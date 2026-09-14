// VS Code 配置层：三项 `jerrypi.*` 设置的**读取**与**生效**。
//
// 为什么单独一个文件、且必须由 `activate()` **最开头**调用（`docs/S6-plan.md` §3.1）：
//
//   1. `pi.getAgentDir()` 每次调用都读 `process.env.PI_CODING_AGENT_DIR`
//      （`dist/config.js`，**没有缓存**），其余路径全从它派生（sessions / auth.json /
//      models.json / settings.json / tools / themes …）。所以想让 `jerrypi.agentDir`
//      对 **pi 自己**也生效，唯一办法就是在**任何 `loadPi()` 之前**把环境变量设好。
//   2. 这是**进程级**副作用（扩展宿主是共享进程）—— 所以只在环境变量**未设**时写：
//      用户在 shell 里设过 `PI_CODING_AGENT_DIR` 时，那是他对"整台机器的 pi"的选择，
//      比 VS Code 设置更宽，不覆盖（与 pi 自己的 `applyHttpProxySettings` 同一个 `??=` 惯用法）。
//   3. 改设置**不能热切换**（我们的 runtime 按 agentDir 缓存，pi 模块内部也在首次 import
//      时建立了与目录相关的状态）→ 只能提示重载窗口。
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

/** pi 认的环境变量名（`dist/config.js` 的 `ENV_AGENT_DIR`）。 */
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
/** 三项设置（`contributes.configuration` 与 README 的配置表都用这三个 id）。 */
export const AGENT_DIR_SETTING = "jerrypi.agentDir";
export const PROXY_SETTING = "jerrypi.proxy";
export const APPROVAL_MODE_SETTING = "jerrypi.approvalMode";

/** 生效的 agentDir 从哪来（Output 里会打这一行，用户据此判断"为什么没变"）。 */
export type AgentDirSource = "env" | "setting" | "default";

/** pi 的默认目录：`join(homedir(), CONFIG_DIR_NAME, "agent")`（`dist/config.js`）。 */
export const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");

/** 一次"agentDir 该用哪个"的裁决结果。 */
export interface AgentDirDecision {
  source: AgentDirSource;
  /** 生效的目录。`default` 时是我们按 pi 的规则算出来的（权威值仍在 pi 那边）。 */
  dir: string;
}

const SOURCE_LABEL: Record<AgentDirSource, string> = {
  env: "环境变量",
  setting: "设置",
  default: "默认",
};

/**
 * 把 `jerrypi.agentDir` 落到进程环境变量上。
 *
 * 纯函数（`env` 可注入）—— 断言不需要碰真的 `process.env`，也就不会污染同进程的
 * 其他断言（`docs/S6-plan.md` §6 的 N5）。
 *
 * 返回**生效来源**：`env`（环境变量本来就设了，我们没动）、`setting`（我们写进去的）、
 * `default`（设置为空 → 交给 pi 的默认 `~/.pi/agent`）。
 */
export function applyAgentDirSetting(
  configuredValue: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentDirDecision {
  const existing = (env[ENV_AGENT_DIR] ?? "").trim();
  if (existing.length > 0) return { source: "env", dir: existing };
  const wanted = configuredValue.trim();
  if (wanted.length === 0) return { source: "default", dir: DEFAULT_AGENT_DIR };
  env[ENV_AGENT_DIR] = wanted;
  return { source: "setting", dir: wanted };
}

/** 读设置值（唯一读 vscode 的地方，薄到不需要断言）。 */
export function readAgentDirSetting(): string {
  return vscode.workspace.getConfiguration("jerrypi").get<string>(AGENT_DIR_SETTING, "");
}

/** 读另外两项（S6 只登记，见 §2/§3.4）。 */
export function readProxySetting(): string {
  return vscode.workspace.getConfiguration("jerrypi").get<string>(PROXY_SETTING, "");
}

export function readApprovalModeSetting(): string {
  return vscode.workspace.getConfiguration("jerrypi").get<string>(APPROVAL_MODE_SETTING, "off");
}

/** 给 Output 写一行"生效的 agentDir + 来源"（M1 的判据就是这一行）。 */
export function describeAgentDir(decision: AgentDirDecision): string {
  return `[jerrypi] agentDir=${decision.dir}（来源：${SOURCE_LABEL[decision.source]}）`;
}

/** 「重载窗口」按钮的文案（`executeCommand("workbench.action.reloadWindow")` 的触发器）。 */
export const RELOAD_ITEM = "重载窗口";

/**
 * agentDir 变了之后做的事：弹**一次**信息消息（带「重载窗口」按钮），用户点了才重载。
 *
 * 刻意不强制：用户可能正开着别的窗口，替人重载是意外行为。返回"用户是否点了重载"。
 */
export async function notifyAgentDirChanged(): Promise<boolean> {
  const picked = await vscode.window.showInformationMessage(
    `jerrypi: 已改 ${AGENT_DIR_SETTING}。pi 的会话、模型与设置都跟着这个目录走，需要「重载窗口」才生效。`,
    RELOAD_ITEM,
  );
  if (picked !== RELOAD_ITEM) return false;
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
  return true;
}

/**
 * 监听 `jerrypi.agentDir` 的变更 → 提示重载。
 *
 * 只认这一项：另外两项不涉及进程级状态（`approvalMode` 还没实现、`proxy` 见 §3.4），
 * 改了不需要重载。
 */
export function registerAgentDirWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(AGENT_DIR_SETTING)) return;
      await notifyAgentDirChanged();
    }),
  );
}
