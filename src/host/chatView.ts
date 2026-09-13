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
import type { SessionHostController } from "../pi/controller";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "../shared/protocol";
import { isExternalUrlAllowed } from "../shared/urlPolicy";
import { buildWebviewHtml, createNonce } from "./webviewHtml";
import { pickModel, pickThinkingLevel, type PickerBridge } from "./modelPicker";
import { MetaStatusBar } from "./statusBar";

export const CHAT_VIEW_ID = "jerrypi.chat";

export interface ChatViewOptions {
  controller: SessionHostController;
  extensionUri: vscode.Uri;
  output: vscode.OutputChannel;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar = new MetaStatusBar();

  constructor(private readonly options: ChatViewOptions) {}

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
   * 全量重放。
   *
   * **`state` 的组装只有这一处** —— 面板重建（`ready`/`requestState`）与会话替换
   * （`onSessionReplaced`，见 controller 的 D6）都走它，所以两边的形状不可能跑偏。
   */
  replay(): void {
    this.post({ type: "state", protocol: PROTOCOL_VERSION, ...this.options.controller.snapshot() });
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
      }),
    );
  }

  dispose(): void {
    this.disposeView();
    this.statusBar.dispose();
  }

  private disposeView(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async handleMessage(message: ClientMessage): Promise<void> {
    const { controller, output } = this.options;
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
