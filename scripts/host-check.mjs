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
const { resetStub, callsOf, stubCalls, queueQuickPickResponse, queueWarningResponse, queueInformationResponse, fireConfigurationChange } = stub;

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
    /**
     * 真输入：把一条消息喂进 provider 注册的监听器。
     *
     * **必须多等一个宏任务**：`chatView` 的监听器是
     * `void this.handleMessage(...)`（fire-and-forget，产品代码故意的 ——
     * 不能让一条消息把 webview 的消息泵堵住），所以 `await listener(...)`
     * 立刻返回，而处理链（`pickModel` → `showQuickPick` → `applyModel`）
     * 还在跑。少这一个等待，所有"await 之后"的断言都会假红。
     */
    async send(message) {
      await listener(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
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

/** 一个模型目录项的假数据（字段名与 pi 的 Model 一致）。 */
function makeModel(provider, id, extra = {}) {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    contextWindow: 1_000_000,
    input: ["text"],
    cost: { input: 2, output: 8 },
    ...extra,
  };
}

function makeController(overrides = {}) {
  const calls = { appliedModels: [], appliedLevels: [], notices: [] };
  const controller = {
    calls,
    ensure: async () => {},
    snapshot: () => ({
      items: [],
      truncated: false,
      queue: { steering: [], followUp: [] },
      busy: false,
      cwd: "/w",
      meta: {
        model: "",
        provider: "",
        modelName: "",
        thinkingLevel: "off",
        supportsThinking: false,
        contextWindow: 0,
        contextUsage: null,
        // S5（协议 v4）：`session` 必填，且 `state` 里不再有顶层 `model`。
        session: { path: "", name: "新会话", persisted: false },
      },
    }),
    prompt: async () => {},
    abort: async () => {},
    clearQueue: () => "",
    isOpenableFile: () => false,
    // ---- S4 的选择器接口 ----
    pickerContext: () => ({ model: "", thinkingLevel: "off", supportsThinking: false, levels: [] }),
    listAvailableModels: async () => [],
    applyPanelModel: async (model) => {
      calls.appliedModels.push(model);
    },
    applyThinkingLevel: (level) => {
      calls.appliedLevels.push(level);
    },
    // ---- S5 的会话接口 ----
    currentSessionPath: () => "",
    listSessions: async () => [],
    newSession: async () => ({ ok: true }),
    switchSession: async () => ({ ok: true }),
    notifyUser: (level, text) => {
      calls.notices.push({ level, text });
    },
    ...overrides,
  };
  return controller;
}

/** 把需要的模块打成一个临时 ESM，`vscode` 换成桩。 */
async function buildModules(tempDir) {
  const entry = path.join(tempDir, "host-entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export { ChatViewProvider } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/chatView"))};`,
      `export { buildWebviewHtml } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/webviewHtml"))};`,
      `export { replaceSessionWithConfirm } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/sessionActions"))};`,
      `export { sessionToItem } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/sessionPicker"))};`,
      `export { applyAgentDirSetting, registerAgentDirWatcher, describeAgentDir, ENV_AGENT_DIR } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/config"))};`,
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
const { ChatViewProvider, replaceSessionWithConfirm, sessionToItem, applyAgentDirSetting, registerAgentDirWatcher, describeAgentDir, ENV_AGENT_DIR } =
  await buildModules(tempDir);
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
await view1.send({ type: "ready", protocol: 4 });
const stateMessages = view1.posted.filter((m) => m.type === "state");
check("ready → 恰好回一条 state", stateMessages.length === 1, String(stateMessages.length));
check(
  "state 里带 protocol 与 meta（协议 v4 的核心）",
  stateMessages[0]?.protocol === 4 &&
    typeof stateMessages[0]?.meta === "object" &&
    stateMessages[0]?.meta !== null &&
    "contextWindow" in stateMessages[0].meta,
  JSON.stringify(stateMessages[0]?.meta ?? null).slice(0, 120),
);
check(
  "协议 v4：`state` 里没有 deprecated 的 `model` 键（S5 的 D12 清掉了它）",
  stateMessages[0] !== undefined && !("model" in stateMessages[0]),
  JSON.stringify(Object.keys(stateMessages[0] ?? {})),
);
check(
  "`meta.session` 也在（形状：path/name/persisted）",
  typeof stateMessages[0]?.meta?.session === "object" &&
    "path" in stateMessages[0].meta.session &&
    "name" in stateMessages[0].meta.session &&
    "persisted" in stateMessages[0].meta.session,
  JSON.stringify(stateMessages[0]?.meta?.session ?? null),
);
check("ready 会写一行 [webview] ready", output.lines.includes("[webview] ready"));

