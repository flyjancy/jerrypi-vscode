#!/usr/bin/env node
/**
 * 纯函数层的单元检查 —— 不需要 VS Code，也不需要网络。
 *
 * 覆盖 S2 里两类"错了也不会立刻崩，但会静默做错事"的逻辑：
 *   1. `src/pi/serialize.ts`：pi 消息 → ChatItem 的映射与 id 规则；
 *   2. `src/shared/urlPolicy.ts`：链接/图片的 scheme 白名单。
 *
 * 之所以要把它们做成可独立运行的检查，是因为这两处的错误形态都是"看起来正常"：
 * id 规则错了会让节点重复或丢字，白名单错了会让点了没反应的链接看起来可点。
 * 靠人工点面板发现不了，靠 CI 才靠得住。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** 用 esbuild 把 TS 打成临时 ESM 再 import —— 避免为检查脚本引入测试框架或 ts-node。 */
async function loadModule(relativeEntry, tempDir) {
  const outfile = path.join(tempDir, path.basename(relativeEntry).replace(/\.ts$/, ".mjs"));
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, relativeEntry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

async function checkSerialize(serialize, protocol) {
  console.log("[protocol-check] serialize.ts");
  const index = serialize.createToolCallIndex();

  const assistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先看文件" },
      { type: "text", text: "好的" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
  };
  serialize.indexToolCalls(assistant, index);

  const user = serialize.serializeMessage({ role: "user", content: [{ type: "text", text: "看看 a.ts" }] }, 0, index);
  equal("user 用 msg-<下标> 作 id", user.id, "msg-0");
  equal("user 文本", user.text, "看看 a.ts");

  const assistantItem = serialize.serializeMessage(assistant, 1, index);
  equal("assistant 用 msg-<下标> 作 id", assistantItem.id, "msg-1");
  equal("assistant 文本", assistantItem.text, "好的");
  equal("assistant 思考", assistantItem.thinking, "先看文件");
  check("assistant 不带 toolCalls 字段", !("toolCalls" in assistantItem));

  const toolResult = serialize.serializeMessage(
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "文件内容" }],
      isError: false,
    },
    2,
    index,
  );
  // 这条是本目录最关键的不变量：工具行的 id 由 toolCallId 构造，
  // 与"实时路径在 tool_execution_start 时发的运行中占位"必须是同一个 id。
  equal("toolResult 的 id 由 toolCallId 构造（不依赖下标）", toolResult.id, "tool-call_1");
  equal("toolResult 取到参数摘要", toolResult.summary, '{"path":"a.ts"}');
  equal("toolResult 的 toolName", toolResult.toolName, "read");

  const orphan = serialize.serializeMessage(
    { role: "toolResult", toolCallId: "", toolName: "x", content: [], isError: true },
    3,
    serialize.createToolCallIndex(),
  );
  check("没有 toolCallId 时仍产出唯一 id", orphan.id === "tool-unknown-3", orphan.id);

  const unknown = serialize.serializeMessage({ role: "mystery" }, 4, index);
  equal("未知 role 降级为 notice 而不是丢弃", unknown.kind, "notice");
  equal("未知 role 的级别是 warn", unknown.level, "warn");
  check("未知 role 的提示里带 role 名", unknown.text.includes("mystery"));

  const emptyUser = serialize.serializeMessage({ role: "user", content: [] }, 5, index);
  equal("空 user 消息不产出 item", emptyUser, undefined);

  const bash = serialize.serializeMessage(
    { role: "bashExecution", command: "ls", output: "a.ts", exitCode: 0, cancelled: false },
    6,
    index,
  );
  equal("bashExecution 变成 notice", bash.kind, "notice");

  const compaction = serialize.serializeMessage({ role: "compactionSummary", summary: "s" }, 7, index);
  check("compactionSummary 不丢", compaction !== undefined && compaction.text.includes("压缩"));

  // 参数摘要长度上限
  const longArgs = serialize.summarizeArgs({ blob: "x".repeat(protocol.SUMMARY_MAX * 2) });
  check(
    `参数摘要被截到 ${protocol.SUMMARY_MAX} 字符以内`,
    longArgs.length <= protocol.SUMMARY_MAX + 1,
    `length=${longArgs.length}`,
  );

  // 批量：条数上限，保留最新的
  const many = Array.from({ length: protocol.MAX_REPLAY_ITEMS + 20 }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `m${i}` }],
  }));
  const batch = serialize.serializeMessages(many);
  check("超出条数上限时置 truncated", batch.truncated === true);
  check("超出条数上限时保留最新的", batch.items[batch.items.length - 1].text === `m${many.length - 1}`);

  // 批量：**字节**上限（名字从 CHARS 改成 BYTES 是 S3 的事，见 protocol.ts 的注释）
  const huge = [
    { role: "user", content: [{ type: "text", text: "y".repeat(protocol.MAX_REPLAY_BYTES + 10) }] },
  ];
  const hugeBatch = serialize.serializeMessages(huge);
  check("超出字节上限时置 truncated 并丢弃该条", hugeBatch.truncated === true && hugeBatch.items.length === 0);

  // 中文字符串：按字节算 → 同样长度的中文比 ASCII 更早触顶
  const cjkBytes = serialize.itemBytes({ kind: "user", id: "x", text: "汉".repeat(1000) });
  check("itemBytes 按 UTF-8 字节算（1000 个汉字 = 3000 字节）", cjkBytes === 3000, `got ${cjkBytes}`);

  // id 唯一性：一条 assistant 的 toolCall 与后面的 toolResult 不能撞 id
  const mixed = [
    { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "c9", toolName: "bash", content: [], isError: false },
  ];
  const mixedItems = serialize.serializeMessages(mixed).items;
  const ids = mixedItems.map((item) => item.id);
  check("同一批转写里 id 不重复", new Set(ids).size === ids.length, ids.join(", "));
}

