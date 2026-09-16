// 工具审批（S8）：三档判定 + 审批表 + `InlineExtension`。
//
// 分工（为什么是这个形状，见 `docs/S8-plan.md` §3.1/§3.2）：
//   - **判定**是纯函数（`needsApproval`）：`off` 谁都不拦；`mutating` 只拦"写的"；
//     `all` 全拦。只读集用 pi 自己的 `createReadOnlyTools` 当 oracle 钉住（host-check 的 A1）。
//   - **审批表**（`createApprovals`）既是 controller 的状态（协议派生、面板重放都读它），
//     也是扩展拿到的"提问方"（`ask`）。挂在 controller 上、活到扩展卸载（会话替换只 `reset()`）。
//   - **扩展工厂**（`createApprovalExtension`）只做三件事：判定 → 问 → 返回 block。
//
// 四条写死的语义（都是评审逼出来的，别"顺手简化"）：
//   1. `ask` **永不抛错、永不无限挂**：`signal` 已 abort 时直接收口，否则注册 abort 监听。
//      pi 在待审批时被 abort 会把这一轮的 signal 打掉（`docs/S8-plan.md` F6 实测）。
//   2. **处理器任何路径都不许抛**（F4）：`emitToolCall` 不 catch，抛出去会变成一条
//      `Extension failed, blocking execution: …` 的 error toolResult —— 用户看不懂、我们也认不出。
//      ⇒ 整个 handler 包在 try/catch 里，**失败一律 block**（闸门坏了就不放行，fail-closed）。
//   3. **`cancelled` 与 `deny` 的 reason 必须分开**（第 1 轮 S1 / 第 2 轮 S2）：用户没拒绝的时候
//      别替他拒绝。今天 pi 会把这两条都覆盖成 `Operation aborted`（因为 reset 路径都先 abort），
//      所以这条断言在纯函数层（A5b）—— 它守的是"pi 哪天不再 abort"。
//   4. **上限只数已决记录**（第 1 轮 N2）：待审批项天然 ≤ 1（F5：同批工具调用是逐个预检的），
//      永远不会被淘汰；已决记录只为"回放一次拒绝"存在（200 条 FIFO）。

import type {
  ExtensionAPI,
  InlineExtension,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { EventSink } from "./bindings";
import { summarizeArgs, titleOf } from "./serialize";

/** 三档（与 `package.json` 的 `enum` 一一对应）。 */
export type ApprovalMode = "off" | "mutating" | "all";

/** 档位的合法取值（`package.json` 的 enum 是这份的字面复制；host-check 比对着它）。 */
export const APPROVAL_MODES: readonly ApprovalMode[] = ["off", "mutating", "all"];

/**
 * `mutating` 档放行的只读工具。
 *
 * ⚠️ **不要手改这张表**：host-check 的 A1 拿 pi 自己的 `createReadOnlyTools(cwd)` 当 oracle
 * 逐字对照（第 1 轮评审 S3：没有第二份实现对照的名单就是实现的镜像）。
 */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * 解析设置值。**只认精确的三个字面量**（大小写、空白都不容忍）：
 * 写错的档位不许"猜"成某个更弱的档位 —— 静默降级成 `off` 就等于用户以为有闸门、
 * 其实没有（R9）。调用方负责记那一行 Output（`createApprovalModeReader`）。
 */
export function parseApprovalMode(raw: unknown): ApprovalMode {
  if (typeof raw !== "string") return "off";
  const trimmed = raw.trim();
  return (APPROVAL_MODES as readonly string[]).includes(trimmed) ? (trimmed as ApprovalMode) : "off";
}

/** 这个工具调用要不要问。`mutating` = "不在只读集里的一律问"（含未知/扩展注册的工具）。 */
export function needsApproval(mode: ApprovalMode, toolName: string): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return !READ_ONLY_TOOLS.includes(toolName);
}

