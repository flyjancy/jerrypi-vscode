// 面板前端。
//
// 铁律（与 src/webview/render.ts 配合）：
//   1. **任何来自扩展的数据都不得直接进 innerHTML** —— 唯一例外是 `render.ts`
//      的返回值（它内部已按 pi 的消毒配置处理过）。流式文本一律 `textContent` 追加。
//   2. **按 id upsert**：`item` 消息用 id 定位节点，存在就替换内容、不存在才追加。
//      pi 对同一实体可能发多条消息（工具行先"运行中"再"完成"、assistant 先建壳再收尾），
//      按 id 定位是唯一不会出现重复行的做法。
//   3. 流式期间**不重渲染 markdown**（半截的表格/代码块会闪），只把增量文本追加成纯文本；
//      收到该条的最终 `item` 时才换成渲染后的 HTML。
import {
  renderAssistant,
  renderMarkdown,
  renderNotice,
  renderToolBody,
  renderToolApproval,
  renderToolHeadLine,
  renderToolStatusClass,
  renderMeta,
} from "./render";
import {
  PROTOCOL_VERSION,
  type ChatItem,
  type ClientMessage,
  type ServerMessage,
  type SessionMeta,
} from "../shared/protocol";

interface VsCodeApi {
  postMessage(message: ClientMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const transcript = document.getElementById("transcript") as HTMLDivElement;
const queueBar = document.getElementById("queue") as HTMLDivElement;
const statusBar = document.getElementById("status") as HTMLDivElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendButton = document.getElementById("send-button") as HTMLButtonElement;
const abortButton = document.getElementById("abort-button") as HTMLButtonElement;
const queueButton = document.getElementById("queue-button") as HTMLButtonElement;
const hint = document.getElementById("composer-hint") as HTMLSpanElement;
const errorBox = document.getElementById("composer-error") as HTMLDivElement;
const metaBar = document.getElementById("meta") as HTMLDivElement;

interface LiveRegion {
  thinking: HTMLDivElement;
  text: HTMLDivElement;
}

const nodes = new Map<string, HTMLElement>();
const live = new Map<string, LiveRegion>();
/** 工具卡片的三个可独立更新的部分（**就地更新**，见下面 renderTool 的注释）。 */
interface ToolView {
  head: HTMLButtonElement;
  /** S8 的审批行（在 head 与 body **之间**，见 render.ts 的 renderToolApproval）。 */
  approval: HTMLDivElement;
  body: HTMLDivElement;
}
const tools = new Map<string, ToolView>();
/**
 * 最近一次收到的 item（按 id）。
 *
 * 为什么前端要留一份：展开/折叠时要**重新渲染正文**，而正文来自 item；
 * 再从 DOM 里把文本抠出来（塞 `data-*`）既浪费又容易出错。
 */
const itemById = new Map<string, ChatItem>();
/**
 * 展开的工具卡片 id。
 *
 * 为什么不进协议、也不进 item：展开是**纯 UI 状态**，而流式输出每 200ms 会
 * upsert 一次同一条 item —— 状态一旦跟着 item 走，用户展开的卡片会在下一次
 * 更新时被折叠回去（S3-plan D10）。
 */
const expanded = new Set<string>();
/** 上一次的正文串（用来判断"这一帧真的变了没有"，避免无意义重排）。 */
const toolTextSeen = new Map<string, string>();
/**
 * 上一次的审批状态（S8）。只在**它变了**时才重画状态行 —— 流式卡片每 200ms 一帧，
 * 每帧重画状态行会把用户正指着的那个链接节点换掉。
 */
const toolApprovalSeen = new Map<string, string>();
const order: string[] = [];
/** 耗时 tick（每秒一次，只改进行中卡片的那个 span）。 */
let durationTimer: ReturnType<typeof setInterval> | undefined;
let busy = false;
/** 当前会话元信息（模型/等级/用量）。`undefined` 表示还没收到过（面板刚开）。 */
let meta: SessionMeta | undefined;
/**
 * 已发出、还没被确认的那条文本。
 *
 * 为什么要它：发送后**立即清空输入框**（见 D10 的修订）。清空带来一个新问题——
 * 如果这条根本没被接受（没模型、没凭据…），用户的话就凭空消失了，所以留一份，
 * 收到 `composerError` 时放回去。
 */
let pendingText: string | undefined;

// ------------------------------------------------------------------ DOM 工具

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function removeNode(id: string): void {
  nodes.get(id)?.remove();
  nodes.delete(id);
  live.delete(id);
  // 工具卡片的三份附带状态要一起清：漏掉任何一个都会在长会话里慢慢堆积。
  tools.delete(id);
  itemById.delete(id);
  toolTextSeen.delete(id);
  toolApprovalSeen.delete(id);
  expanded.delete(id);
  const index = order.indexOf(id);
  if (index >= 0) order.splice(index, 1);
}

function ensureNode(id: string, className: string): HTMLElement {
  const existing = nodes.get(id);
  if (existing !== undefined) return existing;
  const node = element("div", `msg ${className}`);
  node.dataset.id = id;
  transcript.appendChild(node);
  nodes.set(id, node);
  order.push(id);
  return node;
}

/** 只有 render.ts 的返回值可以进 innerHTML。 */
function setHtml(node: HTMLElement, html: string): void {
  node.innerHTML = html;
}

// ------------------------------------------------------------------ 渲染

function renderItem(item: ChatItem): void {
  itemById.set(item.id, item);
  if (item.kind === "user") {
    const node = ensureNode(item.id, "msg-user");
    setHtml(node, `<div class="markdown">${renderMarkdown(item.text)}</div>`);
    onUserItem(item.text);
    return;
  }
  if (item.kind === "assistant") {
    const node = ensureNode(item.id, "msg-assistant");
    if (item.streaming === true) {
      // 建壳：先给流式区，等最终 item 到达再整体换成渲染结果。
      setHtml(node, "");
      const thinking = element("div", "live-thinking") as HTMLDivElement;
      thinking.hidden = true;
      const text = element("div", "live-text") as HTMLDivElement;
      node.append(thinking, text);
      live.set(item.id, { thinking, text });
      return;
    }
    live.delete(item.id);
    setHtml(node, renderAssistant(item));
    return;
  }
  if (item.kind === "tool") {
    renderTool(item);
    return;
  }
  const node = ensureNode(item.id, "msg-notice");
  setHtml(node, renderNotice(item));
}

function appendDelta(id: string, kind: "text" | "thinking", delta: string): void {
  const region = live.get(id);
  if (region === undefined) {
    // 没有流式区（例如重放后才开始收增量）：退化成一个普通文本块，
    // 后续该条的最终 item 会把它整体替换掉。
    const node = ensureNode(id, "msg-assistant");
    const fallback = element("div", "live-text") as HTMLDivElement;
    node.appendChild(fallback);
    live.set(id, { thinking: element("div", "live-thinking") as HTMLDivElement, text: fallback });
  }
  const target = kind === "thinking" ? live.get(id)!.thinking : live.get(id)!.text;
  if (kind === "thinking") target.hidden = false;
  target.textContent = (target.textContent ?? "") + delta;
  // **这里不滚**：调用方（delta 分支）自己会走 `scrollIfFollowing()`。
  // 原来这里有一句无条件 `scrollToBottom()`，于是"流式中往上翻"每个 delta 都被拽回底部 ——
  // 跟随的判定权必须只有一个（`following`），否则两处各自决定就会打架。
}

function renderQueue(queue: { steering: string[]; followUp: string[] }): void {
  queueBar.textContent = "";
  const total = queue.steering.length + queue.followUp.length;
  queueBar.hidden = total === 0;
  if (total === 0) return;
  const title = element("div", "queue-title");
  title.textContent = `待处理 ${total} 条`;
  // pi 的队列区在消息下面还有一行提示，指向"取回全部排队消息"这个动作，照做。
  const dequeue = element("button", "button tiny");
  dequeue.textContent = "取回编辑";
  dequeue.addEventListener("click", () => vscode.postMessage({ type: "clearQueue" }));
  queueBar.append(title, dequeue);
  const hintRow = element("div", "queue-hint");
  hintRow.textContent = "↳ 点「取回编辑」把排队的消息放回输入框";
  queueBar.appendChild(hintRow);
  for (const text of queue.steering) {
    const row = element("div", "queue-row queue-steer");
    // 用词对齐 pi 的 TUI：Steering / Follow-up
    row.textContent = `转向：${text}`;
    queueBar.appendChild(row);
  }
  for (const text of queue.followUp) {
    const row = element("div", "queue-row queue-followup");
    row.textContent = `追加：${text}`;
    queueBar.appendChild(row);
  }
}

/**
 * 工作状态行（**输入框上方**，pi 的 statusContainer 位置）。
 *
 * 只显示**瞬态**状态：生成中… / 已中止之类由 notice 负责。
 * 空闲时**内容为空但保留一行高度** —— 空闲时把整行收掉会让输入框上下跳一行
 * （VS Code 里 composer 是底部锚定的），这比"省一行"重要。
 * 另外：**不再出现"空闲"两个字**（与 pi 一致；忙/闲已由按钮与提示语体现）。
 */
function renderStatus(): void {
  // S8（Q8）：有待审批项时状态行要说话 —— 否则卡片滚出视口后用户只看到"生成中…"，
  // 属于静默卡住。提示可点：跳到最后一张待审批的卡片。
  const waiting = pendingApprovalIds();
  if (waiting.length > 0) {
    const suffix = busy ? " · " : "";
    setHtml(
      statusBar,
      `${suffix}<a class="status-approval" data-goto-approval="${escapeForStatus(waiting.at(-1) ?? "")}" role="button" tabindex="0">⚠ 有 ${waiting.length} 个工具调用等待确认（点击跳转）</a>`,
    );
  } else {
    statusBar.textContent = busy ? "生成中…" : "";
  }
  abortButton.hidden = !busy;
  queueButton.hidden = !busy;
  // 发出一份、还没确认的期间禁用发送按钮（避免连点重复发送），但**不禁用输入框**：
  // 流式期间用户还要能打字发 steer。
  sendButton.disabled = pendingText !== undefined;
  // 提示语必须说真话：pi 的 steer **不会掐断正在生成的那段文字**，
  // 而是在"这段输出结束、下一次调用模型之前"注入（pi 的 TUI 也是这个行为）。
  // 第一版的提示语声称"会打断当前回复"，那是照抄 PLAN.md 5.2 的错误描述，已更正。
  hint.textContent = busy ? "Enter：转向（写完这段就注入）\n「追加」：整轮结束后再发" : "";
  // **这里不滚**（S4 的 R10）：状态行/chips 的变化不改变转写内容，
  // 滚动跟随的唯一条件是"内容变了"（delta 与 item 两条路径）。
  // 原来这里有无条件 `scrollToBottom()`，在 meta 每轮刷新几次之后会把翻历史的用户
  // 反复拽回底部。
}

/**
 * 工具卡片：**就地更新**，不重建节点。
 *
 * 为什么不能像其它 item 那样 `setHtml(整块)`：bash 每 200ms upsert 一次，
 * 整体重写会（a）把 `<details>`/展开态重置、（b）清掉正文容器的 `scrollTop`
 * —— 用户正展开着读输出时会被一直拽回顶部（S3-plan 评审第 3 轮第 2 条）。
 * 所以这里只改两处：标题行、正文；节点本身复用。
 */
function renderTool(item: Extract<ChatItem, { kind: "tool" }>): void {
  const node = ensureNode(item.id, "msg-tool");
  let view = tools.get(item.id);
  if (view === undefined) {
    view = createToolView(item);
    node.replaceChildren(view.head, view.approval, view.body);
    tools.set(item.id, view);
  }

  const isOpen = expanded.has(item.id);
  const bodyHtml = renderToolBody(item, isOpen);
  const text = item.text ?? "";

  // 审批行只在内容真的变了时重写 —— 与正文同一个理由（别每帧重排）。
  setHtml(view.approval, renderToolApproval(item));
  view.approval.hidden = item.approval === undefined;
  // 审批状态一变，状态行那句提示也要跟着变（Q8：卡片滚出视口时不能静默）
  const approvalSignature = item.approval ?? "";
  if (toolApprovalSeen.get(item.id) !== approvalSignature) {
    toolApprovalSeen.set(item.id, approvalSignature);
    renderStatus();
  }

  // 调 render.ts 的同一个函数拼装按钮内容 —— 不许在这里自己拼（见 S3 第一次验收的教训）。
  setHtml(view.head, renderToolHeadLine(item, isOpen && bodyHtml !== ""));
  view.head.className = `tool-head ${renderToolStatusClass(item)}`;
  view.head.setAttribute("aria-expanded", isOpen && bodyHtml !== "" ? "true" : "false");

  // 正文只在内容真的变了时重写：否则每帧都会把用户的选中与滚动位置清掉。
  const signature = `${isOpen}\u0000${text}\u0000${item.truncation === undefined ? "" : JSON.stringify(item.truncation)}\u0000${item.fullOutputPath ?? ""}\u0000${item.textTruncated === true}`;
  if (toolTextSeen.get(item.id) !== signature) {
    toolTextSeen.set(item.id, signature);
    // ⚠️ 滚动容器是内层的 `.tool-text`（它有 `max-height: 40vh; overflow: auto`），
    // **不是** `.tool-body`（它没有 overflow，scrollTop 恒为 0）。第一版存的是
    // `.tool-body.scrollTop`，于是"保存/恢复"存了个恒为 0 的值 —— 而 setHtml 会把
    // 内层 `<pre>` 整个换掉，真正的滚动位置照样归零：表现就是用户往下滚了以后
    // 每 200ms 被拽回正文顶部（M7 人工验收实测）。
    const previous = view.body.querySelector(".tool-text") as HTMLElement | null;
    const followedTail =
      previous === null ||
      previous.scrollTop + previous.clientHeight >= previous.scrollHeight - BODY_STICK_THRESHOLD_PX;
    const keepScroll = previous?.scrollTop ?? 0;
    setHtml(view.body, bodyHtml);
    view.body.hidden = bodyHtml === "";
    const next = view.body.querySelector(".tool-text") as HTMLElement | null;
    if (next !== null) {
      // 本来贴着底部（或在顶部没动过）就跟随新输出，否则停在用户看的位置。
      next.scrollTop = followedTail ? next.scrollHeight : keepScroll;
    }
  }

  ensureDurationTimer();
}

function createToolView(item: Extract<ChatItem, { kind: "tool" }>): ToolView {
  const head = document.createElement("button");
  head.className = "tool-head";
  head.type = "button";
  // 审批行：常驻一个空容器（折叠时也要能答），内容由 renderToolApproval 决定。
  // **不挂任何键盘监听**：里面是真 <button>，原生激活会补 click，交给下面捕获阶段的委托。
  const approval = element("div", "tool-approval-slot") as HTMLDivElement;
  approval.hidden = true;
  const body = element("div", "tool-body") as HTMLDivElement;
  body.hidden = true;
  // 标题点击只负责展开/折叠 —— 点路径由下面的**委托**处理（见 onTranscriptClick）。
  head.addEventListener("click", () => toggleTool(item.id));
  head.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleTool(item.id);
    }
  });
  return { head, approval, body };
}

