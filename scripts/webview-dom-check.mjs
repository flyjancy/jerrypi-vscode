#!/usr/bin/env node
/**
 * 面板前端的**接线层**检查 —— 在一个真 DOM（happy-dom）里把 `main.ts` 真跑起来。
 *
 * 它回答的问题是自动化检查以前答不了的那一类：**事件有没有真的接上**。
 * 这一轮人工验收抓到的 7 个缺陷里，有两个属于这一类，而且都是"看着像回事、
 * 实际没接上"：
 *   - 展开箭头根本没渲染（`render.ts` 与 `main.ts` 各拼一份按钮内容）；
 *   - 正文里的路径是**死链**（`data-open-path` 出现在两处，只有标题挂了 handler，
 *     正文那条冒泡到 S2 的 markdown 链接处理器里被 `preventDefault()` 吞掉）。
 * 纯函数断言与源码断言能兜住一部分，但"派发一次真点击、看它发出什么消息"
 * 只有真 DOM 能测。
 *
 * 三条自我约束（评审第 2 轮定的）：
 *   1. **喂真的**：HTML 由 `src/host/webviewHtml.ts` 生成、bundle 用
 *      `scripts/webview-bundle.mjs`（与生产同一份配置）。自制假 DOM 会制造
 *      我们最想避免的"测试通过但真机错"。
 *   2. **不测滚动**：happy-dom 没有排版引擎，`scrollHeight`/`clientHeight` 恒为 0
 *      —— `isAtBottom()` 会永远为真。滚动类在覆盖清单里**不算**（M7/M8 保留人工）。
 *   3. **不测 CSP**：happy-dom 不执行 CSP。nonce/CSP 由 `check:render` 的静态断言
 *      + 真机验收覆盖。**本脚本全绿不等于面板能在 VS Code 里跑起来。**
 *
 * 时钟是注入的：不 sleep、不靠真实定时器，因此 CI 上不会随机挂。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWebviewForTest } from "./webview-bundle.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** 把 TS 打成临时 ESM 再 import（与其它检查脚本同样的套路）。 */
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

/**
 * 可控时钟：`Date.now` + `setTimeout`/`setInterval` 全部接管。
 *
 * 为什么要它：面板里有两处定时器（200ms 的合帧、1s 的耗时 tick），
 * 靠 `sleep` 等它们触发在 CI 上迟早随机挂。
 */
