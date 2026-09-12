// jerrypi 扩展宿主入口。
//
// 本步骤的铁律：
//   1. 绝不静态 import pi —— pi 只能经 src/pi/loader.ts 动态加载（由 esbuild 守卫强制）；
//   2. activate() 不阻断扩展启动 —— pi-runtime 缺失时只写 Output，不弹窗、不抛错；
//   3. 用户可见的失败只发生在主动执行命令时。
import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { readRuntimeVersion } from "./pi/loader";

const COMMAND_ID = "jerrypi.focusChat";
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

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, async () => {
      const version = await readRuntimeVersion(extensionPath);
      if (version === undefined) {
        void vscode.window.showErrorMessage(
          "jerrypi: pi-runtime 未同步，请运行 npm run sync 后重载窗口",
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `jerrypi: pi-runtime ${version} 就绪（聊天 UI 将在 S2 实现）`,
      );
    }),
  );

  registerCommands(context, channel);

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
  // Output channel 已挂在 context.subscriptions 上；会话由命令/自测自行 dispose。
}