/** 展开/折叠。重渲染正文时**保留滚动位置**。 */
function toggleTool(id: string): void {
  const item = itemById.get(id);
  const view = tools.get(id);
  if (item === undefined || item.kind !== "tool" || view === undefined) return;
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  toolTextSeen.delete(id);
  renderTool(item);
}

/**
 * 耗时 tick：只更新"进行中"卡片里的那个 span。
 *
 * 不进协议的第二个理由：每秒重发一条 item 会让整个卡片重绘。
 * 停表条件：没有进行中的卡片时清掉定时器（否则一个常驻的 1s 定时器会一直跑）。
 */
function ensureDurationTimer(): void {
  const hasRunning = [...tools.keys()].some((id) => {
    const item = itemById.get(id);
    return item?.kind === "tool" && item.pending === true;
  });
  if (!hasRunning) {
    if (durationTimer !== undefined) {
      clearInterval(durationTimer);
      durationTimer = undefined;
    }
    return;
  }
  durationTimer ??= setInterval(() => {
    for (const [id, view] of tools) {
      const item = itemById.get(id);
      if (item?.kind !== "tool" || item.pending !== true) continue;
      const span = view.head.querySelector(".tool-duration") as HTMLElement | null;
      if (span === null || item.startedAt === undefined) continue;
      const seconds = Math.max(0, (Date.now() - item.startedAt) / 1000).toFixed(1);
      span.textContent = `Elapsed ${seconds}s`;
    }
    ensureDurationTimer();
  }, 1000);
}

