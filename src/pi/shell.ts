// S9 ④（追加范围）：bash 路径的候选与写穿。
//
// 为什么需要它（F39）：pi 在 win32 找 bash 的瀑布是
// `settings.json` 的 `shellPath` → `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\…`
// → `where bash.exe`（PATH）→ 报错。**盲区**：Git **按用户安装**落在
// `%LOCALAPPDATA%\Programs\Git`，而安装器默认只把 `<安装目录>\cmd`（git.exe）加进 PATH、
// **不加 `bin`**（bash.exe 所在）⇒ 上面三档全部落空，用户只看到 pi 的报错。
//
// 我们**不复刻** pi 的探测（那会分叉）：候选只用来给用户选，写进 `shellPath` 之后
// 生效仍由 pi 自己那条瀑布决定。
//
// 信任口径（Astra R1-B2/R2-B2）：预检与写穿都用 `{ projectTrusted: false }` 的 manager
// —— 我们自己写的就是 **global** 那一份（`setShellPath` 写 global，F40），用默认信任
// 会把**用户已拒绝**的项目级 `shellPath` 报出来（实测）。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import type { PiModule } from "./loader";

export interface ShellDeps {
  pi: PiModule;
  cwd: string;
  agentDir: string;
}

export interface ShellCandidateDeps {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** `where bash.exe` 的结果（由 `pathBashCandidates()` 跑；非 win32 给空数组）。 */
  pathBash?: string[];
  /** 覆盖 `process.platform` / `os.homedir()` 只为断言（生产不传）。 */
  platform?: NodeJS.Platform;
  homeDir?: string;
}

/**
 * 有序候选（**不存在的会被滤掉**）：`where` 的结果（用户 PATH 里的显式意愿）最优先，
 * 然后 `%ProgramFiles%` / `%ProgramFiles(x86)%` / **`%LOCALAPPDATA%\Programs\Git`**（F39 的盲区）、
 * 最后 scoop 两处（shim 也是可执行的 bash）。
 */
