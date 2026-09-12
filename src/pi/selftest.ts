// S1 可行性闸门：T1–T9 + GATE 判定。
//
// 输出契约（PLAN.md 第 6 节 S1）：
//   flyjancy.jerrypi <扩展版本> selftest-v1 <平台> node=<版本>
//   T1 PASS
//   T3 FAIL E_EXTENSION_ERRORS
//   ...
//   GATE PASS | GATE BLOCKED <失败项列表>
//
// 判定规则：**除 T5c 外，任一 required 项非 PASS 即 GATE BLOCKED；SKIP 不算通过。**
// T5c 是 advisory，其 FAIL/SKIP 都不参与判定。
//
// 设计约束：
//   - 不污染用户环境：全部临时目录在 os.tmpdir() 下，最后统一清理；
//   - 每项独立超时；每项结束立刻写一行 Output（最坏情况约 16 分钟，中途静默无法定位）；
//   - 模型相关项（T4/T6/T7/T9）各重试 1 次，并把 E_MODEL_* 与能力错误分开记录。
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { crc32, deflateSync } from "node:zlib";
import type { AgentSessionEvent, ExtensionError, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EventSink, RuntimeMode } from "./bindings";
import { readRuntimeVersion, runtimePath, type PiModule } from "./loader";
import { REQUIRED_RESOURCE_DIRS, REQUIRED_RESOURCE_FILES } from "./resources";
import type { ApiKeyStore } from "./runtime";
import { getModelRuntime } from "./runtime";
import { createSessionHost, type SessionHost } from "./session";
import { createSelfTestUIContext } from "./selftest-ui";

export const SELFTEST_TAG = "selftest-v1";

export interface SelfTestOptions {
  pi: PiModule;
  extensionPath: string;
  extensionVersion: string;
  vscodeVersion: string;
  agentDir: string;
  keys: ApiKeyStore;
  sink: EventSink;
}

type Status = "PASS" | "FAIL" | "SKIP";

interface ItemResult {
  id: string;
  status: Status;
  code?: string;
  detail?: string;
}

/** 参与 GATE 判定的项（T5c 是 advisory）。 */
const REQUIRED_ITEMS = ["T1", "T2", "T3", "T4", "T5a", "T5b", "T6", "T7", "T8", "T9"] as const;

const MIN_NODE = [24, 15, 0] as const;

/** 自测选模型时的优先级：先把用户最可能配的 deepseek 放前面。 */
const PREFERRED_PROVIDERS = ["deepseek", "anthropic", "google", "openrouter", "openai"] as const;

/**
 * 选一个**真正可用**（有凭据）的模型。
 *
 * 为什么要显式选：不传 model 时 pi 会按 settings 与内置默认规则自己挑，
 * 在一台只配了部分 provider 的机器上，它可能挑到一个用不了的模型
 * （实测：某 Windows 机上它挑了 openai/gpt-5.5，而那里只有别的 provider 的 key），
 * 于是每次 prompt 都落一条空内容的 assistant 消息，看起来像"pi 跑不起来"，
 * 实际上是"模型用不了"。
 */
async function pickModel(runtime: { getAvailable(): Promise<readonly unknown[]> }): Promise<{
  model: unknown;
  provider: string | undefined;
  detail: string;
}> {
  const available = (await runtime.getAvailable()) as Array<{
    provider?: string;
    id?: string;
    name?: string;
  }>;
  if (available.length === 0) {
    return {
      model: undefined,
      provider: undefined,
      detail: "(没有任何可用模型：未配置任何 provider 的凭据)",
    };
  }
  for (const provider of PREFERRED_PROVIDERS) {
    const matches = available.filter((model) => model.provider === provider);
    if (matches.length === 0) continue;
    // 注意：这里只能拿到 pi 的可用列表顺序，拿不到 pi 内部的
    // defaultModelPerProvider（模块私有）。所以真正生效的模型由 alignModel() 决定：
    // 若 pi 自己解析出的 provider 就是 targetProvider，就沿用 pi 的选择。
    return {
      model: matches[0],
      provider,
      detail: `${matches.map((m) => m.id ?? m.name).join(", ")}（首选 ${provider}；共 ${available.length} 个可用）`,
    };
  }
  const first = available[0];
  return {
    model: first,
    provider: first.provider,
    detail: `${first.provider}/${first.id ?? first.name}（无首选 provider，取第一个）`,
  };
}

