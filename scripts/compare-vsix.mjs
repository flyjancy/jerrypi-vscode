#!/usr/bin/env node
/**
 * 核对"Marketplace 上已发布的那份"与"本地构建的那份"内容是否一致。
 *
 * 为什么不能直接比字节：**.vsix 的字节不可复现** —— zip 里存的是文件 mtime，
 * 而 `dist/*.js` 每次重新构建 mtime 都变。实测：同一棵树重建后 338 个文件
 * 逐个字节相同，但整个 .vsix 的 SHA-256 不同（见 docs/S3-plan.md §12.11）。
 *
 * 还有第二个坑：**从 Marketplace 直接 curl 下来的是 gzip 流**
 * （响应头不带 Content-Encoding，curl 不会自动解压），`file` 会告诉你
 * `original size modulo 2^32`。本脚本会嗅探魔数并自动解压。
 *
 * 用法：
 *   node scripts/compare-vsix.mjs                 # 版本取 package.json，比本地产物
 *   node scripts/compare-vsix.mjs 0.1.5           # 指定版本
 *   node scripts/compare-vsix.mjs 0.1.5 <path>    # 指定本地产物路径
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHER = "flyjancy";
const EXTENSION = "jerrypi";

function fail(message) {
  console.log(`VSIX-COMPARE FAILED: ${message}`);
  process.exit(1);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gunzipIfNeeded(file) {
  const magic = fs.readFileSync(file).subarray(0, 2);
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return file;
  const out = `${file}.unzipped`;
  const result = spawnSync("gunzip", ["-c", file], { stdio: ["ignore", fs.openSync(out, "w"), "inherit"] });
  if (result.status !== 0) fail("gunzip 失败");
  console.log(`   （下载的是 gzip 流，已解压）`);
  return out;
}

function extract(vsix, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync("unzip", ["-q", vsix, "-d", dir], { encoding: "utf8" });
  if (result.status !== 0) fail(`unzip 失败：${(result.stderr ?? "").trim().slice(0, 200)}`);
}

function listFiles(dir) {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk("");
  return files.sort();
}

const version = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
const localPath = process.argv[3] ?? path.join(REPO_ROOT, `jerrypi-${version}.vsix`);
if (!fs.existsSync(localPath)) fail(`找不到本地产物：${localPath}`);

const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${PUBLISHER}/vsextensions/${EXTENSION}/${version}/vspackage`;
console.log(`本地：${localPath}（${fs.statSync(localPath).size} 字节）`);
console.log(`市场：${url}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-compare-"));
const downloaded = path.join(tmp, `mp-${version}.vsix`);
const response = await fetch(url);
if (!response.ok) fail(`下载失败：HTTP ${response.status}`);
fs.writeFileSync(downloaded, Buffer.from(await response.arrayBuffer()));
const rawSize = fs.statSync(downloaded).size;
const unpacked = gunzipIfNeeded(downloaded);
console.log(`   （下载 ${rawSize} 字节 → 解压后 ${fs.statSync(unpacked).size} 字节）`);

extract(unpacked, path.join(tmp, "mp"));
extract(localPath, path.join(tmp, "local"));

const mpFiles = listFiles(path.join(tmp, "mp"));
const localFiles = listFiles(path.join(tmp, "local"));

const onlyMp = mpFiles.filter((f) => !localFiles.includes(f));
const onlyLocal = localFiles.filter((f) => !mpFiles.includes(f));
if (onlyMp.length > 0 || onlyLocal.length > 0) {
  fail(`文件列表不同 —— 只在市场：${onlyMp.slice(0, 5).join(", ") || "无"}；只在本地：${onlyLocal.slice(0, 5).join(", ") || "无"}`);
}

const different = [];
for (const file of localFiles) {
  const a = sha256(path.join(tmp, "mp", file));
  const b = sha256(path.join(tmp, "local", file));
  if (a !== b) different.push(file);
}
if (different.length > 0) fail(`内容不同（${different.length} 个）：${different.slice(0, 5).join(", ")}`);

const archiveSame = sha256(unpacked) === sha256(localPath);
console.log(`\n✅ 内容一致：${localFiles.length} 个文件逐个字节相同`);
console.log(`   整体 .vsix 字节：${archiveSame ? "相同" : "不同（zip 存 mtime，不可复现；这不影响内容一致性）"}`);
console.log(`   本地 .vsix SHA-256: ${sha256(localPath).slice(0, 32)}…`);
console.log(`\nVSIX-COMPARE OK ${version}`);

// 留档：把"确证已发布"的那一份存到仓库外，便于将来核对（0.1.5 之前没留档）
const archiveDir = path.join(os.homedir(), "jerrypi-releases");
fs.mkdirSync(archiveDir, { recursive: true });
const archived = path.join(archiveDir, `jerrypi-${version}.vsix`);
if (!fs.existsSync(archived)) {
  fs.copyFileSync(localPath, archived);
  console.log(`   已留档：${archived}`);
} else if (sha256(archived) !== sha256(localPath)) {
  console.log(`   ⚠️ 留档已存在且字节不同（换成新的了，旧的在 .bak）：${archived}`);
  fs.copyFileSync(archived, `${archived}.bak`);
  fs.copyFileSync(localPath, archived);
}
