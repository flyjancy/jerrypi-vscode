// S1 的三条命令。
//
// 命令标题**不含** `Pi:` 前缀 —— category 会渲染成 `Pi: `，
// 写成 title: "Pi: Run Self-Test" 会显示成 "Pi: Pi: Run Self-Test"。
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { loadPi } from "./pi/loader";
import type { PiModule } from "./pi/loader";
import { describePackage, installPackage, listPackages, removePackage, settingsPathOf } from "./pi/packages";
import { clearStoredApiKeys, createApiKeyStore, DEFAULT_PROVIDER, getModelRuntime, injectApiKey, refreshModelCatalog } from "./pi/runtime";
import { describeAuthSource } from "./shared/format";
import { runSelfTest } from "./pi/selftest";
import { workspaceCwd } from "./host/workspace";
import {
  applyTrustAction,
  TRUST_ACTION_LABELS,
  TRUST_ACTIONS,
  trustParentOf,
  type TrustAction,
} from "./pi/trust";
import type { TrustMemoLike } from "./pi/trust";

const CUSTOM_PROVIDER = "其他（手动输入 provider id）";

/** 包管理命令共用的依赖（`agentDir` 一律取自生效的 pi 目录，与「打开设置文件」同一套）。 */
function packageDeps(module: PiModule, cwd: string) {
  return { pi: module, cwd, agentDir: module.getAgentDir() };
}

/** 装完之后的话术：**必须**告诉用户怎么让它生效（C2/R2）—— 我们不热重载（Q3）。 */
function installedMessage(source: string, settingsPath: string): string {
  return `已安装 ${source}（写进 ${settingsPath}）—— 新建会话（或重载窗口）后生效`;
}

async function runInstall(
  module: PiModule,
  source: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const { cwd } = workspaceCwd();
  const deps = packageDeps(module, cwd);
  const outcome = await installPackage(deps, source);
  if (!outcome.ok) {
    output.appendLine(`[packages] 安装失败 ${source}：${outcome.message}`);
    void vscode.window.showWarningMessage(
      `jerrypi: 安装 ${source} 失败 —— ${outcome.message.split("\n")[0]}（细节见 Output）`,
    );
    return;
  }
  const settingsPath = settingsPathOf(deps);
  const message = outcome.changed
    ? installedMessage(source, settingsPath)
    : `${source} 已经在配置里了（未改动；${settingsPath}）`;
  output.appendLine(`[packages] ${message}`);
  void vscode.window.showInformationMessage(`jerrypi: ${message}`);
}

/** 选择器入口（由 ChatViewProvider 提供；命令面板与面板点击共用同一套逻辑）。 */
export interface PickerCommands {
  runModelPicker(fromPanel: boolean): Promise<void>;
  runThinkingPicker(fromPanel: boolean): Promise<void>;
  /** `Pi: New Session`（忙时弹确认的逻辑只在 ChatViewProvider 一处）。 */
  runNewSession(): Promise<void>;
  /** `Pi: Resume Session`。 */
  runSessionPicker(fromPanel: boolean): Promise<void>;
  /** S8：`Pi: Project Trust…` 改判之后要读写的那个本进程缓存。 */
  trustMemo(): TrustMemoLike;
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

