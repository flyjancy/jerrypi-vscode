// 聊天面板的宿主侧：消息路由、状态重放、CSP 与外部链接代理。
//
// 分工：**webview 不认识 pi，本文件不认识 pi 的内部结构** —— 中间只有
// `shared/protocol.ts` 的协议与 `pi/controller.ts` 的会话主机。
//
// 三个刻意的决定：
//   1. 视图级 `retainContextWhenHidden` 必须写在 **`registerWebviewViewProvider` 的第三参数**里。
//      写进 `view.webview.options` 过不了类型检查、运行也不生效（`WebviewOptions` 只有 5 个成员，
//      这个开关在 `WebviewPanelOptions` 里）——见 chatView 的注册处。
//   2. `localResourceRoots` 放行的是**扩展根目录**：脚本在 `dist/`、图标在 `media/`，
//      只放行其中一个会让面板白屏或无样式。
//   3. 每次 webview 发 `ready` 都往 Output 写一行 —— 这是"面板是否真的被重建了"的
//      唯一可观测证据（人工判断"DOM 有没有重建"是做不到的），M6/M6b 就靠它判定。
import * as vscode from "vscode";
import type { SessionHostController, SessionReplaceOutcome } from "../pi/controller";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "../shared/protocol";
import { isExternalUrlAllowed } from "../shared/urlPolicy";
import { buildWebviewHtml, createNonce } from "./webviewHtml";
import { pickModel, pickThinkingLevel, type PickerBridge } from "./modelPicker";
import { pickSession, type SessionPickerBridge } from "./sessionPicker";
import { replaceSessionWithConfirm, reportReplaceOutcome } from "./sessionActions";
import { DialogHost } from "./dialogHost";
import { MetaStatusBar } from "./statusBar";
import type { DiffPresenter } from "./diff";
import type { ApprovalDecision } from "../pi/approval";
import type { TrustMemoLike } from "../pi/trust";

export const CHAT_VIEW_ID = "jerrypi.chat";

/** 通知上那个"打开面板"按钮的文案（S8 的 Q9）。 */
export const FOCUS_CHAT_ITEM = "打开面板";

export interface ChatViewOptions {
  controller: SessionHostController;
  extensionUri: vscode.Uri;
  output: vscode.OutputChannel;
  /** S7：打开"这次调用改了什么"的 diff（`extension.ts` 造，白名单在它里面）。 */
  diff: DiffPresenter;
  /**
   * S9 ①②：面板内的对话框。
   *
   * 生产由 `extension.ts` 单独造并**同时**交给 `createVSCodeUIContext` —— 两边必须是
   * 同一个实例：`uiContext.select/confirm/input` 挂起的那个 Promise，等的就是面板
   * 回传的 `dialog/answer`。
   *
   * 不传时自己造一个（post 指向自己的 `post`）—— 只为让不关心对话框的夹具少写一行；
   * 那种情况下 `uiContext` 也没接它，所以不会有“两张表”的问题。
   */
  dialogHost?: DialogHost;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar = new MetaStatusBar();
  /**
   * S9 ①②：面板内的对话框（由 `extension.ts` 注入，与 `uiContext` 共用同一实例）。
   *
   * 它自持 post 通道，所以就绪/重放/回答路由**不经过 `controller.ensure()`**
   * （R15 的死锁窗口就是这么消掉的）。
   */
  readonly dialogHost: DialogHost;

  constructor(private readonly options: ChatViewOptions) {
    this.dialogHost =
      options.dialogHost ??
      new DialogHost({
        post: (message) => this.post(message),
        announce: () => this.notifyDialogPending(),
        log: { appendLine: (line) => options.output.appendLine(line) },
      });
  }

  /** 把控制器的协议消息送到面板（面板不在时静默丢弃：重放时会给全量状态）。 */
  readonly post = (message: ServerMessage): void => {
    // 状态栏跟着 meta 走。**不额外建会话**：第一次 update 才 createStatusBarItem，
    // 而 meta 只有 controller 已经 ensure 之后才会来。
    if (message.type === "state" || message.type === "meta") {
      this.statusBar.update(message.meta);
    }
    void this.view?.webview.postMessage(message);
  };

