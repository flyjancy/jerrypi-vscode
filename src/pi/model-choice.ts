// 模型选择：把"用哪个 provider、哪个模型"这件事集中到一处。
//
// 为什么要单独一个模块：自测闸门（selftest.ts）与聊天面板（controller.ts）
// 必须用**同一套**选模型规则。两套实现的漂移是静默的——面板能跑、闸门能过，
// 但两者选的是不同的模型，出问题时无从对照。
//
// 背景（对着 pi 0.85.1 源码核实过，不是推测）：
//
//   1. `ModelRuntime.getAvailable()` 只判断**配没配凭据**，不判断能不能用。
//      一个填错的 key 也算"已配置"——实测某台 Windows 机上 deepseek 与 openai
//      都有凭据，pi 每次都挑 `openai/gpt-5.5`（不可用），于是每次 prompt 都落一条
//      空 assistant 消息，看起来像"pi 跑不起来"，实际是"模型用不了"。
//   2. pi 内部有一张 `defaultModelPerProvider` 表（bundle 里可见但未导出），
//      它给 provider 挑的默认模型**不是**可用列表的第一个：实测 deepseek 的
//      可用列表顺序是 `flash, flash-vision-exp, pro`，而 pi 自己选的是 `pro`。
//      所以"取可用列表第一个"会拿到与 pi 不同的模型。

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** 选模型时的 provider 优先级：用户最可能配的放前面。 */
export const PREFERRED_PROVIDERS = [
  "deepseek",
  "anthropic",
  "google",
  "openrouter",
  "openai",
] as const;

/**
 * 每个 provider 下**指定使用**的模型（按顺序取第一个可用的）。
 *
 * 为什么需要它：pi 内部的 `defaultModelPerProvider` 会给 deepseek 选 `deepseek-v4-pro`（贵），
 * 而闸门与面板都会跑真实模型调用，所以这里显式指定用便宜的 flash。
 * 未列出的 provider 仍沿用 pi 自己的选择（那才是它认为最合适的模型）。
 */
export const PREFERRED_MODEL_IDS: Record<string, readonly string[]> = {
  deepseek: ["deepseek-v4-flash"],
};

/** `getAvailable()` 返回的模型，只取我们需要的字段。 */
interface AvailableModel {
  provider?: string;
  id?: string;
  name?: string;
}

export interface ModelChoice {
  /** 首选 provider 下的候选模型（未锁定 provider 时不做声明）。 */
  model: unknown;
  provider: string | undefined;
  /** true 表示模型是**显式指定**的，必须强制切换过去。 */
  pinned: boolean;
  /** 给人看的一句话说明，直接写进自测输出/日志。 */
  detail: string;
}

/**
 * 选一个**真正可用**（有凭据）的模型。
 *
 * 返回的 `provider` 是"首选 provider"，`model` 是该 provider 下的候选。
 * 真正生效的模型由 {@link alignModel} 决定。
 */
export async function pickModel(runtime: {
  getAvailable(): Promise<readonly unknown[]>;
}): Promise<ModelChoice> {
  const available = (await runtime.getAvailable()) as AvailableModel[];
  if (available.length === 0) {
    return {
      model: undefined,
      provider: undefined,
      pinned: false,
      detail: "(没有任何可用模型：未配置任何 provider 的凭据)",
    };
  }
  for (const provider of PREFERRED_PROVIDERS) {
    const matches = available.filter((model) => model.provider === provider);
    if (matches.length === 0) continue;
    // 该 provider 有指定模型就用指定的；没有则交给 pi 自己解析（见 alignModel）。
    const pinned = PREFERRED_MODEL_IDS[provider];
    const pinnedMatch =
      pinned === undefined
        ? undefined
        : matches.find((model) => pinned.includes(String(model.id ?? model.name)));
    const picked = pinnedMatch ?? (pinned === undefined ? undefined : matches[0]);
    return {
      model: picked ?? matches[0],
      provider,
      pinned: pinnedMatch !== undefined,
      detail:
        `${matches.map((m) => m.id ?? m.name).join(", ")}（首选 ${provider}` +
        `${pinnedMatch !== undefined ? `，锁定 ${String(pinnedMatch.id)}` : pinned !== undefined ? `，未找到指定模型，取第一个` : "，交给 pi 自己解析"}）`,
    };
  }
  const first = available[0];
  return {
    model: first,
    provider: first.provider,
    pinned: true,
    detail: `${first.provider}/${first.id ?? first.name}（无首选 provider，取第一个）`,
  };
}

