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
import { workspaceCwd } from "./host/workspace";

const OUTPUT_CHANNEL_NAME = "jerrypi";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return outputChannel;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = getOutputChannel();
  context.subscriptions.push(channel);
  const extensionPath = context.extensionUri.fsPath;
  const keys = createApiKeyStore(context);
  const { cwd, isWorkspace } = workspaceCwd();

  // 面板的会话主机：懒加载，第一次要数据时才真正加载 pi。
  const controller = new SessionHostController({
    // 传加载器而不是句柄：activate() **不能**被 pi 的加载阻塞（S0-D3）。
    // controller.ensure() 在真正需要时才 await 它，失败也只影响面板。
    pi: () => loadPi(extensionPath),
    cwd,
    keys,
    uiContext: createVSCodeUIContext(channel),
    log: channel,
    onMessage: (message) => provider.post(message),
    // D6：会话替换成功后让面板**全量重放** —— 否则它会继续显示上一个会话的转写
    // （并且新消息的 `msg-<下标>` 会和旧内容撞号）。`provider` 在下面才赋值，
    // 但这个箭头只在替换发生时（远晚于 activate）才执行。
    onSessionReplaced: () => provider.replay(),
  });
  context.subscriptions.push({ dispose: () => void controller.dispose() });
  if (!isWorkspace) {
    channel.appendLine(`[jerrypi] 没有打开工作区，会话 cwd 使用用户主目录：${cwd}`);
  }

  const provider: ChatViewProvider = registerChatView(context, {
    controller,
    extensionUri: context.extensionUri,
    output: channel,
  });

  registerCommands(context, channel, controller, provider);

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
