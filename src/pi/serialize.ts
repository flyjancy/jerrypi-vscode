// 把 pi 的消息转成 webview 用的 ChatItem。
//
// **实时路径与重放路径共用这一个序列化器**。这是刻意的：如果实时用事件流转写、
// 重放用消息数组重建，两条路径迟早会长得不一样（第一版计划就出过这个错——
// 重放时把"S2 不做工具卡片"的工具输出正文全冒了出来，用户重开一次面板就看到两个样子）。
//
// 一个约定：**一条 pi 消息最多产出一个 ChatItem**（不是列表）。pi 的 assistant 消息里
// 可以同时有文本、思考与工具调用，但工具调用在 UI 上另有 `kind:"tool"` 的行，
// 所以这里只取文本与思考，不重复展示。

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_ITEMS,
  SUMMARY_MAX,
  TOOL_TEXT_MAX_BYTES,
  type ChatItem,
} from "../shared/protocol";
import { clipToolText, toolTextFromContent, utf8Length } from "../shared/toolText";
import { diffFieldsOf, type FileChangeStore } from "./filechanges";
import type { Approvals } from "./approval";

/**
 * 序列化的上下文。
 *
 * 存在的理由：工具卡片要显示**可点击的文件路径**，而相对路径只有配上会话 cwd
 * 才能解析成绝对路径。把它作为参数传进来（而不是让序列化器去问控制器），
 * 是为了让**实时与重放两条路径都走同一套铸造逻辑** —— 否则重放开出来的历史卡片，
 * 路径点不了（docs/S3-plan.md 评审第 1 轮第 4 条）。
 */
export interface SerializeContext {
  cwd: string;
  /**
   * S7：diff 的可打开性从 store 派生（**不把 patch 塞进协议** —— 它可以是几十 KB，
   * 而协议每帧都要过）。没传就是"这次序列化不关心 diff"（自测/纯函数断言用）。
   */
  fileChanges?: FileChangeStore;
  /**
   * S8：工具审批的字段也从 store 派生（同一个理由：协议每帧都要过，不塞正文）。
   * 没传就是"这次序列化不关心审批"（自测/纯函数断言用）。
   */
  approvals?: Approvals;
}

/** 没有 cwd 时的兜底（不会用到，但让类型不必可空）。 */
const NO_CWD: SerializeContext = { cwd: "" };

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
  /** toolResult 的 details（各工具不同：bash 有 truncation/fullOutputPath，edit 有 diff/patch）。 */
  details?: unknown;
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

/**
 * 工具调用的登记表：toolCallId → 名字、参数摘要**与原始参数**。
 *
 * 为什么要存原始 `args`：工具卡片的可点击路径要从参数里的 `path` 铸造，
 * 而重放路径上我们只有这条索引（`state.pendingToolCalls` 只给 id）。
 */
export type ToolCallIndex = Map<string, { name: string; argsText: string; args: unknown }>;

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
      args: block.arguments,
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
  context: SerializeContext = NO_CWD,
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
    const openablePaths = openablePathsOfResult(message, known?.args, context);
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
      ...toolBodyOf(message),
      ...toolMetaOf(message.details),
      ...titleOfItem(message.toolName ?? known?.name, known?.args, context),
      // S7：diff 字段（`pending` 的卡片走 tool_execution_start 那条路，这里恒为 false）
      ...(context.fileChanges === undefined
        ? {}
        : diffFieldsOf(context.fileChanges, {
            toolCallId: id,
            toolName: message.toolName ?? known?.name ?? "tool",
            isError: message.isError === true,
            pending: false,
          })),
      // S8：审批字段（重放这条路上工具已经结束，所以 pending 恒为 false ——
      // "待审批"的那种卡片在 controller.snapshot() 的 pendingToolCalls 分支里）
      ...(context.approvals === undefined ? {} : context.approvals.fieldsOf(id, false)),
      // 空数组不写字段：没有可点路径是常态，写一个 `[]` 只会让两端各写一遍空判断。
      ...(openablePaths.length > 0 ? { openablePaths } : {}),
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
export function serializeMessages(
  messages: readonly unknown[],
  context: SerializeContext = NO_CWD,
): SerializeResult {
  const toolCalls = createToolCallIndex();
  const all: ChatItem[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as AnyMessage;
    // 工具调用要先登记，后面的 toolResult 才能取到参数摘要。
    if (message?.role === "assistant") indexToolCalls(message, toolCalls);
    const item = serializeMessage(message, i, toolCalls, context);
    if (item !== undefined) all.push(item);
  }

  const kept: ChatItem[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const item = all[i];
    const size = itemBytes(item);
    if (kept.length >= MAX_REPLAY_ITEMS || bytes + size > MAX_REPLAY_BYTES) {
      truncated = true;
      break;
    }
    kept.push(item);
    bytes += size;
  }
  kept.reverse();
  return { items: kept, truncated };
}

