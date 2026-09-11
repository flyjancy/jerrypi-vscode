// jerrypi 扩展宿主入口（S0：只有脚手架，不含任何 pi 功能）。
//
// 本步骤的铁律：
//   1. 绝不静态 import pi —— pi 只能通过 `pi-runtime/` 动态加载（S1 的 loader.ts）；
//   2. activate() 不阻断扩展启动 —— pi-runtime 缺失时只写 Output，不弹窗、不抛错；
//   3. 用户可见的失败只发生在主动执行命令时。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

const RUNTIME_DIR = "pi-runtime";
const VERSION_FILE = ".version";
const COMMAND_ID = "jerrypi.focusChat";
const OUTPUT_CHANNEL_NAME = "jerrypi";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return outputChannel;
}

/** 读取 pi-runtime/.version；文件缺失或为空时返回 undefined。 */
async function readRuntimeVersion(extensionUri: vscode.Uri): Promise<string | undefined> {
  try {
    const raw = await readFile(join(extensionUri.fsPath, RUNTIME_DIR, VERSION_FILE), "utf8");
    const version = raw.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = getOutputChannel();
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, async () => {
      const version = await readRuntimeVersion(context.extensionUri);
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

  // 非阻断自检：把状态写进 Output，绝不打断扩展启动。
  void readRuntimeVersion(context.extensionUri).then((version) => {
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
  // S0 没有需要释放的资源：Output channel 已挂在 context.subscriptions 上。
}
