#!/usr/bin/env node
/**
 * .vsix 体积门禁 —— PLAN.md 要求发布包小于 30 MB，此处把它落成硬断言。
 *
 * 用法：node scripts/check-vsix.mjs <path-to-vsix>
 * 退出码：0 通过；1 文件缺失/为空/超限；2 用法错误。
 */
import fs from "node:fs";

const MAX_BYTES = 30 * 1024 * 1024;

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

console.log(`VSIX OK ${target} ${megabytes.toFixed(2)} MB (${percentOfGate}% of the 30 MB gate)`);
