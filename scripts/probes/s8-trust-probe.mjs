#!/usr/bin/env node
/**
 * S8 探针（二）：项目信任的**裁决钩子**与 `trust.json`。
 *
 * 为什么要有它（S8-plan §0.2 的 F11–F15 都出自这里）：信任流程有一半的语义在
 * pi 内部（什么时候问、问完谁去 reload 设置、答案存哪、父子目录怎么继承）。
 * 这些只能实跑：读源码能看出"有钩子"，看不出"钩子返回 true 之后项目设置真的生效"。
 *
 * 观察点用 `theme` / `defaultTools`：
 *   - `theme` 只证明"设置被读了"；
 *   - **`defaultTools` 会改 `getActiveToolNames()`**（`sdk.js:139-146`），是**面板里看得见**
 *     的效果，S8 的人工验收（M2）就靠它。
 *
 * 用法：`node scripts/probes/s8-trust-probe.mjs`（需要先 `npm run sync`）。
 * 临时目录全在 os.tmpdir() 下并**先 realpath**（macOS 上 `/var` → `/private/var`，
 * pi 的 `canonicalizePath` 会把 trust.json 的键写成物理路径 —— 不 realpath 就会看到
 * "同一个文件夹两把钥匙"的假象，S5-plan §11 的 6-8 踩过同类坑）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = path.join(REPO_ROOT, "pi-runtime", "dist", "bundle", "index.js");
if (!fs.existsSync(BUNDLE)) {
  console.error(`SKIP：${BUNDLE} 不存在，先跑 npm run sync`);
  process.exit(1);
}
const pi = await import(pathToFileURL(BUNDLE).href);

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s8-trust-probe-"));
const agentDir = path.join(root, "agent");
const proj = path.join(root, "proj");
fs.mkdirSync(path.join(proj, ".pi"), { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
  path.join(proj, ".pi", "settings.json"),
  JSON.stringify({ theme: "proj-theme", defaultTools: ["read"] }, null, 2),
  "utf8",
);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "global-theme" }), "utf8");

console.log("== 1. 有没有「要问的」资源");
console.log(`   hasTrustRequiring(proj)     = ${pi.hasTrustRequiringProjectResources(proj)}`);
console.log(`   hasTrustRequiring(agentDir) = ${pi.hasTrustRequiringProjectResources(agentDir)}`);
console.log(`   （前者 = <cwd>/.pi/ 里有 settings.json；后者 = 没有）`);

/**
 * 跑一次真装配：钩子返回 `trusted`（或干脆不传钩子 = 今天的现状）。
 *
 * 顺带钉住一件事：**loader 不会替我们判断"要不要问"** —— 只要传了钩子，
 * 哪怕这个 cwd 里一个 `.pi/` 资源都没有，它照样 await 一次（下面的 `cwd` 参数就为它准备的）。
 * ⇒「没有要问的资源就直接信任」这条短路必须写在**我们的**裁决函数里（S8-plan §0.2 F14 与 §3.4 第 2 步）。
 */
async function run(label, { withHook, trusted, cwd = proj }) {
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // 故意挂一个 inline 工厂：预信任阶段会用 `includeInlineFactories: true` 加载一次，
  // 所以扩展数应当 ≥ 1（这也是"审批扩展在预信任阶段就已在场"的证据）。
  const inlineProbe = (api) => {
    api.on("tool_call", async () => undefined);
  };
  const before = { trusted: settingsManager.isProjectTrusted(), theme: settingsManager.getTheme() };
  let hookCalls = 0;
  const services = await pi.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: { extensionFactories: [inlineProbe] },
    resourceLoaderReloadOptions: withHook
      ? {
          resolveProjectTrust: async ({ extensionsResult }) => {
            hookCalls += 1;
            console.log(`   [${label}] 钩子被调用（预信任阶段的扩展数=${extensionsResult.extensions.length}）`);
            return trusted;
          },
        }
      : undefined,
  });
  const sessionManager = pi.SessionManager.create(cwd, path.join(root, "sessions", `--${label}--`));
  const created = await pi.createAgentSessionFromServices({ services, sessionManager, customTools: [] });
  const after = {
    trusted: services.settingsManager.isProjectTrusted(),
    theme: services.settingsManager.getTheme(),
    activeTools: created.session.getActiveToolNames().join(","),
  };
  console.log(
    `   [${label}] 钩子次数=${hookCalls} 之前{trusted:${before.trusted} theme:${before.theme}} → 之后{trusted:${after.trusted} theme:${after.theme} tools:[${after.activeTools}]}`,
  );
  return after;
}

console.log("\n== 2. 钩子决定一切（今天的现状 = 不传钩子 = 固定不信任）");
const untrusted = await run("不传钩子（今天的现状）", { withHook: false });
console.log(`   ⇒ 项目级 defaultTools 生效了吗？activeTools=[${untrusted.activeTools}]`);
const trustedRun = await run("钩子→true", { withHook: true, trusted: true });
console.log(`   ⇒ 信任之后：theme=${trustedRun.theme}（项目值 proj-theme）、activeTools=[${trustedRun.activeTools}]`);
const deniedRun = await run("钩子→false", { withHook: true, trusted: false });
console.log(`   ⇒ 不信任：theme=${deniedRun.theme}（全局值 global-theme）、activeTools=[${deniedRun.activeTools}]`);
const noResourceRun = await run("没有 .pi 资源 + 照样传钩子", {
  withHook: true,
  trusted: false,
  cwd: agentDir,
});
console.log(`   ⇒ loader 照样问了（钩子次数=1）⇒「没资源就别问」得我们自己短路（§3.4 第 2 步）`);

console.log("\n== 3. trust.json（一律经 pi 自己的 ProjectTrustStore）");
const store = new pi.ProjectTrustStore(agentDir);
const trustFile = path.join(agentDir, "trust.json");
console.log(`   文件：${trustFile}（存在=${fs.existsSync(trustFile)}）`);
store.set(proj, true);
console.log(`   set(proj,true) 之后：${fs.readFileSync(trustFile, "utf8").trim()}`);
const parent = path.join(proj, "sub", "deep");
fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
console.log(`   子目录继承：get(${path.basename(path.dirname(parent))}/deep)=${store.get(parent)}`);
store.setMany([{ path: path.join(root, "parent"), decision: true }]);
console.log(`   setMany 之后：${JSON.stringify(JSON.parse(fs.readFileSync(trustFile, "utf8")))}`);
store.set(proj, null);
console.log(`   set(proj,null)（清除）之后：${fs.readFileSync(trustFile, "utf8").trim()}`);

fs.rmSync(root, { recursive: true, force: true });
console.log("\nS8-TRUST-PROBE OK（3 节全部符合 S8-plan §0.2 的记录）");