/**
 * 每次工具调用现读档位（`approvalMode` 是 `machine` scope，改了**不需要**重载窗口 ——
 * 与 `agentDir` 不同，见 S6-plan §3.1）。非法值只记**一次** Output（R9），别刷屏。
 */
export function createApprovalModeReader(options: {
  read: () => unknown;
  log?: EventSink;
}): () => ApprovalMode {
  let warned = false;
  return () => {
    const raw = options.read();
    const mode = parseApprovalMode(raw);
    if (!warned && mode === "off" && String(raw).trim() !== "off") {
      warned = true;
      options.log?.appendLine(
        `[approval] 设了无法识别的 jerrypi.approvalMode=${JSON.stringify(raw)}（只认 off/mutating/all）—— 按 off 处理，即不拦任何工具调用`,
      );
    }
    return mode;
  };
}

/** 面板要显示与要问的东西。`title` 是 pi 风格的 call 行（bash 是命令、edit/write 是路径）。 */
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  title: string;
  requestedAt: number;
}

export type ApprovalDecision = "allow" | "deny";
/** `cancelled` = 没答上（用户中止 / 会话替换 / 卸载），**不是**拒绝。 */
export type ApprovalOutcome = ApprovalDecision | "cancelled";

export interface ApprovalRecord {
  toolCallId: string;
  toolName: string;
  title: string;
  requestedAt: number;
  /** 缺席 = 还在等。 */
  decision?: ApprovalOutcome;
}

/** 协议上的审批字段：`pending` 给按钮、`denied` 给"已拒绝"标记；放行/取消都不派生。 */
export interface ApprovalFields {
  approval?: "pending" | "denied";
}

