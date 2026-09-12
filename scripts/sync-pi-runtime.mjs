#!/usr/bin/env node
/**
 * 把 pi 运行时同步到 ./pi-runtime/，并执行 PLAN.md 5.4 的机械校验。
 *
 * 本脚本是 `npm run sync` 的**唯一**入口，职责：
 *   1. 版本单一来源：从 package.json 的精确钉版读「预期版本」，与已解析 pi 包
 *      的实际版本**只比较一次**，然后写入 pi-runtime/.version（校验 ⑥）；
 *   2. 幂等：每次运行等价于「删除 pi-runtime/ 后重建」，不做增量复制；
 *   3. 失败清理：任一环节失败（含 Ctrl-C）都删掉半成品 pi-runtime/，
 *      避免下次运行复用不完整结果造成假通过；
 *   4. 执行校验 ①③④⑤（快速/结构门禁）+ 相对资源引用扫描（advisory）；
 *   5. 通过子进程编排校验 ②⑦ —— 它们的实现在 verify-isolated-runtime.mjs，
 *      本脚本不重复实现。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const RUNTIME_DIR = path.join(REPO_ROOT, "pi-runtime");
const VERSION_FILE = path.join(RUNTIME_DIR, ".version");
const VERIFY_SCRIPT = path.join(SCRIPT_DIR, "verify-isolated-runtime.mjs");
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PIN_FIELD = `devDependencies["${PI_PACKAGE_NAME}"]`;
const ADVISORY_LIMIT = 20;

/** 必须随 pi-runtime 一起复制、且必须能被解析到的裸依赖。 */
export const MUST_COPY_SPECIFIERS = ["jiti", "@earendil-works/chord/context", "@silvia-odwyer/photon-node"];
/** 允许缺失：可选依赖，运行时被 try/catch 或能力探测包住。 */
export const ALLOWED_MISSING_SPECIFIERS = ["bufferutil", "utf-8-validate", "supports-color", "@mariozechner/clipboard"];
/** 仅出现在字符串里（懒加载的签名实现），不会被解析。 */
export const STRING_ONLY_SPECIFIERS = ["@aws-sdk/signature-v4-crt"];

/**
 * pi 只 import chord 的 context 入口；chord 的 bundler（chord/dist/node/bundle.js）
 * 才需要 esbuild，而它从不会被加载，因此 chord 自带的 node_modules（约 11 MB）不进包。
 * 若 pi 升级后开始引用其它子路径，校验 ① 会直接失败（见 checkBareImports）。
 */
export const ALLOWED_CHORD_SUBPATHS = new Set(["@earendil-works/chord/context"]);

const KNOWN_SPECIFIERS = new Set([
  ...MUST_COPY_SPECIFIERS,
  ...ALLOWED_MISSING_SPECIFIERS,
  ...STRING_ONLY_SPECIFIERS,
]);

/** 裸标识符形状：排除 "./x"、"file://x"、"node:fs" 这类写法。 */
const SPECIFIER_SHAPE = /^[A-Za-z@][A-Za-z0-9._@/-]*$/;

const IMPORT_PATTERNS = [
  /from"([^"]+)"/g,
  /import"([^"]+)"/g,
  /import\("([^"]+)"\)/g,
  /\b[A-Za-z0-9_$]*[Rr]equire[A-Za-z0-9_$]*\("([^"]+)"\)/g,
];

const RELATIVE_REFERENCE_PATTERNS = [
  /new URL\("(\.[^"]*)"\s*,\s*import\.meta\.url\)/g,
  /readFileSync\("(\.[^"]*)"\)/g,
  /\b[A-Za-z0-9_$]*[Rr]equire[A-Za-z0-9_$]*\("(\.[^"]*)"\)/g,
];

// 复制清单：必须与 PLAN.md 5.4 一致。
const COPY_ENTRIES = [
  "dist/bundle",
  "dist/modes/interactive/theme",
  "dist/core/export-html",
  "docs",
  "examples",
  "README.md",
  "package.json",
];

export const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "dist/bundle/index.js",
  "dist/bundle/cli.js",
  "dist/bundle/rpc-entry.js",
  "dist/bundle/chunks/image-resize-worker.js",
  "dist/modes/interactive/theme/dark.json",
  "dist/modes/interactive/theme/light.json",
  "dist/core/export-html/template.html",
  "node_modules/@earendil-works/chord/dist/context/index.js",
  "node_modules/jiti/package.json",
  "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
];

