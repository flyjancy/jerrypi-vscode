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
import { TOOL_PREVIEW_LINES, type ChatItem, type SessionMeta } from "../shared/protocol";
import { formatContextUsage } from "../shared/format";
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

/** `diffUnavailable` 的四值四文案（与协议一一对应）。 */
export const DIFF_UNAVAILABLE_TEXT: Record<"evicted" | "too-large" | "read-failed" | "none", string> = {
  none: "本次会话不可用",
  evicted: "较早的改动记录已清理",
  "too-large": "文件过大，未保留",
  "read-failed": "快照读取失败",
};

/** 标题行尾的 diff 入口（有记录给链接，没记录给原因）。 */
function renderToolDiff(item: Extract<ChatItem, { kind: "tool" }>): string {
  if (item.diff !== undefined) {
    // `role`/`tabindex` 与路径链接同规格：卡片标题是个 `<button>`，键盘用户得能到达它。
    return ` <a class="tool-diff" data-open-diff="${escapeHtml(item.toolCallId)}" role="button" tabindex="0">查看 diff</a>`;
  }
  if (item.diffUnavailable !== undefined) {
    return ` <span class="tool-note">${renderPlain(DIFF_UNAVAILABLE_TEXT[item.diffUnavailable])}</span>`;
  }
  return "";
}

/** 工具卡片的标题（不换行的那一行）。 */
export function renderToolHead(item: Extract<ChatItem, { kind: "tool" }>, now: number = Date.now()): string {
  const icon = item.pending === true ? "…" : item.isError ? "✗" : "✓";
  // 参数槽的显示条件看的是**标题或摘要有没有**，不是只看摘要：
  // 第一版写成 `summary === "" ? "" : …`，于是"有 title 但 summary 为空"的 item
  // 会把标题一起丢掉（测试台的"运行中卡片要有可点路径"就是这么红的）。
  const hasArgs = item.summary !== "" || item.title !== undefined;
  const summary = hasArgs ? ` <span class="tool-args">${renderToolTitle(item)}</span>` : "";
  const pending = item.pending === true ? ' <span class="tool-pending">运行中…</span>' : "";
  const duration = renderToolDuration(item, now);
  return (
    `<span class="tool-icon">${icon}</span>` +
    `<span class="tool-name">${renderPlain(item.toolName)}</span>` +
    summary +
    pending +
    duration +
    renderToolDiff(item)
  );
}

/**
 * 标题里的那段文字。
 *
 * 优先用宿主铸造的 `title`（照 pi 的 call 行：`~/a.ts:10-20`、`命令 (timeout 30s)`），
 * 没有就回退到原始的 JSON 参数摘要（扩展工具走这条路）。
 * `title.link` 存在时，那一段渲染成**可点的路径**（pi 的 `renderToolPath` 也是把
 * call 行里的路径做成交互元素的）。
 */
export function renderToolTitle(item: Extract<ChatItem, { kind: "tool" }>): string {
  const title = item.title;
  if (title === undefined) return renderPlain(item.summary);
  const link = title.link;
  if (link === undefined || link.text === "" || !title.text.includes(link.text)) {
    return renderPlain(title.text);
  }
  const at = title.text.indexOf(link.text);
  const before = title.text.slice(0, at);
  const after = title.text.slice(at + link.text.length);
  return renderPlain(before) + renderPathLink(link.text, link.path, item) + renderPlain(after);
}

/**
 * 耗时。进行中显示 `Elapsed`、结束显示 `Took`（**照 pi 的文案**，见 S3-plan D13）。
 *
 * 没有 `startedAt` 时不显示 —— 重放/重启后我们不知道它跑了多久，**不编造**。
 * 进行中的秒数由 `main.ts` 每秒 tick 重写这一个 span（`data-started-at` 是它的锚点）。
 */
function renderToolDuration(item: Extract<ChatItem, { kind: "tool" }>, now: number): string {
  if (item.startedAt === undefined) return "";
  const streaming = item.pending === true;
  // ⚠️ 进行中必须用**现在**：用 `endedAt ?? startedAt` 的话每一帧都算出 0.0s，
  // 而流式期间每 200ms 就会重渲染一次标题行 —— 表现是"1 秒的 tick 刚写上 2.5s，
  // 200ms 后又被抹回 0.0s"，用户看到的是 0→2→0→3 的跳（S3 第二次人工验收实测）。
  const end = item.endedAt ?? now;
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
    //
    // **必须把"还有多少行被折起来了"说出来**：折叠态对 bash 不是"隐藏"而是"只看尾部"，
    // 如果输出本来就只有几行，折叠与展开**长得一模一样**，用户会以为点击没生效
    // （S3 第一次验收就是这样反馈的）。pi 在 TUI 里也插这一行
    // （`... (N earlier lines, <key> to expand)`），只是它用键位提示、我们用点击。
    //
    // ⚠️ 提示里的行数与真正显示的行数必须用**同一个**行定义：第一版计数用
    // `textLines()`（减掉末尾空行）、渲染用 `text.split()`（没减），于是"还有 7 行"
    // 却只显示 4 行 —— 少了一行（S3 第二次人工验收实测）。
    const lines = textLines(text);
    const hidden = Math.max(0, lines.length - TOOL_PREVIEW_LINES);
    if (hidden > 0) {
      parts.push(`<div class="tool-note">… 还有 ${hidden} 行（点击标题展开）</div>`);
    }
    parts.push(`<pre class="tool-text">${renderPlain(lines.slice(-TOOL_PREVIEW_LINES).join("\n"))}</pre>`);
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
    parts.push(
      `<div class="tool-note">完整输出：${renderPathLink(item.fullOutputPath, item.fullOutputPath, item)}</div>`,
    );
  }
  return parts.join("");
}