/**
 * 把会话的模型对齐到首选 provider。
 *
 * 为什么不直接在建会时指定 model：pi 内部有一张 defaultModelPerProvider 表
 * （bundle 里可见，但未导出），它才会挑出"该 provider 最合适的那个模型"
 * （实测 deepseek → `deepseek-v4-pro`，而可用列表第一个是 `flash`）。
 * 所以先让 pi 自己解析：
 *   - 它的 provider 就是首选 → 沿用（得到 pi 认为最好的那个模型）；
 *   - 否则（例如另一台只配了别的 provider 的机器上它选中了 `openai/gpt-5.5`）
 *     → 用 setModel 改成首选 provider 的模型。
 */
async function alignModel(
  host: SessionHost,
  targetProvider: string | undefined,
  preferredModel: unknown,
): Promise<string> {
  const session = host.session as unknown as {
    model?: { provider?: string; id?: string };
    setModel(model: unknown, options?: { persist?: boolean }): Promise<void>;
  };
  const piChoice = session.model;
  const piChoiceLabel = piChoice ? `${piChoice.provider}/${piChoice.id}` : "(none)";

  if (targetProvider === undefined) {
    return `无可用 provider，沿用 pi 的选择 ${piChoiceLabel}`;
  }
  if (piChoice?.provider === targetProvider) {
    return `${piChoiceLabel}（沿用 pi 的选择：provider 与首选一致）`;
  }
  if (preferredModel === undefined) {
    return `无法改模型：首选 provider ${targetProvider} 没有候选；pi 选的是 ${piChoiceLabel}`;
  }

  const preferred = preferredModel as { provider?: string; id?: string };
  await session.setModel(preferredModel, { persist: false });
  return `pi 选的是 ${piChoiceLabel} → 已改为 ${preferred.provider}/${preferred.id}（首选 provider ${targetProvider}）`;
}

/** 各项超时（毫秒）。 */
const TIMEOUTS: Record<string, number> = {
  T1: 5_000,
  T2: 30_000,
  T3: 60_000,
  T4: 60_000,
  T5a: 30_000,
  T5b: 30_000,
  T5c: 90_000,
  T6: 120_000,
  T7: 60_000,
  T8: 30_000,
  T9: 120_000,
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
function describeConfiguredProviders(runtime: {
  getProviders(): readonly { id: string }[];
  getProviderAuthStatus(providerId: string): unknown;
}): string {
  const configured = runtime
    .getProviders()
    .map((provider) => provider.id)
    .filter((id) => {
      const status = runtime.getProviderAuthStatus(id) as { configured?: boolean } | undefined;
      return status?.configured === true;
    });
  return configured.length > 0 ? configured.join(", ") : "(无)";
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
    const sessionDirR = join(this.tempRoot, "sessions-r");
    const sessionDirR2 = join(this.tempRoot, "sessions-r2");
    const fixtureDir = join(this.tempRoot, "fixture");
    const markerSession = join(this.tempRoot, "session-start.marker");
    const markerCommand = join(this.tempRoot, "command.marker");
    const markerWrite = join(this.tempRoot, "write.marker");
    for (const dir of [cwd, sessionDirR, sessionDirR2, fixtureDir]) {
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
      const chosen = await pickModel(modelRuntime);
      const modelDetail = chosen.detail;
      const targetProvider = chosen.provider;
      const preferredModel = chosen.model;
      this.sink.appendLine(`[selftest] 已配置的 provider: ${providerSummary}`);
      this.sink.appendLine(`[selftest] 首选 provider: ${targetProvider ?? "(无)"}；候选模型: ${modelDetail}`);

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
        writeProbe: {
          record: (toolCallId: string, absolutePath: string) => {
            appendFileSync(markerWrite, `${toolCallId}\t${absolutePath}\n`);
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
          const modelInfo = await alignModel(hostR, targetProvider, preferredModel);
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
    const [recordedId, recordedPath] = lastCall.split("\t");
    if (recordedId === undefined || recordedId.length === 0) {
      fail("E_TOOL_OVERRIDE", `标记内容缺少 toolCallId：${lastCall}`);
    }
    if (recordedPath !== target) {
      fail("E_TOOL_OVERRIDE", `记录路径 ${recordedPath} != ${target}`);
    }

    return `内容正确；patch ${String(patch).length} 字符；wrappedWrite 捕获 toolCallId=${recordedId}；model=${describeModel(session)}`;
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
