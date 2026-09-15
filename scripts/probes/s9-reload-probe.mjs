#!/usr/bin/env node
/**
 * S9 探针（二）：**装完之后，正在跑的那个会话什么时候才看得见这个包？**
 *
 * 为什么必须实测：S9 的验收之一是"重启后其主题/扩展被加载"，但 UI 上要写给用户的话
 * （"立即生效"/"新建会话生效"/"重载窗口生效"）取决于 pi 内部**哪一步**会重新解析包。
 * `session.reload()` / `settingsManager.reload()` / `resourceLoader.reload()` 三个都有 ——
 * 读源码看不出"哪一个够用"，更看不出"少的那个会不会静默不生效"。
 *
 * ⚠️ **每个场景跑在独立进程、独立临时目录里**（`node <file> <场景名>`；不带参数时自己 spawn 一圈）。
 * 这不是洁癖：2026-09-15 的第 1 版探针把 8 个场景塞在一个进程、共用一个 agentDir，
 * 于是从第 2 个场景起"全新会话"建好时就**已经**带着上一轮的包了 —— S2 打印的
 * "session.reload() 之后有了"其实是"装包之前的本来就有"，**最关键的那条证据是假的**
 * （评审 B1 抓到的，它换成干净进程后得到相反的顺序）。所以现在每个场景开头都有
 * **前置断言**：装包之前命令表必须是空的，不是就 `exit 1`（把污染变成显式失败，而不是静默假绿）。
 *
 * 观察点用**扩展注册的命令**与**工具表**（面板里看得见的东西），不依赖 UI。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = path.join(REPO_ROOT, "pi-runtime", "dist", "bundle", "index.js");

const line = (label, value) => console.log(`  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

/** 每个场景一份自己的世界（agentDir / cwd / 包），互相看不见。 */
function makeWorld(tag) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `s9-reload-${tag}-`));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, `ws`);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const pkgDir = path.join(root, "pkg");
  fs.mkdirSync(path.join(pkgDir, "extensions"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "extensions", "two.ts"),
    `export default function (pi) {
  pi.registerCommand("pkg-two", { description: "来自包里的扩展", handler: async () => {} });
}\n`,
    "utf8",
  );

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

  return { root, agentDir, cwd, pkgDir, richDir, settingsPath: path.join(agentDir, "settings.json") };
}

/** 建一套全新的 services + session（用这个场景自己的 agentDir）。 */
async function makeFixture(pi, world, model) {
  const services = await pi.createAgentSessionServices({
    cwd: world.cwd,
    agentDir: world.agentDir,
    resourceLoaderOptions: {},
  });
  await services.resourceLoader.reload();
  const created = await pi.createAgentSessionFromServices({
    services,
    sessionManager: pi.SessionManager.create(world.cwd, path.join(world.root, "sessions")),
    model,
  });
  return {
    services,
    session: created.session,
    commands: () => created.session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName ?? c.name),
    tools: () => created.session.getActiveToolNames(),
    themes: () => services.resourceLoader.getThemes().themes.map((t) => t.name),
  };
}

const installer = (pi, world) => {
  const settingsManager = pi.SettingsManager.create(world.cwd, world.agentDir);
  return new pi.DefaultPackageManager({ cwd: world.cwd, agentDir: world.agentDir, settingsManager });
};

/** 装包之前必须是干净的 —— 不干净就显式失败（第 1 版探针的假绿就是这么来的）。 */
function requireClean(label, list) {
  if (list.length !== 0) {
    console.error(`  ✗ 前置断言失败（${label}）：装包之前就有 ${JSON.stringify(list)} —— 这个场景被污染了，结论不可信`);
    process.exit(1);
  }
  console.log(`  ✓ 前置：装包之前是空的`);
}

