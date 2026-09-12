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
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const results = [];
const check = (name, ok, detail = "") => results.push([name, ok, detail]);

function agentDirOf(pi) {
  return process.env.PI_CODING_AGENT_DIR ?? pi.getAgentDir();
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
  const { SessionHostController, createSelfTestUIContext, loadPi } = await loadModules(tempDir);
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
  const sessionsDir = path.join(root, "sessions");
  const cwd = path.join(root, "cwd");
  for (const dir of [agentDir, sessionsDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(sourceAgentDir, "auth.json"), path.join(agentDir, "auth.json"));

  const log = { appendLine: () => {} };
  const messages = [];
  let controllerRef;
  let snapshotDuringStream;
  let deltasSeen = 0;
  let deltasAfterSnapshot = 0;
  let liveIdAtFirstDelta = "";

  const controller = new SessionHostController({
    pi,
    cwd,
    agentDir,
    sessionsDir,
    keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
    uiContext: createSelfTestUIContext(log),
    log,
    additionalExtensionPaths: [path.join(REPO_ROOT, "test-fixtures", "ext-smoke", "index.ts")],
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

    // ---------------------------------------------------- 1. 一轮对话 + 流式中重开面板
    messages.length = 0;
    deltasSeen = 0;
    deltasAfterSnapshot = 0;
    snapshotDuringStream = undefined;
    liveIdAtFirstDelta = "";
    await controller.prompt("请写一段 150 字左右的中文介绍，主题是海洋。", "auto");
    const view = collect();
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
    void controller.prompt("排队一", "followUp");
    void controller.prompt("排队二", "steer");
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 关键回归：入队也必须回一个"已接受"，否则前端会把用户的下一条消息卡住
    // （实测现象：队列里有一条时，第二条点「排队」毫无反应）。
    check("steer/followUp 入队后收到 promptAccepted",
      messages.filter((m) => m.type === "promptAccepted").length >= 2,
      String(messages.filter((m) => m.type === "promptAccepted").length));
    const queued = controller.snapshot().queue;
    check("排队后快照里能看到两条（steering + followUp）",
      queued.steering.length === 1 && queued.followUp.length === 1, JSON.stringify(queued));
    await controller.abort();
    await long.catch(() => {});
    const restored = messages.filter((m) => m.type === "restoreComposer").map((m) => m.text);
    check("中止后被清掉的排队文本退回输入框（D9 回归）",
      restored.join("|").includes("排队一") && restored.join("|").includes("排队二"), JSON.stringify(restored));
    const lastQueue = messages.filter((m) => m.type === "queue").pop();
    check("中止后队列条清空",
      lastQueue !== undefined && lastQueue.steering.length === 0 && lastQueue.followUp.length === 0,
      JSON.stringify(lastQueue));
    const busyAfterAbort = messages.filter((m) => m.type === "busy").map((m) => m.busy);
    check("中止后 busy 回到 false", busyAfterAbort[busyAfterAbort.length - 1] === false, busyAfterAbort.join("->"));

    messages.length = 0;
    await controller.prompt("Reply with exactly: OK", "auto");
    check("中止后会话仍可用", collect().byKind("assistant").some((i) => textOf(i).toUpperCase().includes("OK")));

    // ---------------------------------------------------- 4. 扩展命令不卡 busy
    messages.length = 0;
    await controller.prompt("/smoke", "auto");
    const smokeBusy = messages.filter((m) => m.type === "busy").map((m) => m.busy);
    check("扩展命令后 busy 被解除（N2 回归）",
      smokeBusy.length > 0 && smokeBusy[smokeBusy.length - 1] === false, smokeBusy.join("->"));

    // ---------------------------------------------------- 5. 新会话
    const before = controller.snapshot().items.length;
    await controller.newSession();
    check("newSession 后历史清空", controller.snapshot().items.length === 0 && before > 0);

    // ---------------------------------------------------- 6. 面板的模型策略
    // 6a：临时 agentDir 里**没有** settings.json → 用户没选过 → 用我们的偏好兜底
    check("用户没选过模型时，兜底到便宜的 flash（不用 pro）",
      controller.snapshot().model === "deepseek/deepseek-v4-flash", controller.snapshot().model);

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
        pi, cwd, agentDir: agentDir2, sessionsDir: path.join(root, "sessions2"),
        keys: { listProviders: () => [], getApiKey: async () => undefined, saveApiKey: async () => {} },
        uiContext: createSelfTestUIContext(log),
        log,
        onMessage: () => {},
      });
      try {
        await second.ensure();
        const picked = second.snapshot().model;
        check("用户选过模型时，面板不覆盖（跟着 pi 设置走）",
          picked === "deepseek/deepseek-v4-flash-vision-exp", picked);
        // 再换一个会话：新会话同样要保住用户的选择
        await second.newSession();
        check("新会话之后仍然保住用户的选择",
          second.snapshot().model === "deepseek/deepseek-v4-flash-vision-exp", second.snapshot().model);
      } finally {
        await second.dispose().catch(() => {});
      }
    }
  } finally {
    await controller.dispose().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
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
