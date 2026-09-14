#!/usr/bin/env node
/**
 * controller 的端到端检查 —— **需要网络与真实凭据**，因此不进 CI。
 *
 * 为什么值得单独一个脚本：S2 的这几条不变量只有在真实事件流里才暴露得出来，
 * 而且全都是"看起来正常"的错误形态：
 *   - 流式中重开面板丢字（id 对不上，但已收到的字还在，像是成功）；
 *   - 每条回复多留一个空壳节点（upsert 找不到旧 id 就新建）；
 *   - 工具行要等调用结束才出现（长命令 30 秒毫无迹象）；
 *   - 扩展命令把状态行永久卡在"生成中"（扩展命令不启动 agent run，没有 agent_settled）；
 *   - 中止时**排队文本静默丢失**（pi 在中止过程中会把队列一并清掉，之后再 clearQueue 只拿到空数组）。
 *
 * 前置：
 *   1. `npm run sync`（需要 pi-runtime/ 存在）；
 *   2. `~/.pi/agent/auth.json`（或 `PI_CODING_AGENT_DIR` 指向的目录）里有可用凭据；
 *   3. 会产生**若干次真实模型调用**（本机用 deepseek 时约 5 次）。
 *
 * 没有凭据时以 0 退出并打印 SKIPPED —— 但不许把 SKIPPED 当成 PASS：
 * 提交涉及 controller 的改动前，必须在有凭据的开发机上跑一次。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const results = [];
const check = (name, ok, detail = "") => results.push([name, ok, detail]);

/** 会被 pi 当成凭据的环境变量（`provider-composer.js` 的那几档环境凭据都从 `process.env` 读）。 */
const CREDENTIAL_ENV_PATTERN = /^ANTHROPIC_|_API_KEY$|_API_TOKEN$|_AUTH_TOKEN$|_TOKEN$|_SECRET_ACCESS_KEY$/i;

/**
 * 在"凭据环境变量已清掉"的环境里跑一段断言 —— S6 的 **A4/A5 共用前置条件**（S6-plan §6）。
 * 不干净的环境会让 A4 假绿（别人的 key 顶着）、A5 假红（环境凭据让 configured 永远为真）。
 *
 * 计划原文是"**子进程里** `env -u`"；这里同进程删/恢复 —— pi 读的就是 `process.env`，等价，
 * 且不用为几条断言搭一个子进程入口（S6-plan §11 的 5-2）。
 */
async function withoutCredentialEnv(fn) {
  const saved = new Map();
  for (const name of Object.keys(process.env)) {
    if (!CREDENTIAL_ENV_PATTERN.test(name)) continue;
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) process.env[name] = value;
  }
}

function agentDirOf(pi) {
  return process.env.PI_CODING_AGENT_DIR ?? pi.getAgentDir();
}

/** 在 PATH 上找一个可执行文件（要跟符号链接：npm/fnm 装的 `pi` 通常是指向 cli.js 的链接）。 */
function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 权限/竞态：跳过这个候选
    }
  }
  return undefined;
}