/**
 * 自动滚动：**只在用户本来就在底部附近**时跟随。
 *
 * 原来是无条件 `scrollTop = scrollHeight`：流式输出（尤其工具卡片每 200ms 一次）
 * 会把正在往上翻历史的用户一直拽回底部（S3-plan 约束 #6）。
 */
/** 转写区"算贴着底部"的容差。 */
const STICK_THRESHOLD_PX = 40;
/** 卡片正文内部"算贴着底部"的容差。 */
const BODY_STICK_THRESHOLD_PX = 24;

function isAtBottom(): boolean {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= STICK_THRESHOLD_PX;
}

function scrollToBottom(): void {
  transcript.scrollTop = transcript.scrollHeight;
}

/** 跟随时才滚（流式与工具更新走这个）。 */
function scrollIfFollowing(): void {
  if (following) scrollToBottom();
}

/** 用户是不是跟着最新内容（滚动时更新；发送时强制跟随）。 */
let following = true;

transcript.addEventListener("scroll", () => {
  following = isAtBottom();
});

/**
 * user 消息回显了 → 这条发送已经落地，不用再留恢复用的副本。
 *
 * D10 原先的设计是"等回显才清空输入框"，实测被推翻：流式期间发的 steer/followUp
 * 会在队列里躺很久（甚至几分钟），输入框里一直留着那句文本，用户会以为没发出去、
 * 想再按一次回车。改成"发送即清空"，反馈由队列条与回显给出。
 */