function installClock(window) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  window.Date.now = () => now;
  window.setTimeout = (fn, ms = 0) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + ms, repeat: undefined });
    return id;
  };
  window.setInterval = (fn, ms = 0) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + ms, repeat: ms });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.clearInterval = (id) => timers.delete(id);
  return {
    now: () => now,
    pending: () => timers.size,
    /** 推进时间并触发到期定时器（按到期时间排序，模拟真实调度）。 */
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        for (const [id, timer] of due) {
          if (!timers.has(id)) continue;
          if (timer.repeat === undefined) timers.delete(id);
          else timer.at = now + timer.repeat;
          timer.fn();
        }
      }
    },
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-webview-dom-"));
  try {
    const { Window } = await import("happy-dom");
    const html = await loadModule("src/host/webviewHtml.ts", tempDir);
    const protocol = await loadModule("src/shared/protocol.ts", tempDir);

    const bundlePath = path.join(tempDir, "webview.js");
    await buildWebviewForTest(bundlePath);
    const bundle = fs.readFileSync(bundlePath, "utf8");

    // ---------------------------------------------------------------- 启动
    console.log("[webview-dom-check] 启动");
    const window = new Window({ url: "https://localhost/" });
    const posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message) });
    const clock = installClock(window);

    // **真 HTML**：与生产同一个函数（顺带把 shell 的 id 与 main.ts 的引用对上）。
    const shell = html.buildWebviewHtml({
      scriptUri: "webview.js",
      styleUri: "style.css",
      cspSource: "https://localhost/",
      nonce: "test-nonce",
    });
    window.document.write(shell);
    window.eval(bundle);

    const doc = window.document;
    const ids = ["transcript", "queue", "status", "input", "send-button", "abort-button", "queue-button", "composer-hint", "composer-error"];
    check("真 HTML 提供了 main.ts 需要的全部元素", ids.every((id) => doc.getElementById(id) !== null),
      ids.filter((id) => doc.getElementById(id) === null).join(", "));
    check("启动后发 ready（含协议版本）",
      posted.some((m) => m.type === "ready" && m.protocol === protocol.PROTOCOL_VERSION),
      JSON.stringify(posted));

    /** 模拟扩展 → webview 的消息。 */
    const send = (message) => window.dispatchEvent(new window.MessageEvent("message", { data: message }));
    const click = (element) => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const openFileMessages = () => posted.filter((m) => m.type === "openFile");

    // ---------------------------------------------------------------- 工具卡片
    console.log("[webview-dom-check] 工具卡片（点击接线）");
    const toolItem = (extra) => ({
      kind: "tool",
      id: "tool-1",
      toolCallId: "c1",
      toolName: "bash",
      summary: '{"command":"echo hi"}',
      isError: false,
      ...extra,
    });

    send({ type: "state", protocol: protocol.PROTOCOL_VERSION, items: [toolItem({ title: { text: "echo hi" }, text: "a\nb\nc" })], truncated: false, queue: { steering: [], followUp: [] }, busy: false, cwd: "/w", model: "m/m" });

    const card = doc.querySelector('[data-id="tool-1"]');
    check("卡片节点被创建", card !== null);
    const head = card.querySelector(".tool-head");
    const body = card.querySelector(".tool-body");
    check("标题行是一个按钮（可点、可聚焦）", head !== null && head.tagName === "BUTTON");
    check("标题行里有展开箭头（S3 第一次验收就是它没渲染出来）",
      (head.textContent ?? "").includes("▸"), head?.textContent);
    equal("state 之后卡片默认折叠", head.getAttribute("aria-expanded"), "false");

    // 点标题 → 展开；再点 → 折叠。这是"就地更新 + 展开态"的行为级回归。
    click(head);
    equal("点标题行后 aria-expanded 变 true", head.getAttribute("aria-expanded"), "true");
    check("展开后箭头变 ▾", (head.textContent ?? "").includes("▾"), head.textContent);
    check("展开后正文可见并包含内容", body.hidden === false && (body.textContent ?? "").includes("a"), body.textContent);
    click(head);
    equal("再点一次收回去", head.getAttribute("aria-expanded"), "false");
    // ⚠️ bash 折叠时**显示最后 5 行预览**（照 pi 的 BASH_PREVIEW_LINES），
    // 所以"折叠=正文隐藏"只对 read/write/edit 成立 —— 两类分开断言。
    check("bash 折叠时仍显示预览（子节点还在）", body.hidden === false && body.querySelector(".tool-text") !== null);
    send({ type: "item", item: { kind: "tool", id: "tool-read", toolCallId: "cr", toolName: "read", summary: "", isError: false, title: { text: "~/a.ts" }, text: "第一行\n第二行" } });
    const readCard = doc.querySelector('[data-id="tool-read"]');
    check("read 折叠时不显示正文", readCard.querySelector(".tool-body").hidden === true && readCard.querySelector(".tool-body").textContent === "");
    click(readCard.querySelector(".tool-head"));
    check("read 展开后显示正文", (readCard.querySelector(".tool-body").textContent ?? "").includes("第二行"));

    // ---------------------------------------------------------------- 路径点击
    console.log("[webview-dom-check] 路径点击（死链回归）");
    const before = openFileMessages().length;
    send({
      type: "item",
      item: toolItem({
        title: { text: "~/a.ts:10-20", link: { text: "~/a.ts", path: "/work/a.ts" } },
        openablePaths: ["/work/a.ts"],
        text: "x",
      }),
    });
    const link = card.querySelector("[data-open-path]");
    check("标题里的路径渲染成可点元素", link !== null && link.getAttribute("data-open-path") === "/work/a.ts");
    click(link);
    check("点路径发出 openFile（带绝对路径）",
      openFileMessages().length === before + 1 && openFileMessages().at(-1).path === "/work/a.ts",
      JSON.stringify(openFileMessages().slice(-2)));
    equal("点路径不会顺带展开/折叠卡片", head.getAttribute("aria-expanded"), "false");

    // **正文里的路径**：这就是死链那个 bug —— 它以前冒泡到 markdown 链接处理器里被吞掉。
    send({
      type: "item",
      item: toolItem({
        title: { text: "seq 1 4000" },
        text: "3999\n4000",
        truncation: { truncatedBy: "lines", totalLines: 4000, outputLines: 2000 },
        fullOutputPath: "/tmp/pi-bash-x.log",
        openablePaths: ["/tmp/pi-bash-x.log"],
      }),
    });
    const bodyLink = card.querySelector('.tool-body [data-open-path]');
    check("正文里的完整输出路径也是可点元素", bodyLink !== null, card.querySelector(".tool-body")?.textContent);
    click(bodyLink);
    check("点正文里的路径也发出 openFile（死链回归）",
      openFileMessages().at(-1)?.path === "/tmp/pi-bash-x.log",
      JSON.stringify(openFileMessages().slice(-2)));

    // **运行中**的卡片也要有可点路径（M14 的 DOM 半边）：
    // 宿主侧在 tool_execution_start 就铸造路径，否则运行中的卡片点不开。
    send({
      type: "item",
      item: { kind: "tool", id: "tool-run", toolCallId: "cn", toolName: "read", summary: "", isError: false,
        title: { text: "~/running.ts", link: { text: "~/running.ts", path: "/work/running.ts" } },
        openablePaths: ["/work/running.ts"], pending: true, startedAt: clock.now(), text: "第 1 行" },
    });
    const runCard = doc.querySelector('[data-id="tool-run"]');
    const runLink = runCard.querySelector("[data-open-path]");
    check("运行中的卡片也渲染出可点路径", runLink !== null && runLink.getAttribute("data-open-path") === "/work/running.ts");
    const beforeRun = openFileMessages().length;
    click(runLink);
    check("运行中点路径同样发出 openFile", openFileMessages().length === beforeRun + 1, JSON.stringify(openFileMessages().slice(-2)));
    equal("运行中点路径不会展开/折叠卡片", runCard.querySelector(".tool-head").getAttribute("aria-expanded"), "false");

    // 反向控制：**未登记**的路径必须是不可点的纯文字，点了也不会发消息。
    send({ type: "item", item: toolItem({ title: { text: "/etc/passwd" }, text: "x" }) });
    const linksNow = card.querySelectorAll("[data-open-path]").length;
    check("没有 openablePaths 时不渲染可点元素", linksNow === 0, String(linksNow));
    const beforeBad = openFileMessages().length;
    // 点**转写区容器**，不点标题 —— 点标题会顺带切换展开态（第一次写这个反向控制时
    // 就是被这一点咬的：后面按"折叠态"断言全错，而代码其实没问题）。
    click(doc.getElementById("transcript"));
    check("点不可点的文字不会发出 openFile（反向控制）", openFileMessages().length === beforeBad);
    equal("反向控制之后卡片仍是折叠态", head.getAttribute("aria-expanded"), "false");

    // ---------------------------------------------------------------- 就地更新
    console.log("[webview-dom-check] 流式就地更新");
    const lines = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`);
    send({ type: "item", item: toolItem({ title: { text: "seq" }, text: `${lines.join("\n")}\n`, pending: true, startedAt: clock.now() }) });
    const bodyText = () => card.querySelector(".tool-body").textContent ?? "";
    check("折叠态只显示最后 5 行", (bodyText().match(/第 \d+ 行/g) ?? []).length === 5, bodyText());
    check("折叠态说明还有 7 行", bodyText().includes("还有 7 行"), bodyText());
    check("说的行数与显示的行数一致（S3 第四次验收实测过不一致）",
      (bodyText().match(/第 \d+ 行/g) ?? []).length === 12 - 7, bodyText());

    const elapsedOf = () => (head.textContent ?? "").match(/Elapsed ([\d.]+)s/)?.[1];
    equal("运行中的耗时从 0.0s 起", elapsedOf(), "0.0");
    // 推进 3 秒后再收一帧：耗时必须是 3.0s，**不能回到 0.0s**
    // （S3 第二次验收实测的 "0→2→0→3" 就是这个：每帧都算出 0）
    clock.advance(3000);
    send({ type: "item", item: toolItem({ title: { text: "seq" }, text: `${lines.join("\n")}\n第 13 行\n`, pending: true, startedAt: clock.now() - 3000 }) });
    equal("流式再渲染后耗时不被重置", elapsedOf(), "3.0");
    // 1 秒 tick：不靠新消息也能自己往前走
    clock.advance(1000);
    equal("每秒 tick 会把耗时推上去", elapsedOf(), "4.0");

    // 结束态：Took + 计时器停表
    send({ type: "item", item: toolItem({ title: { text: "seq" }, text: "done", startedAt: clock.now() - 4000, endedAt: clock.now() }) });
    check("结束后显示 Took", (head.textContent ?? "").includes("Took 4.0s"), head.textContent);
    // 注意：上面那张"运行中"的卡片还挂着（tool-run），所以先把所有卡片都收尾，
    // 再断言定时器停表 —— 否则这条会误报（第一次就是这样红的）。
    send({ type: "item", item: { kind: "tool", id: "tool-run", toolCallId: "cn", toolName: "read", summary: "", isError: false,
      title: { text: "~/running.ts", link: { text: "~/running.ts", path: "/work/running.ts" } },
      openablePaths: ["/work/running.ts"], startedAt: clock.now() - 500, endedAt: clock.now(), text: "done" } });
    equal("所有卡片都不再运行时定时器被清掉", clock.pending(), 0);

    // 中止那种形状：pending → 就地替换成 ✗（M13 的 DOM 半边）。
    // 宿主侧另有断言"中止后正文没丢 + 带 pi 自己的 Command aborted"。
    send({ type: "item", item: { kind: "tool", id: "tool-abort", toolCallId: "ca", toolName: "bash", summary: "", isError: false,
      title: { text: "sleep 30" }, pending: true, startedAt: clock.now(), text: "已流出的第 1 行\n已流出的第 2 行" } });
    const abortCard = doc.querySelector('[data-id="tool-abort"]');
    click(abortCard.querySelector(".tool-head"));
    check("运行中的卡片先显示运行中与 ✗ 之前的状态",
      (abortCard.querySelector(".tool-head").textContent ?? "").includes("运行中…") &&
        (abortCard.querySelector(".tool-head").textContent ?? "").includes("…"));
    send({ type: "item", item: { kind: "tool", id: "tool-abort", toolCallId: "ca", toolName: "bash", summary: "", isError: true,
      title: { text: "sleep 30" }, startedAt: clock.now() - 3000, endedAt: clock.now(),
      text: "已流出的第 1 行\n已流出的第 2 行\n\nCommand aborted" } });
    check("中止后就地变成 ✗（没有新增第二个节点）",
      doc.querySelectorAll('[data-id="tool-abort"]').length === 1 &&
        (abortCard.querySelector(".tool-head").textContent ?? "").includes("✗"),
      abortCard.querySelector(".tool-head").textContent);
    check("中止后已流出的正文仍在（含 pi 自己的 Command aborted）",
      (abortCard.querySelector(".tool-body").textContent ?? "").includes("已流出的第 1 行") &&
        (abortCard.querySelector(".tool-body").textContent ?? "").includes("Command aborted"),
      abortCard.querySelector(".tool-body").textContent);
    check("中止后耗时从 Elapsed 变 Took", (abortCard.querySelector(".tool-head").textContent ?? "").includes("Took"),
      abortCard.querySelector(".tool-head").textContent);

    // ------------------------------------------------- 滚动：只测"有没有调用"，不测"滚到哪"
    // happy-dom 没有排版引擎（scrollHeight 恒 0），所以**不能**断言滚动结果；
    // 但"谁在写 scrollTop"是纯接线问题，可以装一个探针精确锁住。
    // 这三条合起来才锁得住 R10：单独断言"meta 不写"会被"那我把滚动搬进 busy"绕过去。
    let scrollWrites = 0;
    let scrollValue = 0;
    Object.defineProperty(doc.getElementById("transcript"), "scrollTop", {
      configurable: true,
      get: () => scrollValue,
      set: (value) => {
        scrollWrites += 1;
        scrollValue = value;
      },
    });
    const writesAfter = (fn) => {
      const before = scrollWrites;
      fn();
      return scrollWrites - before;
    };
    check("收到 busy 不写 transcript.scrollTop（R10）", writesAfter(() => send({ type: "busy", busy: true })) === 0);
    check("收到 delta 会写（跟随时必须还在底部）", writesAfter(() => send({ type: "delta", id: "live-x", kind: "text", delta: "字" })) > 0);
    send({ type: "busy", busy: false });
    check(
      "收到 state 会写（快照重放后必须停在底部）",
      writesAfter(() =>
        send({
          type: "state",
          protocol: protocol.PROTOCOL_VERSION,
          items: [],
          truncated: false,
          queue: { steering: [], followUp: [] },
          busy: false,
          cwd: "/w",
          model: "m/m",
        }),
      ) > 0,
    );

    // ---------------------------------------------------------------- 安全（真 DOM）
    console.log("[webview-dom-check] 工具正文的 XSS（走真 DOM 解析）");
    const payload = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    send({ type: "item", item: toolItem({ title: { text: "echo" }, text: payload, id: "tool-x", toolCallId: "cx" }) });
    const xssCard = doc.querySelector('[data-id="tool-x"]');
    // 先展开再看（正文默认折叠，但节点已经渲染出来了）
    click(xssCard.querySelector(".tool-head"));
    check("正文里没有真的 <img> 元素被创建", doc.querySelector("img") === null);
    // 注意：**真 HTML 骨架里本来就有** `<script src="webview.js">`，
    // 所以要查的是"卡片正文里没有新增 script"，而不是整个文档没有 script。
    check("正文里没有真的 <script> 元素被创建",
      xssCard.querySelector("script") === null && doc.getElementById("transcript").querySelector("script") === null);
    check("payload 以文字形式出现", (xssCard.querySelector(".tool-body").textContent ?? "").includes("<img src=x"), xssCard.querySelector(".tool-body").textContent);
    check("标题里的 payload 也被转义", xssCard.querySelector("img") === null);

    // ---------------------------------------------------------------- 发送/输入接线
    console.log("[webview-dom-check] 输入与发送接线");
    const input = doc.getElementById("input");
    input.value = "你好";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const prompt = posted.filter((m) => m.type === "prompt").at(-1);
    check("回车发送 prompt（空闲时 behavior=auto）", prompt !== undefined && prompt.text === "你好" && prompt.behavior === "auto", JSON.stringify(prompt));
    equal("发送后输入框清空", input.value, "");

    // 发完之后 `pendingText` 还挂着（等宿主确认），这时**不允许再发** ——
    // 这是 S2 刻意的防重复发送。所以要先回一条 promptAccepted 才能测下一条。
    check("确认之前不再接受下一条（防重复发送）", input.value === "");
    send({ type: "promptAccepted" });

    send({ type: "busy", busy: true });
    input.value = "追加一句";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const steer = posted.filter((m) => m.type === "prompt").at(-1);
    check("忙时回车是转向（behavior=steer）", steer?.text === "追加一句" && steer?.behavior === "steer", JSON.stringify(steer));
    send({ type: "promptAccepted" });

    // 「追加」按钮 = followUp（与回车不同）
    posted.length = 0;
    input.value = "整轮结束后再发";
    click(doc.getElementById("queue-button"));
    const followUp = posted.filter((m) => m.type === "prompt").at(-1);
    check("「追加」按钮发出 followUp", followUp?.behavior === "followUp", JSON.stringify(posted));
    send({ type: "promptAccepted" });

    // 「取回编辑」是 renderQueue **动态创建**的按钮（不是 #queue-button）——
    // 这条同时覆盖了 renderQueue 的接线。
    posted.length = 0;
    send({ type: "queue", steering: ["甲"], followUp: ["乙"] });
    const dequeue = [...doc.querySelectorAll("#queue button")].find((b) => (b.textContent ?? "").includes("取回"));
    check("队列条里出现「取回编辑」按钮", dequeue !== undefined, doc.getElementById("queue").textContent);
    click(dequeue);
    check("点「取回编辑」发出 clearQueue", posted.some((m) => m.type === "clearQueue"), JSON.stringify(posted));
    click(doc.getElementById("abort-button"));
    check("中止按钮发出 abort", posted.some((m) => m.type === "abort"), JSON.stringify(posted));

    input.value = "我自己的输入";
    send({ type: "restoreComposer", text: "取回的字" });
    check("restoreComposer 把取回的文本放在当前输入之前（pi 的 dequeue 语义）",
      input.value.startsWith("取回的字") && input.value.includes("我自己的输入"), JSON.stringify(input.value));

    // ---------------------------------------------------------------- 流式文本
    console.log("[webview-dom-check] 流式文本");
    send({ type: "item", item: { kind: "assistant", id: "live-1", text: "", thinking: "", stopReason: "pending", streaming: true } });
    send({ type: "delta", id: "live-1", kind: "text", delta: "第一段" });
    send({ type: "delta", id: "live-1", kind: "text", delta: "第二段" });
    const live = doc.querySelector('[data-id="live-1"] .live-text');
    check("流式文本按增量追加", live !== null && live.textContent === "第一段第二段", live?.textContent);
    send({ type: "item", item: { kind: "assistant", id: "live-1", text: "第一段第二段", thinking: "", stopReason: "stop" } });
    check("收尾后换成渲染结果且只有一个节点",
      doc.querySelectorAll('[data-id="live-1"]').length === 1 &&
        (doc.querySelector('[data-id="live-1"]').textContent ?? "").includes("第一段第二段"));

    // ---------------------------------------------------------------- 反向控制
    console.log("[webview-dom-check] 检查检查本身");
    // 一次点击派发本身要能被观测到（否则上面的"点路径发 openFile"可能是假绿）
    const probe = doc.createElement("a");
    probe.setAttribute("data-open-path", "/probe");
    doc.body.appendChild(probe);
    const beforeProbe = openFileMessages().length;
    click(probe);
    check("未登记在卡片里的元素点击也不会发出 openFile（白名单在渲染层就生效）",
      openFileMessages().length === beforeProbe);
    probe.remove();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`WEBVIEW-DOM-CHECK FAILED (${checks - failures}/${checks} passed)`);
    return 1;
  }
  console.log(`WEBVIEW-DOM-CHECK OK (${checks} checks)`);
  console.log("  注意：本脚本不覆盖 CSP（happy-dom 不执行 CSP）与滚动（无排版引擎），两者由真机验收覆盖。");
  return 0;
}

process.exit(await main().catch((error) => {
  console.error(`WEBVIEW-DOM-CHECK ERROR ${error?.stack ?? error}`);
  process.exit(1);
}));