/**
 * S3：工具卡片的结果正文、元信息与可点路径。
 *
 * 这一组的每一格都是"实时与重放必须给出同一份数据"的具体化 ——
 * 而"同一份数据"正是 S2 花了一整轮评审才立起来的规矩。
 */
async function checkToolCard(serialize, protocol, toolText) {
  console.log("[protocol-check] 工具卡片（S3）");

  const ctx = { cwd: "/work/project" };
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } },
      { type: "toolCall", id: "t2", name: "read", arguments: { path: "src/a.ts" } },
      { type: "toolCall", id: "t3", name: "bash", arguments: { command: "big" } },
      { type: "toolCall", id: "t4", name: "read", arguments: { path: "/abs/b.png" } },
    ],
    stopReason: "toolUse",
  };
  const messages = [
    assistant,
    // ① 普通正文
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "\u001b[32mhi\u001b[0m\n" }],
      isError: false,
    },
    // ② 空正文
    { role: "toolResult", toolCallId: "t2", toolName: "read", content: [], isError: false },
    // ③ pi 的截断：details 里既有标量也有一份 50KB 的 content
    {
      role: "toolResult",
      toolCallId: "t3",
      toolName: "bash",
      // 用 pi 的真实形态：正文 + `\n\n[Showing … Full output: <path>]`（探针 C 的实测）
      content: [{ type: "text", text: "x".repeat(200) + "\n\n[Showing lines 2001-4000 of 4000. Full output: /tmp/pi-bash-123.log]" }],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "bytes",
          totalLines: 1,
          totalBytes: 120000,
          outputLines: 1,
          outputBytes: 51200,
          maxBytes: 51200,
          content: "y".repeat(50000),
        },
        fullOutputPath: "/tmp/pi-bash-123.log",
      },
      isError: false,
    },
    // ④ 图片结果（我们只显示提示）
    {
      role: "toolResult",
      toolCallId: "t4",
      toolName: "read",
      content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
      isError: false,
    },
  ];

  const items = serialize.serializeMessages(messages, ctx).items;
  const tool = (id) => items.find((item) => item.id === `tool-${id}`);

  const t1 = tool("t1");
  check("① 正文里的 ANSI 被剥掉", t1.text === "hi\n", JSON.stringify(t1.text));
  check("① 没有正文裁剪标记", t1.textTruncated === undefined);
  check("① 参数摘要保留", typeof t1.summary === "string" && t1.summary.includes("echo hi"), t1.summary);
  check("① 没有可点路径（bash 命令里的路径不猜）", t1.openablePaths === undefined, JSON.stringify(t1.openablePaths));

  const t2 = tool("t2");
  check("② 空正文不写 text 字段", t2.text === undefined, JSON.stringify(t2.text));

  const t3 = tool("t3");
  check("③ pi 的截断摘要被保留（truncatedBy）", t3.truncation?.truncatedBy === "bytes");
  check("③ 截断摘要里的 totalBytes 被保留", t3.truncation?.totalBytes === undefined);
  check("③ 完整输出路径被保留", t3.fullOutputPath === "/tmp/pi-bash-123.log");
  check(
    "③ 截断摘要**不含** pi 的 truncation.content（否则协议体积翻倍）",
    JSON.stringify(t3.truncation).length < 500,
    `length=${JSON.stringify(t3.truncation).length}`,
  );
  check("③ 完整输出路径进可点路径", (t3.openablePaths ?? []).includes("/tmp/pi-bash-123.log"));
  check("③ pi 的截断脚注被剥掉（否则同一件事说三遍、还占掉折叠预览的名额）",
    !(t3.text ?? "").includes("[Showing last"), JSON.stringify(t3.text));
  // 只在"确实截断 + 有完整输出路径"时剥；否则正文里的方括号是用户自己的内容
  const notTruncated = serialize.serializeMessages(
    [
      { role: "assistant", content: [{ type: "toolCall", id: "t8", name: "bash", arguments: {} }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "t8", toolName: "bash", content: [{ type: "text", text: "a\n\n[not a footer]" }], isError: false },
    ],
    ctx,
  ).items.find((item) => item.id === "tool-t8");
  check("没有截断信息时不动正文", (notTruncated.text ?? "").includes("[not a footer]"), JSON.stringify(notTruncated.text));

  const t4 = tool("t4");
  check("④ 图片结果只给提示文本", t4.text === "[Image: image/png]", JSON.stringify(t4.text));

  // 路径铸造：相对路径按 cwd 解析、绝对路径原样、去重
  const tRead = serialize.serializeMessages(
    [
      assistant,
      { role: "toolResult", toolCallId: "t2", toolName: "read", content: [], isError: false },
    ],
    ctx,
  ).items.find((item) => item.id === "tool-t2");
  check("② 相对路径按会话 cwd 解析成绝对路径", tRead.openablePaths?.[0] === "/work/project/src/a.ts", JSON.stringify(tRead.openablePaths));

  const tAbs = serialize.serializeMessages(
    [assistant, { role: "toolResult", toolCallId: "t4", toolName: "read", content: [], isError: false }],
    ctx,
  ).items.find((item) => item.id === "tool-t4");
  check("④ 绝对路径原样保留", tAbs.openablePaths?.[0] === "/abs/b.png", JSON.stringify(tAbs.openablePaths));

  check(
    "没有 cwd 时相对路径不被凭空改写",
    serialize.openablePathsOfToolCall({ path: "rel/x" }, "")[0] === "rel/x",
  );

  // 我们自己的上限（只有扩展工具能触发）：正文被裁 + 标记
  const hugeText = "z".repeat(protocol.TOOL_TEXT_MAX_BYTES + 5000);
  const hugeItem = serialize.serializeMessages(
    [
      { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "ext", arguments: {} }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "t9", toolName: "ext", content: [{ type: "text", text: hugeText }], isError: false },
    ],
    ctx,
  ).items.find((item) => item.id === "tool-t9");
  check("超出我们的上限时被裁", (hugeItem.text ?? "").length < hugeText.length);
  check("超出我们的上限时置 textTruncated", hugeItem.textTruncated === true);
  check("裁剪说明写进正文", (hugeItem.text ?? "").includes("已省略"), (hugeItem.text ?? "").slice(-40));

  // 实时 vs 重放：同一批数据的两次序列化必须逐字节相同
  const again = serialize.serializeMessages(messages, ctx).items;
  check(
    "同一批数据重复序列化的结果完全一致",
    JSON.stringify(items) === JSON.stringify(again),
  );

  // 未登记路径 / 非字符串 path 都不铸造
  check("非字符串 path 不铸造", serialize.openablePathsOfToolCall({ path: 42 }, "/w").length === 0);

  // ---- 标题（照 pi 的 call 行）----
  const tBash = serialize.titleOf("bash", { command: "wc  -l\n/tmp/a.md", timeout: 30 }, "/w");
  check("bash 标题是压成一行的命令 + timeout", tBash.title?.text === "wc -l /tmp/a.md (timeout 30s)", JSON.stringify(tBash.title));
  check("bash 标题不带可点路径", tBash.title?.link === undefined);
  const titleRead = serialize.titleOf("read", { path: "src/a.ts", offset: 10, limit: 11 }, "/work/project");
  check("read 标题是 '路径:起-止'", titleRead.title?.text === "/work/project/src/a.ts:10-20", JSON.stringify(titleRead.title));
  check("read 标题里的 link.path 是绝对路径", titleRead.title?.link?.path === "/work/project/src/a.ts");
  check("read 标题的 link.text 是显示形态（title 里真有这一段）",
    titleRead.title.text.includes(titleRead.title.link.text));
  const tWrite = serialize.titleOf("write", { path: "/abs/x.ts", content: "big" }, "/work");
  check("write 标题不带 content（大文件不该进标题）",
    tWrite.title?.text === "/abs/x.ts", JSON.stringify(tWrite.title));
  check("edit 标题同 write", serialize.titleOf("edit", { path: "rel.ts" }, "/w").title?.text === "/w/rel.ts");
  check("扩展工具（未知名字）不铸造标题", serialize.titleOf("my_ext_tool", { path: "x" }, "/w").title === undefined);
  check("命令里的换行被压平", !String(tBash.title?.text).includes("\n"));
  const tLong = serialize.titleOf("bash", { command: "x".repeat(500) }, "/w");
  check("超长命令被截断", (tLong.title?.text ?? "").length <= 200, String((tLong.title?.text ?? "").length));
  check("空 path 不铸造", serialize.openablePathsOfToolCall({ path: "   " }, "/w").length === 0);
}

