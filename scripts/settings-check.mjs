// S6 第 1 步：三项 VS Code 设置的**声明**与**文档**是否对得上。
//
// 为什么值得一个脚本：这三项设置是 0.1.7 之前"从来没声明过、写了也不生效"的东西
// （S6-plan §0.4 F13），而 README 里一度把它们写成"能用"。所以这里同时钉住两件事：
//   1. `package.json` 的 `contributes.configuration` 里三项设置齐全、scope 与裁决一致（A1）；
//   2. README 中英双语里每项设置的**生效状态**与 `package.json` 的描述一致（A10）。
//
// 按 S6-plan §6 的 N2/N3 判据：比的是**可枚举的集合**（设置 id → 状态词），不比自由文本；
// 而且先断言"集合非空"，否则"空集合 == 空集合"会恒绿。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 三项设置与它们**在计划里定死**的默认值（`docs/S6-plan.md` §4 的 Q1/Q2/Q6）。 */
const EXPECTED = [
  { id: "jerrypi.agentDir", type: "string", default: "", scope: "machine" },
  { id: "jerrypi.proxy", type: "string", default: "", scope: "machine" },
  { id: "jerrypi.approvalMode", type: "string", default: "off", scope: "machine" },
];

/**
 * 生效状态的**配对词表**（写死的白名单，顺序 = 优先级）。
 *
 * 为什么配对：`package.json` 的描述只有一份（中文），README 是双语的 —— 所以中文那边比
 * 同一个中文词，英文那边比它对应的英文短语。只允许这三组，于是"README 换个措辞"不会假绿、
 * "两边都抽不到"也不会假绿（那是 0 === 0）。
 * 顺序即优先级：英文 `effective` 是 `not effective yet` 的子串，先命中否定短语才不会误判。
 */
const STATUS_PAIRS = [
  { zh: "未实现", en: "not implemented" },
  { zh: "尚未生效", en: "not effective yet" },
  { zh: "已生效", en: "effective" },
];

const results = [];
function check(name, ok, detail) {
  results.push([name, ok, detail]);
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
}

/** 在中文描述里找出它命中的状态档位（返回下标，按优先级取第一个命中）。 */
function statusIndexOf(text) {
  const lower = text.toLowerCase();
  const at = STATUS_PAIRS.findIndex((pair) => lower.includes(pair.zh.toLowerCase()));
  return at < 0 ? undefined : at;
}

/**
 * 在文本里找出它命中的状态词：**按优先级取第一个命中**（词表顺序 = 优先级）。
 *
 * 为什么不能"要求恰好命中一个"：英文里 `effective` 是 `not effective yet` 的子串，
 * 于是"尚未生效"的行会同时命中两个词（第一版就是红在这里）。按顺序取第一个即可 ——
 * 词表从"最具体"排到"最泛"，否定短语在前，裸肯定词在后。
 */
function statusOf(text, words) {
  const lower = text.toLowerCase();
  return words.find((word) => lower.includes(word.toLowerCase()));
}

const pkg = readJson("package.json");
const properties = pkg?.contributes?.configuration?.properties ?? {};

// ------------------------------------------------------------------ A1：声明
check(
  "package.json 声明了 contributes.configuration 且三项设置齐全",
  EXPECTED.every((item) => properties[item.id] !== undefined),
  `实际有：${Object.keys(properties).join(", ") || "（无）"}`,
);
for (const item of EXPECTED) {
  const actual = properties[item.id];
  check(
    `${item.id}：type/default/scope 与计划一致`,
    actual !== undefined && actual.type === item.type && actual.default === item.default && actual.scope === item.scope,
    actual === undefined ? "（没声明）" : JSON.stringify({ type: actual.type, default: actual.default, scope: actual.scope }),
  );
  check(
    `${item.id}：描述里命中了生效状态词（${STATUS_PAIRS.map((p) => p.zh).join(" / ")}，按此优先级）`,
    actual !== undefined && statusIndexOf(String(actual.markdownDescription ?? actual.description ?? "")) !== undefined,
    String(actual?.markdownDescription ?? actual?.description ?? "（没有描述）").slice(0, 80),
  );
}
check(
  "capabilities.untrustedWorkspaces 已声明（Q9：受限工作区里不启用）",
  pkg?.capabilities?.untrustedWorkspaces?.supported === false,
  JSON.stringify(pkg?.capabilities ?? "（没有 capabilities）"),
);

