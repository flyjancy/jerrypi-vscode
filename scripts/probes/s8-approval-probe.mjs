#!/usr/bin/env node
/**
 * S8 探针（一）：**不用模型、不用凭据、不联网**地把 pi 的工具审批路径跑通。
 *
 * 为什么要有它（S8-plan §0.1 的 F1–F8 都出自这里）：
 *   审批是"拦截 + 副作用不存在"这类断言，光读源码不足以定案 —— 比如
 *   "`tool_call` 到底在 `tool_execution_start` 之前还是之后"、"拒绝之后
 *   落盘的正文是什么"、"中止时 `ctx.signal` 会不会真的触发"，都必须**实跑**。
 *
 * 驱动方式（S8-plan F8）：把 `session.agent.streamFunction` 换成脚本化的假流。
 * ⚠️ **假流必须尊重 `opts.signal`**：abort 之后 pi 还会再要一次模型回复，
 * 假流若无视 signal 继续吐工具调用，agent 循环会**无限转**（F7，我第一版探针
 * 就是这么挂住的 —— 每 ~10ms 重复一次 handler，永不结束）。
 *
 * 用法：`node scripts/probes/s8-approval-probe.mjs`（需要先 `npm run sync`）。
 * 只读仓库里的 pi-runtime，只在 os.tmpdir() 下写临时文件，结束清理。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = path.join(REPO_ROOT, "pi-runtime", "dist", "bundle", "index.js");
if (!fs.existsSync(BUNDLE)) {
  console.error(`SKIP：${BUNDLE} 不存在，先跑 npm run sync`);
  process.exit(1);
}
const pi = await import(pathToFileURL(BUNDLE).href);

// ---------------------------------------------------------------- 1. 导出面
console.log("== 1. bundle 导出面（决定「能不能直接调 pi 的实现」）");
for (const name of [
  "hasTrustRequiringProjectResources",
  "ProjectTrustStore",
  "resolveProjectTrusted",
  "getProjectTrustOptions",
  "emitProjectTrustEvent",
  "DefaultResourceLoader",
  "createAgentSessionServices",
  "createAgentSessionFromServices",
  "SettingsManager",
  "SessionManager",
]) {
  console.log(`   ${name.padEnd(38)} ${typeof pi[name]}`);
}

// ---------------------------------------------------------------- 夹具
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s8-approval-probe-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "ws");
const sessionDir = path.join(root, "sessions", "--ws--");
const marker = path.join(cwd, "marker.txt");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
const readTarget = path.join(cwd, "readme.txt");
fs.writeFileSync(readTarget, "hello-from-probe\n");

/**
 * 造一个脚本化的假模型。两条纪律（都是踩出来的）：
 *   1. **尊重 signal**：`opts.signal.aborted` 时必须回 `stopReason:"aborted"`，
 *      否则 abort 之后循环不会退出（F7，探针第一版就是这样挂住的）。
 *   2. **第一次吐工具调用、之后必须收尾**（一条纯文本 `stop`）：被审批拦下的工具
 *      调用**不会**终止循环 —— pi 会把结果喂回模型再问一次，假模型要是每次都吐同一个
 *      工具调用，就会无限重复"预检 → 拦下 → 再问"（探针第二版就是这么挂住的）。
 *      真模型会看到"被拒绝"的 toolResult 后换个做法或停下。
 */
function scriptedStream(toolName, input) {
  const calls = [];
  const stream = async (m, _ctx, opts) => {
    const aborted = opts?.signal?.aborted === true;
    calls.push({ aborted, turn: calls.length + 1 });
    const base = {
      role: "assistant",
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0 } },
      timestamp: Date.now(),
    };
    const msg = aborted
      ? { ...base, content: [{ type: "text", text: "(aborted)" }], stopReason: "aborted" }
      : calls.length === 1
        ? { ...base, content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: input }], stopReason: "stop" }
        : { ...base, content: [{ type: "text", text: "(done)" }], stopReason: "stop" };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: msg };
        yield { type: "done" };
      },
      async result() {
        return msg;
      },
    };
  };
  return { stream, calls };
}

/**
 * 起一个真会话（真 pi 装配路径），审批由 `answer` 决定。
 * `mode` 是我们自己的三档语义的一个最小替身（探针只关心 pi 那一侧的机制）。
 */
