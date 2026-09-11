#!/usr/bin/env node
/**
 * 隔离运行时校验器 —— PLAN.md 5.4 校验 ②（隔离 import）与 ⑦（隔离加载扩展）
 * 的**唯一**实现，也是依赖完整性的最终依据（校验 ① 只是快速门禁）。
 *
 * 用法：
 *   node scripts/verify-isolated-runtime.mjs --pi-runtime <dir> \
 *        [--fixture <index.ts>] [--expect-version <v>] [--keep-temp]
 *
 * 设计约束：
 *   - 只使用 node: 内置模块，以及 --pi-runtime 目录内的 bundle；
 *     绝不 import 仓库根 node_modules，也不依赖仓库其它文件。
 *   - 把 --pi-runtime 整个复制到 os.tmpdir() 下的临时目录再断言，因此
 *     「本地通过、VSIX 解包复跑失败」这类问题会在这里暴露。
 *   - 子进程的 cwd 是一个空目录，向上不存在任何 node_modules，
 *     保证 bundle 只能用它自带的 node_modules。
 *   - 逐行输出 `CHECK <id> PASS|FAIL <detail>`，末行 `VERIFY OK|FAILED`。
 *   - 退出码：0 全部通过；1 有检查失败；2 用法错误。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const RESULT_MARKER = "__JERRYPI_RESULT__";
const DEFAULT_FIXTURE_RELATIVE = ["test-fixtures", "ext-smoke", "index.ts"];
const BUNDLE_RELATIVE = ["dist", "bundle", "index.js"];
/**
 * 校验 ② 除了 bundle 本身，还要求这些「必须复制」的依赖能在隔离目录里真实加载。
 * jiti 由校验 ⑦（加载 TS 扩展）覆盖，photon 由校验 ④（wasm 文件）覆盖。
 */
const MUST_LOAD_MODULES = ["node_modules/@earendil-works/chord/dist/context/index.js"];
const CHILD_TIMEOUT_MS = 180_000;

function usageError(message) {
  console.error(`usage: node scripts/verify-isolated-runtime.mjs --pi-runtime <dir> [--fixture <index.ts>] [--expect-version <v>] [--keep-temp]`);
  console.error(`error: ${message}`);
  process.exit(EXIT_USAGE);
}

function parseArgs(argv) {
  const args = { keepTemp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--pi-runtime":
        args.piRuntime = argv[++index];
        break;
      case "--fixture":
        args.fixture = argv[++index];
        break;
      case "--expect-version":
        args.expectVersion = argv[++index];
        break;
      case "--keep-temp":
        args.keepTemp = true;
        break;
      case "--help":
      case "-h":
        console.log("usage: node scripts/verify-isolated-runtime.mjs --pi-runtime <dir> [--fixture <index.ts>] [--expect-version <v>] [--keep-temp]");
        process.exit(EXIT_OK);
        break;
      default:
        usageError(`unknown argument: ${token}`);
    }
  }
  return args;
}

/**
 * 生成在临时目录里执行的 runner 源码。
 * runner 同样只允许 node: 内置模块 + 目标 bundle。
 */
function buildRunnerSource({ bundleUrl, expectVersion, fixturePath, cwd, agentDir, extraModules }) {
  return `// 由 scripts/verify-isolated-runtime.mjs 生成，执行完即删除。
const BUNDLE_URL = ${JSON.stringify(bundleUrl)};
const EXPECT_VERSION = ${JSON.stringify(expectVersion)};
const FIXTURE_PATH = ${JSON.stringify(fixturePath)};
const CWD = ${JSON.stringify(cwd)};
const AGENT_DIR = ${JSON.stringify(agentDir)};
const EXTRA_MODULES = ${JSON.stringify(extraModules)};

const checks = [];
const record = (id, ok, detail) => checks.push({ id, ok, detail });
const message = (error) => (error && error.message ? error.message : String(error));

let bundle = undefined;
try {
  bundle = await import(BUNDLE_URL);
} catch (error) {
  record(2, false, \`bundle import failed: \${message(error)}\`);
}

if (bundle !== undefined) {
  try {
    const version = bundle.VERSION;
    const packageDir = bundle.getPackageDir();
    if (version !== EXPECT_VERSION) {
      record(2, false, \`VERSION=\${version} expected \${EXPECT_VERSION}\`);
    } else if (typeof packageDir !== "string" || !packageDir.endsWith("pi-runtime")) {
      record(2, false, \`getPackageDir()=\${packageDir}\`);
    } else {
      const failures = [];
      for (const extra of EXTRA_MODULES) {
        try {
          await import(extra.url);
        } catch (error) {
          failures.push(\`\${extra.label}: \${message(error)}\`);
        }
      }
      if (failures.length > 0) {
        record(2, false, \`dependency import failed: \${failures.join("; ")}\`);
      } else {
        record(2, true, \`VERSION=\${version} packageDir=\${packageDir} extra=[\${EXTRA_MODULES.map((entry) => entry.label).join(", ")}]\`);
      }
    }
  } catch (error) {
    record(2, false, \`bundle probe failed: \${message(error)}\`);
  }
}

try {
  if (bundle === undefined) {
    record(7, false, "skipped: bundle import failed");
  } else {
    const fs = await import("node:fs");
    if (!fs.existsSync(FIXTURE_PATH)) {
      record(7, false, \`fixture not found: \${FIXTURE_PATH}\`);
    } else {
      // 空 cwd + 空 agentDir：用户目录里的扩展错误不会混进来，
      // ⑦ 的失败只可能来自打包内容本身。
      const loaded = await bundle.discoverAndLoadExtensions([FIXTURE_PATH], CWD, AGENT_DIR);
      const errors = loaded.errors ?? [];
      if (errors.length > 0) {
        record(7, false, \`extension errors: \${JSON.stringify(errors)}\`);
      } else {
        const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
        const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
        const missing = [];
        if (!commands.includes("smoke")) missing.push("command:smoke");
        if (!tools.includes("smoke_tool")) missing.push("tool:smoke_tool");
        if (missing.length > 0) {
          record(7, false, \`missing \${missing.join(",")}; commands=[\${commands}] tools=[\${tools}]\`);
        } else {
          record(7, true, \`extensions=\${loaded.extensions.length} commands=[\${commands}] tools=[\${tools}]\`);
        }
      }
    }
  }
} catch (error) {
  record(7, false, \`extension load failed: \${error && error.message ? error.message : String(error)}\`);
}

process.stdout.write(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ checks }) + "\\n");
`;
}

