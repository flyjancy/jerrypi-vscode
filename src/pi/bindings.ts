// 把 pi 会话接到宿主（S1 只写 Output；S2 起在这里转发协议消息）。
//
// ⚠️ 本文件**不得**运行时 import vscode：`src/pi/session.ts` 值导入 `bindSession`，
// 一旦这里有 vscode，整个 src/pi 层就无法在纯 Node 里跑（S1 留下的快速迭代通道）。
// 需要 VS Code 的东西放 `src/host/`。
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionCommandContextActions,
  ExtensionError,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

/**
 * `ExtensionMode` 并没有从包根导出（它只存在于 dist/core/extensions），
 * 所以从 bindExtensions 的入参里推导，避免写死字符串联合。
 */
export type RuntimeMode = NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["mode"]>;

/** Output 之类的最小输出出口。 */
export interface EventSink {
  appendLine(message: string): void;
}

export interface SessionBindingOptions {
  uiContext: ExtensionUIContext;
  mode: RuntimeMode;
  sink: EventSink;
  commandContextActions: ExtensionCommandContextActions;
  /** 自测用它收集事件（如 T4 的 text_delta、T5c 的 tool_execution_update）。 */
  onEvent?: (event: AgentSessionEvent) => void;
  /** 收集扩展错误（如 T3 的 `/smoke-custom` 可控错误）。 */
  onExtensionError?: (error: ExtensionError) => void;
}

export interface SessionBinding {
  unsubscribe(): void;
}

/**
 * 绑定一个会话：`bindExtensions()` + `subscribe()`。
 *
 * 注意语义：本函数只负责**一个**会话。会话替换（`newSession`/`switchSession`/`fork`）
 * 之后必须重新调用——由 `session.ts` 经 `runtime.setRebindSession()` 统一处理。
 */
export async function bindSession(
  session: AgentSession,
  options: SessionBindingOptions,
): Promise<SessionBinding> {
  await session.bindExtensions({
    uiContext: options.uiContext,
    mode: options.mode,
    abortHandler: () => {
      void session.abort();
    },
    onError: (error) => {
      options.sink.appendLine(
        `[extension error] ${error.extensionPath} @${error.event}: ${error.error}`,
      );
      options.onExtensionError?.(error);
    },
    commandContextActions: options.commandContextActions,
  });

  const unsubscribe = session.subscribe((event) => {
    const summary = describeEvent(event);
    if (summary !== undefined) {
      options.sink.appendLine(summary);
    }
    options.onEvent?.(event);
  });

  return { unsubscribe };
}

/** 只记录对诊断有用的少数事件，避免 Output 被刷屏。 */
function describeEvent(event: AgentSessionEvent): string | undefined {
  switch (event.type) {
    case "agent_start":
      return "[agent] start";
    case "agent_end":
      return "[agent] end";
    case "tool_execution_end": {
      const name = (event as { toolName?: string }).toolName ?? "?";
      return `[tool] ${name} end`;
    }
    default:
      return undefined;
  }
}