/**
 * 把正文切成"逻辑行"。
 *
 * 末尾那个换行会 split 出一个空串，它不是一行内容 —— 要减掉。
 * **折叠预览与折行计数必须共用这一个定义**，否则两处会差一行。
 */
function textLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 把路径渲染成可点的东西。
 *
 * **只在宿主铸造过这条路径时**才渲染成 `<a>`（`item.openablePaths`）——
 * 否则就是一段普通文字。理由：可点却点不开（host 会拒）比不可点更让人困惑，
 * 而"渲染层与 host 侧判定一致"是 S2 就立下的规矩。
 */
export function renderPathLink(
  display: string,
  path: string,
  item: Extract<ChatItem, { kind: "tool" }>,
): string {
  const escaped = renderPlain(display);
  if (!(item.openablePaths ?? []).includes(path)) return `<span class="tool-path">${escaped}</span>`;
  // `data-open-path` 带的是**绝对路径**（host 白名单的键），显示的是缩短形态。
  return `<a class="tool-path tool-path-open" data-open-path="${escapeHtml(path)}" role="button" tabindex="0">${escaped}</a>`;
}

/** 展开箭头的字形。 */
export function renderToolCaret(open: boolean): string {
  return open ? "▾" : "▸";
}

/**
 * 标题按钮的**全部内容**（文本 + 箭头）。
 *
 * ⚠️ 这是**唯一**产出按钮内容的地方 —— `main.ts`（就地更新）与 `renderToolCard`
 * （渲染断言用）都必须调它。S3 的第一次人工验收就是被这件事咬的：
 * `renderToolCard` 有箭头、`main.ts` 自己拼的那份没有，于是 74 条断言全绿、
 * 真机上箭头根本不出现（两份拼装代码漂移）。
 */
export function renderToolHeadLine(
  item: Extract<ChatItem, { kind: "tool" }>,
  open: boolean,
  now: number = Date.now(),
): string {
  return (
    `<span class="tool-head-text">${renderToolHead(item, now)}</span>` +
    `<span class="tool-caret" aria-hidden="true">${renderToolCaret(open)}</span>`
  );
}

/**
 * 审批行（S8）。
 *
 * ⚠️ 两个结构性的约定，都有断言守着（S8-plan 的 A8b）：
 *   ① 它渲染在**标题按钮之外**（`renderToolCard` 里 head 与 body 之间）—— 展开/折叠的监听器
 *      挂在 head 元素自身上（`main.ts`），所以"点审批按钮不会顺带展开卡片"是**这个兄弟关系**
 *      的推论。把它挪进 head 内部就会两件事一起坏（HTML 解析器还会把嵌套的 `<button>` 拆掉）。
 *   ② 两个控件是**真 `<button type="button">`** —— 键盘可达性（Tab 能停、Enter/Space 能激活）
 *      全靠它；而且正因为是真按钮，**审批控件不需要手写键盘分支**（原生激活会补一次 click，
 *      被 `main.ts` 捕获阶段的点击委托接住 ⇒ "一次按键只发一条"是构造保证）。
 *      第 2 轮评审 B1：在 happy-dom 里手写"keydown + preventDefault"那条路是**测不出来**的。
 */
export function renderToolApproval(item: Extract<ChatItem, { kind: "tool" }>): string {
  if (item.approval === "pending") {
    const id = escapeHtml(item.toolCallId);
    return (
      `<div class="tool-approval">` +
      `<span class="tool-approval-hint">这个工具调用需要你确认</span>` +
      `<button class="button primary tool-approval-allow" type="button" data-approve="${id}">允许</button>` +
      `<button class="button secondary tool-approval-deny" type="button" data-deny="${id}">拒绝</button>` +
      `</div>`
    );
  }
  if (item.approval === "denied") {
    return `<div class="tool-approval"><span class="tool-note">已拒绝</span></div>`;
  }
  return "";
}

/** 工具卡片的 class（三态）。 */
export function renderToolStatusClass(item: Extract<ChatItem, { kind: "tool" }>): string {
  return `tool-${item.pending === true ? "running" : item.isError ? "error" : "ok"}`;
}

