// 把 pi 的消息转成 webview 用的 ChatItem。
//
// **实时路径与重放路径共用这一个序列化器**。这是刻意的：如果实时用事件流转写、
// 重放用消息数组重建，两条路径迟早会长得不一样（第一版计划就出过这个错——
// 重放时把"S2 不做工具卡片"的工具输出正文全冒了出来，用户重开一次面板就看到两个样子）。
//
// 一个约定：**一条 pi 消息最多产出一个 ChatItem**（不是列表）。pi 的 assistant 消息里
// 可以同时有文本、思考与工具调用，但工具调用在 UI 上另有 `kind:"tool"` 的行，
// 所以这里只取文本与思考，不重复展示。

import {
  MAX_REPLAY_CHARS,
  MAX_REPLAY_ITEMS,
  SUMMARY_MAX,
  type ChatItem,
} from "../shared/protocol";

/** pi 消息的最小结构（只取我们真正读的字段，避免依赖完整类型）。 */
interface AnyMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  // toolResult
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // custom / summaries
  customType?: string;
  summary?: string;
  display?: boolean;
  // bashExecution
  command?: string;
  output?: string;
  exitCode?: number | undefined;
  cancelled?: boolean;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  mimeType?: string;
}

/** 工具调用的登记表：toolCallId → 名字与参数摘要。 */
export type ToolCallIndex = Map<string, { name: string; argsText: string }>;

export function createToolCallIndex(): ToolCallIndex {
  return new Map();
}

function blocksOf(message: AnyMessage): ContentBlock[] {
  if (Array.isArray(message.content)) return message.content as ContentBlock[];
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

function joinText(message: AnyMessage): string {
  return blocksOf(message)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function joinThinking(message: AnyMessage): string {
  return blocksOf(message)
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? "")
    .join("");
}

/** 把工具参数压成一行摘要。 */
export function summarizeArgs(args: unknown): string {
  let text: string;
  if (typeof args === "string") {
    text = args;
  } else if (args === undefined || args === null) {
    text = "";
  } else {
    try {
      text = JSON.stringify(args);
    } catch {
      text = String(args);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

/** 登记 assistant 消息里的工具调用，供随后的 toolResult 取参数摘要。 */
export function indexToolCalls(message: AnyMessage, index: ToolCallIndex): void {
  for (const block of blocksOf(message)) {
    if (block.type !== "toolCall") continue;
    const id = block.id ?? "";
    if (id === "") continue;
    index.set(id, {
      name: block.name ?? "tool",
      argsText: summarizeArgs(block.arguments),
    });
  }
}

/**
 * 转一条消息。
 *
 * `index` 是历史消息的下标，**必须**是调用方从 `session.messages` 里数出来的真实位置
 * ——id 的稳定性依赖它（`msg-<index>`）。实时路径要传 `session.messages.length - 1`
 * （pi 在 `message_end` 时**先**把消息压进数组、**之后**才通知监听器，所以那一刻
 * 长度减一就是它的下标）。
 */
export function serializeMessage(
  raw: unknown,
  index: number,
  toolCalls: ToolCallIndex,
): ChatItem | undefined {
  const message = raw as AnyMessage;
  const role = message.role;

  if (role === "user") {
    const text = joinText(message);
    const images = blocksOf(message).filter((block) => block.type === "image").length;
    if (text === "" && images === 0) return undefined;
    return {
      kind: "user",
      id: `msg-${index}`,
      text: images > 0 ? `${text}${text === "" ? "" : "\n"}${"[图片]".repeat(images)}` : text,
    };
  }

  if (role === "assistant") {
    return {
      kind: "assistant",
      id: `msg-${index}`,
      text: joinText(message),
      thinking: joinThinking(message),
      stopReason: message.stopReason ?? "",
      ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
    };
  }

  if (role === "toolResult") {
    const id = message.toolCallId ?? "";
    const known = id === "" ? undefined : toolCalls.get(id);
    return {
      kind: "tool",
      // id 由 toolCallId 构造，**实时与重放构造方式相同**（不依赖下标）：
      // 实时在 tool_execution_start 时先发一条同 id 的"运行中"，toolResult 到达时
      // 用同一个 id upsert 成最终态，不会多出一行。
      id: `tool-${id === "" ? `unknown-${index}` : id}`,
      toolCallId: id,
      toolName: message.toolName ?? known?.name ?? "tool",
      summary: known?.argsText ?? "",
      isError: message.isError === true,
    };
  }

  if (role === "bashExecution") {
    const command = message.command ?? "";
    const status = message.cancelled === true ? "已中止" : `退出码 ${message.exitCode ?? "?"}`;
    return {
      kind: "notice",
      id: `msg-${index}`,
      level: message.cancelled === true ? "warn" : "info",
      text: `! ${command}（${status}）`,
    };
  }

  if (role === "custom") {
    const text = joinText(message) || message.customType || "(自定义消息)";
    return { kind: "notice", id: `msg-${index}`, level: "info", text };
  }

  if (role === "compactionSummary" || role === "branchSummary") {
    return {
      kind: "notice",
      id: `msg-${index}`,
      level: "info",
      text: role === "compactionSummary" ? "（上下文已压缩）" : "（分支摘要）",
    };
  }

  // 未知角色**不静默丢弃**：宁可显示一行带 role 的提示，也不要让用户以为历史里少了什么。
  return {
    kind: "notice",
    id: `msg-${index}`,
    level: "warn",
    text: `（未支持的消息类型：${role ?? "undefined"}）`,
  };
}

export interface SerializeResult {
  items: ChatItem[];
  /** 是否因超出上限丢掉了更早的消息。 */
  truncated: boolean;
}

/**
 * 批量转写（重放用）。从**最新的往旧的**数上限，超出的丢掉并置 `truncated`。
 *
 * 为什么按条数+字符数双上限：单条上限（工具摘要）管不住"会话很长"这件事，
 * 而重放是整包过去的。
 */
export function serializeMessages(messages: readonly unknown[]): SerializeResult {
  const toolCalls = createToolCallIndex();
  const all: ChatItem[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as AnyMessage;
    // 工具调用要先登记，后面的 toolResult 才能取到参数摘要。
    if (message?.role === "assistant") indexToolCalls(message, toolCalls);
    const item = serializeMessage(message, i, toolCalls);
    if (item !== undefined) all.push(item);
  }

  const kept: ChatItem[] = [];
  let chars = 0;
  let truncated = false;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const item = all[i];
    const size = itemChars(item);
    if (kept.length >= MAX_REPLAY_ITEMS || chars + size > MAX_REPLAY_CHARS) {
      truncated = true;
      break;
    }
    kept.push(item);
    chars += size;
  }
  kept.reverse();
  return { items: kept, truncated };
}

function itemChars(item: ChatItem): number {
  switch (item.kind) {
    case "user":
      return item.text.length;
    case "assistant":
      return item.text.length + item.thinking.length + (item.errorMessage?.length ?? 0);
    case "tool":
      return item.summary.length + item.toolName.length;
    case "notice":
      return item.text.length;
  }
}
