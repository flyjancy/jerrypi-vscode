// 渲染层：**webview 里唯一生成 HTML 的地方**。
//
// 两条铁律：
//   1. 除本文件返回值之外，任何地方都不得把数据写进 `innerHTML`（webview 侧用 textContent）；
//   2. 本文件是**纯函数**，不碰 DOM —— 因此可以在 Node 里直接跑，
//      让 `scripts/render-xss-check.mjs` 能在 CI 上做安全回归（不需要启动 VS Code）。
//
// 消毒配置照抄 pi 自己的 `dist/core/export-html/template.js`（marked v18.0.5）：
//   - tokenizer 的 `html()` / `tag()` 返回 undefined → HTML 当**纯文本**（转义后显示）；
//   - link/image 的 URL 过 scheme 白名单；
//   - 代码块与文本一律 escapeHtml。
// 唯一比 pi 更严的地方是图片（见 urlPolicy：只允许 data:image/，不放行远程 URL）。
import { marked, type Tokens } from "marked";
import { TOOL_PREVIEW_LINES, type ChatItem } from "../shared/protocol";
import { cleanUrl, isExternalUrlAllowed, isImageUrlAllowed } from "../shared/urlPolicy";

/** 转义 HTML 特殊字符（照抄 pi 的实现，包含单引号）。 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** pi 用的严格删除线正则：`~~a~~` 才算，`~~ a ~~` 不算（与 TUI 渲染一致）。 */
const strictStrikethroughRegex = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

let configured = false;