export interface Approvals {
  /** 登记一次提问并等答案。**绝不抛错**；`signal` 已 abort 或随后 abort 都解析成 `cancelled`。 */
  ask(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalOutcome>;
  /** 面板答一次。返回 `false` = 没有这条待审批（已答过 / 已取消 / 未知 id），**不抛错**。 */
  decide(toolCallId: string, decision: ApprovalDecision): boolean;
  /** 会话替换 / 卸载：把待审批的全部以 `cancelled` 收口，并清空（旧转写已经没了）。 */
  reset(): void;
  get(toolCallId: string): ApprovalRecord | undefined;
  /** 协议派生（与 S7 的 `diffFieldsOf` 同一个位置、同一个理由：不把正文塞进协议）。 */
  fieldsOf(toolCallId: string, pending: boolean): ApprovalFields;
  /**
   * **当前还在等**的那些（面板不可见时宿主据此说"有 N 个待确认"）。
   *
   * 为什么要它、而不是让宿主自己记一份：宿主记的那份**只有"面板点按钮"这条退出路径**
   * （S8 的 M1 真机验收实测：被**中止**结掉的、以及会话替换清掉的那些会永远留在副本里，
   * 于是通知里的计数只增不减）。权威只有这一张表。
   */
  pending(): ApprovalRequest[];
  /** 断言用（上限只数已决 —— 见文件头第 4 条）。 */
  size(): { pending: number; decided: number };
}

export interface ApprovalsOptions {
  /** 有人要问（controller 用它就地更新那张卡片 + 通知宿主）。**同步调用**。 */
  onPending: (request: ApprovalRequest) => void;
  log: EventSink;
  /** 已决记录的条数上限（FIFO）。 */
  maxDecided?: number;
}

const DEFAULT_MAX_DECIDED = 200;

export function createApprovals(options: ApprovalsOptions): Approvals {
  const maxDecided = options.maxDecided ?? DEFAULT_MAX_DECIDED;
  /** 插入序 = Map 的迭代序；已决记录按它做 FIFO 淘汰。 */
  const records = new Map<string, ApprovalRecord>();
  /** 还没答的那些（值 = 收口用的 resolve）。 */
  const waiting = new Map<string, (outcome: ApprovalOutcome) => void>();
  /**
   * 挂在 `ctx.signal` 上的中止监听（拿住引用是为了**结算时摘掉**）。
   *
   * ⚠️ 不摘掉的话：用户先点「拒绝」、这一轮里再点「中止」时，abort 监听还会响第二次 ——
   * 而 `settle` 原先无条件覆盖决定，`deny` 就被改写成 `cancelled`，卡片上那个"已拒绝"
   * 标记（回放要用）随之消失。这是**回顾评审（codex）P2** 实测到的形态。
   */
  const watchers = new Map<string, { signal: AbortSignal; listener: () => void }>();

  /** 只数已决：`decided` 与 `waiting` 是同一批 key 的两个视图。 */
  const decidedCount = (): number => {
    let count = 0;
    for (const id of records.keys()) if (!waiting.has(id)) count += 1;
    return count;
  };

  const pruneDecided = (): void => {
    while (decidedCount() > maxDecided) {
      for (const id of records.keys()) {
        if (waiting.has(id)) continue;
        records.delete(id);
        break;
      }
    }
  };

  /**
   * 统一收口：**第一次结算说了算**，并负责摘监听、叫醒 `waiting`、按上限淘汰。
   *
   * 三个"顺带做"的事都有判例（回顾评审 codex 的 P2/P3）：
   *   - 已决的不能被覆盖（拒绝之后再中止，原决定要留着 —— 卡片上那个标记是给回放用的）；
   *   - 监听必须摘（否则 `ctx.signal` 上挂着一堆只响一次却永不触发的闭包）；
   *   - **淘汰也要走这条路**：取消同样是"已决"，而 abort 这条路径原先根本不淘汰
   *     （连着中止 201 次 ⇒ 表里 201 条）。
   */
  const settle = (toolCallId: string, outcome: ApprovalOutcome): void => {
    const record = records.get(toolCallId);
    if (record !== undefined && record.decision === undefined) record.decision = outcome;
    const watcher = watchers.get(toolCallId);
    if (watcher !== undefined) {
      watcher.signal.removeEventListener("abort", watcher.listener);
      watchers.delete(toolCallId);
    }
    const resolve = waiting.get(toolCallId);
    waiting.delete(toolCallId);
    resolve?.(outcome);
    pruneDecided();
  };

  return {
    ask(request, signal) {
      // 同一个 id 问第二次是不可能的（pi 一个 toolCallId 只发一次 tool_call），
      // 真发生了就按"没答上"收口 —— 宁可拦下也不放行。
      if (waiting.has(request.toolCallId)) {
        options.log.appendLine(`[approval] 同一个 toolCallId 被问了两次：${request.toolCallId}`);
        return Promise.resolve("cancelled");
      }
      records.set(request.toolCallId, { ...request });
      if (signal?.aborted === true) {
        settle(request.toolCallId, "cancelled");
        return Promise.resolve("cancelled");
      }
      const promise = new Promise<ApprovalOutcome>((resolve) => {
        waiting.set(request.toolCallId, resolve);
        if (signal !== undefined) {
          const listener = (): void => settle(request.toolCallId, "cancelled");
          watchers.set(request.toolCallId, { signal, listener });
          signal.addEventListener("abort", listener, { once: true });
        }
      });
      // 先登记 `waiting` 再叫宿主：宿主（或测试）在 `onPending` 里就能直接 `decide`。
      // 宿主抛错也必须收口 —— 否则 `waiting` 里留下一条永远没人答的（文件头第 1 条：
      // "永不无限挂"包的是整条路，不只是 signal 那一段）。fail-closed：按没答上处理。
      try {
        options.onPending({ ...request });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        options.log.appendLine(`[approval] 通知面板时出错，按未回答处理：${text}`);
        settle(request.toolCallId, "cancelled");
      }
      return promise;
    },

    decide(toolCallId, decision) {
      if (!waiting.has(toolCallId)) return false;
      settle(toolCallId, decision);
      return true;
    },

    reset() {
      for (const toolCallId of [...waiting.keys()]) settle(toolCallId, "cancelled");
      // `settle` 会把监听摘掉；这里再兜一遍（万一有 watcher 没见过 waiting）
      for (const [toolCallId, watcher] of watchers) {
        watcher.signal.removeEventListener("abort", watcher.listener);
        watchers.delete(toolCallId);
      }
      records.clear();
    },

    get: (toolCallId) => records.get(toolCallId),

    pending() {
      const list: ApprovalRequest[] = [];
      for (const [toolCallId, record] of records) {
        if (record.decision !== undefined) continue;
        if (!waiting.has(toolCallId)) continue;
        list.push({
          toolCallId,
          toolName: record.toolName,
          title: record.title,
          requestedAt: record.requestedAt,
        });
      }
      return list;
    },

    fieldsOf(toolCallId, pending) {
      const record = records.get(toolCallId);
      if (record?.decision === "deny") return { approval: "denied" };
      if (record !== undefined && record.decision === undefined && pending) return { approval: "pending" };
      // 放行 / 取消 / 没问过（`off` 档）都不派生：卡片回到普通形态。
      return {};
    },

    size: () => ({ pending: waiting.size, decided: decidedCount() }),
  };
}

/** 拒绝时给模型的理由（英文：模型与 pi 自己的文案都是英文，`Rejected by user: <标题>`）。 */
export function denyReason(title: string): string {
  return `Rejected by user: ${title}`;
}

/** 取消（中止/会话结束）时的理由 —— **不能**沿用"用户拒绝了"（文件头第 3 条）。 */
export const CANCEL_REASON = "Cancelled: session ended";

export interface ApprovalExtensionOptions {
  /** 每次调用现读（`createApprovalModeReader`）。 */
  mode: () => ApprovalMode;
  approvals: Approvals;
  /** `titleOf` 需要它来把相对路径变成可读形态。 */
  cwd: string;
  log: EventSink;
}

/**
 * 造审批扩展。**返回具名 + `hidden` 的形态**（F10b）：具名才有 `hidden`，
 * 而我们不希望自己的内部机制出现在用户的扩展清单里（C1："与今天完全一致"）。
 */
export function createApprovalExtension(options: ApprovalExtensionOptions): InlineExtension {
  return {
    name: "jerrypi-approval",
    hidden: true,
    factory: (api: ExtensionAPI) => {
      api.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
        try {
          if (!needsApproval(options.mode(), event.toolName)) return undefined;
          const title = approvalTitleOf(event.toolName, event.input, options.cwd);
          const outcome = await options.approvals.ask(
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              title,
              requestedAt: Date.now(),
            },
            ctx.signal,
          );
          if (outcome === "allow") return undefined;
          return {
            block: true,
            reason: outcome === "cancelled" ? CANCEL_REASON : denyReason(title),
          };
        } catch (error) {
          // 文件头第 2 条：不许抛，且 **fail-closed**（闸门坏了就不放行）。
          const text = error instanceof Error ? error.message : String(error);
          options.log.appendLine(`[approval] 审批过程出错，已拦下这次调用：${text}`);
          return { block: true, reason: `jerrypi: approval failed, tool call blocked (${text})` };
        }
      });
    },
  };
}

/**
 * 卡片/审批行上显示的那一行。复用 `serialize.ts` 的 `titleOf`（bash 是命令、edit/write 是路径），
 * 拿不到标题（扩展工具、参数形状不认识）就退回参数摘要 —— 与卡片上的显示同源，
 * 用户看到的就是他刚才在卡片上看到的那个东西。
 */
export function approvalTitleOf(toolName: string, args: unknown, cwd: string): string {
  const title = titleOf(toolName, args, cwd).title?.text;
  if (typeof title === "string" && title !== "") return title;
  const summary = summarizeArgs(args);
  return summary === "" ? toolName : summary;
}