// ------------------------------------------------------- A10：README ↔ package.json
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
// README 是双语的：不切开的话，中文这一轮会把英文那三行也算进来（第一版就红在"命中 6 行"）。
const englishAt = readme.indexOf('<a id="english">');
if (englishAt < 0) {
  check('README 里有 <a id="english"> 分界（双语各自成段）', false, "找不到分界标记");
}
const halves = [
  { label: "中文", word: (index) => STATUS_PAIRS[index].zh, text: readme.slice(0, englishAt < 0 ? readme.length : englishAt) },
  { label: "英文", word: (index) => STATUS_PAIRS[index].en, text: readme.slice(englishAt < 0 ? readme.length : englishAt) },
];

for (const half of halves) {
  // 只认**配置表**的行（`| \`jerrypi.xxx\` | … |`）—— 设置 id 在已知限制里也被提到，
  // 用 includes 会命中十几行，行的选取本身就变成不确定的（第一版就是这么红的）。
  const rows = half.text
    .split("\n")
    .filter((line) => line.trimStart().startsWith("| `jerrypi."));

  // 先挡"空集合 == 空集合"（S6-plan §6 的 N2）
  check(
    `README（${half.label}）里三项设置各有一行`,
    rows.length === EXPECTED.length,
    `命中 ${rows.length} 行（期望 ${EXPECTED.length}）`,
  );

  for (const item of EXPECTED) {
    const row = rows.find((line) => line.includes(`\`${item.id}\``));
    const declared = statusIndexOf(String(properties[item.id]?.markdownDescription ?? ""));
    const documented = row === undefined ? undefined : statusOf(row, [half.word(0), half.word(1), half.word(2)]);
    check(
      `${item.id}（${half.label}）：README 的生效状态与 package.json 一致`,
      declared !== undefined && documented !== undefined && documented === half.word(declared),
      `package.json="${declared === undefined ? "?" : STATUS_PAIRS[declared].zh}"｜README="${documented ?? "?"}"`,
    );
  }
}

// ------------------------------------------------- A11：S9 新命令与面板内交互的文档一致性
//
// 为什么扩到这里：S9 新增了 5 条命令 + 一整套面板内对话框。命令/交互都是“用户看不见就会
// 以为没做”的东西，而 README 是唯一入口 —— 所以把“该提的名字”钉成可枚举的集合
// （只钉**新增的**，不逼着 README 把每一条命令都列全）。
{
  const S9_COMMANDS = [
    "Pi: Install Package",
    "Pi: Install Package from Folder…",
    "Pi: List Packages",
    "Pi: Remove Package",
    "Pi: Set Shell Path",
  ];
  const commandTitles = new Set((pkg?.contributes?.commands ?? []).map((entry) => entry.title));
  for (const command of S9_COMMANDS) {
    // 先保证这个名字真的存在于 manifest 里（否则下面只是在查一个拼错的字符串）。
    check(`package.json 里有 ${command} 这条命令`, commandTitles.has(command.replace(/^Pi: /, "")), [...commandTitles].join(", "));
  }
  for (const half of halves) {
    for (const command of S9_COMMANDS) {
      check(`${command}（${half.label}）出现在 README 里`, half.text.includes(command), "");
    }
  }
  // 面板内对话框：中英文各自要有一节能找到的说明（不比对文案细节，只比对“有没有说”）。
  const zh = readme.slice(0, englishAt < 0 ? readme.length : englishAt);
  const en = readme.slice(englishAt < 0 ? readme.length : englishAt);
  check("README（中文）说明面板内的对话框停在面板里", zh.includes("面板内") && zh.includes("不再弹窗口顶部"), "");
  check("README（英文）说明面板内的对话框停在面板里", en.toLowerCase().includes("inside the panel") && en.toLowerCase().includes("top of the window"), "");
}

// ------------------------------------------------------------------- 收尾
let failed = 0;
for (const [name, ok, detail] of results) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(`SETTINGS-CHECK ${failed === 0 ? "OK" : "FAILED"} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
