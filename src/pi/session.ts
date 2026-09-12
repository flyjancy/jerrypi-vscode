// 会话装配：完全照 pi 官方 SDK 文档的生产路径，不自创。
//
//   createAgentSessionServices（cwd-bound 服务）
//     → createAgentSessionFromServices（会话）
//     → createAgentSessionRuntime（可替换会话的宿主）
//
// 两个容易漏的点（都来自评审，且已对着 pi 源码核实）：
//
//   1. `setRebindSession` 注册的回调**只在会话替换时触发**（pi 在
//      finishSessionReplacement() 里调它）。首个会话必须**再显式绑定一次**，
//      否则它既没有 bindExtensions 也没有 subscribe —— 表现为 session_start
//      不触发、扩展 onError 不通、事件一个都收不到。
//   2. 工厂必须使用**传进来**的 cwd / agentDir（switchSession({cwdOverride}) 时
//      闭包里的值会错），customTools 也在工厂内按该 cwd 构造。
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionError,
  ExtensionUIContext,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { bindSession, type EventSink, type RuntimeMode, type SessionBinding } from "./bindings";
import { createCustomTools, type WriteProbe } from "./custom-tools";
import type { PiModule } from "./loader";
import { getModelRuntime, type ApiKeyStore } from "./runtime";

export interface SessionHostOptions {
  pi: PiModule;
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  keys: ApiKeyStore;
  uiContext: ExtensionUIContext;
  mode: RuntimeMode;
  sink: EventSink;
  additionalExtensionPaths?: string[];
  writeProbe?: WriteProbe;
  /**
   * 是否信任工作区里的项目级设置。
   *
   * **默认 false**（S1-D11）：不传 settingsManager 时 pi 会用 `projectTrusted ?? true`，
   * 即无条件信任工作区里的 `.pi/settings.json` —— 那里面能改 shellPath 和默认工具。
   * 与 pi CLI 行为刻意不同，已记入 README 已知限制；信任 UI 留到 S6。
   */
  projectTrusted?: boolean;
  onEvent?: (event: AgentSessionEvent) => void;
  onExtensionError?: (error: ExtensionError) => void;
}

export interface SessionHost {
  readonly runtime: AgentSessionRuntime;
  readonly session: AgentSession;
  /** 手动重新绑定当前会话（一般不需要——替换时会自动触发）。 */
  refresh(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createSessionHost(options: SessionHostOptions): Promise<SessionHost> {
  const { pi } = options;
  const projectTrusted = options.projectTrusted ?? false;

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: pi.SettingsManager.create(cwd, agentDir, { projectTrusted }),
      modelRuntime: await getModelRuntime(pi, agentDir, options.keys),
      resourceLoaderOptions: {
        additionalExtensionPaths: options.additionalExtensionPaths,
      },
    });

    const customTools: ToolDefinition[] = createCustomTools(pi, cwd, options.writeProbe);

    const created = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      customTools,
    });

    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });

  let binding: SessionBinding | undefined;

  const rebind = async (session: AgentSession): Promise<void> => {
    binding?.unsubscribe();
    binding = undefined;
    binding = await bindSession(session, {
      uiContext: options.uiContext,
      mode: options.mode,
      sink: options.sink,
      onEvent: options.onEvent,
      onExtensionError: options.onExtensionError,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (newSessionOptions) => runtime.newSession(newSessionOptions),
        fork: async (entryId, forkOptions) => ({
          cancelled: (await runtime.fork(entryId, forkOptions)).cancelled,
        }),
        navigateTree: (targetId, treeOptions) => session.navigateTree(targetId, treeOptions),
        switchSession: (sessionPath, switchOptions) =>
          runtime.switchSession(sessionPath, switchOptions),
        reload: async () => {
          await session.reload();
        },
      },
    });
  };

  runtime.setRebindSession(async (session) => {
    await rebind(session);
  });
  // 首个会话必须显式绑定一次（见文件头注释 1）。
  await rebind(runtime.session);

  return {
    runtime,
    get session() {
      return runtime.session;
    },
    refresh: () => rebind(runtime.session),
    async dispose() {
      binding?.unsubscribe();
      binding = undefined;
      await runtime.dispose();
    },
  };
}
