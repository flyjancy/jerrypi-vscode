#!/usr/bin/env node
/**
 * .vsix 体积门禁 —— PLAN.md 要求发布包小于 30 MB，此处把它落成硬断言。
 *
 * 用法：node scripts/check-vsix.mjs <path-to-vsix>
 * 退出码：0 通过；1 文件缺失/为空/超限；2 用法错误。
 */
import fs from "node:fs";

const MAX_BYTES = 30 * 1024 * 1024;

/**
 * 必须在包里的文件（按相对 `extension/` 的路径）。
 *
 * 为什么连 S2 的新产物也要列进来：`.vscodeignore` 用的是 minimatch，
 * 一条写错的模式会让文件**静默消失**——扩展能装上、面板却白屏。
 * 这些断言是唯一能在打包阶段发现它的地方。
 */
const REQUIRED_FILES = [
  "pi-runtime/dist/bundle/index.js",
  "pi-runtime/node_modules/jiti/package.json",
  "pi-runtime/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
  "test-fixtures/ext-smoke/index.ts",
  // S2 新增：面板的三个产物 + 活动栏图标
  "dist/extension.js",
  "dist/webview.js",
  "dist/style.css",
  "media/jerrypi.svg",
];

const target = process.argv[2];
if (target === undefined || target.length === 0) {
  console.error("usage: node scripts/check-vsix.mjs <path-to-vsix>");
  process.exit(2);
}

let stats;
try {
  stats = fs.statSync(target);
} catch {
  console.error(`VSIX FAIL ${target} does not exist`);
  process.exit(1);
}

if (!stats.isFile()) {
  console.error(`VSIX FAIL ${target} is not a regular file`);
  process.exit(1);
}

const bytes = stats.size;
const megabytes = bytes / (1024 * 1024);
const percentOfGate = ((bytes / MAX_BYTES) * 100).toFixed(1);

if (bytes === 0) {
  console.error(`VSIX FAIL ${target} is empty`);
  process.exit(1);
}

if (bytes >= MAX_BYTES) {
  console.error(`VSIX FAIL ${target} is ${megabytes.toFixed(2)} MB, over the 30 MB gate`);
  process.exit(1);
}

// 解包后逐个断言必需文件（用 zip 中央目录，避免把整个包解到磁盘）。
const { execFileSync } = await import("node:child_process");
let entries;
try {
  entries = execFileSync("unzip", ["-Z1", target], { encoding: "utf8" }).split("\n");
} catch (error) {
  console.error(`VSIX FAIL 无法列出 ${target} 的内容：${error.message}`);
  process.exit(1);
}
const present = new Set(entries.map((line) => line.trim()));
const missing = REQUIRED_FILES.filter((file) => !present.has(`extension/${file}`));
if (missing.length > 0) {
  console.error(`VSIX FAIL 缺少必需文件：${missing.join(", ")}`);
  process.exit(1);
}
if (present.has("extension/dist/extension.js.map")) {
  console.log("VSIX NOTE 包里含 sourcemap（开发期可接受，正式发布前应确认）");
}

console.log(`VSIX OK ${target} ${megabytes.toFixed(2)} MB (${percentOfGate}% of the 30 MB gate), ${REQUIRED_FILES.length} required files present`);