  /** 选择器需要的桥（选择器本身不认识 session）。 */
  private pickerBridge(): PickerBridge {
    const { controller } = this.options;
    return {
      currentModelId: () => controller.pickerContext().model,
      supportsThinking: () => controller.pickerContext().supportsThinking,
      currentLevel: () => controller.pickerContext().thinkingLevel,
      levels: () => controller.pickerContext().levels,
      listModels: () => controller.listAvailableModels(),
      applyModel: (model) => controller.applyPanelModel(model),
      applyLevel: (level) => controller.applyThinkingLevel(level),
      notify: (text, level) => controller.notifyUser(level, text),
      focusInput: () => this.post({ type: "focusInput" }),
    };
  }

  /** 命令面板入口（`fromPanel: false` —— 那时不抢用户焦点）。 */
  async runModelPicker(fromPanel: boolean): Promise<void> {
    await this.options.controller.ensure();
    await pickModel(this.pickerBridge(), { fromPanel });
  }

  async runThinkingPicker(fromPanel: boolean): Promise<void> {
    await this.options.controller.ensure();
    await pickThinkingLevel(this.pickerBridge(), { fromPanel });
  }

  /**
   * 一次会话替换：忙时先弹确认（D7），再把结果翻译成面板里的提示。
   *
   * **两条入口（新建 / 切换）都走这里** —— 弹窗与文案只有这一处。
   */
  private async replaceSession(
    run: (force: boolean) => Promise<SessionReplaceOutcome>,
  ): Promise<void> {
    // S9 ①②：会话切换 ⇒ 旧会话上挂着的对话框**结算成 replaced**（§3.8 的结算表）。
    // 放在替换之前：替换会 abort 旧会话，而对话框等的是旧会话的初始化/命令，
    // 留着它只会变成一张永远答不上的孤卡。
    const cancelled = this.dialogHost.cancelAll("replaced");
    if (cancelled > 0) this.options.output.appendLine(`[dialog] 会话切换：撤掉 ${cancelled} 个待答对话框（replaced）`);
    const outcome = await replaceSessionWithConfirm(run);
    reportReplaceOutcome(outcome, (level, text) => this.options.controller.notifyUser(level, text));
  }

  /** `Pi: New Session`（命令面板）。 */
  async runNewSession(): Promise<void> {
    await this.options.controller.ensure();
    await this.replaceSession((force) => this.options.controller.newSession({ force }));
  }

  /** S8：`Pi: Project Trust…` 用的本进程信任缓存（权威在 controller 上）。 */
  trustMemo(): TrustMemoLike {
    return this.options.controller.trustMemo;
  }

  /** 会话列表入口。 */
  async runSessionPicker(fromPanel: boolean): Promise<void> {
    await this.options.controller.ensure();
    await pickSession(this.sessionBridge(), { fromPanel });
  }

  private sessionBridge(): SessionPickerBridge {
    const { controller } = this.options;
    return {
      currentSessionPath: () => controller.currentSessionPath(),
      listSessions: () => controller.listSessions(),
      startNewSession: () => this.replaceSession((force) => controller.newSession({ force })),
      switchToSession: (path) =>
        this.replaceSession((force) => controller.switchSession(path, { force })),
      notify: (level, text) => controller.notifyUser(level, text),
      focusInput: () => this.post({ type: "focusInput" }),
    };
  }

  /**
   * 有工具调用在等确认（S8，Q9/Q10）。
   *
   * 三条口径：
   *   1. **面板可见时不打扰**（卡片上就有按钮，用户正看着它）；
   *   2. 面板不可见 → 弹一条信息通知，按钮聚焦面板 —— 否则「中止」在面板里、用户够不着，
   *      而 `ask` 会一直等着（那条待审批项的唯一出口就是"答"或"中止"）；
   *   3. Q10：视图**销毁**（`onDidDispose`）与**重建后仍有待审批**时各再喊一次 —— 这是
   *      "销毁不取消待审批"（与 C6 的重放口径一致）留下的洞的补法。
   */
  notifyApprovalPending(): void {
    this.announcePendingApproval();
  }

  /**
   * 把"还在等"这件事说出去（面板可见就只说给 Output）。
   *
   * 数量**每次都问 controller**（`pendingApprovals()`）—— 宿主不自己攒副本：
   * M1 真机验收实测过一次"副本只增不减"（被中止结掉的不会被删掉），
   * 而权威只有 controller 的审批表。
   */
  private announcePendingApproval(): void {
    const pending = this.options.controller.pendingApprovals();
    if (pending.length === 0) return;
    const latest = pending.at(-1);
    const count = pending.length;
    if (this.view?.visible === true) {
      this.options.output.appendLine(
        `[approval] 面板可见，不再弹通知（${count} 个待确认，最新：${latest?.toolName}）`,
      );
      return;
    }
    void vscode.window
      .showInformationMessage(
        `jerrypi: 有 ${count} 个工具调用等待确认（${latest?.toolName}）：${latest?.title ?? ""}`,
        FOCUS_CHAT_ITEM,
      )
      .then((picked) => {
        if (picked === FOCUS_CHAT_ITEM) void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
      });
  }

