// 生成 webview 的 HTML（**纯函数**，便于单测与评审）。
//
// 这里唯一容易做错、做错了又很难查的东西是 CSP：
//   - `default-src 'none'` 的含义是"全都不许"，所以**每一样都要显式放开**。
//     忘了 `style-src` → 面板能跑但完全没有样式；忘了 `img-src data:` →
//     连 data URI 图片都不显示。这类错误的表象是"界面怪怪的"，不是报错。
//   - 脚本只能靠 **nonce** 放行（不用 `unsafe-inline`）。
//   - 本地资源必须走 `webview.asWebviewUri`，且目录要在 `localResourceRoots` 里
//     （见 chatView.ts：那里放行的是扩展根目录，因为脚本在 `dist/`、图标在 `media/`）。
// 注意：本文件**不 import vscode** —— 只要进来的都是字符串，它就是纯函数，
// 于是 `scripts/render-xss-check.mjs` 能在 Node 里断言 CSP 的每一条指令。
// （CSP 写错的表现不是报错，而是"面板能跑但没样式"，靠人工看很难定位。）

export interface WebviewHtmlOptions {
  /** `webview.asWebviewUri(...)` 的结果。 */
  scriptUri: string;
  styleUri: string;
  /** `webview.cspSource`。 */
  cspSource: string;
  nonce: string;
}

/** CSP 里需要 `webview.cspSource` 的几项，集中在这里以便评审时一眼看全。 */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** 随机 nonce（每次 resolve 都换）。 */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const { scriptUri, styleUri, cspSource, nonce } = options;
  const csp = contentSecurityPolicy(cspSource, nonce);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Pi</title>
</head>
<body>
<div id="transcript" class="transcript"></div>
<div id="queue" class="queue" hidden></div>
<!--
  状态行与元信息行的位置**照 pi TUI 的装配顺序**（interactive-mode.js:634-642）：
  转录 → 待发消息 → 工作状态 → 输入框 → 底部信息。
  状态行在输入框**上方**（空闲时内容为空，但**常驻一行高度** —— 否则每轮
  忙/闲切换会让输入框上下跳一行）；模型/等级/用量在输入框**下方**（那里才是
  用户打字时视线所在处，也是 pi 的 footer 位置）。
-->
<div id="status" class="status" aria-live="polite"></div>
<div class="composer">
  <textarea id="input" class="input" rows="3" placeholder="输入消息，Enter 发送（Shift+Enter 换行）"></textarea>
  <div class="composer-actions">
    <span id="composer-hint" class="hint"></span>
    <div class="buttons">
      <button id="queue-button" class="button secondary" hidden>追加</button>
      <button id="abort-button" class="button secondary" hidden>中止</button>
      <button id="send-button" class="button primary">发送</button>
    </div>
  </div>
  <div id="composer-error" class="composer-error" hidden></div>
  <div id="meta" class="meta" aria-live="polite"></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