async function checkUrlPolicy(urlPolicy) {
  console.log("[protocol-check] urlPolicy.ts");

  const externalAllowed = ["https://example.com/a", "http://example.com", "mailto:a@b.c"];
  const externalDenied = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\u0001script:alert(1)",
    "data:text/html,x",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "tel:123",
    "ftp://example.com",
    "",
    "/relative",
    "#anchor",
  ];
  for (const url of externalAllowed) {
    check(`外开放行 ${JSON.stringify(url)}`, urlPolicy.isExternalUrlAllowed(url) === true);
  }
  for (const url of externalDenied) {
    check(`外开拦截 ${JSON.stringify(url)}`, urlPolicy.isExternalUrlAllowed(url) === false, url);
  }

  // white-box 复现"看起来像合法域名"的构造
  const tricky = [
    "https://example.com javascript:alert(1)",
    "  javascript:alert(1)  ",
    "\tjavascript:alert(1)",
  ];
  for (const url of tricky) {
    check(`外开拦截伪装 ${JSON.stringify(url)}`, urlPolicy.isExternalUrlAllowed(url) === false, url);
  }

  check("图片放行 data:image/png", urlPolicy.isImageUrlAllowed("data:image/png;base64,iVBORw0KGgo=") === true);
  check("图片放行 data:image/svg+xml", urlPolicy.isImageUrlAllowed("data:image/svg+xml,%3Csvg/%3E") === true);
  check(
    "图片拦截 data:text/html（不是图片 mediatype）",
    urlPolicy.isImageUrlAllowed("data:text/html;base64,PHNjcmlwdD4=") === false,
  );
  check(
    "图片拦截远程 https（放行等于给出网信道）",
    urlPolicy.isImageUrlAllowed("https://example.com/a.png") === false,
  );
  check("图片拦截相对路径", urlPolicy.isImageUrlAllowed("a.png") === false);
}

