#!/usr/bin/env node
/**
 * 宿主侧的接线检查（fake-`vscode` 桩 + 真 `ChatViewProvider`）。
 *
 * 为什么需要它（S4 评审第 1/2 轮的结论）：`chatView.handleMessage` 是**唯一**做
 * 运行期消息校验的地方（`protocol.ts` 只有类型），而它 `import * as vscode`，
 * 于是 `controller-check` 那条路径（把 vscode 设为 external）永远碰不到它。
 * 结果就是：协议里加了新消息，却没有任何检查能证明宿主真的认它。
 *
 * 三条纪律（写在桩的文件头，这里重复一遍是因为它们是**本脚本**的规矩）：
 *   1. 桩里不写业务判断，只有记录与预置返回；
 *   2. **驱动端必须是真输入**（一条真实 webview 消息、一次真实的注册回调），
 *      桩只能出现在断言端 —— 两端都是桩的断言一律删掉；
 *   3. 用真 HTML（`buildWebviewHtml` 经 provider 生成）与真类（`ChatViewProvider`），
 *      不重新实现一份。
 *
 * 这里**不测**：CSP 是否被浏览器执行（桩不执行 CSP）、滚动、真实焦点。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const STUB_PATH = path.join(SCRIPT_DIR, "fixtures", "vscode-stub.mjs");

const stub = await import(pathToFileURL(STUB_PATH).href);
const { resetStub, callsOf } = stub;

const results = [];
const check = (name, ok, detail = "") => results.push([name, ok, detail]);

/** 假 WebviewView：只实现 provider 真的会碰的成员。 */
function makeView() {
  let listener;
  const posted = [];
  return {
    posted,
    webview: {
      options: undefined,
      html: "",
      cspSource: "vscode-webview://test",
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage(fn) {
        listener = fn;
        return { dispose() {} };
      },
      postMessage(message) {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose() {} }),
    /** 真输入：把一条消息喂进 provider 注册的监听器。 */
    async send(message) {
      await listener(message);
    },
  };
}

function makeOutput() {
  return {
    lines: [],
    appendLine(line) {
      this.lines.push(line);
    },
    append(line) {
      this.lines.push(line);
    },
    replace() {},
    clear() {
      this.lines.length = 0;
    },
    show() {},
    hide() {},
    dispose() {},
  };
}

function makeController(overrides = {}) {
  return {
    ensure: async () => {},
    snapshot: () => ({
      items: [],
      truncated: false,
      queue: { steering: [], followUp: [] },
      busy: false,
      cwd: "/w",
      model: "",
      meta: {
        model: "",
        provider: "",
        modelName: "",
        thinkingLevel: "off",
        supportsThinking: false,
        contextWindow: 0,
        contextUsage: null,
      },
    }),
    prompt: async () => {},
    abort: async () => {},
    clearQueue: () => "",
    isOpenableFile: () => false,
    ...overrides,
  };
}

/** 把需要的模块打成一个临时 ESM，`vscode` 换成桩。 */
async function buildModules(tempDir) {
  const entry = path.join(tempDir, "host-entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export { ChatViewProvider } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/chatView"))};`,
      `export { buildWebviewHtml } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/webviewHtml"))};`,
    ].join("\n"),
  );
  const outfile = path.join(tempDir, "host-bundle.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    alias: { vscode: STUB_PATH },
    logLevel: "silent",
    absWorkingDir: REPO_ROOT,
  });
  return import(pathToFileURL(outfile).href);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-check-"));
const { ChatViewProvider } = await buildModules(tempDir);
const vscode = await import(pathToFileURL(STUB_PATH).href);

// ----------------------------------------------------------------- 视图装配
resetStub();
const output = makeOutput();
const provider = new ChatViewProvider({
  controller: makeController(),
  extensionUri: vscode.Uri.file("/ext"),
  output,
});
const view = makeView();
provider.resolveWebviewView(view);

check("resolveWebviewView 装出了 HTML", view.webview.html.includes("<div id=\"transcript\""));
check(
  "localResourceRoots 放行扩展根目录（脚本在 dist/）",
  Array.isArray(view.webview.options?.localResourceRoots) &&
    view.webview.options.localResourceRoots.length === 1 &&
    view.webview.options.enableScripts === true,
);
check(
  "HTML 的 script 走 asWebviewUri 且带 nonce",
  /<script nonce="[0-9a-f]{32}" src="[^"]*dist\/webview\.js"><\/script>/.test(view.webview.html),
);

// ----------------------------------------------------------------- 消息路由
// ① ready → 回一条 state（含 v3 的 meta），并且记一行 ready
resetStub();
const view1 = makeView();
provider.resolveWebviewView(view1);
await view1.send({ type: "ready", protocol: 3 });
const stateMessages = view1.posted.filter((m) => m.type === "state");
check("ready → 恰好回一条 state", stateMessages.length === 1, String(stateMessages.length));
check(
  "state 里带 protocol 与 meta（v3 的核心）",
  stateMessages[0]?.protocol === 3 &&
    typeof stateMessages[0]?.meta === "object" &&
    stateMessages[0]?.meta !== null &&
    "contextWindow" in stateMessages[0].meta,
  JSON.stringify(stateMessages[0]?.meta ?? null).slice(0, 120),
);
check("ready 会写一行 [webview] ready", output.lines.includes("[webview] ready"));