function onUserItem(_text: string): void {
  pendingText = undefined;
}

// ------------------------------------------------------------------ 消息

function renderMetaBar(): void {
  metaBar.innerHTML = meta === undefined ? "" : renderMeta(meta);
}

function applyState(message: Extract<ServerMessage, { type: "state" }>): void {
  for (const id of [...order]) removeNode(id);
  transcript.textContent = "";
  busy = message.busy;
  // 协议 v4（S5）起 `state` 里没有 `model` 了 —— 模型只说在 `meta` 里。
  meta = message.meta;
  if (message.truncated) {
    const node = element("div", "msg msg-notice");
    node.textContent = "（更早的消息已省略）";
    transcript.appendChild(node);
  }
  for (const item of message.items) renderItem(item);
  renderQueue(message.queue);
  renderStatus();
  renderMetaBar();
  // 快照重放之后**必须**停在底部（与 pi 一致：重开会话看到的是最新内容）。
  // 这一句是 R10 修复的配套：状态渲染不再顺带滚动之后，重开面板就不会自己滚了。
  scrollToBottom();
}

// webview 被销毁时停掉耗时定时器（页面隐藏/卸载之后让它空转没有意义）。
window.addEventListener("pagehide", () => {
  if (durationTimer !== undefined) {
    clearInterval(durationTimer);
    durationTimer = undefined;
  }
});

