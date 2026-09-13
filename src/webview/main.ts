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
  renderToolHeadLine,
  renderToolStatusClass,
} from "./render";
import { PROTOCOL_VERSION, type ChatItem, type ClientMessage, type ServerMessage } from "../shared/protocol";

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

interface LiveRegion {
  thinking: HTMLDivElement;
  text: HTMLDivElement;
}

const nodes = new Map<string, HTMLElement>();
const live = new Map<string, LiveRegion>();
/** 工具卡片的三个可独立更新的部分（**就地更新**，见下面 renderTool 的注释）。 */
interface ToolView {
  head: HTMLButtonElement;
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
const order: string[] = [];
/** 耗时 tick（每秒一次，只改进行中卡片的那个 span）。 */
let durationTimer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let model = "";
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
  scrollToBottom();
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

function renderStatus(): void {
  const parts = [model === "" ? "未选择模型" : model, busy ? "生成中…" : "空闲"];
  statusBar.textContent = parts.join(" · ");
  abortButton.hidden = !busy;
  queueButton.hidden = !busy;
  // 发出一份、还没确认的期间禁用发送按钮（避免连点重复发送），但**不禁用输入框**：
  // 流式期间用户还要能打字发 steer。
  sendButton.disabled = pendingText !== undefined;
  // 提示语必须说真话：pi 的 steer **不会掐断正在生成的那段文字**，
  // 而是在"这段输出结束、下一次调用模型之前"注入（pi 的 TUI 也是这个行为）。
  // 第一版的提示语声称"会打断当前回复"，那是照抄 PLAN.md 5.2 的错误描述，已更正。
  hint.textContent = busy ? "Enter：转向（写完这段就注入）\n「追加」：整轮结束后再发" : "";
  scrollToBottom();
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
    node.replaceChildren(view.head, view.body);
    tools.set(item.id, view);
  }

  const isOpen = expanded.has(item.id);
  const bodyHtml = renderToolBody(item, isOpen);
  const text = item.text ?? "";

  // 调 render.ts 的同一个函数拼装按钮内容 —— 不许在这里自己拼（见 S3 第一次验收的教训）。
  setHtml(view.head, renderToolHeadLine(item, isOpen && bodyHtml !== ""));
  view.head.className = `tool-head ${renderToolStatusClass(item)}`;
  view.head.setAttribute("aria-expanded", isOpen && bodyHtml !== "" ? "true" : "false");

  // 正文只在内容真的变了时重写：否则每帧都会把用户的选中与滚动位置清掉。
  const signature = `${isOpen}\u0000${text}\u0000${item.truncation === undefined ? "" : JSON.stringify(item.truncation)}\u0000${item.fullOutputPath ?? ""}\u0000${item.textTruncated === true}`;
  if (toolTextSeen.get(item.id) !== signature) {
    toolTextSeen.set(item.id, signature);
    const keepScroll = view.body.scrollTop;
    setHtml(view.body, bodyHtml);
    // 恢复正文内部的滚动位置（大输出展开时用户会自己往下滚）。
    view.body.scrollTop = keepScroll;
    view.body.hidden = bodyHtml === "";
  }

  ensureDurationTimer();
}

function createToolView(item: Extract<ChatItem, { kind: "tool" }>): ToolView {
  const head = document.createElement("button");
  head.className = "tool-head";
  head.type = "button";
  const body = element("div", "tool-body") as HTMLDivElement;
  body.hidden = true;
  head.addEventListener("click", (event) => {
    const path = (event.target as HTMLElement).dataset?.openPath;
    if (path !== undefined && path !== "") {
      // 点路径不展开卡片：用户的意图是打开文件。
      event.stopPropagation();
      vscode.postMessage({ type: "openFile", path });
      return;
    }
    toggleTool(item.id);
  });
  head.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleTool(item.id);
    }
  });
  return { head, body };
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
const STICK_THRESHOLD_PX = 40;

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

function applyState(message: Extract<ServerMessage, { type: "state" }>): void {
  for (const id of [...order]) removeNode(id);
  transcript.textContent = "";
  busy = message.busy;
  model = message.model;
  if (message.truncated) {
    const node = element("div", "msg msg-notice");
    node.textContent = "（更早的消息已省略）";
    transcript.appendChild(node);
  }
  for (const item of message.items) renderItem(item);
  renderQueue(message.queue);
  renderStatus();

}

// webview 被销毁时停掉耗时定时器（页面隐藏/卸载之后让它空转没有意义）。
window.addEventListener("pagehide", () => {
  if (durationTimer !== undefined) {
    clearInterval(durationTimer);
    durationTimer = undefined;
  }
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
      return;
    case "queue":
      renderQueue({ steering: message.steering, followUp: message.followUp });
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
  event.preventDefault();
  send(busy ? "steer" : "auto");
});

// 链接一律交给扩展去开：webview 里直接跳转会被拦，而且我们要用与渲染层同一份白名单。
transcript.addEventListener("click", (event: MouseEvent) => {
  const target = event.target as HTMLElement | null;
  const anchor = target?.closest("a");
  if (anchor === null || anchor === undefined) return;
  event.preventDefault();
  const href = anchor.getAttribute("href");
  if (href !== null) vscode.postMessage({ type: "openExternal", href });
});

renderStatus();
vscode.postMessage({ type: "ready", protocol: PROTOCOL_VERSION });