/**
 * 一条 item 占多少**字节**。
 *
 * 按 UTF-8 字节而不是 `String.length`：工具正文现在动辄几十 KB，
 * 而中文会话里"字符数"与"字节数"差三倍（S3-plan D3/D4）。
 */
export function itemBytes(item: ChatItem): number {
  switch (item.kind) {
    case "user":
      return utf8Length(item.text);
    case "assistant":
      return utf8Length(item.text) + utf8Length(item.thinking) + utf8Length(item.errorMessage ?? "");
    case "tool":
      return (
        utf8Length(item.summary) +
        utf8Length(item.toolName) +
        utf8Length(item.text ?? "") +
        utf8Length(item.fullOutputPath ?? "") +
        (item.openablePaths?.reduce((sum, path) => sum + utf8Length(path), 0) ?? 0)
      );
    case "notice":
      return utf8Length(item.text);
  }
}

// ------------------------------------------------------------------ 工具卡片

/**
 * 剥掉 pi 附在正文末尾的截断脚注。
 *
 * pi 在截断时会把 `[Showing lines 2001-4000 of 4000. Full output: <path>]` 直接写进正文，
 * 而**我们另外渲染"已截断：…"与"完整输出：…"两行**（这正是 pi 的 TUI 做法：
 * 它在 `renderResult` 里把这段脚注从正文剥掉，另起一行 warning）。不剥的话：
 *   - 同一件事在卡片里说三遍；
 *   - 折叠预览只有 5 行，这段脚注要占掉 2 行，真正的内容只剩 3 行。
 * 剥除条件与 pi 完全一致（未完成、已截断、有 fullOutputPath、正文以 `]` 结尾、
 * 最后一段 `\n\n[…` 里确实含那个路径）。
 */
export function stripPiTruncationFooter(text: string, details: unknown): string {
  const meta = toolMetaOf(details);
  if (meta.truncation === undefined || meta.fullOutputPath === undefined) return text;
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("]")) return text;
  // pi 的 bash 用的是 `\n\n[`（它自己的 renderResult 也只认这个），
  // 但 read/grep 那几处的脚注只隔一个换行 —— 两种都认，其余条件照样卡死。
  const at = trimmed.lastIndexOf("\n\n[") !== -1 ? trimmed.lastIndexOf("\n\n[") : trimmed.lastIndexOf("\n[");
  if (at === -1) return text;
  const tail = trimmed.slice(at);
  if (!tail.includes(meta.fullOutputPath)) return text;
  return trimmed.slice(0, at).trimEnd();
}

/** toolResult 的正文部分。 */
function toolBodyOf(message: AnyMessage): { text?: string; textTruncated?: boolean } {
  const body = stripPiTruncationFooter(toolTextFromContent(message.content), message.details);
  // 空正文**不写字段**：卡片折叠时本来就不显示正文，写个空串只会让"有没有正文"这个判断
  // 在两端各写一遍（而且 `(no output)` 这种占位是 pi 自己加在文本里的，我们照显示）。
  if (body === "") return {};
  const clipped = clipToolText(body, TOOL_TEXT_MAX_BYTES);
  return clipped.clipped
    ? { text: clipped.text, textTruncated: true }
    : { text: clipped.text };
}

/** toolResult 的 details → 展示用的标量（**绝不带** pi 的 `truncation.content`）。 */
export function toolMetaOf(details: unknown): {
  truncation?: { truncatedBy: "lines" | "bytes"; totalLines: number; outputLines: number; maxBytes?: number };
  fullOutputPath?: string;
} {
  if (details === null || typeof details !== "object") return {};
  const raw = details as { truncation?: unknown; fullOutputPath?: unknown };
  const out: {
    truncation?: { truncatedBy: "lines" | "bytes"; totalLines: number; outputLines: number; maxBytes?: number };
    fullOutputPath?: string;
  } = {};
  const truncation = raw.truncation as
    | { truncated?: unknown; truncatedBy?: unknown; totalLines?: unknown; outputLines?: unknown; maxBytes?: unknown }
    | undefined;
  if (truncation !== undefined && truncation !== null && truncation.truncated === true) {
    out.truncation = {
      truncatedBy: truncation.truncatedBy === "lines" ? "lines" : "bytes",
      totalLines: typeof truncation.totalLines === "number" ? truncation.totalLines : 0,
      outputLines: typeof truncation.outputLines === "number" ? truncation.outputLines : 0,
      ...(typeof truncation.maxBytes === "number" ? { maxBytes: truncation.maxBytes } : {}),
    };
  }
  if (typeof raw.fullOutputPath === "string" && raw.fullOutputPath !== "") {
    out.fullOutputPath = raw.fullOutputPath;
  }
  return out;
}