/**
 * 源码级交叉检查：webview 侧 `getElementById("x")` 的每个 id，
 * 都必须在 HTML 生成器里真的存在。
 *
 * 为什么值得单独查一次：写错一个 id 的表现是 `null.xxx` 抛错 → 面板白屏，
 * 而这类错误在 Node 侧的任何单元检查里都看不出来（没有 DOM），
 * 只能靠 F5 或人眼比对。用它换掉一次 F5 很划算。
 */
function checkWebviewElementIds() {
  console.log("[protocol-check] webview 元素 id 交叉检查");
  const main = fs.readFileSync(path.join(REPO_ROOT, "src/webview/main.ts"), "utf8");
  // 断言"代码里不再出现某个字符串"时要去掉注释：注释里往往正在解释"以前是这么写的"。
  const mainCode = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const html = fs.readFileSync(path.join(REPO_ROOT, "src/host/webviewHtml.ts"), "utf8");
  const referenced = [...main.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  check("main.ts 至少引用了一个元素", referenced.length > 0, String(referenced.length));
  // 侧栏很窄：工具名与图标一旦可收缩就会被参数挤成竖排单字母（实测踩过）。
  const css = fs.readFileSync(path.join(REPO_ROOT, "src/webview/style.css"), "utf8");
  const toolNameRule = css.match(/\.tool-name\s*\{[^}]*\}/)?.[0] ?? "";
  check("工具名声明了不可收缩", /flex:\s*0 0 auto/.test(toolNameRule), toolNameRule.trim());
  const toolLineRule = css.match(/\.tool-line\s*\{[^}]*\}/)?.[0] ?? "";
  check("工具行允许换行", /flex-wrap:\s*wrap/.test(toolLineRule));
  // 同一类错误的第三处：提示语被按钮挤成一列单字。根治办法是分两行。
  const actionsRule = css.match(/\.composer-actions\s*\{[^}]*\}/)?.[0] ?? "";
  check("提示语与按钮分成两行（不再互相挤压）",
    /flex-direction:\s*column/.test(actionsRule) && /class="buttons"/.test(html));
  // 同一类错误的第二处：按钮被 hint 挤成竖排字。
  const buttonRule = css.match(/\.button\s*\{[^}]*\}/)?.[0] ?? "";
  check("按钮不可收缩且不换行",
    /flex:\s*0 0 auto/.test(buttonRule) && /white-space:\s*nowrap/.test(buttonRule), buttonRule.trim());
  // D10 修订：发送即清空，不再依赖"回显时比对文本"。
  // 用词一律对齐 pi 的 TUI：Steering / Follow-up / "edit all queued messages"。
  check("提示语不再谎称会打断（steer 只在本段结束后注入）",
    !/打断当前回复/.test(mainCode) && /转向（写完这段就注入）/.test(mainCode));
  check("队列条用词对齐 pi（转向 / 追加 / 取回编辑）",
    /转向：/.test(mainCode) && /追加：/.test(mainCode) && /取回编辑/.test(mainCode));
  // ---- S3：工具卡片的就地更新、滚动策略、展开态 ----
  // 这几条都是"看着正常但会一直折磨用户"的类型：每 200ms 重写 innerHTML 会
  // 重置展开态与滚动位置，无条件滚底会把正在翻历史的用户拽回底部。
  // S3 第一次人工验收的教训：render.ts 与 main.ts 各拼一份按钮内容，
  // 于是测试测到有箭头、真机上没有。这条断言把"只能有一份拼装"钉死。
  check("按钮内容只有一处拼装（main.ts 必须调 renderToolHeadLine）",
    /renderToolHeadLine\(/.test(mainCode) && !/tool-caret/.test(mainCode), 
    /tool-caret/.test(mainCode) ? "main.ts 里仍在自建 caret" : "");
  check("工具卡片就地更新（不再整块 setHtml）",
    /renderToolBody\(/.test(mainCode) && !/setHtml\(node, renderToolLine\(item\)\)/.test(mainCode));
  check("展开态存在 webview 侧（不进协议）",
    /const expanded = new Set<string>\(\)/.test(mainCode) && !/expanded/.test(
      fs.readFileSync(path.join(REPO_ROOT, "src/shared/protocol.ts"), "utf8"),
    ));
  check("正文重写前保存/恢复正文容器的滚动位置",
    /keepScroll/.test(mainCode) && /view\.body\.scrollTop = keepScroll/.test(mainCode));
  check("自动滚动只在用户本来就在底部时发生",
    /function isAtBottom/.test(mainCode) && /scrollIfFollowing\(\)/.test(mainCode) &&
      !/case "item":\s*renderItem\(message\.item\);\s*scrollToBottom\(\);/.test(mainCode));
  check("耗时定时器有停止条件", /hasRunning/.test(mainCode) && /clearInterval\(durationTimer\)/.test(mainCode));
  const toolBodyRule = css.match(/\.tool-body\s*\{[^}]*\}/)?.[0] ?? "";
  const toolTextRule = css.match(/\.tool-text\s*\{[^}]*\}/)?.[0] ?? "";
  check("正文限高且可滚动", /max-height/.test(toolTextRule) && /overflow:\s*auto/.test(toolTextRule), toolTextRule.trim());
  const headTextRule = css.match(/\.tool-head-text\s*\{[^}]*\}/)?.[0] ?? "";
  check("标题内容不可收缩（同类挤压错误的第四处）",
    /flex:\s*1 1 auto/.test(headTextRule) && /flex-wrap:\s*wrap/.test(headTextRule), headTextRule.trim());
  check("工具卡片有可点路径的样式", /\.tool-path-open\s*\{/.test(css));
  void toolBodyRule;

  check("发送后立即清空输入框（不再比对 sentText）",
    /input\.value = ""/.test(mainCode) && !/sentText/.test(mainCode));
  // 协议版本只能有一处来源：两边硬编码成两个数字是最容易漏的漂移。
  const chatView = fs.readFileSync(path.join(REPO_ROOT, "src/host/chatView.ts"), "utf8");
  check("chatView 不硬编码协议版本", !/protocol:\s*\d/.test(chatView));
  // pi 的 dequeue 是"取回编辑"，不是"丢弃"：聊天视图必须把返回值回填。
  check("取回队列的文本被回填而不是丢弃",
    /const restoredText = controller\.clearQueue\(\)/.test(chatView) && /restoreComposer/.test(chatView));
  // 回填顺序对齐 pi：队列在前、当前输入在后、空行分隔
  check("回填顺序与 pi 一致（队列在前、当前输入在后、空行分隔）",
    /\[message\.text, input\.value\]/.test(mainCode) && /join\("\\n\\n"\)/.test(mainCode));
  for (const id of referenced) {
    check(`HTML 里存在 id="${id}"`, declared.has(id), `已声明：${[...declared].join(", ")}`);
  }
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-protocol-check-"));
  return Promise.resolve()
    .then(async () => {
      const serialize = await loadModule("src/pi/serialize.ts", tempDir);
      const urlPolicy = await loadModule("src/shared/urlPolicy.ts", tempDir);
      const protocol = await loadModule("src/shared/protocol.ts", tempDir);
      const toolText = await loadModule("src/shared/toolText.ts", tempDir);
      await checkSerialize(serialize, protocol);
      await checkToolCard(serialize, protocol, toolText);
      await checkUrlPolicy(urlPolicy);
      checkWebviewElementIds();
    })
    .then(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (failures > 0) {
        console.error(`PROTOCOL-CHECK FAILED (${checks - failures}/${checks} passed)`);
        process.exit(1);
      }
      console.log(`PROTOCOL-CHECK OK (${checks} checks)`);
    })
    .catch((error) => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.error(`PROTOCOL-CHECK ERROR ${error?.stack ?? error}`);
      process.exit(1);
    });
}

await main();