export const REQUIRED_DIRS = ["docs", "examples"];

// ---------------------------------------------------------------------------
// 校验 ①：裸依赖扫描（快速门禁，证据层级见 docs/S0-plan.md §1.2）
// ---------------------------------------------------------------------------

/** 收集源码中出现过的裸 module specifier（已按形状过滤）。 */
export function collectBareImports(source) {
  const specifiers = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (SPECIFIER_SHAPE.test(match[1])) {
        specifiers.add(match[1]);
      }
    }
  }
  return [...specifiers].sort();
}

/** 返回既不是 node 内置、也不在白名单里的 specifier。 */
export function findUnknownBareImports(source) {
  return collectBareImports(source).filter(
    (specifier) => !isBuiltin(specifier) && !KNOWN_SPECIFIERS.has(specifier),
  );
}

/**
 * 扫一个文件；发现未知裸依赖即抛错。
 * 导出以便 scripts/self-test.mjs 直接做负用例。
 */
export function scanBareImports(source, label = "<inline>") {
  const unknown = findUnknownBareImports(source);
  if (unknown.length > 0) {
    throw new Error(`unknown bare import(s) in ${label}: ${unknown.join(", ")}`);
  }
  return collectBareImports(source);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function check(id, detail) {
  console.log(`CHECK ${id} PASS ${detail}`);
}

function checkFailed(id, detail) {
  console.error(`CHECK ${id} FAIL ${detail}`);
  throw new Error(detail);
}

function walkPaths(root) {
  const collected = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stats = fs.lstatSync(full);
      collected.push({ path: full, stats });
      if (stats.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return collected;
}

function copyTree(from, to, options = {}) {
  if (!fs.existsSync(from)) {
    throw new Error(`source path is missing: ${from}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true, ...options });
}

function removeRuntimeDir() {
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
}

/** 从任意入口文件向上找 name 匹配的 package.json，返回包根目录。 */
function findPackageRoot(startPath, expectedName) {
  let current = path.dirname(startPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        if (readJson(candidate).name === expectedName) {
          return current;
        }
      } catch {
        // 损坏的 package.json：继续向上找
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * 解析包目录。各包 exports 的开放程度不同（pi 不导出 ./package.json，
 * chord 连 "." 都不导出），所以按三级策略降级，而不是只赌一种：
 *   1. import.meta.resolve(主入口) —— 处理有 import 条件的包；
 *   2. createRequire(fromFile).resolve("<name>/package.json") —— 在 pi 的上下文里解析；
 *   3. 直接拼 node_modules 路径 —— 保底。
 */
function resolvePackageDir(name, { fromFile, searchBases = [] } = {}) {
  try {
    const resolvedUrl = import.meta.resolve(name);
    const root = findPackageRoot(fileURLToPath(resolvedUrl), name);
    if (root !== undefined) return root;
  } catch {
    // 该包没有可从本脚本解析的入口，走下一策略
  }

  if (fromFile !== undefined) {
    try {
      const requireFrom = createRequire(fromFile);
      const resolved = requireFrom.resolve(`${name}/package.json`);
      const root = findPackageRoot(resolved, name);
      if (root !== undefined) return root;
    } catch {
      // exports 不开放 ./package.json，走下一策略
    }
  }

  for (const base of searchBases) {
    const candidate = path.join(base, ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error(`cannot resolve package "${name}"`);
}

function resolvePiDir() {
  return resolvePackageDir(PI_PACKAGE_NAME, {
    fromFile: path.join(REPO_ROOT, "package.json"),
    searchBases: [path.join(REPO_ROOT, "node_modules")],
  });
}

function resolveDependencyDir(piDir, name) {
  return resolvePackageDir(name, {
    fromFile: path.join(piDir, "package.json"),
    searchBases: [path.join(piDir, "node_modules"), path.join(REPO_ROOT, "node_modules")],
  });
}

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

function resolveVersions() {
  const repoPackage = readJson(path.join(REPO_ROOT, "package.json"));
  const pinned = repoPackage.devDependencies?.[PI_PACKAGE_NAME];
  if (typeof pinned !== "string" || pinned.length === 0) {
    throw new Error(`package.json is missing an exact pin at ${PI_PIN_FIELD}`);
  }

  const piDir = resolvePiDir();
  const actual = readJson(path.join(piDir, "package.json")).version;
  if (actual !== pinned) {
    throw new Error(
      `pi version mismatch: package.json pins ${pinned}, resolved package is ${actual} (${piDir})`,
    );
  }

  console.log(`[sync] pi ${actual} <- ${piDir}`);
  return { pinned: actual, piDir };
}

function copyRuntime(piDir) {
  removeRuntimeDir();
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  for (const entry of COPY_ENTRIES) {
    copyTree(path.join(piDir, entry), path.join(RUNTIME_DIR, entry));
  }

  const runtimeNodeModules = path.join(RUNTIME_DIR, "node_modules");
  const chordSource = resolveDependencyDir(piDir, "@earendil-works/chord");
  copyTree(chordSource, path.join(runtimeNodeModules, "@earendil-works", "chord"), {
    filter: (source) => {
      const relative = path.relative(chordSource, source);
      if (relative === "") return true;
      const segments = relative.split(path.sep);
      // src/ 是 TS 源码，不进包；
      // node_modules/ 是 esbuild 平台二进制，只有 chord 的 bundler 入口才会用到。
      if (segments.includes("src") || segments.includes("node_modules")) return false;
      if (relative.endsWith(".map")) return false;
      return true;
    },
  });
  copyTree(resolveDependencyDir(piDir, "jiti"), path.join(runtimeNodeModules, "jiti"));
  copyTree(
    resolveDependencyDir(piDir, "@silvia-odwyer/photon-node"),
    path.join(runtimeNodeModules, "@silvia-odwyer", "photon-node"),
  );
}

// ---------------------------------------------------------------------------
// 结构校验 ③④⑤
// ---------------------------------------------------------------------------

function checkNoNativeModules() {
  const offenders = walkPaths(RUNTIME_DIR).filter(({ path: file }) => file.endsWith(".node"));
  if (offenders.length > 0) {
    checkFailed(3, `found native addon(s): ${offenders.map(({ path: f }) => path.relative(RUNTIME_DIR, f)).join(", ")}`);
  }
  check(3, "no native .node addons");
}

function checkRequiredPaths() {
  for (const relative of REQUIRED_FILES) {
    const full = path.join(RUNTIME_DIR, relative);
    if (!fs.existsSync(full)) {
      checkFailed(4, `required file is missing: ${relative}`);
    }
    const stats = fs.lstatSync(full);
    if (stats.isSymbolicLink()) {
      checkFailed(4, `required file is a symlink: ${relative}`);
    }
    if (!stats.isFile()) {
      checkFailed(4, `required path is not a regular file: ${relative}`);
    }
    if (stats.size === 0) {
      checkFailed(4, `required file is empty: ${relative}`);
    }
    fs.accessSync(full, fs.constants.R_OK);
  }

  for (const relative of REQUIRED_DIRS) {
    const full = path.join(RUNTIME_DIR, relative);
    if (!fs.existsSync(full)) {
      checkFailed(4, `required directory is missing: ${relative}`);
    }
    const stats = fs.lstatSync(full);
    if (stats.isSymbolicLink()) {
      checkFailed(4, `required directory is a symlink: ${relative}`);
    }
    if (!stats.isDirectory()) {
      checkFailed(4, `required path is not a directory: ${relative}`);
    }
    if (fs.readdirSync(full).length === 0) {
      checkFailed(4, `required directory is empty: ${relative}`);
    }
  }

  check(4, `${REQUIRED_FILES.length} required files + ${REQUIRED_DIRS.length} required directories are present, readable and non-empty`);
}

function checkNoSourceOrSymlinks() {
  const sourceDir = path.join(RUNTIME_DIR, "src");
  if (fs.existsSync(sourceDir)) {
    checkFailed(5, "pi-runtime/src exists; pi would resolve theme/export paths against src instead of dist");
  }

  const symlinks = walkPaths(RUNTIME_DIR).filter(({ stats }) => stats.isSymbolicLink());
  if (symlinks.length > 0) {
    checkFailed(5, `found symlink(s): ${symlinks.map(({ path: f }) => path.relative(RUNTIME_DIR, f)).join(", ")}`);
  }

  check(5, "no src/ directory and no symlinks");
}

// ---------------------------------------------------------------------------
// 校验 ①：扫描 bundle
// ---------------------------------------------------------------------------

function checkBareImports() {
  const bundleDir = path.join(RUNTIME_DIR, "dist", "bundle");
  const files = walkPaths(bundleDir)
    .filter(({ path: file, stats }) => stats.isFile() && file.endsWith(".js"))
    .map(({ path: file }) => file);

  let scanned = 0;
  const externals = new Set();
  for (const file of files) {
    const specifiers = scanBareImports(fs.readFileSync(file, "utf8"), path.relative(RUNTIME_DIR, file));
    scanned += specifiers.length;
    for (const specifier of specifiers) {
      if (isBuiltin(specifier)) {
        continue;
      }
      externals.add(specifier);
      if (specifier.startsWith("@earendil-works/chord")) {
        if (!ALLOWED_CHORD_SUBPATHS.has(specifier)) {
          checkFailed(
            1,
            `bundle references "${specifier}", but pi-runtime only ships chord/dist/context ` +
              "(chord's own node_modules are stripped). Update the copy list in " +
              "scripts/sync-pi-runtime.mjs and docs/S0-plan.md §5.2, then re-run.",
          );
        }
      }
    }
  }

  check(1, `${files.length} bundle files, ${scanned} specifiers, ${externals.size} external, all known`);
}

// ---------------------------------------------------------------------------
// 相对资源引用扫描（advisory，不失败）
// ---------------------------------------------------------------------------

function collectRelativeReferences(source) {
  const references = new Set();
  for (const pattern of RELATIVE_REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      references.add(match[1]);
    }
  }
  return [...references];
}

function reportAdvisories() {
  const bundleDir = path.join(RUNTIME_DIR, "dist", "bundle");
  const files = walkPaths(bundleDir)
    .filter(({ path: file, stats }) => stats.isFile() && file.endsWith(".js"))
    .map(({ path: file }) => file);

  const missing = [];
  for (const file of files) {
    for (const reference of collectRelativeReferences(fs.readFileSync(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), reference);
      if (!fs.existsSync(resolved)) {
        missing.push(`${reference} (in ${path.relative(RUNTIME_DIR, file)})`);
      }
    }
  }

  if (missing.length === 0) {
    console.log("ADVISORY no unresolved relative resource references in bundle");
    return;
  }

  for (const entry of missing.slice(0, ADVISORY_LIMIT)) {
    console.log(`ADVISORY unresolved relative reference: ${entry}`);
  }
  if (missing.length > ADVISORY_LIMIT) {
    console.log(`ADVISORY ... and ${missing.length - ADVISORY_LIMIT} more`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function sync() {
  const { pinned, piDir } = resolveVersions();

  copyRuntime(piDir);
  console.log(`[sync] copied pi runtime -> ${path.relative(REPO_ROOT, RUNTIME_DIR)}/`);

  checkBareImports();
  checkNoNativeModules();
  checkRequiredPaths();
  checkNoSourceOrSymlinks();
  reportAdvisories();

  fs.writeFileSync(VERSION_FILE, `${pinned}\n`, "utf8");
  check(6, `pi-runtime/.version = ${pinned}`);

  // 校验 ②⑦ 的唯一实现在 verify-isolated-runtime.mjs；此处只做编排。
  // 失败时 execFileSync 抛错，由 main() 统一清理半成品并退出非零。
  execFileSync(process.execPath, [VERIFY_SCRIPT, "--pi-runtime", RUNTIME_DIR], {
    stdio: "inherit",
  });
}

function main() {
  const startedAt = Date.now();

  const abort = (signal) => {
    removeRuntimeDir();
    console.error(`SYNC ABORTED (${signal})`);
    process.exit(130);
  };
  process.on("SIGINT", () => abort("SIGINT"));
  process.on("SIGTERM", () => abort("SIGTERM"));

  try {
    sync();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`SYNC OK (${seconds}s)`);
  } catch (error) {
    removeRuntimeDir();
    console.error(`SYNC FAILED: ${error.message}`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
