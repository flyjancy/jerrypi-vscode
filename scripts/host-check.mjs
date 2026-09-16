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
const { resetStub, callsOf, stubCalls, queueQuickPickResponse, queueWarningResponse, queueInformationResponse, queueInputBoxAnswer, queueConfiguration, fireConfigurationChange, setWorkspaceFolders } = stub;

const results = [];
const check = (name, ok, detail = "") => results.push([name, ok, detail]);

/** 假 WebviewView：只实现 provider 真的会碰的成员。 */
function makeView() {
  let listener;
  let disposeListener;
  const posted = [];
  return {
    posted,
    /** S8：`chatView` 用 `view.visible` 决定"要不要弹通知"（Q9/Q10）。 */
    visible: false,
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
    onDidDispose(fn) {
      disposeListener = fn;
      return { dispose() {} };
    },
    /** 真输入：模拟"视图被销毁"（VS Code 会发这个事件）。 */
    disposeView() {
      disposeListener?.();
    },
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
      `export { PROTOCOL_VERSION } from ${JSON.stringify(path.join(REPO_ROOT, "src/shared/protocol"))};`,
      `export { sidesOfPatch, pathLabelOf, HUNK_GAP } from ${JSON.stringify(path.join(REPO_ROOT, "src/shared/patch"))};`,
      `export { createFileChanges, recordEditsFromMessages, diffFieldsOf } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/filechanges"))};`,
      `export { createCustomTools } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/custom-tools"))};`,
      `export { createDiffPresenter, DIFF_SCHEME } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/diff"))};`,
      `export { parseApprovalMode, needsApproval, createApprovals, createApprovalExtension, createApprovalModeReader, approvalTitleOf, denyReason, CANCEL_REASON, READ_ONLY_TOOLS, APPROVAL_MODES } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/approval"))};`,
      `export { createSessionHost } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/session"))};`,
      `export { SessionHostController } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/controller"))};`,
      `export { createSelfTestUIContext } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/selftest-ui"))};`,
      `export { createTrustResolver, applyTrustAction, trustParentOf, TRUST_ACTIONS, TRUST_ACTION_LABELS } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/trust"))};`,
      `export { createTrustPrompter, TRUST_REMEMBER_ITEM, TRUST_SESSION_ITEM, TRUST_DENY_ITEM } from ${JSON.stringify(path.join(REPO_ROOT, "src/host/trustPrompt"))};`,
      `export { isNpmSource, translateSourceError, describePackage, settingsPathOf, listPackages, installPackage, removePackage } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/packages"))};`,
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
const { ChatViewProvider, replaceSessionWithConfirm, sessionToItem, applyAgentDirSetting, registerAgentDirWatcher, describeAgentDir, ENV_AGENT_DIR, readAgentDirSetting, readProxySetting, readApprovalModeSetting, clearStoredApiKeys, describeAuthSource, registerCommands, loadPi, getModelRuntime, sidesOfPatch, pathLabelOf, createFileChanges, recordEditsFromMessages, diffFieldsOf, createCustomTools, createDiffPresenter, DIFF_SCHEME, PROTOCOL_VERSION, parseApprovalMode, needsApproval, createApprovals, createApprovalExtension, createApprovalModeReader, approvalTitleOf, denyReason, CANCEL_REASON, READ_ONLY_TOOLS, APPROVAL_MODES, createSessionHost, SessionHostController, createSelfTestUIContext, createTrustResolver, applyTrustAction, trustParentOf, TRUST_ACTIONS, TRUST_ACTION_LABELS, createTrustPrompter, TRUST_REMEMBER_ITEM, TRUST_SESSION_ITEM, TRUST_DENY_ITEM, isNpmSource, translateSourceError, describePackage, settingsPathOf, listPackages, installPackage, removePackage } =
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
  "state 里带 protocol 与 meta（读的是 PROTOCOL_VERSION，不是写死的数字）",
  stateMessages[0]?.protocol === PROTOCOL_VERSION &&
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

// ------------------------- S7 第 6 步：漂移守卫（A8）—— 真 pi 生成 + 独立实现当 oracle
//
// 为什么必须在这里（而不是 controller-check）：这是**纯函数**，不需要凭据也不需要模型；
// controller-check 没凭据时整体 SKIP，而 SKIP 不是 PASS（第 2 轮评审 S6）。
// oracle 是 `diff@8.0.4` 自己（断言期依赖，devDependencies；`--no-dependencies` 保证
// 不进 VSIX）—— 版本不符**显式失败**，不 SKIP（第 2 轮评审 S5）。
{
  const diffPkg = await import("diff/package.json", { with: { type: "json" } }).then((m) => m.default).catch(() => undefined);
  check("A8：oracle 的版本被钉死（diff@8.0.4）", diffPkg?.version === "8.0.4", String(diffPkg?.version));
  const Diff = await import("diff");
  const piModule = await loadPi(REPO_ROOT);

  /** jsdiff 的解析结果 → 每 hunk 的两侧行（**独立实现**，不经过我们的解析器）。 */
  const hunksFromJsdiff = (patch) => {
    const parsed = Diff.parsePatch(patch);
    const hunks = Array.isArray(parsed) ? parsed[0]?.hunks ?? [] : [];
    return hunks.map((hunk) => {
      const left = [];
      const right = [];
      for (const line of hunk.lines) {
        if (line === "\\ No newline at end of file") continue;
        const prefix = line[0];
        if (prefix === " ") {
          left.push(line.slice(1));
          right.push(line.slice(1));
        } else if (prefix === "-") left.push(line.slice(1));
        else if (prefix === "+") right.push(line.slice(1));
      }
      return { left, right };
    });
  };

  const cases = [
    ["单行文件整行替换", "a\n", "b\n"],
    ["改中间一行", "L0\nL1\nL2\nL3\nL4\nL5\n", "L0\nL1\nX2\nL3\nL4\nL5\n"],
    ["多个 hunk（相隔很远）", Array.from({ length: 40 }, (_, i) => `L${i}`).join("\n") + "\n", Array.from({ length: 40 }, (_, i) => (i === 2 ? "X2" : i === 30 ? "Y30" : `L${i}`)).join("\n") + "\n"],
    ["纯新增（左空）", "", "l1\nl2\n"],
    ["纯删除（右空）", "a\nb\n", ""],
    ["无尾换行（两侧）", "a\nb", "a\nB"],
    ["无尾换行（只左）", "a\nb", "a\nb\n"],
    ["CRLF 内容原样", "a\r\nb\r\n", "a\r\nB\r\n"],
  ];
  for (const [name, oldText, newText] of cases) {
    const patch = piModule.generateUnifiedPatch("rel/a.ts", oldText, newText);
    const ours = sidesOfPatch(patch);
    const expected = hunksFromJsdiff(patch);
    check(
      `A8：${name} → hunks 与 jsdiff 逐行一致`,
      JSON.stringify(ours.hunks) === JSON.stringify(expected),
      JSON.stringify({ ours: ours.hunks, jsdiff: expected }).slice(0, 240),
    );
    // ② 用**原封不动的整份 patch** 往返（不需要重写 hunk 头：jsdiff 自带偏移搜索）
    check(
      `A8：${name} → applyPatch(左, patch) === 右`,
      Diff.applyPatch(ours.left, patch) === ours.right,
      JSON.stringify({ applied: String(Diff.applyPatch(ours.left, patch)).slice(0, 80), right: ours.right.slice(0, 80) }),
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

// ------------------------------------- S8 第 1 步：三档判定、审批表、审批扩展（A1/A5b/A6）
//
// 这一段的**夹具全是真输入**：三档判定是纯函数、扩展那一半用 pi 的真实 handler 形态
// （`api.on("tool_call", handler)` 捕获后手工调用），只有 `approvals` 与 `log` 是断言端的替身
// —— 这正是 S8-plan §6 的分工（真 pi 的那一半在 A2/A3/A4/A6b）。
{
  const silentLog = { lines: [], appendLine(line) { this.lines.push(line); } };
  /**
   * 等一个"应该会收口"的 promise，**带超时**。
   *
   * 为什么必须有：`node` 在"顶层 await 永不收口、事件循环空转"时以 exit 13 退出，
   * 而且**一行输出都不打**（实测）—— 那时既看不到是哪条判据，也看不到前面的 ok。
   */
  const settled = async (promise, label, ms = 2000) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(`(未收口:${label})`), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // ---- A1：三档判定 + 只读集的漂移守卫（oracle = pi 自己的 createReadOnlyTools）
  {
    const eq = (a, b) => a === b;
    for (const raw of [undefined, null, "", "  ", "ALL", "Mutating", "yes", 7, {}]) {
      check(`A1：非法档位 ${JSON.stringify(raw)} → off`, eq(parseApprovalMode(raw), "off"), String(parseApprovalMode(raw)));
    }
    for (const mode of ["off", "mutating", "all"]) {
      check(`A1：合法档位 ${mode} 原样返回（前后空白容忍）`, eq(parseApprovalMode(`  ${mode} `), mode), String(parseApprovalMode(`  ${mode} `)));
    }
    const names = ["read", "grep", "find", "ls", "bash", "edit", "write", "powershell", "smoke_tool", "MCP_note"];
    const expected = {
      off: names.map(() => false),
      mutating: names.map((n) => !["read", "grep", "find", "ls"].includes(n)),
      all: names.map(() => true),
    };
    for (const mode of ["off", "mutating", "all"]) {
      const got = names.map((n) => needsApproval(mode, n));
      check(`A1：${mode} 档的真值表（含未知/扩展工具）`, JSON.stringify(got) === JSON.stringify(expected[mode]), JSON.stringify(got));
    }

    // 漂移守卫：pi 说哪些是只读的，我们就得放行哪些 —— 手改 READ_ONLY_TOOLS 会红（第 1 轮评审 S3）
    const piModule = await loadPi(REPO_ROOT);
    const oracleDir = fs.mkdtempSync(path.join(os.tmpdir(), "s8-oracle-"));
    try {
      const oracle = piModule.createReadOnlyTools(oracleDir).map((t) => t.name);
      check("A1：READ_ONLY_TOOLS 逐字等于 pi.createReadOnlyTools（漂移守卫）", JSON.stringify([...READ_ONLY_TOOLS]) === JSON.stringify(oracle), `ours=${JSON.stringify(READ_ONLY_TOOLS)} pi=${JSON.stringify(oracle)}`);
      check("A1：APPROVAL_MODES 与协议/设置里的三档一致", JSON.stringify([...APPROVAL_MODES]) === JSON.stringify(["off", "mutating", "all"]), JSON.stringify(APPROVAL_MODES));
    } finally {
      fs.rmSync(oracleDir, { recursive: true, force: true });
    }

    // R9：非法值只记一行，且不静默降级到"更弱的档"
    let raw = "bogus";
    const reader = createApprovalModeReader({ read: () => raw, log: silentLog });
    silentLog.lines.length = 0;
    check("A1：非法档位 → off", reader() === "off" && reader() === "off", JSON.stringify(silentLog.lines));
    check("A1：非法档位只记一行 Output（不刷屏）", silentLog.lines.length === 1, JSON.stringify(silentLog.lines));
    raw = "all";
    check("A1：改成合法档位后立刻生效、不再记", reader() === "all" && silentLog.lines.length === 1, JSON.stringify(silentLog.lines));
  }

  // ---- A5b：cancelled 与 deny 的理由必须分开（纯函数层；端到端会被 pi 覆盖成 Operation aborted）
  {
    const capture = (approvals, mode = () => "all") => {
      const extension = createApprovalExtension({ mode, approvals, cwd: "/w", log: silentLog });
      const handlers = [];
      const api = { on: (event, handler) => handlers.push([event, handler]) };
      extension.factory(api);
      check("A5b：扩展注册的是 tool_call 处理器", handlers.length === 1 && handlers[0][0] === "tool_call", JSON.stringify(handlers.map(([e]) => e)));
      check("A5b：具名 + hidden（F10b：具名才有 hidden）", extension.name === "jerrypi-approval" && extension.hidden === true, JSON.stringify({ name: extension.name, hidden: extension.hidden }));
      return handlers[0][1];
    };
    const event = { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "rm -rf /tmp/x" } };

    const denyHandler = capture({ ask: async () => "deny" });
    const denyResult = await denyHandler(event, { signal: undefined });
    const cancelHandler = capture({ ask: async () => "cancelled" });
    const cancelResult = await cancelHandler(event, { signal: undefined });
    check(
      "A5b：deny 的理由是 Rejected by user: <标题>",
      denyResult?.block === true && denyResult.reason === denyReason("rm -rf /tmp/x"),
      JSON.stringify(denyResult),
    );
    check(
      "A5b：cancelled 的理由与 deny **不同**（不许替用户拒绝）",
      cancelResult?.block === true && cancelResult.reason === CANCEL_REASON && !String(cancelResult.reason).includes("Rejected by user"),
      JSON.stringify(cancelResult),
    );
    const allowHandler = capture({ ask: async () => "allow" });
    check("A5b：allow → 什么都不返回（放行）", (await allowHandler(event, { signal: undefined })) === undefined);
    const offHandler = capture({ ask: async () => { throw new Error("不该被问到"); } }, () => "off");
    check("A5b：off 档连问都不问", (await offHandler(event, { signal: undefined })) === undefined);
    const readHandler = capture({ ask: async () => { throw new Error("不该被问到"); } }, () => "mutating");
    check("A5b：mutating 档放行只读工具", (await readHandler({ ...event, toolName: "read" }, { signal: undefined })) === undefined);
    const boom = capture({ ask: async () => { throw new Error("boom"); } });
    silentLog.lines.length = 0;
    // 抛出去这件事本身要被**断言**接住（否则脚本会以 unhandled rejection 崩掉，
    // 而"崩掉"虽然也是红，却看不出是哪条判据 —— F4 的形态必须能被指名）
    let boomResult;
    let boomThrew;
    try {
      boomResult = await boom(event, { signal: undefined });
    } catch (error) {
      boomThrew = error;
    }
    check(
      "A5b：审批出错时**拦下**（fail-closed）而不是抛出去（F4）",
      boomThrew === undefined && boomResult?.block === true && String(boomResult.reason).includes("approval failed") && silentLog.lines.length === 1,
      JSON.stringify([boomThrew?.message, boomResult, silentLog.lines]),
    );
    check("A5b：标题拿不到时退回参数摘要", approvalTitleOf("MCP_note", { text: "hi" }, "/w") === '{"text":"hi"}', approvalTitleOf("MCP_note", { text: "hi" }, "/w"));
  }

  // ---- A6：审批表的派生与上限（只数已决）
  {
    const pendingSeen = [];
    const approvals = createApprovals({ onPending: (r) => pendingSeen.push(r), log: silentLog, maxDecided: 5 });
    check("A6：没问过 → 不派生任何字段（off 档的常态）", JSON.stringify(approvals.fieldsOf("nope", true)) === "{}", JSON.stringify(approvals.fieldsOf("nope", true)));

    const asked = approvals.ask({ toolCallId: "t1", toolName: "bash", title: "ls", requestedAt: 1 }, undefined);
    check("A6：ask 会叫 onPending（面板据此就地更新卡片）", pendingSeen.length === 1 && pendingSeen[0].toolCallId === "t1", JSON.stringify(pendingSeen));
    check("A6：等答时派生 pending", JSON.stringify(approvals.fieldsOf("t1", true)) === '{"approval":"pending"}', JSON.stringify(approvals.fieldsOf("t1", true)));
    check("A6：卡片已经不是 pending 时不派生", JSON.stringify(approvals.fieldsOf("t1", false)) === "{}", JSON.stringify(approvals.fieldsOf("t1", false)));
    check("A6：size 把待答算在 pending 里", JSON.stringify(approvals.size()) === '{"pending":1,"decided":0}', JSON.stringify(approvals.size()));
    check("A6：答一次返回 true，再答返回 false", approvals.decide("t1", "allow") === true && approvals.decide("t1", "allow") === false);
    const askedOutcome = await settled(asked, "t1");
    check("A6：allow 的结果是放行", askedOutcome === "allow", String(askedOutcome));
    check("A6：放行之后不派生（卡片回普通形态）", JSON.stringify(approvals.fieldsOf("t1", false)) === "{}", JSON.stringify(approvals.fieldsOf("t1", false)));

    const denied = approvals.ask({ toolCallId: "t2", toolName: "write", title: "a.ts", requestedAt: 2 }, undefined);
    approvals.decide("t2", "deny");
    check("A6：拒绝后工具已结束时仍派生 denied", JSON.stringify(approvals.fieldsOf("t2", false)) === '{"approval":"denied"}', JSON.stringify(approvals.fieldsOf("t2", false)));
    const deniedOutcome = await settled(denied, "t2");
    check("A6：拒绝的理由走 decide 的返回值口径", deniedOutcome === "deny", String(deniedOutcome));

    // 中止路径：signal 触发 → cancelled（且 reason 与 deny 分开，见 A5b）
    const controller = new AbortController();
    const aborted = approvals.ask({ toolCallId: "t3", toolName: "bash", title: "x", requestedAt: 3 }, controller.signal);
    controller.abort();
    const abortedOutcome = await settled(aborted, "t3");
    check("A6：signal 触发 → cancelled", abortedOutcome === "cancelled", String(abortedOutcome));
    check("A6：cancelled 不派生（不冒充拒绝）", JSON.stringify(approvals.fieldsOf("t3", false)) === "{}", JSON.stringify(approvals.fieldsOf("t3", false)));
    const pre = new AbortController();
    pre.abort();
    const preOutcome = await settled(approvals.ask({ toolCallId: "t4", toolName: "bash", title: "x", requestedAt: 4 }, pre.signal), "t4");
    check("A6：进来时 signal 已经 abort → 直接 cancelled（连 onPending 都不叫）", preOutcome === "cancelled" && !pendingSeen.some((r) => r.toolCallId === "t4"), JSON.stringify({ preOutcome, seen: pendingSeen.map((r) => r.toolCallId) }));
    check("A6：未知 id 的 decide 返回 false（不抛）", approvals.decide("nope", "deny") === false);
    {
      // signal 的监听是"中止能收口"的**唯一**机制（端到端那条见 A4/A5；这里钉住机制本身：
      // 不注册监听的话 A4 会以超时红，但那要看 5 秒 —— 这条立刻就能报出来）
      const ctl = new AbortController();
      const pendingOne = approvals.ask({ toolCallId: "signal-probe", toolName: "bash", title: "s", requestedAt: 11 }, ctl.signal);
      ctl.abort();
      const probeOutcome = await settled(pendingOne, "signal-probe");
      check("A6：abort 之后 ask 立刻以 cancelled 收口（监听真的挂上了）", probeOutcome === "cancelled", String(probeOutcome));
    }

    // onPending 抛错也要收口（"ask 永不抛、永不无限挂"包的是整条路）
    const boomLog = { lines: [], appendLine(line) { this.lines.push(line); } };
    const boomApprovals = createApprovals({ onPending: () => { throw new Error("panel gone"); }, log: boomLog });
    const boomOutcome = await settled(boomApprovals.ask({ toolCallId: "boom", toolName: "bash", title: "x", requestedAt: 9 }, undefined), "boom");
    check("A6：onPending 抛错 → 按未回答收口（不挂死、不抛）", boomOutcome === "cancelled" && boomApprovals.size().pending === 0 && boomLog.lines.length === 1, JSON.stringify({ boomOutcome, size: boomApprovals.size(), lines: boomLog.lines }));

    // 上限：只数已决；待答的那条永远不会被淘汰（第 1 轮 N2；S7 墓碑教训的正面写法）
    const held = approvals.ask({ toolCallId: "keep", toolName: "bash", title: "keep", requestedAt: 5 }, undefined);
    for (let i = 0; i < 8; i++) {
      approvals.ask({ toolCallId: `d${i}`, toolName: "bash", title: `d${i}`, requestedAt: 10 + i }, undefined).catch(() => {});
      approvals.decide(`d${i}`, "deny");
    }
    check("A6：已决记录超上限时按 FIFO 丢最旧的", approvals.size().decided === 5 && approvals.get("d0") === undefined && approvals.get("d7") !== undefined, JSON.stringify({ size: approvals.size(), d0: approvals.get("d0") === undefined }));
    check("A6：待答的那条没有被淘汰", JSON.stringify(approvals.fieldsOf("keep", true)) === '{"approval":"pending"}', JSON.stringify(approvals.fieldsOf("keep", true)));

    // ⑥ **回顾评审（codex）P2**：答完之后 abort 监听必须失效 ——
    //    "先拒绝、这一轮里再点中止"是很常见的顺序，而"已拒绝"是给回放用的标记（A6b②）。
    {
      const ctl2 = new AbortController();
      const deniedThenAborted = approvals.ask({ toolCallId: "t5", toolName: "bash", title: "y", requestedAt: 6 }, ctl2.signal);
      approvals.decide("t5", "deny");
      await settled(deniedThenAborted, "t5");
      ctl2.abort(); // 用户随后点了「中止」
      check(
        "A6⑥：拒绝之后再中止，原来的 deny 不许被改写成 cancelled（codex 回顾评审 P2）",
        approvals.get("t5")?.decision === "deny" &&
          JSON.stringify(approvals.fieldsOf("t5", false)) === '{"approval":"denied"}',
        JSON.stringify({ decision: approvals.get("t5")?.decision, fields: approvals.fieldsOf("t5", false) }),
      );
    }

    // ⑦ **回顾评审（codex）P3**：上限必须覆盖**取消**这条路径（它也是"已决"）
    {
      const capApprovals = createApprovals({ log: silentLog, maxDecided: 5 });
      for (let i = 0; i < 12; i += 1) {
        const ctl3 = new AbortController();
        const p3 = capApprovals.ask({ toolCallId: `c${i}`, toolName: "bash", title: "c", requestedAt: 20 + i }, ctl3.signal);
        ctl3.abort();
        await settled(p3, `c${i}`);
      }
      check(
        "A6⑦：连续中止也不能让已决记录无限增长（上限覆盖取消路径；codex 回顾评审 P3）",
        capApprovals.size().decided <= 5,
        JSON.stringify(capApprovals.size()),
      );
    }

    // reset：会话替换/卸载 → 全部收口 + 清空
    approvals.reset();
    check("A6：reset 之后 pending 清零、已决也清空", JSON.stringify(approvals.size()) === '{"pending":0,"decided":0}', JSON.stringify(approvals.size()));
    const heldOutcome = await settled(held, "keep");
    check("A6：reset 把待答的收成 cancelled", heldOutcome === "cancelled", String(heldOutcome));
    check("A6：reset 之后旧 id 再也答不了", approvals.decide("keep", "allow") === false && approvals.get("keep") === undefined);
  }
}

// ------------------------------------- S8 第 2 步：真 pi + 假模型（A2/A3/A4/A5）
//
// **不用模型、不用凭据、不联网**地驱动真实的工具调用（S8-plan F8）：
//   · 假模型：`session.agent.streamFunction` 换成一个脚本化的 async iterable；
//   · 那把"内存 key"走**生产路径**注入（`ApiKeyStore` → `getModelRuntime` 的
//     `injectStoredApiKeys`），不碰任何磁盘上的凭据；
//   · agentDir / cwd / sessions 全是 `os.tmpdir()` 下的一次性目录（F8：假 key 会留在这个
//     ModelRuntime 里，而 `getModelRuntime` 按 agentDir 缓存 ⇒ 必须隔离）。
//
// 假流的三条纪律（S8-plan R2，都是探针挂过的地方）：
//   ① `opts.signal.aborted` → `stopReason:"aborted"`（否则 abort 之后循环不退出）；
//   ② 第一次吐工具调用、之后收尾（被拦下的调用**不会**终止循环，F7b）；
//   ③ 每个 `prompt()` 都套超时（挂死的断言最贵）。
{
  const piModule = await loadPi(REPO_ROOT);
  /** 扩展工具的夹具：仓库里现成的那个（selftest T3 用的同一个），只为拿到一个"未知工具" */
  const SMOKE_FIXTURE = path.join(REPO_ROOT, "test-fixtures", "ext-smoke", "index.ts");
  const approvalFixtures = [];

  /**
   * 造一个装了审批的会话宿主。
   *
   * `modeRef.mode` 是**可变**的：A3 要在**同一个会话**里切三档（第 1 轮评审 S2 的核心 ——
   * 换会话就分不清"没问"与"扩展没装上"）。
   */
  async function makeApprovalHost({
    modeRef,
    answer,
    toolName = "bash",
    input,
    subscribe,
    additionalExtensionPaths,
  }) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s8-approval-"));
    approvalFixtures.push(root);
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "ws");
    const sessionDir = path.join(root, "sessions", "--ws--");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    // ① 先建 runtime（拿到一个可用模型 + provider），再按**生产路径**注入内存 key
    const bootstrapRuntime = await piModule.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const model = bootstrapRuntime.getModels()[0];
    const keys = {
      listProviders: () => [model.provider],
      getApiKey: async (providerId) => (providerId === model.provider ? "probe-key" : undefined),
      saveApiKey: async () => {},
      removeApiKey: async () => {},
    };

    const asked = [];
    const log = { lines: [], appendLine(line) { this.lines.push(line); } };
    const approvals = createApprovals({
      log,
      onPending: (request) => {
        asked.push(request);
        // 回答走**真路径**（decide）：这样"面板答题"这件事和真机是同一条链
        const decision = typeof answer === "function" ? answer(request) : answer;
        if (decision === "allow" || decision === "deny") approvals.decide(request.toolCallId, decision);
      },
    });

    const host = await createSessionHost({
      pi: piModule,
      cwd,
      agentDir,
      sessionManager: piModule.SessionManager.create(cwd, sessionDir),
      keys,
      uiContext: createSelfTestUIContext(log),
      mode: "rpc",
      sink: log,
      model,
      approval: { mode: () => modeRef.mode, approvals },
      ...(additionalExtensionPaths === undefined ? {} : { additionalExtensionPaths }),
      onEvent: subscribe,
    });

    const calls = [];
    /**
     * 换一份模型剧本：第 i 次调用吐 `steps[i]`，用完就收尾（纯文本 stop）。
     *
     * 纪律（S8-plan R2）：① 尊重 signal；② **工具调用之后必须收尾** —— 被拦下的调用不会
     * 终止循环（F7b），剧本用完还接着吐工具调用就会无限转。
     */
    const script = (steps) => {
      let turn = 0;
      host.session.agent.streamFunction = async (m, _ctx, opts) => {
        const aborted = opts?.signal?.aborted === true;
        const step = aborted ? undefined : steps[turn];
        turn += 1;
        calls.push({ aborted, turn });
        const base = {
          role: "assistant",
          api: m.api,
          provider: m.provider,
          model: m.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0 } },
          timestamp: Date.now(),
        };
        const message = aborted
          ? { ...base, content: [{ type: "text", text: "(aborted)" }], stopReason: "aborted" }
          : step !== undefined
            ? { ...base, content: [{ type: "toolCall", id: step.id, name: step.name, arguments: step.arguments }], stopReason: "stop" }
            : { ...base, content: [{ type: "text", text: "(done)" }], stopReason: "stop" };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            yield { type: "done" };
          },
          async result() {
            return message;
          },
        };
      };
    };
    script([{ id: "call-1", name: toolName, arguments: input }]);

    const withTimeout = async (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)),
      ]);
    return { root, cwd, host, approvals, asked, calls, log, script, withTimeout };
  }

  /**
   * 带超时、吞错地卸载宿主。
   *
   * 为什么不能直接 `await host.dispose()`：待审批被卡住时 `dispose()` 会一直等下去
   * （内部的 abort 要等这一轮收口），而**在 `finally` 里挂住**会让整个脚本以 exit 13
   * 静默退出 —— 前面所有 ok/FAIL 一行都打不出来。
   */
  const safeDispose = async (host) => {
    try {
      await Promise.race([host.dispose(), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      // 卸载失败不该盖住真正的判据
    }
  };

  const toolResultsOf = (session) =>
    session.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => ({ toolName: m.toolName, isError: m.isError === true, text: m.content?.[0]?.text ?? "" }));

  // ---- A2：拒绝 → 工具没执行；允许 → 工具执行
  {
    const marker = path.join(os.tmpdir(), `s8-marker-${Date.now()}`);
    for (const [label, answer] of [["deny", "deny"], ["allow", "allow"]]) {
      fs.rmSync(marker, { force: true });
      const f = await makeApprovalHost({
        modeRef: { mode: "all" },
        answer,
        input: { command: `touch ${marker.split("\\").join("/")}` },
      });
      try {
        await f.withTimeout(f.host.session.prompt("go"), 15000, `A2 ${label} 的 prompt()`);
        const results = toolResultsOf(f.host.session);
        const hit = results[0] ?? { text: "", isError: false };
        if (label === "deny") {
          check("A2①：拒绝之后交给 bash 的命令**没有执行**（文件不存在）", fs.existsSync(marker) === false, `marker=${fs.existsSync(marker)}`);
          check(
            "A2①：落盘的是 isError，且正文是我们给的 reason（含被拒的命令）",
            results.length === 1 && hit.isError === true && hit.text.startsWith("Rejected by user: ") && hit.text.includes(marker),
            JSON.stringify(results),
          );
          check("A2①：reason 逐字等于 denyReason(卡片上那个标题)", f.asked.length === 1 && hit.text === denyReason(f.asked[0].title), JSON.stringify({ got: hit.text, asked: f.asked.length, expected: f.asked.length === 1 ? denyReason(f.asked[0].title) : "(没问过)" }));
          check("A2①：问的是这次调用的 toolCallId、且拿到了 signal", f.asked.length === 1 && f.asked[0].toolCallId === "call-1" && typeof f.asked[0].toolName === "string");
          check("A2①：工具结束后 pendingToolCalls 清空", f.host.session.state.pendingToolCalls.size === 0, String(f.host.session.state.pendingToolCalls.size));
        } else {
          check("A2②：允许之后命令真的执行了（文件存在）", fs.existsSync(marker) === true, `marker=${fs.existsSync(marker)}`);
          check("A2②：工具结果是成功", results.length === 1 && hit.isError === false, JSON.stringify(results));
        }
      } finally {
        await safeDispose(f.host);
        fs.rmSync(f.root, { recursive: true, force: true });
        fs.rmSync(marker, { force: true });
      }
    }
  }

  // ---- A3：三档只拦该拦的（**同一个会话里切** + 扩展在场的阳性证据）
  {
    const readTarget = path.join(os.tmpdir(), `s8-read-${Date.now()}.txt`);
    fs.writeFileSync(readTarget, "hello-from-approval-fixture\n");
    const modeRef = { mode: "off" };
    const marker = path.join(os.tmpdir(), `s8-marker3-${Date.now()}`);
    const f = await makeApprovalHost({
      modeRef,
      answer: "deny",
      toolName: "bash",
      input: { command: `touch ${marker.split("\\").join("/")}` },
    });
    try {
      // 扩展在场的阳性证据：装了审批扩展，且没有加载错误（F10b：工厂抛错是静默缺席）
      const ext = f.host.runtime.services.resourceLoader.getExtensions();
      check("A3：审批扩展在场且没有加载错误（静默缺席的反面）", ext.extensions.some((e) => e.path === "<inline:jerrypi-approval>") && ext.errors.length === 0, JSON.stringify({ paths: ext.extensions.map((e) => e.path), errors: ext.errors }));

      // ① off + bash：不问、命令执行
      await f.withTimeout(f.host.session.prompt("go"), 15000, "A3① prompt()");
      check("A3①：off 档不问", f.asked.length === 0, JSON.stringify(f.asked));
      check("A3①：off 档命令照常执行", fs.existsSync(marker) === true, `marker=${fs.existsSync(marker)}`);

      // ② mutating + read：不问、工具执行（正文里有文件内容）
      modeRef.mode = "mutating";
      f.calls.length = 0;
      const readSession = f.host.session;
      f.script([{ id: "call-read", name: "read", arguments: { path: readTarget } }]);
      await f.withTimeout(readSession.prompt("read it"), 15000, "A3② prompt()");
      const readResults = toolResultsOf(readSession).filter((r) => r.toolName === "read");
      check("A3②：mutating 档不问只读工具", f.asked.length === 0, JSON.stringify(f.asked));
      check("A3②：只读工具真的执行了（正文含文件内容）", readResults.length >= 1 && String(readResults.at(-1)?.text ?? "").includes("hello-from-approval-fixture"), JSON.stringify(readResults.at(-1)));

      // ③ all + 同一个读操作：问了（扩展在场 + 档位真的在拦）
      modeRef.mode = "all";
      f.script([{ id: "call-read-2", name: "read", arguments: { path: readTarget } }]);
      await f.withTimeout(readSession.prompt("read again"), 15000, "A3③ prompt()");
      check("A3③：all 档问了同一个读操作（阳性证据：闸门真的在场）", f.asked.length === 1 && f.asked[0].toolName === "read", JSON.stringify(f.asked));

      // ④ mutating + **扩展注册的工具**：必须问（第 1 轮评审 S4：C2 的"未知工具"那半句要有端到端断言）
      //
      // 未知工具从哪来：用仓库里现成的 smoke 夹具（`test-fixtures/ext-smoke/index.ts`，T3 用的同一个）
      // 经 `additionalExtensionPaths` 装进来 —— 它的 `smoke_tool` 对我们是彻头彻尾的"未知名字"。
      const g = await makeApprovalHost({
        modeRef: { mode: "mutating" },
        answer: "deny",
        toolName: "smoke_tool",
        input: { message: "from-approval-fixture" },
        additionalExtensionPaths: [SMOKE_FIXTURE],
      });
      try {
        const active = g.host.session.getActiveToolNames();
        check("A3④（前提）：扩展注册的工具默认就在活动集里", active.includes("smoke_tool"), JSON.stringify(active));
        await g.withTimeout(g.host.session.prompt("custom"), 15000, "A3④ prompt()");
        check(
          "A3④：扩展工具（未知名字）在 mutating 档被问了一次，名字原样",
          g.asked.length === 1 && g.asked[0].toolName === "smoke_tool",
          JSON.stringify(g.asked.map((r) => r.toolName)),
        );
        const results = toolResultsOf(g.host.session).filter((r) => r.toolName === "smoke_tool");
        check("A3④：拒绝之后扩展工具**没有被调用**（正文里没有它的回应）", results.length === 1 && results[0].isError === true && !String(results[0].text ?? "").includes("smoke tool ok"), JSON.stringify(results));
      } finally {
        await safeDispose(g.host);
        fs.rmSync(g.root, { recursive: true, force: true });
      }
    } finally {
      await safeDispose(f.host);
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.rmSync(readTarget, { force: true });
      fs.rmSync(marker, { force: true });
    }
  }

  // ---- A4：待审批时中止（F6）
  {
    const marker = path.join(os.tmpdir(), `s8-marker4-${Date.now()}`);
    const f = await makeApprovalHost({
      modeRef: { mode: "all" },
      answer: "hang",
      input: { command: `touch ${marker.split("\\").join("/")}` },
    });
    try {
      const running = f.host.session.prompt("go").then(() => "resolved", (e) => `threw:${e.message}`);
      for (let i = 0; i < 60 && f.asked.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
      check("A4①：挂起时审批表里有一条待答", f.approvals.size().pending === 1, JSON.stringify(f.approvals.size()));
      try {
        await f.withTimeout(f.host.session.abort(), 5000, "A4 abort()");
      } catch {
        // abort 本身挂住也是红（下面三条会报出来），但不许把它变成 exit 13
      }
      // 超时本身也是一种失败，但必须**报出是哪条判据**（不能让它变成 unhandled rejection 崩脚本）
      let outcome = "(超时未收口)";
      try {
        outcome = await f.withTimeout(running, 5000, "A4 中止后的 prompt()");
      } catch (error) {
        outcome = `timeout:${error.message}`;
      }
      check("A4②：中止之后 prompt() 收口（不是永远挂着）", outcome === "resolved", String(outcome));
      check("A4②：会话回到空闲", f.host.session.isIdle === true && f.host.session.isStreaming === false, JSON.stringify({ idle: f.host.session.isIdle, streaming: f.host.session.isStreaming }));
      check("A4③：文件不存在（工具没执行）", fs.existsSync(marker) === false, `marker=${fs.existsSync(marker)}`);
      check("A4④：待审批项被清掉", f.approvals.size().pending === 0 && f.approvals.pending().length === 0, JSON.stringify(f.approvals.size()));
      const record = f.approvals.get("call-1");
      check("A4⑤：记录是 cancelled，且不冒充拒绝", record?.decision === "cancelled" && JSON.stringify(f.approvals.fieldsOf("call-1", false)) === "{}", JSON.stringify(record));
      check("A4⑥：落盘的是 pi 的 Operation aborted（不是我们的 reason）", toolResultsOf(f.host.session).some((r) => r.isError && r.text === "Operation aborted"), JSON.stringify(toolResultsOf(f.host.session)));
      check("A4⑦：模型被问了两次（abort 之后那次必须返回 aborted）", f.calls.length === 2 && f.calls[1].aborted === true, JSON.stringify(f.calls));
    } finally {
      await safeDispose(f.host);
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  }

  // ---- A5：会话替换/卸载时待审批项清干净
  {
    for (const how of ["newSession", "dispose"]) {
      const marker = path.join(os.tmpdir(), `s8-marker5-${Date.now()}-${how}`);
      const f = await makeApprovalHost({
        modeRef: { mode: "all" },
        answer: "hang",
        input: { command: `touch ${marker.split("\\").join("/")}` },
      });
      let disposed = false;
      try {
        const running = f.host.session.prompt("go").then(() => "resolved", () => "threw");
        for (let i = 0; i < 60 && f.asked.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
        // 替换/卸载本身超时也要报得出来（否则"挂住"会变成 unhandled rejection 崩脚本，
        // 看不出是哪条判据 —— 这是本轮夹具有意做硬的地方）
        let replaced = "(ok)";
        try {
          if (how === "newSession") {
            await f.withTimeout(f.host.runtime.newSession(), 10000, "A5 newSession()");
          } else {
            disposed = true;
            await f.withTimeout(f.host.dispose(), 10000, "A5 dispose()");
          }
        } catch (error) {
          replaced = `throw:${error.message}`;
        }
        check(`A5（${how}）：替换/卸载本身收口`, replaced === "(ok)", replaced);
        try {
          await f.withTimeout(running, 5000, `A5 ${how} 之后的 prompt()`);
        } catch {
          // 超时 → 下面那三条会因为"还挂在那儿"而红，比让脚本崩掉好
        }
        check(`A5（${how}）：待审批项清零`, f.approvals.size().pending === 0, JSON.stringify(f.approvals.size()));
        check(`A5（${how}）：旧 id 再也答不了`, f.approvals.decide("call-1", "allow") === false);
        check(`A5（${how}）：文件不存在`, fs.existsSync(marker) === false, `marker=${fs.existsSync(marker)}`);
      } finally {
        if (!disposed) await safeDispose(f.host);
        fs.rmSync(f.root, { recursive: true, force: true });
        fs.rmSync(marker, { force: true });
      }
    }
  }

  for (const root of approvalFixtures) fs.rmSync(root, { recursive: true, force: true });
}


// ------------------------------------- S8 第 4 步：宿主接线（A7）
//
// 真 `ChatViewProvider` + 假 controller（与 S5/S6/S7 的宿主断言同一个套路）：
//   · 一条 `approvalDecision` → 恰好一次 `decideApproval`，参数原样；
//   · 未知 id / 畸形决定 → 不崩 + Output 有一行；
//   · 面板不可见 → 弹一条通知、点按钮聚焦面板；可见 → 不弹（只记 Output）；
//   · Q10：视图销毁时若仍有待审批 → 再喊一次；重建后快照里仍有 pending 也喊。
{
  resetStub();
  const output = makeOutput();
  const decided = [];
  let snapshotItems = [];
  /** S8：待确认的**权威列表**（真 controller 是审批表；这里由断言驱动） */
  let pendingApprovals = [];
  const controller = makeController({
    decideApproval: (toolCallId, decision) => {
      decided.push({ toolCallId, decision });
      return toolCallId !== "unknown";
    },
    pendingApprovals: () => pendingApprovals,
    snapshot: () => ({
      items: snapshotItems,
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
        session: { path: "", name: "新会话", persisted: false },
      },
    }),
  });
  const provider = new ChatViewProvider({
    controller,
    extensionUri: vscode.Uri.file("/ext"),
    output,
    diff: { open: () => true },
  });

  const view = makeView();
  view.visible = false;
  provider.resolveWebviewView(view);
  await view.send({ type: "ready", protocol: PROTOCOL_VERSION });

  // ① 转发一条审批决定
  await view.send({ type: "approvalDecision", toolCallId: "call-1", decision: "deny" });
  check("A7：approvalDecision 被原样转给 controller（恰好一次）", decided.length === 1 && decided[0].toolCallId === "call-1" && decided[0].decision === "deny", JSON.stringify(decided));
  await view.send({ type: "approvalDecision", toolCallId: "unknown", decision: "allow" });
  check("A7：controller 说'不在了'时记一行 Output", output.lines.some((l) => l.includes("这次审批已经不在了")), JSON.stringify(output.lines.slice(-2)));
  await view.send({ type: "approvalDecision", toolCallId: "call-2", decision: "maybe" });
  check("A7：畸形的决定被忽略、不转给 controller", decided.length === 2 && output.lines.some((l) => l.includes("无法识别的审批决定")), JSON.stringify({ decided, lines: output.lines.slice(-2) }));

  // ② 通知（面板不可见）
  resetStub();
  const request = { toolCallId: "call-9", toolName: "bash", title: "rm -rf /tmp/x", requestedAt: 1 };
  pendingApprovals = [request];
  provider.notifyApprovalPending();
  const info = callsOf("showInformationMessage");
  check("A7：面板不可见时弹一条通知", info.length === 1 && String(info[0].message).includes("bash") && String(info[0].message).includes("rm -rf"), JSON.stringify(info));
  check("A7：通知上带「打开面板」按钮", JSON.stringify(info[0].items) === JSON.stringify(["打开面板"]), JSON.stringify(info[0].items));
  queueInformationResponse("打开面板");
  pendingApprovals = [request, { ...request, toolCallId: "call-10" }];
  provider.notifyApprovalPending();
  await new Promise((r) => setTimeout(r, 0));
  check("A7：点了「打开面板」会聚焦聊天视图", callsOf("executeCommand").some((c) => c.id === "jerrypi.chat.focus"), JSON.stringify(callsOf("executeCommand")));

  // ③ 面板可见 → 不打扰（只记 Output）
  resetStub();
  const before = callsOf("showInformationMessage").length;
  view.visible = true;
  pendingApprovals = [request, { ...request, toolCallId: "call-10" }, { ...request, toolCallId: "call-11" }];
  provider.notifyApprovalPending();
  check("A7：面板可见时不弹通知（只记一行 Output）", callsOf("showInformationMessage").length === before && output.lines.some((l) => l.includes("面板可见，不再弹通知")), JSON.stringify(output.lines.slice(-1)));

  // ④ **回归（M1 真机验收抓到的）**：数量必须等于 controller 报的**当前**待确认数，
  //    不能像"宿主自己攒一份"那样只增不减（被中止结掉的那些当时没人删）
  {
    resetStub();
    view.visible = false;
    const counts = [];
    let seenNotifications = 0;
    for (const list of [[request, { ...request, toolCallId: "b" }], [{ ...request, toolCallId: "b" }], []]) {
      pendingApprovals = list;
      provider.notifyApprovalPending();
      const calls = callsOf("showInformationMessage");
      if (calls.length === seenNotifications) {
        // 没有**新的**通知（不是"上一条还是旧的"）
        counts.push("(没弹)");
        continue;
      }
      seenNotifications = calls.length;
      counts.push(/有 (\d+) 个/.exec(String(calls.at(-1).message))?.[1] ?? "?");
    }
    check(
      "A7：通知里的数量跟着 controller 走（2 → 1 → 不弹），不是只增不减",
      JSON.stringify(counts) === JSON.stringify(["2", "1", "(没弹)"]),
      JSON.stringify(counts),
    );
  }

  // ⑤ Q10：视图销毁时若仍有待审批 → 再喊一次
  resetStub();
  view.visible = false;
  pendingApprovals = [request];
  const beforeDispose = callsOf("showInformationMessage").length;
  view.disposeView();
  check("A7/Q10：视图销毁时仍有待审批 → 再喊一次", callsOf("showInformationMessage").length === beforeDispose + 1, JSON.stringify(callsOf("showInformationMessage").length));

  // ⑥ Q10：重建后快照里仍有 pending → 也喊（快照是权威）
  resetStub();
  const view2 = makeView();
  view2.visible = false;
  snapshotItems = [
    { kind: "tool", id: "tool-call-9", toolCallId: "call-9", toolName: "bash", summary: "", isError: false, pending: true, approval: "pending" },
  ];
  provider.resolveWebviewView(view2);
  await view2.send({ type: "ready", protocol: PROTOCOL_VERSION });
  pendingApprovals = [request];
  check("A7/Q10：重建面板后快照里仍有 pending → 也弹一次", callsOf("showInformationMessage").length === 1, JSON.stringify(callsOf("showInformationMessage")));
  snapshotItems = [];
  pendingApprovals = [];
}


// ------------------------------------- S8 第 5 步：项目信任（A10/A11/A12/A13/A14）
//
// 夹具分三层，按"离实现有多近"排：
//   · A10 用**真 pi**（`createAgentSessionServices` + 真 `ProjectTrustStore` + 真 settings.json）——
//     观察点是 pi 自己的 `isProjectTrusted()` 与 `getActiveToolNames()`，不是我们的镜像；
//   · A11/A12 用**真 trust.json**（临时 agentDir）验裁决顺序与"只写 true"；
//   · A13/A14 用 `vscode` 桩验对话框/QuickPick 的映射（真模态只有真机能验）。
{
  const piModule = await loadPi(REPO_ROOT);
  const trustRoot = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s8-trust-"));
  const quiet = { lines: [], appendLine(line) { this.lines.push(line); } };
  /** 假的信任存储（只给"裁决顺序"那组用；A10/A12/A14 一律用 pi 的真 store）。 */
  const fakeStore = (initial = {}) => {
    const data = { ...initial };
    const writes = [];
    return {
      data,
      writes,
      get: (cwd) => (cwd in data ? data[cwd] : null),
      set(cwd, decision) { writes.push([cwd, decision]); if (decision === null) delete data[cwd]; else data[cwd] = decision; },
      setMany(decisions) { for (const { path, decision } of decisions) this.set(path, decision); },
    };
  };

  // ---- A10：信任之后项目级设置真的生效（真 pi + 真文件）
  {
    for (const [label, trusted] of [["信任", true], ["不信任", false]]) {
      const root = trustRoot();
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "proj");
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });
      // 唯一一个"面板里看得见"的项目级效果（F13）：defaultTools 会改 getActiveToolNames()
      fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
      const settingsManager = piModule.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
      let asked = 0;
      const resolver = createTrustResolver({
        cwd,
        trustStore: new piModule.ProjectTrustStore(agentDir),
        hasRequiringResources: (value) => piModule.hasTrustRequiringProjectResources(value),
        defaultProjectTrust: () => "ask",
        ask: async () => {
          asked += 1;
          return { trusted, remember: false };
        },
        log: quiet,
      });
      const services = await piModule.createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        resourceLoaderReloadOptions: { resolveProjectTrust: resolver },
      });
      const created = await piModule.createAgentSessionFromServices({
        services,
        sessionManager: piModule.SessionManager.create(cwd, path.join(root, "sessions", "--probe--")),
        customTools: [],
      });
      const tools = created.session.getActiveToolNames().join(",");
      const isTrusted = services.settingsManager.isProjectTrusted();
      if (trusted) {
        check("A10：信任之后 pi 自己认这个工作区已被信任", isTrusted === true && asked === 1, JSON.stringify({ isTrusted, asked }));
        check("A10：项目级 defaultTools 真的生效（可用工具集只剩 read）", tools === "read", tools);

        // ⑨ 装配那一层：**生产路径**（`createSessionHost`）真的把钩子交给了 `createAgentSessionServices`。
        //    少了这一条，"裁决函数本身对"与"我们把它接上了"就会各绿一次、合起来是坏的
        //    （实测：把 session.ts 里那三行删掉，上面两条照样绿）。
        const host = await createSessionHost({
          pi: piModule,
          cwd,
          agentDir,
          sessionManager: piModule.SessionManager.create(cwd, path.join(root, "sessions", "--host--")),
          keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {}, removeApiKey: async () => {} },
          uiContext: createSelfTestUIContext({ appendLine() {} }),
          mode: "rpc",
          sink: { appendLine() {} },
          projectTrust: { ask: async () => ({ trusted: true, remember: false }) },
        });
        try {
          // 注意判据：生产路径会把自己的 `write` 包装作为 customTools 挂上（S7），
          // 所以这里**不是**"只剩 read"，而是"项目设置把 bash/edit 拿掉了"。
          const hostTools = host.session.getActiveToolNames();
          check(
            "A10：生产装配路径（createSessionHost）真的把信任钩子接上了",
            host.runtime.services.settingsManager.isProjectTrusted() === true &&
              hostTools.includes("read") &&
              !hostTools.includes("bash") &&
              !hostTools.includes("edit"),
            JSON.stringify({ trusted: host.runtime.services.settingsManager.isProjectTrusted(), tools: hostTools }),
          );
        } finally {
          await host.dispose();
        }
      } else {
        check("A10：不信任时项目设置不生效（四个内置工具都在）", isTrusted === false && tools === "read,bash,edit,write", JSON.stringify({ isTrusted, tools }));
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A10⑪：**无资源 → 之后长出资源** 的真 pi 端到端（回顾评审 codex 的 P1 的"用户可见后果"）
  //
  // 纯函数那一条（A11⑦）证明的是 resolver 的机制；这一条证明的是**后果**：
  // 同一个 memo（= 同一个 VS Code 窗口）里，第二个会话必须**问**，而且项目配置不许生效。
  {
    const root = trustRoot();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "proj");   // ← 故意**先不建** .pi
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const memo = new Map();
    let asked = 0;
    const makeResolver = () =>
      createTrustResolver({
        cwd,
        trustStore: new piModule.ProjectTrustStore(agentDir),
        hasRequiringResources: (dir) => piModule.hasTrustRequiringProjectResources(dir),
        defaultProjectTrust: () => "ask",
        ask: async () => {
          asked += 1;
          return { trusted: false, remember: false };  // 用户这次**不**信任
        },
        log: quiet,
        memo,
      });
    const openSession = async () => {
      const settingsManager = piModule.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
      const services = await piModule.createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        // ⚠️ 键名是 **resourceLoaderReloadOptions**（不是 resourceLoaderOptions）——
        // 写错的话钩子**一个都不装**，表现为"没问、也不信任"，很容易被当成"实现是对的"
        resourceLoaderReloadOptions: { resolveProjectTrust: makeResolver() },
      });
      await services.resourceLoader.reload();
      return settingsManager;
    };
    try {
      const first = await openSession();
      check("A10⑪：空目录的第一个会话不问（F14）", asked === 0 && first.isProjectTrusted() === true, JSON.stringify({ asked, trusted: first.isProjectTrusted() }));

      // 之后目录里长出项目级资源（git pull / 别人塞文件 / 自己刚建）
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read"] }), "utf8");

      const second = await openSession();
      check(
        "A10⑪：长出 .pi/ 之后的第二个会话**必须问**（memo 不许把「无资源」当成授权）",
        asked === 1,
        JSON.stringify({ asked, memo: [...memo.entries()] }),
      );
      check(
        "A10⑪：而且这次用户不信任 ⇒ 项目配置**不能**生效（真 pi 的 isProjectTrusted）",
        second.isProjectTrusted() === false,
        JSON.stringify({ trusted: second.isProjectTrusted() }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A11：裁决顺序（memo → 没资源 → trust.json → defaultProjectTrust → 问）
  {
    const cwd = "/w/proj";
    // ① memo：同一个 resolver 问两次只问一遍
    {
      const store = fakeStore();
      let asked = 0;
      const resolver = createTrustResolver({
        cwd, trustStore: store, hasRequiringResources: () => true,
        defaultProjectTrust: () => "ask",
        ask: async () => { asked += 1; return { trusted: true, remember: false }; },
        log: quiet,
      });
      const first = await resolver({});
      const second = await resolver({});
      check("A11①：同一个 cwd 只裁决一次（memo）", first === true && second === true && asked === 1, JSON.stringify({ first, second, asked }));
    }
    // ② trust.json 里有记录（true 或 false）→ 直接用、不问
    for (const saved of [true, false]) {
      const store = fakeStore({ [cwd]: saved });
      let asked = 0;
      const resolver = createTrustResolver({
        cwd, trustStore: store, hasRequiringResources: () => true,
        defaultProjectTrust: () => "ask",
        ask: async () => { asked += 1; return { trusted: !saved, remember: false }; },
        log: quiet,
      });
      const outcome = await resolver({});
      check(`A11②：trust.json 里的 ${saved} 直接用、不问（CLI 写的 false 也认）`, outcome === saved && asked === 0, JSON.stringify({ outcome, asked }));
    }
    // ③ 没有需要信任的资源 → 不问、按信任
    {
      const store = fakeStore();
      let asked = 0;
      const resolver = createTrustResolver({
        cwd, trustStore: store, hasRequiringResources: () => false,
        defaultProjectTrust: () => "ask",
        ask: async () => { asked += 1; return { trusted: false, remember: true }; },
        log: quiet,
      });
      check("A11③：没有 .pi/.agents 资源时直接信任、不问（F14）", (await resolver({})) === true && asked === 0 && store.writes.length === 0, JSON.stringify({ asked, writes: store.writes }));
    }
    // ④ defaultProjectTrust 的 always / never 直接短路
    for (const [fallback, expected] of [["always", true], ["never", false]]) {
      const store = fakeStore();
      let asked = 0;
      const resolver = createTrustResolver({
        cwd, trustStore: store, hasRequiringResources: () => true,
        defaultProjectTrust: () => fallback,
        ask: async () => { asked += 1; return { trusted: !expected, remember: false }; },
        log: quiet,
      });
      check(`A11④：defaultProjectTrust=${fallback} → ${expected}、不问`, (await resolver({})) === expected && asked === 0, JSON.stringify({ asked }));
    }
    // ⑤ 询问答案的落盘规则（Q5：只有"记住且信任"才写；**从不写 false**）
    for (const [label, answer, expectWrite] of [
      ["记住 + 信任", { trusted: true, remember: true }, true],
      ["仅本次信任", { trusted: true, remember: false }, false],
      ["不信任（记住了也不写）", { trusted: false, remember: true }, false],
    ]) {
      const store = fakeStore();
      const resolver = createTrustResolver({
        cwd, trustStore: store, hasRequiringResources: () => true,
        defaultProjectTrust: () => "ask", ask: async () => answer, log: quiet,
      });
      await resolver({});
      check(`A11⑤：${label} → ${expectWrite ? "写一条 true" : "不写文件"}`, (store.writes.length > 0) === expectWrite && (!expectWrite || store.data[cwd] === true), JSON.stringify(store.writes));
    }
    // ⑥ 问不出来（对话框崩了）→ 不信任、不写文件
    {
      const store = fakeStore();
      const resolver = createTrustResolver({
        cwd, trustStore: store, hasRequiringResources: () => true,
        defaultProjectTrust: () => "ask",
        ask: async () => { throw new Error("panel gone"); },
        log: quiet,
      });
      check("A11⑥：询问失败 → 按不信任处理且不写文件（安全方向）", (await resolver({})) === false && store.writes.length === 0, JSON.stringify(store.writes));
    }
    // ⑦ **回顾评审（codex）P1**：**"没有资源"不是一次授权**，不许进 memo。
    //    否则同一个窗口里先在一个空目录裁决过，之后目录里长出 `.pi/settings.json`
    //    （git pull / 别人塞文件 / 自己刚建），下一个会话就会**不问就用**项目配置。
    {
      const store = fakeStore();
      const memo = new Map();
      let hasResources = false;
      let asked = 0;
      const makeResolver = () =>
        createTrustResolver({
          cwd, trustStore: store, hasRequiringResources: () => hasResources,
          defaultProjectTrust: () => "ask",
          ask: async () => { asked += 1; return { trusted: false, remember: false }; },
          log: quiet, memo,
        });
      const first = await makeResolver()({});          // 空目录：不问、按信任
      hasResources = true;                             // 之后长出资源
      const second = await makeResolver()({});         // **同一个 memo**、新会话
      check(
        "A11⑦：无资源那次不进 memo —— 之后长出 .pi/ 必须重新问（codex 回顾评审 P1）",
        first === true && asked === 1 && second === false,
        JSON.stringify({ first, second, asked, memo: [...memo.entries()] }),
      );
    }
    // ⑧ **回顾评审（codex）P2**：父目录已有裁决时，"清除本目录记录"的**反馈**必须说清
    //    仍然受继承影响（`get(cwd)` 会查祖先，而清除只删 cwd 自己的键）。
    {
      const root = trustRoot();
      const agentDir = path.join(root, "agent");
      const parent = path.join(root, "parent");
      const child = path.join(parent, "child");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(child, { recursive: true });
      const store = new piModule.ProjectTrustStore(agentDir);
      store.set(parent, true);
      const message = applyTrustAction("clear", { cwd: child, trustStore: store, memo: new Map(), log: quiet });
      check(
        "A11⑧：父目录有记录时，清除的反馈不许说成「下次会重新问」（codex 回顾评审 P2）",
        store.get(child) === true && !/下次会重新问/.test(message) && /上层|父|inherit/i.test(message),
        JSON.stringify({ message, stillTrusted: store.get(child) }),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A12：只写 true、只写一次（真 trust.json）
  {
    const cases = [
      ["信任并记住", { trusted: true, remember: true }, true],
      ["仅本次信任", { trusted: true, remember: false }, false],
      ["不信任", { trusted: false, remember: false }, false],
      // 这条防的是"记住了不信任"被写进文件（CLI 会这么写，我们不写 —— Q5）
      ["不信任（且记住了）", { trusted: false, remember: true }, false],
    ];
    for (const [label, answer, shouldExist] of cases) {
      const root = trustRoot();
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "proj");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      const store = new piModule.ProjectTrustStore(agentDir);
      const trustFile = path.join(agentDir, "trust.json");
      const resolver = createTrustResolver({
        cwd, trustStore: store, hasRequiringResources: () => true,
        defaultProjectTrust: () => "ask", ask: async () => answer, log: quiet,
      });
      const outcome = await resolver({});
      const exists = fs.existsSync(trustFile);
      if (shouldExist) {
        const raw = JSON.parse(fs.readFileSync(trustFile, "utf8"));
        const key = Object.keys(raw)[0];
        check("A12：选「信任并记住」→ trust.json 里恰好一条 true（key 是 canonical 路径）", exists && raw[key] === true && Object.keys(raw).length === 1 && path.isAbsolute(key), JSON.stringify({ exists, raw }));
        check("A12：真实存储回读得到", store.get(cwd) === true && outcome === true, JSON.stringify({ get: store.get(cwd), outcome }));
      } else {
        check(`A12：选「${label}」→ trust.json **一个字节都没变**（空目录时仍然不存在）`, exists === false, JSON.stringify({ exists, files: fs.existsSync(agentDir) ? fs.readdirSync(agentDir) : [] }));
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A13：模态询问的映射（vscode 桩）
  {
    resetStub();
    const prompter = createTrustPrompter({ log: quiet });
    const cwd = "/w/proj";
    for (const [label, queued, expected] of [
      ["点「信任并记住」", TRUST_REMEMBER_ITEM, { trusted: true, remember: true }],
      ["点「仅本次信任」", TRUST_SESSION_ITEM, { trusted: true, remember: false }],
      ["点「不信任」", TRUST_DENY_ITEM, { trusted: false, remember: false }],
      ["ESC/关掉", undefined, { trusted: false, remember: false }],
    ]) {
      queueWarningResponse(queued);
      const answer = await prompter.ask(cwd);
      check(`A13：${label} → ${JSON.stringify(expected)}`, JSON.stringify(answer) === JSON.stringify(expected), JSON.stringify(answer));
    }
    const call = callsOf("showWarningMessage").at(-1);
    check("A13：模态（modal:true）且标题里有那个文件夹", call?.options?.modal === true && String(call.message).includes(cwd), JSON.stringify(call?.options));
    check("A13：三个按钮齐全", JSON.stringify(call?.items) === JSON.stringify([TRUST_REMEMBER_ITEM, TRUST_SESSION_ITEM, TRUST_DENY_ITEM]), JSON.stringify(call?.items));
    check("A13：文案说清两种触发源，并点明与 VS Code 工作区信任不是一回事", String(call.message).includes(".agents/skills") && String(call.message).includes("工作区信任"), String(call.message).slice(0, 60));
  }

  // ---- A14：`Pi: Project Trust…` 的动作映射（真 store + 真命令 + QuickPick 桩）
  {
    // ① 纯动作：五个动作各自改了什么
    {
      const root = trustRoot();
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "proj");
      const child = path.join(cwd, "sub");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(child, { recursive: true });
      const store = new piModule.ProjectTrustStore(agentDir);
      const memo = new Map();
      check("A14：有五个动作、文案各不同", TRUST_ACTIONS.length === 5 && new Set(TRUST_ACTIONS.map((a) => TRUST_ACTION_LABELS[a])).size === 5, JSON.stringify(TRUST_ACTIONS));

      memo.set(cwd, false);
      applyTrustAction("trust-remember", { cwd, trustStore: store, memo, log: quiet });
      check("A14：「信任并记住」→ 落盘 true 且清掉本进程旧裁决", store.get(cwd) === true && memo.get(cwd) === undefined, JSON.stringify({ get: store.get(cwd), memo: memo.get(cwd) }));

      // 先给子目录塞一条记录（模拟 CLI 写过 false），再"信任父文件夹"
      store.set(child, false);
      const message = applyTrustAction("trust-parent", { cwd: child, trustStore: store, memo, log: quiet });
      check("A14：「信任父文件夹」写**两条** update：父目录 true + 子目录记录清掉（第 1 轮评审 S6）", store.get(child) === true && message.includes(cwd), JSON.stringify({ childGet: store.get(child), message }));
      check("A14：父目录那条真的在 trust.json 里", JSON.parse(fs.readFileSync(path.join(agentDir, "trust.json"), "utf8"))[cwd] === true);

      applyTrustAction("trust-session", { cwd, trustStore: store, memo, log: quiet });
      check("A14：「仅本次信任」只动 memo、不动文件", memo.get(cwd) === true && store.get(cwd) === true, JSON.stringify({ memo: memo.get(cwd) }));
      applyTrustAction("deny-session", { cwd, trustStore: store, memo, log: quiet });
      check("A14：「不信任（仅本次）」只动 memo、不写 false", memo.get(cwd) === false, JSON.stringify({ memo: memo.get(cwd) }));
      const cleared = applyTrustAction("clear", { cwd, trustStore: store, memo, log: quiet });
      check("A14：「清除记录」把记录删掉并清 memo", store.get(cwd) === null && memo.get(cwd) === undefined && cleared.includes("清除"), JSON.stringify({ get: store.get(cwd), message: cleared }));
      check("A14：根目录没有「父文件夹」可信任（不越界）", trustParentOf("/") === undefined && trustParentOf("/a") === "/", JSON.stringify([trustParentOf("/"), trustParentOf("/a")]));
      fs.rmSync(root, { recursive: true, force: true });
    }

    // ② 命令层：真注册 + 真 store + QuickPick 桩（映射错了这里会红）
    {
      resetStub();
      const root = trustRoot();
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "proj");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      const savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
      const savedCwd = process.cwd;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      // workspaceCwd() 读 vscode.workspace.workspaceFolders → 用桩预置
      setWorkspaceFolders([{ uri: vscode.Uri.file(cwd) }]);
      try {
        const context = {
          extensionUri: vscode.Uri.file(REPO_ROOT),
          extension: { packageJSON: { version: "0.0.0-check" } },
          subscriptions: [],
          secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
          globalState: { get: (_k, fallback) => fallback, update: async () => {} },
        };
        const memo = new Map([[cwd, false]]);
        let memoReads = 0;
        const output2 = makeOutput();
        registerCommands(context, output2, {
          runModelPicker: async () => {},
          runThinkingPicker: async () => {},
          runNewSession: async () => {},
          runSessionPicker: async () => {},
          trustMemo: () => {
            memoReads += 1;
            return memo;
          },
        });
        check("A14：命令 jerrypi.projectTrust 注册了", callsOf("registerCommand").some((c) => c.id === "jerrypi.projectTrust"), JSON.stringify(callsOf("registerCommand").map((c) => c.id)));
        queueQuickPickResponse((items) => items.find((item) => item.action === "trust-remember"));
        await vscodeStub.commands.executeCommand("jerrypi.projectTrust");
        const stored = new piModule.ProjectTrustStore(agentDir).get(cwd);
        check("A14：命令走的是同一条 applyTrustAction（真 store 落盘 + memo 被清）", stored === true && memo.get(cwd) === undefined && memoReads === 1, JSON.stringify({ stored, memo: memo.get(cwd), memoReads }));
        check("A14：命令给了用户一句反馈", callsOf("showInformationMessage").some((c) => String(c.message).includes("已记住信任")), JSON.stringify(callsOf("showInformationMessage").map((c) => c.message)));
        check("A14：QuickPick 的五个选项都在（含父文件夹的路径说明）", (() => {
          const call = callsOf("showQuickPick").at(-1);
          return call.items.length === 5 && call.items.some((i) => i.label === TRUST_ACTION_LABELS["trust-parent"]);
        })(), JSON.stringify(callsOf("showQuickPick").at(-1)?.items?.map((i) => i.label)));
      } finally {
        setWorkspaceFolders([]);
        void savedCwd;
        if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
}


// ------------------------------------- S8 第 6 步：真 controller 的 snapshot（A6b，C6 的主守卫）
//
// 为什么值得这么麻烦（第 1 轮评审 B2 把它从 controller-check 搬过来）：C6（"待审批项在面板
// 重开后还在"）**不需要模型**，而 controller-check 没凭据时整体 SKIP —— 那等于换个开发机就不查了。
//
// 驱动方式**不动生产代码**：`SessionHostControllerOptions.pi` 本来就允许传句柄
// （`PiModule | (() => Promise<PiModule>)`），测试传一个只换"模型流"的包装句柄。
{
  const piModule = await loadPi(REPO_ROOT);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s8-controller-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "ws");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const marker = path.join(cwd, "marker.txt");

  // 包一层 pi 句柄：只在创建会话之后把模型流换成脚本化的那个
  const bootstrap = await piModule.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  const probeModel = bootstrap.getModels()[0];
  let scriptSteps = [];
  /** 换剧本（并把回合计数归零 —— 假模型的回合是"用一格少一格"，不归零第二轮的 turn 已经越过了新剧本）。 */
  let setScript = () => {};
  const wrappedPi = {
    ...piModule,
    async createAgentSessionFromServices(options) {
      const created = await piModule.createAgentSessionFromServices(options);
      let turn = 0;
      setScript = (steps) => {
        scriptSteps = steps;
        turn = 0;
      };
      created.session.agent.streamFunction = async (m, _ctx, opts) => {
        const aborted = opts?.signal?.aborted === true;
        const step = aborted ? undefined : scriptSteps[turn];
        turn += 1;
        const base = {
          role: "assistant",
          api: m.api,
          provider: m.provider,
          model: m.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0 } },
          timestamp: Date.now(),
        };
        const message = aborted
          ? { ...base, content: [{ type: "text", text: "(aborted)" }], stopReason: "aborted" }
          : step !== undefined
            ? { ...base, content: [{ type: "toolCall", id: step.id, name: step.name, arguments: step.arguments }], stopReason: "stop" }
            : { ...base, content: [{ type: "text", text: "(done)" }], stopReason: "stop" };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            yield { type: "done" };
          },
          async result() {
            return message;
          },
        };
      };
      return created;
    },
  };

  const emitted = [];
  const log = { lines: [], appendLine(line) { this.lines.push(line); } };
  let mode = "all";
  const snapshotsDuringPending = [];
  const pendingSeen = [];
  const controller = new SessionHostController({
    pi: wrappedPi,
    cwd,
    agentDir,
    sessionsRoot: path.join(root, "sessions"),
    keys: {
      listProviders: () => [probeModel.provider],
      getApiKey: async (id) => (id === probeModel.provider ? "probe-key" : undefined),
      saveApiKey: async () => {},
      removeApiKey: async () => {},
    },
    uiContext: createSelfTestUIContext(log),
    log,
    onMessage: (message) => emitted.push(message),
    approvalMode: () => mode,
    onApprovalPending: (request) => {
      pendingSeen.push(request);
      // ① 待审批时**先** snapshot：卡片必须带着按钮回来（C6）
      snapshotsDuringPending.push(controller.snapshot());
      // ② 再答（时序写死：见 S8-plan 的 N3）
      controller.decideApproval(request.toolCallId, answerFor(request));
    },
  });
  let answer = "deny";
  const answerFor = () => answer;

  const toolItemOf = (snapshot, toolCallId) =>
    snapshot === undefined ? undefined : snapshot.items.find((item) => item.kind === "tool" && item.toolCallId === toolCallId);

  try {
    await controller.ensure();
    // 会话创建完之后再设剧本（`ensure()` 之前 pi 还没建会话）
    setScript([{ id: "call-1", name: "bash", arguments: { command: `touch ${marker.split("\\").join("/")}` } }]);

    // ---- ①/②：待审批时的快照 + 答完之后的就地撤回
    // `controller.prompt()` 会 await 整轮（`sendPrompt` 等的是 `session.prompt`），
    // 所以这一行返回时：审批问过、答过、工具也结束了。
    await controller.prompt("go", "auto");
    const during = snapshotsDuringPending[0];
    const diagnostics = JSON.stringify({
      pendingSeen: pendingSeen.length,
      snapshots: snapshotsDuringPending.length,
      composerErrors: emitted.filter((m) => m.type === "composerError").map((m) => m.text),
      notices: emitted.filter((m) => m.type === "state" || m.type === "item").length,
      log: log.lines.slice(-6),
      scriptSteps: scriptSteps.length,
    });
    check("A6b①：待审批时 snapshot() 的卡片带 approval:\"pending\"", during !== undefined && toolItemOf(during, "call-1")?.approval === "pending", `${JSON.stringify(toolItemOf(during, "call-1") ?? null)}｜诊断=${diagnostics}`);
    check("A6b：问的是这次调用、且带着工具名", pendingSeen.length === 1 && pendingSeen[0].toolCallId === "call-1" && pendingSeen[0].toolName === "bash", JSON.stringify(pendingSeen));
    check("A6b：拒绝之后文件不存在（快照没骗人）", fs.existsSync(marker) === false, `marker=${fs.existsSync(marker)}`);

    // 实时那条路：onPending 时就地重发过带按钮的卡片；答完又撤回了
    const liveItems = emitted.filter((m) => m.type === "item" && m.item.kind === "tool" && m.item.toolCallId === "call-1");
    check(
      "A6b：实时路径先就地加上按钮、答完之后按钮不再在（拒绝 → 立刻显示「已拒绝」）",
      liveItems.filter((m) => m.item.approval === "pending").length === 1 && liveItems.at(-1)?.item.approval !== "pending",
      JSON.stringify(liveItems.map((m) => m.item.approval ?? "(无)")),
    );

    // ---- ② 工具结束之后：拒绝标记仍在
    const after = controller.snapshot();
    check("A6b②：工具结束后卡片仍是 approval:\"denied\"（可回溯）", toolItemOf(after, "call-1")?.approval === "denied", JSON.stringify(toolItemOf(after, "call-1") ?? null));
    check(
      "A6b：答完之后 controller.pendingApprovals() 为空（通知的数量就靠它）",
      controller.pendingApprovals().length === 0,
      JSON.stringify(controller.pendingApprovals().map((r) => r.toolCallId)),
    );

    // ---- ③ 第二轮：允许 → 文件出现，卡片上没有审批标记
    answer = "allow";
    fs.rmSync(marker, { force: true });
    setScript([{ id: "call-2", name: "bash", arguments: { command: `touch ${marker.split("\\").join("/")}` } }]);
    await controller.prompt("again", "auto");
    check("A6b：允许之后文件存在", fs.existsSync(marker) === true, `marker=${fs.existsSync(marker)}`);

    // ---- ④ off 档：卡片上不带任何审批字段（C1 的"不多发"）
    mode = "off";
    fs.rmSync(marker, { force: true });
    const beforeOff = emitted.length;
    setScript([{ id: "call-3", name: "bash", arguments: { command: `touch ${marker.split("\\").join("/")}` } }]);
    await controller.prompt("third", "auto");
    const offSnapshot = controller.snapshot();
    const offTool = offSnapshot.items.find((item) => item.kind === "tool" && item.toolCallId === "call-3");
    // 判据取**整条流**：C1 的"一个字节都不多发"是"这一轮里一个 approval 字段都没出现过"，
    // 而不只是终态里没有（只判终态的话，"off 也去问、但立刻被放行"会漏过去）
    const offApprovalFields = emitted
      .slice(beforeOff)
      .filter((m) => m.type === "item" && m.item.kind === "tool")
      .map((m) => m.item.approval)
      .filter((value) => value !== undefined);
    check(
      "A6b④：off 档整轮都不带 approval（C1：与今天一致、不多发字段）",
      offTool !== undefined &&
        offApprovalFields.length === 0 &&
        offTool.approval === undefined &&
        !JSON.stringify(offSnapshot.items.filter((i) => i.kind === "tool" && i.toolCallId === "call-3")).includes('"approval"'),
      JSON.stringify({ offTool: offTool?.approval ?? "(无)", offApprovalFields, items: offSnapshot.items.filter((i) => i.kind === "tool").map((i) => ({ id: i.toolCallId, approval: i.approval ?? "(无)" })) }),
    );
    // ---- A10⑩：**经真 controller** 把 `askProjectTrust` 接到建会话的信任钩子上
    //
    // 为什么还要这一条（第 5 步的 5-2 是同一类）：`createSessionHost({projectTrust})` 那条
    // 只证明 session.ts 会传钩子；而生产链是 **extension.ts → controller → session.ts**，
    // controller 少传一次，整条信任流程就是静默不生效的。判据用 `session.getActiveToolNames()`
    // （真 pi 的公开 API，不是我们的镜像）+ `ask` 被叫过。
    {
      const trustCwd = path.join(root, "trustproj");
      fs.mkdirSync(path.join(trustCwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(trustCwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
      let askedTrust = 0;
      const trustController = new SessionHostController({
        pi: wrappedPi,
        cwd: trustCwd,
        agentDir,
        sessionsRoot: path.join(root, "sessions-trust"),
        keys: {
          listProviders: () => [probeModel.provider],
          getApiKey: async (id) => (id === probeModel.provider ? "probe-key" : undefined),
          saveApiKey: async () => {},
          removeApiKey: async () => {},
        },
        uiContext: createSelfTestUIContext(log),
        log,
        onMessage: () => {},
        askProjectTrust: async () => {
          askedTrust += 1;
          return { trusted: true, remember: false };
        },
      });
      try {
        await trustController.ensure();
        const tools = trustController.session?.getActiveToolNames() ?? [];
        check(
          "A10⑩：真 controller 把 askProjectTrust 接到了信任钩子上（项目设置真的改变了工具集）",
          askedTrust === 1 && tools.includes("read") && !tools.includes("bash"),
          JSON.stringify({ askedTrust, tools }),
        );
      } finally {
        await trustController.dispose().catch(() => undefined);
      }
    }
  } finally {
    await controller.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }
}

// ------------------------------------- S9 第 1 步：包管理（A1–A4 / A8 / A9 / A11 / A12 / A13a）
//
// 夹具：真 pi（`loadPi`）+ 临时 agentDir / cwd / 一个临时本地包；**不碰用户配置**（AGENTS.md §4）。
// A1/A8/A11 是纯函数（构造对象当输入）；A2/A3/A4/A9/A12 走真文件系统与真 `DefaultPackageManager`。
{
  const s9Root = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s9-host-"));
  /** 一个 pi 认的本地包：`extensions/` + `themes/` 子目录就够（F20）。 */
  const makePackage = (dir) => {
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "probe.ts"), "export default function () {}\n", "utf8");
    fs.writeFileSync(path.join(dir, "themes", "probe-theme.json"), "{}\n", "utf8");
    return dir;
  };
  const piModule = await loadPi(REPO_ROOT);

  // ---- A1：保守的 npm 判定（不许复刻 pi 的 parseSource）
  {
    const yes = ["npm:foo", "npm:@scope/x"];
    const no = ["git@github.com:a/b.git", "https://github.com/a/b", "./x", "../x", "C:\\Users\\me\\pkg", "/abs/x", "x", "path:./x"];
    const wrong = [...yes.filter((s) => !isNpmSource(s)), ...no.filter((s) => isNpmSource(s))];
    check("A1：只有 npm: 前缀算 npm 源（C:\\… 这种 Windows 路径不许被误判）", wrong.length === 0, JSON.stringify(wrong));
  }

  // ---- A11：失败形态的四态（纯函数）
  {
    const spawnNpm = translateSourceError(new Error("spawn /nonexistent/npm-binary ENOENT"), "npm:whatever");
    const spawnGit = "spawn git ENOENT";
    const gitRaw = translateSourceError(new Error(spawnGit), "https://github.com/a/b");
    const missing = translateSourceError(new Error("Path does not exist: /nope/here"), "/nope/here");
    const other = translateSourceError(new Error("boom"), "npm:whatever");
    check("A11①：npm: 源 + spawn ENOENT → 翻译成「需要 npm」并保留原文", spawnNpm.includes("需要 npm") && spawnNpm.includes("ENOENT"), spawnNpm);
    check("A11②：非 npm 源的 spawn ENOENT → 原样透出（F37：缺 git 也一样是 ENOENT，硬翻译会撒谎）", gitRaw === spawnGit, gitRaw);
    check("A11③：Path does not exist → 加前缀「找不到这个路径：」并带路径", missing.startsWith("找不到这个路径：/nope/here") && missing.includes("Path does not exist: /nope/here"), missing);
    check("A11④：其它错误 → 原样", other === "boom", other);
  }

  // ---- A8：列表行的三段（纯函数）
  {
    const user = describePackage({ source: "../my-pkg", scope: "user", filtered: false, installedPath: "/x/my-pkg" });
    const filtered = describePackage({ source: "npm:foo", scope: "user", filtered: true, installedPath: "/x/foo" });
    const broken = describePackage({ source: "/gone", scope: "user", filtered: false });
    const project = describePackage({ source: "/p", scope: "project", filtered: false, installedPath: "/p" });
    check("A8①：user 行 = 源 + user + 解析后的绝对路径", user.label === "../my-pkg" && user.description === "user" && user.detail === "/x/my-pkg", JSON.stringify(user));
    check("A8②：filtered 的加 (filtered) 后缀（与 CLI 一致，F24）", filtered.label === "npm:foo (filtered)", JSON.stringify(filtered));
    check("A8③：installedPath 缺失 → 「找不到（路径已失效）」（不许静默过滤，Q5）", broken.detail === "找不到（路径已失效）", JSON.stringify(broken));
    check("A8④：project 行标注「（项目作用域：本版本不管理）」（Q5b/B5）", project.description.includes("项目作用域：本版本不管理"), JSON.stringify(project));
  }

  // ---- A13a：agentDir 缺失/为空直接抛（不许回退 pi 的默认目录）
  {
    const throws = (fn) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    };
    check(
      "A13a：agentDir 为空/缺失时包管理直接抛（C7：不写用户真实配置）",
      throws(() => listPackages({ pi: piModule, cwd: os.tmpdir(), agentDir: "" })) &&
        throws(() => listPackages({ pi: piModule, cwd: os.tmpdir(), agentDir: undefined })),
      "",
    );
  }

  // ---- A2/A3/A4：真装（临时 agentDir + 临时 cwd + 临时包）
  {
    const root = s9Root();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "ws");
    const pkg = fs.realpathSync(makePackage(path.join(root, "my-pkg")));
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const deps = { pi: piModule, cwd, agentDir };
    const settingsPath = settingsPathOf(deps);
    const seeded = {
      theme: "catppuccin-mocha",
      retry: { enabled: true, maxRetries: 7, provider: { timeoutMs: 1234 } },
      packages: [],
    };
    // 非标准缩进 + 嵌套值：pi 落盘时会 `JSON.stringify(…,null,2)` 重写整份，
    // 所以 A3 判的是「解析后无关字段深相等」，不是逐字节（N2）。
    fs.writeFileSync(
      settingsPath,
      '{\n    "theme": "catppuccin-mocha",\n  "retry": {\n      "enabled": true,\n    "maxRetries": 7,\n    "provider": { "timeoutMs": 1234 }\n  },\n  "packages": []\n}\n',
      "utf8",
    );
    try {
      const first = await installPackage(deps, pkg);
      check("A4①：第一次装 → ok 且 changed=true", first.ok === true && first.changed === true, JSON.stringify(first));
      check(
        "A2：装完之后工作区里没有 .pi/settings.json（配置只写 user 作用域）",
        fs.existsSync(path.join(cwd, ".pi", "settings.json")) === false,
        path.join(cwd, ".pi", "settings.json"),
      );
      const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const { packages, ...rest } = after;
      check(
        "A3①：除 packages 外其它字段解析后深相等（嵌套值与非标准缩进都活下来）",
        JSON.stringify(rest) === JSON.stringify({ theme: seeded.theme, retry: seeded.retry }),
        JSON.stringify(rest),
      );
      check(
        "A3②：写进去的是相对 agentDir 的形态（F9：绝对路径被规范化）",
        Array.isArray(packages) && packages.length === 1 && packages[0] === "../my-pkg",
        JSON.stringify(packages),
      );
      const second = await installPackage(deps, pkg);
      check("A4②：同一个源再装一次 → changed=false（F10 的幂等分支）", second.ok === true && second.changed === false, JSON.stringify(second));
      const listed = listPackages(deps);
      check(
        "A8 前置：list() 看到那条（scope=user、installedPath=解析后的绝对路径）",
        listed.length === 1 && listed[0].scope === "user" && fs.realpathSync(listed[0].installedPath) === pkg,
        JSON.stringify(listed),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A9：remove 的返回值原样透出（false 不许当成功）
  {
    const root = s9Root();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "ws");
    const pkg = fs.realpathSync(makePackage(path.join(root, "my-pkg")));
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const deps = { pi: piModule, cwd, agentDir };
    try {
      await installPackage(deps, pkg);
      const removed = await removePackage(deps, pkg);
      const again = await removePackage(deps, pkg);
      check(
        "A9①：第一次 remove → removed=true；再 remove → removed=false（F11）",
        removed.ok === true && removed.removed === true && again.ok === true && again.removed === false,
        JSON.stringify({ removed, again }),
      );
      const raw = JSON.parse(fs.readFileSync(settingsPathOf(deps), "utf8"));
      check("A9②：移除只在 packages 里动手（空数组保留，不删键 —— F11）", Array.isArray(raw.packages) && raw.packages.length === 0, JSON.stringify(raw.packages));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A12：失败不留脏（npm 不可用 = 把 npmCommand 指到不存在的路径，F23）
  {
    const root = s9Root();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "ws");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const deps = { pi: piModule, cwd, agentDir };
    const settingsPath = settingsPathOf(deps);
    const seed = { npmCommand: ["/nonexistent/npm-binary"], packages: [] };
    fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2), "utf8");
    try {
      const outcome = await installPackage(deps, "npm:whatever");
      const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      check(
        "A12①：npm 不可用时 install 报失败（翻译成「需要 npm」）",
        outcome.ok === false && outcome.message.includes("需要 npm"),
        JSON.stringify(outcome),
      );
      check("A12②：失败之后 settings.json 解析后不变（F23：先 install 再写）", JSON.stringify(after) === JSON.stringify(seed), JSON.stringify(after));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A18：未信任的项目配置不许影响写路径（R7/B1）
  //
  // 全局 npmCommand 与项目 npmCommand 指到**两个不同**的不存在路径：
  // 错误里出现哪个，就证明了用的是哪份配置（B1 的实测就是这么做的）。
  {
    const root = s9Root();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "ws");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ npmCommand: ["/nonexistent/evil"] }), "utf8");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["/nonexistent/user-npm"], packages: [] }), "utf8");
    const deps = { pi: piModule, cwd, agentDir };
    try {
      const outcome = await installPackage(deps, "npm:whatever");
      check(
        "A18：未信任项目的 npmCommand 不许决定我们 spawn 什么（错误里不许出现 evil）",
        outcome.ok === false && !outcome.message.includes("evil"),
        JSON.stringify(outcome),
      );
      check(
        "A18②：用的确实是全局那份 npmCommand（阳性证据：错误里出现 user-npm）",
        outcome.ok === false && outcome.message.includes("user-npm"),
        JSON.stringify(outcome),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A19：写后回读校验（F32：API 正常返回 ≠ 落盘成功）
  {
    const root = s9Root();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "ws");
    const pkg = fs.realpathSync(makePackage(path.join(root, "my-pkg")));
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const deps = { pi: piModule, cwd, agentDir };
    const settingsPath = settingsPathOf(deps);
    const broken = "{invalid-json\n";
    fs.writeFileSync(settingsPath, broken, "utf8");
    try {
      const outcome = await installPackage(deps, pkg);
      check(
        "A19①：坏 JSON 时 install 必须 ok:false（pi 的 API 正常返回但文件没写）",
        outcome.ok === false,
        JSON.stringify(outcome),
      );
      check("A19②：坏内容不被改写（我们没「修」它、也没写脏）", fs.readFileSync(settingsPath, "utf8") === broken, fs.readFileSync(settingsPath, "utf8"));
      check(
        "A19③：消息里带 drainErrors() 的原文（scope + 路径 + 解析错误）",
        outcome.ok === false && /pi 报告的错误：global .*settings\.json：/.test(outcome.message),
        outcome.ok === false ? outcome.message : JSON.stringify(outcome),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A20：模块内并发不丢更新（F33/R8）
  {
    const root = s9Root();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "ws");
    const pkgA = fs.realpathSync(makePackage(path.join(root, "pkg-a")));
    const pkgB = fs.realpathSync(makePackage(path.join(root, "pkg-b")));
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const deps = { pi: piModule, cwd, agentDir };
    try {
      const [a, b] = await Promise.all([installPackage(deps, pkgA), installPackage(deps, pkgB)]);
      const packages = JSON.parse(fs.readFileSync(settingsPathOf(deps), "utf8")).packages;
      check(
        "A20：两个并发 install → 两个包都在文件里（F33 的丢更新）",
        a.ok === true && b.ok === true && packages.length === 2 && packages.includes("../pkg-a") && packages.includes("../pkg-b"),
        JSON.stringify({ a, b, packages }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- A13b：源码不变式（写路径的信任口径，R7）
  {
    const source = fs.readFileSync(path.join(REPO_ROOT, "src", "pi", "packages.ts"), "utf8");
    const region = (start, end) => {
      const at = source.indexOf(start);
      return at < 0 ? "" : source.slice(at, source.indexOf(end, at + start.length));
    };
    const writeManager = region("function writeManagerFor(", "function readManagerFor(");
    const writeRegion =
      region("export function installPackage(", "export function removePackage(") +
      region("export function removePackage(", "export function isNpmSource(");
    check(
      "A13b①：写路径的 manager 显式 { projectTrusted: false }（且不沾 true 那份）",
      writeManager.includes("projectTrusted: false") && !writeManager.includes("projectTrusted: true"),
      writeManager,
    );
    check(
      "A13b②：写函数不碰读列表那份 manager、也不出现 projectTrusted:true",
      source.includes("export function installPackage(") &&
        source.includes("export function removePackage(") &&
        writeRegion.includes("writeManagerFor(") &&
        !/readManagerFor|projectTrusted:\s*true/.test(writeRegion),
      writeRegion.slice(0, 200),
    );
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