/** 工具卡片：标题行（可点）+ 正文容器。`expanded` 由调用方维护。 */
export function renderToolCard(item: Extract<ChatItem, { kind: "tool" }>, expanded = false): string {
  const body = renderToolBody(item, expanded);
  const open = expanded && body !== "";
  return (
    `<button class="tool-head ${renderToolStatusClass(item)}" aria-expanded="${open ? "true" : "false"}">` +
    renderToolHeadLine(item, open) +
    `</button>` +
    // 审批行在 head **之外**（见 renderToolApproval 的注释①）、正文之前：
    // 折叠时也要能答，所以它不能进 body。
    renderToolApproval(item) +
    `<div class="tool-body"${open ? "" : " hidden"}>${body}</div>`
  );
}

/** 兼容旧调用点：只给标题行的版本（S2 的 `renderToolLine`）。 */
export function renderToolLine(item: Extract<ChatItem, { kind: "tool" }>): string {
  return `<div class="tool-line">${renderToolHead(item)}</div>`;
}

/** 提示行。 */
/**
 * 输入框下方那一行：`会话名 · 模型 • 等级 • 42.3%/1.0M`。
 *
 * 四条与 pi 对齐的规矩：
 *   - 会话段、模型段、等级段是**独立的按钮**（可点开各自的选择器），用量是纯文字；
 *   - `reasoning: false` 的模型**不显示等级**（pi 的 footer 也是这么做的）；
 *   - 用量未知（`percent === null`）显示 `?/1.0M`（**没有百分号**），
 *     没有模型（`contextWindow === 0`）时整段不显示 —— 模型段已经说了"未选择模型"；
 *   - 会话**未落盘**时名字后面标一句"未保存"（pi 在首条 assistant 消息之后才建文件；
 *     不说一句的话，用户会以为"名单里找不到刚建的会话"是 bug）。
 *
 * 所有值都经过转义：会话名与模型 id 都是**别人写的**（模型能往会话文件里写 user 消息）。
 */
export function renderMeta(meta: SessionMeta): string {
  const sessionLabel =
    meta.session.persisted === true ? meta.session.name : `${meta.session.name} · 未保存`;
  const sessionButton =
    `<button type="button" class="meta-link meta-session" data-meta-action="session"` +
    // 路径放 `title`（S5 的 N3：`path` 得有个用途，不能白留在协议里）；
    // **未落盘时不设这个属性**（定死，否则两种实现都能"通过"）。
    (meta.session.path === "" ? "" : ` title="${escapeHtml(meta.session.path)}"`) +
    ` aria-label="当前会话 ${escapeHtml(meta.session.name)}，点击切换">` +
    `${escapeHtml(sessionLabel)}</button>`;

  const label = meta.model === "" ? "未选择模型" : meta.model.split("/").slice(1).join("/");
  const modelButton =
    `<button type="button" class="meta-link meta-model" data-meta-action="model"` +
    ` aria-label="当前模型 ${escapeHtml(meta.model === "" ? "未选择，点击选择" : meta.model)}，点击切换">` +
    `${escapeHtml(label)}</button>`;

  const levelButton =
    meta.supportsThinking === true
      ? `<button type="button" class="meta-link meta-level" data-meta-action="thinking"` +
        ` aria-label="当前思考等级 ${escapeHtml(meta.thinkingLevel)}，点击切换">` +
        `${escapeHtml(meta.thinkingLevel === "off" ? "thinking off" : meta.thinkingLevel)}</button>`
      : "";

  const percent = meta.contextUsage?.percent ?? null;
  const usage = formatContextUsage(percent, meta.contextWindow);
  // 阈值与配色**照 pi 的 footer**：`> 90` error、`> 70` warning（严格大于），
  // `percent === null`（刚压缩）**不着色**（pi 用的是 `percent ?? 0`）。
  const tone = percent === null ? "" : percent > 90 ? " meta-usage-error" : percent > 70 ? " meta-usage-warn" : "";
  const usageSpan = usage === "" ? "" : `<span class="meta-usage${tone}">${escapeHtml(usage)}</span>`;

  return [sessionButton, modelButton, levelButton, usageSpan]
    .filter((part) => part !== "")
    .join(`<span class="meta-sep">·</span>`);
}

export function renderNotice(item: Extract<ChatItem, { kind: "notice" }>): string {
  return `<div class="notice notice-${item.level}">${renderPlain(item.text)}</div>`;
}

/** 助手的正文（含错误信息与"中止/空回复"占位）。 */
export function renderAssistant(item: Extract<ChatItem, { kind: "assistant" }>): string {
  const parts: string[] = [];
  if (item.thinking !== "") parts.push(renderThinking(item.thinking, item.streaming === true));
  if (item.text !== "") {
    parts.push(`<div class="markdown">${renderMarkdown(item.text)}</div>`);
  } else if (
    item.streaming !== true &&
    item.stopReason !== "toolUse" &&
    // 已经有一条具体的错误信息时**不再补一句"没有内容"**：
    // 两行说的是同一件事，而且"没有内容：error"里的 `error` 是 StopReason 枚举值、
    // 不是给人看的词（实测中止长命令时就是这样：pi 给的是 `stopReason: "error"` +
    // `errorMessage: "This operation was aborted"`，下面那行红字已经把原因说全了）。
    (item.errorMessage === undefined || item.errorMessage === "")
  ) {
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
