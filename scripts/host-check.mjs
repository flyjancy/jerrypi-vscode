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
const { resetStub, callsOf, stubCalls, queueQuickPickResponse, queueWarningResponse, queueInformationResponse, queueInputBoxAnswer, queueConfiguration, fireConfigurationChange } = stub;

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
      `export { applyAgentDirSetting, registerAgentDirWatcher, describeAgentDir, ENV_AGENT_DIR, readAgentDirSetting, readProxySetting, readApprovalModeSetting } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/config"))};`,
      `export { clearStoredApiKeys, getModelRuntime } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/runtime"))};`,
      `export { loadPi } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/loader"))};`,
      `export { registerCommands } from ${JSON.stringify(path.join(REPO_ROOT, "src/commands"))};`,
      `export { describeAuthSource } from ${JSON.stringify(path.join(REPO_ROOT, "src/shared/format"))};`,
      `export { sidesOfPatch, pathLabelOf, HUNK_GAP } from ${JSON.stringify(path.join(REPO_ROOT, "src/shared/patch"))};`,
      `export { createFileChanges, recordEditsFromMessages, diffFieldsOf } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/filechanges"))};`,
      `export { createCustomTools } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/custom-tools"))};`,
      `export { createDiffPresenter, DIFF_SCHEME } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/diff"))};`,
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
const { ChatViewProvider, replaceSessionWithConfirm, sessionToItem, applyAgentDirSetting, registerAgentDirWatcher, describeAgentDir, ENV_AGENT_DIR, readAgentDirSetting, readProxySetting, readApprovalModeSetting, clearStoredApiKeys, describeAuthSource, registerCommands, loadPi, getModelRuntime, sidesOfPatch, pathLabelOf, createFileChanges, recordEditsFromMessages, diffFieldsOf, createCustomTools, createDiffPresenter, DIFF_SCHEME } =
  await buildModules(tempDir);
const vscode = await import(pathToFileURL(STUB_PATH).href);
const vscodeStub = await import(pathToFileURL(STUB_PATH).href);

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