    // S8：项目信任的"改判"入口。
    //
    // 为什么需要它（Q5/Q6）：面板只写 `true`、从不写 `false`（免得一个误点变成"永不再问"），
    // 但 pi CLI **会**写 false，而用户也可能想撤销自己刚才的"记住"。没有这个入口，
    // 唯一办法就是手改 `<agentDir>/trust.json` —— 那是替用户干他的活。
    vscode.commands.registerCommand("jerrypi.projectTrust", async () => {
      const { cwd } = workspaceCwd();
      let module;
      try {
        module = await pi();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`[trust] 加载 pi 失败：${text}`);
        void vscode.window.showErrorMessage(`jerrypi: 项目信任需要先同步 pi-runtime（${text}）`);
        return;
      }
      const agentDir = module.getAgentDir();
      const store = new module.ProjectTrustStore(agentDir);
      const current = store.get(cwd);
      const parent = trustParentOf(cwd);
      const picked = await vscode.window.showQuickPick(
        TRUST_ACTIONS.map((action) => ({
          label: TRUST_ACTION_LABELS[action],
          description:
            action === "trust-parent"
              ? (parent ?? "（已在根目录，没有父文件夹）")
              : action === "clear"
                ? `当前记录：${current === null ? "没有" : current ? "信任" : "不信任"}`
                : action.startsWith("trust") && current !== null
                  ? "（当前已有记录）"
                  : undefined,
          action,
        })),
        {
          title: `项目信任：${cwd}`,
          placeHolder: "选择这次要怎么处理这个文件夹的 pi 项目级资源",
        },
      );
      if (picked === undefined) return;
      const message = applyTrustAction(picked.action as TrustAction, {
        cwd,
        trustStore: store,
        memo: pickers?.trustMemo() ?? new Map(),
        log: output,
      });
      output.appendLine(`[trust] trust.json=${join(agentDir, "trust.json")}｜cwd=${cwd}`);
      void vscode.window.showInformationMessage(`jerrypi: ${message}`);
    }),

    // S9：pi 包管理（装 / 装（文件夹）/ 列 / 卸）。
    //
    // 输入框与 QuickPick 都由宿主侧弹（与 `Pi: Project Trust…` 一致），**不经过 webview**
    // ⇒ 协议不用改（S9-plan §3.2）。装/卸之后**不热重载**（Q3）：`session.reload()` 不重裁决
    // 项目信任（F34），统一走“新建会话”（F36）—— 所以这几条命令与会话宿主的接触面是**零**。
    vscode.commands.registerCommand("jerrypi.installPackage", async () => {
      try {
        const module = await pi();
        const source = await vscode.window.showInputBox({
          title: "jerrypi: 安装 pi 包",
          prompt: "本地文件夹（绝对路径）、npm: 包名，或 git URL",
          placeHolder: "/path/to/my-pi-package ｜ npm:@scope/pkg ｜ https://github.com/user/repo",
          ignoreFocusOut: true,
        });
        if (source === undefined || source.trim().length === 0) return;
        await runInstall(module, source.trim(), output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[packages] 安装失败：${message}`);
        void vscode.window.showErrorMessage(`jerrypi: 安装包失败：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.installPackageFromFolder", async () => {
      try {
        const module = await pi();
        const picked = await vscode.window.showOpenDialog({
          title: "jerrypi: 选择包文件夹",
          openLabel: "安装这个文件夹里的 pi 包",
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
        });
        const folder = picked?.[0];
        if (folder === undefined) return;
        // `uri.fsPath`（**不是** `uri.toString()` —— 那会给出 `file:///…`，pi 认不出来）
        await runInstall(module, folder.fsPath, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[packages] 安装失败：${message}`);
        void vscode.window.showErrorMessage(`jerrypi: 安装包失败：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.listPackages", async () => {
      try {
        const module = await pi();
        const deps = packageDeps(module, workspaceCwd().cwd);
        const entries = listPackages(deps);
        if (entries.length === 0) {
          void vscode.window.showInformationMessage(
            `jerrypi: 没有配置任何包（${settingsPathOf(deps)} 里没有 packages 条目）。`,
          );
          return;
        }
        // 只读：选中不做事（每一项已经把源 / 作用域 / 解析后的路径写在行里了）
        await vscode.window.showQuickPick(entries.map(describePackage), {
          title: `jerrypi: 已配置 ${entries.length} 个包（新建会话后生效）`,
          matchOnDetail: true,
          ignoreFocusOut: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[packages] 列出包失败：${message}`);
        void vscode.window.showErrorMessage(`jerrypi: 列出包失败：${message}`);
      }
    }),

    vscode.commands.registerCommand("jerrypi.removePackage", async () => {
      try {
        const module = await pi();
        const deps = packageDeps(module, workspaceCwd().cwd);
        // 候选只列 **user 作用域**：删除固定写 user，若两边都有同名源，选 project 那行
        // 会删错对象（B5）。
        const candidates = listPackages(deps)
          .filter((entry) => entry.scope === "user")
          .map((entry) => ({ ...describePackage(entry), source: entry.source }));
        if (candidates.length === 0) {
          void vscode.window.showInformationMessage(
            "jerrypi: 没有可移除的包（本版本只管理 user 作用域的条目；项目作用域的请在 .pi/settings.json 里改）。",
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(candidates, {
          title: `jerrypi: 移除哪个包（${candidates.length} 个 user 作用域条目）`,
          matchOnDetail: true,
          ignoreFocusOut: true,
        });
        if (picked === undefined) return;

        const outcome = await removePackage(deps, picked.source);
        if (!outcome.ok) {
          output.appendLine(`[packages] 移除失败 ${picked.source}：${outcome.message}`);
          void vscode.window.showWarningMessage(
            `jerrypi: 移除 ${picked.source} 失败 —— ${outcome.message.split("\n")[0]}（细节见 Output）`,
          );
          return;
        }
        if (!outcome.removed) {
          // `removeAndPersist()` 返回 false = “没匹配到”（F11）—— **不许**当成功报（C5）。
          const message = `未移除 ${picked.source}：配置里的 user 作用域没有匹配的条目（可能它已不在 user 配置里）。`;
          output.appendLine(`[packages] ${message}`);
          void vscode.window.showWarningMessage(`jerrypi: ${message}`);
          return;
        }
        const settingsPath = settingsPathOf(deps);
        const message = `已移除 ${picked.source}（配置：${settingsPath}）—— 新建会话（或重载窗口）后生效`;
        output.appendLine(`[packages] ${message}`);
        void vscode.window.showInformationMessage(`jerrypi: ${message}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[packages] 移除包失败：${message}`);
        void vscode.window.showErrorMessage(`jerrypi: 移除包失败：${message}`);
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
