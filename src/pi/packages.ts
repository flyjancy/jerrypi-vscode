// S9：pi 包管理（装 / 列 / 卸）。
//
// **形状是「依赖 + 一次性函数」，不是长命的 manager 对象**（`docs/S9-plan.md` §3.1）：
// 每条命令都新建 `SettingsManager` + `DefaultPackageManager` —— 它们会读盘，代价是几次
// `readFileSync`，换来的是"看到的就是文件里的真相"。这不是风格洁癖：会话里那份
// `settingsManager` 是**启动时的缓存**（F14），拿它列出来的东西会跟 CLI / 新会话不一致。
//
// 只做 **user 作用域**（写 `<agentDir>/settings.json`），绝不写工作区（C1 / F8）：
// 项目作用域要往用户的仓库里写 `.pi/settings.json`，与"别动用户的东西"直接冲突。
//
// 两份 manager 职责不重叠（R7 / F31）：
//   · 写（install/remove）= `{ projectTrusted: false }` —— 默认值 `true` 会合并**未信任项目**
//     的 `.pi/settings.json`，而包管理会 spawn 那里的 `npmCommand`；那等于让项目配置决定
//     我们执行什么程序。写 user 作用域本来也不需要项目配置。
//   · 读（list）= `{ projectTrusted: true }`，**只读**，只为把项目级条目也列出来（C4/Q5b）。
//     它**绝不**传给写函数（A13b 用源码不变式钉住）。

import { join } from "node:path";
import type { PiModule } from "./loader";

/** 与 pi 的 `ConfiguredPackage` 同形（那个类型没从包根导出，与 F2b 的坑同类）。 */
export interface ConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  /** 解析后**存在**才给（pi 的 `existsSync` 检查，F13）。 */
  installedPath?: string;
}

export interface PackageDeps {
  /** pi 的导出面（`DefaultPackageManager` / `SettingsManager`）。 */
  pi: PiModule;
  /** `DefaultPackageManager` 构造必给（F3：缺 cwd 会在 `startsWith` 处抛）。 */
  cwd: string;
  /** **必填**：没有它直接抛（C7）—— 一次"忘了传、悄悄写进用户真实配置"的事故比显式错误贵得多。 */
  agentDir: string;
}

export type InstallOutcome =
  | { ok: true; changed: boolean; source: string }
  | { ok: false; message: string };

export type RemoveOutcome =
  | { ok: true; removed: boolean; source: string }
  | { ok: false; message: string };

/** 列表里那一行的三段（QuickPick 的 label/description/detail）。 */
export interface PackageDescription {
  label: string;
  description: string;
  detail: string;
}

/** `<agentDir>/settings.json` —— 文案里要说清"写去了哪个文件"（C2）。 */
export function settingsPathOf(deps: PackageDeps): string {
  return join(deps.agentDir, "settings.json");
}

/** 什么都不碰，只列配置里的条目（含项目作用域的，F13）。 */
export function listPackages(deps: PackageDeps): ConfiguredPackage[] {
  requireAgentDir(deps);
  return new deps.pi.DefaultPackageManager({
    cwd: deps.cwd,
    agentDir: deps.agentDir,
    settingsManager: readManagerFor(deps),
  }).listConfiguredPackages();
}

export async function installPackage(deps: PackageDeps, source: string): Promise<InstallOutcome> {
  requireAgentDir(deps);
  const settingsManager = writeManagerFor(deps);
  const manager = new deps.pi.DefaultPackageManager({ cwd: deps.cwd, agentDir: deps.agentDir, settingsManager });
  // `changed` 的口径：**这次调用有没有改动配置**（F10：同一个源再装一次返回"没改动"）。
  // 装之前先快照 —— pi 的 `packageSourcesMatch` 命中时不写，两端自然相等。
  const before = JSON.stringify(settingsManager.getPackages());
  try {
    // `installAndPersist` 是"先 install 再写"：install 抛了就不写（F23 ⇒ A12 天然成立）。
    await manager.installAndPersist(source);
  } catch (error) {
    return { ok: false, message: translateSourceError(error, source) };
  }
  return { ok: true, changed: before !== JSON.stringify(settingsManager.getPackages()), source };
}

