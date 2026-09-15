// 项目信任（S8）：谁来裁决"要不要加载工作区里的项目级 pi 资源"。
//
// 为什么自己写这一小段（`docs/S8-plan.md` §0.2 F12）：pi 的 `resolveProjectTrusted()` 与
// `getProjectTrustOptions()` **没有从 bundle 导出**（只在 CLI 那个 chunk 里），所以
// "问什么、怎么问、怎么记"只能我们定。但**判据来源不许自己造**：
//   · `hasTrustRequiringProjectResources`（什么算"需要信任的资源"）—— 用 pi 的导出（F14）；
//   · `ProjectTrustStore`（`<agentDir>/trust.json` 的格式、父子继承、canonical 路径）—— 用 pi 的类（F15）。
// 我们**不自己拼 trust.json**（与 AGENTS.md §4 的"不自己拼会话 JSONL"同一条纪律）。
//
// 裁决顺序（复刻 CLI 的语义，去掉 `--approve/--no-approve` 这个 CLI 专有开关）：
//
//   1) memo 里有 → 用它（同一个进程里同一个 cwd 只裁决一次，CLI 的 projectTrustByCwd）
//   2) 没有"需要信任的资源" → true（**不问**；⚠️ loader 不会替我们短路：只要传了钩子，
//      哪怕一个 `.pi/` 都没有它照样 await 一次 —— F11 的实测）
//   3) trust.json 里有记录（true 或 false）→ 用它（不问；CLI 写的 false 我们照样尊重）
//   4) settings.json 的 defaultProjectTrust：always → true / never → false（不问）
//   5) 问用户 → { trusted, remember }；**只有 remember 才写文件，且只写 true**
//
// ⚠️ "只写 true"是刻意的（S8-plan 的 Q5）：面板里没有天然的"改判"入口，一个误点写成
// `false` 就变成"永不再问"。要改判走 `Pi: Project Trust…` 命令（`applyTrustAction`）。

import { dirname } from "node:path";
import type { EventSink } from "./bindings";

/**
 * 跨会话记住的裁决（`Map<string, boolean>` 天然满足它）。
 *
 * 取窄接口是为了让"命令改判之后清缓存"这件事能落在**同一个**对象上
 * （controller 持有它；测试给一个普通 Map）。
 */
export interface TrustMemoLike {
  get(cwd: string): boolean | undefined;
  set(cwd: string, trusted: boolean): void;
  delete(cwd: string): boolean;
}

/** `settings.json` 的 `defaultProjectTrust`（pi 的三档）。 */
export type DefaultProjectTrust = "ask" | "always" | "never";

/**
 * 信任存储的**窄接口**（pi 的 `ProjectTrustStore` 天然满足它）。
 *
 * 取窄接口是为了让断言能注入一个假的存储去验"裁决顺序"，而不是每次都写真实文件。
 */
export interface TrustStoreLike {
  get(cwd: string): boolean | null;
  set(cwd: string, decision: boolean | null): void;
  /** 一条写入里改多把钥匙（pi 的 `ProjectTrustStore.setMany`；"信任父文件夹"要用它保证原子）。 */
  setMany(decisions: { path: string; decision: boolean | null }[]): void;
}

/** 一次询问的答案。`remember === false` ⇒ 只作用于本次进程，不写文件。 */
export interface TrustAnswer {
  trusted: boolean;
  remember: boolean;
}

export interface TrustResolverOptions {
  cwd: string;
  trustStore: TrustStoreLike;
  /** pi 的 `hasTrustRequiringProjectResources`（注入是为了断言"没资源就不问"）。 */
  hasRequiringResources: (cwd: string) => boolean;
  /** pi 的 `settingsManager.getDefaultProjectTrust()`（**每次现读**：用户可能刚改过）。 */
  defaultProjectTrust: () => DefaultProjectTrust;
  /** 用户界面那一侧（VS Code 模态；`src/host/trustPrompt.ts`）。**不许抛**。 */
  ask: (cwd: string) => Promise<TrustAnswer>;
  log: EventSink;
  /** 跨会话记住的裁决（controller 持有、命令可以清）。 */
  memo?: TrustMemoLike;
}

/**
 * 造裁决函数：`({extensionsResult}) => Promise<boolean>`，形状与 pi 的
 * `ResourceLoaderReloadOptions.resolveProjectTrust` 一致（那个入参我们不用 ——
 * 不做 `project_trust` 扩展事件，见 S8-plan 的 Q6/§2 不做清单；签名照样吃下它）。
 */