  /**
   * S9 ①②：有对话框在等作答（对齐 S8 的 `notifyApprovalPending`）。
   *
   * 面板可见 → 只记 Output（卡片就在眼前）；不可见 → 弹一条通知 + 「打开面板」。
   */
  notifyDialogPending(): void {
    const count = this.dialogHost.pendingCount();
    if (count === 0) return;
    if (this.view?.visible === true) {
      this.options.output.appendLine(`[dialog] 面板可见，不再弹通知（${count} 个待答）`);
      return;
    }
    void vscode.window
      .showInformationMessage(`jerrypi: 有一个对话框等待作答（共 ${count} 个）：打开面板即可回答`, FOCUS_CHAT_ITEM)
      .then((picked) => {
        if (picked === FOCUS_CHAT_ITEM) void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
      });
  }

  /**
   * 全量重放。
   *
   * **`state` 的组装只有这一处** —— 面板重建（`ready`/`requestState`）与会话替换
   * （`onSessionReplaced`，见 controller 的 D6）都走它，所以两边的形状不可能跑偏。
   */
  replay(): void {
    const snapshot = this.options.controller.snapshot();
    this.post({ type: "state", protocol: PROTOCOL_VERSION, ...snapshot });
    // Q10 的"重建后仍有待审批"：快照是权威（与前端数卡片用的是同一份字段）
    // Q10 的"重建后仍有待审批"：快照与 controller 的审批表是同一份权威
    if (snapshot.items.some((item) => item.kind === "tool" && item.approval === "pending")) {
      this.announcePendingApproval();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // 脚本在 dist/、样式在 dist/：只放行 media/ 会让面板一片空白。
      localResourceRoots: [this.options.extensionUri],
    };
    view.webview.html = buildWebviewHtml({
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview.js"))
        .toString(),
      styleUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, "dist", "style.css"))
        .toString(),
      cspSource: view.webview.cspSource,
      nonce: createNonce(),
    });

    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.handleMessage(raw as ClientMessage);
      }),
      // 视图被销毁（右键隐藏、拖到别的容器）时只清理引用，**不动 pi 会话**：
      // 会话归 controller，重新拉开时重放即可。
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        this.disposeView();
        // Q10：销毁**不**取消待审批项（那是 C6 的反面），但得再喊一次 —— 用户可能
        // 再也看不到那张卡片，而「中止」按钮在面板里。
        this.announcePendingApproval();
        // S9 ①②：对话框同理 —— 销毁**不结算**（只断开 post 通道），但要说一声。
        this.notifyDialogPending();
      }),
    );
  }

  dispose(): void {
    // S9 ①②：控制器销毁 = 会话终止（与“视图销毁”是两回事，Q10）：把挂起的对话框
    // 结算成 cancelled，否则调用方（pi 扩展的 select/confirm/input）会永远挂着。
    this.dialogHost.cancelAll("cancelled");
    this.disposeView();
    this.statusBar.dispose();
  }

  private disposeView(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async handleMessage(message: ClientMessage): Promise<void> {
    const { controller, output, diff } = this.options;
    try {
      switch (message.type) {
        case "ready":
        case "requestState": {
          // 这一行是 M6/M6b 的判据：视图被重建时才应该多出一行。
          output.appendLine("[webview] ready");
          if (message.type === "ready" && message.protocol !== PROTOCOL_VERSION) {
            output.appendLine(
              `[webview] 协议版本不一致：面板=${message.protocol} 扩展=${PROTOCOL_VERSION}（已按当前协议继续）`,
            );
          }
          // ⚠️ **顺序是刻意的**（S9-plan §3.8 / R15）：先把挂起的对话框重放出去，
          // 再 `await controller.ensure()`。反过来的话，“初始化期间某个 session_start
          // 处理器挂起在对话框上”时：ensure 等那个回答，而回答要等 keep ensure 完成
          // 才能重放到前端 —— 死锁。对话框的 post 通道自持，所以可以先于 ensure 走。
          this.dialogHost.replay();
          await controller.ensure();
          this.replay();
          return;
        }
        case "prompt": {
          // 不 await：`prompt()` 的 promise 要到整轮结束才 resolve。
          void controller.prompt(message.text, message.behavior).catch((error: unknown) => {
            this.post({ type: "composerError", text: describeError(error) });
            this.post({ type: "busy", busy: false });
          });
          return;
        }
        case "abort": {
          await controller.abort();
          return;
        }
        case "clearQueue": {
          // pi 的 "edit all queued messages"：取回输入框，不是丢弃。
          // （第一版这里把返回值扔了 —— 用户排队的字会静默消失。）
          const restoredText = controller.clearQueue();
          if (restoredText !== "") this.post({ type: "restoreComposer", text: restoredText });
          return;
        }
        case "openExternal": {
          // 与渲染层用**同一个**判定：否则会出现"看起来可点、点了没反应"。
          if (!isExternalUrlAllowed(message.href)) {
            output.appendLine(`[webview] 拒绝打开非白名单链接：${message.href.slice(0, 120)}`);
            return;
          }
          await vscode.env.openExternal(vscode.Uri.parse(message.href));
          return;
        }
        case "openModelPicker": {
          await pickModel(this.pickerBridge(), { fromPanel: true });
          return;
        }
        case "openThinkingPicker": {
          await pickThinkingLevel(this.pickerBridge(), { fromPanel: true });
          return;
        }
        case "openSessionPicker": {
          await this.runSessionPicker(true);
          return;
        }
        case "openFile": {
          // 工具卡片里的路径。**只认控制器登记过的绝对路径**（精确字符串比对）：
          // 渲染层也是按同一份 `openablePaths` 决定"渲染成可点还是纯文字"的，
          // 两层不可能各说各话。
          if (!controller.isOpenableFile(message.path)) {
            output.appendLine(`[webview] 拒绝打开未登记的文件：${message.path.slice(0, 200)}`);
            return;
          }
          try {
            // 用 `Uri.file` 而不是 `Uri.parse`：后者会把路径里的 `#` 当 fragment、
            // `?` 当 query（`/tmp/a#b.log` 会打开成另一个文件或直接失败）。
            await vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: true });
          } catch (error) {
            // 文件可能已经被删了、或者是二进制/超大文件。**不静默失败**。
            const text = describeError(error);
            output.appendLine(`[webview] 打开文件失败：${message.path} — ${text}`);
            void vscode.window.showWarningMessage(`jerrypi: 打不开 ${message.path}（${text}）`);
          }
          return;
        }
        case "approvalDecision": {
          // 白名单在 controller 的审批表里（"这条 id 现在真的在等吗"），面板说什么不算数。
          if (message.decision !== "allow" && message.decision !== "deny") {
            output.appendLine(`[webview] 忽略无法识别的审批决定：${JSON.stringify(message).slice(0, 120)}`);
            return;
          }
          if (!controller.decideApproval(message.toolCallId, message.decision satisfies ApprovalDecision)) {
            output.appendLine(`[webview] 这次审批已经不在了（已中止/已答过）：${message.toolCallId}`);
          }
          return;
        }
        case "dialog/answer": {
          // 路由**直接查 DialogHost 的 pending 表**，不经过 controller —— 才能做到
          // “初始化期间也能作答”（A32①）。晚到 / 未知的 id 在 DialogHost 里被丢弃。
          if ("cancelled" in message) this.dialogHost.answer(message.dialogId, { cancelled: true });
          else this.dialogHost.answer(message.dialogId, { value: message.value });
          return;
        }
        case "openDiff": {
          // 白名单在 presenter 里（store 里没有这条记录 / 已被淘汰都不打开，并记一行原因）。
          diff.open(message.toolCallId);
          return;
        }
        default: {
          output.appendLine(`[webview] 未知消息：${JSON.stringify(message).slice(0, 200)}`);
        }
      }
    } catch (error) {
      const text = describeError(error);
      output.appendLine(`[webview] 处理 ${message.type} 失败：${text}`);
      this.post({ type: "composerError", text });
      this.post({ type: "busy", busy: false });
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 注册聊天视图。
 *
 * ⚠️ `retainContextWhenHidden` **只能**写在这里（第三参数）。它不属于 `WebviewOptions`，
 * 写进 `view.webview.options` 会编译失败，而且即使绕过类型也不会生效。
 */
export function registerChatView(
  context: vscode.ExtensionContext,
  options: ChatViewOptions,
): ChatViewProvider {
  const provider = new ChatViewProvider(options);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider,
  );
  return provider;
}
