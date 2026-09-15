// 面板会话主机：长期持有**一个** pi 会话，并把 pi 的事件翻译成协议消息。
//
// 三条设计主线，都是评审逼出来的，改动前请先读完：
//
//   1. **UI 只由 `message_end` 驱动，转写与重放共用同一个序列化器**。
//      pi 对 toolResult 只发 `message_start`+`message_end`（agent-loop.js:557-558），
//      对进行中的 assistant 又会发**两次** `message_start`（partial 与 final，两者互斥分支）。
//      如果实时走事件流、重放走消息数组，两条路径迟早长得不一样。
//   2. **id 的唯一权威在本文件**。同一实体在整个生命周期里 id 不得改变：
//      进行中的 assistant 用 `activeAssistantId`（结束时**必须**继续用），
//      工具行用 `tool-<toolCallId>`，历史消息用 `msg-<下标>`，
//      运行时提示用 `notice-<递增序号>`（**绝不能**用 `msg-` 前缀：提示不是消息、
//      没有下标，与刚结束的消息撞下标会把真实回复整条替换掉）。
//   3. **空闲以 `agent_settled` 为准**，但 `agent_settled` 不是万能的：扩展命令由
//      `prompt()` 内部直接执行、不启动 agent run，因此永远不会settle —— 必须在
//      `prompt()` 返回后与 `session.isIdle` 对账一次（否则状态行永久卡在"生成中"）。
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { TOOL_FRAME_MS, type ChatItem, type ServerMessage, type SessionMeta } from "../shared/protocol";
import { sessionDisplayName } from "../shared/format";
import { toolTextFromContent } from "../shared/toolText";
import type { EventSink } from "./bindings";
import type { PiModule } from "./loader";
import { alignPanelModel } from "./model-choice";
import {
  createToolCallIndex,
  indexToolCalls,
  openablePathsOfToolCall,
  titleOf,
  serializeMessage,
  serializeMessages,
  summarizeArgs,
  toolMetaOf,
  type ToolCallIndex,
  type SerializeContext,
} from "./serialize";
import { createSessionHost, type SessionHost } from "./session";
import { createFileChanges, recordEditsFromMessages, type FileChangeStore } from "./filechanges";
import type { TrustAnswer, TrustMemoLike } from "./trust";
import {
  createApprovals,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
  type Approvals,
} from "./approval";
import { resolveSessionDir, sessionsRootOf } from "./sessions";
import { getModelRuntime, type ApiKeyStore } from "./runtime";

/** delta 合帧窗口：合并相邻增量**不改变内容与顺序**，只是少几千次 IPC 往返。 */
const DELTA_FRAME_MS = 16;

export type PromptBehavior = "auto" | "steer" | "followUp";

export interface SessionHostControllerOptions {
  /**
   * pi 的句柄或加载器。
   *
   * 允许传加载器（`() => loadPi(...)`）是因为扩展的 `activate()` **不能**被 pi 的加载阻塞
   * （S0-D3）：视图与命令要立刻注册，pi 留到面板第一次要数据时再加载。
   */
  pi: PiModule | (() => Promise<PiModule>);
  cwd: string;
  /** 不传时用 `pi.getAgentDir()`（即尊重 `PI_CODING_AGENT_DIR` 与 `~/.pi/agent`）。 */
  agentDir?: string;
  keys: ApiKeyStore;
  uiContext: ExtensionUIContext;
  /** 诊断输出（Output channel）。 */
  log: EventSink;
  /** 发往 webview 的消息出口。 */
  onMessage: (message: ServerMessage) => void;
  /**
   * 会话的**根**目录（即 `<agentDir>/sessions` 这一层），默认取 agentDir 下的 sessions。
   * 单独拿出来是为了让本地端到端测试能用临时目录，不去动用户的 `~/.pi/agent`。
   *
   * ⚠️ **它是根，不是 pi 的 `sessionDir` 参数**：pi 那个参数要的是"直接装 jsonl 的目录"
   * （per-cwd 的编码子目录），差一层就会把会话写到没人看得见的地方 ——
   * 细节与实测见 `src/pi/sessions.ts` 的文件头注释。名字从 `sessionsDir` 改成
   * `sessionsRoot` 就是 S5 为了让编译器抓出这个误用（docs/S5-plan.md 的 D2）。
   */
  sessionsRoot?: string;
  /**
   * 会话被替换成功后通知宿主（D6）。**没有参数**：宿主要做的只是重新要一次全量快照 ——
   * 这样 `state` 的组装（protocol 版本、truncated）就仍然只有 chatView 一处。
   */
  onSessionReplaced?: () => void;
  /** 额外加载的 pi 扩展（测试用；后续的 `jerrypi.extensionPaths` 设置也会走这里）。 */
  additionalExtensionPaths?: string[];
  /**
   * S8：工具审批档位。**每次工具调用现读**（`approvalMode` 是 machine scope 设置，
   * 改了不需要重载窗口）。缺省 = 永远 `off`。
   */
  approvalMode?: () => ApprovalMode;
  /**
   * S8：有工具调用在等确认。宿主用它弹通知（面板不可见时）、Q10 的"销毁后再提一次"也走这里。
   *
   * 与 `onSessionReplaced` 同一条纪律：controller 不认识 `vscode`，通知由宿主做。
   */
  onApprovalPending?: (request: ApprovalRequest) => void;
  /**
   * S8：项目信任的问（VS Code 模态；`src/host/trustPrompt.ts`）。不给 ⇒ 不传信任钩子，
   * 行为与今天完全一致（`projectTrusted:false`）。
   */
  askProjectTrust?: (cwd: string) => Promise<TrustAnswer>;
}

/**
 * 会话替换的结果（D7/D9）。
 *
 * 为什么返回结果而不直接弹窗：**分类在 controller，文案/弹窗在 host** ——
 * controller 拿不到 `vscode.window`，而 `controller-check` 也断言不了"有没有弹窗"（评审 S4）。
 */
export type SessionReplaceOutcome =
  | { ok: true }
  | { ok: false; code: "busy" | "cancelled" | "missing-cwd"; detail?: string };

/** `snapshot()` 的产物。 */
export interface ReplaySnapshot {
  items: ChatItem[];
  truncated: boolean;
  queue: { steering: string[]; followUp: string[] };
  busy: boolean;
  cwd: string;
  meta: SessionMeta;
  errorMessage?: string;
}

/** 会话上我们真正读写的成员（避免把整个 AgentSession 类型铺开）。 */
interface SessionView {
  messages: readonly unknown[];
  /** S5：会话自己的身份与目录（`AgentSession.sessionManager` 是 public）。 */
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
    getCwd(): string;
    getSessionDir(): string;
  };
  model?: { provider?: string; id?: string; name?: string; contextWindow?: number } | null;
  thinkingLevel: string;
  supportsThinking(): boolean;
  getContextUsage():
    | { tokens: number | null; percent: number | null; contextWindow: number }
    | undefined;
  isStreaming: boolean;
  isIdle: boolean;
  state: {
    streamingMessage?: unknown;
    pendingToolCalls: ReadonlySet<string>;
    errorMessage?: string;
  };
  prompt(
    text: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      /** pi 在**接受**这条 prompt 时回调 true（见协议里 `promptAccepted` 的说明）。 */
      preflightResult?: (success: boolean) => void;
    },
  ): Promise<void>;
  abort(): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  setModel(model: never, options?: { persist?: boolean }): Promise<void>;
  setThinkingLevel(level: never, options?: { persist?: boolean }): void;
  getAvailableThinkingLevels(): readonly string[];
  modelRuntime: { getAvailable(providerId?: string): Promise<readonly unknown[]> };
}

