// S1 可行性闸门：T1–T13 + GATE 判定（T5c、T12 与 T13 是 advisory，不参与判定）。
//
// 输出契约（PLAN.md 第 6 节 S1）：
//   flyjancy.jerrypi <扩展版本> selftest-v1 <平台> node=<版本>
//   T1 PASS
//   T3 FAIL E_EXTENSION_ERRORS
//   ...
//   GATE PASS | GATE BLOCKED <失败项列表>
//
// 判定规则：**除 T5c / T12 / T13 外，任一 required 项非 PASS 即 GATE BLOCKED；SKIP 不算通过。**
// T5c（模型驱动的 bash 中止）、T12（终端那份 pi 的会话目录比对）与 T13（代理身份，S6）是 **advisory**。
//
// 设计约束：
//   - 不污染用户环境：全部临时目录在 os.tmpdir() 下，最后统一清理；
//   - 每项独立超时；每项结束立刻写一行 Output（最坏情况约 16 分钟，中途静默无法定位）；
//   - 模型相关项（T4/T6/T7/T9）各重试 1 次，并把 E_MODEL_* 与能力错误分开记录。
import { accessSync, appendFileSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { crc32, deflateSync } from "node:zlib";
import type { AgentSessionEvent, ExtensionError, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EventSink, RuntimeMode } from "./bindings";
import { readRuntimeVersion, runtimePath, type PiModule } from "./loader";
import { REQUIRED_RESOURCE_DIRS, REQUIRED_RESOURCE_FILES } from "./resources";
import {
  alignSessionModel,
  describeConfiguredProviders,
  pickModel,
  type ModelChoice,
} from "./model-choice";
import type { ApiKeyStore } from "./runtime";
import { getModelRuntime } from "./runtime";
import { describeProxyIdentity } from "../shared/format";
import type { WriteRecord } from "./custom-tools";
import { createApprovals } from "./approval";
import { createSessionHost, type SessionHost } from "./session";
import { resolveSessionDir, sessionsRootOf } from "./sessions";
import { createSelfTestUIContext } from "./selftest-ui";

export const SELFTEST_TAG = "selftest-v1";

export interface SelfTestOptions {
  pi: PiModule;
  extensionPath: string;
  extensionVersion: string;
  vscodeVersion: string;
  agentDir: string;
  /**
   * 扩展宿主当前的 cwd（= VS Code 第一个工作区目录，没打开工作区时是用户主目录）。
   *
   * T10/T11/T12 需要它：那三条验的是"我们的会话目录推导与 pi 一致"，
   * 而 `SessionManager.create(cwd)` 不传 `sessionDir` 时会 **mkdirSync** ——
   * 拿临时 cwd 去跑会在用户真实的 agentDir 下留下垃圾目录（评审 B3），
   * 而真实 cwd 的那个目录本来就在（我们的会话就住那里）。
   */
  cwd: string;
  keys: ApiKeyStore;
  sink: EventSink;
  /**
   * T13（advisory）要报告的 VS Code `http.*` 设置（取值在宿主侧做 —— selftest 不 import vscode）。
   * 缺省时报告 "(未提供)"，不影响 GATE。
   */
  httpProxyConfig?: { proxySupport?: string; proxy?: string };
}

type Status = "PASS" | "FAIL" | "SKIP";

interface ItemResult {
  id: string;
  status: Status;
  code?: string;
  detail?: string;
}

/** 参与 GATE 判定的项（T5c 是 advisory）。 */
const REQUIRED_ITEMS = ["T1", "T2", "T3", "T4", "T5a", "T5b", "T6", "T7", "T8", "T9", "T10", "T11", "T14"] as const;

const MIN_NODE = [24, 15, 0] as const;

/** 各项超时（毫秒）。 */
const TIMEOUTS: Record<string, number> = {
  T1: 5_000,
  // T13 只是读几个值、拼一行字符串（不联网、不碰磁盘）
  T13: 5_000,
  T2: 30_000,
  T3: 60_000,
  T4: 60_000,
  T5a: 30_000,
  T5b: 30_000,
  T5c: 90_000,
  // 不需要网络，只需要算路径 / 写一个自造会话
  T10: 15_000,
  T11: 30_000,
  T12: 30_000,
  T6: 120_000,
  T7: 60_000,
  T8: 30_000,
  T9: 120_000,
  // T14（S8）：不用模型、不用网络，只是几次本地工具调用 —— 但要建会话，给足 30s
  T14: 30_000,
};

class SelfTestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SelfTestFailure";
  }
}

class SelfTestSkip extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SelfTestSkip";
  }
}

function fail(code: string, message: string): never {
  throw new SelfTestFailure(code, message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 诊断用：当前会话解析出的模型（Windows 与 Mac 上的差异往往就在这里）。 */
function describeModel(session: { model?: unknown }): string {
  const model = session.model as { id?: string; provider?: string; name?: string } | undefined;
  if (model === undefined || model === null) return "(none)";
  return `${model.provider ?? "?"}/${model.id ?? model.name ?? "?"}`;
}

/** 诊断用：最后一条 assistant 消息的关键信息（文本 / 停止原因 / 错误原文）。 */
function describeLastAssistant(session: { messages: unknown[] }): string {
  const messages = session.messages as Array<Record<string, unknown>>;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const parts: string[] = [];
    const content = message.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => (block as { type?: string })?.type === "text")
        .map((block) => String((block as { text?: string }).text ?? ""))
        .join(" ")
        .trim();
      if (text.length > 0) parts.push(`text=${JSON.stringify(text.slice(0, 200))}`);
      const kinds = [...new Set(content.map((block) => String((block as { type?: string })?.type)))];
      parts.push(`contentTypes=[${kinds.join(",")}]`);
    } else if (typeof content === "string") {
      parts.push(`text=${JSON.stringify(content.slice(0, 200))}`);
    }
    if (typeof message.stopReason === "string") parts.push(`stopReason=${message.stopReason}`);
    if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
      parts.push(`errorMessage=${message.errorMessage.slice(0, 300)}`);
    }
    return parts.join("; ");
  }
  return "(没有 assistant 消息)";
}

/** 取最后一条 assistant 消息上的 provider 错误原文（如果有）。 */
function lastAssistantError(session: { messages: unknown[] }): string | undefined {
  const messages = session.messages as Array<Record<string, unknown>>;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return typeof message.errorMessage === "string" && message.errorMessage.length > 0
      ? message.errorMessage
      : undefined;
  }
  return undefined;
}

/** 把 provider 的错误文本归到可执行的错误码上（而不是笼统的 E_MODEL_NOT_COOPERATING）。 */
function providerErrorCode(error: string): string {
  return /401|403|unauthor|invalid.*api[ _-]?key|authentication|no credentials|not authenticated|insufficient|quota|balance/i.test(
    error,
  )
    ? "E_NO_CREDENTIALS"
    : "E_PROVIDER_ERROR";
}

/** 失败时优先报 provider 的错误码，否则报 fallbackCode。 */
function failModelRelated(session: { messages: unknown[] }, fallbackCode: string, message: string): never {
  const error = lastAssistantError(session);
  if (error !== undefined) {
    fail(providerErrorCode(error), `${message}；${describeLastAssistant(session)}`);
  }
  fail(fallbackCode, `${message}；${describeLastAssistant(session)}`);
}
function retryable(code: string): boolean {
  // 重试只对"模型没配合"和超时这类瞬时原因有意义；
  // 凭据缺失、前置项缺失之类的确定性失败重试没有意义。
  return code.startsWith("E_MODEL") || code === "E_TIMEOUT" || code === "E_NOT_ABORTED";
}