const SCENARIOS = {
  async baseline(pi, world, model) {
    const f = await makeFixture(pi, world, model);
    requireClean("baseline", f.commands());
    await installer(pi, world).installAndPersist(world.pkgDir);
    line("装完之后**什么都不做**：commands", f.commands());
    line("装完之后**什么都不做**：会话那份 settingsManager.getPackages()（启动时的缓存）", f.services.settingsManager.getPackages());
    line("落盘的 settings.json", fs.readFileSync(world.settingsPath, "utf8").trim());
  },

  async "loader-only"(pi, world, model) {
    const f = await makeFixture(pi, world, model);
    requireClean("loader-only", f.commands());
    await installer(pi, world).installAndPersist(world.pkgDir);
    await f.services.resourceLoader.reload();
    line("只调 resourceLoader.reload()：commands", f.commands());
  },

  async "settings-only"(pi, world, model) {
    const f = await makeFixture(pi, world, model);
    requireClean("settings-only", f.commands());
    await installer(pi, world).installAndPersist(world.pkgDir);
    await f.services.settingsManager.reload();
    line("只调 settingsManager.reload()：commands", f.commands());
    line("会话那份 settingsManager.getPackages()（reload 之后）", f.services.settingsManager.getPackages());
  },

  async "settings+loader"(pi, world, model) {
    const f = await makeFixture(pi, world, model);
    requireClean("settings+loader", f.commands());
    await installer(pi, world).installAndPersist(world.pkgDir);
    await f.services.settingsManager.reload();
    await f.services.resourceLoader.reload();
    line("settingsManager.reload() + resourceLoader.reload()：commands", f.commands());
  },

  async "session-reload"(pi, world, model) {
    const f = await makeFixture(pi, world, model);
    requireClean("session-reload", f.commands());
    await installer(pi, world).installAndPersist(world.pkgDir);
    await f.session.reload();
    line("只调 session.reload()：commands", f.commands());
    line("只调 session.reload()：会话那份 getPackages()", f.services.settingsManager.getPackages());
  },

  async remove(pi, world, model) {
    const f = await makeFixture(pi, world, model);
    requireClean("remove", f.commands());
    await installer(pi, world).installAndPersist(world.pkgDir);
    await f.session.reload();
    line("装完 + reload：commands", f.commands());
    line("removeAndPersist 的返回值", await installer(pi, world).removeAndPersist(world.pkgDir));
    line("移除之后**没 reload**：commands", f.commands());
    await f.session.reload();
    line("移除 + reload：commands", f.commands());
  },

  async rich(pi, world, model) {
    const f = await makeFixture(pi, world, model);
    requireClean("rich", f.commands());
    line("装之前：工具里有 probe_echo 吗", f.tools().includes("probe_echo"));
    line("装之前：主题列表里有 gruvbox-dark 吗", f.themes().includes("gruvbox-dark"));
    if (f.tools().includes("probe_echo") || f.themes().includes("gruvbox-dark")) {
      console.error("  ✗ 前置断言失败（rich）：装包之前就已经有包里的资源了");
      process.exit(1);
    }
    console.log("  ✓ 前置：装包之前没有包里的工具/主题");
    await installer(pi, world).installAndPersist(world.richDir);
    await f.session.reload();
    line("reload 之后：工具里有 probe_echo 吗", f.tools().includes("probe_echo"));
    line("reload 之后：主题列表里有 gruvbox-dark 吗", f.themes().includes("gruvbox-dark"));
    line("reload 之后：可用工具全表", f.tools());
  },
};

async function main() {
  const name = process.argv[2];
  if (name === undefined) {
    // 父进程：每个场景一个干净子进程（模块级缓存、进程内状态都不可能串味）
    let failed = 0;
    for (const key of Object.keys(SCENARIOS)) {
      console.log(`\n=== 场景 ${key}（独立进程）===`);
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), key], { stdio: "inherit" });
      if (result.status !== 0) failed += 1;
    }
    console.log(`\nPROBE ${failed === 0 ? "OK" : `FAILED（${failed} 个场景出错）`}（${Object.keys(SCENARIOS).length} 个场景）`);
    process.exit(failed === 0 ? 0 : 1);
  }
  if (SCENARIOS[name] === undefined) {
    console.error(`未知场景 ${name}；可选：${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
  if (!fs.existsSync(BUNDLE)) {
    console.error(`SKIP：${BUNDLE} 不存在，先跑 npm run sync`);
    process.exit(1);
  }
  const pi = await import(pathToFileURL(BUNDLE).href);
  const world = makeWorld(name.replace(/[^\w-]/g, "_"));
  try {
    const bootstrap = await pi.ModelRuntime.create({
      authPath: path.join(world.agentDir, "auth.json"),
      modelsPath: path.join(world.agentDir, "models.json"),
      modelsStorePath: path.join(world.agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    await SCENARIOS[name](pi, world, bootstrap.getModels()[0]);
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
}

await main();