// ①b S5 §9 第 2 步（D6）：会话替换后的重放。
// `provider.replay()` 与 `ready` 必须走**同一个出口**，否则两边的 state 形状会跑偏。
{
  const before = view1.posted.length;
  provider.replay();
  const replayed = view1.posted.slice(before).filter((m) => m.type === "state");
  check("replay() → 恰好一条 state", replayed.length === 1, String(replayed.length));
  check(
    "replay() 的 state 与 ready 的那条同形（同一出口）",
    JSON.stringify(Object.keys(replayed[0] ?? {}).sort()) ===
      JSON.stringify(Object.keys(stateMessages[0] ?? {}).sort()),
    JSON.stringify(Object.keys(replayed[0] ?? {})),
  );
}

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

// ------------------------------------------------- 模型选择器（S4 的 ①②③）
const MODELS = [
  makeModel("deepseek", "deepseek-v4-flash"),
  makeModel("deepseek", "deepseek-v4-flash-vision-exp", { input: ["text", "image"] }),
  makeModel("other", "some-pro", { reasoning: false, cost: { input: 3, output: 9 } }),
];

function pickerProvider(overrides = {}) {
  const controller = makeController({
    pickerContext: () => ({
      model: "deepseek/deepseek-v4-flash",
      thinkingLevel: "high",
      supportsThinking: true,
      levels: ["off", "low", "high", "max"],
    }),
    listAvailableModels: async () => MODELS,
    ...overrides,
  });
  const output2 = makeOutput();
  const p = new ChatViewProvider({
    controller,
    extensionUri: vscode.Uri.file("/ext"),
    output: output2,
  });
  const v = makeView();
  p.resolveWebviewView(v);
  return { provider: p, view: v, controller, output: output2 };
}

resetStub();
const p1 = pickerProvider();
await p1.view.send({ type: "openModelPicker" });
const quickPicks = callsOf("showQuickPick");
check("openModelPicker → 弹一次 QuickPick（不再算未知消息）", quickPicks.length === 1, String(quickPicks.length));
check(
  "QuickPick 的 items 与 getAvailable() 顺序一致，且当前项带 $(check)",
  quickPicks[0]?.items.length === MODELS.length &&
    quickPicks[0]?.items[0].label.startsWith("$(check) ") &&
    quickPicks[0]?.items[1].label === "deepseek-v4-flash-vision-exp",
  JSON.stringify((quickPicks[0]?.items ?? []).map((i) => i.label)),
);
check(
  "价格与上下文写进 detail（价格带单位）",
  /\$2\/\$8 \/ 1M tokens/.test(quickPicks[0]?.items[0].detail ?? "") &&
    /1\.0M/.test(quickPicks[0]?.items[0].detail ?? "") &&
    /支持图片/.test(quickPicks[0]?.items[1].detail ?? ""),
  quickPicks[0]?.items[0].detail,
);
check(
  "面发起的选择器关闭后把焦点还给输入框",
  p1.view.posted.some((m) => m.type === "focusInput"),
);

// ③ 选中第 2 项：`setModel` 必须收到**那个 Model 对象**（不是字符串、不是 "provider/id"）
resetStub();
const p2 = pickerProvider();
queueQuickPickResponse((items) => items[1]);
await p2.view.send({ type: "openModelPicker" });
check(
  "选中的是列表里那个 Model 对象本身（防止传成 id 字符串）",
  p2.controller.calls.appliedModels.length === 1 &&
    p2.controller.calls.appliedModels[0] === MODELS[1],
  JSON.stringify(p2.controller.calls.appliedModels.map((m) => typeof m)),
);

