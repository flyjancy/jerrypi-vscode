// S1 的三条命令。
//
// 命令标题**不含** `Pi:` 前缀 —— category 会渲染成 `Pi: `，
// 写成 title: "Pi: Run Self-Test" 会显示成 "Pi: Pi: Run Self-Test"。
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { loadPi } from "./pi/loader";
import { clearStoredApiKeys, createApiKeyStore, DEFAULT_PROVIDER, getModelRuntime, injectApiKey, refreshModelCatalog } from "./pi/runtime";
import { describeAuthSource } from "./shared/format";
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
          // T13（advisory）：只在宿主侧取 http.* 的值（selftest 不 import vscode）
          httpProxyConfig: (() => {
            const http = vscode.workspace.getConfiguration("http");
            return { proxySupport: String(http.get("proxySupport") ?? "(未设)"), proxy: http.get<string>("proxy") };
          })(),
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
        const module = await pi();
        const agentDir = module.getAgentDir();
        const runtime = await getModelRuntime(module, agentDir, keys);
        // 候选来自 **pi 自己**（不是硬编码清单），每项标注来源（6 档，F18/§3.3）
        const known = runtime.getProviders().map((provider) => ({
          label: provider.id,
          description: `${provider.name === provider.id ? "" : `${provider.name} · `}${describeAuthSource(runtime.getProviderAuthStatus(provider.id).source)}`,
        }));
        const ordered = [
          ...known.filter((item) => item.label === DEFAULT_PROVIDER),
          ...known.filter((item) => item.label !== DEFAULT_PROVIDER),
        ];
        const picked = await vscode.window.showQuickPick(
          [...ordered, { label: CUSTOM_PROVIDER, description: "pi 不认识的 provider id（例如 models.json 里自定义的）" }],
          { title: `jerrypi: 选择 provider（pi 认识 ${known.length} 个）`, ignoreFocusOut: true },
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
          if (runtime.getProvider(providerId) === undefined) {
            // 本地判定：pi 不认识它 —— 允许继续（用户可能在 models.json 里自定义），但要说清后果
            void vscode.window.showWarningMessage(
              `jerrypi: pi 不认识 provider "${providerId}" —— 模型列表可能是空的，除非你在 models.json 里定义过它。`,
            );
          }
        }

        const apiKey = await vscode.window.showInputBox({
          title: `jerrypi: ${providerId} API key`,
          password: true,
          ignoreFocusOut: true,
        });
        if (apiKey === undefined || apiKey.trim().length === 0) return;
        const trimmed = apiKey.trim();

        await keys.saveApiKey(providerId, trimmed);
        // 关键：pi 的 setRuntimeApiKey 只写内存，重载窗口即丢。
        // 所以除了"创建时注入"，这里还要把 key 注入**已经缓存的那个实例**，
        // 否则用户设完 key 必须重载窗口才生效——而重载又会丢掉刚设的值。
        await injectApiKey(module, module.getAgentDir(), keys, providerId, trimmed);

        // 本地校验（Q3：**不发请求、不花钱**）：① 凭据解析得出来吗 ② pi 的目录里它有没有模型
        const check = await runtime.checkAuth(providerId);
        const available = await runtime.getAvailable(providerId);
        if (check === undefined) {
          void vscode.window.showWarningMessage(
            `jerrypi: 已保存 ${providerId} 的 key，但这个 provider 不接受 API key（pi 侧未配置成功）—— 检查 provider id 是否正确。`,
          );
        } else if (available.length === 0) {
          void vscode.window.showWarningMessage(
            `jerrypi: 已保存 ${providerId} 的 key，但 pi 的模型目录里这个 provider 没有可用模型 —— 生效的配置目录是 ${agentDir}（provider id 拼错、models.json 里没有它、或 jerrypi.agentDir 指错了都会这样）。`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `jerrypi: 已保存 ${providerId} 的 API key（VS Code SecretStorage —— 你的 key 不会写进 auth.json）—— pi 目录里有 ${available.length} 个可用模型。`,
          );
        }
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

    // S6：清掉**我们存的** key（绝不用 `logout()` —— 那会删 auth.json 里用户自己的凭据）
    vscode.commands.registerCommand("jerrypi.clearStoredApiKeys", async () => {
      try {
        const providers = keys.listProviders();
        if (providers.length === 0) {
          void vscode.window.showInformationMessage("jerrypi: 没有面板保存的 API key（pi 自己的 auth.json / models.json 不归本扩展管）。");
          return;
        }
        const pickedItems = await vscode.window.showQuickPick(
          providers.map((providerId) => ({ label: providerId })),
          { title: `jerrypi: 选择要清除的 key（共 ${providers.length} 个）`, canPickMany: true, ignoreFocusOut: true },
        );
        if (pickedItems === undefined || pickedItems.length === 0) return;

        const confirmed = await vscode.window.showWarningMessage(
          `将从 VS Code SecretStorage 删除 ${pickedItems.length} 个 provider 的 key。**当前会话将无法继续发送**，直到重新设置 key（pi 的 auth.json / models.json 不受影响）。继续吗？`,
          { modal: true },
          "清除",
        );
        if (confirmed !== "清除") return;

        const module = await pi();
        const agentDir = module.getAgentDir();
        const runtime = await getModelRuntime(module, agentDir, keys);
        const result = await clearStoredApiKeys(pickedItems.map((item) => item.label), { keys, runtime });

        if (result.failed.length === 0) {
          void vscode.window.showInformationMessage(`jerrypi: 已清除 ${result.ok.length} 个 provider 的 key。`);
        } else {
          void vscode.window.showWarningMessage(
            `jerrypi: 清除了 ${result.ok.length} 个；${result.failed.length} 个失败 —— ${result.failed.map((f) => `${f.providerId}: ${f.reason}`).join("；")}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`jerrypi: 清除 key 失败：${message}`);
      }
    }),

    // S6 §3.5：显式联网刷新模型目录 —— 这是"只有用户点它才发请求"的**唯一**入口
    vscode.commands.registerCommand("jerrypi.refreshModelCatalog", async () => {
      try {
        const module = await pi();
        const runtime = await getModelRuntime(module, module.getAgentDir(), keys);
        output.appendLine("[jerrypi] 刷新模型目录（显式联网）…");
        const result = await refreshModelCatalog(runtime);
        for (const error of result.errors) {
          output.appendLine(`[jerrypi] 模型目录刷新失败：${error.providerId}: ${error.reason}`);
        }
        const summary = `provider ${result.providersBefore} → ${result.providersAfter}，可用模型 ${result.modelsBefore} → ${result.modelsAfter}`;
        if (result.errors.length === 0) {
          void vscode.window.showInformationMessage(`jerrypi: 模型目录已刷新 —— ${summary}。`);
        } else {
          const names = result.errors.map((error) => error.providerId).join("、");
          void vscode.window.showWarningMessage(
            `jerrypi: 模型目录刷新完成（${result.errors.length} 个 provider 失败：${names}）—— ${summary}；细节见 Output。`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`jerrypi: 刷新模型目录失败：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.openSettingsFile", async () => {
      try {
        const module = await pi();
        const agentDir = module.getAgentDir();
        const file = join(agentDir, "settings.json");
        if (!existsSync(agentDir)) {
          // S6 §3.6（评审 N6）：**不要替用户把目录建出来** —— 用户把 `jerrypi.agentDir`
          // 拼错时，旧代码会替他在那个拼错的路径上创建一个目录。
          // 创建这个目录的是 **pi**，时机是写第一个会话时（`session-manager.js:603`）。
          void vscode.window.showWarningMessage(
            `jerrypi: ${agentDir} 还不存在 —— 发一条消息后 pi 会建出来；如果不是你要的路径，检查 jerrypi.agentDir。`,
          );
          return;
        }
        if (!existsSync(file)) {
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