function configureMarked(): void {
  if (configured) return;
  configured = true;
  marked.use({
    breaks: true,
    gfm: true,
    tokenizer: {
      // 关键：让 marked 不要把 HTML 当 HTML。返回 undefined 表示"我不认领这段"，
      // 于是 `<script>alert(1)</script>` 会走普通文本路径，最终被 escapeHtml 转义。
      html() {
        return undefined;
      },
      tag() {
        return undefined;
      },
      del(src: string) {
        const match = strictStrikethroughRegex.exec(src);
        if (match === null) return undefined;
        return {
          type: "del",
          raw: match[0],
          text: match[2],
          tokens: this.lexer.inlineTokens(match[2]),
        };
      },
    },
    renderer: {
      link(token: Tokens.Link) {
        if (!isExternalUrlAllowed(token.href)) {
          // 不可点的 scheme（javascript:/data:/tel:…）**降级为纯文本**：
          // 看起来不能点的东西就不该是链接。
          return this.parser.parseInline(token.tokens);
        }
        const href = escapeHtml(cleanUrl(token.href));
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a href="${href}"${title} rel="noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
      },
      image(token: Tokens.Image) {
        const alt = escapeHtml(token.text ?? "");
        if (!isImageUrlAllowed(token.href)) {
          // 远程图片不放行：放行等于把"模型可控的 URL"变成出网信道（PLAN R9）。
          return `<span class="img-blocked">${alt === "" ? "（图片已隐藏）" : alt}</span>`;
        }
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<img src="${escapeHtml(cleanUrl(token.href))}" alt="${alt}"${title}>`;
      },
      code(token: Tokens.Code) {
        const body = token.escaped === true ? token.text : escapeHtml(token.text);
        const lang = token.lang ? ` class="language-${escapeHtml(token.lang)}"` : "";
        return `<pre class="code"><code${lang}>${body}</code></pre>\n`;
      },
    },
  });
}

/** markdown → 已消毒的 HTML。**唯一**允许进 innerHTML 的来源。 */
export function renderMarkdown(text: string): string {
  configureMarked();
  return marked.parse(String(text ?? "")) as string;
}

/** 纯文本 → 已转义的 HTML（换行交给 CSS 的 `white-space: pre-wrap`）。 */
export function renderPlain(text: unknown): string {
  return escapeHtml(text);
}

/** 思考块：折叠容器 + 纯文本内容。 */
export function renderThinking(text: string, streaming: boolean): string {
  const label = streaming ? "思考中…" : "思考过程";
  return `<details class="thinking"${streaming ? " open" : ""}><summary>${label}</summary><div class="thinking-body">${renderPlain(text)}</div></details>`;
}

/** 工具卡片的标题（不换行的那一行）。 */
export function renderToolHead(item: Extract<ChatItem, { kind: "tool" }>): string {
  const icon = item.pending === true ? "…" : item.isError ? "✗" : "✓";
  const summary = item.summary === "" ? "" : ` <span class="tool-args">${renderPlain(item.summary)}</span>`;
  const pending = item.pending === true ? ' <span class="tool-pending">运行中…</span>' : "";
  const duration = renderToolDuration(item);
  return (
    `<span class="tool-icon">${icon}</span>` +
    `<span class="tool-name">${renderPlain(item.toolName)}</span>` +
    summary +
    pending +
    duration
  );
}

/**
 * 耗时。进行中显示 `Elapsed`、结束显示 `Took`（**照 pi 的文案**，见 S3-plan D13）。
 *
 * 没有 `startedAt` 时不显示 —— 重放/重启后我们不知道它跑了多久，**不编造**。
 * 进行中的秒数由 `main.ts` 每秒 tick 重写这一个 span（`data-started-at` 是它的锚点）。
 */
function renderToolDuration(item: Extract<ChatItem, { kind: "tool" }>): string {
  if (item.startedAt === undefined) return "";
  const streaming = item.pending === true;
  const end = item.endedAt ?? item.startedAt;
  const seconds = Math.max(0, (end - item.startedAt) / 1000).toFixed(1);
  const label = streaming ? "Elapsed" : "Took";
  return ` <span class="tool-duration" data-started-at="${item.startedAt}"${
    item.endedAt === undefined ? "" : ` data-ended-at="${item.endedAt}"`
  }>${label} ${seconds}s</span>`;
}

/**
 * 卡片正文。
 *
 * 内容的折叠规则照 pi（`core/tools/renderers/*.js`）：
 *   - bash 折叠时只给**最后 5 行**（pi 的 `BASH_PREVIEW_LINES`），展开时全量；
 *   - read/write/edit 等折叠时**不显示正文**；
 *   - 空正文给一个灰色占位。
 *
 * 展开状态由调用方传入（`main.ts` 里按 item id 记着），不在这个纯函数里存状态 ——
 * 于是"展开态在流式更新时不被重置"这件事只需要保证调用方每次都把同一个值传进来。
 */
export function renderToolBody(item: Extract<ChatItem, { kind: "tool" }>, expanded: boolean): string {
  const text = item.text ?? "";
  const parts: string[] = [];

  if (text === "") {
    parts.push(`<div class="tool-empty">${item.pending === true ? "（等待输出…）" : "（无输出）"}</div>`);
    return parts.join("");
  }

  if (expanded) {
    parts.push(`<pre class="tool-text">${renderPlain(text)}</pre>`);
  } else if (item.toolName === "bash") {
    // 折叠态只给尾部 —— 长命令最有价值的是最后几行（pi 的 BASH_PREVIEW_LINES=5）。
    parts.push(`<pre class="tool-text">${renderPlain(lastLines(text, TOOL_PREVIEW_LINES))}</pre>`);
  }

  if (item.textTruncated === true) {
    // 我们自己的裁剪：只说"省略了多少"，**不用** pi 的脚注样式（来源不同）。
    parts.push(`<div class="tool-note">（正文过长，开头已省略）</div>`);
  }
  if (item.truncation !== undefined) {
    const lines =
      item.truncation.truncatedBy === "lines"
        ? `显示 ${item.truncation.outputLines} / 共 ${item.truncation.totalLines} 行`
        : `显示最后 ${item.truncation.outputLines} 行（共 ${item.truncation.totalLines} 行）`;
    parts.push(`<div class="tool-note">已截断：${lines}</div>`);
  }
  if (item.fullOutputPath !== undefined) {
    parts.push(`<div class="tool-note">完整输出：${renderPathLink(item.fullOutputPath, item)}</div>`);
  }
  return parts.join("");
}

/** 取最后 n 行（不足就全给）。 */
function lastLines(text: string, count: number): string {
  const lines = text.split("\n");
  if (lines.length <= count) return text;
  return lines.slice(-count).join("\n");
}

/**
 * 把路径渲染成可点的东西。
 *
 * **只在宿主铸造过这条路径时**才渲染成 `<a>`（`item.openablePaths`）——
 * 否则就是一段普通文字。理由：可点却点不开（host 会拒）比不可点更让人困惑，
 * 而"渲染层与 host 侧判定一致"是 S2 就立下的规矩。
 */
export function renderPathLink(path: string, item: Extract<ChatItem, { kind: "tool" }>): string {
  const escaped = renderPlain(path);
  if (!(item.openablePaths ?? []).includes(path)) return `<span class="tool-path">${escaped}</span>`;
  return `<a class="tool-path tool-path-open" data-open-path="${escapeHtml(path)}" role="button" tabindex="0">${escaped}</a>`;
}

/** 工具卡片：标题行（可点）+ 正文容器。`expanded` 由调用方维护。 */
export function renderToolCard(item: Extract<ChatItem, { kind: "tool" }>, expanded = false): string {
  const status = item.pending === true ? "running" : item.isError ? "error" : "ok";
  const body = renderToolBody(item, expanded);
  const hasBody = body !== "";
  const open = expanded && hasBody;
  return (
    `<button class="tool-head tool-${status}" aria-expanded="${open ? "true" : "false"}">` +
    `<span class="tool-head-text">${renderToolHead(item)}</span>` +
    `<span class="tool-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>` +
    `</button>` +
    `<div class="tool-body"${open ? "" : " hidden"}>${body}</div>`
  );
}

/** 兼容旧调用点：只给标题行的版本（S2 的 `renderToolLine`）。 */
export function renderToolLine(item: Extract<ChatItem, { kind: "tool" }>): string {
  return `<div class="tool-line">${renderToolHead(item)}</div>`;
}

/** 提示行。 */
export function renderNotice(item: Extract<ChatItem, { kind: "notice" }>): string {
  return `<div class="notice notice-${item.level}">${renderPlain(item.text)}</div>`;
}

/** 助手的正文（含错误信息与"中止/空回复"占位）。 */
export function renderAssistant(item: Extract<ChatItem, { kind: "assistant" }>): string {
  const parts: string[] = [];
  if (item.thinking !== "") parts.push(renderThinking(item.thinking, item.streaming === true));
  if (item.text !== "") {
    parts.push(`<div class="markdown">${renderMarkdown(item.text)}</div>`);
  } else if (item.streaming !== true && item.stopReason !== "toolUse") {
    // 中止或模型没吐字时，别留一个空壳让人以为界面坏了。
    //
    // ⚠️ `toolUse` 必须排除：那一轮的 assistant 消息**本来就只带工具调用、没有正文**
    // （正文在工具执行完之后的下一轮才产生）。实测第一版会显示一行橙字
    // "（本次回复没有内容：toolUse）"，紧接着才是工具行和真正的回复 —— 纯属误导。
    const reason = item.stopReason;
    parts.push(
      `<div class="notice notice-warn">（本次回复${
        reason === "aborted" ? "已被中止" : reason === "" ? "没有内容" : `没有内容：${renderPlain(reason)}`
      }）</div>`,
    );
  }
  if (item.errorMessage !== undefined && item.errorMessage !== "") {
    parts.push(`<div class="notice notice-error">${renderPlain(item.errorMessage)}</div>`);
  }
  return parts.join("");
}
