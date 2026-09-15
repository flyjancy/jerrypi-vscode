#!/usr/bin/env node
/**
 * `Pi: Run Self-Test` 的**无头跑法** —— 在终端里复现扩展宿主里那条闸门（T1–T14 + GATE 判定）。
 *
 * 为什么需要它：闸门与 `Pi: Run Self-Test` 命令调的是**同一个** `runSelfTest()`，但它平时只能在
 * VS Code 里点命令跑 —— S5 当时是拿临时脚本跑的（结果记在 `docs/S5-plan.md` §12.1），**不可复现**。
 * 这里把它固定下来，于是"跑闸门"不再依赖某次会话里手写的东西。
 *
 * 与命令里的差异只有三处，且都只影响**报告**、不影响判定：
 *   - `vscodeVersion`：无头环境没有 VS Code，写 `headless`（首行会照实打出来）；
 *   - `httpProxyConfig`：T13 是 advisory，读不到 `http.*` 就报 `(无头)`；
 *   - `keys`：空的内存 store —— 凭据走真实的 `auth.json`（或环境变量 / 终端里设过的 key），
 *     与用户点命令时同源。
 *
 * **需要凭据与网络**（T4/T6/T7/T9 会真调模型），所以不进 CI。没有凭据时打印 SKIPPED 并以 0 退出。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-selftest-check-"));
try {
  const entry = path.join(tempDir, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export { runSelfTest } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/selftest"))};`,
      `export { loadPi } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/loader"))};`,
    ].join("\n"),
    "utf8",
  );
  const outfile = path.join(tempDir, "bundle.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
  });
  const { runSelfTest, loadPi } = await import(pathToFileURL(outfile).href);

  if (!fs.existsSync(path.join(REPO_ROOT, "pi-runtime", "dist", "bundle", "index.js"))) {
    console.error("SELFTEST-CHECK SKIPPED 需要先跑 npm run sync（pi-runtime/ 不存在）");
    process.exit(0);
  }

  const pi = await loadPi(REPO_ROOT);
  const agentDir = pi.getAgentDir();
  // T4/T6/T7/T9 真的需要凭据；没有就明说“为什么没跑”，而不是打一个假 PASS。
  const hasCredentials =
    fs.existsSync(path.join(agentDir, "auth.json")) ||
    Object.keys(process.env).some((name) => /^ANTHROPIC_|_API_KEY$|_API_TOKEN$|_AUTH_TOKEN$|_TOKEN$/i.test(name));
  if (!hasCredentials) {
    console.error(`SELFTEST-CHECK SKIPPED 没有凭据（${agentDir}/auth.json 不存在，环境变量里也没有）`);
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const lines = [];
  const sink = {
    appendLine(line) {
      lines.push(line);
    },
  };
  // 与 `Pi: Run Self-Test` 命令传的是同一组值；`cwd` 必须是**真实工作区**（T10/T11 用它算会话目录）。
  const gate = await runSelfTest({
    pi,
    extensionPath: REPO_ROOT,
    extensionVersion: String(pkg.version ?? "0.0.0"),
    vscodeVersion: "headless",
    agentDir,
    cwd: process.cwd(),
    keys: {
      listProviders: () => [],
      getApiKey: async () => undefined,
      saveApiKey: async () => {},
      removeApiKey: async () => {},
    },
    httpProxyConfig: { proxySupport: "(无头)" },
    sink,
  });

  for (const line of lines) console.log(line);
  console.log(`SELFTEST-CHECK ${gate}`);
  process.exit(gate === "GATE PASS" ? 0 : 1);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
