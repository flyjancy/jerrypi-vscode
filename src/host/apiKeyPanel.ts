// S9 ①②：面板内的「设置 API key」流程（provider 选择卡 + **password 卡**）。
//
// 与 `src/commands.ts` 的原生命令同源（`getModelRuntime` / `injectApiKey` / 本地校验三态），
// 差别只在"用哪种控件问"：命令入口保持原生 QuickPick（Q11），面板入口全走卡片。
//
// 泄漏面（A29）：密钥**只**在 `dialog/answer` 这一条 webview→宿主消息里出现；
// 宿主从不把它写进任何 host→webview 消息（`DialogHost` 的 open 载荷里没有值），
// 也不写 Output。这里额外注意：**不把 key 放进 notify 文案**。
import type { PiModule } from "../pi/loader";
import { DEFAULT_PROVIDER, getModelRuntime, injectApiKey, type ApiKeyStore } from "../pi/runtime";
import { describeAuthSource } from "../shared/format";
import type { DialogPanel } from "./dialogHost";

export interface ApiKeyPanelDeps {
  pi: PiModule;
  agentDir: string;
  keys: ApiKeyStore;
  dialogs: DialogPanel;
  notify: (text: string, level: "info" | "warn" | "error") => void;
}

const CUSTOM_PROVIDER = "其他（手动输入 provider id）";

export async function pickApiKeyInPanel(deps: ApiKeyPanelDeps): Promise<void> {
  const runtime = await getModelRuntime(deps.pi, deps.agentDir, deps.keys);
  const known = runtime.getProviders().map((provider) => ({
    label: provider.id,
    description: `${provider.name === provider.id ? "" : `${provider.name} · `}${describeAuthSource(runtime.getProviderAuthStatus(provider.id).source)}`,
  }));
  const ordered = [
    ...known.filter((item) => item.label === DEFAULT_PROVIDER),
    ...known.filter((item) => item.label !== DEFAULT_PROVIDER),
  ];
  const first = await deps.dialogs.open({
    kind: "select",
    title: `jerrypi: 选择 provider（pi 认识 ${known.length} 个）`,
    current: DEFAULT_PROVIDER,
    items: [...ordered, { label: CUSTOM_PROVIDER, description: "pi 不认识的 provider id（例如 models.json 里自定义的）" }],
  });
  if (first === undefined) return;

  let providerId = first;
  if (providerId === CUSTOM_PROVIDER) {
    const typed = await deps.dialogs.open({ kind: "input", title: "jerrypi: provider id", placeholder: "例如 deepseek" });
    if (typed === undefined || typed.trim().length === 0) return;
    providerId = typed.trim();
  }

  // **password 卡**：宿主侧这张卡不存任何值；`answer` 是唯一带明文的那条消息。
  const apiKey = await deps.dialogs.open({ kind: "password", title: `jerrypi: ${providerId} API key` });
  if (apiKey === undefined || apiKey.trim().length === 0) return;
  const trimmed = apiKey.trim();

  await deps.keys.saveApiKey(providerId, trimmed);
  // pi 的 `setRuntimeApiKey` 只写内存：重载窗口即丢，所以还要注入**已经缓存的那个实例**。
  await injectApiKey(deps.pi, deps.agentDir, deps.keys, providerId, trimmed);

  // 本地校验（不发请求、不花钱）——与命令入口同一套三态。
  const check = await runtime.checkAuth(providerId);
  const available = await runtime.getAvailable(providerId);
  if (check === undefined) {
    deps.notify(`已保存 ${providerId} 的 key，但 pi 侧未配置成功 —— 检查 provider id 是否正确。`, "warn");
  } else if (available.length === 0) {
    deps.notify(
      `已保存 ${providerId} 的 key，但 pi 的模型目录里这个 provider 没有可用模型 —— 生效的配置目录是 ${deps.agentDir}。`,
      "warn",
    );
  } else {
    deps.notify(
      `已保存 ${providerId} 的 API key（VS Code SecretStorage —— 不写进 auth.json）—— pi 目录里有 ${available.length} 个可用模型。`,
      "info",
    );
  }
}