// 元信息行的点击委托。
//
// 为什么单独挂一处：`#meta` 在 `.composer` 里、**不在** `#transcript` 下，
// 转写那套捕获阶段的委托覆盖不到它。命名与那边保持一致（`data-meta-action`）。
metaBar.addEventListener("click", (event: MouseEvent) => {
  const target = (event.target as HTMLElement | null)?.closest("[data-meta-action]");
  if (target === null || target === undefined) return;
  const action = target.getAttribute("data-meta-action");
  if (action === "model") vscode.postMessage({ type: "openModelPicker" } satisfies ClientMessage);
  else if (action === "thinking") vscode.postMessage({ type: "openThinkingPicker" } satisfies ClientMessage);
  else if (action === "session") vscode.postMessage({ type: "openSessionPicker" } satisfies ClientMessage);
});

window.addEventListener("message", (event: MessageEvent<ServerMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state":
      applyState(message);
      return;
    case "item":
      renderItem(message.item);
      scrollIfFollowing();
      return;
    case "delta":
      appendDelta(message.id, message.kind, message.delta);
      // 流式文本会长到可视区下方 —— 用户在底部时跟随，翻历史时不动。
      // （S2 只在 `item` 上滚，于是"逐字流式"其实是看着字往下跑出屏幕。）
      scrollIfFollowing();
      return;
    case "queue":
      renderQueue({ steering: message.steering, followUp: message.followUp });
      return;
    case "meta":
      // **不滚**：meta 刷新不改转写内容（DOM 测试台有一条 setter 探针锁这个）。
      meta = message.meta;
      renderMetaBar();
      return;
    case "focusInput":
      // 选择器关闭后把焦点还给输入框。不判 `document.hasFocus()`：
      // iframe 没焦点时 `focus()` 只设置文档内 activeElement，等它拿回焦点时正好落在输入框。
      input.focus();
      return;
    case "busy":
      busy = message.busy;
      renderStatus();
      return;
    case "promptAccepted":
      // 服务器已接受（可能只是入队）：可以发下一条了。
      pendingText = undefined;
      renderStatus();
      return;
    case "composerError":
      errorBox.textContent = message.text;
      errorBox.hidden = false;
      // 这条根本没被接受（没模型/没凭据…）：把文本放回输入框，别让它凭空消失。
      if (pendingText !== undefined) {
        if (input.value === "") input.value = pendingText;
        pendingText = undefined;
      }
      renderStatus();
      return;
    case "restoreComposer": {
      // 退回队列消息到输入框。顺序与分隔符**对齐 pi 的 TUI**：
      //   const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
      // 即"队列消息在前、用户已打的内容在后"，空行分隔（按时间顺序读起来才顺）。
      const combined = [message.text, input.value].filter((part) => part.trim() !== "").join("\n\n");
      input.value = combined;
      input.focus();
      return;
    }
    default:
      return;
  }
});