// A2 的**真 API 那一半**（M1 真机验收抓到的 bug，2026-09-14）：
// `getConfiguration(section).get(key)` 的 `key` 是相对 key —— 第一版传了完整 id
// （`jerrypi.agentDir`），真机上一路查成 `jerrypi.jerrypi.agentDir`、静默拿到默认值；
// 而当时的桩不区分这两种写法，所以自动门禁全绿。桩现在按真 vscode 的 `${section}.${key}` 查。
{
  resetStub();
  queueConfiguration("jerrypi", { agentDir: "/tmp/from-config", proxy: "http://proxy.invalid:1", approvalMode: "mutating" });
  check("A2：readAgentDirSetting() 读到 section 相对 key 下的值（不是 jerrypi.jerrypi.…）",
    readAgentDirSetting() === "/tmp/from-config", readAgentDirSetting());
  check("A2：readProxySetting() 同上",
    readProxySetting() === "http://proxy.invalid:1", readProxySetting());
  check("A2：readApprovalModeSetting() 同上（它的默认是 off，不能用空串测试）",
    readApprovalModeSetting() === "mutating", readApprovalModeSetting());
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
  // 真机发现（M1 验收期，2026-09-14）：第一版把 `**重载窗口**` 写进了通知，而 VS Code 的通知
  // **不渲染 markdown** —— 用户看到的是字面量星号。这里钉住“通知里不出现 markdown 记号”。
  check("A3：通知文字里不能出现 markdown 记号（通知不渲染 markdown）",
    !String(messages[0]?.message).includes("**"), String(messages[0]?.message));

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

// ------------------------------------- S6 第 3 步：清 key 的核心契约（A5 的 ① + 顺序 + 不用 logout）
{
  const calls = [];
  const store = { providers: ["p1", "p2"] };
  const keys = {
    listProviders: () => [...store.providers],
    getApiKey: async () => undefined,
    saveApiKey: async () => {},
    removeApiKey: async (id) => {
      calls.push(`store.remove:${id}`);
      store.providers = store.providers.filter((p) => p !== id);
    },
  };
  const runtime = {
    removeRuntimeApiKey: async (id) => { calls.push(`runtime.remove:${id}`); },
    logout: async (id) => { calls.push(`runtime.LOGOUT:${id}`); },
  };
  const result = await clearStoredApiKeys(["p1", "p2"], { keys, runtime });
  check("A5①：清完之后我们存的 provider 列表为空", store.providers.length === 0, JSON.stringify(store.providers));
  check("A5：逐个都成功了", result.ok.length === 2 && result.failed.length === 0, JSON.stringify(result));
  check("A5：**不用 `logout()`**（它会删 auth.json 里用户自己的凭据）",
    calls.every((c) => !c.includes("LOGOUT")), JSON.stringify(calls));
  check("A5：顺序是先清内存那把、再删 SecretStorage（反过来会留下夹生状态）",
    calls.join("|") === "runtime.remove:p1|store.remove:p1|runtime.remove:p2|store.remove:p2", JSON.stringify(calls));

  // 一个 provider 失败不能拖垮其余的
  const calls2 = [];
  const store2 = { providers: ["bad", "good"] };
  const r2 = await clearStoredApiKeys(["bad", "good"], {
    keys: { listProviders: () => [...store2.providers], getApiKey: async () => undefined, saveApiKey: async () => {},
      removeApiKey: async (id) => { store2.providers = store2.providers.filter((p) => p !== id); } },
    runtime: { removeRuntimeApiKey: async (id) => { calls2.push(id); if (id === "bad") throw new Error("boom"); } },
  });
  check("A5：一个失败不影响其余（失败项带原因）",
    r2.ok.length === 1 && r2.failed.length === 1 && r2.failed[0].providerId === "bad" && r2.failed[0].reason.includes("boom"),
    JSON.stringify(r2));
}

// ------------------------------------- S6 第 4 步：来源文案是纯函数（A6 的纯函数那一半）
{
  const sources = ["runtime", "stored", "models_json_key", "models_json_command", "fallback", "environment"];
  const labels = sources.map((source) => describeAuthSource(source));
  check("A6：6 档来源都有各不相同的文案（抽成纯函数才可能这样断言）",
    new Set(labels).size === 6 && labels.every((label) => label.startsWith("已配置")),
    JSON.stringify(labels));
  check("A6：未知来源 → 未配置（不瞎猜）", describeAuthSource(undefined) === "未配置", describeAuthSource(undefined));
  check("A6：面板存的与 auth.json 的能区分开", labels[0] !== labels[1], `${labels[0]} vs ${labels[1]}`);
}

// ------------------------------------- S6 第 6 步：`Pi: Refresh Model Catalog`（A8）
//
// 驱动的是**真命令**（`registerCommands` 注册、`executeCommand` 调）与**真 pi**（`loadPi` 走
// `pi-runtime/dist/bundle/index.js`）；只把"刷新"与两个计数源换成可控的 —— 否则这条断言
// 要么真发网络请求，要么只能对着硬编码文案照镜子。
{
  /** 命令里真的会碰到的上下文成员（`commands.ts` 只用了这几个）。 */
  function makeExtensionContext(extensionPath) {
    const secrets = new Map();
    const globalState = new Map();
    return {
      extensionUri: vscode.Uri.file(extensionPath),
      extension: { packageJSON: { version: "0.0.0-check" } },
      subscriptions: [],
      secrets: {
        get: (key) => Promise.resolve(secrets.get(key)),
        store: (key, value) => { secrets.set(key, value); return Promise.resolve(); },
        delete: (key) => { secrets.delete(key); return Promise.resolve(); },
      },
      globalState: {
        get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
        update: (key, value) => { globalState.set(key, value); return Promise.resolve(); },
      },
    };
  }

  resetStub();
  const context = makeExtensionContext(REPO_ROOT);
  const commandOutput = makeOutput();
  registerCommands(context, commandOutput);
  check(
    "A8：命令注册了 jerrypi.refreshModelCatalog",
    callsOf("registerCommand").some((call) => call.id === "jerrypi.refreshModelCatalog"),
    JSON.stringify(callsOf("registerCommand").map((call) => call.id)),
  );

  // 夹具 agentDir：真的 loadPi + 真的 ModelRuntime（`allowModelNetwork:false`，创建期不联网），
  // 然后把实例上的三个入口换成可控的 —— 命令拿到的必须是**同一个**缓存实例。
  const savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  const refreshAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-host-refresh-"));
  process.env.PI_CODING_AGENT_DIR = refreshAgentDir;
  try {
    const piModule = await loadPi(REPO_ROOT);
    const runtime = await getModelRuntime(piModule, piModule.getAgentDir(), {
      listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {}, removeApiKey: async () => {},
    });
    let providerCount = 2;
    let modelCount = 3;
    const refreshCalls = [];
    const refreshErrors = new Map();
    runtime.getProviders = () => new Array(providerCount).fill({});
    runtime.getAvailableSnapshot = () => new Array(modelCount).fill({});
    runtime.refresh = async (options) => {
      refreshCalls.push(options);
      providerCount = 5;
      modelCount = 9;
      return { aborted: false, errors: refreshErrors };
    };

    await vscode.commands.executeCommand("jerrypi.refreshModelCatalog");
    check("A8：一次点击只调一次 `refresh`，且显式 `allowNetwork: true`",
      refreshCalls.length === 1 && refreshCalls[0]?.allowNetwork === true, JSON.stringify(refreshCalls));
    const info = callsOf("showInformationMessage");
    check("A8：文案里的数字来自刷新**前后**的计数（provider 2 → 5、模型 3 → 9）",
      info.length === 1 && /2\s*→\s*5/.test(String(info[0].message)) && /3\s*→\s*9/.test(String(info[0].message)),
      String(info[0]?.message));

    // 有 provider 刷新失败时：失败要在消息与 Output 里都留痕，不能静默
    // 注意：`resetStub()` 会连命令注册表一起清掉（状态挂在 globalThis 上），所以要重新注册。
    resetStub();
    registerCommands(context, commandOutput);
    refreshErrors.set("broken-provider", new Error("catalog exploded"));
    providerCount = 5;
    modelCount = 9;
    await vscode.commands.executeCommand("jerrypi.refreshModelCatalog");
    const warns = callsOf("showWarningMessage");
    check("A8：有刷新失败时用警告消息点名（不静默）",
      warns.length === 1 && String(warns[0].message).includes("broken-provider"), String(warns[0]?.message));
    check("A8：失败原因记进 Output",
      commandOutput.lines.some((line) => line.includes("broken-provider") && line.includes("catalog exploded")),
      commandOutput.lines.filter((line) => line.includes("broken-provider")).join(" ｜ "));
  } finally {
    if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
    fs.rmSync(refreshAgentDir, { recursive: true, force: true });
  }
}

// ------------------------------------- S6 第 4 步的后半：`Pi: Set API Key` 的 QuickPick 与三态校验（A6b/A7）
//
// 与 A8 同一套夹具：真命令 + 真 pi + 同一缓存实例（`getModelRuntime` 按 agentDir 缓存），
// 只把 provider 目录之外的运行时入口换成可控的。
{
  function makeExtensionContext(extensionPath) {
    const secrets = new Map();
    const globalState = new Map();
    return {
      extensionUri: vscode.Uri.file(extensionPath),
      extension: { packageJSON: { version: "0.0.0-check" } },
      subscriptions: [],
      secrets: {
        get: (key) => Promise.resolve(secrets.get(key)),
        store: (key, value) => { secrets.set(key, value); return Promise.resolve(); },
        delete: (key) => { secrets.delete(key); return Promise.resolve(); },
      },
      globalState: {
        get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
        update: (key, value) => { globalState.set(key, value); return Promise.resolve(); },
      },
    };
  }

  const savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  const keyAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-host-keys-"));
  process.env.PI_CODING_AGENT_DIR = keyAgentDir;
  try {
    const piModule = await loadPi(REPO_ROOT);
    const runtime = await getModelRuntime(piModule, piModule.getAgentDir(), {
      listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {}, removeApiKey: async () => {},
    });
    const injected = [];
    runtime.setRuntimeApiKey = async (id, key) => { injected.push([id, key]); };

    // A6b：候选来自 **pi 自己**（`getProviders()`），描述来自 `describeAuthSource(source)`
    resetStub();
    const context = makeExtensionContext(REPO_ROOT);
    const commandOutput = makeOutput();
    registerCommands(context, commandOutput);
    queueQuickPickResponse(undefined); // 看完 items 就按 Esc
    await vscode.commands.executeCommand("jerrypi.setApiKey");
    const picks = callsOf("showQuickPick");
    const items = picks[0]?.items ?? [];
    const knownItems = items.filter((item) => !String(item.label).startsWith("其他（"));
    const providerIds = runtime.getProviders().map((provider) => provider.id);
    check("A6b：QuickPick 的候选数与 `getProviders()` 一致（不是硬编码清单）",
      knownItems.length === providerIds.length && providerIds.length > 7,
      `items=${knownItems.length}｜getProviders=${providerIds.length}`);
    check("A6b：每个 provider id 都在，且 deepseek 被置顶",
      providerIds.every((id) => knownItems.some((item) => item.label === id)) && String(knownItems[0]?.label) === "deepseek",
      JSON.stringify(knownItems.slice(0, 3).map((item) => item.label)));
    const expectedDescription = describeAuthSource(runtime.getProviderAuthStatus("deepseek").source);
    check("A6b：描述是 `describeAuthSource(source)` 的返回（不是 listCredentials 那样混源的）",
      String(knownItems.find((item) => item.label === "deepseek")?.description ?? "").includes(expectedDescription),
      `expected≈${expectedDescription}｜got=${String(knownItems.find((item) => item.label === "deepseek")?.description)}`);

    // A7 三态（Q3：**只本地判定，不发请求**）：run 一次真命令，分别造三种判定结果
    const runSetKey = async (checkAuthResult, availableModels) => {
      resetStub();
      registerCommands(context, commandOutput);
      runtime.setRuntimeApiKey = async (id, key) => { injected.push([id, key]); };
      runtime.checkAuth = async () => checkAuthResult;
      runtime.getAvailable = async () => availableModels;
      queueQuickPickResponse((all) => all.find((item) => item.label === "deepseek"));
      queueInputBoxAnswer("sk-host-check-not-a-real-key");
      await vscode.commands.executeCommand("jerrypi.setApiKey");
    };

    await runSetKey({ configured: true }, [{}, {}]);
    const okMessages = callsOf("showInformationMessage");
    check("A7：正常态 → 信息消息报可用模型数",
      okMessages.length === 1 && String(okMessages[0].message).includes("2 个可用模型"), String(okMessages[0]?.message));
    check("A7：key 经过 `injectApiKey` 真的注入了已缓存实例（不是只写了 SecretStorage）",
      injected.some(([id, key]) => id === "deepseek" && key === "sk-host-check-not-a-real-key"), JSON.stringify(injected));

    await runSetKey(undefined, []);
    const badAuth = callsOf("showWarningMessage");
    check("A7：`checkAuth` 无结果 → 警告“不接受 API key”",
      badAuth.length === 1 && String(badAuth[0].message).includes("不接受 API key"), String(badAuth[0]?.message));

    await runSetKey({ configured: true }, []);
    const noModels = callsOf("showWarningMessage");
    check("A7：目录里没有可用模型 → 警告点出**生效的 agentDir 绝对路径**（R-S6-2）",
      noModels.length === 1 && String(noModels[0].message).includes("没有可用模型") && String(noModels[0].message).includes(keyAgentDir),
      String(noModels[0]?.message));

    // A9：`Pi: Open Settings File` 打开的是 <生效 agentDir>/settings.json（C3 的一部分）
    resetStub();
    registerCommands(context, commandOutput);
    await vscode.commands.executeCommand("jerrypi.openSettingsFile");
    const opened = callsOf("showTextDocument");
    const expectedFile = path.join(keyAgentDir, "settings.json");
    check("A9：打开的是 <生效 agentDir>/settings.json",
      opened.length === 1 && String(opened[0].uri).endsWith(expectedFile),
      `expected …${expectedFile}｜got=${String(opened[0]?.uri)}`);
    check("A9：目录已存在时，缺失的 settings.json 用 `{}` 建出来",
      fs.existsSync(expectedFile) && fs.readFileSync(expectedFile, "utf8").trim() === "{}",
      fs.existsSync(expectedFile) ? JSON.stringify(fs.readFileSync(expectedFile, "utf8")) : "（没建）");

    // A9 的反向分支（评审 N6）：目录不存在时**报错、不替用户建目录**
    resetStub();
    registerCommands(context, commandOutput);
    const missingAgentDir = path.join(os.tmpdir(), `jerrypi-host-missing-${Date.now()}`);
    process.env.PI_CODING_AGENT_DIR = missingAgentDir;
    try {
      await vscode.commands.executeCommand("jerrypi.openSettingsFile");
      const warn = callsOf("showWarningMessage");
      check("A9：目录不存在 → 警告里说清“谁会在什么时候建它”",
        warn.length === 1 && String(warn[0].message).includes("还不存在") && String(warn[0].message).includes("发一条消息"),
        String(warn[0]?.message));
      check("A9：目录不存在时不替用户建目录、也不开文件",
        !fs.existsSync(missingAgentDir) && callsOf("showTextDocument").length === 0,
        `dirExists=${fs.existsSync(missingAgentDir)}｜opened=${callsOf("showTextDocument").length}`);
    } finally {
      process.env.PI_CODING_AGENT_DIR = keyAgentDir;
      fs.rmSync(missingAgentDir, { recursive: true, force: true });
    }
  } finally {
    if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
    fs.rmSync(keyAgentDir, { recursive: true, force: true });
  }
}

// ------------------------------------- S7 第 1 步：unified patch → 两侧（A1）
//
// 夹具是 **diff@8.0.4 的实跑输出**（S7-plan §0.1 那一段，逐字节抄下来的），不是
// "我想象中的 patch" —— 判据的两侧文本也是手写死的期望值，不用被测实现算。
{
  /** 造夹具：hunk 头 + 正文行（`-`/`+`/` ` 前缀由调用方写好）。 */
  const patchOf = (...lines) => `${lines.join("\n")}\n`;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const show = (v) => JSON.stringify(v).slice(0, 160);

  // ① 单行文件整行替换
  {
    const p = patchOf("--- a.ts", "+++ a.ts", "@@ -1,1 +1,1 @@", "-a", "+b");
    const r = sidesOfPatch(p);
    check("A1：单行文件整行替换 → 两侧", eq(r.left, "a\n") && eq(r.right, "b\n"), show(r));
    check("A1：同一个 patch 的 hunks 逐行", eq(r.hunks, [{ left: ["a"], right: ["b"] }]), show(r.hunks));
  }

  // ② 多 hunk（改动相隔很远；左侧必须出现分隔行）
  {
    const p = patchOf(
      "--- a.ts", "+++ a.ts",
      "@@ -1,7 +1,7 @@",
      " L0", " L1", "-L2", "+X2", " L3", " L4", " L5", " L6",
      "@@ -22,9 +22,9 @@",
      " L21", " L22", " L23", " L24", "-L25", "+Y25", " L26", " L27", " L28", " L29",
    );
    const r = sidesOfPatch(p);
    check(
      "A1：多 hunk → 两段之间插分隔行（不是假装连着）",
      eq(r.left, "L0\nL1\nL2\nL3\nL4\nL5\nL6\n⋯（中间省略）\nL21\nL22\nL23\nL24\nL25\nL26\nL27\nL28\nL29\n") &&
        eq(r.right, "L0\nL1\nX2\nL3\nL4\nL5\nL6\n⋯（中间省略）\nL21\nL22\nL23\nL24\nY25\nL26\nL27\nL28\nL29\n"),
      show(r),
    );
    check(
      "A1：多 hunk 的 hunks 是两段（每段含它自己的上下文行）",
      r.hunks.length === 2 &&
        eq(r.hunks[0], {
          left: ["L0", "L1", "L2", "L3", "L4", "L5", "L6"],
          right: ["L0", "L1", "X2", "L3", "L4", "L5", "L6"],
        }) &&
        eq(r.hunks[1], {
          left: ["L21", "L22", "L23", "L24", "L25", "L26", "L27", "L28", "L29"],
          right: ["L21", "L22", "L23", "L24", "Y25", "L26", "L27", "L28", "L29"],
        }),
      show(r.hunks),
    );
  }

  // ③ 纯新增（左空）/ ④ 纯删除（右空）
  {
    const add = sidesOfPatch(patchOf("--- a.ts", "+++ a.ts", "@@ -0,0 +1,2 @@", "+l1", "+l2"));
    check("A1：纯新增 → 左侧是空串（不是空行）", eq(add.left, "") && eq(add.right, "l1\nl2\n"), show(add));
    const del = sidesOfPatch(patchOf("--- a.ts", "+++ a.ts", "@@ -1,2 +0,0 @@", "-a", "-b"));
    check("A1：纯删除 → 右侧是空串", eq(del.left, "a\nb\n") && eq(del.right, ""), show(del));
  }

  // ⑤ 无尾换行（标记作用于**紧邻的上一行**；两侧各一次）
  {
    const p = patchOf("--- a.ts", "+++ a.ts", "@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+B", "\\ No newline at end of file");
    const r = sidesOfPatch(p);
    check("A1：无尾换行 → 两侧都不补尾换行", eq(r.left, "a\nb") && eq(r.right, "a\nB"), show(r));
  }
  // ⑤b 只有一侧无尾换行（评审 N1 实测过的形态）
  {
    const p = patchOf("--- a.ts", "+++ a.ts", "@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b");
    const r = sidesOfPatch(p);
    check("A1：只左侧无尾换行时，右侧照常补", eq(r.left, "a\nb") && eq(r.right, "a\nb\n"), show(r));
  }

  // ⑥ 容忍：hunk 头不带 ,count（别的 patch 源）+ section heading
  {
    const bare = sidesOfPatch(patchOf("--- a.ts", "+++ a.ts", "@@ -2 +2 @@", "-x", "+y"));
    check("A1：hunk 头不带 ,count 也能解析", eq(bare.left, "x\n") && eq(bare.right, "y\n"), show(bare));
    const heading = sidesOfPatch(patchOf("--- a.ts", "+++ a.ts", "@@ -1,3 +1,3 @@ function foo()", " a", "-b", "+B", " c"));
    check("A1：hunk 头带 section heading 也能解析", eq(heading.left, "a\nb\nc\n") && eq(heading.right, "a\nB\nc\n"), show(heading));
  }

  // ⑦ 正文行里的 \r 是内容（评审 S2：不能"归一化行尾"）
  {
    const p = patchOf("--- a.ts", "+++ a.ts", "@@ -1,2 +1,2 @@", " a\r", "-b\r", "+B\r");
    const r = sidesOfPatch(p);
    check("A1：正文里的 \\r 原样保留", eq(r.left, "a\r\nb\r\n") && eq(r.right, "a\r\nB\r\n"), show(r));
  }

  // ⑧ 文件名（标题用）：`+++` 优先；Windows 反斜杠；GNU diff 的时间戳尾巴
  {
    check("A1：pathLabelOf 取 +++ 一侧的文件名", pathLabelOf(patchOf("--- a/old.ts", "+++ a/new.ts", "@@ -1 +1 @@", "-a", "+b")) === "new.ts", pathLabelOf(patchOf("--- a/old.ts", "+++ a/new.ts", "@@ -1 +1 @@", "-a", "+b")));
    check("A1：Windows 形态的路径也取得到 basename", pathLabelOf(patchOf("--- C:\\dir\\old.ts", "+++ C:\\dir\\new.ts", "@@ -1 +1 @@", "-a", "+b")) === "new.ts", pathLabelOf(patchOf("--- C:\\dir\\old.ts", "+++ C:\\dir\\new.ts", "@@ -1 +1 @@", "-a", "+b")));
    check("A1：带时间戳尾巴时只取文件名", pathLabelOf(patchOf("--- a.ts\t2026-01-01 12:00:00 +0800", "+++ a.ts\t2026-01-01 12:00:00 +0800", "@@ -1 +1 @@", "-a", "+b")) === "a.ts", pathLabelOf(patchOf("--- a.ts\t2026-01-01 12:00:00 +0800", "+++ a.ts\t2026-01-01 12:00:00 +0800", "@@ -1 +1 @@", "-a", "+b")));
    check("A1：没有任何头时返回空串（不瞎猜）", pathLabelOf("@@ -1 +1 @@\n-a\n+b\n") === "", pathLabelOf("@@ -1 +1 @@\n-a\n+b\n"));
  }
}

// ------------------------------- S7 第 2 步：filechanges 的 store 与重放登记（A2/A4/A10）
//
// 三条断言都对着**真实形态**（不是人造夹具）：
//   - A2① 条数上限只数活记录（评审第 2 轮 B1 的死锁就出在这里）
//   - A2② patch 可覆盖墓碑（重放的真实形态：会话里 edit 超过上限）
//   - A4①② 重放只登记 edit、write 的"不可用"是派生的（第 1 轮 B1 的覆盖缺口）
//   - A10 失败的 edit（`details = {}`）既不登记也不给"不可用"
{
  const P = (n) => `--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-x${n}\n+y${n}\n`;
  const editMsg = (id, patch) => ({ role: "toolResult", toolName: "edit", toolCallId: id, details: { patch } });
  const failedEdit = (id) => ({ role: "toolResult", toolName: "edit", toolCallId: id, details: {}, isError: true });
  const writeMsg = (id) => ({ role: "toolResult", toolName: "write", toolCallId: id });

  // ---- A2①：条数上限只数活记录（默认墓碑上限很宽，先单看这一条语义）
  {
    const store = createFileChanges({ maxPatches: 3 });
    for (let i = 0; i < 10; i++) store.recordEdit({ toolCallId: `p${i}`, path: "a.ts", patch: P(i) });
    check("A2①：活记录数 === 上限（墓碑不占名额）", store.size().live === 3, JSON.stringify(store.size()));
    const tomb = store.get("p0");
    check("A2①：最早的记录变成墓碑（不是消失）", tomb?.kind === "unavailable" && tomb.why === "evicted", JSON.stringify(tomb));
    check("A2①：最近 3 条还在", store.get("p9")?.kind === "patch" && store.get("p7")?.kind === "patch", JSON.stringify(store.get("p7")));
    check(
      "A2①：墓碑一条也不比活记录少（10 插 3 活 → 7 墓碑）",
      store.size().tombstones === 7,
      JSON.stringify(store.size()),
    );
  }

  // ---- A2①b：墓碑自己也有上限（超了丢最旧的，回落成 none —— 不是坏链）
  {
    const store = createFileChanges({ maxPatches: 1, maxTombstones: 2 });
    for (let i = 0; i < 5; i++) store.recordEdit({ toolCallId: `q${i}`, path: "a.ts", patch: P(i) });
    check("A2①b：墓碑条数封顶", store.size().tombstones === 2, JSON.stringify(store.size()));
    check("A2①b：最旧的墓碑被丢掉（get 不到 → 派生为 none）", store.get("q0") === undefined, JSON.stringify(store.get("q0")));
    check("A2①b：最新那个墓碑还在（留的是近期的）", store.get("q3")?.kind === "unavailable", JSON.stringify(store.get("q3")));
  }

  // ---- A2②：patch 可覆盖墓碑（重放的真实形态）
  {
    const store = createFileChanges({ maxPatches: 1, maxTombstones: 10 });
    store.recordEdit({ toolCallId: "e1", path: "a.ts", patch: P(1) });
    store.recordEdit({ toolCallId: "e2", path: "a.ts", patch: P(2) });
    check("A2②：上限 1 时 e1 被淘汰成墓碑", store.get("e1")?.kind === "unavailable", JSON.stringify(store.get("e1")));
    store.recordEdit({ toolCallId: "e1", path: "a.ts", patch: P(1) });
    check(
      "A2②：同 id 再登记 patch → 墓碑被救回来（重启后 edit 仍可打开）",
      store.get("e1")?.kind === "patch",
      JSON.stringify(store.get("e1")),
    );
    check("A2②：救回来之后 e2 变成墓碑（仍然只有一个活记录）", store.get("e2")?.kind === "unavailable", JSON.stringify(store.get("e2")));
  }

  // ---- A2③：单条过大 / 读失败 → unavailable，且内容**没有**存进来
  {
    const store = createFileChanges({ maxSingleBytes: 64 });
    store.recordEdit({ toolCallId: "big", path: "a.ts", patch: `--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-${"x".repeat(200)}\n+y\n` });
    const rec = store.get("big");
    check("A2③：单条超过上限 → unavailable{too-large}", rec?.kind === "unavailable" && rec.why === "too-large", JSON.stringify(rec));
    check("A2③：没有把 patch 存进来", rec?.kind !== "patch", JSON.stringify(rec));
    store.recordWrite({ toolCallId: "w1", path: "b.ts", before: null, after: "x", newFile: true, failure: "read-failed" });
    const w = store.get("w1");
    check("A2③：write 读失败 → unavailable{read-failed}", w?.kind === "unavailable" && w.why === "read-failed", JSON.stringify(w));
  }

  // ---- A2④：write 的前后内容按 FIFO 淘汰；字节上限对两侧都生效
  {
    const store = createFileChanges({ maxSnapshots: 2, maxSnapshotBytes: 1000 });
    store.recordWrite({ toolCallId: "w1", path: "b.ts", before: null, after: "one", newFile: true });
    store.recordWrite({ toolCallId: "w2", path: "b.ts", before: "one", after: "two", newFile: false });
    store.recordWrite({ toolCallId: "w3", path: "b.ts", before: "two", after: "three", newFile: false });
    check("A2④：write 超过条数上限 → 最旧的成墓碑", store.get("w1")?.kind === "unavailable" && store.get("w2")?.kind === "snapshot", JSON.stringify(store.get("w1")));
    const fat = createFileChanges({ maxSnapshotBytes: 8 });
    fat.recordWrite({ toolCallId: "big", path: "b.ts", before: "x".repeat(50), after: "y".repeat(50), newFile: false });
    check("A2④：write 超过字节上限 → 也成墓碑", fat.get("big")?.kind === "unavailable", JSON.stringify(fat.get("big")));
  }

  // ---- A4：重放口径（① 空 store；② 先有实时快照再重放 —— ② 才是能红的那条）
  {
    const store = createFileChanges();
    recordEditsFromMessages([editMsg("e1", P(1)), writeMsg("w1")], store);
    check(
      "A4①：重放登记 edit 的 patch（write 没有 details，登记不了）",
      store.get("e1")?.kind === "patch" && store.get("w1") === undefined,
      JSON.stringify([store.get("e1"), store.get("w1")]),
    );
    check(
      "A4①：没有记录的 write → 派生为 diffUnavailable:none",
      JSON.stringify(diffFieldsOf(store, { toolCallId: "w1", toolName: "write", isError: false, pending: false })) ===
        JSON.stringify({ diffUnavailable: "none" }),
      JSON.stringify(diffFieldsOf(store, { toolCallId: "w1", toolName: "write", isError: false, pending: false })),
    );

    const s2 = createFileChanges();
    s2.recordWrite({ toolCallId: "w1", path: "b.ts", before: null, after: "one", newFile: true });
    recordEditsFromMessages([editMsg("e1", P(1)), writeMsg("w1")], s2);
    check(
      "A4②：重放**不会**把实时快照改写成 unavailable",
      s2.get("w1")?.kind === "snapshot" &&
        JSON.stringify(diffFieldsOf(s2, { toolCallId: "w1", toolName: "write", isError: false, pending: false })) ===
          JSON.stringify({ diff: "snapshot" }),
      JSON.stringify([s2.get("w1"), diffFieldsOf(s2, { toolCallId: "w1", toolName: "write", isError: false, pending: false })]),
    );
  }

  // ---- A10：失败的 edit（details = {}）既不登记、也不给"不可用"
  {
    const store = createFileChanges();
    recordEditsFromMessages([failedEdit("bad")], store);
    check("A10：失败的 edit 不登记", store.get("bad") === undefined, JSON.stringify(store.get("bad")));
    const fields = diffFieldsOf(store, { toolCallId: "bad", toolName: "edit", isError: true, pending: false });
    check("A10：失败的工具卡片两个字段都缺席", JSON.stringify(fields) === "{}", JSON.stringify(fields));
    const ok = diffFieldsOf(store, { toolCallId: "missing", toolName: "edit", isError: false, pending: false });
    check("A10：成功的 edit 但没有记录 → 才给 none", JSON.stringify(ok) === JSON.stringify({ diffUnavailable: "none" }), JSON.stringify(ok));
  }

  // ---- A6：真写工具（真 pi、不用模型）—— 同一文件顺序两次写，before/after 必须接得上
  //
  // ⚠️ 这是 host-check **第一次真执行 pi 的工具、真写盘**（此前它只碰 ModelRuntime 与
  // catalog，不碰文件系统）。所以按 AGENTS.md §4 的纪律：在 `os.tmpdir()` 下建一次性
  // 目录、`finally` 清理，**清理前断言目标就在那个目录之下**。
  {
    const piModule = await loadPi(REPO_ROOT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-check-write-"));
    const target = path.join(dir, "note.txt");
    const records = [];
    try {
      const tools = createCustomTools(piModule, dir, { record: (r) => records.push(r) });
      const writeTool = tools.find((tool) => tool.name === "write");
      check("A6：createCustomTools 里能找到被包装的 write", writeTool !== undefined, JSON.stringify(tools.map((t) => t.name)));
      if (writeTool !== undefined) {
        await writeTool.execute("id-1", { path: target, content: "X" }, undefined, undefined, { cwd: dir });
        await writeTool.execute("id-2", { path: target, content: "Y" }, undefined, undefined, { cwd: dir });
        check("A6：第一次写 → before=null / newFile", records[0]?.before === null && records[0]?.newFile === true, JSON.stringify(records[0]));
        check("A6：第一次写的 after 是写进去的内容", records[0]?.after === "X", JSON.stringify(records[0]?.after));
        check(
          "A6：第二次写 → before 正是第一次写进去的内容（互斥队列内读盘）",
          records[1]?.before === "X" && records[1]?.after === "Y",
          JSON.stringify(records[1]),
        );
        check("A6：磁盘上最终是第二次的内容", fs.readFileSync(target, "utf8") === "Y", fs.readFileSync(target, "utf8"));
      }
    } finally {
      // 清理守卫：只删我们自己建在 tmpdir 下的那个目录。
      if (!dir.startsWith(os.tmpdir() + path.sep)) {
        throw new Error(`host-check: 拒绝清理不在 tmpdir 下的目录：${dir}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- 运行中的卡片什么都不给（第 3 轮之后补的缺口）
  {
    const store = createFileChanges();
    check(
      "pending 的卡片既无 diff 也无文案",
      JSON.stringify(diffFieldsOf(store, { toolCallId: "x", toolName: "write", isError: false, pending: true })) === "{}",
      JSON.stringify(diffFieldsOf(store, { toolCallId: "x", toolName: "write", isError: false, pending: true })),
    );
  }
}

// ------------------------------------- S7 第 4 步：打开 diff（A3）
//
// 桩这一轮补了三件事（评审第 2 轮 B3：桩不够忠实，断言就是自欺）：
//   `Uri.parse` 真拆 scheme/path/query/fragment、`Uri.from` 按组件收、
//   `workspace.registerTextDocumentContentProvider` 与 `executeCommand("vscode.diff")`。
{
  const PATCH = [
    "--- rel/a.ts",
    "+++ rel/a.ts",
    "@@ -1,3 +1,3 @@",
    " L0",
    "-L1",
    "+X1",
    " L2",
    "@@ -20,3 +20,3 @@",
    " L19",
    "-L20",
    "+X20",
    " L21",
    "",
  ].join("\n");
  const makeLog = () => ({ lines: [], appendLine(line) { this.lines.push(line); } });
  const context = { subscriptions: [] };

  resetStub();
  const store = createFileChanges();
  store.recordEdit({ toolCallId: "call_1", path: "rel/a.ts", patch: PATCH });
  const log = makeLog();
  const presenter = createDiffPresenter(context, { store, log });

  const diffCalls = () => vscodeStub.callsOf("executeCommand").filter((call) => call.id === "vscode.diff");
  const opened = presenter.open("call_1");
  check("A3：已登记 → 真的打开了", opened === true, String(opened));
  check("A3：恰好一次 vscode.diff", diffCalls().length === 1, String(diffCalls().length));
  const [left, right, title, options] = diffCalls()[0]?.args ?? [];
  check(
    "A3：两个 URI 都是 jerrypi-diff:（不是 file:）",
    left?.scheme === DIFF_SCHEME && right?.scheme === DIFF_SCHEME,
    JSON.stringify([left?.scheme, right?.scheme]),
  );
  check("A3：标题含文件名与形态", typeof title === "string" && title.includes("a.ts") && title.includes("edit"), String(title));
  check("A3：preview 打开（不占死一个标签）", options?.preview === true, JSON.stringify(options));

  const provider = vscodeStub.contentProviderOf(DIFF_SCHEME);
  check("A3：注册了 jerrypi-diff 的虚拟文档 provider", provider !== undefined, String(provider));
  const sides = sidesOfPatch(PATCH);
  check(
    "A3：provider 给的左右与 sidesOfPatch 一致",
    provider?.provideTextDocumentContent(left) === sides.left &&
      provider?.provideTextDocumentContent(right) === sides.right,
    JSON.stringify([provider?.provideTextDocumentContent(left)?.slice(0, 40), provider?.provideTextDocumentContent(right)?.slice(0, 40)]),
  );

  // 未登记：不打开，且 Output 里要说得出为什么
  const beforeCount = diffCalls().length;
  const openedNope = presenter.open("call_nope");
  check("A3：未登记 → 不调用 vscode.diff", diffCalls().length === beforeCount && openedNope === false, String(diffCalls().length));
  check("A3：未登记 → Output 有一行说明", log.lines.some((line) => line.includes("call_nope")), log.lines.join(" | ").slice(0, 160));

  // write 的快照：左右是整文件前后；新文件时左侧空
  {
    store.recordWrite({ toolCallId: "call_w", path: "/tmp/dir/b.ts", before: "旧\n", after: "新\n", newFile: false });
    presenter.open("call_w");
    const last = diffCalls().at(-1);
    const [wl, wr, wt] = last?.args ?? [];
    check("A3：write 的左右是整文件前后", provider?.provideTextDocumentContent(wl) === "旧\n" && provider?.provideTextDocumentContent(wr) === "新\n", JSON.stringify(wt));
    check("A3：write 的标题写的是 write 形态", typeof wt === "string" && wt.includes("b.ts") && wt.includes("write"), String(wt));
    store.recordWrite({ toolCallId: "call_new", path: "/tmp/dir/new.ts", before: null, after: "内容\n", newFile: true });
    presenter.open("call_new");
    const [nl, , nt] = diffCalls().at(-1)?.args ?? [];
    check("A3：新文件 → 左侧空 + 标题写「新建」", provider?.provideTextDocumentContent(nl) === "" && String(nt).includes("新建"), String(nt));
  }

  // 不可用：记过墓碑的也不打开
  {
    const s2 = createFileChanges({ maxPatches: 1 });
    s2.recordEdit({ toolCallId: "a", path: "a.ts", patch: PATCH });
    s2.recordEdit({ toolCallId: "b", path: "b.ts", patch: PATCH });
    const log2 = makeLog();
    const p2 = createDiffPresenter({ subscriptions: [] }, { store: s2, log: log2 });
    const openedGone = p2.open("a");
    check("A3：墓碑（已淘汰）→ 不打开", openedGone === false, String(openedGone));
    check("A3：墓碑 → Output 写出原因", log2.lines.some((line) => line.includes("evicted")), log2.lines.join(" | ").slice(0, 160));
  }

  // Windows 形态的 patch 头 + 名字里带 #/?/空格：Uri.from 按组件收，编码发生在 toString
  {
    const s3 = createFileChanges();
    s3.recordEdit({ toolCallId: "win", path: "C:\\dir\\b.ts", patch: "--- C:\\dir\\b.ts\n+++ C:\\dir\\b.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n" });
    s3.recordEdit({
      toolCallId: "hash",
      path: "a#b c?.ts",
      patch: "--- a#b c?.ts\n+++ a#b c?.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n",
    });
    const p3 = createDiffPresenter({ subscriptions: [] }, { store: s3, log: makeLog() });
    const beforeWin = diffCalls().length;
    p3.open("win");
    check("A3：Windows 形态的头也取得到 b.ts 作标题", String(diffCalls().at(-1)?.args?.[2] ?? "").includes("b.ts"), String(diffCalls().at(-1)?.args?.[2] ?? ""));
    p3.open("hash");
    check("A3：带 #/?/空格的路径也打开了（没被 parse 吃掉）", diffCalls().length === beforeWin + 2, String(diffCalls().length));
    const hashLeft = diffCalls().at(-1)?.args?.[0];
    const asText = String(hashLeft);
    check(
      "A3：URI 文本里 %23/%3F/%20 都在（编码发生在 toString）",
      asText.includes("%23") && asText.includes("%3F") && asText.includes("%20"),
      asText,
    );
    const reparsed = vscodeStub.Uri.parse(asText);
    check(
      "A3：再解析回来：fragment 为空、路径没被截断",
      (reparsed.fragment === undefined || reparsed.fragment === "") && reparsed.path.includes("a#b c?.ts"),
      JSON.stringify([reparsed.fragment, reparsed.path]),
    );
    check("A3：provider 仍然认得出它（内容对）", vscodeStub.contentProviderOf(DIFF_SCHEME)?.provideTextDocumentContent(hashLeft) === "a\n", String(vscodeStub.contentProviderOf(DIFF_SCHEME)?.provideTextDocumentContent(hashLeft)));
  }
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
