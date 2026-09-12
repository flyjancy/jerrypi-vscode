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
  renderToolLine,
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
const order: string[] = [];
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
    const node = ensureNode(item.id, "msg-tool");
    setHtml(node, renderToolLine(item));
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
  const clear = element("button", "button tiny");
  clear.textContent = "清空队列";
  clear.addEventListener("click", () => vscode.postMessage({ type: "clearQueue" }));
  queueBar.append(title, clear);
  for (const text of queue.steering) {
    const row = element("div", "queue-row queue-steer");
    row.textContent = `将打断：${text}`;
    queueBar.appendChild(row);
  }
  for (const text of queue.followUp) {
    const row = element("div", "queue-row queue-followup");
    row.textContent = `排队：${text}`;
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
  hint.textContent = busy ? "Enter 将打断当前回复；点「排队」等本轮结束再发" : "";
  scrollToBottom();
}

function scrollToBottom(): void {
  transcript.scrollTop = transcript.scrollHeight;
}

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

window.addEventListener("message", (event: MessageEvent<ServerMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state":
      applyState(message);
      return;
    case "item":
      renderItem(message.item);
      scrollToBottom();
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
    case "restoreComposer":
      // 中止时被退回的排队文本：追加到输入框（不覆盖用户已经打了一半的内容）。
      input.value = input.value === "" ? message.text : `${input.value}\n${message.text}`;
      input.focus();
      return;
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