// 旧协议的面板：要留一行日志（这是删掉「断言常量等于 3」之后唯一有意义的版本断言）
const beforeVersionLog = output.lines.length;
await view1.send({ type: "ready", protocol: 2 });
check(
  "旧协议的面板会留下版本不一致日志",
  output.lines
    .slice(beforeVersionLog)
    .some((line) => line.includes("协议版本不一致") && line.includes("面板=2")),
  output.lines.slice(beforeVersionLog).join(" | ").slice(0, 160),
);

// 未知消息：记一行，且**不发任何消息给 webview**
const beforeUnknown = view1.posted.length;
await view1.send({ type: "nonsense", payload: 1 });
check(
  "未知消息记一行日志",
  output.lines.some((line) => line.includes("未知消息")),
);
check("未知消息不会给 webview 发东西", view1.posted.length === beforeUnknown);

// ----------------------------------------------------------------- prompt
resetStub();
const view2 = makeView();
provider.resolveWebviewView(view2);
const failing = new ChatViewProvider({
  controller: makeController({
    prompt: async () => {
      throw new Error("没有可用模型");
    },
  }),
  extensionUri: vscode.Uri.file("/ext"),
  output,
});
const view3 = makeView();
failing.resolveWebviewView(view3);
await view3.send({ type: "prompt", text: "你好", behavior: "auto" });
await new Promise((resolve) => setTimeout(resolve, 5));
check(
  "prompt 抛错 → composerError + busy:false（不让面板卡在生成中）",
  view3.posted.some((m) => m.type === "composerError" && m.text.includes("没有可用模型")) &&
    view3.posted.some((m) => m.type === "busy" && m.busy === false),
  JSON.stringify(view3.posted.map((m) => m.type)),
);

// ----------------------------------------------------------------- 链接与文件
resetStub();
const view4 = makeView();
provider.resolveWebviewView(view4);
await view4.send({ type: "openExternal", href: "https://example.com/a" });
check("https 链接交给系统浏览器", callsOf("openExternal")[0]?.href === "https://example.com/a");

resetStub();
const view5 = makeView();
provider.resolveWebviewView(view5);
const beforeRefuse = output.lines.length;
await view5.send({ type: "openExternal", href: "javascript:alert(1)" });
check("javascript: 链接被拒绝", callsOf("openExternal").length === 0);
check(
  "拒绝链接会留一行日志",
  output.lines.slice(beforeRefuse).some((line) => line.includes("拒绝打开非白名单链接")),
);

resetStub();
const view6 = makeView();
const withFile = new ChatViewProvider({
  controller: makeController({ isOpenableFile: (p) => p === "/w/known.ts" }),
  extensionUri: vscode.Uri.file("/ext"),
  output,
});
withFile.resolveWebviewView(view6);
await view6.send({ type: "openFile", path: "/w/known.ts" });
check(
  "白名单里的路径用 Uri.file 打开（preview）",
  callsOf("showTextDocument")[0]?.uri === "file:///w/known.ts" &&
    callsOf("showTextDocument")[0]?.options?.preview === true,
  JSON.stringify(callsOf("showTextDocument")[0] ?? null),
);

resetStub();
const view7 = makeView();
withFile.resolveWebviewView(view7);
const beforeBadPath = output.lines.length;
await view7.send({ type: "openFile", path: "/etc/passwd" });
check("白名单外的路径不打开", callsOf("showTextDocument").length === 0);
check(
  "白名单外的路径会留一行日志",
  output.lines.slice(beforeBadPath).some((line) => line.includes("拒绝打开未登记的文件")),
);

// ----------------------------------------------------------------- 队列取回
resetStub();
const queueController = makeController({ clearQueue: () => "第一句\n第二句" });
const queueProvider = new ChatViewProvider({
  controller: queueController,
  extensionUri: vscode.Uri.file("/ext"),
  output,
});
const view8 = makeView();
queueProvider.resolveWebviewView(view8);
await view8.send({ type: "clearQueue" });
check(
  "取回队列 → restoreComposer 带上原文（不是静默丢弃）",
  view8.posted.find((m) => m.type === "restoreComposer")?.text === "第一句\n第二句",
  JSON.stringify(view8.posted),
);

resetStub();
const emptyQueueProvider = new ChatViewProvider({
  controller: makeController({ clearQueue: () => "" }),
  extensionUri: vscode.Uri.file("/ext"),
  output,
});
const view9 = makeView();
emptyQueueProvider.resolveWebviewView(view9);
await view9.send({ type: "clearQueue" });
check(
  "队列为空时不发 restoreComposer（避免输入框被清空）",
  view9.posted.every((m) => m.type !== "restoreComposer"),
);

// ----------------------------------------------------------------- 汇总
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
}
console.log(
  `\nHOST-CHECK ${failed.length === 0 ? "OK" : "FAILED"} (${results.length - failed.length}/${results.length} passed)`,
);
if (failed.length > 0) process.exitCode = 1;
