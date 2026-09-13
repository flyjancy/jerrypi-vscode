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
import { isAbsolute, join } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { TOOL_FRAME_MS, type ChatItem, type ServerMessage } from "../shared/protocol";
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
} from "./serialize";
import { createSessionHost, type SessionHost } from "./session";
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
   * 会话文件的存放目录，默认 `<agentDir>/sessions`。
   * 单独拿出来是为了让本地端到端测试能用临时目录，不去动用户的 `~/.pi/agent`。
   */
  sessionsDir?: string;
  /** 额外加载的 pi 扩展（测试用；后续的 `jerrypi.extensionPaths` 设置也会走这里）。 */
  additionalExtensionPaths?: string[];
}

/** `snapshot()` 的产物。 */
export interface ReplaySnapshot {
  items: ChatItem[];
  truncated: boolean;
  queue: { steering: string[]; followUp: string[] };
  busy: boolean;
  cwd: string;
  model: string;
  errorMessage?: string;
}

/** 会话上我们真正读写的成员（避免把整个 AgentSession 类型铺开）。 */
interface SessionView {
  messages: readonly unknown[];
  model?: { provider?: string; id?: string } | null;
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
}

export class SessionHostController {
  private readonly options: SessionHostControllerOptions;
  private host: SessionHost | undefined;
  private ensuring: Promise<void> | undefined;
  private disposed = false;

  /** 进行中的那条 assistant 消息的 id（唯一权威，见文件头注释 2）。 */
  private activeAssistantId: string | undefined;
  private liveCounter = 0;
  private noticeCounter = 0;

  /** 工具调用登记表：给 toolResult 补参数摘要（与重放共用同一套转写逻辑）。 */
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

  private async createHost(): Promise<void> {
    const { cwd, keys } = this.options;
    const pi = await this.loadPi();
    const agentDir = this.options.agentDir ?? pi.getAgentDir();
    // 每次创建 ModelRuntime 之后都要重新注入 key：pi 的 setRuntimeApiKey 只写内存。
    const modelRuntime = await getModelRuntime(pi, agentDir, keys);
    const sessionManager: SessionManager = pi.SessionManager.create(
      cwd,
      this.options.sessionsDir ?? join(agentDir, "sessions"),
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
      // 与 pi CLI 的行为刻意不同：不信任工作区里的项目级设置（见 README 已知限制）。
      projectTrusted: false,
      onEvent: (event) => this.handleEvent(event),
      onExtensionError: (error) => this.handleExtensionError(error),
      // 面板不钉模型：用户选过就听用户的（见 alignPanelModel 的注释）。
      // 挂在 onRebind 上是因为 `newSession()` 之后 pi 会重新解析模型，建会话时做一次不够。
      onRebind: async (session) => {
        const detail = await alignPanelModel(
          session as unknown as Parameters<typeof alignPanelModel>[0],
          modelRuntime as { getAvailable(): Promise<readonly unknown[]> },
        );
        this.options.log.appendLine(`[controller] 模型：${detail}｜cwd=${cwd}｜agentDir=${agentDir}`);
      },
    });
    this.host = host;


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
      if (success) this.emit({ type: "promptAccepted" });
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

  /** 开一个新会话（D8 的 `Pi: New Session`）。 */
  async newSession(): Promise<void> {
    await this.ensure();
    const host = this.host;
    if (host === undefined) return;
    this.resetLiveState();
    await host.runtime.newSession();
    this.options.log.appendLine("[controller] 已新建会话");
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
  snapshot(): ReplaySnapshot {
    const session = this.host === undefined ? undefined : this.view();
    if (session === undefined) {
      return {
        items: [],
        truncated: false,
        queue: { steering: [], followUp: [] },
        busy: this.pendingSend,
        cwd: this.options.cwd,
        model: "",
      };
    }

    const { items, truncated } = serializeMessages(session.messages, { cwd: this.options.cwd });
    const knownToolIds = new Set(
      items.filter((item) => item.kind === "tool").map((item) => (item as { id: string }).id),
    );

    // 白名单重建（不是累加）：重放出来的卡片才是 webview 上真实存在的卡片。
    this.openableFiles = new Set();
    for (const item of items) this.registerOpenable(item);

    const streaming = session.state.streamingMessage;
    if (streaming !== undefined && streaming !== null) {
      const lastIndex = Math.max(0, session.messages.length - 1);
      const partial = serializeMessage(streaming, lastIndex, this.toolCalls, { cwd: this.options.cwd });
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
          ...(paths.length > 0 ? { openablePaths: paths } : {}),
          ...titleOf(known?.name, known?.args, this.options.cwd),
        },
        this.partials.get(toolCallId),
        this.toolTimes.get(toolCallId),
      );
      this.registerOpenable(row);
      items.push(row);
    }

    const model = session.model;
    // 快照会把 busy 一并带给前端（`state.busy`），也就是说这一刻前后端是同步的。
    // 因此**必须忘掉"上次发过的 busy 值"**：否则在"面板重开 → 前端按快照显示忙 →
    // 服务端的 lastBusy 仍是上一次的值 → 之后真正的 busy:false 被当成重复而丢掉"，
    // 面板就会一直卡在"生成中…"直到下一次状态变化。
    this.lastBusy = undefined;
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
      model: model ? `${model.provider}/${model.id}` : "",
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
        return;
      case "tool_execution_start":
        this.onToolExecutionStart(event as unknown as { toolCallId: string; toolName: string; args: unknown });
        return;
      case "tool_execution_update":
        this.onToolExecutionUpdate(event as unknown as ToolUpdateEvent);
        return;
      case "tool_execution_end":
        this.onToolExecutionEnd(event as unknown as { toolCallId: string });
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
        return;
      case "agent_end": {
        const willRetry = (event as { willRetry?: boolean }).willRetry === true;
        if (willRetry) this.notice("warn", "请求失败，将自动重试");
        return;
      }
      case "compaction_start":
        this.notice("info", "上下文压缩中…");
        return;
      case "compaction_end": {
        const aborted = (event as { aborted?: boolean }).aborted === true;
        this.notice("info", aborted ? "上下文压缩已中止" : "上下文压缩完成");
        return;
      }
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
        // 其余事件（entry_appended / session_info_changed / thinking_level_changed /
        // summarization_* / bash_execution_update）S2 不用，留给后续步骤。
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
    const index = session.messages.length - 1;
    if (message.role === "assistant") indexToolCalls(raw as never, this.toolCalls);

    const item = serializeMessage(raw, index, this.toolCalls, { cwd: this.options.cwd });
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
  }

  private emit(message: ServerMessage): void {
    if (this.disposed) return;
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
function isAlreadyProcessing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /already processing|streamingBehavior/i.test(text);
}
