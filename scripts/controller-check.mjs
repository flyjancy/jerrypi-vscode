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

    // ---------------------------------------------------- 2b. 工具卡片的流式输出（S3）
    //
    // 这一组每一条都对应 S3-plan §0.2 里一条"反直觉"的事实，或评审抓到的一个洞。
    messages.length = 0;
    const streamedSnapshots = [];
    let streamBytes = 0;
    let streamFrames = 0;
    // 用一个独立的控制器实例，理由：这一组要单独量测消息帧数与字节数。
    const streamController = new SessionHostController({
      pi, cwd, agentDir, sessionsDir,
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