function parseRunnerResult(child) {
  const stdout = child.stdout ?? "";
  const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_MARKER));
  if (line === undefined) {
    const tail = `${child.stderr ?? ""}${stdout}`.trim().split("\n").slice(-6).join(" | ");
    const reason = tail.length > 0 ? tail : `child exited with code ${child.status}`;
    return [
      { id: 2, ok: false, detail: `runner crashed: ${reason}` },
      { id: 7, ok: false, detail: "runner crashed before reporting" },
    ];
  }
  try {
    return JSON.parse(line.slice(RESULT_MARKER.length)).checks;
  } catch (error) {
    return [
      { id: 2, ok: false, detail: `unparsable runner output: ${error.message}` },
      { id: 7, ok: false, detail: "unparsable runner output" },
    ];
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.piRuntime === undefined) {
    usageError("--pi-runtime is required");
  }

  const runtimeDir = path.resolve(args.piRuntime);
  if (!fs.existsSync(runtimeDir) || !fs.statSync(runtimeDir).isDirectory()) {
    usageError(`--pi-runtime is not a directory: ${runtimeDir}`);
  }

  const versionFile = path.join(runtimeDir, ".version");
  let expectVersion = args.expectVersion;
  if (expectVersion === undefined) {
    if (!fs.existsSync(versionFile)) {
      usageError(`missing ${versionFile}; pass --expect-version explicitly`);
    }
    expectVersion = fs.readFileSync(versionFile, "utf8").trim();
    if (expectVersion.length === 0) {
      usageError(`empty ${versionFile}; pass --expect-version explicitly`);
    }
  }

  const fixturePath = path.resolve(
    args.fixture ?? path.join(runtimeDir, "..", ...DEFAULT_FIXTURE_RELATIVE),
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-verify-"));
  let exitCode = EXIT_FAIL;

  try {
    const tempRuntime = path.join(tempRoot, "pi-runtime");
    fs.cpSync(runtimeDir, tempRuntime, { recursive: true, dereference: true });

    const cwd = path.join(tempRoot, "work");
    const agentDir = path.join(tempRoot, "agent");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const bundleUrl = pathToFileURL(path.join(tempRuntime, ...BUNDLE_RELATIVE)).href;
    const extraModules = MUST_LOAD_MODULES.map((relative) => ({
      label: relative,
      url: pathToFileURL(path.join(tempRuntime, ...relative.split("/"))).href,
    }));
    const runnerPath = path.join(tempRoot, "__jerrypi_runner__.mjs");
    fs.writeFileSync(
      runnerPath,
      buildRunnerSource({ bundleUrl, expectVersion, fixturePath, cwd, agentDir, extraModules }),
      "utf8",
    );

    // 清掉可能从外部注入的解析开关，保证隔离性。
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;

    const child = spawnSync(process.execPath, [runnerPath], {
      cwd,
      env,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });

    const checks = parseRunnerResult(child);
    let allPassed = checks.length > 0;

    for (const check of [...checks].sort((a, b) => a.id - b.id)) {
      console.log(`CHECK ${check.id} ${check.ok ? "PASS" : "FAIL"} ${check.detail}`);
      if (!check.ok) {
        allPassed = false;
      }
    }

    if (allPassed) {
      console.log("VERIFY OK");
      exitCode = EXIT_OK;
    } else {
      console.error(`VERIFY FAILED (runtime: ${runtimeDir})`);
      exitCode = EXIT_FAIL;
    }
  } catch (error) {
    console.error(`VERIFY FAILED (internal error): ${error.message}`);
    exitCode = EXIT_FAIL;
  } finally {
    if (args.keepTemp) {
      console.log(`TEMP KEPT: ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  process.exit(exitCode);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}

export { buildRunnerSource, parseRunnerResult };