export function shellCandidates(deps: ShellCandidateDeps): string[] {
  const platform = deps.platform ?? process.platform;
  const found: string[] = [];
  const push = (candidate: string | undefined): void => {
    if (candidate === undefined || candidate.length === 0) return;
    if (found.includes(candidate)) return;
    if (!deps.exists(candidate)) return;
    found.push(candidate);
  };

  for (const entry of deps.pathBash ?? []) push(entry);
  if (platform !== "win32") return found;

  const env = deps.env;
  const home = deps.homeDir ?? env.USERPROFILE ?? env.HOMEPATH ?? homedir();
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
  const programFilesX86 = env["ProgramFiles(x86)"] ?? env["PROGRAMFILES(X86)"];
  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData;
  // ⚠️ 用 `win32.join`：生产在 win32 上跑时两者一致，但断言可注入 `platform` 在 Mac 上验 Windows 形态
  // （用宿主 `join` 会拼出 `C:\PF/Git/bin/bash.exe` 这种混合形态）。
  push(programFiles === undefined ? undefined : win32.join(programFiles, "Git", "bin", "bash.exe"));
  push(programFilesX86 === undefined ? undefined : win32.join(programFilesX86, "Git", "bin", "bash.exe"));
  // 用户真机踩中的那一档（F39）：按用户安装的 Git。
  push(localAppData === undefined ? undefined : win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  push(win32.join(home, "scoop", "apps", "git", "current", "bin", "bash.exe"));
  push(win32.join(home, "scoop", "shims", "bash.exe"));
  return found;
}

/** `where bash.exe` 的结果（只有 win32 有意义；找不到/没装 where 就返回空数组，不抛）。 */
export function pathBashCandidates(): string[] {
  if (process.platform !== "win32") return [];
  try {
    const result = spawnSync("where", ["bash.exe"], { encoding: "utf8" });
    if (result.error !== undefined && result.error !== null) return [];
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export interface ShellResolution {
  /** 已保存的用户配置（global）里的 `shellPath`；没配过就是 undefined。 */
  configured?: string;
  /** pi 解析出来的 bash 路径（出错时没有）。 */
  path?: string;
  /** 解析失败时 pi 的原文（例如 `Custom shell path not found: …`）。 */
  error?: string;
}

/**
 * 「现在会解析到哪个 bash」的**预检**：读已保存的用户配置（global）再交给 `getShellConfig`。
 *
 * ⚠️ 不能只调无参 `getShellConfig()`（F41 实测）：无参是**纯自动探测**，
 * **不读 `settings.json` 的 `shellPath`** —— 用户刚存的值在预检里看不到。
 */
export function resolveCurrentShell(deps: ShellDeps): ShellResolution {
  const settings = deps.pi.SettingsManager.create(deps.cwd, deps.agentDir, { projectTrusted: false });
  const configured = settings.getShellPath();
  const withConfigured = configured === undefined ? {} : { configured };
  try {
    const config = configured === undefined ? deps.pi.getShellConfig() : deps.pi.getShellConfig(configured);
    return { ...withConfigured, path: config.shell };
  } catch (error) {
    return { ...withConfigured, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ShellWriteOutcome {
  ok: boolean;
  message?: string;
}

/**
 * T16（advisory）与 `Pi: Set Shell Path` 的“当前”那一行**共用**的文案。
 *
 * 抽成纯函数是为了让“找不到时的指引里必须含 `Pi: Set Shell Path`”这条能被**无头断言**
 * （T16 自身是 advisory，不能只靠肉眼看那行字）。
 */
export function describeShellResolution(resolution: ShellResolution): string {
  if (resolution.error !== undefined) {
    return `找不到：${resolution.error}｜下一步：运行 Pi: Set Shell Path（候选 + 手动输入，会写进 settings.json 的 shellPath）`;
  }
  const source = resolution.configured === undefined ? "pi 自动探测" : "settings.json 的 shellPath";
  return `找到：${resolution.path}（来源：${source}）`;
}

export function shellSettingsPathOf(deps: ShellDeps): string {
  return join(deps.agentDir, "settings.json");
}

/**
 * 写穿 `shellPath`（写 **global** 作用域，F40），并**回读校验**（对齐 A19）。
 *
 * `setShellPath()` 只是把改动**排队**（`enqueueWrite`），所以必须先 `flush()` 再回读；
 * settings.json 是坏 JSON 时 `save()` 会静默早退，只有回读/`drainErrors()` 能发现。
 */
export async function setShellPathWrite(deps: ShellDeps & { path: string | undefined }): Promise<ShellWriteOutcome> {
  const settings = deps.pi.SettingsManager.create(deps.cwd, deps.agentDir, { projectTrusted: false });
  const thrown: string[] = [];
  try {
    settings.setShellPath(deps.path);
    await settings.flush();
  } catch (error) {
    thrown.push(error instanceof Error ? error.message : String(error));
  }
  const reported = [
    ...thrown,
    ...settings.drainErrors().map((entry) => `${entry.scope}${entry.path === undefined ? "" : ` ${entry.path}`}：${entry.error.message}`),
  ];
  const persisted = persistedShellPath(deps);
  if (reported.length > 0 || persisted !== deps.path) {
    const detail = `回读得到 shellPath=${persisted === undefined ? "(无)" : persisted}，期望 ${deps.path === undefined ? "(无)" : deps.path}`;
    const errors = reported.length === 0 ? "" : ` pi 报告的错误：${reported.join("；")}`;
    return { ok: false, message: `${shellSettingsPathOf(deps)} 没有真的被改写（${detail}）。${errors}` };
  }
  return { ok: true };
}

/** 文件里的真相：**全新** manager（与写路径同信任口径）读出来的 `shellPath`。 */
function persistedShellPath(deps: ShellDeps): string | undefined {
  return deps.pi.SettingsManager.create(deps.cwd, deps.agentDir, { projectTrusted: false }).getShellPath();
}