export class SessionHostController {
  private readonly options: SessionHostControllerOptions;

  /** 给 `diff.ts` 的 presenter 用（白名单与内容都从这里取）。 */
  get diffStore(): FileChangeStore {
    return this.fileChanges;
  }
  private host: SessionHost | undefined;
  private ensuring: Promise<void> | undefined;
  private disposed = false;

  /**
   * 上一次广播出去的 meta 的指纹（去重）。
   *
   * `message_end` 每条消息都来（含工具结果），不做去重会让前端每轮重绘十几次。
   * **快照之后必须清掉**（同 `lastBusy`）：否则重开面板时第一条相同的 meta 会被
   * 当成重复而丢掉，面板就会一直显示旧模型。
   */
  private lastMeta: string | undefined;
  /**
   * 用户在**面板里**选过的模型（S4 的 D15）。
   *
   * 只活在内存里：一旦落盘（`workspaceState`/`globalState`）它就是第三份"默认模型"
   * 设置，S6 得同时和 pi 的 settings 与它对账。规则写死为
   * **"你在面板里选过模型，本窗口就一直用它，直到你再换或重开窗口"** ——
   * 面板里点的那一下是用户最近、最明确的一次表态。
   */
  private panelModel: unknown;

  /** 进行中的那条 assistant 消息的 id（唯一权威，见文件头注释 2）。 */
  private activeAssistantId: string | undefined;
  private liveCounter = 0;
  private noticeCounter = 0;

  /** 工具调用登记表：给 toolResult 补参数摘要（与重放共用同一套转写逻辑）。 */
  /**
   * S7：这次调用改了什么（`edit` 的 patch / `write` 的前后内容）。
   *
   * 挂在 **controller** 上而不是 SessionHost 上：切会话时 host 会被替换，而 store 要
   * 活到扩展卸载（重放要靠它把 edit 的 patch 找回来）。
   */
  private readonly fileChanges: FileChangeStore = createFileChanges();

  /**
   * S8：工具审批表。
   *
   * 与 `fileChanges` 同一个理由挂在 controller 上（会话替换时只 `reset()`，表本身活着）：
   * 面板重开要靠它把"还在等的那条"重放出来（C6）。
   */
  /**
   * S8：信任裁决的**跨会话缓存**（同一个 cwd 只裁决一次，CLI 的 `projectTrustByCwd`；F11）。
   * `Pi: Project Trust…` 改判之后要 `clearTrustMemo()`，否则下一个会话还用旧答案。
   */
  private readonly trustDecisions = new Map<string, boolean>();

  private readonly approvals: Approvals = createApprovals({
    onPending: (request) => this.onApprovalPending(request),
    log: { appendLine: (line) => this.options.log.appendLine(line) },
  });

  private readonly toolCalls: ToolCallIndex = createToolCallIndex();
  /** 已发出的工具行，用于"中止时把仍在执行的标记为已中止"。 */
  private readonly toolItems = new Map<string, ToolItem>();
  /**
   * 正在执行的工具（toolCallId）。
   *
   * 存在的唯一理由是**丢弃过期帧**：`tool_execution_end` 之后可能还有一帧排着队，
   * 如果它落在最终 item 之后，就会用不带截断脚注的旧正文把最终正文覆盖回去
   * （docs/S3-plan.md 评审第 2 轮第 6 条）。
   */
  private readonly runningTools = new Set<string>();
  /**
   * 每个工具**已经流出来的**正文快照。
   *
   * pi 不保存 partial 输出（消息里没有、`state.pendingToolCalls` 只有 id），
   * 所以"面板中途重开时已经流出来的字还在吗"完全取决于这份缓存 —— C1/N1 家族的第四处。
   */
  private readonly partials = new Map<string, ToolPartial>();
  /** 每个工具的起止时间（只在实时路径有；重放时没有就不显示耗时）。 */
  private readonly toolTimes = new Map<string, { startedAt?: number; endedAt?: number }>();
  /** 每个工具的待发帧（`TOOL_FRAME_MS` 合并）。 */
  private readonly toolFrameTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每个工具上一次发帧的时间。 */
  private readonly toolLastEmit = new Map<string, number>();
  /**
   * 可打开路径的白名单。
   *
   * 铸造点在 `serialize.ts`（实时与重放同一套逻辑），这里只登记；
   * `snapshot()` 时**重建**而不是累加 —— 快照之后 webview 上的卡片就是这些，
   * 于是"重开面板后历史卡片的路径仍可点"自然成立。
   */
  private openableFiles = new Set<string>();

  /** 在途的发送（乐观 busy 用：`isStreaming` 在 agent_start 之前还是 false）。 */
  private pendingSend = false;
  /** 上一次发给前端的 busy 值：同值不发，免得 UI 反复重绘。 */
  private lastBusy: boolean | undefined;

