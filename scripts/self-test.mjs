#!/usr/bin/env node
/**
 * 最小自检 —— 不引入测试框架，只用 node:assert 风格的手写断言 + 子进程。
 *
 * 覆盖 6 个用例：
 *   1. 正用例：`npm run sync` 成功，且 pi-runtime/.version 等于 package.json 的钉版；
 *   2. 负用例：裸依赖扫描对未知包抛错（同时对已知包放行）；
 *   3. 负用例：删掉 jiti 后，隔离校验必须非零退出（依赖完整性）；
 *   4. 负用例：往 pi-runtime/ 塞一个陈旧文件，再次 sync 后它必须消失（幂等）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const RUNTIME_DIR = path.join(REPO_ROOT, "pi-runtime");
const VERSION_FILE = path.join(RUNTIME_DIR, ".version");
const SYNC_SCRIPT = path.join(SCRIPT_DIR, "sync-pi-runtime.mjs");
const VERIFY_SCRIPT = path.join(SCRIPT_DIR, "verify-isolated-runtime.mjs");
const FIXTURE_PATH = path.join(REPO_ROOT, "test-fixtures", "ext-smoke", "index.ts");
const RESOURCES_TS = path.join(REPO_ROOT, "src", "pi", "resources.ts");
const PROTOCOL_CHECK = path.join(SCRIPT_DIR, "protocol-check.mjs");
const RENDER_CHECK = path.join(SCRIPT_DIR, "render-xss-check.mjs");
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

const TOTAL = 6;
let passed = 0;

function pass(id, name, detail) {
  passed += 1;
  console.log(`SELF-TEST ${id}/${TOTAL} PASS ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(id, name, detail) {
  console.error(`SELF-TEST ${id}/${TOTAL} FAIL ${name} — ${detail}`);
  console.error(`SELF-TEST ABORTED (${passed}/${TOTAL} passed before failure)`);
  process.exit(1);
}

function runSync(stdio) {
  return spawnSync(process.execPath, [SYNC_SCRIPT], { cwd: REPO_ROOT, stdio, encoding: "utf8" });
}

function testSyncProducesVersion() {
  const result = runSync("inherit");
  if (result.status !== 0) {
    fail(1, "sync succeeds", `exit code ${result.status}`);
  }
  if (!fs.existsSync(VERSION_FILE)) {
    fail(1, "sync writes pi-runtime/.version", `${VERSION_FILE} does not exist`);
  }
  const written = fs.readFileSync(VERSION_FILE, "utf8").trim();
  const repoPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const pinned = repoPackage.devDependencies?.[PI_PACKAGE_NAME];
  if (written !== pinned) {
    fail(1, "version single source of truth", `.version=${written} but package.json pins ${pinned}`);
  }
  pass(1, "sync succeeds and writes .version", `${written} (single source: package.json)`);
}

async function testBareImportGate() {
  const syncModule = await import(pathToFileURL(SYNC_SCRIPT).href);

  let rejected = false;
  try {
    syncModule.scanBareImports('import"totally-unknown-pkg";', "<self-test-negative>");
  } catch {
    rejected = true;
  }
  if (!rejected) {
    fail(2, "scanBareImports rejects unknown packages", 'import"totally-unknown-pkg" was accepted');
  }

  // 正向对照：已知依赖 + node 内置必须放行。
  try {
    syncModule.scanBareImports('import"jiti";import"node:fs";import"@silvia-odwyer/photon-node";');
  } catch (error) {
    fail(2, "scanBareImports allows known packages", error.message);
  }

  pass(2, "scanBareImports rejects unknown and allows known specifiers");
}

function testMissingDependencyFailsVerification() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-self-test-"));
  try {
    const tempRuntime = path.join(tempRoot, "pi-runtime");
    fs.cpSync(RUNTIME_DIR, tempRuntime, { recursive: true, dereference: true });
    fs.rmSync(path.join(tempRuntime, "node_modules", "jiti"), { recursive: true, force: true });

    const result = spawnSync(
      process.execPath,
      [VERIFY_SCRIPT, "--pi-runtime", tempRuntime, "--fixture", FIXTURE_PATH],
      { encoding: "utf8" },
    );

    if (result.status === 0) {
      fail(3, "verification fails without jiti", "verify exited 0 even though jiti was removed");
    }
    if (!`${result.stdout}${result.stderr}`.includes("CHECK 7 FAIL")) {
      fail(
        3,
        "verification fails without jiti",
        `expected "CHECK 7 FAIL" in output, got: ${`${result.stdout}${result.stderr}`.trim().split("\n").slice(-3).join(" | ")}`,
      );
    }

    pass(3, "verification fails when a dependency is missing", `exit code ${result.status}, CHECK 7 FAIL`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testIdempotentSync() {
  const staleFile = path.join(RUNTIME_DIR, "stale.js");
  fs.writeFileSync(staleFile, "// must not survive the next sync\n", "utf8");

  const result = runSync("pipe");
  if (result.status !== 0) {
    fail(
      4,
      "re-sync succeeds",
      `exit code ${result.status}: ${`${result.stdout}${result.stderr}`.trim().split("\n").slice(-3).join(" | ")}`,
    );
  }
  if (fs.existsSync(staleFile)) {
    fail(4, "sync is idempotent", "stale.js survived a full sync (delete-then-rebuild broken)");
  }

  pass(4, "sync is idempotent", "pre-existing stale files are removed");
}

async function testResourceListDrift() {
  // 资源清单在两处存在：
  //   - scripts/sync-pi-runtime.mjs（打包期校验，REQUIRED_FILES / REQUIRED_DIRS）
  //   - src/pi/resources.ts（随扩展发布，自测 T2 用）
  // scripts/ 不进 .vsix，所以无法合并成一份；这里用一致性用例盯住它们。
  const syncModule = await import(pathToFileURL(SYNC_SCRIPT).href);
  const source = fs.readFileSync(RESOURCES_TS, "utf8");
  const shippedFiles = extractStringArray(source, "REQUIRED_RESOURCE_FILES");
  const shippedDirs = extractStringArray(source, "REQUIRED_RESOURCE_DIRS");

  const sameSet = (left, right) =>
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

  if (!sameSet(shippedFiles, syncModule.REQUIRED_FILES)) {
    fail(
      5,
      "resource file lists match",
      `src/pi/resources.ts=${JSON.stringify([...shippedFiles].sort())} vs sync=${JSON.stringify([...syncModule.REQUIRED_FILES].sort())}`,
    );
  }
  if (!sameSet(shippedDirs, syncModule.REQUIRED_DIRS)) {
    fail(
      5,
      "resource directory lists match",
      `src/pi/resources.ts=${JSON.stringify(shippedDirs)} vs sync=${JSON.stringify(syncModule.REQUIRED_DIRS)}`,
    );
  }

  pass(
    5,
    "resource lists match between shipped and packaging checks",
    `${shippedFiles.length} files + ${shippedDirs.length} dirs`,
  );
}

/** 从 TS 源码里取「字符串字面量数组」——两份清单都刻意写成这个形状。 */
function extractStringArray(source, exportName) {
  const match = source.match(new RegExp(`export const ${exportName}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (match === null) {
    fail(5, "resource list is parseable", `cannot find ${exportName} in src/pi/resources.ts`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function testUnitChecks() {
  // S2 的纯函数层（serialize 的 id 规则、urlPolicy 的白名单、渲染安全）由单独脚本检查，
  // 这里只保证它们**真的会被跑**——漂移的检查脚本等于没有检查。
  const summaries = [];
  for (const [name, script] of [
    ["protocol", PROTOCOL_CHECK],
    ["render", RENDER_CHECK],
  ]) {
    const result = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.status !== 0) {
      fail(6, `${name} checks pass`, output.split("\n").slice(-3).join(" | "));
    }
    summaries.push(output.split("\n").slice(-1)[0]);
  }
  pass(6, "protocol and render checks pass", summaries.join(" | "));
}

async function main() {
  console.log(`[self-test] pi runtime: ${RUNTIME_DIR}`);
  testSyncProducesVersion();
  await testBareImportGate();
  testMissingDependencyFailsVerification();
  testIdempotentSync();
  await testResourceListDrift();
  testUnitChecks();
  console.log(`SELF-TEST OK (${passed}/${TOTAL})`);
}

await main();