// Esc 取消：什么都不改，但**焦点照样要还**
resetStub();
const p3 = pickerProvider();
await p3.view.send({ type: "openModelPicker" });
check(
  "Esc 取消不改模型",
  p3.controller.calls.appliedModels.length === 0,
);
check(
  "Esc 取消也要还焦点（只写在 if (picked) 里就会丢光标）",
  p3.view.posted.some((m) => m.type === "focusInput"),
);

// 命令面板发起：不还焦点
resetStub();
const p4 = pickerProvider();
await p4.provider.runModelPicker(false);
check(
  "从命令面板发起时不抢焦点",
  p4.view.posted.every((m) => m.type !== "focusInput"),
);

// 空列表：一条说明项，选中它就跳去设 key
resetStub();
const p5 = pickerProvider({ listAvailableModels: async () => [] });
queueQuickPickResponse((items) => items[0]);
await p5.view.send({ type: "openModelPicker" });
check(
  "没有可用模型时给一条可操作的说明项",
  callsOf("showQuickPick")[0]?.items.length === 1 &&
    callsOf("showQuickPick")[0].items[0].label.includes("没有可用模型"),
);
check(
  "选中说明项会执行 jerrypi.setApiKey",
  callsOf("executeCommand")[0]?.id === "jerrypi.setApiKey",
  JSON.stringify(callsOf("executeCommand")),
);

// ④ 切换失败：提示里要有 provider/id（否则用户不知道是哪个模型失败了）
resetStub();
const p6 = pickerProvider({
  applyPanelModel: async () => {
    throw new Error("no auth");
  },
});
queueQuickPickResponse((items) => items[2]);
await p6.view.send({ type: "openModelPicker" });
check(
  "切换失败 → 提示里带 provider/id 与原因",
  p6.controller.calls.notices.some(
    (n) => n.text.includes("other/some-pro") && n.text.includes("no auth"),
  ),
  JSON.stringify(p6.controller.calls.notices),
);

// ------------------------------------------------- 思考等级选择器（S4 的 D8）
resetStub();
const t1 = pickerProvider();
await t1.view.send({ type: "openThinkingPicker" });
const levelItems = callsOf("showQuickPick")[0]?.items ?? [];
check(
  "等级列表**原样**带空洞（off/low/high/max，中间没有 medium）",
  JSON.stringify(levelItems.map((i) => i.label.replace("$(check) ", ""))) ===
    JSON.stringify(["off", "low", "high", "max"]),
  JSON.stringify(levelItems.map((i) => i.label)),
);
check("当前档位带 $(check)", levelItems[2].label === "$(check) high");

resetStub();
const t2 = pickerProvider({
  pickerContext: () => ({ model: "other/some-pro", thinkingLevel: "off", supportsThinking: false, levels: [] }),
});
await t2.view.send({ type: "openThinkingPicker" });
check(
  "不支持思考的模型给一条明确说明（不是空列表）",
  (callsOf("showQuickPick")[0]?.items ?? []).length === 1 &&
    callsOf("showQuickPick")[0].items[0].label.includes("不支持思考等级"),
  JSON.stringify(callsOf("showQuickPick")[0]?.items ?? []),
);
check("不支持时不设等级（不拿 7 档假数据去设置）", t2.controller.calls.appliedLevels.length === 0);

