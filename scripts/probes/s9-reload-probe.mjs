#!/usr/bin/env node
/**
 * S9 探针（二）：**装完之后，正在跑的那个会话什么时候才看得见这个包？**
 *
 * 为什么必须实测：S9 的验收之一是"重启后其主题/扩展被加载"，但 UI 上要写给用户的话
 * （"立即生效"/"新建会话生效"/"重载窗口生效"）取决于 pi 内部**哪一步**会重新解析包。
 * d.ts 里 `session.reload()` / `settingsManager.reload()` / `resourceLoader.reload()`
 * 三个都有 —— 读源码看不出"哪一个够用"，更看不出"少的那个会不会静默不生效"。
 *
 * 观察点用**扩展注册的命令**（`extensionRunner.getRegisteredCommands()`）：
 * 面板里看得见（扩展命令会进我们的命令列表），而且是纯函数式的证据，不依赖 UI。
 *
 * 每个场景都从**全新的一套 services + session** 开始（装包用另一个 SettingsManager，
 * 这正是我们在命令里要做的事：`Pi: Install Package` 与跑着的会话是两个对象）。
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

const line = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const section = (title) => console.log(`\n=== ${title} ===`);

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s9-reload-probe-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir, { recursive: true });

const pkgDir = path.join(root, "pkg-2");
fs.mkdirSync(path.join(pkgDir, "extensions"), { recursive: true });
fs.writeFileSync(
  path.join(pkgDir, "extensions", "two.ts"),
  `export default function (pi) {
  pi.registerCommand("pkg-two", { description: "来自包里的扩展", handler: async () => {} });
}\n`,
  "utf8",
);
const settingsPath = path.join(agentDir, "settings.json");

const bootstrap = await pi.ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
  modelsStorePath: path.join(agentDir, "models-store.json"),
  allowModelNetwork: false,
});
const model = bootstrap.getModels()[0];

/** 造一套全新的 services + session（每个场景一份，互不污染）。 */
async function freshSession(label) {
  const cwd = path.join(root, `ws-${label}`);
  fs.mkdirSync(cwd, { recursive: true });
  const services = await pi.createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {} });
  await services.resourceLoader.reload();
  const created = await pi.createAgentSessionFromServices({
    services,
    sessionManager: pi.SessionManager.create(cwd, path.join(root, `sessions-${label}`)),
    model,
  });
  const names = () =>
    created.session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName ?? c.name);
  return { cwd, services, session: created.session, names };
}

/** 装包：**另一个** SettingsManager（与跑着的会话无关），和命令里做的事一样。 */
async function install(cwd) {
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
  await manager.installAndPersist(pkgDir);
}

// ---------------------------------------------------------------- 准备：先清空 settings.json
fs.rmSync(settingsPath, { force: true });

section("S0 基线：什么都没装");
{
  const f = await freshSession("s0");
  line("commands", f.names());
  line("session.setModel 之类会不会写 settings（观察文件在不在）", fs.existsSync(settingsPath));
  await install(f.cwd);
  fs.rmSync(settingsPath, { force: true });
}

section("S1 装完之后**什么都不做**");
{
  const f = await freshSession("s1");
  await install(f.cwd);
  line("commands", f.names());
  line("会话那份 settingsManager.getPackages()（缓存）", f.services.settingsManager.getPackages());
}

section("S2 只调 session.reload()");
{
  const f = await freshSession("s2");
  await install(f.cwd);
  await f.session.reload();
  line("commands", f.names());
  line("会话那份 settingsManager.getPackages() 还看得到包吗", f.services.settingsManager.getPackages());
}

section("S3 先 settingsManager.reload()，再 session.reload()");
{
  const f = await freshSession("s3");
  await install(f.cwd);
  await f.services.settingsManager.reload();
  await f.session.reload();
  line("commands", f.names());
}

section("S4 先 settingsManager.reload()，只调 resourceLoader.reload()");
{
  const f = await freshSession("s4");
  await install(f.cwd);
  await f.services.settingsManager.reload();
  await f.services.resourceLoader.reload();
  line("commands", f.names());
}

section("S5 到 S4 之后**再**加一步 session.reload()（= S3 的顺序反过来）");
{
  const f = await freshSession("s5");
  await install(f.cwd);
  await f.services.settingsManager.reload();
  await f.services.resourceLoader.reload();
  line("commands（loader 之后）", f.names());
  await f.session.reload();
  line("commands（session.reload 之后）", f.names());
}

section("S6 移除之后要不要也 reload（S3 的顺序）");
{
  const f = await freshSession("s6");
  await install(f.cwd);
  await f.services.settingsManager.reload();
  await f.session.reload();
  line("装完 + reload 的 commands", f.names());
  const settingsManager = pi.SettingsManager.create(f.cwd, agentDir);
  const manager = new pi.DefaultPackageManager({ cwd: f.cwd, agentDir, settingsManager });
  line("removeAndPersist 的返回值", await manager.removeAndPersist(pkgDir));
  line("移除之后（没 reload）commands", f.names());
  await f.services.settingsManager.reload();
  await f.session.reload();
  line("移除 + reload 之后 commands", f.names());
}

section("S7 包里若带**工具**与**主题**，reload 之后看得见吗");
{
  // 这个包同时带三样：扩展（注册命令 + 工具）、主题、技能说明文件
  const richDir = path.join(root, "pkg-rich");
  fs.mkdirSync(path.join(richDir, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(richDir, "themes"), { recursive: true });
  fs.writeFileSync(
    path.join(richDir, "extensions", "rich.ts"),
    `import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "probe_echo",
      label: "Probe Echo",
      description: "S9 探针用的工具",
      parameters: Type.Object({ message: Type.Optional(Type.String()) }),
      async execute() {
        return { content: [{ type: "text" as const, text: "probe-echo-ok" }], details: {} };
      },
    }),
  );
}
\n`,
    "utf8",
  );
  // 主题用一份**真的**主题文件（pi-config 里那份），避免"格式不对所以没被认"的假象
  const realTheme = path.join(REPO_ROOT, "..", "pi-config", "themes", "gruvbox-dark.json");
  if (fs.existsSync(realTheme)) {
    fs.copyFileSync(realTheme, path.join(richDir, "themes", "gruvbox-dark.json"));
  } else {
    fs.writeFileSync(path.join(richDir, "themes", "gruvbox-dark.json"), JSON.stringify({ name: "gruvbox-dark", colors: {} }), "utf8");
  }

  const f = await freshSession("s7");
  const tools = () => f.session.getActiveToolNames();
  const themes = () => f.services.resourceLoader.getThemes().themes.map((t) => t.name);
  line("装之前：工具里有 probe_echo 吗", tools().includes("probe_echo"));
  line("装之前：主题列表里有 gruvbox-dark 吗", themes().includes("gruvbox-dark"));
  const settingsManager = pi.SettingsManager.create(f.cwd, agentDir);
  const manager = new pi.DefaultPackageManager({ cwd: f.cwd, agentDir, settingsManager });
  await manager.installAndPersist(richDir);
  await f.session.reload();
  line("reload 之后：commands", f.names());
  line("reload 之后：工具里有 probe_echo 吗", tools().includes("probe_echo"));
  line("reload 之后：主题列表里有 gruvbox-dark 吗", themes().includes("gruvbox-dark"));
  line("reload 之后：可用工具全表（前 12 个）", tools().slice(0, 12));
}

fs.rmSync(root, { recursive: true, force: true });
console.log("\nPROBE DONE");
