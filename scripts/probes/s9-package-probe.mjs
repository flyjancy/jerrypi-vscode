#!/usr/bin/env node
/**
 * S9 探针：`DefaultPackageManager` 的真实行为（安装 / 列出 / 移除 / 失败形态）。
 *
 * 为什么要有它：S9 的每一条可见行为都落在 pi 内部的一串副作用上 —— 写进哪个 settings、
 * 写成什么形态（绝对 / 相对 agentDir）、`listConfiguredPackages()` 回什么、
 * 移除失败（返回 false）长什么样、**没有 npm 时**错误信息长什么样。
 * 这些读 d.ts 只能看出"有这个方法"，看不出"点下去会发生什么"。
 *
 * 用法：`node scripts/probes/s9-package-probe.mjs`（需要先 `npm run sync`）。
 * 临时目录建在 `fs.realpathSync(os.tmpdir())` 之下（macOS 的 `/var` → `/private/var`：
 * pi 的 `resolvePath` 会 canonicalize，不先 realpath 会看到"同一个目录两种写法"的假象）。
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

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s9-pkg-probe-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "ws");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

/** 一个"本地包"：pi 认两种形态 —— `pi` 清单 或 直接放 extensions/ themes/ 目录。 */
const pkgDir = path.join(root, "my-pkg");
fs.mkdirSync(path.join(pkgDir, "extensions"), { recursive: true });
fs.mkdirSync(path.join(pkgDir, "themes"), { recursive: true });
fs.writeFileSync(path.join(pkgDir, "extensions", "probe.ts"), "export default function () {}\n", "utf8");
fs.writeFileSync(path.join(pkgDir, "themes", "probe-theme.json"), "{}\n", "utf8");

/** 一个**空**目录（用来观察"没有可加载资源"时 pi 怎么处理）。 */
const emptyPkgDir = path.join(root, "empty-pkg");
fs.mkdirSync(emptyPkgDir, { recursive: true });

const settingsPath = path.join(agentDir, "settings.json");
const readSettings = () => (fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8").trim() : "(文件不存在)");
const newManager = (options = {}) => {
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, options);
  return { settingsManager, manager: new pi.DefaultPackageManager({ cwd, agentDir, settingsManager }) };
};

section("F0 导出面：我们从 pi-runtime 里能拿到什么");
line("typeof pi.DefaultPackageManager", typeof pi.DefaultPackageManager);
line("typeof pi.SettingsManager.create", typeof pi.SettingsManager.create);
line("typeof pi.getExtensionTempFolder", typeof pi.getExtensionTempFolder);

section("F1 空配置：listConfiguredPackages()");
{
  const { manager } = newManager();
  line("listConfiguredPackages()", manager.listConfiguredPackages());
  line("settings.json", readSettings());
}

section("F2 installAndPersist(<本地目录绝对路径>) 之后");
{
  const { settingsManager, manager } = newManager();
  await manager.installAndPersist(pkgDir);
  line("settings.json（原始字节）", readSettings());
  line("settingsManager.getPackages()", settingsManager.getPackages());
  line("listConfiguredPackages()", manager.listConfiguredPackages());
}

section("F3 用**全新的** SettingsManager 再列一次（证明它落盘了）");
{
  const { manager } = newManager();
  line("listConfiguredPackages()", manager.listConfiguredPackages());
}

section("F4 getInstalledPath / resolve() 看得见包里的资源吗");
{
  const { manager } = newManager();
  const [configured] = manager.listConfiguredPackages();
  line("getInstalledPath(source,'user')", manager.getInstalledPath(configured.source, "user"));
  const resolved = await manager.resolve();
  line("resolve().extensions", resolved.extensions.map((entry) => ({ path: path.relative(root, entry.path), enabled: entry.enabled, scope: entry.metadata.scope, origin: entry.metadata.origin })));
  line("resolve().themes", resolved.themes.map((entry) => ({ path: path.relative(root, entry.path), enabled: entry.enabled })));
}