  private deltaBuffer = new Map<string, string>();
  private deltaTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SessionHostControllerOptions) {
    this.options = options;
  }

  get ready(): boolean {
    return this.host !== undefined;
  }

  get session(): AgentSession | undefined {
    return this.host?.session;
  }

  /** 取 pi 句柄（惰性加载只发生一次，失败会把 promise 丢弃以便下次重试）。 */
  private async loadPi(): Promise<PiModule> {
    const { pi } = this.options;
    return typeof pi === "function" ? await pi() : pi;
  }

  /** 幂等地建会话。失败会抛错，由调用方转成面板提示。 */
  async ensure(): Promise<void> {
    if (this.host !== undefined) return;
    if (this.disposed) throw new Error("jerrypi: 会话已关闭");
    this.ensuring ??= this.createHost().finally(() => {
      this.ensuring = undefined;
    });
    await this.ensuring;
  }

  /**
   * 每次会话建立/替换后要做的事：重置实时状态、广播 meta、**记一行会话文件路径**、
   * 以及（替换时）通知宿主"该重放了"。
   *
   * 为什么需要那个回调（D6）：会话换了之后**面板必须重放**，否则它会继续显示上一个会话的
   * 转写（而且新消息的 `msg-<下标>` 会和旧内容撞号）。重放本身由宿主做（`state` 的组装
   * 只在 chatView 一处），controller 只负责"替换成功后叫一声"。
   */
  private afterSessionChange(reason: "start" | "new" | "switch"): void {
    this.resetLiveState();
    this.publishMeta();
    const file = this.host?.session.sessionManager.getSessionFile();
    this.options.log.appendLine(
      `[controller] 会话文件：${
        typeof file === "string" && file.length > 0
          ? file
          : "(尚未落盘：pi 在首条 assistant 消息之后才建文件)"
      }`,
    );
    // 首个会话不发：宿主那时正要自己发一次全量 state（`ready` 的处理里），
    // 发了就是两条一样的。
    if (reason !== "start") this.options.onSessionReplaced?.();
  }

  /**
   * "面板正忙吗" —— **与面板显示的那个忙同源**（D7；评审 B2）。
   *
   * 不能只用 `session.isIdle`：pi 的 `isIdle = !_isAgentRunActive && !isCompacting`
   * （`agent-session.js:620-622`）—— 它看得到续跑循环里的队列，但**看不到**
   * "已发送、`agent_start` 还没到"那个窗口，而本仓自己为它维护了 `pendingSend`。
   */
  private isBusy(): boolean {
    if (this.host === undefined) return false;
    return this.pendingSend || !this.view().isIdle;
  }

  private async createHost(): Promise<void> {
    const { cwd, keys } = this.options;
    const pi = await this.loadPi();
    const agentDir = this.options.agentDir ?? pi.getAgentDir();
    // 每次创建 ModelRuntime 之后都要重新注入 key：pi 的 setRuntimeApiKey 只写内存。
    const modelRuntime = await getModelRuntime(pi, agentDir, keys);
    // **必须经 resolveSessionDir**：pi 的 `sessionDir` 参数是 per-cwd 的目录，不是根。
    const sessionsRoot = this.options.sessionsRoot ?? sessionsRootOf(agentDir);
    // D4：**启动时接过上一会话**（`continueRecent`），不再每次都新建 ——
    // 这就是 G3 的"重启 VS Code 后能恢复上一会话"。没有已落盘会话时，continueRecent
    // 返回的 manager 等价于新建（session-manager.js:1247-1252），所以不用特判。
    // 注意它的"最近"是**文件 mtime**，与 list() 的消息活动时间不是同一个键（plan §3.2）。
    const sessionManager: SessionManager = pi.SessionManager.continueRecent(
      cwd,
      resolveSessionDir(cwd, sessionsRoot),
    );

    const host = await createSessionHost({
      pi,
      cwd,
      agentDir,
      sessionManager,
      keys,
      uiContext: this.options.uiContext,
      mode: "rpc",
      sink: this.options.log,
      additionalExtensionPaths: this.options.additionalExtensionPaths,
      // S7：`write` 的前后内容（只在本次进程内存活；重放拿不到，见 filechanges 的文件头）
      writeRecorder: {
        record: (record) =>
          this.fileChanges.recordWrite({
            toolCallId: record.toolCallId,
            path: record.absolutePath,
            before: record.before,
            after: record.after,
            newFile: record.newFile,
            ...(record.failure === undefined ? {} : { failure: record.failure }),
          }),
      },
      // 与 pi CLI 的行为刻意不同：不信任工作区里的项目级设置（见 README 已知限制）。
      projectTrusted: false,
      // S8：审批扩展（档位现读；审批表挂在 controller 上，切会话不丢历史记录）
      approval: {
        mode: this.options.approvalMode ?? (() => "off"),
        approvals: this.approvals,
      },
      // S8：项目信任（不给就不传钩子 —— 自测与夹具保持"今天的行为"）
      ...(this.options.askProjectTrust === undefined
        ? {}
        : { projectTrust: { ask: this.options.askProjectTrust, memo: this.trustDecisions } }),
      onEvent: (event) => this.handleEvent(event),
      onExtensionError: (error) => this.handleExtensionError(error),
      // 面板不钉模型：用户选过就听用户的（见 alignPanelModel 的注释）。
      // 挂在 onRebind 上是因为 `newSession()` 之后 pi 会重新解析模型，建会话时做一次不够。
      onRebind: async (session) => {
        // D15：面板里选过的模型**优先**（用户在面板点的那一下是最近、最明确的表态）。
        // 凭据可能在两次会话之间失效，所以这里要真的试一次：失败就退回下面的兜底，
        // 并且**要告诉用户**（否则看起来像"我选的模型被吞了"）。
        if (this.panelModel !== undefined) {
          try {
            await session.setModel(this.panelModel as never);
            this.options.log.appendLine(
              `[controller] 模型：沿用你在面板里选的（${this.sessionMeta(session).model}）`,
            );
            this.publishMeta();
            return;
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.options.log.appendLine(`[controller] 面板里选的模型现在不可用：${text}`);
            this.notice("warn", `上次选的模型现在不可用，已回退：${text}`);
            this.panelModel = undefined;
          }
        }
        const detail = await alignPanelModel(
          session as unknown as Parameters<typeof alignPanelModel>[0],
          modelRuntime as { getAvailable(): Promise<readonly unknown[]> },
        );
        this.options.log.appendLine(`[controller] 模型：${detail}｜cwd=${cwd}｜agentDir=${agentDir}`);
        this.publishMeta();
      },
    });
    this.host = host;
    this.afterSessionChange("start");
    this.warnIfCliSessionDirRedirected(pi, cwd, agentDir);
  }

  /**
   * 诊断（R9）：CLI 侧有两个"把会话目录整体搬走"的开关 ——
   * 环境变量 `PI_CODING_AGENT_SESSION_DIR`（`config.js:407`、`main.js:531-534`）与
   * `settings.json` 的 `sessionDir`（`settings-manager.js:450-453`）。
   *
   * 面板**不跟随**（跟随会把目录推导从一份变成三份，而 agentDir 的事属于 S6），
   * 但要不声不响地分叉会弄出极难自诊的现象（终端与面板各写一处）→ 至少记一行。
   * 优先级（实现侧）：`--session-dir` > 环境变量 > settings.json。
   */
  private warnIfCliSessionDirRedirected(pi: PiModule, cwd: string, agentDir: string): void {
    const env = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (typeof env === "string" && env.length > 0) {
      this.options.log.appendLine(
        `[controller] 注意：环境变量 PI_CODING_AGENT_SESSION_DIR=${env} 会让终端里的 pi 把会话写到那个目录，` +
          "面板不跟随（它固定用 <agentDir>/sessions/<编码 cwd>/）。两边会分叉。",
      );
    }
    try {
      const fromSettings = pi.SettingsManager.create(cwd, agentDir, {
        projectTrusted: false,
      }).getSessionDir();
      if (typeof fromSettings === "string" && fromSettings.length > 0) {
        this.options.log.appendLine(
          `[controller] 注意：settings.json 里的 sessionDir=${fromSettings} 会让终端里的 pi 把会话写到那里，` +
            "面板不跟随。两边会分叉。",
        );
      }
    } catch {
      // 读设置失败不影响会话（上面已经在建会话时读过一次了）——这是诊断，不是功能。
    }
  }

  // ---------------------------------------------------------------- 发送语义

  /**
   * 发送一条消息。
   *
   * `prompt()` 的 promise **要到整轮结束才 resolve**，所以调用方（消息路由）
   * 必须立刻返回、不要 await 它。这里负责 busy 的置位与对账。
   */
  async prompt(text: string, behavior: PromptBehavior): Promise<void> {
    await this.ensure();
    const session = this.view();
    this.pendingSend = true;
    this.emit({ type: "busy", busy: true });
    try {
      await this.sendPrompt(session, text, behavior);
    } finally {
      this.pendingSend = false;
      // 扩展命令不启动 agent run，因此不会有 agent_settled；用 isIdle 对账。
      // （isIdle 不看队列，所以队列里还有 followUp 时它会是 false，正好不清 busy。）
      if (session.isIdle) this.emit({ type: "busy", busy: false });
    }
  }

  private async sendPrompt(session: SessionView, text: string, behavior: PromptBehavior): Promise<void> {
    const streamingBehavior = behavior === "followUp" ? "followUp" : "steer";
    // 用同一个回调覆盖所有路径：pi 在**接受**（入队或开始处理）时回调 true。
    // 不能等 `prompt()` 的 promise —— 它要到整轮结束才 resolve，队列里的消息更久。
    const preflightResult = (success: boolean): void => {
      if (!success) return;
      this.emit({ type: "promptAccepted" });
      // 用户消息一进 `messages`，`getContextUsage()`（= estimateContextTokens）就变了。
      this.publishMeta();
    };
    if (session.isStreaming) {
      await session.prompt(text, { streamingBehavior, preflightResult });
      return;
    }
    try {
      await session.prompt(text, { preflightResult });
    } catch (error) {
      // 检查与调用之间可能已经开始流式（竞态）；只有这一种错误值得重试一次。
      if (!isAlreadyProcessing(error)) throw error;
      await session.prompt(text, { streamingBehavior: "steer", preflightResult });
    }
  }

  /**
   * 中止当前回合，**并清空队列**。
   *
   * 为什么连队列一起清：用户点"中止"的语义是"停下来"。留着 followUp 让它在用户
   * 以为已经停下之后继续发出去，属于违背意图。pi 自己的 `clearQueue()` 注释也把
   * "用户中止时还原到编辑器"列为用途。被清掉的文本经 `restoreComposer` 退回输入框。
   *
   * ⚠️ **顺序不能反：先 `clearQueue()`，再 `abort()`。** 实测（本地端到端）pi 在
   * 中止过程中会把队列一并清掉，此时再调 `clearQueue()` 只会拿到两个空数组 ——
   * 用户排队的文本就**静默丢失**了，而这正是 D9 要防的那件事。
   * 语义上也应该如此：先停止接收新工作，再停止当前回合。
   */
  async abort(): Promise<void> {
    const session = this.view();
    const restored = this.drainQueue();
    if (restored !== "") this.emit({ type: "restoreComposer", text: restored });
    await session.abort();
    if (session.isIdle) this.emit({ type: "busy", busy: false });
  }

  /**
   * 把队列里的消息全部取出来（pi 的 `clearQueue`）。
   *
   * 对应 pi TUI 的 **"edit all queued messages"**：不是"丢弃"，而是**取回输入框**，
   * 所以这里把文本返回给调用方去回填。返回顺序与 pi 一致：
   * steering 在前、followUp 在后，用空行连接（`interactive-mode.js` 的
   * `allQueued.join("\n\n")`）。
   */
  clearQueue(): string {
    return this.drainQueue();
  }

  private drainQueue(): string {
    const session = this.view();
    const cleared = session.clearQueue();
    this.emit({ type: "queue", steering: [], followUp: [] });
    // 顺序与分隔符都对齐 pi 的 TUI：steering 在前、followUp 在后，空行分隔。
    return [...cleared.steering, ...cleared.followUp].join("\n\n");
  }

  /**
   * 开一个新会话（D8 的 `Pi: New Session`）。
   *
   * 忙的时候**不直接切**（D7）：返回 `{ok:false, code:"busy"}`，由宿主去问用户；
   * 「继续」则带 `{force:true}` 再调一次。三条路的取舍见 plan §4 D7。
   */
  async newSession(options: { force?: boolean } = {}): Promise<SessionReplaceOutcome> {
    await this.ensure();
    const host = this.host;
    if (host === undefined) return { ok: false, code: "busy", detail: "会话尚未建立" };
    if (options.force !== true && this.isBusy()) return { ok: false, code: "busy" };
    // 顺序很重要（评审 S1）：**替换成功之后**才清状态/重放。
    // 以前是替换之前清，于是被扩展取消（`{cancelled:true}`）时会白清一次、而面板还拿着旧转写。
    const result = await host.runtime.newSession();
    if (result.cancelled) {
      this.options.log.appendLine("[controller] 新建会话被扩展取消（session_before_switch）");
      return { ok: false, code: "cancelled" };
    }
    this.afterSessionChange("new");
    this.options.log.appendLine("[controller] 已新建会话");
    return { ok: true };
  }

  /**
   * 切换到某个会话文件（D5/D9）。
   *
   * 只应传**当前 cwd 的会话目录**里的路径：`switchSession` 会把 `sessionDir`
   * 换成该文件的父目录，跨项目切换会让后续的 `newSession` 落到别的项目里（plan §3.4）。
   */
  async switchSession(
    sessionPath: string,
    options: { force?: boolean } = {},
  ): Promise<SessionReplaceOutcome> {
    await this.ensure();
    const host = this.host;
    if (host === undefined) return { ok: false, code: "busy", detail: "会话尚未建立" };
    if (options.force !== true && this.isBusy()) return { ok: false, code: "busy" };
    // 只接受当前会话目录里的路径：`switchSession` 会把 `sessionDir` 换成该文件的父目录，
    // 跨项目切换会让后续的 `newSession` 落到别的项目里（plan §3.4）。这里只做**单调的**
    // 前缀比对（不 realpath、不归一化 —— pi 自己也不做，plan §3.1）。
    const dir = this.view().sessionManager.getSessionDir();
    if (!sessionPath.startsWith(dir)) {
      this.options.log.appendLine(`[controller] 拒绝切换：${sessionPath} 不在当前会话目录 ${dir} 下`);
      return { ok: false, code: "missing-cwd", detail: sessionPath };
    }
    try {
      const result = await host.runtime.switchSession(sessionPath);
      if (result.cancelled) {
        this.options.log.appendLine(`[controller] 切换会话被扩展取消：${sessionPath}`);
        return { ok: false, code: "cancelled" };
      }
    } catch (error) {
      // `MissingSessionCwdError` **不在 bundle 的导出面**（plan §3.3），但它有结构化的
      // `issue`（`core/session-cwd.js`）→ 按 `name` + `issue` 判定，
      // **不按 message 字符串匹配**（name 是契约，message 不是）。
      const typed = error as { name?: string; issue?: { sessionCwd?: string } } | null;
      if (typed?.name === "MissingSessionCwdError") {
        const gone = typed.issue?.sessionCwd ?? "(未知)";
        this.options.log.appendLine(`[controller] 切换失败：会话的工作目录已不存在 ${gone}`);
        return { ok: false, code: "missing-cwd", detail: gone };
      }
      throw error;
    }
    this.afterSessionChange("switch");
    this.options.log.appendLine(`[controller] 已切换会话：${sessionPath}`);
    return { ok: true };
  }

  // ---------------------------------------------------------------- 重放

  /**
   * 生成重放数据。
   *
   * 除了 `session.messages`，还必须补上**两类"还没进消息数组的进行中状态"**，
   * 否则重开面板会让它们凭空消失：
   *   - `state.streamingMessage`：正在流式接收的那条 assistant；
   *   - `state.pendingToolCalls`：正在执行的工具调用（toolResult 还没产生）。
   */
  /** 没有会话时的元信息（与 `sessionMeta()` 的空模型结果保持一致）。 */
  private emptyMeta(): SessionMeta {
    return {
      model: "",
      provider: "",
      modelName: "",
      thinkingLevel: "off",
      supportsThinking: false,
      contextWindow: 0,
      contextUsage: null,
      session: { path: "", name: "新会话", persisted: false },
    };
  }

  /**
   * 广播一次元信息（去重由 `emit()` 负责）。
   *
   * 刷新点（S4 的 D5）：`message_end`、`tool_execution_end`、`agent_settled`、
   * `compaction_start` / `compaction_end`、用户消息被接受、
   * `thinking_level_changed`、切换模型/等级之后、会话重建之后。
   * **不轮询**：上下文用量只在上述时刻变化。
   */
  private publishMeta(): void {
    if (this.host === undefined) return;
    this.emit({ type: "meta", meta: this.sessionMeta(this.view()) });
  }

  /** 面板要用的"当前模型/等级"信息（给宿主的 QuickPick 用，避免它摸 session）。 */
  pickerContext(): {
    model: string;
    thinkingLevel: string;
    supportsThinking: boolean;
    levels: readonly string[];
  } {
    if (this.host === undefined) {
      return { model: "", thinkingLevel: "off", supportsThinking: false, levels: [] };
    }
    const session = this.view();
    return {
      model: this.sessionMeta(session).model,
      thinkingLevel: this.sessionMeta(session).thinkingLevel,
      // **顺序不能反**：`supportsThinking()` 为 false 时（含"还没有模型"）
      // `getAvailableThinkingLevels()` 会返回全部 7 档假数据。
      supportsThinking: session.supportsThinking(),
      levels: session.supportsThinking() ? [...session.getAvailableThinkingLevels()] : [],
    };
  }

  /** 可用模型列表（已按有效凭据过滤）。宿主用它填 QuickPick。 */
  async listAvailableModels(): Promise<readonly unknown[]> {
    await this.ensure();
    if (this.host === undefined) return [];
    return this.view().modelRuntime.getAvailable();
  }

  /**
   * 面板里选了一个模型：记住它（D15）、切过去、广播 meta。
   *
   * `setModel` 是 async 且会 `checkAuth`，失败时**不广播**（别把半截状态推给前端）。
   */
  async applyPanelModel(model: unknown): Promise<void> {
    const session = this.view();
    await session.setModel(model as never);
    this.panelModel = model;
    this.publishMeta();
  }

  /** 面板里选了一个思考等级。pi 会 clamp，所以**回读**生效值。 */
  applyThinkingLevel(level: string): void {
    const session = this.view();
    session.setThinkingLevel(level as never);
    this.publishMeta();
  }

  /**
   * 组装元信息（模型 / 思考等级 / 上下文用量）。
   *
   * 三条容易错的地方：
   *   - `thinkingLevel` 要**回读** `session.thinkingLevel`：`setThinkingLevel()` 会静默
   *     clamp（实测 `medium→high`、`xhigh→max`），设进去的值不一定是生效值；
   *   - `supportsThinking()` 为 false 时**不要**去读 `getAvailableThinkingLevels()` ——
   *     `model === undefined` 时那个函数会返回**全部 7 档**（假数据）；
   *   - `contextUsage === null`（没有模型 / 窗口 <= 0）与 `contextUsage.percent === null`
   *     （刚压缩）是两种状态，见 protocol.ts 的注释。
   */
  private sessionMeta(session: SessionView): SessionMeta {
    const model = session.model;
    const usage = session.getContextUsage();
    return {
      model: model ? `${model.provider}/${model.id}` : "",
      provider: model?.provider ?? "",
      modelName: model?.name ?? "",
      thinkingLevel: session.thinkingLevel,
      supportsThinking: session.supportsThinking(),
      contextWindow: model?.contextWindow ?? 0,
      contextUsage:
        usage === undefined ? null : { tokens: usage.tokens, percent: usage.percent },
      session: this.sessionInfo(session),
    };
  }

  /**
   * 当前会话的身份（S5 的 D8）：路径、显示名、**落盘了没**。
   *
   * 两个易错点：
   *   - `isPersisted()` **不是**"落盘了没"（它返回的是 persist 模式，`session-manager.js:721-723`）
   *     → 用 `existsSync(getSessionFile())` 判（pi 在首条 assistant 消息之后才建文件）；
   *   - 名字优先 `session_info`（pi 的 `--name`/重命名写它），否则用首条 user 消息。
   */
  private sessionInfo(session: SessionView): SessionMeta["session"] {
    const manager = session.sessionManager;
    const file = manager.getSessionFile();
    const path = typeof file === "string" ? file : "";
    const first = session.messages.find(
      (message) => (message as { role?: string } | null)?.role === "user",
    );
    return {
      path,
      name: sessionDisplayName(manager.getSessionName(), firstUserText(first)),
      persisted: path !== "" && existsSync(path),
    };
  }

  /**
   * 列出**当前 cwd 的会话目录**里的会话（S5 的 D5）。
   *
   * 用**活会话自己的** `sessionDir`（和 pi CLI 的会话选择器一样，plan §3.6 有出处）：
   * 这样目录只有一处权威，不会和 `resolveSessionDir` 的推导分叉。
   * 省略 `sessionDir` 让 pi 自己算是不行的 —— 它默认吃 `getAgentDir()`，
   * S6 的 `jerrypi.agentDir` 一套上就失效（plan §3.1）。
   *
   * 返回值里的 `modified` 是**消息活动时间**（不是文件 mtime），且 pi 已经按它倒序。
   */
  async listSessions(): Promise<readonly unknown[]> {
    await this.ensure();
    const host = this.host;
    if (host === undefined) return [];
    const manager = this.view().sessionManager;
    const pi = await this.loadPi();
    return await pi.SessionManager.list(manager.getCwd(), manager.getSessionDir());
  }

  /** 当前会话文件的绝对路径（未落盘时为空串）。宿主用它标"当前项"。 */
  currentSessionPath(): string {
    return this.host === undefined ? "" : this.sessionInfo(this.view()).path;
  }

  /** 序列化上下文：cwd + diff 的记录源（S7）。 */
  private serializeContext(): SerializeContext {
    return { cwd: this.options.cwd, fileChanges: this.fileChanges, approvals: this.approvals };
  }

  snapshot(): ReplaySnapshot {
    const session = this.host === undefined ? undefined : this.view();
    if (session === undefined) {
      return {
        items: [],
        truncated: false,
        queue: { steering: [], followUp: [] },
        busy: this.pendingSend,
        cwd: this.options.cwd,
        meta: this.emptyMeta(),
      };
    }

    // S7：重放先登记（补回首次打开的 edit patch），再序列化 —— 派生字段才拿得到。
    recordEditsFromMessages(session.messages as never, this.fileChanges);
    const { items, truncated } = serializeMessages(session.messages, this.serializeContext());
    const knownToolIds = new Set(
      items.filter((item) => item.kind === "tool").map((item) => (item as { id: string }).id),
    );

    // 白名单重建（不是累加）：重放出来的卡片才是 webview 上真实存在的卡片。
    this.openableFiles = new Set();
    for (const item of items) this.registerOpenable(item);

    const streaming = session.state.streamingMessage;
    if (streaming !== undefined && streaming !== null) {
      const lastIndex = Math.max(0, session.messages.length - 1);
      const partial = serializeMessage(streaming, lastIndex, this.toolCalls, this.serializeContext());
      if (partial !== undefined && partial.kind === "assistant") {
        // **必须复用** activeAssistantId：重开后后续 delta 打的是这个 id，
        // 换一个 id 就等于把回复的后半截丢掉。
        partial.id = this.activeAssistantId ?? this.mintAssistantId();
        partial.streaming = true;
        items.push(partial);
      }
    }

    for (const toolCallId of session.state.pendingToolCalls) {
      const id = `tool-${toolCallId}`;
      if (knownToolIds.has(id)) continue;
      const known = this.toolCalls.get(toolCallId);
      // 运行中的行也要带上**已经流出来的正文**（否则重开面板会看到它退回"运行中…"），
      // 以及**可点路径**（否则重开后一个仍在执行的卡片，标题上的路径点不开）。
      const paths = openablePathsOfToolCall(known?.args, this.options.cwd);
      const row = this.applyPartial(
        {
          kind: "tool",
          id,
          toolCallId,
          toolName: known?.name ?? "tool",
          summary: known?.argsText ?? "",
          isError: false,
          pending: true,
          // S8：面板重开时"还在等的那条"要带着按钮回来（C6）。工具已结束的那种由
          // serializeMessage 那条路派生（pending:false）—— 两条路同一份表，不会各说各话。
          ...this.approvals.fieldsOf(toolCallId, true),
          ...(paths.length > 0 ? { openablePaths: paths } : {}),
          ...titleOf(known?.name, known?.args, this.options.cwd),
        },
        this.partials.get(toolCallId),
        this.toolTimes.get(toolCallId),
      );
      this.registerOpenable(row);
      items.push(row);
    }

    // 快照会把 busy 一并带给前端（`state.busy`），也就是说这一刻前后端是同步的。
    // 因此**必须忘掉"上次发过的 busy 值"**：否则在"面板重开 → 前端按快照显示忙 →
    // 服务端的 lastBusy 仍是上一次的值 → 之后真正的 busy:false 被当成重复而丢掉"，
    // 面板就会一直卡在"生成中…"直到下一次状态变化。
    this.lastBusy = undefined;
    // 同 `lastBusy`：快照已经把 meta 一起给了前端，因此"上次发过的 meta"必须忘掉。
    this.lastMeta = undefined;
    return {
      items,
      truncated,
      queue: {
        steering: [...session.getSteeringMessages()],
        followUp: [...session.getFollowUpMessages()],
      },
      // 乐观 busy 发生在 agent_start 之前，那时 isStreaming 还是 false。
      busy: session.isStreaming || this.pendingSend,
      cwd: this.options.cwd,
      meta: this.sessionMeta(session),
      ...(session.state.errorMessage === undefined ? {} : { errorMessage: session.state.errorMessage }),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearDeltaTimer();
    const host = this.host;
    this.host = undefined;
    if (host !== undefined) await host.dispose();
  }

  // ---------------------------------------------------------------- 事件翻译

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        this.onMessageStart(event.message as { role?: string });
        return;
      case "message_update":
        this.onMessageUpdate(event);
        return;
      case "message_end":
        this.onMessageEnd(event.message as { role?: string });
        // 用量通常在这里变（assistant 的 usage 落地）。
        this.publishMeta();
        return;
      case "tool_execution_start":
        this.onToolExecutionStart(event as unknown as { toolCallId: string; toolName: string; args: unknown });
        return;
      case "tool_execution_update":
        this.onToolExecutionUpdate(event as unknown as ToolUpdateEvent);
        return;
      case "tool_execution_end":
        this.onToolExecutionEnd(event as unknown as { toolCallId: string });
        this.publishMeta();
        return;
      case "queue_update":
        this.emit({ type: "queue", steering: [...event.steering], followUp: [...event.followUp] });
        return;
      case "agent_start":
        this.emit({ type: "busy", busy: true });
        return;
      case "agent_settled":
        this.settlePendingTools();
        this.emit({ type: "busy", busy: false });
        // 兜底对账：一整轮结束之后用量一定变了。
        this.publishMeta();
        return;
      case "agent_end": {
        const willRetry = (event as { willRetry?: boolean }).willRetry === true;
        if (willRetry) this.notice("warn", "请求失败，将自动重试");
        return;
      }
      case "compaction_start":
        this.notice("info", "上下文压缩中…");
        this.publishMeta();
        return;
      case "compaction_end": {
        const aborted = (event as { aborted?: boolean }).aborted === true;
        this.notice("info", aborted ? "上下文压缩已中止" : "上下文压缩完成");
        // 压缩后 `percent` 会变成 null（pi 的 `?` 就是为这个状态准备的）——
        // 不广播的话面板会一直显示压缩前的旧数字。
        this.publishMeta();
        return;
      }
      case "thinking_level_changed":
        // pi 自己也会改等级（clamp、`/model` 之类），只信事件。
        this.publishMeta();
        return;
      case "auto_retry_start": {
        const attempt = (event as { attempt?: number; maxAttempts?: number }).attempt ?? 0;
        const max = (event as { maxAttempts?: number }).maxAttempts ?? 0;
        this.notice("warn", `自动重试 ${attempt}/${max}`);
        return;
      }
      case "auto_retry_end":
        this.notice("info", `自动重试${(event as { success?: boolean }).success === true ? "成功" : "失败"}`);
        return;
      default:
        // 其余事件（entry_appended / session_info_changed / summarization_* /
        // bash_execution_update）暂不使用，留给后续步骤。
        return;
    }
  }

  private onMessageStart(message: { role?: string }): void {
    if (message.role !== "assistant") return;
    // pi 会为同一条 assistant 发两次 message_start（partial 与 final），
    // 只有第一次该建节点；第二次忽略，否则会出现两个节点。
    if (this.activeAssistantId !== undefined) return;
    const id = this.mintAssistantId();
    this.activeAssistantId = id;
    this.emit({
      type: "item",
      item: { kind: "assistant", id, text: "", thinking: "", stopReason: "", streaming: true },
    });
  }

  private onMessageUpdate(event: AgentSessionEvent): void {
    const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
      .assistantMessageEvent;
    if (inner === undefined) return;
    if (inner.type !== "text_delta" && inner.type !== "thinking_delta") return;
    const delta = inner.delta ?? "";
    if (delta === "") return;
    // 防御：万一 delta 先于 message_start 到达（理论上不会），先把节点建出来。
    if (this.activeAssistantId === undefined) this.onMessageStart({ role: "assistant" });
    const id = this.activeAssistantId as string;
    const kind = inner.type === "text_delta" ? "text" : "thinking";
    const key = `${id}\u0000${kind}`;
    this.deltaBuffer.set(key, (this.deltaBuffer.get(key) ?? "") + delta);
    this.deltaTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FRAME_MS);
  }

  private onMessageEnd(message: { role?: string }): void {
    // **先把积压的 delta 发出去**，否则前端会先收到最终态、再收到一段陈旧增量。
    this.flushDeltas();

    const session = this.view();
    const raw = session.messages[session.messages.length - 1];
    // S7：`edit` 的 patch 在这里登记（重放走 `recordEditsFromMessages(session.messages)`，
    // 同一个函数）；失败的 edit 是 `details = {}`，函数里会自己跳过。
    recordEditsFromMessages(
      [raw as { role?: string; toolName?: string; toolCallId?: string; details?: unknown }],
      this.fileChanges,
    );
    const index = session.messages.length - 1;
    if (message.role === "assistant") indexToolCalls(raw as never, this.toolCalls);

    const item = serializeMessage(raw, index, this.toolCalls, this.serializeContext());
    if (item === undefined) return;

    if (item.kind === "tool") {
      const times = this.toolTimes.get(item.toolCallId);
      if (times?.startedAt !== undefined) item.startedAt = times.startedAt;
      if (times?.endedAt !== undefined) item.endedAt = times.endedAt;
      this.registerOpenable(item);
      this.cleanupTool(item.toolCallId);
    }

    if (item.kind === "assistant" && this.activeAssistantId !== undefined) {
      // 收尾端复用同一个 id：否则 message_start 建的节点与这里的节点 id 不同，
      // upsert 找不到就会新建，每条回复都多留一个空壳。
      item.id = this.activeAssistantId;
      this.activeAssistantId = undefined;
    }
    this.emit({ type: "item", item });
  }

  private onToolExecutionStart(event: { toolCallId: string; toolName: string; args: unknown }): void {
    const toolCallId = event.toolCallId;
    const summary = summarizeArgs(event.args);
    this.toolCalls.set(toolCallId, { name: event.toolName, argsText: summary, args: event.args });
    const startedAt = Date.now();
    this.runningTools.add(toolCallId);
    this.toolTimes.set(toolCallId, { startedAt });
    this.toolLastEmit.set(toolCallId, startedAt);

    // 运行中的卡片也要有可点路径：`tool_execution_start` 手上就有 args。
    const paths = openablePathsOfToolCall(event.args, this.options.cwd);
    const item: ToolItem = {
      kind: "tool",
      id: `tool-${toolCallId}`,
      toolCallId,
      toolName: event.toolName,
      summary,
      isError: false,
      pending: true,
      startedAt,
      ...(paths.length > 0 ? { openablePaths: paths } : {}),
      // 运行中的卡片同样要有 pi 风格的标题 —— 否则它显示原始 JSON，
      // 而工具一结束就变成清爽的命令（实测第一版就是这样，用户一眼看出两种形态）。
      ...titleOf(event.toolName, event.args, this.options.cwd),
    };
    this.registerOpenable(item);
    this.toolItems.set(toolCallId, item);
    this.emit({ type: "item", item });
  }

  /**
   * 工具的流式输出。
   *
   * 三条容易写错的规矩（都在 S3-plan §0.2 里，且都有探针）：
   *   1. 正文是**累积快照**，语义是整体替换，不是增量；
   *   2. 第一次更新带的是 `content: []`（bash 的占位）→ **不能**用它把已有正文清空；
   *   3. 超过 50KB 后快照会"换头"（保留最后 50KB），所以也不能假定内容只增不减。
   */
  private onToolExecutionUpdate(event: ToolUpdateEvent): void {
    const toolCallId = event.toolCallId;
    if (!this.runningTools.has(toolCallId)) return;
    const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined;
    const text = partial === undefined ? "" : toolTextFromContent(partial.content);
    const meta = toolMetaOf(partial?.details);
    const previous = this.partials.get(toolCallId);
    const kept = text === "" ? (previous?.text ?? "") : text;
    this.partials.set(toolCallId, { text: kept, ...meta });
    this.scheduleToolFrame(toolCallId);
  }

  /** 工具执行结束：停掉待发帧、记结束时间。最终态由随后的 toolResult 构建。 */
  private onToolExecutionEnd(event: { toolCallId: string }): void {
    const toolCallId = event.toolCallId;
    const timer = this.toolFrameTimers.get(toolCallId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.toolFrameTimers.delete(toolCallId);
    }
    // 先移出 runningTools：即便上面那行没拦住，回调也会因为不在 runningTools 里而丢弃。
    this.runningTools.delete(toolCallId);
    const times = this.toolTimes.get(toolCallId);
    if (times !== undefined) times.endedAt = Date.now();
  }

  /** 排一帧（同一工具最多一帧在途，间隔不小于 `TOOL_FRAME_MS`）。 */
  private scheduleToolFrame(toolCallId: string): void {
    if (this.toolFrameTimers.has(toolCallId)) return;
    const last = this.toolLastEmit.get(toolCallId) ?? 0;
    const wait = Math.max(0, TOOL_FRAME_MS - (Date.now() - last));
    const timer = setTimeout(() => {
      this.toolFrameTimers.delete(toolCallId);
      this.flushToolFrame(toolCallId);
    }, wait);
    this.toolFrameTimers.set(toolCallId, timer);
  }

  private flushToolFrame(toolCallId: string): void {
    // 过期帧：工具已经结束了，正文的最终态由 toolResult 决定，这一帧必须丢。
    if (!this.runningTools.has(toolCallId)) return;
    const base = this.toolItems.get(toolCallId);
    if (base === undefined || base.kind !== "tool") return;
    this.toolLastEmit.set(toolCallId, Date.now());
    const item = this.applyPartial(base, this.partials.get(toolCallId), this.toolTimes.get(toolCallId));
    this.toolItems.set(toolCallId, item);
    this.registerOpenable(item);
    this.emit({ type: "item", item });
  }

  /** 把"已流出来的正文 + 元信息 + 时间"贴到一条工具行上。 */
  private applyPartial(
    item: ToolItem,
    partial: ToolPartial | undefined,
    times: { startedAt?: number; endedAt?: number } | undefined,
  ): ToolItem {
    const next: ToolItem = { ...item };
    if (partial?.text !== undefined && partial.text !== "") next.text = partial.text;
    if (partial?.textTruncated === true) next.textTruncated = true;
    if (partial?.truncation !== undefined) next.truncation = partial.truncation;
    if (partial?.fullOutputPath !== undefined) next.fullOutputPath = partial.fullOutputPath;
    if (times?.startedAt !== undefined) next.startedAt = times.startedAt;
    if (times?.endedAt !== undefined) next.endedAt = times.endedAt;
    return next;
  }

  /** 清掉一个工具的全部内存态（正文缓存、时间、待发帧、行）。 */
  private cleanupTool(toolCallId: string): void {
    this.runningTools.delete(toolCallId);
    this.partials.delete(toolCallId);
    this.toolTimes.delete(toolCallId);
    this.toolItems.delete(toolCallId);
    this.toolLastEmit.delete(toolCallId);
    const timer = this.toolFrameTimers.get(toolCallId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.toolFrameTimers.delete(toolCallId);
    }
  }

  /** 登记一条 item 里的可打开路径（`snapshot()` 与实时路径都走这里）。 */
  private registerOpenable(item: ChatItem | ToolItem): void {
    if (item.kind !== "tool" || item.openablePaths === undefined) return;
    for (const path of item.openablePaths) this.openableFiles.add(path);
  }

  /**
   * 这个路径能不能打开。
   *
   * 只做**精确字符串比对** + 绝对路径校验：host 侧不解析路径，也就不存在
   * "两个解析器各解各的"的歧义（`Uri.parse` 会把 `#` 当 fragment）。
   */
  isOpenableFile(path: string): boolean {
    return path !== "" && isAbsolute(path) && this.openableFiles.has(path);
  }

  /**
   * 兜底：某个工具调用的 toolResult **永远不来**时，别让它停在"运行中"。
   *
   * 探针 H 实测（S3）：**正常中止走不到这里** —— 中止时 pi 会发一条
   * `isError=true`、正文为"已流出内容 + `Command aborted`"的 toolResult，
   * 于是这条工具已经从 `pendingToolCalls` 里消失了。所以这里是"扩展工具挂死 /
   * 宿主异常"的低频路径，一旦触发就必须收口。
   *
   * ⚠️ 收口时必须**把已流出来的正文贴上**（否则用户眼看着流了 10 秒的输出，
   * 因为一次异常全没了），并且必须**清掉 partial 缓存**（那个 `message_end`
   * 永远不来，不删就是每次触发泄漏一份 ≤64KB 的字符串）。
   */
  private settlePendingTools(): void {
    const session = this.host === undefined ? undefined : this.view();
    const stillPending = new Set(session?.state.pendingToolCalls ?? []);
    for (const [toolCallId, item] of [...this.toolItems]) {
      if (!stillPending.has(toolCallId)) {
        this.toolItems.delete(toolCallId);
        continue;
      }
      const settled: ToolItem = {
        ...this.applyPartial(item, this.partials.get(toolCallId), this.toolTimes.get(toolCallId)),
        pending: false,
        isError: true,
      };
      this.cleanupTool(toolCallId);
      this.emit({ type: "item", item: settled });
    }
  }

  private handleExtensionError(error: ExtensionError): void {
    this.notice("error", `扩展出错：${error.error}`);
  }

  // ---------------------------------------------------------------- 小工具

  private view(): SessionView {
    const host = this.host;
    if (host === undefined) throw new Error("jerrypi: 会话尚未建立");
    return host.session as unknown as SessionView;
  }

  private mintAssistantId(): string {
    this.liveCounter += 1;
    return `live-${this.liveCounter}`;
  }

  // ---------------------------------------------------------------- 工具审批（S8）

  /** 有人要问：把那张卡片**就地重发**一次（带上按钮），并把"该通知了"交给宿主。 */
  private onApprovalPending(request: ApprovalRequest): void {
    this.options.log.appendLine(
      `[approval] 等待确认：${request.toolName}｜${request.title}（面板上点「允许/拒绝」）`,
    );
    this.refreshToolApproval(request.toolCallId, true);
    this.options.onApprovalPending?.(request);
  }

  /**
   * 面板答了一次（`chatView` 路由过来）。返回 `false` = 没有这条待审批
   * （重发 / 过期 / 已中止）—— **不抛错**，但记一行 Output："看着能点却没反应"是最烦的失败形态。
   */
  decideApproval(toolCallId: string, decision: ApprovalDecision): boolean {
    if (!this.approvals.decide(toolCallId, decision)) {
      this.options.log.appendLine(`[approval] 忽略一次过期的回答：${toolCallId}（${decision}）`);
      return false;
    }
    // 答完立刻把按钮撤掉：工具还在跑，卡片回到普通的"运行中…"（拒绝的那种随后由
    // toolResult 那条路派生出 `denied` 标记）。
    this.refreshToolApproval(toolCallId, true);
    return true;
  }

  /**
   * 把 `tool-<id>` 那张卡片按审批表的**当前**状态重发一次。
   *
   * 注意：`toolItems` 里存的是"卡片本身"（`tool_execution_start` 那一刻的形态），
   * 审批字段只在发出去的那一份上 —— 所以这里 `{...item, ...fields}` 不会留下过期字段。
   */
  private refreshToolApproval(toolCallId: string, pending: boolean): void {
    const item = this.toolItems.get(toolCallId);
    if (item === undefined) return;
    this.emit({ type: "item", item: { ...item, ...this.approvals.fieldsOf(toolCallId, pending) } });
  }

  /**
   * S8：信任裁决的本进程缓存（`Pi: Project Trust…` 用它读写/清）。
   *
   * 为什么必须能清：`session.reload()` **不会**重跑信任钩子（F17）—— 钩子只在**建会话**时跑，
   * 而这份缓存活在整个扩展进程里，不清就是"改判了、下一个会话还用旧答案"。
   */
  get trustMemo(): TrustMemoLike {
    return this.trustDecisions;
  }

  /** 宿主侧（选择器等）要往面板发一条提示时的入口。 */
  notifyUser(level: "info" | "warn" | "error", text: string): void {
    this.notice(level, text);
  }

  private notice(level: "info" | "warn" | "error", text: string): void {
    this.noticeCounter += 1;
    // **必须**用 notice- 前缀：提示不是消息、没有下标，写成 msg-<length-1>
    // 会与刚刚结束的那条消息撞 id，把它整条替换掉。
    this.emit({ type: "item", item: { kind: "notice", id: `notice-${this.noticeCounter}`, level, text } });
  }

  private flushDeltas(): void {
    this.clearDeltaTimer();
    if (this.deltaBuffer.size === 0) return;
    const pending = this.deltaBuffer;
    this.deltaBuffer = new Map();
    for (const [key, delta] of pending) {
      const [id, kind] = key.split("\u0000");
      this.emit({ type: "delta", id, kind: kind === "thinking" ? "thinking" : "text", delta });
    }
  }

  private clearDeltaTimer(): void {
    if (this.deltaTimer !== undefined) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = undefined;
    }
  }

  private resetLiveState(): void {
    this.clearDeltaTimer();
    this.deltaBuffer.clear();
    this.activeAssistantId = undefined;
    this.toolCalls.clear();
    for (const timer of this.toolFrameTimers.values()) clearTimeout(timer);
    this.toolFrameTimers.clear();
    this.runningTools.clear();
    this.partials.clear();
    this.toolTimes.clear();
    this.toolLastEmit.clear();
    this.toolItems.clear();
    this.openableFiles = new Set();
    // S8：待审批项以 toolId 为键，跨会话留着就是"新会话里冒出一个答不了的按钮"。
    // （会话替换之前 pi 已经 abort 过，所以这里多半只是在收口 + 清历史。）
    this.approvals.reset();
  }

  private emit(message: ServerMessage): void {
    if (this.disposed) return;
    if (message.type === "meta") {
      const fingerprint = JSON.stringify(message.meta);
      if (this.lastMeta === fingerprint) return;
      this.lastMeta = fingerprint;
    }
    if (message.type === "busy") {
      // busy 会从多个来源到达（乐观置位、agent_start、agent_settled、prompt 对账），
      // 同一个值重复发只是让前端白重绘一次。
      if (this.lastBusy === message.busy) return;
      this.lastBusy = message.busy;
    }
    this.options.onMessage(message);
  }
}

/** 工具行在协议里的类型（唯一需要"贴正文"的变体）。 */
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** `tool_execution_update` 里我们真正读的字段。 */
interface ToolUpdateEvent {
  toolCallId: string;
  partialResult?: { content?: unknown; details?: unknown };
}

/** 一个工具已经流出来的正文与元信息。 */
interface ToolPartial {
  text: string;
  textTruncated?: boolean;
  truncation?: { truncatedBy: "lines" | "bytes"; totalLines: number; outputLines: number; maxBytes?: number };
  fullOutputPath?: string;
}

/** pi 在流式期间收到没有 `streamingBehavior` 的 prompt 时的报错原文。 */
/** 取一条消息的纯文本（给会话名摘要用；不认识的形状就返回空串）。 */
function firstUserText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      (part as { type?: string; text?: string } | null)?.type === "text"
        ? ((part as { text?: string }).text ?? "")
        : "",
    )
    .join(" ");
}

function isAlreadyProcessing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /already processing|streamingBehavior/i.test(text);
}