// ------------------------------------------------- 状态栏项（S4 的 D13/⑤）
resetStub();
const barController = makeController({
  snapshot: () => ({
    items: [],
    truncated: false,
    queue: { steering: [], followUp: [] },
    busy: false,
    cwd: "/w",
    model: "deepseek/deepseek-v4-flash",
    meta: {
      model: "deepseek/deepseek-v4-flash",
      provider: "deepseek",
      modelName: "flash",
      thinkingLevel: "high",
      supportsThinking: true,
      contextWindow: 1_000_000,
      contextUsage: { tokens: 423_000, percent: 42.3 },
    },
  }),
});
const barProvider = new ChatViewProvider({
  controller: barController,
  extensionUri: vscode.Uri.file("/ext"),
  output: makeOutput(),
});
const barView = makeView();
barProvider.resolveWebviewView(barView);
check(
  "还没有 meta 时不创建状态栏项（不为了显示它提前建会话）",
  callsOf("createStatusBarItem").length === 0,
);
await barView.send({ type: "ready", protocol: 3 });
const bars = callsOf("createStatusBarItem");
check("拿到 meta 之后才创建状态栏项", bars.length === 1 && bars[0].alignment === 2);
// 状态栏文本：驱动端是真的 ready 消息，断言端才是桩。
resetStub();
const barProvider2 = new ChatViewProvider({
  controller: barController,
  extensionUri: vscode.Uri.file("/ext"),
  output: makeOutput(),
});
const barView2 = makeView();
barProvider2.resolveWebviewView(barView2);
await barView2.send({ type: "ready", protocol: 3 });
const statusText = globalThis.__jerrypiVscodeStub.statusBars[0]?.text ?? "";
const statusTooltip = globalThis.__jerrypiVscodeStub.statusBars[0]?.tooltip ?? "";
check(
  "状态栏文本含模型 id 与 42.3%/1.0M",
  statusText.includes("deepseek-v4-flash") && statusText.includes("42.3%/1.0M"),
  statusText,
);
check(
  "状态栏 tooltip 含 provider 与等级",
  statusTooltip.includes("deepseek") && statusTooltip.includes("high"),
  statusTooltip.replace(/\n/g, " | "),
);
barProvider2.dispose();
check(
  "面板 dispose 时状态栏被隐藏（不留在状态栏上误导人）",
  globalThis.__jerrypiVscodeStub.statusBars[0].hiddenCount > 0,
);

// 上下文未知（压缩后）：显示 ?/1.0M，**没有百分号**
resetStub();
const unknownController = makeController({
  snapshot: () => ({
    items: [],
    truncated: false,
    queue: { steering: [], followUp: [] },
    busy: false,
    cwd: "/w",
    model: "m/m",
    meta: {
      model: "m/m",
      provider: "m",
      modelName: "m",
      thinkingLevel: "off",
      supportsThinking: false,
      contextWindow: 1_000_000,
      contextUsage: { tokens: null, percent: null },
    },
  }),
});
const unknownProvider = new ChatViewProvider({
  controller: unknownController,
  extensionUri: vscode.Uri.file("/ext"),
  output: makeOutput(),
});
const unknownView = makeView();
unknownProvider.resolveWebviewView(unknownView);
await unknownView.send({ type: "ready", protocol: 3 });
check(
  "压缩后（percent=null）状态栏显示 ?/1.0M（无百分号）",
  (globalThis.__jerrypiVscodeStub.statusBars[0]?.text ?? "").includes("?/1.0M"),
  globalThis.__jerrypiVscodeStub.statusBars[0]?.text,
);