/**
 * 从工具参数里取可点击的文件路径。
 *
 * 只认 `path` 与 `file_path`（read 两种写法都用过）—— **不从命令文本里正则猜路径**：
 * 猜错比猜不到更糟（S3-plan D7）。
 */
export function openablePathsOfArgs(args: unknown, context: SerializeContext): string[] {
  if (args === null || typeof args !== "object") return [];
  const raw = (args as { path?: unknown; file_path?: unknown }).file_path ?? (args as { path?: unknown }).path;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return [absolutePathOf(raw, context.cwd)];
}

/** `tool_execution_start` 用的入口（它手上只有 args）。 */
export function openablePathsOfToolCall(args: unknown, cwd: string): string[] {
  return openablePathsOfArgs(args, { cwd });
}

/** toolResult 的入口：参数里的路径 + 完整输出文件。 */
function openablePathsOfResult(
  _message: AnyMessage,
  args: unknown,
  context: SerializeContext,
): string[] {
  const paths = openablePathsOfArgs(args, context);
  const details = (_message.details ?? undefined) as { fullOutputPath?: unknown } | undefined;
  if (details !== null && details !== undefined && typeof details.fullOutputPath === "string") {
    if (details.fullOutputPath !== "") paths.push(details.fullOutputPath);
  }
  // 去重：同一个路径出现两次时点哪个都一样，重复只会让白名单变大。
  return [...new Set(paths)];
}

/** 标题里命令/路径的显示上限（超出就省略；卡片很窄）。 */
const TITLE_MAX = 160;

/** 压成一行（命令里可能有换行）。 */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** pi 的 `shortenPath`：家目录前缀缩成 `~`（窄栏里这点很值）。 */
export function shortenPath(value: string): string {
  const home = homedir();
  if (home !== "" && value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value;
}

function clip(value: string): string {
  return value.length > TITLE_MAX ? `${value.slice(0, TITLE_MAX)}…` : value;
}

/**
 * 构造工具卡片的**标题**（照 pi 的 call 行，`core/tools/renderers/*.js`）：
 *
 *   - bash / powershell → 命令原文（pi 前面有个 `$` 提示符；我们这一行本来就有工具名，
 *     再放一个 `$` 是重复，所以省略）+ ` (timeout Ns)`；
 *   - read → `~/path:10-20`（offset/limit 转成行号范围）；
 *   - write / edit → `~/path`；
 *   - 其它（含扩展工具）→ 不铸造，调用方回退到原始的 JSON 参数摘要。
 *
 * `link` 是标题里**可点击的那一段**：显示形态是缩短过的（`~/a.ts`），
 * 而 `path` 是解析后的绝对路径（白名单的键）。两者必须分开，因为白名单比对的是绝对路径。
 */
export function titleOf(
  toolName: string | undefined,
  args: unknown,
  cwd: string,
): { title?: { text: string; link?: { text: string; path: string } } } {
  if (typeof toolName !== "string" || args === null || typeof args !== "object") return {};
  const a = args as Record<string, unknown>;

  if (toolName === "bash" || toolName === "powershell") {
    if (typeof a.command !== "string") return {};
    const command = singleLine(a.command);
    if (command === "") return {};
    const timeout = typeof a.timeout === "number" ? ` (timeout ${a.timeout}s)` : "";
    return { title: { text: `${clip(command)}${timeout}` } };
  }

  // 只给内置的路径类工具铸造标题：扩展工具的 `path` 未必是文件路径，
  // 猜错比不猜更糟（回退到 JSON 参数摘要它至少是准确的）。
  if (toolName !== "read" && toolName !== "write" && toolName !== "edit") return {};

  const raw = typeof a.file_path === "string" ? a.file_path : typeof a.path === "string" ? a.path : undefined;
  if (raw === undefined || raw.trim() === "") return {};
  const absolute = absolutePathOf(raw, cwd);
  const display = shortenPath(absolute);

  let text = display;
  if (toolName === "read") {
    const offset = typeof a.offset === "number" ? a.offset : undefined;
    const limit = typeof a.limit === "number" ? a.limit : undefined;
    const start = offset ?? (limit === undefined ? undefined : 1);
    if (start !== undefined) text += `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
  }
  return { title: { text, link: { text: display, path: absolute } } };
}

/** `titleOf` 的调用形态（toolResult 分支用）。 */
function titleOfItem(
  toolName: string | undefined,
  args: unknown,
  context: SerializeContext,
): { title?: { text: string; link?: { text: string; path: string } } } {
  return titleOf(toolName, args, context.cwd);
}

/** 相对路径按会话 cwd 解析；已经是绝对路径就原样返回。 */
function absolutePathOf(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (isAbsolute(trimmed)) return trimmed;
  if (cwd === "") return trimmed;
  return resolvePath(cwd, trimmed);
}