/**
 * 模型相关项的前置检查：没有可用模型就直接报 E_NO_CREDENTIALS，
 * 不把它混成"pi 跑不起来"。
 */
function requireUsableModel(session: { model: unknown }): void {
  if (session.model === undefined || session.model === null) {
    fail(
      "E_NO_CREDENTIALS",
      "没有可用模型：先用 `Pi: Set API Key` 配置一把 key（pi 内置 provider 只需 key）",
    );
  }
}

/** 把 provider 侧的认证/网络错误归到正确的错误码，而不是笼统的 E_UNEXPECTED。 */
async function promptOrFail(
  session: { prompt(text: string): Promise<void> },
  text: string,
): Promise<void> {
  try {
    await session.prompt(text);
  } catch (error) {
    const message = describe(error);
    if (/api[ _-]?key|unauthor|forbidden|401|403|no credentials|not authenticated/i.test(message)) {
      fail("E_NO_CREDENTIALS", message);
    }
    fail("E_PROVIDER_ERROR", message);
  }
}

class SelfTestRun {
  private readonly results: ItemResult[] = [];
  private tempRoot = "";

  constructor(private readonly options: SelfTestOptions) {}

  private get sink(): EventSink {
    return this.options.sink;
  }

  private withTimeout<T>(id: string, body: () => Promise<T>): Promise<T> {
    const ms = TIMEOUTS[id] ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      body(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new SelfTestFailure("E_TIMEOUT", `${id} 超过 ${ms}ms 未完成`));
        }, ms);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private record(item: ItemResult): void {
    this.results.push(item);
    const head = `${item.id} ${item.status}${item.code !== undefined ? ` ${item.code}` : ""}`;
    this.sink.appendLine(head);
    if (item.detail !== undefined && item.detail.length > 0) {
      this.sink.appendLine(`    ${item.detail}`);
    }
  }

  private async item(
    id: string,
    body: () => Promise<string | void>,
    options: { retries?: number } = {},
  ): Promise<void> {
    const retries = options.retries ?? 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const detail = await this.withTimeout(id, body);
        const suffix = attempt > 0 ? `（第 ${attempt + 1} 次尝试成功）` : undefined;
        this.record({
          id,
          status: "PASS",
          detail: [detail, suffix].filter((part) => part !== undefined).join(" "),
        });
        return;
      } catch (error) {
        if (error instanceof SelfTestSkip) {
          this.record({ id, status: "SKIP", code: error.code, detail: error.message });
          return;
        }
        const code = error instanceof SelfTestFailure ? error.code : "E_UNEXPECTED";
        if (attempt < retries && retryable(code)) {
          this.sink.appendLine(`    ${id} 第 ${attempt + 1} 次失败（${code}），重试一次`);
          continue;
        }
        this.record({ id, status: "FAIL", code, detail: describe(error) });
        return;
      }
    }
  }

  async run(): Promise<{ results: ItemResult[]; gate: string }> {
    this.tempRoot = mkdtempSync(join(tmpdir(), "jerrypi-selftest-"));
    try {
      return await this.runAll();
    } finally {
      rmSync(this.tempRoot, { recursive: true, force: true });
    }
  }

  private async runAll(): Promise<{ results: ItemResult[]; gate: string }> {
    // 一次性构造所有夹具：R 与 R2 **共用同一个临时 cwd**，
    // 否则 T9 切到 T7 的会话时，那个 cwd 可能已经被清掉了
    // （switchSession 内部会断言会话的 cwd 存在）。
    const cwd = join(this.tempRoot, "cwd");
    const agentDir = this.options.agentDir;
    // 临时会话目录：**必须经 resolveSessionDir** 拿 per-cwd 目录。
    // 以前这里直接把 `<tempRoot>/sessions-r` 当 pi 的 `sessionDir` 传（那就是 S5 修的 bug 本身）。
    const sessionsRootR = join(this.tempRoot, "sessions-r");
    const sessionsRootR2 = join(this.tempRoot, "sessions-r2");
    const sessionDirR = resolveSessionDir(cwd, sessionsRootR);
    const sessionDirR2 = resolveSessionDir(cwd, sessionsRootR2);
    const fixtureDir = join(this.tempRoot, "fixture");
    const markerSession = join(this.tempRoot, "session-start.marker");
    const markerCommand = join(this.tempRoot, "command.marker");
    const markerWrite = join(this.tempRoot, "write.marker");
    for (const dir of [cwd, sessionsRootR, sessionsRootR2, fixtureDir]) {
      mkdirSync(dir, { recursive: true });
    }

    const fixtureSource = join(this.options.extensionPath, "test-fixtures", "ext-smoke");
    cpSync(fixtureSource, fixtureDir, { recursive: true, dereference: true });
    const fixtureIndex = join(fixtureDir, "index.ts");

    // fixture 通过环境变量拿到标记文件路径（jiti 与扩展同进程）。
    const previousMarker = process.env.JERRYPI_SMOKE_MARKER;
    const previousCommandMarker = process.env.JERRYPI_SMOKE_COMMAND_MARKER;
    process.env.JERRYPI_SMOKE_MARKER = markerSession;
    process.env.JERRYPI_SMOKE_COMMAND_MARKER = markerCommand;

    let hostR: SessionHost | undefined;
    let hostR2: SessionHost | undefined;
    let t7SessionFile: string | undefined;
    let t7MessageCount = 0;

    const extensionErrors: ExtensionError[] = [];
    const events: AgentSessionEvent[] = [];

    try {
      const { pi } = this.options;
      const ui: ExtensionUIContext = createSelfTestUIContext(this.sink);
      const mode: RuntimeMode = "rpc";

      // 先确定"用哪个模型"，因为 pi 自己的默认规则在一台只配了部分 provider 的
      // 机器上可能选中一个用不了的模型（见 pickModel 注释）。
      const modelRuntime = await getModelRuntime(pi, agentDir, this.options.keys);
      const providerSummary = describeConfiguredProviders(modelRuntime);
      const chosen: ModelChoice = await pickModel(modelRuntime);
      const modelDetail = chosen.detail;
      this.sink.appendLine(`[selftest] 已配置的 provider: ${providerSummary}`);
      this.sink.appendLine(`[selftest] 首选 provider: ${chosen.provider ?? "(无)"}；候选模型: ${modelDetail}`);

      await this.item("T1", () => this.testRuntimeVersions(providerSummary, modelDetail));
      await this.item("T2", () => this.testRuntimeResources());

      // ---- R：T3 / T6 / T9 共用 ----
      const hostOptions = {
        pi,
        cwd,
        agentDir,
        keys: this.options.keys,
        uiContext: ui,
        mode,
        sink: this.sink,
        additionalExtensionPaths: [fixtureIndex],
        writeRecorder: {
          record: (record: WriteRecord) => {
            // 一行一条 JSON：既是"包装真的被调用"的证据（T6），也是 S7 A9 要的
            // before/after 记录（tab 分隔装不下多行的文件内容）。
            appendFileSync(markerWrite, `${JSON.stringify(record)}\n`);
          },
        },
        onEvent: (event: AgentSessionEvent) => {
          events.push(event);
        },
        onExtensionError: (error: ExtensionError) => {
          extensionErrors.push(error);
        },
      };

      await this.item("T3", async () => {
          hostR = await createSessionHost({
            ...hostOptions,
            sessionManager: pi.SessionManager.create(cwd, sessionDirR),
          });
          const modelInfo = await alignSessionModel(hostR, chosen);
          this.sink.appendLine(`[selftest] 模型：${modelInfo}`);
          return this.testExtensionLifecycle(
            hostR,
            fixtureDir,
            markerSession,
            markerCommand,
            extensionErrors,
          );
        });

      await this.item(
        "T4",
        async () => {
          const session = this.requireHost(hostR).session;
          requireUsableModel(session);
          // 接受任意 *_delta：text_delta / thinking_delta / toolcall_delta。
          // T4 要证的是"真 provider 流式可用"，而不是"模型话多"——
          // 只认 text_delta 会在只输出思考的模型上误报。
          const deltas = new Set<string>();
          const unsubscribe = session.subscribe((event) => {
            if (event.type !== "message_update") return;
            const type = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent
              ?.type;
            if (typeof type === "string" && type.endsWith("_delta")) {
              deltas.add(type);
            }
          });
          try {
            await promptOrFail(session, "Reply with the single word PONG");
          } finally {
            unsubscribe();
          }
          if (deltas.size === 0) {
            failModelRelated(
              session,
              "E_MODEL_NOT_COOPERATING",
              `prompt 结束但没有任何 *_delta 事件；model=${describeModel(session)}`,
            );
          }
          return `delta=[${[...deltas].sort().join(", ")}]；model=${describeModel(session)}`;
        },
        { retries: 1 },
      );

      await this.item("T5a", () => this.testBashBasic(hostR));
      await this.item("T5b", () => this.testBashAbort(hostR));
      await this.item("T5c", () => this.testBashAbortViaModel(hostR));

      await this.item(
        "T6",
        async () => this.testWriteReadEdit(this.requireHost(hostR), cwd, markerWrite, events),
        { retries: 1 },
      );

      await this.item(
        "T7",
        async () => {
          hostR2 = await createSessionHost({
            ...hostOptions,
            sessionManager: pi.SessionManager.create(cwd, sessionDirR2),
          });
          const session = hostR2.session;
          requireUsableModel(session);
          await promptOrFail(session, "Reply with the single word PONG");
          const file = session.sessionFile;
          const count = session.messages.length;
          if (typeof file !== "string" || file.length === 0) {
            fail("E_MODEL_NOT_COOPERATING", "会话未落盘：pi 在首条 assistant 消息前不写文件");
          }
          await hostR2.dispose();
          hostR2 = undefined;

          // continueRecent 是**同步**的（返回 SessionManager，不是 Promise）
          const reopened = pi.SessionManager.continueRecent(cwd, sessionDirR2);
          const entries = reopened.getEntries().length;
          if (entries < 2) {
            fail("E_SESSION_ENTRIES", `重开后条目数 ${entries} < 2`);
          }
          t7SessionFile = reopened.getSessionFile() ?? file;
          t7MessageCount = count;
          return `文件 ${file}；重开后条目 ${entries}，消息 ${count}`;
        },
        { retries: 1 },
      );

      await this.item("T8", () => this.testImageWorker());

      await this.item(
        "T9",
        async () => {
          if (t7SessionFile === undefined) {
            fail("E_PRECONDITION", "T7 未产出会话文件，T9 无法执行");
          }
          return this.testSessionReplacement(
            this.requireHost(hostR),
            t7SessionFile,
            t7MessageCount,
            markerSession,
            events,
          );
        },
        { retries: 1 },
      );

      // ---- T10/T11/T12（S5 新增）：会话目录的推导必须与 pi 一致，且 CLI 能列出来
      await this.item("T10", () => this.testSessionDirGuard());
      await this.item("T11", () => this.testCliListingInterop());
      // T12 是 advisory（不参与 GATE）：它要去问**用户终端里那份 pi**，找不到就 SKIP
      await this.item("T12", () => this.testUserPiDrift());
      // T14（S8，**gating**）：工具审批。**不用模型**（脚本化 `streamFunction` + 内存 key，
      // 见 S8-plan F8），所以它在受限机/无凭据机器上也真的会跑 —— 这正是把它放进自测的理由。
      await this.item("T14", () => this.testApprovalGate());

      // T13 也是 advisory（S6 §3.4 / A11）：代理身份**只报告不判定** ——
      // 但这些值只能说明"这一层有没有生效"，说明不了"用户的网络能不能通"（T4 已经在真宿主里直连成功）。
      await this.item("T13", () => Promise.resolve(this.reportProxyIdentity()));
    } finally {
      await hostR2?.dispose().catch(() => undefined);
      await hostR?.dispose().catch(() => undefined);
      if (previousMarker === undefined) delete process.env.JERRYPI_SMOKE_MARKER;
      else process.env.JERRYPI_SMOKE_MARKER = previousMarker;
      if (previousCommandMarker === undefined) delete process.env.JERRYPI_SMOKE_COMMAND_MARKER;
      else process.env.JERRYPI_SMOKE_COMMAND_MARKER = previousCommandMarker;
    }

    return { results: this.results, gate: this.computeGate() };
  }

  private requireHost(host: SessionHost | undefined): SessionHost {
    if (host === undefined) {
      fail("E_HOST_MISSING", "前置项未建立会话宿主");
    }
    return host;
  }

  // -------------------------------------------------------------------------
  // T10–T12（S5）：会话目录推导与 pi / 终端那份 pi 的一致性
  // -------------------------------------------------------------------------

  /** 三条目录断言只在 agentDir 是 pi 的默认目录时有意义（S6 的自定义 agentDir 另说）。 */
  private requireDefaultAgentDir(): void {
    const { agentDir, pi } = this.options;
    if (resolve(agentDir) !== resolve(pi.getAgentDir())) {
      throw new SelfTestSkip(
        "E_CUSTOM_AGENT_DIR",
        `agentDir=${agentDir} 不是 pi 的默认目录，默认布局断言不适用（S6 的自定义 agentDir 场景）`,
      );
    }
  }

  /**
   * T10：**目录漂移守卫** —— 我们算出来的 per-cwd 目录必须就是 pi 自己的默认目录。
   *
   * 为什么需要它：`resolveSessionDir` 是**复刻** pi 的编码规则（`getDefaultSessionDir`
   * 没从 bundle 导出）。pi 哪天改了规则，我们就会再一次把会话写到没人看得见的地方，
   * 而且是静默的 —— 这条断言就是那个响声。
   */
  private async testSessionDirGuard(): Promise<string> {
    this.requireDefaultAgentDir();
    const { cwd, agentDir, pi } = this.options;
    const ours = resolveSessionDir(cwd, sessionsRootOf(agentDir));
    // 用真实 cwd：下面这两个 create 都会 mkdirSync，临时 cwd 会在用户真实 agentDir 下留垃圾。
    const piDefault = pi.SessionManager.create(cwd).getSessionDir();
    if (ours !== piDefault) {
      fail("E_SESSION_DIR_DRIFT", `我们算的 ${ours} ≠ pi 自己算的 ${piDefault}`);
    }
    const probe = pi.SessionManager.create(cwd, ours);
    if (!probe.usesDefaultSessionDir()) {
      fail("E_SESSION_DIR_NOT_DEFAULT", `pi 认为 ${ours} 不是默认会话目录`);
    }
    return `ours==pi：${ours}；usesDefaultSessionDir()=true`;
  }

  /**
   * T11：**模块级互通** —— 用 pi 的 CLI 算法（`list(cwd)` 不传 sessionDir）
   * 能把我们写下的会话列出来。不需网络、不需凭据。
   *
   * 会话真的写在**用户真实的 agentDir** 下（要验的就是那个位置），所以最后要收尾删除：
   * 只删我们自己建的那个编码目录，而且带一个"必须在 sessions 根之下"的守卫。
   */
  private async testCliListingInterop(): Promise<string> {
    this.requireDefaultAgentDir();
    const { agentDir, pi } = this.options;
    // **物理化**：`pi` CLI 的 cwd 是 `process.cwd()`（物理路径），而 macOS 上 `os.tmpdir()`
    // 给的是 `/var/folders/…`（`/private/var/…` 的符号链接）。不物理化的话，下面那句
    // `list(interopCwd)`（pi 自己算默认目录）会与我们的 `resolveSessionDir` 分叉，
    // 而分叉的真相是"CLI 找不到我们会话"（controller-check 里那条真 spawn 的检查先撞到的）。
    const interopCwd = realpathSync(mkdtempSync(join(this.tempRoot, "interop-cwd-")));
    const dir = resolveSessionDir(interopCwd, sessionsRootOf(agentDir));
    try {
      const manager = pi.SessionManager.create(interopCwd, dir);
      // pi 在第一条 assistant 消息之前不落盘，所以两条都要造（不调模型）。
      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: `jerrypi selftest interop ${Date.now()}` }],
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "jerrypi-selftest",
        provider: "jerrypi-selftest",
        model: "selftest",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const file = manager.getSessionFile();
      if (typeof file !== "string" || file.length === 0) {
        fail("E_SESSION_NOT_PERSISTED", "自造会话没有路径（pi 的落盘契约变了？）");
      }
      if (!existsSync(file)) {
        fail("E_SESSION_FILE_MISSING", `自造会话未落盘：${file}`);
      }
      // **CLI 的算法**：`pi --resume/-c` 走的也是 `list(cwd)`（不传 sessionDir）。
      const listed = await pi.SessionManager.list(interopCwd);
      if (!listed.some((info) => info.path === file)) {
        fail("E_INTEROP_LIST", `pi 的 list(cwd) 没看到 ${file}（它列了 ${listed.length} 条）`);
      }
      return `pi 的 list(cwd) 看到了它：${basename(file)}（${dir}）`;
    } finally {
      const root = resolve(sessionsRootOf(agentDir));
      if (resolve(dir).startsWith(root + sep)) rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * T12（**advisory**，不参与 GATE）：直接去问**用户终端里那份 pi** 算出来的目录。
   *
   * 为什么需要它：T10/T11 跑的是我们自己打包的那份 pi（`pi-runtime/`），
   * 而用户终端里的 `pi` 是**另一份独立安装**（自己会升级）—— 它改了编码规则时，
   * T10/T11 照样全绿，而互通已经断了。所以这里 import 它自己的未打包源码问一次。
   * 找不到 / 不是 JS 入口 / 没有未打包源码 → SKIP（受限机就是这样，没有 pi）。
   */
  private async testUserPiDrift(): Promise<string> {
    const { cwd, agentDir } = this.options;
    const exe = findOnPath("pi");
    if (exe === undefined) throw new SelfTestSkip("E_NO_PI", "PATH 上没有 pi（受限机就是这样）");
    let real: string;
    try {
      real = realpathSync(exe);
    } catch {
      throw new SelfTestSkip("E_PI_REALPATH", `${exe} 无法解析真实路径`);
    }
    if (!real.endsWith(".js")) {
      throw new SelfTestSkip("E_PI_NOT_JS", `PATH 上的 pi 不是 JS 入口（${real}）`);
    }
    const pkgRoot = resolve(dirname(real), "..", "..");
    const modulePath = join(pkgRoot, "dist", "core", "session-manager.js");
    if (!existsSync(modulePath)) {
      throw new SelfTestSkip("E_PI_NO_SOURCES", `那份 pi 没有未打包源码（${modulePath}）`);
    }
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      getDefaultSessionDir?: (cwd: string, agentDir?: string) => string;
    };
    if (typeof mod.getDefaultSessionDir !== "function") {
      throw new SelfTestSkip("E_PI_API", "那份 pi 没有导出 getDefaultSessionDir");
    }
    const theirs = mod.getDefaultSessionDir(cwd, agentDir);
    const ours = resolveSessionDir(cwd, sessionsRootOf(agentDir));
    if (ours !== theirs) {
      fail(
        "E_CLI_DRIFT",
        `⚠️ 两份 pi 算出来的会话目录不一致：我们 ${ours}｜终端那份 pi ${theirs}` +
          "（互通已断，请重跑 docs/S5-plan.md §7 的动作②）",
      );
    }
    return `与终端那份 pi（${real}）一致：${theirs}`;
  }

  /**
   * T13（advisory，S6 §3.4 / A11）：代理身份的**报告**，不做 PASS/FAIL 判定。
   *
   * 三件事：① `globalThis.fetch` 是不是原生实现（VS Code 的 `http.proxySupport: override`
   * 会把它换成普通函数）；② `http.proxySupport` / `http.proxy` 的值；③ 四个代理环境变量的
   * **存在性**（不打印值）。加 PI_OFFLINE 是为了给"目录刷新为何不联网"留下可对照的痕迹
   * （它是推导值 —— `modelNetworkEnabled = PI_OFFLINE === undefined`）。
   *
   * 为什么只报告不判定：这些值只能说明"这一层有没有生效"，说明不了"网络能不能通"
   * （T4 已在真宿主里直连成功）。把读不懂的身份变成 FAIL 是假失败。
   * 但"必须产生一行 T13"是真要求（评审第 4 轮 N3）：`item()` 即使抛异常也会写一行 T13 FAIL。
   */
  private reportProxyIdentity(): string {
    let fetchNative: boolean | undefined = undefined;
    try {
      fetchNative = String(globalThis.fetch).includes("[native code]");
    } catch {
      // 极少数宿主的 toString 可能被代理掉；保持 undefined（“读不到”）而不是把 T13 变红
    }
    const http = this.options.httpProxyConfig;
    const present = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].filter(
      (name) => (process.env[name] ?? "").length > 0,
    );
    return describeProxyIdentity({
      fetchNative,
      proxySupport: http?.proxySupport,
      proxy: http?.proxy,
      proxyEnvNames: present,
      piOfflineSet: process.env.PI_OFFLINE !== undefined,
    });
  }

  private computeGate(): string {
    const blocked = this.results.filter(
      (item) => (REQUIRED_ITEMS as readonly string[]).includes(item.id) && item.status !== "PASS",
    );
    if (blocked.length === 0) return "GATE PASS";
    return `GATE BLOCKED ${blocked.map((item) => item.id).join(",")}`;
  }

  // -------------------------------------------------------------------------
  // T1：运行时版本
  // -------------------------------------------------------------------------
  private async testRuntimeVersions(providerSummary: string, modelDetail: string): Promise<string> {
    const node = process.versions.node;
    const segments = node.split(".").map((part) => Number.parseInt(part, 10));
    for (let index = 0; index < MIN_NODE.length; index += 1) {
      const actual = segments[index] ?? 0;
      const expected = MIN_NODE[index];
      if (actual > expected) break;
      if (actual < expected) {
        fail("E_NODE_VERSION", `Node ${node} < ${MIN_NODE.join(".")}`);
      }
    }
    return `node=${node} electron=${process.versions.electron ?? "-"} vscode=${this.options.vscodeVersion}` +
      `；已配置 provider=[${providerSummary}]；模型=${modelDetail}`;
  }

  // -------------------------------------------------------------------------
  // T2：bundle 与其资源
  // -------------------------------------------------------------------------
  private async testRuntimeResources(): Promise<string> {
    const { extensionPath, pi } = this.options;
    const expected = await readRuntimeVersion(extensionPath);
    if (expected === undefined) {
      fail("E_RUNTIME_MISSING", "pi-runtime/.version 缺失");
    }
    if (pi.VERSION !== expected) {
      fail("E_VERSION", `bundle=${String(pi.VERSION)} 期望=${expected}`);
    }
    if (!pi.getPackageDir().endsWith("pi-runtime")) {
      fail("E_PACKAGE_DIR", `getPackageDir()=${pi.getPackageDir()}`);
    }

    for (const relative of REQUIRED_RESOURCE_FILES) {
      const full = runtimePath(extensionPath, ...relative.split("/"));
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) fail("E_RESOURCE", `${relative} 是符号链接`);
      if (!stats.isFile()) fail("E_RESOURCE", `${relative} 不是普通文件`);
      if (stats.size === 0) fail("E_RESOURCE", `${relative} 为空`);
      accessSync(full, constants.R_OK);
    }
    for (const relative of REQUIRED_RESOURCE_DIRS) {
      const full = runtimePath(extensionPath, relative);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) fail("E_RESOURCE", `${relative} 是符号链接`);
      if (!stats.isDirectory()) fail("E_RESOURCE", `${relative} 不是目录`);
      if (readdirSync(full).length === 0) fail("E_RESOURCE", `${relative} 是空目录`);
    }

    return `${REQUIRED_RESOURCE_FILES.length} 个文件 + ${REQUIRED_RESOURCE_DIRS.length} 个目录全部合格；pi ${pi.VERSION}`;
  }

  // -------------------------------------------------------------------------
  // T3：扩展生命周期（含同名覆盖与 onError 通路）
  // -------------------------------------------------------------------------
  private async testExtensionLifecycle(
    host: SessionHost,
    fixtureDir: string,
    markerSession: string,
    markerCommand: string,
    extensionErrors: ExtensionError[],
  ): Promise<string> {
    const session = host.session;
    const errors = host.runtime.services.resourceLoader.getExtensions().errors ?? [];
    const fixtureErrors = errors.filter((entry) => entry.path.includes(fixtureDir));
    if (fixtureErrors.length > 0) {
      fail("E_EXTENSION_ERRORS", JSON.stringify(fixtureErrors));
    }

    const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.name);
    if (!commands.includes("smoke")) {
      fail("E_EXTENSION_COMMANDS", `已注册命令 = [${commands.join(", ")}]`);
    }

    // session_start 标记（由 fixture 的 session_start 处理器写出）
    if (!readMarker(markerSession).includes("session_start")) {
      fail("E_SESSION_START_MARKER", `${markerSession} 里没有 session_start`);
    }

    // 同名覆盖：内置 write 的 sourceInfo.source 是 "builtin"，我们的 customTools 是 "sdk"
    const writeTool = session.getAllTools().find((tool) => tool.name === "write");
    if (writeTool === undefined) {
      fail("E_TOOL_OVERRIDE", "工具表里没有 write");
    }
    const source = writeTool.sourceInfo?.source;
    if (source !== "sdk") {
      fail("E_TOOL_OVERRIDE", `write 的来源是 ${String(source)}，期望 sdk（同名覆盖未生效）`);
    }

    // 扩展命令通路
    await session.prompt("/smoke");
    if (!readMarker(markerCommand).includes("smoke")) {
      fail("E_COMMAND_MARKER", `/smoke 未写出标记：${readMarker(markerCommand)}`);
    }

    // 可控错误通路：/smoke-custom 调 ctx.ui.custom()，自测 UI 会抛错
    const errorsBefore = extensionErrors.length;
    let promptThrew = false;
    try {
      await session.prompt("/smoke-custom");
    } catch {
      promptThrew = true;
    }
    if (!readMarker(markerCommand).includes("smoke-custom")) {
      fail("E_COMMAND_MARKER", "/smoke-custom 未写出标记");
    }
    const reportedViaOnError = extensionErrors.length > errorsBefore;
    if (!reportedViaOnError && !promptThrew) {
      fail("E_ERROR_PATH", "custom UI 的错误既没有经 onError 上报，也没有让 prompt 失败");
    }
    if (!session.isIdle) {
      fail("E_SESSION_STUCK", "可控错误之后会话没有回到 idle");
    }

    return `命令=[${commands.join(", ")}]；onError=${reportedViaOnError ? "命中" : "未命中（prompt 抛出）"}；write←sdk`;
  }

  // -------------------------------------------------------------------------
  // T5a：bash 基本可用性（失败必须分层）
  // -------------------------------------------------------------------------
  /**
   * T14（S8）：工具审批的**不用模型**版本。
   *
   * 为什么能不用模型（S8-plan §0.1 F8）：把 `session.agent.streamFunction` 换成脚本化的假流，
   * 再给那个 provider 一把**内存** key（走生产路径的 `ApiKeyStore` 注入）骗过 `prompt()` 的
   * 前置检查 —— 之后 pi 的 `tool_call` 钩子、真的 bash 工具、中止流程全都是真的。
   *
   * 三条纪律（S8-plan R2，探针挂过两次）：① 假流必须尊重 signal；② 工具调用之后必须收尾；
   * ③ 每条 `prompt()` 都套超时。
   *
   * ⚠️ **独立的临时 agentDir**（F8）：那把假 key 会留在这个 `ModelRuntime` 里，而
   * `getModelRuntime` 按 agentDir 缓存 —— 共用 agentDir 会污染后面几条模型项的 provider 判断。
   */
  private async testApprovalGate(): Promise<string> {
    const { pi } = this.options;
    const root = join(this.tempRoot, "approval");
    const agentDir = join(root, "agent");
    const cwd = join(root, "cwd");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const marker = join(cwd, "t14-marker.txt");

    const bootstrap = await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const model = bootstrap.getModels()[0];
    const keys: ApiKeyStore = {
      listProviders: () => [model.provider],
      getApiKey: async (providerId) => (providerId === model.provider ? "selftest-probe-key" : undefined),
      saveApiKey: async () => {},
      removeApiKey: async () => {},
    };

    const asked: string[] = [];
    let mode: "off" | "mutating" | "all" = "all";
    let answer: "allow" | "deny" | "hang" = "deny";
    const approvals = createApprovals({
      log: this.sink,
      onPending: (request) => {
        asked.push(request.toolName);
        if (answer !== "hang") approvals.decide(request.toolCallId, answer);
      },
    });
    const host = await createSessionHost({
      pi,
      cwd,
      agentDir,
      sessionManager: pi.SessionManager.create(cwd, resolveSessionDir(cwd, join(root, "sessions"))),
      keys,
      uiContext: createSelfTestUIContext(this.sink),
      mode: "rpc",
      sink: this.sink,
      model,
      approval: { mode: () => mode, approvals },
    });

    let steps: { id: string; name: string; arguments: unknown }[] = [];
    let turn = 0;
    const script = (next: typeof steps): void => {
      steps = next;
      turn = 0;
    };
    const fakeStream = async (
      m: { api: string; provider: string; id: string },
      _ctx: unknown,
      opts?: { signal?: AbortSignal },
    ) => {
      const aborted = opts?.signal?.aborted === true;
      const step = aborted ? undefined : steps[turn];
      turn += 1;
      const base = {
        role: "assistant" as const,
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0 } },
        timestamp: Date.now(),
      };
      const message = aborted
        ? { ...base, content: [{ type: "text" as const, text: "(aborted)" }], stopReason: "aborted" as const }
        : step !== undefined
          ? {
              ...base,
              content: [{ type: "toolCall" as const, id: step.id, name: step.name, arguments: step.arguments }],
              stopReason: "stop" as const,
            }
          : { ...base, content: [{ type: "text" as const, text: "(done)" }], stopReason: "stop" as const };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: message };
          yield { type: "done" };
        },
        async result() {
          return message;
        },
      };
    };
    // 鸭子类型说明：pi 的循环只用 `for await (const event of stream)` + `await stream.result()`
    // （S8-plan F8 的实测），所以这里给的对象就够了；而 `StreamFn` 的声明类型还要求
    // `AssistantMessageEventStream` 的队列细节（queue/waiting/…），我们不实现它们。
    // 用一次**显式**断言，而不是 `any` —— 断言的理由就在这两行注释里。
    host.session.agent.streamFunction =
      fakeStream as unknown as typeof host.session.agent.streamFunction;

    const withTimeout = async (promise: Promise<unknown>, ms: number, label: string): Promise<unknown> =>
      Promise.race([
        promise,
        new Promise((_resolve, reject) => setTimeout(() => reject(new SelfTestFailure("E_TIMEOUT", `${label} 超时 ${ms}ms`)), ms)),
      ]);
    const toolResultTexts = (): { isError: boolean; text: string }[] =>
      host.session.messages
        .filter((message) => (message as { role?: string }).role === "toolResult")
        .map((message) => {
          const raw = message as { isError?: boolean; content?: { text?: string }[] };
          return { isError: raw.isError === true, text: raw.content?.[0]?.text ?? "" };
        });

    try {
      // ① 拒绝 → 工具没执行，且 agent 收到我们给的原因
      script([{ id: "t14-1", name: "bash", arguments: { command: `touch ${marker}` } }]);
      await withTimeout(host.session.prompt("go"), 15_000, "T14 拒绝轮的 prompt()");
      if (existsSync(marker)) fail("E_APPROVAL_NOT_BLOCKING", "拒绝之后 bash 仍然执行了（文件被创建）");
      const denied = toolResultTexts();
      if (!denied.some((r) => r.isError && r.text.startsWith("Rejected by user: "))) {
        fail("E_APPROVAL_REASON", `拒绝之后的 toolResult 不是我们给的 reason：${JSON.stringify(denied)}`);
      }

      // ② 允许 → 真的执行
      answer = "allow";
      script([{ id: "t14-2", name: "bash", arguments: { command: `touch ${marker}` } }]);
      await withTimeout(host.session.prompt("again"), 15_000, "T14 允许轮的 prompt()");
      if (!existsSync(marker)) fail("E_APPROVAL_NOT_EXECUTING", "允许之后 bash 没有执行（文件不存在）");

      // ③ mutating 档放行只读工具（不问）
      mode = "mutating";
      const beforeRead = asked.length;
      script([{ id: "t14-3", name: "read", arguments: { path: marker } }]);
      await withTimeout(host.session.prompt("read"), 15_000, "T14 只读轮的 prompt()");
      if (asked.length !== beforeRead) fail("E_APPROVAL_OVERREACH", `mutating 档问了只读工具：${JSON.stringify(asked)}`);

      // ④ 待审批时中止 → 收口、文件不存在
      mode = "all";
      answer = "hang";
      rmSync(marker, { force: true });
      script([{ id: "t14-4", name: "bash", arguments: { command: `touch ${marker}` } }]);
      const running = host.session.prompt("hang").then(() => "resolved", () => "threw");
      // 等的是"**这一轮**又问了一次"（`asked` 里前面几轮也有 bash，用个数比对，
      // 否则循环立刻退出、下面那条断言会看到 0 而误报）
      const beforeHang = asked.length;
      for (let i = 0; i < 200 && asked.length === beforeHang; i += 1) await new Promise((r) => setTimeout(r, 25));
      if (approvals.size().pending !== 1) fail("E_APPROVAL_NOT_PENDING", `中止前待审批数=${approvals.size().pending}`);
      await host.session.abort();
      await withTimeout(running, 5_000, "T14 中止后的 prompt()");
      if (approvals.size().pending !== 0) fail("E_APPROVAL_NOT_CLEARED", `中止后仍有待审批：${approvals.size().pending}`);
      if (!host.session.isIdle) fail("E_APPROVAL_NOT_IDLE", "中止之后会话没有回到空闲");
      if (existsSync(marker)) fail("E_APPROVAL_ABORT_SIDE_EFFECT", "中止之后 bash 仍然执行了");

      return `三档 + 拒绝/允许/中止都符合；问过 ${asked.length} 次（${[...new Set(asked)].join("/")}）`;
    } finally {
      await host.dispose().catch(() => undefined);
    }
  }

  private async testBashBasic(host: SessionHost | undefined): Promise<string> {
    const session = this.requireHost(host).session;

    let shell = "(unknown)";
    try {
      shell = this.options.pi.getShellConfig().shell;
    } catch {
      // 找不到 shell 也没关系：下面的 executeBash 会给出带搜索路径的原文
    }

    let result;
    try {
      result = await session.executeBash("echo hi && pwd");
    } catch (error) {
      const message = describe(error);
      if (message.includes("Custom shell path not found")) {
        fail("E_SHELL_PATH_INVALID", message);
      }
      if (message.includes("No bash shell found")) {
        fail("E_NO_SHELL", message);
      }
      if (/ENOENT|EACCES|EPERM|spawn/i.test(message)) {
        fail("E_SPAWN_DENIED", message);
      }
      fail("E_SHELL_OUTPUT", message);
    }

    const cwd = session.sessionManager.getCwd();
    // Git Bash（MSYS）会把 `C:\Users\...\Temp` 映射成 `/tmp`，所以不能直接比全路径。
    // 取 cwd 的最后两段做比对，两种写法都命中。
    const normalized = result.output.replace(/\\/g, "/");
    const tail = cwd.split(/[\\/]/).filter((part) => part.length > 0).slice(-2).join("/");
    if (!normalized.includes(tail)) {
      fail("E_SHELL_OUTPUT", `输出未包含 cwd 尾部 ${tail}：${result.output.slice(0, 200)}`);
    }
    const pwdLine = result.output.trim().split("\n").at(-1) ?? "";
    return `shell=${shell}；pwd=${pwdLine.trim()}（cwd 尾部 ${tail} 命中）`;
  }

  // -------------------------------------------------------------------------
  // T5b：abortBash（不经模型，A3 的决定性证据）
  // -------------------------------------------------------------------------
  private async testBashAbort(host: SessionHost | undefined): Promise<string> {
    const session = this.requireHost(host).session;
    const running = session.executeBash("sleep 30");
    await sleep(2_000);
    const abortAt = Date.now();
    session.abortBash();
    const result = await running;
    const elapsed = Date.now() - abortAt;
    if (elapsed > 3_000) {
      fail("E_NOT_ABORTED", `abortBash 后 ${elapsed}ms 才返回`);
    }
    if (result.cancelled !== true) {
      fail("E_NOT_CANCELLED", `BashResult.cancelled=${String(result.cancelled)}`);
    }
    return `abortBash 后 ${elapsed}ms 返回，cancelled=true`;
  }

  // -------------------------------------------------------------------------
  // T5c（advisory）：模型驱动的中止
  // -------------------------------------------------------------------------
  private async testBashAbortViaModel(host: SessionHost | undefined): Promise<string> {
    const session = this.requireHost(host).session;
    const token = `JERRYPI_START_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

    let toolCallId: string | undefined;
    let markerAt: number | undefined;
    let agentEndAt: number | undefined;
    let abortTimer: NodeJS.Timeout | undefined;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const record = event as { toolName?: string; toolCallId?: string };
        if (record.toolName === "bash" && toolCallId === undefined) {
          toolCallId = record.toolCallId;
        }
      }
      if (event.type === "tool_execution_update") {
        const record = event as { toolCallId?: string; partialResult?: unknown };
        if (toolCallId !== undefined && record.toolCallId === toolCallId && markerAt === undefined) {
          if (JSON.stringify(record.partialResult ?? "").includes(token)) {
            markerAt = Date.now();
            // 看到启动标记后再等 2 秒才中止（确认命令真的跑起来了）
            abortTimer = setTimeout(() => {
              void session.abort();
            }, 2_000);
          }
        }
      }
      if (event.type === "agent_end") {
        agentEndAt = Date.now();
      }
    });

    try {
      await promptOrFail(session, `Run this exact bash command: echo ${token} && sleep 30`);
      // prompt 返回即 agent 结束；等一拍让事件落地
      await sleep(50);
    } catch (error) {
      // T5c 是 advisory：没有凭据时记 SKIP，而不是污染 GATE 判定。
      if (error instanceof SelfTestFailure && error.code === "E_NO_CREDENTIALS") {
        throw new SelfTestSkip("E_NO_CREDENTIALS", "没有可用模型，无法驱动 bash 中止测试");
      }
      throw error;
    } finally {
      unsubscribe();
      if (abortTimer !== undefined) clearTimeout(abortTimer);
    }

    if (toolCallId === undefined) {
      const error = lastAssistantError(session);
      if (error !== undefined) {
        fail(providerErrorCode(error), `模型未能发起 bash 调用；${describeLastAssistant(session)}`);
      }
      throw new SelfTestSkip(
        "E_NO_TOOLCALL",
        `60 秒内模型没有发起 bash 调用；model=${describeModel(session)}；${describeLastAssistant(session)}`,
      );
    }
    if (markerAt === undefined) {
      fail("E_NO_SPAWN", "模型发起了 bash 调用，但没有收到启动标记");
    }
    if (agentEndAt === undefined) {
      fail("E_NOT_ABORTED", "调用 abort() 后没有收到 agent_end");
    }
    const elapsed = agentEndAt - markerAt;
    if (elapsed > 30_000) {
      fail("E_NOT_ABORTED", `从启动标记到 agent_end 用了 ${elapsed}ms，abort 未生效`);
    }
    return `toolCallId=${toolCallId}；标记后 ${elapsed}ms 结束`;
  }

  // -------------------------------------------------------------------------
  // T6：write → read → edit（同时验证 wrappedWrite 的行为证据）
  // -------------------------------------------------------------------------
  private async testWriteReadEdit(
    host: SessionHost,
    cwd: string,
    markerWrite: string,
    events: AgentSessionEvent[],
  ): Promise<string> {
    const session = host.session;
    requireUsableModel(session);
    const target = join(cwd, "selftest-note.txt");
    const before = events.length;

    // 分成三步单独下指令：一条长指令让模型一次做完三件事，失败率明显更高，
    // 而且失败时分不清是"模型不配合"还是"工具坏了"。
    await promptOrFail(
      session,
      `Use the write tool to create the file ${target} with exactly this content: jerrypi-selftest. Do not use bash.`,
    );
    if (!existsSync(target)) {
      failModelRelated(
        session,
        "E_MODEL_NOT_COOPERATING",
        `write 之后文件不存在；model=${describeModel(session)}`,
      );
    }

    await promptOrFail(session, `Use the read tool to read ${target}. Do not use bash.`);
    await promptOrFail(
      session,
      `Use the edit tool on ${target} to replace jerrypi-selftest with jerrypi-selftest-edited. Do not use bash.`,
    );

    const content = readFileSync(target, "utf8").trim();
    if (content !== "jerrypi-selftest-edited") {
      fail(
        "E_MODEL_NOT_COOPERATING",
        `文件内容是 ${JSON.stringify(content)}；model=${describeModel(session)}；${describeLastAssistant(session)}`,
      );
    }

    const patch = events
      .slice(before)
      .filter((event) => event.type === "tool_execution_end")
      .map((event) => event as { toolName?: string; result?: { details?: { patch?: unknown } } })
      .filter((event) => event.toolName === "edit")
      .map((event) => event.result?.details?.patch)
      .find((value) => typeof value === "string" && value.length > 0);
    if (patch === undefined) {
      fail("E_NO_PATCH", "没有拿到非空的 details.patch");
    }

    const writeMarker = readMarker(markerWrite);
    if (writeMarker.trim().length === 0) {
      fail("E_TOOL_OVERRIDE", "wrappedWrite 没有被调用（标记文件为空）");
    }
    const lastCall = writeMarker.trim().split("\n").at(-1) ?? "";
    let recorded: WriteRecord | undefined;
    try {
      recorded = JSON.parse(lastCall) as WriteRecord;
    } catch {
      fail("E_TOOL_OVERRIDE", `标记不是一行 JSON：${lastCall.slice(0, 120)}`);
    }
    if (typeof recorded.toolCallId !== "string" || recorded.toolCallId.length === 0) {
      fail("E_TOOL_OVERRIDE", `标记内容缺少 toolCallId：${lastCall.slice(0, 120)}`);
    }
    if (recorded.absolutePath !== target) {
      fail("E_TOOL_OVERRIDE", `记录路径 ${recorded.absolutePath} != ${target}`);
    }
    // A9（S7）：包装不仅要"被调用"，还要把**该次调用**的前后内容记对。
    if (recorded.before !== null) {
      fail(
        "E_WRITE_SNAPSHOT",
        `这是本目录里对该文件的第一次写，before 应为 null；实际 ${JSON.stringify(recorded.before)?.slice(0, 80)}`,
      );
    }
    if (recorded.newFile !== true || !recorded.after.includes("jerrypi-selftest")) {
      fail("E_WRITE_SNAPSHOT", `after/newFile 不对：newFile=${String(recorded.newFile)} after=${JSON.stringify(recorded.after)?.slice(0, 80)}`);
    }

    return `内容正确；patch ${String(patch).length} 字符；wrappedWrite 捕获 toolCallId=${recorded.toolCallId}（before=null/newFile 已核对）；model=${describeModel(session)}`;
  }

  // -------------------------------------------------------------------------
  // T8：图片 worker 往返（自造 PNG，不引三方库）
  // -------------------------------------------------------------------------
  private async testImageWorker(): Promise<string> {
    const { pi, extensionPath } = this.options;
    const workerPath = runtimePath(
      extensionPath,
      "dist",
      "bundle",
      "chunks",
      "image-resize-worker.js",
    );
    const png = createSolidPng(3_000, 3_000);

    const worker = new Worker(pathToFileURL(workerPath));
    let response: { result?: { width?: number; height?: number }; error?: string };
    try {
      response = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new SelfTestFailure("E_WORKER_TIMEOUT", "worker 10 秒未响应")),
          10_000,
        );
        worker.once("message", (message) => {
          clearTimeout(timer);
          resolve(message as typeof response);
        });
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(new SelfTestFailure("E_WORKER_ERROR", describe(error)));
        });
        worker.postMessage({
          inputBytes: png,
          mimeType: "image/png",
          options: { maxWidth: 1_000, maxHeight: 1_000, maxBytes: 1_000_000 },
        });
      });
    } finally {
      await worker.terminate();
    }

    if (response.error !== undefined) {
      fail("E_WORKER_ERROR", response.error);
    }
    const width = response.result?.width;
    const height = response.result?.height;
    if (typeof width !== "number" || typeof height !== "number" || width >= 3_000) {
      fail("E_WORKER_RESULT", `worker 返回 ${JSON.stringify(response.result ?? null)}`);
    }

    // 单独调 resizeImage 只作补充：它失败时会**静默回落到主线程**，
    // 而且可能返回 null（Photon 不可用或压不到 maxBytes）。
    const resized = await pi.resizeImage(createSolidPng(3_000, 3_000), "image/png", {
      maxWidth: 1_000,
      maxHeight: 1_000,
      maxBytes: 1_000_000,
    });
    if (resized === null) {
      fail("E_RESIZE_NULL", "resizeImage() 返回 null（Photon 不可用或压不到 maxBytes）");
    }
    if (resized.width >= 3_000) {
      fail("E_RESIZE_RESULT", `resizeImage() 未缩小：${resized.width}x${resized.height}`);
    }

    return `worker 往返 ${width}x${height}（原 3000x3000）；resizeImage ${resized.width}x${resized.height}`;
  }

  // -------------------------------------------------------------------------
  // T9：会话替换（newSession / switchSession）+ 重绑
  // -------------------------------------------------------------------------
  private async testSessionReplacement(
    host: SessionHost,
    t7SessionFile: string,
    t7MessageCount: number,
    markerSession: string,
    events: AgentSessionEvent[],
  ): Promise<string> {
    const { runtime } = host;
    const before = runtime.session;
    const startsBefore = countMarkerLines(markerSession, "session_start");

    const created = await runtime.newSession();
    if (created.cancelled !== false) {
      fail("E_CANCELLED", `newSession() 返回 cancelled=${String(created.cancelled)}`);
    }
    if (runtime.session === before) {
      fail("E_NOT_REPLACED", "newSession() 之后 session 还是同一个对象");
    }
    const newFile = runtime.session.sessionFile;
    if (newFile !== undefined && newFile === before.sessionFile) {
      fail("E_NOT_REPLACED", `新会话文件与旧会话相同：${newFile}`);
    }
    if (countMarkerLines(markerSession, "session_start") <= startsBefore) {
      fail("E_REBIND_MISSING", "新会话没有触发 session_start（rebind 未生效）");
    }
    const commands = runtime.session.extensionRunner.getRegisteredCommands().map((c) => c.name);
    if (!commands.includes("smoke")) {
      fail("E_REBIND_MISSING", `新会话的命令=[${commands.join(", ")}]`);
    }

    const switched = await runtime.switchSession(t7SessionFile);
    if (switched.cancelled !== false) {
      fail("E_CANCELLED", `switchSession() 返回 cancelled=${String(switched.cancelled)}`);
    }
    const restored = runtime.session.messages.length;
    if (restored !== t7MessageCount) {
      fail("E_HISTORY_MISMATCH", `切回后消息数 ${restored} != T7 的 ${t7MessageCount}`);
    }

    // 订阅必须在重绑后仍然有效：用一次 prompt 触发 agent_start
    let sawAgentStart = false;
    const from = events.length;
    const unsubscribe = runtime.session.subscribe((event) => {
      if (event.type === "agent_start") sawAgentStart = true;
    });
    try {
    await promptOrFail(runtime.session, "Reply with the single word PONG");
    } finally {
      unsubscribe();
    }
    if (!sawAgentStart && !events.slice(from).some((event) => event.type === "agent_start")) {
      fail("E_MODEL_NOT_COOPERATING", "重绑后没有收到 agent_start 事件");
    }

    return `newSession 新文件=${newFile ?? "-"}；switchSession 恢复 ${restored} 条消息；agent_start 可达`;
  }
}

// ---------------------------------------------------------------------------
// PNG 生成（无第三方依赖）
// ---------------------------------------------------------------------------

function createSolidPng(width: number, height: number): Uint8Array {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = 200;
      raw[pixel + 1] = 60;
      raw[pixel + 2] = 60;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readMarker(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function countMarkerLines(path: string, needle: string): number {
  return readMarker(path)
    .split("\n")
    .filter((line) => line.trim() === needle).length;
}

/**
 * 在 PATH 上找一个可执行的文件（**不 spawn**，只查文件）。
 * 只给 T12（advisory）用：找不到就 SKIP，不会因此失败。
 */
function findOnPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  // PATH 的分隔符是 `delimiter`（POSIX `:`，Windows `;`），**不是 `sep`**（`/`）。
  // 踩过：用 `sep` 拆的结果是一堆无效条目 → T12 静默 SKIP（看起来像"这台机器没有 pi"）。
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        // **必须用 statSync（跟符号链接）**：npm/fnm 装在 PATH 上的 `pi` 通常是指向
        // `dist/bundle/cli.js` 的符号链接，`lstatSync().isFile()` 会返回 false
        // → T12 静默 SKIP（看起来像"这台机器没装 pi"，而其实装了）。
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // 权限/竞态：忽略这个候选
      }
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function runSelfTest(options: SelfTestOptions): Promise<string> {
  const header = [
    `flyjancy.jerrypi ${options.extensionVersion}`,
    SELFTEST_TAG,
    process.platform,
    `node=${process.versions.node}`,
  ].join(" ");
  options.sink.appendLine(header);

  const run = new SelfTestRun(options);
  const { results, gate } = await run.run();
  options.sink.appendLine(gate);
  const failed = results.filter((item) => item.status === "FAIL").length;
  const skipped = results.filter((item) => item.status === "SKIP").length;
  options.sink.appendLine(`（共 ${results.length} 项：${results.length - failed - skipped} PASS / ${failed} FAIL / ${skipped} SKIP）`);
  return gate;
}

export { createSolidPng };