async function makeSession({ toolName, input, answer, ask }) {
  const approvalFactory = (api) => {
    api.on("tool_call", async (event, ctx) => {
      const asked = { toolName: event.toolName, hasSignal: ctx.signal !== undefined, id: event.toolCallId };
      const outcome = await ask(asked, event, ctx);
      return outcome === "allow" ? undefined : { block: true, reason: `Rejected by user: ${toolName}` };
    });
  };
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const services = await pi.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: { extensionFactories: [approvalFactory] },
  });
  const sessionManager = pi.SessionManager.create(cwd, sessionDir);
  const model = services.modelRuntime.getModels()[0];
  await services.modelRuntime.setRuntimeApiKey(model.provider, "probe-key"); // 内存，不落盘
  const created = await pi.createAgentSessionFromServices({ services, sessionManager, model, customTools: [] });
  const session = created.session;
  const { stream, calls } = scriptedStream(toolName, input);
  session.agent.streamFunction = stream;
  const asked = [];
  const events = [];
  session.subscribe((event) => events.push(event.type));
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未结束`)), ms)),
    ]);
  return { session, asked, calls, events, withTimeout, answer };
}

function toolResultsOf(session) {
  return session.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => ({ toolName: m.toolName, isError: m.isError === true, text: m.content?.[0]?.text ?? "" }));
}

// ---------------------------------------------------------------- 2. 拒绝 / 允许
{
  console.log("\n== 2. 拒绝 → 工具没执行；允许 → 工具执行");
  for (const [label, answer] of [
    ["deny", "deny"],
    ["allow", "allow"],
  ]) {
    fs.rmSync(marker, { force: true });
    const askedOuter = [];
    const probe = await makeSession({
      toolName: "bash",
      input: { command: `touch ${marker}` },
      answer,
      ask: async (asked) => {
        askedOuter.push(asked);
        return answer;
      },
    });
    await probe.withTimeout(probe.session.prompt("go"), 15_000, "prompt");
    const results = toolResultsOf(probe.session);
    console.log(`   ${label}: marker=${fs.existsSync(marker)} results=${JSON.stringify(results)}`);
    console.log(`         asked=${JSON.stringify(askedOuter)} pending=${JSON.stringify([...probe.session.state.pendingToolCalls])}`);
    console.log(`         事件序=${probe.events.filter((t) => t.startsWith("tool_execution") || t === "agent_settled").join(" → ")}`);
    if (label === "deny") {
      assert.equal(fs.existsSync(marker), false, "拒绝之后工具不该执行");
      assert.equal(results[0].isError, true);
      assert.match(results[0].text, /Rejected by user/);
    } else {
      assert.equal(fs.existsSync(marker), true, "允许之后工具应当执行");
    }
  }
}

// ---------------------------------------------------------------- 3. 中止
{
  console.log("\n== 3. 待审批时 abort()：signal → 收口 → 没有副作用");
  fs.rmSync(marker, { force: true });
  let sawAbort = false;
  const askedOuter = [];
  const probe = await makeSession({
    toolName: "bash",
    input: { command: `touch ${marker}` },
    answer: "hang",
    ask: async (asked, _event, ctx) => {
      askedOuter.push(asked);
      await new Promise((resolve) => {
        if (ctx.signal?.aborted) {
          sawAbort = true;
          resolve();
          return;
        }
        ctx.signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return "deny"; // 中止路径上 pi 会把结果覆盖成 "Operation aborted"
    },
  });
  const running = probe.session.prompt("go").then(
    () => "resolved",
    (error) => `threw:${error.message}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log(`   挂起中：isStreaming=${probe.session.isStreaming} pending=${JSON.stringify([...probe.session.state.pendingToolCalls])}`);
  await probe.session.abort();
  const outcome = await probe.withTimeout(running, 5_000, "中止后的 prompt()");
  console.log(`   中止后：outcome=${outcome} isIdle=${probe.session.isIdle} isStreaming=${probe.session.isStreaming} pending=${JSON.stringify([...probe.session.state.pendingToolCalls])}`);
  console.log(`   signal 触发=${sawAbort} marker=${fs.existsSync(marker)} results=${JSON.stringify(toolResultsOf(probe.session))}`);
  console.log(`   模型被调用的次数=${probe.calls.length}（abort 之后还要再问一次，那次必须返回 aborted，见 F7）`);
  assert.equal(sawAbort, true, "ctx.signal 必须触发");
  assert.equal(outcome, "resolved");
  assert.equal(fs.existsSync(marker), false);
  assert.equal(probe.session.isIdle, true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("\nS8-APPROVAL-PROBE OK（3 节全部符合 S8-plan §0.1 的记录）");
