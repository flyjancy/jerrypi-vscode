// ModelRuntime 工厂。
//
// 这个文件存在的唯一理由是修正一个会让闸门假失败的缺陷：
//
//   `ModelRuntime.setRuntimeApiKey()` 只写**内存**里的凭据覆盖层
//   （`RuntimeCredentials { overrides = new Map() }`，见 pi bundle 源码），
//   **不落盘**，重载窗口即丢。
//
// 所以 key 的注入**必须**发生在每次创建 ModelRuntime 之后，而不是"设置 key 时注入一次"。
// 又因为自测会用临时 agentDir 建出第二个实例（它的凭据 Map 也是空的），
// 注入只能放在这个工厂内部，对任何 agentDir 的实例都生效。
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type * as vscode from "vscode";
import type { PiModule } from "./loader";

/** SecretStorage 的键前缀：`jerrypi.apiKey.<providerId>`。 */
export const SECRET_KEY_PREFIX = "jerrypi.apiKey.";
/** SecretStorage 没有枚举接口，所以另存一份 provider 列表到 globalState。 */
export const PROVIDERS_STATE_KEY = "jerrypi.apiKeyProviders";
/** QuickPick 里置顶的 provider。 */
export const DEFAULT_PROVIDER = "deepseek";
/** QuickPick 的候选（pi 内置 provider 的一部分，用户也可手填）。 */
export const SUGGESTED_PROVIDERS = [
  "deepseek",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
  "mistral",
] as const;

export interface ApiKeyStore {
  listProviders(): readonly string[];
  getApiKey(providerId: string): Promise<string | undefined>;
  saveApiKey(providerId: string, apiKey: string): Promise<void>;
}

/** 基于 VS Code SecretStorage + globalState 的实现。 */
export function createApiKeyStore(context: vscode.ExtensionContext): ApiKeyStore {
  const providers = new Set<string>(context.globalState.get<string[]>(PROVIDERS_STATE_KEY, []));

  return {
    listProviders: () => [...providers].sort(),
    getApiKey: (providerId) => Promise.resolve(context.secrets.get(SECRET_KEY_PREFIX + providerId)),
    async saveApiKey(providerId, apiKey) {
      await context.secrets.store(SECRET_KEY_PREFIX + providerId, apiKey);
      providers.add(providerId);
      await context.globalState.update(PROVIDERS_STATE_KEY, [...providers]);
    },
  };
}

const runtimes = new Map<string, Promise<ModelRuntime>>();

/**
 * 取得某个 agentDir 对应的 ModelRuntime（按 agentDir 缓存）。
 *
 * 三个路径全部显式传：不依赖 pi 的默认值，否则 S6 引入 `jerrypi.agentDir` 之后
 * auth 会走自定义目录、models.json 却仍走默认目录（静默劈叉）。
 */
export function getModelRuntime(
  pi: PiModule,
  agentDir: string,
  keys: ApiKeyStore,
): Promise<ModelRuntime> {
  const existing = runtimes.get(agentDir);
  if (existing !== undefined) {
    return existing;
  }

  const attempt = createModelRuntime(pi, agentDir, keys);
  runtimes.set(agentDir, attempt);
  void attempt.catch(() => {
    if (runtimes.get(agentDir) === attempt) {
      runtimes.delete(agentDir);
    }
  });
  return attempt;
}

/**
 * 给**已缓存**的实例立刻注入一把 key。
 *
 * `Pi: Set API Key` 必须调它：否则用户设完 key 还要等实例重建（重载窗口）才生效，
 * 而重载又会丢掉刚设的值，形成死循环。
 */
export async function injectApiKey(
  pi: PiModule,
  agentDir: string,
  keys: ApiKeyStore,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const runtime = await getModelRuntime(pi, agentDir, keys);
  await runtime.setRuntimeApiKey(providerId, apiKey);
}

async function createModelRuntime(
  pi: PiModule,
  agentDir: string,
  keys: ApiKeyStore,
): Promise<ModelRuntime> {
  const runtime = await pi.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    // pi 的默认值就是 false；显式写出是为了让"不联网刷模型目录"这件事可读。
    allowModelNetwork: false,
  });

  await injectStoredApiKeys(runtime, keys);
  return runtime;
}

/** 把 SecretStorage 里存过的所有 key 注入这个实例（内存态，重建后必须重放）。 */
async function injectStoredApiKeys(runtime: ModelRuntime, keys: ApiKeyStore): Promise<void> {
  for (const providerId of keys.listProviders()) {
    const apiKey = await keys.getApiKey(providerId);
    if (apiKey !== undefined && apiKey.length > 0) {
      await runtime.setRuntimeApiKey(providerId, apiKey);
    }
  }
}
