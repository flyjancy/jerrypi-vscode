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
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import { isExternalUrlAllowed } from "../shared/urlPolicy";
import { buildWebviewHtml, createNonce } from "./webviewHtml";

export const CHAT_VIEW_ID = "jerrypi.chat";

export interface ChatViewOptions {
  controller: SessionHostController;
  extensionUri: vscode.Uri;
  output: vscode.OutputChannel;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly options: ChatViewOptions) {}

  /** 把控制器的协议消息送到面板（面板不在时静默丢弃：重放时会给全量状态）。 */
  readonly post = (message: ServerMessage): void => {
    void this.view?.webview.postMessage(message);
  };

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
          if (message.type === "ready" && message.protocol !== PROTOCOL_EXPECTED) {
            output.appendLine(
              `[webview] 协议版本不一致：面板=${message.protocol} 扩展=${PROTOCOL_EXPECTED}（已按当前协议继续）`,
            );
          }
          await controller.ensure();
          this.post({ type: "state", protocol: PROTOCOL_EXPECTED, ...controller.snapshot() });
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
          controller.clearQueue();
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

const PROTOCOL_EXPECTED = 1;

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