// ------------------------------------------------- S5 第 3 步（D7）：忙时先问一句
//
// 分工："忙不忙"由 controller 判定（controller-check 验那两条），"问不问、问了之后怎么跑"
// 在这里验 —— controller 拿不到 `vscode.window`。
{
  const busy = { ok: false, code: "busy" };

  resetStub();
  queueWarningResponse("继续");
  const forced = [];
  const confirmed = await replaceSessionWithConfirm(async (force) => {
    forced.push(force);
    return force ? { ok: true } : busy;
  });
  const warnings = callsOf("showWarningMessage");
  check("忙时先弹一次确认，而且是模态", warnings.length === 1 && warnings[0]?.options?.modal === true, JSON.stringify(warnings[0]?.options));
  check(
    "确认框把后果说全（中止这一轮 + 排队消息也会被处理）",
    typeof warnings[0]?.message === "string" &&
      warnings[0].message.includes("中止这一轮") &&
      warnings[0].message.includes("排队"),
    String(warnings[0]?.message),
  );
  check("点了「继续」→ 带 force 再跑一次，并返回成功", confirmed.ok === true && forced.join(",") === "false,true", forced.join(","));

  resetStub();
  queueWarningResponse(undefined); // 用户取消（或 Esc）
  const cancelled = await replaceSessionWithConfirm(async (force) => {
    forced.push(force);
    return force ? { ok: true } : busy;
  });
  check("取消 → 不重跑、并把「忙」原样返回（会话不变）", cancelled.code === "busy" && forced.join(",") === "false,true,false", `${cancelled.code}:${forced.join(",")}`);

  resetStub();
  const idle = await replaceSessionWithConfirm(async () => ({ ok: true }));
  check("空闲时**不弹**确认（直接换）", callsOf("showWarningMessage").length === 0 && idle.ok === true);
}

// ------------------------------------- S5 第 4 步（D8/D10/S2）：会话选择器的两个消息入口
{
  resetStub();
  const view = makeView();
  const provider = new ChatViewProvider({
    controller: makeController({
      currentSessionPath: () => "/s/a.jsonl",
      listSessions: async () => [],
      newSession: async () => ({ ok: true }),
      switchSession: async () => ({ ok: true }),
    }),
    extensionUri: vscode.Uri.file("/ext"),
    output: makeOutput(),
  });
  provider.resolveWebviewView(view);
  queueQuickPickResponse(undefined); // 用户按 Esc
  await view.send({ type: "openSessionPicker" });
  const pickers = callsOf("showQuickPick");
  check("面板点会话段 → 宿主弹一次会话列表（不是自己画）", pickers.length === 1, String(pickers.length));
  const items = pickers[0]?.items ?? [];
  check(
    "列表第一项**永远**是「新建会话」（D10：刚建的会话不会出现在列表里）",
    String(items[0]?.label ?? "").includes("新建会话"),
    JSON.stringify(items.map((i) => i.label)),
  );
  check("空列表时给一条能看懂的说明（不对齐 pi 的 Tab 提示，我们没有那个键位）",
    items.some((i) => String(i.label).includes("还没有已保存的会话")), JSON.stringify(items.map((i) => i.label)));
}

// S2：把 SessionInfo 组装成 QuickPickItem 的那一步（纯函数，单独断言）
{
  const now = new Date(2026, 8, 13, 12, 0, 0); // 2026-09-13 12:00 本地时间
  const current = "/s/b.jsonl";
  const item = sessionToItem(
    { path: current, name: undefined, firstMessage: "帮我看一下 STATUS", modified: new Date(2026, 8, 13, 11, 58, 0), messageCount: 114 },
    current,
    now,
  );
  check("当前项用 `$(check)` 前缀标（不能用 `picked`：单选时它什么都不做）", String(item.label).startsWith("$(check) "), String(item.label));
  check("label 是首条 user 消息（没有显式名字时）", String(item.label).includes("帮我看一下 STATUS"), String(item.label));
  check("description 是「相对时间 · 消息数」", String(item.description) === "2 分钟前 · 114 条消息", String(item.description));
  check("detail 是缩成 ~ 的路径", String(item.detail).startsWith("~") || String(item.detail) === "/s/b.jsonl", String(item.detail));
  const other = sessionToItem({ path: "/s/c.jsonl", name: "显式名字", firstMessage: "不理它", modified: new Date(2026, 8, 12, 9, 0, 0), messageCount: 3 }, current, now);
  check("有显式名字时优先用它，且非当前项没有 check 前缀", String(other.label) === "显式名字", String(other.label));
  check("跨天用「昨天 HH:MM」", String(other.description).startsWith("昨天 "), String(other.description));
}