/** 对齐模型时用到的会话子集（避免依赖 AgentSession 的完整类型）。 */
export interface AlignableSession {
  model?: { provider?: string; id?: string } | null;
  setModel(model: never, options?: { persist?: boolean }): Promise<void>;
  /** 用来判断"用户有没有自己选过模型"（见 alignPanelModel）。 */
  settingsManager?: {
    getDefaultProvider?(): string | undefined;
    getDefaultModel?(): string | undefined;
  };
}

/**
 * 把会话的模型对齐到首选 provider / 指定模型。
 *
 * 规则：
 *   - 该 provider 在 PREFERRED_MODEL_IDS 里**有指定模型** → **总是** setModel 强制过去
 *     （否则 pi 会选它自己的默认，如 pro）；
 *   - 没有指定 → 若 pi 选中的 provider 就是首选，则**沿用 pi 的选择**
 *     （那才是它认为最合适的模型）；否则改成该 provider 的可用列表第一个。
 */
export async function alignModel(
  session: AlignableSession,
  choice: Pick<ModelChoice, "provider" | "model" | "pinned">,
): Promise<string> {
  const { provider: targetProvider, model: preferredModel, pinned } = choice;
  const piChoice = session.model;
  const piChoiceLabel = piChoice ? `${piChoice.provider}/${piChoice.id}` : "(none)";

  if (targetProvider === undefined) {
    return `无可用 provider，沿用 pi 的选择 ${piChoiceLabel}`;
  }
  if (preferredModel === undefined) {
    return `无法改模型：首选 provider ${targetProvider} 没有候选；pi 选的是 ${piChoiceLabel}`;
  }

  const preferred = preferredModel as { provider?: string; id?: string };
  const preferredLabel = `${preferred.provider}/${preferred.id}`;

  if (!pinned && piChoice?.provider === targetProvider) {
    return `${piChoiceLabel}（沿用 pi 的选择：provider 与首选一致）`;
  }
  if (piChoiceLabel === preferredLabel) {
    return `${piChoiceLabel}（已是目标模型）`;
  }

  await session.setModel(preferredModel as never, { persist: false });
  return pinned
    ? `${piChoiceLabel} → 已改为 ${preferredLabel}（指定模型，不用 pi 的默认）`
    : `${piChoiceLabel} → 已改为 ${preferredLabel}（首选 provider ${targetProvider}）`;
}

/**
 * 把会话宿主（含 `session` getter）的模型对齐，返回给人看的说明。
 * 面板与自测都用这一个入口。
 */
export async function alignSessionModel(
  host: { session: AgentSession },
  choice: Pick<ModelChoice, "provider" | "model" | "pinned">,
): Promise<string> {
  return alignModel(host.session as unknown as AlignableSession, choice);
}

/**
 * **面板**用的模型策略：用户选过就听用户的，没选过才用我们的偏好兜底。
 *
 * 为什么与自测不同：
 *   - 自测（`pickModel` + `alignModel`）会**钉死**一个便宜的模型，
 *     因为它要跑很多次真实调用，需要确定性与低开销；
 *   - 面板是给人用的，**不该覆盖用户在 pi 里选的模型**（PLAN 5.3 明确写着
 *     "配置来源遵循 pi 自己的约定"）。用户没选过时（全新机器）才由我们兜底，
 *     避免落到一个"凭据填错了但 pi 认为可用"的 provider 上
 *     —— 受限那台机器就是这样被 `openai/gpt-5.5` 卡住的。
 *
 * 判断依据是 pi 设置里的 `defaultProvider` / `defaultModel`（都为空 = 用户没选过）。
 */
export async function alignPanelModel(
  session: AlignableSession,
  runtime: { getAvailable(): Promise<readonly unknown[]> },
): Promise<string> {
  const settings = session.settingsManager;
  const savedProvider = settings?.getDefaultProvider?.();
  const savedModel = settings?.getDefaultModel?.();
  const current = session.model ? `${session.model.provider}/${session.model.id}` : "(none)";
  if (savedProvider !== undefined || savedModel !== undefined) {
    return `${current}（沿用 pi 设置里的默认 ${savedProvider ?? "?"}/${savedModel ?? "?"}，未覆盖）`;
  }
  const choice = await pickModel(runtime);
  return alignModel(session, choice);
}

/** 列出**已配置凭据**的 provider，用于诊断输出。 */
export function describeConfiguredProviders(runtime: {
  getProviders(): readonly { id: string }[];
  getProviderAuthStatus(providerId: string): unknown;
}): string {
  const configured = runtime
    .getProviders()
    .map((provider) => provider.id)
    .filter((id) => {
      const status = runtime.getProviderAuthStatus(id) as { configured?: boolean } | undefined;
      return status?.configured === true;
    });
  return configured.length > 0 ? configured.join(", ") : "(无)";
}