// ------------------------------------------------------------------ 交互

function send(behavior: "auto" | "steer" | "followUp"): void {
  if (pendingText !== undefined) return; // 上一条还没确认，别重复发
  const text = input.value.trim();
  if (text === "") return;
  errorBox.hidden = true;
  pendingText = text;
  input.value = ""; // 立即清空：反馈交给队列条与回显
  vscode.postMessage({ type: "prompt", text, behavior });
}

sendButton.addEventListener("click", () => send(busy ? "steer" : "auto"));
queueButton.addEventListener("click", () => send("followUp"));
abortButton.addEventListener("click", () => vscode.postMessage({ type: "abort" }));

input.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  // 输入法（S5 验收期用户实测）：拼音还在组合中时，回车是"把拼音落成字母"（或选词），
  // **不是发送**。没有这个守卫时，那一按会把（还没组合完的）内容当成消息发出去，
  // 而 IME 随后才把字母插进（已被我们清空的）输入框 —— 于是"消息发出去了，框里还留着那串英文"
  // （中文用户每天都会撞到）。
  // `isComposing` 是标准信号；`keyCode === 229` 是 IME 处理键的旧信号
  // （部分输入法在 compositionend 之后还会补发一次）。
  // 注意：这两条分支里**不能** preventDefault —— 那可能打断输入法的上屏。
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  send(busy ? "steer" : "auto");
});

