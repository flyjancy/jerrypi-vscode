// pi 运行时的唯一入口。
//
// 铁律：**绝不静态 import pi**。类型可以来自 devDependency（编译期擦除），
// 运行期只能 `import()` 扩展目录里的 `pi-runtime/dist/bundle/index.js`。
// 这条由 esbuild.mjs 的 onResolve 守卫强制执行。
//
// 为什么要做导出名断言：`typeof import("@earendil-works/pi-coding-agent")` 解析的是
// 包的 `dist/index.d.ts`，而实际加载的是 `dist/bundle/index.js` —— **两者不是同一个文件**，
// 导出面没有静态保证。而且 `pi-runtime/package.json` 的 main/types/exports 全部指向
// 不存在的文件（我们只打包了 bundle/theme/export-html/docs/examples），
// 所以运行期必须显式指向 bundle。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 编译期类型：来自 devDependency，不会被 esbuild 打进产物。 */
export type PiModule = typeof import("@earendil-works/pi-coding-agent");

export const RUNTIME_DIR = "pi-runtime";
export const RUNTIME_VERSION_FILE = ".version";
export const RUNTIME_BUNDLE_SEGMENTS = ["dist", "bundle", "index.js"] as const;

/**
 * 代码真正用到的导出名。**只列用得到的**——多列一个就是新的漂移源。
 * 断言失败 → `E_MISSING_EXPORTS`。
 */
export const REQUIRED_PI_EXPORTS = [
  "VERSION",
  "getPackageDir",
  "getAgentDir",
  "getShellConfig",
  "ModelRuntime",
  "SessionManager",
  "SettingsManager",
  "createAgentSessionServices",
  "createAgentSessionFromServices",
  "createAgentSessionRuntime",
  "resizeImage",
  "createWriteToolDefinition",
] as const;

/** 带短错误码的加载失败，便于自测输出与归因。 */
export class PiLoadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PiLoadError";
    this.code = code;
  }
}

export function runtimePath(extensionPath: string, ...segments: string[]): string {
  return join(extensionPath, RUNTIME_DIR, ...segments);
}

/** 读取 `pi-runtime/.version`；缺失或为空返回 undefined（不抛错）。 */
export async function readRuntimeVersion(extensionPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(runtimePath(extensionPath, RUNTIME_VERSION_FILE), "utf8");
    const version = raw.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

let cached: Promise<PiModule> | undefined;

/**
 * 加载 pi 运行时（结果缓存）。
 *
 * 失败时**不缓存 rejected promise**：否则一次瞬时失败会永久堵死后续所有调用
 * （包括"重载运行时"这条恢复路径），还会产生未处理拒绝的噪音。
 */
export function loadPi(extensionPath: string): Promise<PiModule> {
  if (cached === undefined) {
    const attempt = loadPiUncached(extensionPath);
    cached = attempt;
    void attempt.catch(() => {
      if (cached === attempt) {
        cached = undefined;
      }
    });
  }
  return cached;
}

/** 丢弃缓存，供"重载运行时"使用。下一次 loadPi() 会重新 import。 */
export function reloadPi(): void {
  cached = undefined;
}

async function loadPiUncached(extensionPath: string): Promise<PiModule> {
  const expectedVersion = await readRuntimeVersion(extensionPath);
  if (expectedVersion === undefined) {
    throw new PiLoadError(
      "E_RUNTIME_MISSING",
      `${RUNTIME_DIR}/${RUNTIME_VERSION_FILE} 缺失，pi-runtime 尚未同步（先运行 npm run sync）`,
    );
  }

  const bundlePath = runtimePath(extensionPath, ...RUNTIME_BUNDLE_SEGMENTS);
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(bundlePath).href);
  } catch (error) {
    throw new PiLoadError("E_IMPORT", `动态 import pi bundle 失败：${describe(error)}（${bundlePath}）`);
  }

  const pi = loaded as PiModule;

  if (pi.VERSION !== expectedVersion) {
    throw new PiLoadError(
      "E_VERSION",
      `版本不一致：bundle=${String(pi.VERSION)} 期望=${expectedVersion}`,
    );
  }

  const packageDir = pi.getPackageDir();
  if (typeof packageDir !== "string" || !packageDir.endsWith(RUNTIME_DIR)) {
    throw new PiLoadError("E_PACKAGE_DIR", `getPackageDir() 未指向 ${RUNTIME_DIR}：${String(packageDir)}`);
  }

  const missing = REQUIRED_PI_EXPORTS.filter((name) => (pi as Record<string, unknown>)[name] === undefined);
  if (missing.length > 0) {
    throw new PiLoadError("E_MISSING_EXPORTS", `bundle 缺少必需导出：${missing.join(", ")}`);
  }

  return pi;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
