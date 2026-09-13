// S1 的三条命令。
//
// 命令标题**不含** `Pi:` 前缀 —— category 会渲染成 `Pi: `，
// 写成 title: "Pi: Run Self-Test" 会显示成 "Pi: Pi: Run Self-Test"。
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { loadPi } from "./pi/loader";
import { createApiKeyStore, DEFAULT_PROVIDER, injectApiKey, SUGGESTED_PROVIDERS } from "./pi/runtime";
import { runSelfTest } from "./pi/selftest";
import { workspaceCwd } from "./host/workspace";

const CUSTOM_PROVIDER = "其他（手动输入 provider id）";

/** 选择器入口（由 ChatViewProvider 提供；命令面板与面板点击共用同一套逻辑）。 */
export interface PickerCommands {
  runModelPicker(fromPanel: boolean): Promise<void>;
  runThinkingPicker(fromPanel: boolean): Promise<void>;
  /** `Pi: New Session`（忙时弹确认的逻辑只在 ChatViewProvider 一处）。 */
  runNewSession(): Promise<void>;
  /** `Pi: Resume Session`。 */
  runSessionPicker(fromPanel: boolean): Promise<void>;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  pickers?: PickerCommands,
): void {
  const extensionPath = context.extensionUri.fsPath;
  const keys = createApiKeyStore(context);
  const pi = () => loadPi(extensionPath);

  context.subscriptions.push(
    vscode.commands.registerCommand("jerrypi.runSelfTest", async () => {
      output.show(true);
      try {
        const module = await pi();
        const gate = await runSelfTest({
          pi: module,
          extensionPath,
          // 必须取自扩展元数据：硬编码就失去"核对跑的是不是发布版"的意义
          extensionVersion: String(context.extension.packageJSON.version ?? "0.0.0"),
          vscodeVersion: vscode.version,
          agentDir: module.getAgentDir(),
          // T10/T11/T12 必需：它们对比的是"真实 cwd 的会话目录"，见 SelfTestOptions.cwd 的注释
          cwd: workspaceCwd().cwd,
          keys,
          sink: output,
        });
        if (gate === "GATE PASS") {
          void vscode.window.showInformationMessage("jerrypi: GATE PASS");
        } else {
          void vscode.window.showWarningMessage(`jerrypi: ${gate}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] 自测无法开始：${message}`);
        void vscode.window.showErrorMessage(`jerrypi: 自测无法开始：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.setApiKey", async () => {
      try {
        const picked = await vscode.window.showQuickPick(
          [
            { label: DEFAULT_PROVIDER, description: "默认" },
            ...SUGGESTED_PROVIDERS.filter((id) => id !== DEFAULT_PROVIDER).map((id) => ({ label: id })),
            { label: CUSTOM_PROVIDER },
          ],
          { title: "jerrypi: 选择 provider", ignoreFocusOut: true },
        );
        if (picked === undefined) return;

        let providerId = picked.label;
        if (providerId === CUSTOM_PROVIDER) {
          const typed = await vscode.window.showInputBox({
            title: "jerrypi: provider id",
            placeHolder: "例如 deepseek",
            ignoreFocusOut: true,
          });
          if (typed === undefined || typed.trim().length === 0) return;
          providerId = typed.trim();
        }

        const apiKey = await vscode.window.showInputBox({
          title: `jerrypi: ${providerId} API key`,
          password: true,
          ignoreFocusOut: true,
        });
        if (apiKey === undefined || apiKey.trim().length === 0) return;
        const trimmed = apiKey.trim();

        await keys.saveApiKey(providerId, trimmed);
        const module = await pi();
        // 关键：pi 的 setRuntimeApiKey 只写内存，重载窗口即丢。
        // 所以除了"创建时注入"，这里还要把 key 注入**已经缓存的那个实例**，
        // 否则用户设完 key 必须重载窗口才生效——而重载又会丢掉刚设的值。
        await injectApiKey(module, module.getAgentDir(), keys, providerId, trimmed);

        void vscode.window.showInformationMessage(
          `jerrypi: 已保存 ${providerId} 的 API key（VS Code SecretStorage，不写入 auth.json）`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`jerrypi: 保存 API key 失败：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.selectModel", async () => {
      // 从命令面板发起：`fromPanel: false` —— 用户的焦点可能在编辑器里，**不要抢**。
      await pickers?.runModelPicker(false);
    }),

    vscode.commands.registerCommand("jerrypi.selectThinkingLevel", async () => {
      await pickers?.runThinkingPicker(false);
    }),

    vscode.commands.registerCommand("jerrypi.newSession", async () => {
      if (pickers === undefined) return;
      try {
        // S5（D7）：忙时先问一句 —— 弹窗与文案在 ChatViewProvider（它拿得到 `vscode.window`），
        // controller 只负责返回"忙"这个事实。
        await pickers.runNewSession();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`jerrypi: 新建会话失败：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.resumeSession", async () => {
      if (pickers === undefined) return;
      try {
        // 从命令面板发起：`fromPanel: false` —— 用户的焦点可能在编辑器里，不要抢。
        await pickers.runSessionPicker(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`jerrypi: 打开会话列表失败：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.openSettingsFile", async () => {
      try {
        const module = await pi();
        const agentDir = module.getAgentDir();
        const file = join(agentDir, "settings.json");
        if (!existsSync(file)) {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(agentDir));
          await writeFile(file, "{}\n", "utf8");
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(document);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`jerrypi: 打开设置文件失败：${message}`);
      }
    }),
  );

  output.appendLine(`[jerrypi] 已注册命令：${String(context.extension.packageJSON.version ?? "?")}`);
}