export function createTrustResolver(
  options: TrustResolverOptions,
): (input: { extensionsResult?: unknown }) => Promise<boolean> {
  const memo = options.memo ?? new Map<string, boolean>();
  return async () => {
    const { cwd } = options;
    const cached = memo.get(cwd);
    if (cached !== undefined) {
      options.log.appendLine(`[trust] ${cwd}：用本进程里已经裁决过的结果（${cached ? "信任" : "不信任"}）`);
      return cached;
    }
    if (!options.hasRequiringResources(cwd)) {
      // 没有需要信任的资源 ⇒ 信任与否不影响任何事。不能"顺手问一下"：
      // 那会让每个干净的仓库都弹一次对话框。
      memo.set(cwd, true);
      options.log.appendLine(`[trust] ${cwd}：工作区里没有 pi 的项目级资源（.pi/ 或 .agents/skills），按信任处理`);
      return true;
    }
    const saved = options.trustStore.get(cwd);
    if (saved !== null) {
      memo.set(cwd, saved);
      options.log.appendLine(`[trust] ${cwd}：用 trust.json 里的记录（${saved ? "信任" : "不信任"}）`);
      return saved;
    }
    const fallback = options.defaultProjectTrust();
    if (fallback === "always" || fallback === "never") {
      const trusted = fallback === "always";
      memo.set(cwd, trusted);
      options.log.appendLine(`[trust] ${cwd}：settings.json 的 defaultProjectTrust=${fallback} ⇒ ${trusted ? "信任" : "不信任"}`);
      return trusted;
    }
    let answer: TrustAnswer;
    try {
      answer = await options.ask(cwd);
    } catch (error) {
      // 问不出来（对话框崩了/宿主没了）⇒ **不信任**（安全方向），并且不写文件。
      const text = error instanceof Error ? error.message : String(error);
      options.log.appendLine(`[trust] 询问失败，按不信任处理：${text}`);
      answer = { trusted: false, remember: false };
    }
    if (answer.remember) {
      if (answer.trusted) {
        options.trustStore.set(cwd, true);
        options.log.appendLine(`[trust] ${cwd}：已记住"信任"（写进 trust.json）`);
      } else {
        // ⚠️ 刻意**不写 false**（Q5）：那会变成"永不再问"。用户要的是"这一次不信任"。
        options.log.appendLine(`[trust] ${cwd}：这次不信任（**不写** trust.json —— 下次还会问）`);
      }
    }
    memo.set(cwd, answer.trusted);
    return answer.trusted;
  };
}

/** `Pi: Project Trust…` 的五个动作。 */
export type TrustAction = "trust-remember" | "trust-parent" | "trust-session" | "deny-session" | "clear";

export const TRUST_ACTIONS: readonly TrustAction[] = [
  "trust-remember",
  "trust-parent",
  "trust-session",
  "deny-session",
  "clear",
];

/** 动作在 QuickPick 里的文案（host 与断言共用同一份）。 */
export const TRUST_ACTION_LABELS: Record<TrustAction, string> = {
  "trust-remember": "信任这个文件夹（记住）",
  "trust-parent": "信任父文件夹（记住）",
  "trust-session": "信任（仅本次，不写文件）",
  "deny-session": "不信任（仅本次，不写文件）",
  clear: "清除这里的记录（下次重新问）",
};

/** `dirname` 的边界：根目录没有"父文件夹"（与 pi 的 `getProjectTrustParentPath` 同一判据）。 */
export function trustParentOf(cwd: string): string | undefined {
  const parent = dirname(cwd);
  return parent === cwd ? undefined : parent;
}

export interface ApplyTrustActionOptions {
  cwd: string;
  trustStore: TrustStoreLike;
  memo: TrustMemoLike;
  log: EventSink;
}

/**
 * 执行一个动作。返回给用户看的一句话（host 用它弹提示）。
 *
 * 两条容易写错的：
 *   1. **"信任父文件夹"要写两条 update**（第 1 轮评审 S6）：`findNearestTrustEntry` 是从 cwd
 *      逐级向上找**最近**的一条，不清掉子目录那条，父目录的裁决永远轮不到 —— pi 自己
 *      （`trust-manager.js:42-54`）给的就是 `[{parent:true},{cwd:null}]` 两条。
 *   2. 执行完必须**清 memo**：否则同一个进程里下一个会话还会用旧裁决（`session.reload()`
 *      不重跑信任钩子，F17；所以提示语里要说"新建会话/重载窗口后生效"）。
 */
export function applyTrustAction(action: TrustAction, options: ApplyTrustActionOptions): string {
  const { cwd, trustStore, memo, log } = options;
  switch (action) {
    case "trust-remember":
      trustStore.set(cwd, true);
      memo.delete(cwd);
      log.appendLine(`[trust] ${cwd}：记住"信任"`);
      return "已记住信任这个文件夹（新建会话或重载窗口后生效）";
    case "trust-parent": {
      const parent = trustParentOf(cwd);
      if (parent === undefined) {
        log.appendLine(`[trust] ${cwd}：已经在根目录，没有父文件夹可信任`);
        return "这个位置没有父文件夹（已在根目录）";
      }
      // 两条一起写：pi 的 setMany 在同一把文件锁里完成（我们只写 true 与"删除"）
      trustStore.setMany([
        { path: parent, decision: true },
        { path: cwd, decision: null },
      ]);
      memo.delete(cwd);
      log.appendLine(`[trust] ${cwd}：记住信任父文件夹 ${parent}，并清掉本文件夹的记录`);
      return `已记住信任父文件夹 ${parent}（新建会话或重载窗口后生效）`;
    }
    case "trust-session":
      memo.set(cwd, true);
      log.appendLine(`[trust] ${cwd}：仅本次信任（不写文件）`);
      return "本次信任这个文件夹（不写文件）";
    case "deny-session":
      memo.set(cwd, false);
      log.appendLine(`[trust] ${cwd}：仅本次不信任（不写文件）`);
      return "本次不信任这个文件夹（不写文件）";
    case "clear": {
      const had = trustStore.get(cwd) !== null;
      trustStore.set(cwd, null);
      memo.delete(cwd);
      log.appendLine(`[trust] ${cwd}：清除记录（原本${had ? "有" : "没有"}）`);
      return had ? "已清除这里的记录（下次会重新问）" : "这里本来就没有记录";
    }
  }
}