// ------------------------------------- S6 第 1 步：agentDir 的生效语义（A2）与变更提示（A3）
//
// A2 走的是**注入的 env 对象**，故意不碰真的 `process.env`：`host-check` 是单进程跑
// 几十条断言，污染环境会让后面的断言（尤其 A9/A13/A14 那条链路）变味（S6-plan §6 的 N5）。
{
  const env = {};
  const empty = applyAgentDirSetting("", env);
  check("A2：设置为空 + 环境变量没设 → 不写环境变量（交给 pi 的默认 ~/.pi/agent）",
    empty.source === "default" && env[ENV_AGENT_DIR] === undefined && empty.dir.endsWith("/.pi/agent"),
    JSON.stringify({ ...empty, env }));

  const bySetting = applyAgentDirSetting("  /tmp/agent-x  ", env);
  check("A2：设置非空 + 环境变量没设 → 写进环境变量，来源=setting",
    bySetting.source === "setting" && env[ENV_AGENT_DIR] === "/tmp/agent-x" && bySetting.dir === "/tmp/agent-x",
    JSON.stringify({ ...bySetting, env }));

  // 已设过环境变量时**不覆盖**：那是用户在 shell 里对"整台机器的 pi"的选择
  const env2 = { [ENV_AGENT_DIR]: "/from-shell" };
  const byEnv = applyAgentDirSetting("/tmp/agent-y", env2);
  check("A2：环境变量已设 → 不覆盖，来源=env",
    byEnv.source === "env" && env2[ENV_AGENT_DIR] === "/from-shell" && byEnv.dir === "/from-shell",
    JSON.stringify({ ...byEnv, env2 }));

  const env3 = { [ENV_AGENT_DIR]: "   " };
  const blank = applyAgentDirSetting("/tmp/agent-z", env3);
  check("A2：环境变量只有空白 → 当作没设",
    blank.source === "setting" && env3[ENV_AGENT_DIR] === "/tmp/agent-z", JSON.stringify({ ...blank, env3 }));

  check("A2：日志那行带来源（M1 的判据）",
    describeAgentDir({ source: "setting", dir: "/tmp/agent-x" }) === "[jerrypi] agentDir=/tmp/agent-x（来源：设置）",
    describeAgentDir({ source: "setting", dir: "/tmp/agent-x" }));
}

// A3：真注册一个监听器，再**真的**触发一次配置变更事件
{
  resetStub();
  registerAgentDirWatcher({ subscriptions: [] });
  check("A3：注册了配置变更监听", callsOf("onDidChangeConfiguration").length === 1, JSON.stringify(stubCalls().map((c) => c.kind)));

  await fireConfigurationChange("editor.fontSize");
  check("A3：与本设置无关的变更 → 不弹任何东西",
    callsOf("showInformationMessage").length === 0, JSON.stringify(callsOf("showInformationMessage")));

  await fireConfigurationChange("jerrypi.agentDir");
  const messages = callsOf("showInformationMessage");
  check("A3：改了 agentDir → 恰好弹一次信息消息，且带「重载窗口」按钮",
    messages.length === 1 && messages[0].items.includes("重载窗口") && String(messages[0].message).includes("重载"),
    JSON.stringify(messages[0]));

  check("A3：没点按钮 → 不重载（不能替用户重载）",
    callsOf("executeCommand").filter((c) => c.id === "workbench.action.reloadWindow").length === 0,
    JSON.stringify(callsOf("executeCommand")));

  // 用户点了「重载窗口」→ 才执行重载
  resetStub();
  registerAgentDirWatcher({ subscriptions: [] });
  queueInformationResponse("重载窗口");
  await fireConfigurationChange("jerrypi.agentDir");
  check("A3：点了「重载窗口」→ 执行 workbench.action.reloadWindow",
    callsOf("executeCommand").some((c) => c.id === "workbench.action.reloadWindow"),
    JSON.stringify(callsOf("executeCommand")));
}

// ----------------------------------------------------------------- 汇总
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
}
console.log(
  `\nHOST-CHECK ${failed.length === 0 ? "OK" : "FAILED"} (${results.length - failed.length}/${results.length} passed)`,
);
if (failed.length > 0) process.exitCode = 1;