export async function removePackage(deps: PackageDeps, source: string): Promise<RemoveOutcome> {
  requireAgentDir(deps);
  const settingsManager = writeManagerFor(deps);
  const manager = new deps.pi.DefaultPackageManager({ cwd: deps.cwd, agentDir: deps.agentDir, settingsManager });
  try {
    // `removed` 原样透出 pi 的返回值：`false` 就是"配置里没有匹配的条目"（F11 ⇒ C5 不许报成功）。
    const removed = await manager.removeAndPersist(source);
    return { ok: true, removed, source };
  } catch (error) {
    return { ok: false, message: translateSourceError(error, source) };
  }
}

/**
 * 保守的**否定条件**：只有 `npm:` 前缀才认成 npm 源。
 *
 * 为什么不复刻 pi 的 `parseSource()`（F2b：它和 `isLocalPath`/`parseGitUrl` 都没从 bundle 导出）：
 * 复刻一份就会分叉。判错的代价方向也要小心 —— 放宽成"含 `:` 就算 npm"会误伤 `C:\…`
 * 这种 Windows 路径（A1 的红法就是这一条）；收窄的代价只是"git 源在没 npm 的机器上
 * 退回 pi 的原文"，属于安全方向（F37：缺 git 与缺 npm 在 spawn 错误里分不开，硬翻译会撒谎）。
 */
export function isNpmSource(source: string): boolean {
  return source.startsWith("npm:");
}

/**
 * 把 pi 的失败形态翻成人话（F22/F23）。**不吞、不重写**没把握的消息。
 *
 * 只有"`npm:` 源 + spawn ENOENT"这一种才翻译成"需要 npm"：git 源（哪怕它带
 * `package.json`、也要 npm）保留原文，因为 git 自己缺失也会产生同样的 ENOENT（F37）。
 */
export function translateSourceError(error: unknown, source: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (isNpmSource(source) && /\bspawn\b/i.test(raw) && /\bENOENT\b/.test(raw)) {
    return `这个源需要 npm 才能安装（npm: 包 / 带 package.json 的 git 源都要它）；当前机器上没有可用的 npm。本地文件夹仍然可以装。\npi 的原文：${raw}`;
  }
  const missing = /^Path does not exist:\s*(.*)$/m.exec(raw);
  if (missing !== null) {
    return `找不到这个路径：${missing[1].trim()}\npi 的原文：${raw}`;
  }
  return raw;
}

/** 列表里那一行：`filtered` 加后缀、路径失效明说、项目作用域标注（A8/C4/Q5b）。 */
export function describePackage(entry: ConfiguredPackage): PackageDescription {
  return {
    label: entry.filtered ? `${entry.source} (filtered)` : entry.source,
    description: entry.scope === "user" ? "user" : "project（项目作用域：本版本不管理）",
    detail: entry.installedPath === undefined ? "找不到（路径已失效）" : entry.installedPath,
  };
}

/** 写路径专用：显式 `projectTrusted: false`（F31/R7）。**绝不复用读列表那份。** */
function writeManagerFor(deps: PackageDeps) {
  return deps.pi.SettingsManager.create(deps.cwd, deps.agentDir, { projectTrusted: false });
}

/** 读列表专用（只读）：允许合并项目级配置，好把项目条目也列出来（C4）。 */
function readManagerFor(deps: PackageDeps) {
  return deps.pi.SettingsManager.create(deps.cwd, deps.agentDir, { projectTrusted: true });
}

function requireAgentDir(deps: PackageDeps): void {
  if (typeof deps.agentDir !== "string" || deps.agentDir.trim().length === 0) {
    throw new Error("jerrypi: 包管理需要明确的 agentDir（不许回退 pi 的默认目录）");
  }
}