/**
 * 转写区里的点击**统一在这里分派**（捕获阶段，先于元素自己的 handler）。
 *
 * 为什么必须是"一处委托"：`data-open-path` 出现在两个位置 —— 工具卡片的**标题行**
 * 与**正文**（`完整输出：<路径>`）。第一版只在标题按钮上挂了 handler，正文那条于是
 * 落到了下面这个 markdown 链接处理器里：它 `closest("a")` 找到我们的 `<a>`、
 * `preventDefault()`、然后发现**没有 href**（我们用的是 `data-open-path`），就什么都不做
 * —— 结果是一条**死链**：看着是蓝色可点的、点了没有任何反应（M5 人工验收实测）。
 *
 * 放在捕获阶段是为了让路径点击**先于**标题按钮自己的 click：命中路径时
 * `stopPropagation()` 掉，卡片就不会顺带被展开/折叠。
 */
function onTranscriptClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  // ① 工具卡片里的路径：不是 URL，走 openFile（host 侧用白名单做精确比对）
  const pathElement = target?.closest("[data-open-path]") as HTMLElement | null;
  const path = pathElement?.getAttribute("data-open-path") ?? "";
  if (path !== "") {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: "openFile", path });
    return;
  }
  // ①b 工具卡片上的「查看 diff」：与路径同一条委托路径（别再出现死链）
  const diffElement = target?.closest("[data-open-diff]") as HTMLElement | null;
  const toolCallId = diffElement?.getAttribute("data-open-diff") ?? "";
  if (toolCallId !== "") {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: "openDiff", toolCallId });
    return;
  }
  // ①c 审批按钮（S8）：与路径/diff 同一条捕获阶段委托。真 <button> 的
  //     Enter/Space 会由浏览器补一次 click，所以**不需要**键盘分支（第 2 轮评审 B1）。
  const approveElement = target?.closest("[data-approve]") as HTMLElement | null;
  const approveId = approveElement?.getAttribute("data-approve") ?? "";
  if (approveId !== "") {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: "approvalDecision", toolCallId: approveId, decision: "allow" });
    return;
  }
  const denyElement = target?.closest("[data-deny]") as HTMLElement | null;
  const denyId = denyElement?.getAttribute("data-deny") ?? "";
  if (denyId !== "") {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: "approvalDecision", toolCallId: denyId, decision: "deny" });
    return;
  }
  // ② markdown 里的普通链接：交给扩展用系统浏览器打开
  const anchor = target?.closest("a");
  if (anchor === null || anchor === undefined) return;
  const href = anchor.getAttribute("href");
  if (href === null) return;
  event.preventDefault();
  vscode.postMessage({ type: "openExternal", href });
}

/** 键盘可达性：路径与 diff 链接都是 `role="button" tabindex="0"`，回车/空格也要能打开。 */
function onTranscriptKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target as HTMLElement | null;
  const diffId = target?.closest("[data-open-diff]")?.getAttribute("data-open-diff") ?? "";
  if (diffId !== "") {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: "openDiff", toolCallId: diffId });
    return;
  }
  const path = target?.closest("[data-open-path]")?.getAttribute("data-open-path") ?? "";
  if (path === "") return;
  event.preventDefault();
  event.stopPropagation();
  vscode.postMessage({ type: "openFile", path });
}

/**
 * 还在等用户答的工具卡片（S8）。从 `itemById` 里数 —— 审批是 item 上的字段，
 * 不需要另开一份前端状态（协议已经在推它）。
 */
function pendingApprovalIds(): string[] {
  const ids: string[] = [];
  for (const id of order) {
    const item = itemById.get(id);
    if (item?.kind === "tool" && item.approval === "pending") ids.push(id);
  }
  return ids;
}

/** 状态行里的文本要转义（id 来自协议）。 */
function escapeForStatus(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 跳到某张卡片（状态行那条提示的点击目标）。 */
function scrollToItem(id: string): void {
  const node = nodes.get(id);
  if (node === undefined) return;
  node.scrollIntoView({ block: "center" });
}

statusBar.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const id = target?.closest("[data-goto-approval]")?.getAttribute("data-goto-approval") ?? "";
  if (id === "") return;
  event.preventDefault();
  scrollToItem(id);
});

transcript.addEventListener("click", onTranscriptClick, true);
transcript.addEventListener("keydown", onTranscriptKeydown, true);

renderStatus();
vscode.postMessage({ type: "ready", protocol: PROTOCOL_VERSION });
