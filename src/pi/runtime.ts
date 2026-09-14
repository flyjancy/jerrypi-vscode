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
  /** S6：清掉我们存的那把（SecretStorage + 名单）。**不碰** pi 自己的 auth.json/models.json。 */
  removeApiKey(providerId: string): Promise<void>;
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
    async removeApiKey(providerId) {
      await context.secrets.delete(SECRET_KEY_PREFIX + providerId);
      providers.delete(providerId);
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

/** 模型目录刷新结果。`refresh()` 自己不返回计数（只有 `{ aborted, errors }`），所以要前后各数一次。 */
export interface CatalogRefreshResult {
  providersBefore: number;
  providersAfter: number;
  modelsBefore: number;
  modelsAfter: number;
  errors: { providerId: string; reason: string }[];
}

/**
 * `Pi: Refresh Model Catalog` 的核心（不依赖 vscode，便于自动断言）。
 *
 * 计数从 `getProviders()` / `getAvailableSnapshot()` 的**前后差**拿（S6-plan §3.5 / 评审第 2 轮 N5）。
 *
 * ⚠️ `allowNetwork: true` 是"**只有用户点这条命令才发请求**"的唯一开关。不要把它挂到任何
 * 自动路径上 —— 这就是 S6-plan §6 的 A12 漂移守卫盯着的那件事（它靠的是 pi 内部每个调用点
 * 都显式传 `allowNetwork: false`，而那是会漂移的内部细节）。
 */
export async function refreshModelCatalog(runtime: ModelRuntime): Promise<CatalogRefreshResult> {
  const providersBefore = runtime.getProviders().length;
  const modelsBefore = runtime.getAvailableSnapshot().length;
  const result = await runtime.refresh({ allowNetwork: true });
  const errors = [...result.errors.entries()].map(([providerId, error]) => ({
    providerId,
    reason: error instanceof Error ? error.message : String(error),
  }));
  return {
    providersBefore,
    providersAfter: runtime.getProviders().length,
    modelsBefore,
    modelsAfter: runtime.getAvailableSnapshot().length,
    errors,
  };
}

/** 清理结果：成功的 provider 与失败的（带原因）。逐个 try/catch，不让一个失败拖垮其余的。 */
export interface ClearKeysResult {
  ok: string[];
  failed: { providerId: string; reason: string }[];
}

/**
 * 清掉**我们自己存的** API key（`Pi: Clear Stored API Keys` 的核心）。
 *
 * 刻意不依赖 vscode：值在 `host-check` 的桩上验 ①，在 `controller-check` 上用**真**
 * `ModelRuntime` 验 ②③（S6-plan §6 的 A5 / §10 第 4 轮 S3）。
 *
 * ⚠️ 顺序与 API 都是有讲究的（S6-plan §3.2 / §0.2 F6）：
 *   1. 用 `removeRuntimeApiKey()`，**绝不用 `logout()`** —— 后者会去删 **auth.json 里用户
 *      自己的凭据**（`RuntimeCredentials.delete()` → 底层 store 的 delete）。
 *   2. **先清内存里的那把、成功之后再删 SecretStorage**：反过来的话，一旦
 *      `removeRuntimeApiKey` 抛出（它内部会同步凭据快照，失败时包成
 *      `CredentialSynchronizationError`），就会留下"SecretStorage 已删、内存里那把还在"的
 *      夹生状态。
 */
export async function clearStoredApiKeys(
  providerIds: readonly string[],
  deps: { keys: ApiKeyStore; runtime: ModelRuntime },
): Promise<ClearKeysResult> {
  const result: ClearKeysResult = { ok: [], failed: [] };
  for (const providerId of providerIds) {
    try {
      await deps.runtime.removeRuntimeApiKey(providerId);
      await deps.keys.removeApiKey(providerId);
      result.ok.push(providerId);
    } catch (error) {
      result.failed.push({ providerId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