section("F5 removeAndPersist：成功 / 再来一次（没匹配到）");
{
  const { manager } = newManager();
  line("第一次 removeAndPersist(绝对路径)", await manager.removeAndPersist(pkgDir));
  line("settings.json", readSettings());
  line("第二次 removeAndPersist(同一个源)", await manager.removeAndPersist(pkgDir));
}

section("F6 相对路径写入后，再 install 同一个绝对路径会不会重复");
{
  const { settingsManager, manager } = newManager();
  await manager.installAndPersist(pkgDir);
  const afterFirst = settingsManager.getPackages();
  await manager.installAndPersist(pkgDir);
  line("两次 installAndPersist 之后 getPackages()", settingsManager.getPackages());
  line("第一次之后的样子（对比用）", afterFirst);
  await manager.removeAndPersist(pkgDir);
}

section("F7 空目录当包源：装进去之后 resolve() 会不会报错");
{
  const { settingsManager, manager } = newManager();
  await manager.installAndPersist(emptyPkgDir);
  line("settings.json", readSettings());
  const resolved = await manager.resolve();
  line("resolve().extensions 条数", resolved.extensions.length);
  await manager.removeAndPersist(emptyPkgDir);
}

section("F8 不存在的路径：错误信息原样是什么");
{
  const { manager } = newManager();
  try {
    await manager.installAndPersist(path.join(root, "nope-does-not-exist"));
    line("结果", "（没有抛错 —— 与预期不符）");
  } catch (error) {
    line("error.name", error?.name);
    line("error.message", error?.message);
  }
}

section("F9 `npm:` 源但没有可用的 npm（受限机形态：把 npmCommand 指到不存在的地方）");
{
  fs.writeFileSync(settingsPath, JSON.stringify({ npmCommand: ["/nonexistent/npm-binary"] }, null, 2), "utf8");
  const { settingsManager, manager } = newManager();
  line("settingsManager.getNpmCommand()", settingsManager.getNpmCommand());
  try {
    await manager.installAndPersist("npm:some-tiny-package");
    line("结果", "（没有抛错 —— 与预期不符）");
  } catch (error) {
    line("error.name", error?.name);
    line("error.message（前 400 字）", String(error?.message).slice(0, 400));
  }
  line("settings.json 里有没有被写进 packages", readSettings());
  fs.rmSync(settingsPath, { force: true });
}

section("F10 项目作用域（{local:true}）在**未信任**时");
{
  fs.writeFileSync(path.join(cwd, "settings.json"), "", "utf8"); // 不必要，只确保 agentDir 干净
  const { settingsManager, manager } = newManager({ projectTrusted: false });
  line("isProjectTrusted()", settingsManager.isProjectTrusted());
  try {
    await manager.installAndPersist(pkgDir, { local: true });
    line("结果", "（没有抛错 —— 与预期不符）");
  } catch (error) {
    line("error.name", error?.name);
    line("error.message", error?.message);
  }
}

section("F11 已经信任时，项目作用域写到哪（cwd/.pi/settings.json 还是 agentDir？）");
{
  const { settingsManager, manager } = newManager({ projectTrusted: true });
  await manager.installAndPersist(pkgDir, { local: true });
  line("agentDir/settings.json", readSettings());
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  line("cwd/.pi/settings.json", fs.existsSync(projectSettingsPath) ? fs.readFileSync(projectSettingsPath, "utf8").trim() : "(文件不存在)");
  line("listConfiguredPackages()", manager.listConfiguredPackages());
}

section("F12 `{local:true}` 到底解析到哪个目录（cwd 还是 cwd/.pi）");
{
  const { manager } = newManager({ projectTrusted: true });
  line("parseSource 是私有的；用 getInstalledPath 观察", manager.getInstalledPath(pkgDir, "project"));
}

fs.rmSync(root, { recursive: true, force: true });
console.log("\nPROBE DONE");
