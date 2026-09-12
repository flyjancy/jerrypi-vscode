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

  // 批量：字符上限
  const huge = [{ role: "user", content: [{ type: "text", text: "y".repeat(protocol.MAX_REPLAY_CHARS + 10) }] }];
  const hugeBatch = serialize.serializeMessages(huge);
  check("超出字符上限时置 truncated 并丢弃该条", hugeBatch.truncated === true && hugeBatch.items.length === 0);

  // id 唯一性：一条 assistant 的 toolCall 与后面的 toolResult 不能撞 id
  const mixed = [
    { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "c9", toolName: "bash", content: [], isError: false },
  ];
  const mixedItems = serialize.serializeMessages(mixed).items;
  const ids = mixedItems.map((item) => item.id);
  check("同一批转写里 id 不重复", new Set(ids).size === ids.length, ids.join(", "));
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
  check("提示语不再谎称会打断（steer 只在本段结束后注入）",
    !/打断当前回复/.test(mainCode) && /这段写完后注入/.test(mainCode));
  check("发送后立即清空输入框（不再比对 sentText）",
    /input\.value = ""/.test(mainCode) && !/sentText/.test(mainCode));
  // 协议版本只能有一处来源：两边硬编码成两个数字是最容易漏的漂移。
  const chatView = fs.readFileSync(path.join(REPO_ROOT, "src/host/chatView.ts"), "utf8");
  check("chatView 不硬编码协议版本", !/protocol:\s*\d/.test(chatView));
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
      await checkSerialize(serialize, protocol);
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
