// S9 第 6 步（追加③）：`contributes` 的**容器位置**与其余贡献点的不变式。
//
// 为什么值得一个脚本：把容器从 `activitybar` 挪到 `secondarySidebar` 是**一行**改动，
// 但它牵动三件容易一起坏的事 —— ①容器 id（`jerrypi`）是视图、命令、激活事件共用的钥匙；
// ②视图必须仍然挂在同一个容器下，否则面板凭空消失；③命令贡献不能顺手丢掉。
// 而 `secondarySidebar` 本身是被官方文档漏写的键（S9-plan §0.8 F38），写错一个字母
// 的表现是"扩展装上了但没有面板"，本地很难发现 —— 所以在这里钉住。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 0.1.12 已有的命令（挪容器不许动它们）+ S9 新增的四条。 */
const EXPECTED_COMMANDS = [
  "jerrypi.focusChat",
  "jerrypi.runSelfTest",
  "jerrypi.clearStoredApiKeys",
  "jerrypi.setApiKey",
  "jerrypi.openSettingsFile",
  "jerrypi.refreshModelCatalog",
  "jerrypi.newSession",
  "jerrypi.projectTrust",
  "jerrypi.resumeSession",
  "jerrypi.selectModel",
  "jerrypi.selectThinkingLevel",
  // S9（包管理）：三项能力、四条命令（安装有输入框与文件夹两个入口）
  "jerrypi.installPackage",
  "jerrypi.installPackageFromFolder",
  "jerrypi.listPackages",
  "jerrypi.removePackage",
];

/** 旧位置（0.1.12）：一旦这里又出现 `jerrypi`，说明那段配置被复制回来了。 */
const LEGACY_CONTAINER_KEYS = ["activitybar", "panel"];

const results = [];
function check(name, ok, detail = "") {
  results.push([name, ok, detail]);
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const viewsContainers = pkg?.contributes?.viewsContainers ?? {};
const secondary = viewsContainers.secondarySidebar ?? [];
const container = secondary.find((entry) => entry?.id === "jerrypi");

check(
  "A23①：容器贡献在 secondarySidebar（辅助边栏 = 右侧）而非 activitybar/panel",
  container !== undefined && secondary.length === 1,
  JSON.stringify(viewsContainers),
);
check(
  "A23②：旧位置里没有残留同名容器（否则会被复制回左侧）",
  LEGACY_CONTAINER_KEYS.every((key) => !(viewsContainers[key] ?? []).some((entry) => entry?.id === "jerrypi")),
  JSON.stringify(Object.fromEntries(LEGACY_CONTAINER_KEYS.map((key) => [key, viewsContainers[key] ?? []]))),
);
check(
  "A23③：容器形状不变（id=jerrypi / title / icon 都在）",
  container !== undefined && container.title === "Pi" && typeof container.icon === "string" && container.icon.length > 0,
  JSON.stringify(container),
);

const views = pkg?.contributes?.views ?? {};
const chatViews = (views.jerrypi ?? []).filter((view) => view?.id === "jerrypi.chat");
check(
  "A23④：视图仍挂在 jerrypi 容器下（id=jerrypi.chat、type=webview）",
  chatViews.length === 1 && chatViews[0].type === "webview",
  JSON.stringify(views),
);
check(
  "A23⑤：命令贡献不变（0.1.12 的 11 条 + S9 的 4 条，且都带 Pi 分类）",
  Array.isArray(pkg?.contributes?.commands) &&
    JSON.stringify([...new Set(pkg.contributes.commands.map((entry) => entry.command))].sort()) ===
      JSON.stringify([...EXPECTED_COMMANDS].sort()),
  JSON.stringify(pkg?.contributes?.commands?.map((entry) => entry.command)),
);
check(
  "A23⑥：每条命令都声明了 category 与 title（缺了会在命令面板里显示成裸 id）",
  (pkg?.contributes?.commands ?? []).every((entry) => typeof entry.title === "string" && entry.title.length > 0 && entry.category === "Pi"),
  JSON.stringify(pkg?.contributes?.commands ?? []),
);

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
}
console.log(`\nMANIFEST-CHECK ${failed.length === 0 ? "OK" : "FAILED"} (${results.length - failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
