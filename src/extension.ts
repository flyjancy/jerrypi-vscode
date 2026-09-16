// jerrypi 扩展宿主入口。
//
// 本步骤的铁律：
//   1. 绝不静态 import pi —— pi 只能经 src/pi/loader.ts 动态加载（由 esbuild 守卫强制）；
//   2. activate() 不阻断扩展启动 —— pi-runtime 缺失时只写 Output，不弹窗、不抛错；
//      视图/provider 同步注册，pi 与建会话留到面板第一次要数据时（`controller.ensure()`）；
//   3. 用户可见的失败只发生在主动执行命令或打开面板时。
import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { ChatViewProvider, CHAT_VIEW_ID, registerChatView } from "./host/chatView";
import { createVSCodeUIContext } from "./host/uiContext";
import { loadPi, readRuntimeVersion } from "./pi/loader";
import { SessionHostController } from "./pi/controller";
import { createApiKeyStore } from "./pi/runtime";
import { createDiffPresenter } from "./host/diff";
import { workspaceCwd } from "./host/workspace";
import {
  applyAgentDirSetting,
  describeAgentDir,
  readAgentDirSetting,
  readApprovalModeSetting,
  registerAgentDirWatcher,
} from "./host/config";
import { createApprovalModeReader } from "./pi/approval";
import { createTrustPrompter } from "./host/trustPrompt";
import { DialogHost } from "./host/dialogHost";

const OUTPUT_CHANNEL_NAME = "jerrypi";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return outputChannel;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = getOutputChannel();

  // S6 第 1 步：**必须在任何 loadPi() 之前** —— pi 的 `getAgentDir()` 每次调用都读
  // `PI_CODING_AGENT_DIR`（无缓存），会话/凭据/模型目录全从它派生（S6-plan §3.1）。
  // 环境变量已由用户设过时不动它；改动设置需要重载窗口，所以这里只记一行带来源的日志。
  channel.appendLine(describeAgentDir(applyAgentDirSetting(readAgentDirSetting())));
  registerAgentDirWatcher(context);
  context.subscriptions.push(channel);
  const extensionPath = context.extensionUri.fsPath;
  const keys = createApiKeyStore(context);
  const { cwd, isWorkspace } = workspaceCwd();

  // 面板的会话主机：懒加载，第一次要数据时才真正加载 pi。
  //
  // S9 ①②：DialogHost 必须先于 `uiContext` 存在，且它的 post 要指向**后**创建的 provider
  // —— 所以这里用 `let provider` + 闭包（闭包只在对话框真的打开时才执行，远晚于 activate）。
  let provider: ChatViewProvider | undefined;
  const dialogHost = new DialogHost({
    post: (message) => provider?.post(message),
    announce: () => provider?.notifyDialogPending(),
    log: channel,
  });
  const controller = new SessionHostController({
    // 传加载器而不是句柄：activate() **不能**被 pi 的加载阻塞（S0-D3）。
    // controller.ensure() 在真正需要时才 await 它，失败也只影响面板。
    pi: () => loadPi(extensionPath),
    cwd,
    keys,
    uiContext: createVSCodeUIContext(channel, dialogHost),
    log: channel,
    onMessage: (message) => provider?.post(message),
    // S8：审批档位**每次工具调用现读**（machine scope 设置，改了不用重载窗口）；
    // 非法值只记一行 Output（R9）。
    approvalMode: createApprovalModeReader({ read: readApprovalModeSetting, log: channel }),
    // D6：会话替换成功后让面板**全量重放** —— 否则它会继续显示上一个会话的转写
    // （并且新消息的 `msg-<下标>` 会和旧内容撞号）。`provider` 在下面才赋值，
    // 但这个箭头只在替换发生时（远晚于 activate）才执行。
    onSessionReplaced: () => provider?.replay(),
    // S8：有工具调用在等确认 —— 面板可见就不打扰，不可见才弹通知（Q9/Q10 的宿主侧）
    onApprovalPending: () => provider?.notifyApprovalPending(),
    // S8：项目信任的问（原生模态 —— 这一问发生在 ensure() 里，用面板问会自锁，F16）
    askProjectTrust: createTrustPrompter({ log: channel }).ask,
  });
  context.subscriptions.push({ dispose: () => void controller.dispose() });
  if (!isWorkspace) {
    channel.appendLine(`[jerrypi] 没有打开工作区，会话 cwd 使用用户主目录：${cwd}`);
  }

  provider = registerChatView(context, {
    controller,
    extensionUri: context.extensionUri,
    output: channel,
    // S7：diff 的内容源是 controller 的 filechanges（切会话不丢），presenter 只负责
    // 虚拟文档与 `vscode.diff`。
    diff: createDiffPresenter(context, { store: controller.diffStore, log: channel }),
    dialogHost,
    // S9 ①②：面板内「设置 API key」入口要用的密钥存储（与命令层同一份）。
    keys,
  });

  registerCommands(context, channel, provider);

  context.subscriptions.push(
    vscode.commands.registerCommand("jerrypi.focusChat", () => {
      void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    }),
  );

  // 非阻断自检：把状态写进 Output，绝不打断扩展启动。
  void readRuntimeVersion(extensionPath).then((version) => {
    if (version === undefined) {
      channel.appendLine(
        "[jerrypi] pi-runtime 尚未同步。打包前请先运行 `npm run sync`（或 `npm run compile`）。",
      );
    } else {
      channel.appendLine(`[jerrypi] pi-runtime ${version} 已就绪。`);
    }
  });
}

export function deactivate(): void {
  // Output channel 与会话都已挂在 context.subscriptions 上。
}