/** 把需要的模块打成一个临时 ESM（`vscode` 保持 external，反正这条路径不碰它）。 */
async function loadModules(tempDir) {
  const entry = path.join(tempDir, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export { SessionHostController } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/controller"))};`,
      `export { createSelfTestUIContext } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/selftest-ui"))};`,
      `export { loadPi } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/loader"))};`,
      `export { getModelRuntime } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/runtime"))};`,
      `export { clearStoredApiKeys } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/runtime"))};`,
      `export { refreshModelCatalog } from ${JSON.stringify(path.join(REPO_ROOT, "src/pi/runtime"))};`,
    ].join("\n"),
    "utf8",
  );
  const outfile = path.join(tempDir, "bundle.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["vscode"],
    banner: {
      js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
    },
    outfile,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

/** 模拟 webview：`item` 是 upsert，`delta` 追加到对应 id 的流式文本上。 */
class View {
  constructor() {
    this.order = [];
    this.items = new Map();
    this.streamed = new Map();
  }
  apply(message) {
    if (message.type === "item") {
      if (!this.items.has(message.item.id)) this.order.push(message.item.id);
      this.items.set(message.item.id, message.item);
      if (message.item.kind === "assistant" && message.item.streaming !== true) {
        this.streamed.delete(message.item.id);
      }
    } else if (message.type === "delta") {
      this.streamed.set(message.id, (this.streamed.get(message.id) ?? "") + message.delta);
    }
  }
  list() {
    return this.order.map((id) => this.items.get(id)).filter(Boolean);
  }
  byKind(kind) {
    return this.list().filter((item) => item.kind === kind);
  }
}

const textOf = (item) => String(item?.text ?? "");

async function main() {
  if (!fs.existsSync(path.join(REPO_ROOT, "pi-runtime", "dist", "bundle", "index.js"))) {
    console.error("CONTROLLER-CHECK SKIPPED 需要先跑 npm run sync（pi-runtime/ 不存在）");
    return 0;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-controller-check-"));
  const { SessionHostController, createSelfTestUIContext, loadPi, getModelRuntime, clearStoredApiKeys, refreshModelCatalog } = await loadModules(tempDir);

  // A12 正向的探针：**必须在任何 ModelRuntime.create() 之前装**（create 期那次 refresh 正是
  // F8 点名的联网窗口）。包在 fetch 层而不是包 runtime.refresh —— 后者被评审第 2 轮 B2 证明
  // 几乎恒真（pi 内部那几个调用点我们的流程一步都走不到）；fetch 是目录刷新的真实出口。
  // 只记 host，不记 URL/header（不碰凭据）。
  const fetchHosts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
    try {
      fetchHosts.push(new URL(String(raw)).host);
    } catch {
      fetchHosts.push(String(raw).slice(0, 60));
    }
    return realFetch(input, init);
  };
  const pi = await loadPi(REPO_ROOT);
  const sourceAgentDir = agentDirOf(pi);
  if (!fs.existsSync(path.join(sourceAgentDir, "auth.json"))) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(`CONTROLLER-CHECK SKIPPED 没有凭据（${sourceAgentDir}/auth.json 不存在）`);
    return 0;
  }

  // 全程落在临时目录里：只借用凭据，不碰用户的 settings / 扩展 / 会话历史。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-ctl-"));
  const agentDir = path.join(root, "agent");
  const sessionsRoot = path.join(root, "sessions");
  const cwd = path.join(root, "cwd");
  for (const dir of [agentDir, sessionsRoot, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(sourceAgentDir, "auth.json"), path.join(agentDir, "auth.json"));

  const logLines = [];
  const log = { appendLine: (line) => { logLines.push(line); } };
  const messages = [];
  let controllerRef;
  let snapshotDuringStream;
  let deltasSeen = 0;
  let deltasAfterSnapshot = 0;
  let liveIdAtFirstDelta = "";
  /** S5 §9 第 2 步：会话替换后宿主应当收到的"重放"信号次数（面板靠它清空旧转写）。 */
  let replays = 0;

  const controller = new SessionHostController({
    pi,
    cwd,
    agentDir,
    sessionsRoot,
    keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
    uiContext: createSelfTestUIContext(log),
    log,
    additionalExtensionPaths: [path.join(REPO_ROOT, "test-fixtures", "ext-smoke", "index.ts")],
    // S5 §9 第 2 步（D6）：每成功替换一次会话就回调一次。
    // 现在没有这个选项 → replays 永远是 0 → 下面那两条断言是**真红**（不是编译错）。
    onSessionReplaced: () => {
      replays += 1;
    },
    onMessage: (message) => {
      messages.push(message);
      if (message.type !== "delta") return;
      deltasSeen += 1;
      if (deltasSeen === 1) liveIdAtFirstDelta = message.id;
      if (deltasSeen === 2 && snapshotDuringStream === undefined) {
        // 第 2 个 delta 时回复还在进行中（第 1 个可能已被 16ms 合帧吞进收尾）。
        snapshotDuringStream = controllerRef.snapshot();
      } else if (snapshotDuringStream !== undefined) {
        deltasAfterSnapshot += 1;
      }
    },
  });
  controllerRef = controller;

  const collect = () => {
    const view = new View();
    for (const message of messages) view.apply(message);
    return view;
  };

  try {
    await controller.ensure();
    const empty = controller.snapshot();
    check("ensure() 后 ready", controller.ready === true);
    check("初始快照为空且不忙", empty.items.length === 0 && empty.busy === false);

    // ---------------------- 0. 会话目录：必须是 pi 的 per-cwd 编码目录（S5 第 1 步的断言）
    //
    // 依据 docs/S5-plan.md §3.1：`sessionDir` 参数是"直接装 jsonl 的目录"，**不是** sessions 根。
    // 这里**故意自己复刻一遍编码规则**、不复用生产的 `resolveSessionDir`：
    // 断言要独立于被测实现，否则实现改了规则、断言跟着改，两边一起错（与 S1 的隔离 import 同理）。
    // `create()` 之后路径就已确定（构造函数里走 `newSession()`），所以这时**文件还不存在**也应该有值。
    // **也要物理化**：pi CLI 的 cwd 是 `process.cwd()`（物理路径），而 macOS 上 `os.tmpdir()`
    // 给的是 `/var/…`（`/private/var/…` 的符号链接）—— 不物理化就会与生产实现（已物理化）分叉，
    // 而分叉的代价是"终端里的 pi 找不到我们会话"（S5 验收期实测撞到过）。
    const physicalCwd = fs.realpathSync(cwd);
    const encodedCwd = `--${physicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const expectedSessionsDir = path.join(sessionsRoot, encodedCwd);
    const sessionFile = controller.session?.sessionManager?.getSessionFile();
    check(
      "会话路径在落盘前就已确定",
      typeof sessionFile === "string" && sessionFile.length > 0,
      String(sessionFile),
    );
    check(
      "会话写在 pi 的 per-cwd 编码目录里（不是 sessions 根）",
      typeof sessionFile === "string" && path.dirname(sessionFile) === expectedSessionsDir,
      `期望 ${expectedSessionsDir}｜实际 ${typeof sessionFile === "string" ? path.dirname(sessionFile) : "(无)"}`,
    );

    // ---------------------------------------------------- 1. 一轮对话 + 流式中重开面板
    messages.length = 0;
    deltasSeen = 0;
    deltasAfterSnapshot = 0;
    snapshotDuringStream = undefined;
    liveIdAtFirstDelta = "";
    // 明确"不要用工具"：这句原本只是要一段纯文本回复，而模型偶尔会先调一次工具，
    // 于是"只剩一个 assistant 节点"与"正文非空"两条就红了（S5 实施期撞到过）。
    // 断言的前提（一次纯文本回复）应当由**提示词**保证，而不是靠运气。
    await controller.prompt("请用中文写一段 150 字左右的海洋介绍。直接回答，不要调用任何工具。", "auto");
    const view = collect();
    check(
      "第一轮回复后文件真的落在同一个目录（路径不漂）",
      typeof sessionFile === "string" &&
        fs.existsSync(sessionFile) &&
        path.dirname(sessionFile) === expectedSessionsDir,
      String(sessionFile),
    );
    const assistants = view.byKind("assistant");
    check("upsert 之后只剩一个 assistant 节点（N1 回归）", assistants.length === 1, JSON.stringify(view.order));
    check("最终文本非空（不是空壳）", textOf(assistants[0]).length > 20, JSON.stringify(textOf(assistants[0]).slice(0, 40)));
    check("delta 带的是 assistant 的 id", liveIdAtFirstDelta === assistants[0]?.id, liveIdAtFirstDelta);
    const busySeq = messages.filter((m) => m.type === "busy").map((m) => m.busy);
    check("busy 先 true 后 false", busySeq[0] === true && busySeq[busySeq.length - 1] === false, busySeq.join("->"));

    const streamedItems = (snapshotDuringStream?.items ?? []).filter(
      (item) => item.kind === "assistant" && item.streaming === true,
    );
    check("流式中快照里有进行中的 assistant（C1 回归）", streamedItems.length === 1, JSON.stringify(streamedItems.map((i) => i.id)));
    check("快照 id 与实时 delta 的 id 一致（不丢后半截）", streamedItems[0]?.id === liveIdAtFirstDelta,
      `snapshot=${streamedItems[0]?.id} live=${liveIdAtFirstDelta}`);
    check("快照之后仍有 delta 到达", deltasAfterSnapshot > 0, String(deltasAfterSnapshot));

    // ---------------------------------------------------- 2. 工具行
    messages.length = 0;
    await controller.prompt("Run this exact bash command: echo JERRYPI_TOOL_TEST", "auto");
    const view2 = collect();
    const toolItems = view2.byKind("tool");
    // 一次 prompt 里模型可能调用多轮工具，所以不能断言"只有一行"；
    // 要断言的是**每个 toolCallId 在最终视图里只占一行**（占位被同 id 的收尾替换掉）。
    const toolMessages = messages.filter((m) => m.type === "item" && m.item.kind === "tool");
    const byId = new Map();
    for (const message of toolMessages) {
      const list = byId.get(message.item.id) ?? [];
      list.push(message.item.pending === true ? "pending" : "settled");
      byId.set(message.item.id, list);
    }
    check("发生过工具调用", toolItems.length > 0, JSON.stringify(view2.order));
    check("最终视图里每个工具调用只占一行（N4 回归）",
      toolItems.length === byId.size && new Set(view2.order).size === view2.order.length,
      `视图行数=${toolItems.length} 不同 id 数=${byId.size} order=${JSON.stringify(view2.order)}`);
    check("每次调用都是 pending -> settled、且 id 不变",
      [...byId.values()].every((seq) => seq.length === 2 && seq[0] === "pending" && seq[1] === "settled"),
      JSON.stringify([...byId.entries()].map(([id, seq]) => `${id}:${seq.join(",")}`)));

    // ---------------------------------------------------- 2b. 工具卡片的流式输出（S3）
    //
    // 这一组每一条都对应 S3-plan §0.2 里一条"反直觉"的事实，或评审抓到的一个洞。
    messages.length = 0;
    const streamedSnapshots = [];
    let streamBytes = 0;
    let streamFrames = 0;
    // 用一个独立的控制器实例，理由：这一组要单独量测消息帧数与字节数。
    const streamController = new SessionHostController({
      pi, cwd, agentDir, sessionsRoot,
      keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
      uiContext: createSelfTestUIContext(log),
      log,
      onMessage: (message) => {
        // 与上面的控制器一样把消息记进**同一个** `messages`（View 从这里重建视图）——
        // 第一版忘了这一句，于是后面所有 "从视图里取工具行" 的断言都拿到 undefined。
        messages.push(message);
        if (message.type === "item" && message.item.kind === "tool") {
          streamFrames += 1;
          streamBytes += Buffer.byteLength(JSON.stringify(message.item), "utf8");
          if (message.item.pending === true && message.item.text !== undefined) {
            streamedSnapshots.push(message.item.text);
          }
        }
      },
    });
    try {
      await streamController.ensure();
      const started = Date.now();
      await streamController.prompt(
        'Run this exact bash command: for i in 1 2 3 4 5 6; do echo "行 $i"; sleep 0.4; done',
        "auto",
      );
      const elapsedMs = Date.now() - started;

      check("流式期间收到多帧工具行（不是结束后才出现）", streamedSnapshots.length >= 2, String(streamedSnapshots.length));
      // **快照语义**：每个中间帧必须是"当次快照"，不能是拼接出来的
      const lastSnapshot = streamedSnapshots.at(-1) ?? "";
      check("中间帧的正文是快照而不是拼接（行数与 echo 次数一致）",
        (lastSnapshot.match(/行 \d/g) ?? []).length >= 3 && !lastSnapshot.includes("行 1行 1"),
        JSON.stringify(lastSnapshot.slice(0, 80)));
      check("流式的帧率被 TOOL_FRAME_MS 限制（不会一帧一帧地打）",
        streamedSnapshots.length <= Math.ceil(elapsedMs / 200) + 2,
        `frames=${streamedSnapshots.length} elapsed=${elapsedMs}ms`);
      console.log(`      · 量测：流式 ${streamFrames} 帧 / ${(streamBytes / 1024).toFixed(1)} KB / ${elapsedMs}ms`);

      // 最坏情况的量测（R4）：输出超过 50KB 之后每次快照都是满的 50KB。
      // 命令边写边停，好让合并窗口真的发出多帧。
      messages.length = 0;
      streamFrames = 0;
      streamBytes = 0;
      const bigStart = Date.now();
      await streamController.prompt(
        'Run this exact bash command: for i in $(seq 1 3000); do echo "行 $i ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; if [ $((i % 500)) -eq 0 ]; then sleep 0.5; fi; done',
        "auto",
      );
      const bigMs = Math.max(1, Date.now() - bigStart);
      const bigRows = new View();
      for (const message of messages) bigRows.apply(message);
      const bigRow0 = bigRows.byKind("tool").filter((item) => item.toolName === "bash").at(-1);
      console.log(
        `      · 量测（大输出）：${streamFrames} 帧 / ${(streamBytes / 1024).toFixed(1)} KB / ${bigMs}ms ` +
        `→ ${(streamBytes / 1024 / (bigMs / 1000)).toFixed(0)} KB/s；最终正文 ${Buffer.byteLength(textOf(bigRow0), "utf8")} 字节`,
      );
      // 这里的期望值在 S3 的 M5 之后**反了**：pi 会把
      // `[Showing … Full output: <path>]` 写进正文，而我们另外渲染"已截断/完整输出"两行
      // （照 pi 的 renderResult），所以序列化后的正文里**必须没有**这段脚注 ——
      // 留着就是同一件事说三遍，而且它会占掉折叠预览 5 个名额里的 2 个。
      // 第一版断言写的是"能看到脚注"，与 M5 的需求相反；它在 S3 之后再没绿过
      // （实测在 fe3a659 上同样是红的 —— 是陈旧断言，不是回归）。
      check("大输出：正文里**没有** pi 的重复脚注（我们另外渲染两行）",
        !textOf(bigRow0).includes("Full output:"), JSON.stringify(textOf(bigRow0).slice(-100)));
      check("大输出：正文确实被 pi 截断过（体积接近 50KB 上限）",
        Buffer.byteLength(textOf(bigRow0), "utf8") > 40 * 1024,
        String(Buffer.byteLength(textOf(bigRow0), "utf8")));


      messages.length = 0;
      // 中止路径（探针 H）：已流出的正文必须还在。
      //
      // 这一节**依赖模型真的照跑那条长命令**。第一版写死"等 2500ms 再断言"，
      // 结果模型有一次没照做（换了命令或跑得很快），一排断言全挂 —— 那是**假警报**，
      // 比不测更糟（会让人去"修"一个不存在的 bug）。改成轮询等一个"确实在执行中的
      // 工具行"，等不到就 SKIP 并打印原因。
      messages.length = 0;
      const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const abortable = streamController.prompt(
        'Run this exact bash command: for i in $(seq 1 20); do echo "中止行 $i"; sleep 0.5; done',
        "auto",
      );
      let midSnapshot;
      let runningRow;
      const waitUntil = Date.now() + 25000;
      // 轮询条件必须包含"**已经流出正文**"：pending 行在 `tool_execution_start`
      // 就存在了，那时正文还是空的 —— 只等 pending 会在第一帧输出之前就命中，
      // 于是下面"已流出的正文还在"偶发假红（实测出现过一次）。
      while (Date.now() < waitUntil) {
        midSnapshot = streamController.snapshot();
        runningRow = midSnapshot.items.find(
          (item) =>
            item.kind === "tool" &&
            item.pending === true &&
            typeof item.text === "string" &&
            item.text.includes("中止行"),
        );
        if (runningRow !== undefined) break;
        await sleepMs(250);
      }
      if (runningRow === undefined) {
        console.log("      · SKIP：模型这次没有执行长命令（等不到 pending 的工具行）—— 本节 4 条断言跳过");
        await streamController.abort().catch(() => {});
        await abortable.catch(() => {});
      } else {
        check("执行中重开：运行中的行已经有 pi 风格的 title（不是原始 JSON）",
          typeof runningRow.title?.text === "string" && !runningRow.title.text.startsWith("{"),
          JSON.stringify(runningRow.title));
        check("执行中重开：已流出的正文还在（C1/N1 家族第四处）",
          typeof runningRow.text === "string" && runningRow.text.includes("中止行"),
          JSON.stringify(runningRow.text?.slice(0, 60)));
        check("执行中快照的 busy=true", midSnapshot.busy === true);
        await streamController.abort();
        await abortable.catch(() => {});
        // 等它落地：中止的收尾是几条事件，不是同步完成的。
        let abortedRow;
        const settleDeadline = Date.now() + 5000;
        while (Date.now() < settleDeadline) {
          const view = new View();
          for (const message of messages) view.apply(message);
          abortedRow = view.byKind("tool").at(-1);
          if (abortedRow !== undefined && abortedRow.pending !== true) break;
          await sleepMs(100);
        }
        check("中止后：正文没有丢（探针 H 的回归点）",
          textOf(abortedRow).includes("中止行"),
          JSON.stringify(textOf(abortedRow).slice(0, 80)));
        check("中止后：状态是错误", abortedRow?.isError === true);
        check("中止后：正文里带 pi 自己的 Command aborted", textOf(abortedRow).includes("Command aborted"));
        check("中止后：有 endedAt（耗时能显示）", typeof abortedRow?.endedAt === "number");
      }

      // 帧竞态：最终 item 之后不得再有同一 id 的 pending 帧（评审第 2 轮第 6 条）
      const finalSeq = new Map();
      for (const message of messages) {
        if (message.type !== "item" || message.item.kind !== "tool") continue;
        const seq = finalSeq.get(message.item.id) ?? [];
        seq.push(message.item.pending === true ? "pending" : "settled");
        finalSeq.set(message.item.id, seq);
      }
      check("同一工具不会在 settled 之后又收到 pending 帧",
        [...finalSeq.values()].every((seq) => seq.indexOf("settled") === seq.length - 1),
        JSON.stringify([...finalSeq.entries()].map(([id, seq]) => `${id}:${seq.join(",")}`)));

      // 失败路径：pi 把状态写进正文，我们只显示不加工
      messages.length = 0;
      await streamController.prompt("Run this exact bash command: exit 3", "auto");
      const failedView = new View();
      for (const message of messages) failedView.apply(message);
      const failedRow = failedView.byKind("tool").at(-1);
      check("失败命令：isError=true", failedRow?.isError === true);
      check("失败命令：正文含 pi 的 Command exited with code 3（我们不自己编）",
        textOf(failedRow).includes("Command exited with code 3"), JSON.stringify(textOf(failedRow)));

      // 截断路径：pi 的标量 + 完整输出文件 + 可点路径
      messages.length = 0;
      await streamController.prompt('Run this exact bash command: head -c 120000 /dev/zero | tr "\\0" "x"', "auto");
      const bigView = new View();
      for (const message of messages) bigView.apply(message);
      const bigRow = bigView.byKind("tool").at(-1);
      check("截断：truncation 标量被保留", bigRow?.truncation?.truncatedBy === "bytes", JSON.stringify(bigRow?.truncation));
      check("截断摘要里**没有** pi 的 truncation.content（体积不翻倍）",
        JSON.stringify(bigRow?.truncation ?? {}).length < 400,
        `len=${JSON.stringify(bigRow?.truncation ?? {}).length}`);
      check("截断：完整输出路径被保留", typeof bigRow?.fullOutputPath === "string" && bigRow.fullOutputPath.length > 0);
      // 同上：脚注必须**已经剥掉**（M5），但"完整输出"这个信息不能丢 ——
      // 它在 `fullOutputPath` 里，由卡片自己渲染成可点路径（下一条断言）。
      check("截断：正文里没有重复脚注，但完整输出路径仍在（M5 的两半）",
        !textOf(bigRow).includes("Full output:") &&
          typeof bigRow?.fullOutputPath === "string" &&
          bigRow.fullOutputPath.length > 0,
        JSON.stringify(textOf(bigRow).slice(-120)));
      check("截断：正文没有被我们自己的上限裁过", bigRow?.textTruncated === undefined);

      // 可点路径白名单（评审第 2 轮第 4、5 条）
      messages.length = 0;
      const probeFile = path.join(cwd, "path-probe.txt");
      fs.writeFileSync(probeFile, "hello\n");
      await streamController.prompt(`Use the read tool on ${probeFile} (read it, do not explain)`, "auto");
      const readView = new View();
      for (const message of messages) readView.apply(message);
      const readRow = readView.byKind("tool").find((item) => item.toolName === "read");
      check("read 卡片的标题参数里有路径", typeof readRow?.summary === "string" && readRow.summary.includes("path-probe.txt"), readRow?.summary);
      check("read 卡片登记了绝对路径", Array.isArray(readRow?.openablePaths) && readRow.openablePaths.includes(probeFile), JSON.stringify(readRow?.openablePaths));
      check("已登记的路径可以打开", streamController.isOpenableFile(probeFile) === true);
      check("未登记的路径打不开（白名单生效）", streamController.isOpenableFile("/etc/passwd") === false);
      check("相对路径打不开（只认绝对路径）", streamController.isOpenableFile("path-probe.txt") === false);
      // 重放之后（快照重建白名单）仍然能打开
      const replayed = streamController.snapshot();
      check("重放快照里的历史卡片仍带路径",
        replayed.items.some((item) => item.kind === "tool" && (item.openablePaths ?? []).includes(probeFile)));
      check("重放之后白名单仍认得它", streamController.isOpenableFile(probeFile) === true);

      // 快照体积与耗时（D4 的 4MB 预算要不要那么大）
      const t0 = Date.now();
      const snap = streamController.snapshot();
      const snapMs = Date.now() - t0;
      const snapBytes = Buffer.byteLength(JSON.stringify(snap), "utf8");
      console.log(`      · 量测：snapshot ${snap.items.length} 条 / ${(snapBytes / 1024).toFixed(1)} KB / ${snapMs}ms`);
    } finally {
      await streamController.dispose().catch(() => {});
    }

    // ---------------------------------------------------- 3. 长命令中重开 + 中止清队列
    messages.length = 0;
    const long = controller.prompt("Run this exact bash command: sleep 25", "auto");
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const mid = controller.snapshot();
    check("执行中快照带 pending 工具行（N1 家族第三处）",
      mid.items.filter((item) => item.kind === "tool" && item.pending === true).length === 1,
      JSON.stringify(mid.items.map((i) => i.id)));
    check("执行中快照 busy=true", mid.busy === true);
    messages.length = 0;
    void controller.prompt("取回甲", "steer").catch(() => {});
    void controller.prompt("取回乙", "followUp").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 关键回归：入队也必须回一个"已接受"，否则前端会把用户的下一条消息卡住
    // （实测现象：队列里有一条时，第二条点「排队」毫无反应）。
    check("steer/followUp 入队后收到 promptAccepted",
      messages.filter((m) => m.type === "promptAccepted").length >= 2,
      String(messages.filter((m) => m.type === "promptAccepted").length));
    const queued = controller.snapshot().queue;
    check("排队后快照里能看到两条（steering + followUp）",
      queued.steering.length === 1 && queued.followUp.length === 1, JSON.stringify(queued));

    // pi 的 "edit all queued messages"（dequeue）：**取回**而不是丢弃，
    // 顺序 steering 在前、空行分隔（对齐 interactive-mode.js 的 allQueued.join("\n\n")）。
    const taken = controller.clearQueue();
    check("取回队列返回文本而不是丢弃", taken === "取回甲\n\n取回乙", JSON.stringify(taken));
    check("取回后队列为空",
      controller.snapshot().queue.steering.length === 0 && controller.snapshot().queue.followUp.length === 0,
      JSON.stringify(controller.snapshot().queue));

    // 再排两条，这次用中止把它们退回输入框（Esc 在 pi 里就是这个行为）
    messages.length = 0;
    void controller.prompt("退回甲", "steer").catch(() => {});
    void controller.prompt("退回乙", "followUp").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    await controller.abort();
    await long.catch(() => {});
    const restored = messages.filter((m) => m.type === "restoreComposer").map((m) => m.text);
    check("中止后被清掉的排队文本退回输入框（D9 回归）",
      restored.join("|").includes("退回甲") && restored.join("|").includes("退回乙"), JSON.stringify(restored));
    const lastQueue = messages.filter((m) => m.type === "queue").pop();
    check("中止后队列条清空",
      lastQueue !== undefined && lastQueue.steering.length === 0 && lastQueue.followUp.length === 0,
      JSON.stringify(lastQueue));
    const busyAfterAbort = messages.filter((m) => m.type === "busy").map((m) => m.busy);
    check("中止后 busy 回到 false", busyAfterAbort[busyAfterAbort.length - 1] === false, busyAfterAbort.join("->"));

    messages.length = 0;
    await controller.prompt("Reply with exactly: OK", "auto");
    // 不断言模型"回了 OK 这两个字" —— 那是模型的措辞，不是我们的行为
    // （S5 实施期撞到过一次：它没照 exactly 回，门禁就红了）。
    // 我们真正要证的是"会话还能正常跑完一轮"。
    const afterAbort = collect().byKind("assistant");
    check(
      "中止后会话仍可用（又跑完了一轮，且有正文）",
      afterAbort.length > 0 && textOf(afterAbort[afterAbort.length - 1]).length > 0 && controller.snapshot().busy === false,
      JSON.stringify(textOf(afterAbort[afterAbort.length - 1] ?? {}).slice(0, 60)),
    );

    // ---------------------------------------------------- 4. 扩展命令不卡 busy
    messages.length = 0;
    await controller.prompt("/smoke", "auto");
    const smokeBusy = messages.filter((m) => m.type === "busy").map((m) => m.busy);
    check("扩展命令后 busy 被解除（N2 回归）",
      smokeBusy.length > 0 && smokeBusy[smokeBusy.length - 1] === false, smokeBusy.join("->"));

    // ---------------------------------------------------- 5. 新会话
    // S5 §9 第 2 步的五条断言（D4 重启恢复 + D6 替换后重放 + S1 取消分支 + B5 的日志）
    check(
      "Output 记了会话文件路径（供人查「我的会话存哪了」）",
      logLines.some((line) => line.includes("[controller] 会话文件：")),
      logLines.filter((l) => l.includes("[controller]")).slice(-2).join(" ｜ "),
    );
    const before = controller.snapshot().items.length;
    const firstSessionFile = controller.session?.sessionManager?.getSessionFile();

    // 5a（S1）：**被扩展取消的替换** — farm 具里的 `session_before_switch` 在
    // `JERRYPI_SMOKE_CANCEL_SWITCH=1` 时取消。取消时必须**什么都不做**：
    // 不清状态（面板还拿着旧转写）、不换会话、不发重放。
    {
      const replaysBeforeCancel = replays;
      process.env.JERRYPI_SMOKE_CANCEL_SWITCH = "1";
      try {
        await controller.newSession();
      } finally {
        delete process.env.JERRYPI_SMOKE_CANCEL_SWITCH;
      }
      check(
        "被取消的替换：会话没换、历史没被清、也没发重放",
        controller.snapshot().items.length === before &&
          controller.session?.sessionManager?.getSessionFile() === firstSessionFile &&
          replays === replaysBeforeCancel,
        `items=${controller.snapshot().items.length}（原 ${before}）｜replays=${replays}`,
      );
    }

    // 5b（D6）：真的换一次 —— 历史清空 + 发出重放
    const replaysBefore = replays;
    await controller.newSession();
    check("newSession 后历史清空", controller.snapshot().items.length === 0 && before > 0);
    check(
      "newSession 后发出重放信号（面板才会真的清空）",
      replays === replaysBefore + 1,
      `replays=${replays}（期望 +1）`,
    );

    // 5c（D4）：**重启等价物** —— 同一个 sessionsRoot 上再建一个 controller，
    // 应当 `continueRecent` 接过上一会话，而不是开一个空的。
    {
      const revived = new SessionHostController({
        pi,
        cwd,
        agentDir,
        sessionsRoot,
        keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
        uiContext: createSelfTestUIContext(log),
        log,
        onMessage: () => {},
      });
      try {
        await revived.ensure();
        const snap = revived.snapshot();
        check(
          "重启（重建 controller）后接过上一会话，而不是开新的",
          snap.items.length > 0 && snap.items.length === before,
          `items=${snap.items.length}，重启前是 ${before}`,
        );
        check(
          "接过的就是那个文件（不是另建了一个）",
          revived.session?.sessionManager?.getSessionFile() === firstSessionFile,
          String(revived.session?.sessionManager?.getSessionFile()),
        );
      } finally {
        await revived.dispose().catch(() => {});
      }
    }

    // 5d（D9）：cwd 已不存在的会话 → 可读的拒绝，且当前会话不变
    {
      const goneCwd = path.join(root, "gone-cwd");
      fs.mkdirSync(goneCwd, { recursive: true });
      const encoded = `--${path.resolve(goneCwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      const goneDir = path.join(sessionsRoot, encoded);
      const manager = pi.SessionManager.create(goneCwd, goneDir);
      manager.appendMessage({ role: "user", content: [{ type: "text", text: "gone" }], timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "jerrypi-check",
        provider: "jerrypi-check",
        model: "check",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const goneFile = manager.getSessionFile();
      fs.rmSync(goneCwd, { recursive: true, force: true });
      const fileBefore = controller.session?.sessionManager?.getSessionFile();
      const gone = await controller.switchSession(goneFile);
      check(
        "cwd 已不存在的会话：给可读的 missing-cwd（不是抛异常）",
        gone.ok === false && gone.code === "missing-cwd",
        JSON.stringify(gone),
      );
      check(
        "  而且当前会话没变（失败是原子的）",
        controller.session?.sessionManager?.getSessionFile() === fileBefore,
        String(controller.session?.sessionManager?.getSessionFile()),
      );
    }

    // 5e（D7）：忙时**不直接切**。两格 —— `pendingSend`（agent_start 之前）与真流式。
    {
      const fileBefore = controller.session?.sessionManager?.getSessionFile();

      // 格 1：那个窗口里 `isIdle` 仍是 true（这正是评审 B2 指的洞），只有 `pendingSend` 知道
      controller.pendingSend = true;
      const busy1 = await controller.newSession();
      controller.pendingSend = false;
      check(
        "忙（已发送、agent_start 未到）：拒绝且会话不变",
        busy1.ok === false && busy1.code === "busy" && controller.session?.sessionManager?.getSessionFile() === fileBefore,
        JSON.stringify(busy1),
      );

      // 格 2：真流式 —— 先拒，force 之后才真的换（旧会话那一轮会被中止并落盘）
      const streaming = controller.prompt("请数 1 到 30，每行一个数字。", "auto");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const busy2 = await controller.newSession();
      check("真流式：拒绝", busy2.ok === false && busy2.code === "busy", JSON.stringify(busy2));
      const forced = await controller.newSession({ force: true });
      check(
        "确认后（force）真的换了",
        forced.ok === true && controller.session?.sessionManager?.getSessionFile() !== fileBefore,
        JSON.stringify(forced),
      );
      await streaming.catch(() => undefined);
    }

    // 5f（D5/D8）：会话列表的数据源与顺序；以及 `meta.session` 的"未保存 → 已保存"
    {
      const list = await controller.listSessions();
      const dir = controller.session?.sessionManager?.getSessionDir();
      check(
        "列表全部来自当前会话目录（D5：不跨项目，也不需要第二处目录推导）",
        list.length > 0 && list.every((s) => path.dirname(s.path) === dir),
        `${list.length} 条；dir=${dir}`,
      );
      const stamps = list.map((s) => s.modified.getTime());
      check(
        "列表已按 modified 倒序（pi 排好的，我们没再排一次）",
        stamps.every((v, i) => i === 0 || stamps[i - 1] >= v),
        stamps.join(","),
      );
      const currentPath = controller.currentSessionPath();
      check(
        "未落盘的当前会话不在列表里（pi 的落盘契约：首条 assistant 之后才建文件）",
        currentPath !== "" && !list.some((s) => s.path === currentPath),
        `current=${currentPath}`,
      );
      const before = controller.snapshot().meta.session;
      check(
        "未落盘时 `meta.session.persisted=false`（面板靠它标「未保存」）",
        before.persisted === false && before.path === currentPath && before.name.length > 0,
        JSON.stringify(before),
      );
      await controller.prompt("Reply with the single word OK", "auto");
      const after = controller.snapshot().meta.session;
      check(
        "一轮回复后 persisted=true，且名字来自首条 user 消息",
        after.persisted === true && after.name.includes("OK"),
        JSON.stringify(after),
      );
      const listed = await controller.listSessions();
      check(
        "落盘后它才出现在列表里",
        listed.some((s) => s.path === after.path),
        `${listed.length} 条`,
      );
    }

    // 5g（R9）：CLI 侧的会话目录被上游开关搬走时，面板不跟随 —— 但必须说一声
    {
      const makeControllerWith = (extraAgentDir) =>
        new SessionHostController({
          pi, cwd, agentDir: extraAgentDir, sessionsRoot,
          keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
          uiContext: createSelfTestUIContext(log),
          log,
          onMessage: () => {},
        });

      process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "elsewhere");
      logLines.length = 0;
      const byEnv = makeControllerWith(agentDir);
      try { await byEnv.ensure(); } finally { await byEnv.dispose().catch(() => undefined); }
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      check(
        "环境变量 PI_CODING_AGENT_SESSION_DIR 会得到一行诊断（R9）",
        logLines.some((line) => line.includes("PI_CODING_AGENT_SESSION_DIR")),
        logLines.filter((l) => l.includes("注意")).join(" ｜ ").slice(0, 200),
      );

      // settings.json 的 sessionDir 那条分支也要真跑一次（否则它只是“看起来写了”）
      const settingsDir = path.join(root, "agent3");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.copyFileSync(path.join(sourceAgentDir, "auth.json"), path.join(settingsDir, "auth.json"));
      fs.writeFileSync(
        path.join(settingsDir, "settings.json"),
        JSON.stringify({ sessionDir: path.join(root, "elsewhere2") }),
        "utf8",
      );
      logLines.length = 0;
      const bySettings = makeControllerWith(settingsDir);
      try { await bySettings.ensure(); } finally { await bySettings.dispose().catch(() => undefined); }
      check(
        "settings.json 里的 sessionDir 也会得到一行诊断（R9）",
        logLines.some((line) => line.includes("settings.json 里的 sessionDir")),
        logLines.filter((l) => l.includes("注意")).join(" ｜ ").slice(0, 200),
      );
    }

    // ---------------------------------------------------- 6. 面板的模型策略
    // 6a：临时 agentDir 里**没有** settings.json → 用户没选过 → 用我们的偏好兜底
    check(
      "协议 v4：快照里没有顶层 `model` 了（只说在 meta 里）",
      !("model" in controller.snapshot()) && typeof controller.snapshot().meta.model === "string",
      JSON.stringify(Object.keys(controller.snapshot())),
    );
    check("用户没选过模型时，兜底到便宜的 flash（不用 pro）",
      controller.snapshot().meta.model === "deepseek/deepseek-v4-flash", controller.snapshot().meta.model);

    // 6b：用户选过（settings.json 里有 defaultProvider/defaultModel）→ 不覆盖
    {
      const agentDir2 = path.join(root, "agent2");
      fs.mkdirSync(agentDir2, { recursive: true });
      fs.copyFileSync(path.join(sourceAgentDir, "auth.json"), path.join(agentDir2, "auth.json"));
      fs.writeFileSync(
        path.join(agentDir2, "settings.json"),
        // 用一个"与我们的兜底不同"的模型，才能真正证明没有被覆盖：
        // 兜底会选 deepseek-v4-flash，这里故意选 flash-vision-exp。
        JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash-vision-exp" }),
        "utf8",
      );
      const second = new SessionHostController({
        pi, cwd, agentDir: agentDir2, sessionsRoot: path.join(root, "sessions2"),
        keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
        uiContext: createSelfTestUIContext(log),
        log,
        onMessage: () => {},
      });
      try {
        await second.ensure();
        const picked = second.snapshot().meta.model;
        check("用户选过模型时，面板不覆盖（跟着 pi 设置走）",
          picked === "deepseek/deepseek-v4-flash-vision-exp", picked);
        // 再换一个会话：新会话同样要保住用户的选择
        await second.newSession();
        check("新会话之后仍然保住用户的选择",
          second.snapshot().meta.model === "deepseek/deepseek-v4-flash-vision-exp", second.snapshot().meta.model);
      } finally {
        await second.dispose().catch(() => {});
      }
    }

    // ---------------------------------------------------- 7. 元信息（S4）
    {
      const meta = controller.snapshot().meta;
      check("快照里带 meta 且形状正确（v3 的必填字段）",
        typeof meta.model === "string" && meta.model !== "" &&
          typeof meta.provider === "string" && meta.provider !== "" &&
          typeof meta.thinkingLevel === "string" &&
          meta.supportsThinking === true &&
          meta.contextWindow > 0 &&
          meta.contextUsage !== null &&
          typeof meta.contextUsage.percent === "number",
        JSON.stringify(meta));
      check("等级是 pi 回读出来的生效值（不是我们设进去的）",
        ["off", "low", "high", "max"].includes(meta.thinkingLevel), meta.thinkingLevel);

      // 注意：`byKind()` 过滤的是 **ChatItem 的 kind**（user/assistant/tool/notice），
      // 协议消息类型要用 `messages.filter(type)` —— 第一版这里查错了维度，恒为 0。
      const metaMessages = messages.filter((m) => m.type === "meta");
      check("一整轮对话期间广播过 meta（用量随消息落地变化）", metaMessages.length > 0, String(metaMessages.length));

      // D15：**面板里选过的模型，本窗口内一直是它** —— 包括 `newSession` 之后。
      // 没有这条记忆的话，onRebind → alignPanelModel 会把它改回我们的偏好（flash）。
      await controller.newSession();
      const models = await controller.listAvailableModels();
      const vision = models.find((m) => m.id === "deepseek-v4-flash-vision-exp");
      if (vision === undefined) {
        console.log("  SKIP 面板模型记忆（D15）：本机没有 flash-vision-exp");
      } else {
        await controller.applyPanelModel(vision);
        check("面板里选模型后 meta 立刻更新",
          controller.snapshot().meta.model === "deepseek/deepseek-v4-flash-vision-exp",
          controller.snapshot().meta.model);
        await controller.newSession();
        check("D15：新建会话之后**仍然**是面板里选的那个模型（不被兜底改回去）",
          controller.snapshot().meta.model === "deepseek/deepseek-v4-flash-vision-exp",
          controller.snapshot().meta.model);
      }
    }

    // ------------------------------- 2. agentDir 贯通（C3 的三条链路，S6 第 2 步）
    //
    // 关键：**不传 `agentDir` 选项**，只设 `process.env.PI_CODING_AGENT_DIR` —— 这样走的是真链路：
    // 设置 → 环境变量 → `pi.getAgentDir()` → 各调用方（`controller.ts:288` 的 `?? pi.getAgentDir()`）。
    // 传选项只能证明"参数被尊重"，那是从 S5 起就一直成立的事（S6-plan §10 第 4 轮 S1）。
    {
      const c3Root = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-c3-"));
      const c3Agent = path.join(c3Root, "agent");
      const c3Cwd = path.join(c3Root, "cwd");
      for (const dir of [c3Agent, c3Cwd]) fs.mkdirSync(dir, { recursive: true });
      // 夹具：auth.json 里放一个**只在这里存在**的 provider —— "读到了新目录"与"读了默认目录"
      // 必然给出不同答案，所以这两条断言能红，不是恒绿。
      const probeProvider = "jerrypi-c3-probe";
      // 夹具只要一个**只在这里存在**的 provider —— 这两条断言**都不发模型请求**（见下），
      // 所以不必拷真凭据进来（少一次"把用户的 key 抄进临时目录"）。
      fs.writeFileSync(path.join(c3Agent, "auth.json"), JSON.stringify({ [probeProvider]: { type: "api_key", key: "sk-not-a-real-key" } }), "utf8");
      const realAuth = path.join(pi.getAgentDir(), "auth.json");
      const sha = (file) => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : undefined);
      const realBefore = sha(realAuth);
      const savedEnv = process.env.PI_CODING_AGENT_DIR;
      const savedRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
      delete process.env.PI_CODING_AGENT_SESSION_DIR; // 免得上游的会话目录开关干扰这条断言
      process.env.PI_CODING_AGENT_DIR = c3Agent;
      let c3;
      try {
        const effective = pi.getAgentDir();
        check("A13/A14 的前提：设了环境变量之后 pi.getAgentDir() 真的变成它",
          path.resolve(effective) === path.resolve(c3Agent), effective);

        const c3Keys = { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} };
        c3 = new SessionHostController({ pi, cwd: c3Cwd, keys: c3Keys, uiContext: createSelfTestUIContext(log), log, onMessage: () => {} });
        await c3.ensure();
        // A13 只看**路径**（`ensure()` 之后就有），所以不需要真对话 —— 上一版先发一条消息，
        // 结果"链路被改坏"时红在 `ensure()` 的凭据错误上，报的是一句和本断言无关的话。
        const file = c3.session?.sessionManager?.getSessionFile() ?? "";
        const selfRoot = path.join(c3Agent, "sessions") + path.sep;
        check("A13：只设环境变量（不传选项）→ 会话落在 <agentDir>/sessions/ 下", file.startsWith(selfRoot), file);

        // A14 也只用本地判定：`ensure()` 已经用生效的 agentDir 建过 ModelRuntime（同一个缓存实例），
        // `getProviderAuthStatus` 读的是 auth.json，不发请求。
        const status = c3.session?.sessionManager === undefined ? {} : (await getModelRuntime(pi, effective, c3Keys)).getProviderAuthStatus(probeProvider);
        check("A14：新目录 auth.json 里的 provider 被认出（source=stored）",
          status.configured === true && status.source === "stored", JSON.stringify(status));

        const defaultDir = path.join(process.env.HOME ?? "/", ".pi", "agent");
        const other = await getModelRuntime(pi, defaultDir, c3Keys);
        check("A14 的反向：默认目录里没有这个 provider（证明夹具有鉴别力）",
          other.getProviderAuthStatus(probeProvider).configured !== true,
          JSON.stringify(other.getProviderAuthStatus(probeProvider)));
        check("A14：真实 ~/.pi/agent/auth.json 的 sha256 未变", sha(realAuth) === realBefore, realBefore);
      } catch (error) {
        check("A13/A14：agentDir 贯通", false, error instanceof Error ? error.message : String(error));
      } finally {
        await c3?.dispose().catch(() => undefined);
        if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedEnv;
        if (savedRoot !== undefined) process.env.PI_CODING_AGENT_SESSION_DIR = savedRoot;
        fs.rmSync(c3Root, { recursive: true, force: true });
      }
    }

    // ------------------------------- 3. 清 key（A5 的 ②③，真 ModelRuntime + 真 auth.json）
    //
    // 夹具的 auth.json 里放一个**只在这里存在**的 provider：于是"清掉内存那把"之后
    // `getProviderAuthStatus` 会**回落到 `stored`**（S6-plan §10 第 2 轮 B1 的教训）——
    // 所以断言写的是 `source !== "runtime"`，不是 `configured === false`。
    {
      const a5Root = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-a5-"));
      const a5Agent = path.join(a5Root, "agent");
      fs.mkdirSync(a5Agent, { recursive: true });
      const probe = "jerrypi-a5-probe";
      const authFile = path.join(a5Agent, "auth.json");
      fs.writeFileSync(authFile, JSON.stringify({ [probe]: { type: "api_key", key: "sk-from-auth-json" } }), "utf8");
      const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const authBefore = sha(authFile);
      const mtimeBefore = fs.statSync(authFile).mtimeMs;

      let providers = [probe];
      const a5Keys = {
        listProviders: () => [...providers],
        getApiKey: async (id) => (id === probe ? "sk-from-secret-storage" : undefined),
        saveApiKey: async (id) => { providers = [...new Set([...providers, id])]; },
        removeApiKey: async (id) => { providers = providers.filter((p) => p !== id); },
      };
      try {
        await withoutCredentialEnv(async () => {
          const runtime = await getModelRuntime(pi, a5Agent, a5Keys);
          const before = runtime.getProviderAuthStatus(probe);
          check("A5 的前提：注入之后来源是 runtime（面板存的）",
            before.source === "runtime", JSON.stringify(before));

          const result = await clearStoredApiKeys([probe], { keys: a5Keys, runtime });
          check("A5：清掉这一个", result.ok.length === 1 && result.failed.length === 0, JSON.stringify(result));
          check("A5①：我们的 provider 列表空了", a5Keys.listProviders().length === 0, JSON.stringify(a5Keys.listProviders()));

          const after = runtime.getProviderAuthStatus(probe);
          check("A5②：不再有 runtime 来源（回落到 stored 是**正确**的 —— 凭据还在 auth.json 里）",
            after.source !== "runtime", JSON.stringify(after));

          check("A5③：auth.json 一个字节没变（sha256 + mtime）",
            sha(authFile) === authBefore && fs.statSync(authFile).mtimeMs === mtimeBefore,
            `${authBefore} → ${sha(authFile)}`);
        });
      } catch (error) {
        check("A5②③：清 key 的真 runtime 断言", false, error instanceof Error ? error.message : String(error));
      } finally {
        fs.rmSync(a5Root, { recursive: true, force: true });
      }
    }

    // ------------------------------- 4. 空凭据目录也能对话（C1，S6 第 5 步）
    //
    // 判据原文（PLAN §6 的 S6）：**清空 models.json 里的 key、只靠 SecretStorage 也能完成对话**。
    // 夹具要把「没有别的凭据来源」造齐：临时 agentDir 里没有 auth.json、models.json 里
    // 有 provider 但**没有 apiKey**，再把环境里的凭据变量清掉 —— 唯一一把 key 放在 SecretStorage 桩里。
    //
    // 为什么必须同时断言来源（评审 B2/B4）：只说「能对话」证明不了 key 来自 SecretStorage ——
    // `getProviderAuthStatus` 还有 `environment` / `models_json_key` 那些档，任一档顶上都会让
    // 这条假绿。所以「对话成功」与「source === runtime」要一起成立才有意义。
    {
      const a4Root = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-a4-"));
      const a4Agent = path.join(a4Root, "agent");
      const a4Cwd = path.join(a4Root, "cwd");
      const a4SessionsRoot = path.join(a4Root, "sessions");
      try {
        for (const dir of [a4Agent, a4Cwd, a4SessionsRoot]) fs.mkdirSync(dir, { recursive: true });

        // 用**面板实际选中的那个 provider**：它保证这轮真对话用的确实是本地有凭据的那家
        // （与夹具的 auth.json 同源，也走同一条选模型规则）。
        const provider = controller.snapshot().meta.provider;
        const realAuth = JSON.parse(fs.readFileSync(path.join(sourceAgentDir, "auth.json"), "utf8"));
        const entry = realAuth[provider];
        if (entry?.type !== "api_key" || typeof entry.key !== "string" || entry.key.length === 0) {
          console.log(
            `  skip A4：${sourceAgentDir}/auth.json 里的 ${provider} 不是 api_key 凭据（这条要把 key 放进 SecretStorage 桩，oauth 做不到）`,
          );
        } else {
          // 「有 provider 无 apiKey」的 models.json：贴着真实布局，挡住 models_json_key 那一档。
          // 没有这份文件时这条断言仍然成立（§6 A4 的 N4 注），所以存在才复制。
          const sourceModels = path.join(sourceAgentDir, "models.json");
          if (fs.existsSync(sourceModels)) fs.copyFileSync(sourceModels, path.join(a4Agent, "models.json"));

          await withoutCredentialEnv(async () => {
            const a4Keys = {
              listProviders: () => [provider],
              getApiKey: async (id) => (id === provider ? entry.key : undefined),
              saveApiKey: async () => {},
              removeApiKey: async () => {},
            };
            const a4Messages = [];
            const a4 = new SessionHostController({
              pi, cwd: a4Cwd, agentDir: a4Agent, sessionsRoot: a4SessionsRoot,
              keys: a4Keys, uiContext: createSelfTestUIContext(log), log,
              onMessage: (message) => a4Messages.push(message),
            });
            try {
              check("A4 的前提：夹具起点没有 auth.json（否则证明不了 key 来自 SecretStorage）",
                !fs.existsSync(path.join(a4Agent, "auth.json")), a4Agent);
              await a4.ensure();
              const runtime = await getModelRuntime(pi, a4Agent, a4Keys);
              const before = runtime.getProviderAuthStatus(provider);
              check("A4①：夹具起点没有 auth.json / models.json 里没有 key 时，来源被判定为 runtime（SecretStorage 那一档）",
                before.source === "runtime", JSON.stringify(before));

              await a4.prompt("Reply with the single word OK", "auto");
              const view = new View();
              for (const message of a4Messages) view.apply(message);
              const replies = view.byKind("assistant").map(textOf);
              const snapshot = a4.snapshot();
              // 不拿模型措辞当判据（同 §5 那两条）：要证的是「这一轮真跑完了」。
              check("A4②：只靠 SecretStorage 里那把 key 跑完了一轮真实对话",
                replies.length > 0 && replies.some((text) => text.length > 0) && snapshot.errorMessage === undefined,
                JSON.stringify({ replies: replies.map((text) => text.slice(0, 40)), errorMessage: snapshot.errorMessage }));
              // 断言的是「key 没落盘」，**不是**「auth.json 不存在」：pi 自己会在任何一次带锁的
              // 凭据读里惰性建一个空的 `{}`（`FileAuthStorageBackend.withLock` → `ensureFileExists`），
              // 这是 pi 的行为，不是我们写了凭据。真正要守的是那把 key 不进文件。
              const a4AuthFile = path.join(a4Agent, "auth.json");
              const authBytes = fs.existsSync(a4AuthFile) ? fs.readFileSync(a4AuthFile, "utf8") : "";
              const containsKey = authBytes.includes(entry.key);
              check("A4③：这一轮之后来源仍是 runtime，且那把 key 没有被写进 auth.json",
                runtime.getProviderAuthStatus(provider).source === "runtime" && !containsKey &&
                  (authBytes === "" || JSON.parse(authBytes)[provider] === undefined),
                JSON.stringify({ status: runtime.getProviderAuthStatus(provider), authFile: authBytes === "" ? "(不存在)" : `${authBytes.length}B`, containsKey }));
            } finally {
              await a4.dispose().catch(() => undefined);
            }
          });
        }
      } catch (error) {
        check("A4：空凭据目录 + SecretStorage 的一轮真对话", false, error instanceof Error ? error.message : String(error));
      } finally {
        fs.rmSync(a4Root, { recursive: true, force: true });
      }
    }

    // ------------------------------------------- 9. CLI 互通（G3 的核心，由**我**跑）
    //
    // S5 的 U5：这一项原来是要用户手动跑一条命令的（受限机没有 pi）。改成自动化 ——
    // 但它要真模型与用户终端那份 pi，所以不进 CI，仍然只能在这个脚本里跑。
    //
    // 判据不是"模型回了什么"（那会抖），而是**那个会话文件有没有被 CLI 继续写** ——
    // 文件长大 = CLI 真的找到了、并用了**我们的**会话，与模型措辞无关。
    {
      const piExe = findOnPath("pi");
      if (piExe === undefined) {
        console.log("  skip CLI 互通：PATH 上没有 pi（受限机/CI 就是这样）");
      } else {
        // 用**临时 cwd + 用户真实的 agentDir**：这样会话落在 CLI 默认会去找的那个目录树里，
        // 而且写入走的是我们的生产路径（controller → SessionManager）。
        const interopCwd = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-interop-"));
        const realRoot = path.join(pi.getAgentDir(), "sessions");
        const interloper = new SessionHostController({
          pi,
          cwd: interopCwd,
          agentDir: pi.getAgentDir(),
          sessionsRoot: realRoot,
          keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
          uiContext: createSelfTestUIContext(log),
          log,
          onMessage: () => {},
        });
        let interopDir = "";
        try {
          await interloper.ensure();
          await interloper.prompt("Reply with exactly the word PONG", "auto");
          const file = interloper.session?.sessionManager?.getSessionFile() ?? "";
          interopDir = path.dirname(file);
          const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
          // `-c` = 继续这个 cwd 最近被写过的那次会话（与用户在终端里敲的一模一样）
          const run = spawnSync(piExe, ["-c", "-p", "Reply with exactly the word PONG"], {
            cwd: interopCwd,
            encoding: "utf8",
            timeout: 180_000,
          });
          const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
          check(
            "CLI 能用 `pi -c` 接过我们写的会话（它把新的一轮追加进了**同一个文件**）",
            run.status === 0 && after > before,
            `exit=${run.status}｜文件条目 ${before} → ${after}｜stdout=${String(run.stdout ?? "").trim().slice(0, 60)}｜stderr=${String(run.stderr ?? "").trim().slice(0, 80)}`,
          );
        } catch (error) {
          check("CLI 能用 `pi -c` 接过我们写的会话", false, error instanceof Error ? error.message : String(error));
        } finally {
          await interloper.dispose().catch(() => undefined);
          // 收尾：只删我们自己建的那个编码目录（带"必须在 sessions 根之下"的守卫）
          const root = path.resolve(realRoot);
          if (interopDir !== "" && path.resolve(interopDir).startsWith(root + path.sep)) {
            fs.rmSync(interopDir, { recursive: true, force: true });
          }
          fs.rmSync(interopCwd, { recursive: true, force: true });
        }
      }
    }
    // ------------------------------- S7 A7：同一条消息里两次 edit + 两次 write 同一文件
    //
    // PLAN 的验收在自动化里的形态：两处改动必须**各自成卡**（不是并集、不是"当前磁盘 vs
    // 首次原文"），两次 write 的前后必须**接得上**。
    //
    // 话术按第 2 轮评审 S5 的提醒设计：pi 的 edit 指南明写"同一文件的多处改动用一次调用的
    // 多个 entries"，直说"分两次改"是在跟系统提示对着干 —— 所以让第二次 edit 的 oldText
    // **只有在第一次生效后才存在**（STAGE-2 → STAGE-3，再 STAGE-3 → STAGE-4），并要求
    // 每步单独调用。
    {
      const a7Target = path.join(cwd, "a7-note.txt");
      const beforeItems = controller.snapshot().items.length;
      await controller.prompt(
        [
          "请分四步完成，每一步都用**单独一次**工具调用（不要合并、不要用 bash）：",
          `1. write：把 ${a7Target} 的内容写成两行 STAGE-1 和 tail`,
          `2. write：把同一个文件的内容写成两行 STAGE-2 和 tail`,
          "3. edit：把文件里的 STAGE-2 改成 STAGE-3",
          "4. edit：**再单独调用一次**，把文件里的 STAGE-3 改成 STAGE-4",
        ].join("\n"),
        "auto",
      );
      const items = controller.snapshot().items.slice(beforeItems).filter((item) => item.kind === "tool");
      const edits = items.filter((item) => item.toolName === "edit");
      const writes = items.filter((item) => item.toolName === "write");
      if (edits.length < 2 || writes.length < 2) {
        console.log(
          `      · SKIP：模型这次没有按"四步各自一次调用"执行（edit=${edits.length} write=${writes.length}）—— 本节断言跳过；` +
            "判定依据是工具调用条数，不是模型措辞",
        );
      } else {
        const editRecords = edits.map((item) => controller.diffStore.get(item.toolCallId));
        const writeRecords = writes.map((item) => controller.diffStore.get(item.toolCallId));
        check(
          "A7：两张 edit 卡片都有可打开的 patch",
          editRecords.every((record) => record?.kind === "patch"),
          JSON.stringify(editRecords.map((record) => record?.kind)),
        );
        check(
          "A7：两张 write 卡片都有快照",
          writeRecords.every((record) => record?.kind === "snapshot"),
          JSON.stringify(writeRecords.map((record) => record?.kind)),
        );
        const [p1, p2] = editRecords;
        // 判据要小心：**每个 patch 本来就会同时含自己那次的旧文本与新文本**（`-旧`/`+新`），
        // 所以"不含对方"才是关键 —— 第一版写成"p1 不含 STAGE-3"是错的（那正是 p1 的新文本）。
        check(
          "A7：两次 edit 的 patch 各自只含自己那次（不是并集、不是累积）",
          p1?.kind === "patch" &&
            p2?.kind === "patch" &&
            p1.patch.includes("STAGE-2") &&
            p1.patch.includes("STAGE-3") &&
            !p1.patch.includes("STAGE-4") &&
            p2.patch.includes("STAGE-3") &&
            p2.patch.includes("STAGE-4") &&
            !p2.patch.includes("STAGE-2"),
          JSON.stringify([p1?.patch?.slice(0, 120), p2?.patch?.slice(0, 120)]),
        );
        check(
          "A7：两次 edit 的 toolCallId 不同（各自成卡）",
          edits[0].toolCallId !== edits[1].toolCallId,
          JSON.stringify(edits.map((item) => item.toolCallId)),
        );
        const [w1, w2] = writeRecords;
        check(
          "A7：第二次 write 的 before 正是第一次 write 的 after（队列内读盘）",
          w1?.kind === "snapshot" && w2?.kind === "snapshot" && w2.before === w1.after,
          JSON.stringify([w1?.after, w2?.before]),
        );
        check(
          "A7：卡片上的 diff 字段与 store 一致（协议那一层也接上了）",
          edits.every((item) => item.diff === "patch") && writes.every((item) => item.diff === "snapshot"),
          JSON.stringify([edits.map((item) => item.diff), writes.map((item) => item.diff)]),
        );
      }
    }
  } finally {
    await controller.dispose().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // ------------------------------- A12 漂移守卫（S6 第 6 步，fetch 层）
  //
  // 正向：上面那一整套流程（建会话、发消息、切会话、换模型、清 key、CLI 互通）里**没有一次**
  // 请求打到 pi.dev。不能靠"包一层 runtime.refresh 数调用次数"—— 那是恒真断言（评审第 2 轮 B2）。
  const piDevHosts = fetchHosts.filter((host) => host === "pi.dev" || host.endsWith(".pi.dev"));
  check(
    "A12 正向：完整流程里没有任何请求打到 pi.dev",
    piDevHosts.length === 0,
    `hosts=${[...new Set(fetchHosts)].sort().join(", ") || "(无)"}`,
  );

  // 反向：显式刷新必须真打到 pi.dev —— 证明探针是活的（否则上面那条可能是恒绿）。
  // 前提：`modelNetworkEnabled = process.env.PI_OFFLINE === undefined`（model-runtime.js:88），
  // 设了 PI_OFFLINE 的环境里 refresh 不联网 —— 那时只能 SKIP，且要说清原因（不是静默跳过）。
  if (process.env.PI_OFFLINE !== undefined) {
    console.log("  skip A12 反向：PI_OFFLINE 已设，refresh 不会联网（这是推导值，见 S6-plan §3.5）");
  } else {
    // 每次跑用**全新的 agentDir**（= 全新的 models-store.json）：否则 checkedAt 未满 4 小时时
    // pi 会直接 return、根本不发请求 → 第二次运行就假红（评审第 4 轮 S2）。
    // 还要**有凭据**：`models.refresh` 对没有凭据的 provider 在联网前就 return
    // （`pi-ai/dist/models.js:150-155` 的 `if (!credential) return`）—— 空目录里的第一次实测
    // 是"0 次 fetch"，不是探针坏了。
    const a12Root = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-a12-"));
    const a12Agent = path.join(a12Root, "agent");
    fs.mkdirSync(a12Agent, { recursive: true });
    fs.copyFileSync(path.join(sourceAgentDir, "auth.json"), path.join(a12Agent, "auth.json"));
    try {
      const runtime = await getModelRuntime(pi, a12Agent, {
        listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {}, removeApiKey: async () => {},
      });
      const before = fetchHosts.length;
      const result = await refreshModelCatalog(runtime);
      const newHosts = [...new Set(fetchHosts.slice(before))];
      check(
        "A12 反向：点一次刷新 → 探针真的看到 pi.dev",
        newHosts.some((host) => host === "pi.dev" || host.endsWith(".pi.dev")),
        `新增 hosts=${newHosts.slice(0, 5).join(", ") || "(无)"}；provider ${result.providersBefore}→${result.providersAfter}；errors=${result.errors.length}`,
      );
    } catch (error) {
      check("A12 反向：点一次刷新 → 探针真的看到 pi.dev", false, error instanceof Error ? error.message : String(error));
    } finally {
      fs.rmSync(a12Root, { recursive: true, force: true });
    }
  }

  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (ok) console.log(`  ok   ${name}`);
    else {
      failed += 1;
      console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  }
  console.log(`CONTROLLER-CHECK ${failed === 0 ? "OK" : "FAILED"} (${results.length - failed}/${results.length})`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main().catch((error) => {
  console.error(`CONTROLLER-CHECK ERROR ${error?.stack ?? error}`);
  return 1;
}));
