# S1 实施计划：可行性闸门

> 状态：**已吸收 Claude Opus 5 第一轮评审 + 其自查修正轮**（2026-09-12），待实施。
> 依据 [`PLAN.md`](PLAN.md) 第 6 节 S1、5.3、5.4；已落地事实见 [`S0-plan.md`](S0-plan.md) §10。
>
> S1 不建 UI。它只回答一个问题：**pi 能不能在 VS Code 扩展宿主里、从 `pi-runtime/` 里真正跑起来，
> 并完成一次真实对话。** 答案是 `GATE PASS` 或 `GATE BLOCKED`，没有第三种。

## 0. 结论的用途

- `GATE PASS` → 进入 S2（协议 + Webview 聊天）。
- `GATE BLOCKED` → **不进入 S2**，回到 `PLAN.md` 第 4 节重新决策（例如降级为只读 agent）。
- 判定规则（引自 PLAN.md）：**除 T5c 外，T1–T9 在受限 Windows 机上任一非 PASS 即 `GATE BLOCKED`；SKIP 不算通过。**
  T5c 为 advisory，其 FAIL/SKIP 都不参与判定，只记录。

### 0.1 评审吸收记录（Claude Opus 5，2026-09-12）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 阻断 | `setRuntimeApiKey` 是内存态，重载窗口后 key 全丢，T4/T6/T7/T9 必然假 BLOCKED | §4.2：**每次创建 `ModelRuntime` 后重新注入全部已存 key**；provider 列表存 `globalState`（SecretStorage 无枚举接口）。本机已核实 `RuntimeCredentials.overrides = new Map()`，`setRuntimeApiKey` 不落盘 |
| 2 | 阻断 | 同一缺陷第二条路径：自测用临时 agentDir → 缓存出第二个空凭据实例 | §4.2：key 注入放在 `getModelRuntime()` 内部，**对任何 agentDir 的实例都生效**；自测统一走该工厂 |
| 3 | 阻断 | `mode: "print"` 与上位计划冲突（5.3 点名 rpc） | §4.4：改为 `mode: "rpc"`（合法值已核实：`tui｜rpc｜json｜print`，默认 `print`） |
| 4 | 阻断 | T2 资源清单漏 `docs/` 与 `examples/` | §4.5：清单改为 **12 文件 + 2 目录**，与 S0 的 `REQUIRED_FILES`/`REQUIRED_DIRS` 同集合；防漂移用例同类比对 |
| 5 | 阻断 | T9 依赖 T7 从未建立的前提（T7 没加载 smoke、T7 已 dispose，"第 7 项的 runtime"指代不清） | §4.6 重构：定义**共享 runtime R**（T3/T6/T9）与**独立 runtime R2**（T7），并写清各步的对象归属 |
| 6 | 阻断 | T5c 没说标记从哪个事件读 | §4.6：改为读 `tool_execution_update.partialResult`（`tool_execution_start` 只有 `toolCallId/toolName/args`，无输出；已核实） |
| 7 | 阻断 | R3 的兜底（5.3 第 2 层代理）在 S1 范围外，自相矛盾 | §9 S1-D8：**T4 失败即终止**，第 2 层代理不塞进 S1；失败后作为独立评估项 |
| 8 | 重要 | 模型不配合会被误判成"pi 跑不起来" | §4.6：模型相关项（T4/T6/T7/T9）**各重试 1 次**，并把 `E_MODEL_*` 与能力错误码分开记录；每项独立超时 |
| 9 | 重要 | 应使用 `setRebindSession` 而非手动 rebind | §4.3：采用 `runtime.setRebindSession(...)`（否则漏掉 `fork()`/`importFromJsonl()`，S5 返工） |
| 10 | 重要 | T9 没检查 `{cancelled}` 返回值 | §4.6：断言返回 `cancelled === false` |
| 11 | 重要 | B2 用 F5 不够，应在 .vsix 上跑（F5 时仓库根有 node_modules，会掩盖打包遗漏） | §7：B2 改为**安装打包后的 `.vsix`** 再跑自测；F5 仅作快速迭代 |
| 12 | 重要 | 命令标题会渲染成 `Pi: Pi: Run Self-Test` | §4.7：`title` 不含 `Pi:` 前缀，统一 `category: "Pi"` |
| 13 | 重要 | `typeof import(...)` 解析 `dist/index.d.ts`，与实际加载的 `bundle/index.js` 不同源，断言是假的 | §4.0：明确类型来源；§4.1 增**必需导出名运行时断言** |
| 14 | 重要 | esbuild 守卫只挡精确裸名 | §4.8：正则改 `^@earendil-works/pi-coding-agent(\/|$)`；另加 `dist/extension.js` 体积上限 |
| 15 | 重要 | `modelsPath` 未显式传，S6 会静默劈叉 | §4.2：显式传 `authPath` / `modelsPath` / `modelsStorePath` |
| 16 | 重要 | `loader.ts` 用 `readFileSync` 违反自订约束；缓存 rejected promise 会堵死重载 | §4.1：改异步读取；不缓存 rejected promise，提供 `reloadPi()` |
| 17 | 重要 | 守卫排在第 5 个提交，前四个没护栏 | §8：守卫与 loader 同批落地 |
| 18 | 事实 | `noOpUIContext` 不是公开 API（`runner.js` 模块私有常量，不在任何 `.d.ts` 或导出里） | §4.7：修正措辞——**不是"故意不用"，是根本拿不到，必须自己写** |
| 19 | 事实 | `ExtensionUIContext` 成员数是 27 方法 + 1 只读属性 | §4.7：已按 28 个成员核实修正（原稿"~35"偏高） |
| 20 | 事实 | `SessionManager.continueRecent` 同步；`BashResult.exitCode` 是必有键可为 `undefined`；`allowModelNetwork` 默认已是 false | §4.6 逐条修正 |
| 21 | 事实 | Node 版本不能用字符串比较（`"24.9.0" > "24.15.0"`） | §4.6：改为数值段比较 |
| 22 | 事实 | 首行版本号必须取 `context.extension.packageJSON.version` | §5：已改；§6 表格不再硬编码资源条数 |
| 23 | 事实 | 改 fixture 要连带看 S0 的校验 ⑦（两个环境变量名都要列） | §4.10：写明两个变量名，并要求 CI 校验 ⑦ 保持绿 |
| 24 | 重要 | `customTools: [wrappedWrite]` 被悄悄去掉，同名覆盖内置 write 的风险被推后到 S7 | §4.9 + §9 S1-D9：**纳入 S1**，作为闸门的一项 |
| 25 | 重要 | T8：`resizeImage()` 会静默回落到主线程，单跑它不能证明 worker 可用；且**可能返回 `null`** | §4.6：只有显式 `new Worker(...)` 那次往返算 worker 证据；先判 `null` 并给独立错误码 |

## 1. 范围

### 1.1 做

1. 真·动态 `import()` pi bundle（`loader.ts`），断言版本与必需导出名；
2. `ModelRuntime` 工厂（含 key 重新注入）与最小会话装配（`runtime.ts` / `session.ts`）；
3. 把 pi 会话事件接到 VS Code（`bindings.ts`）；
4. 三条命令：`Pi: Run Self-Test` / `Pi: Set API Key`（最小版）/ `Pi: Open Settings File`；
5. 一个最小 `wrappedWrite` 自定义工具，验证"同名覆盖内置 write"的机制；
6. 自测 T1–T9，输出固定格式并给出 `GATE PASS|BLOCKED`。

### 1.2 不做（留给后续步骤）

| 不做 | 留给 |
| --- | --- |
| Webview / 任何 UI、协议层 | S2 |
| 工具卡片、diff、审批开关 | S3/S7/S8 |
| 模型选择器、思考等级、状态栏 | S4 |
| 会话列表/新建/恢复的 UI | S5 |
| `jerrypi.*` 三项设置的读写（含 `jerrypi.agentDir`） | S6 |
| **第 2 层代理**（`jerrypi.proxy` + undici） | 见 S1-D8：不塞进 S1 |
| 真实 UIContext（除自测用的最小实现） | S2 |

## 2. 文件清单

**新增**

```
src/pi/loader.ts        # 动态 import pi bundle（唯一入口）+ 版本与导出名断言 + reloadPi()
src/pi/resources.ts     # 打包期必须存在的资源清单（12 文件 + 2 目录，T2 用）
src/pi/runtime.ts       # ModelRuntime 工厂（含 key 重新注入）
src/pi/session.ts       # 生产装配路径：services → session → runtime + setRebindSession
src/pi/bindings.ts      # session 事件 → VS Code（Output channel）
src/pi/custom-tools.ts  # 最小 wrappedWrite（同名覆盖内置 write，验证机制）
src/pi/selftest.ts      # T1–T9 + GATE 判定 + PNG 生成工具
src/pi/selftest-ui.ts   # 最小完整 ExtensionUIContext（28 个成员，自测专用）
src/commands.ts         # 三条命令的注册
```

**修改**

```
src/extension.ts                    # activate() 注册命令；保持非阻断
esbuild.mjs                         # 禁止值导入 pi 的守卫 + dist/extension.js 体积上限
package.json                        # contributes.commands 增三条
test-fixtures/ext-smoke/index.ts    # smoke 处理器写标记文件（T3 需要证据）
scripts/self-test.mjs               # 新增第 5 用例：资源清单一致性（文件 + 目录）
```

## 3. 不可违反的约束

1. **绝不静态 import pi。** 只能 `import type` + 运行时 `import()` 文件 URL。由 §4.8 的构建守卫强制执行。
2. **扩展宿主里不做同步 IO、不阻塞。** activate() 仍然只注册命令；`loader.ts` 用异步 fs。
3. **自测不得污染用户环境。** 一律用 `os.tmpdir()` 下的临时 `cwd` / `agentDir` / `sessionDir`，
   `finally` 里清理。
4. **pi 版本只有一个来源**：`pi-runtime/.version`（S0 已建立）。任何地方不得硬编码 `"0.85.1"`。
5. **类型可以来自 devDependency，运行时不能。** 见 §4.0。

## 4. 模块设计

> 以下 API 签名读自 **devDependency 里那份 pi 包**的 `.d.ts`（`node_modules/@earendil-works/pi-coding-agent/dist/**`）
> 与 bundle 源码，并逐条在本机核实过。

### 4.0 类型从哪来（很重要，先讲清）

- **`pi-runtime/` 里一个 `.d.ts` 都没有。** S0 只复制了 `dist/bundle/`、`dist/modes/interactive/theme/`、
  `dist/core/export-html/`、`docs/`、`examples/`、`README.md`、`package.json`。
- 而且 `pi-runtime/package.json` 的 `main` / `types` / `exports` 三个入口**全部指向不存在的文件**
  （`./dist/index.js`、`./dist/index.d.ts`）。**运行期只能显式指向 `dist/bundle/index.js`。**
- 因此：
  - 编译期类型：`import type { ... } from "@earendil-works/pi-coding-agent"`（来自 devDependency）；
  - 运行期模块：`await import(pathToFileURL(<extension>/pi-runtime/dist/bundle/index.js).href)`；
  - **两者不是同一个文件**，导出面没有静态保证 → 由 §4.1 的运行时导出名断言补上。

### 4.1 `src/pi/loader.ts`

```ts
export type PiModule = typeof import("@earendil-works/pi-coding-agent");

export const REQUIRED_PI_EXPORTS = [
  "VERSION", "getPackageDir", "ModelRuntime", "SessionManager",
  "createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime",
  "resizeImage", "defineTool", "createWriteToolDefinition", "wrapRegisteredTool",
] as const;

let cached: Promise<PiModule> | undefined;

export function loadPi(extensionUri: vscode.Uri): Promise<PiModule> { /* 见下 */ }
export function reloadPi(): void { cached = undefined; }
```

实现要求：

- 用 `await readFile(...)` 读 `pi-runtime/.version`（**不用 `readFileSync`**，遵守 §3 第 2 条）；
- 动态 `import()` 绝对文件 URL；
- 断言 `VERSION === .version`，否则 `E_VERSION`；
- 断言 `getPackageDir().endsWith("pi-runtime")`，否则 `E_PACKAGE_DIR`；
- 断言 `REQUIRED_PI_EXPORTS` 每个名字在模块里 `typeof === "function"`（`VERSION` 为 `string`），
  否则 `E_MISSING_EXPORTS` —— 这是 §4.0 缺口的补偿；
- **失败时清空缓存**（不缓存 rejected promise），并暴露 `reloadPi()` 供"重载运行时"使用。

### 4.2 `src/pi/runtime.ts`

```ts
export async function getModelRuntime(pi, agentDir, keyStore): Promise<ModelRuntime>;
```

- 按 `agentDir` 缓存实例；
- **创建后立刻注入全部已存 key**：`await runtime.setRuntimeApiKey(providerId, apiKey)`。
  **这是必须的**：已核实 `ModelRuntime.setRuntimeApiKey` 只写内存覆盖层
  （`RuntimeCredentials{ overrides = new Map() }`），**不落盘**，重载窗口即丢。
  只要走这个工厂，任何 agentDir 的实例都带 key，评审意见 1、2 一并解决；
- 显式传三个路径，不依赖默认值（否则 S6 加 `jerrypi.agentDir` 后会静默劈叉）：
  `authPath: <agentDir>/auth.json`、`modelsPath: <agentDir>/models.json`、
  `modelsStorePath: <agentDir>/models-store.json`；
- `allowModelNetwork` 保持 `false`（本来也是默认值，写明是为了可读性）；
- `keyStore`：`{ list(): string[]; get(providerId): Promise<string|undefined> }`。
  provider 列表存 `context.globalState`（**SecretStorage 没有枚举接口**），key 本身存 `context.secrets`。

### 4.3 `src/pi/session.ts`（生产装配路径）

```ts
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext,
}) => {
  const services = await pi.createAgentSessionServices({
    cwd, agentDir, modelRuntime: await getModelRuntime(pi, agentDir, keyStore),
    resourceLoaderOptions: { additionalExtensionPaths },
  });
  return {
    ...(await pi.createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, customTools,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
runtime.setRebindSession(async (session) => { bindSession(session); });   // 关键
```

- **工厂必须使用传进来的 `agentDir`**（`switchSession({ cwdOverride })` 时 pi 传的才是正确值），
  不能从闭包拿；`projectTrustContext` 要透传，否则 S2 之后的项目信任流程失灵；
- **用 `setRebindSession()` 而不是在 `newSession()/switchSession()` 之后手动 rebind**：
  pi 在 `finishSessionReplacement()` 里回调它，官方三个模式都这么做；手动版会漏掉
  `fork()` 与 `importFromJsonl()`，S5 必然返工。

### 4.4 `src/pi/bindings.ts`

```ts
session.bindExtensions({
  uiContext,                 // 自测用 §4.7 的最小实现；生产路径 S2 再换真的
  mode: "rpc",               // 已核实合法值：tui｜rpc｜json｜print；默认是 print
  abortHandler: () => void session.abort(),
  onError,
});
const unsubscribe = session.subscribe(onEvent);
```

- 事件先只做计数 + 写 Output（S2 才做协议转发）；
- `onError` 写 Output，**不弹窗、不中断会话**；
- 注意 `hasUI()` 的实现是 `uiContext !== noOpUIContext`，与我们传什么模式无关 —— 传了自定义 uiContext 就是 `true`。

### 4.5 `src/pi/resources.ts`

```ts
export const REQUIRED_RESOURCE_FILES = [ /* 12 条，相对 pi-runtime/ */ ];
export const REQUIRED_RESOURCE_DIRS = ["docs", "examples"];
```

文件 12 条与 S0 的 `REQUIRED_FILES` 完全一致（含 `dist/bundle/chunks/image-resize-worker.js`、
两个主题 json、导出模板、chord context、jiti package.json、photon wasm）。

**为什么要重复一份**：`scripts/` 不进 `.vsix`，打包后的扩展跑不了 S0 的校验脚本，T2 必须自查。
漂移风险由 §4.10 的用例 5 消除。

### 4.6 `src/pi/selftest.ts`

#### 共享夹具

| 对象 | 用于 | 说明 |
| --- | --- | --- |
| **R** | T3 / T6 / T9 | 持久 `SessionManager`（临时 `sessionDir`）+ smoke 扩展 + 临时 `cwd`/`agentDir` |
| **R2** | T7 | 独立 runtime 与会话目录，跑完即 `dispose()`，再做 `continueRecent` 验证 |

#### 各项要点

- **T1**：打印 `process.versions.node` / `process.versions.electron` / `vscode.version`；
  用**数值段比较**判定 Node ≥ 24.15（字符串比较会把 `24.9.0` 误判为大于 `24.15.0`）。
- **T2**：`loadPi()` + 遍历 `REQUIRED_RESOURCE_FILES`（`lstat` 普通文件、可读、非空、非符号链接）
  + `REQUIRED_RESOURCE_DIRS`（存在、是目录、非空）。
- **T3**（在 R 上）：把 `test-fixtures/ext-smoke/` 复制到临时目录 →
  `additionalExtensionPaths: [<临时目录>/index.ts]` → 装配 R → `bindExtensions` →
  断言 `services.resourceLoader.getExtensions().errors` 中**不含 smoke 路径**（用户自己扩展的错误单独列诊断，不参与判定）、
  `session.extensionRunner.getRegisteredCommands()` 含 `smoke`、`session_start` 标记文件已写出；
  `prompt("/smoke")` 后命令标记文件已写出；`prompt("/smoke-custom")` 触发可控错误并经 `onError` 上报，会话仍可用。
- **T4**：真实 provider 流式请求。判定必须是
  **收到 `message_update` 且 `event.assistantMessageEvent.type === "text_delta"`**
  —— `text_delta` **不是**顶层事件（已核实 `MessageUpdateEvent.assistantMessageEvent`）。未配置 key → `FAIL E_NO_CREDENTIALS`。
- **T5**：
  - T5a `session.executeBash("echo hi && pwd")` → `BashResult.output` 含 cwd；
  - T5b `executeBash("sleep 30")` → 2s 后 `abortBash()` → 3s 内返回且 `result.cancelled === true`；
  - T5c（advisory）见下。
  - 已核实：`executeBash` **没有** timeout / cwd 参数（cwd 取 `sessionManager.getCwd()`），
    `abortBash()` 中止**所有**在跑的 bash（不按 id），`BashResult.exitCode` 是必有键、值可为 `undefined`。
    → 超时必须由外层计时器负责；单条命令的 T5a/T5b 不受影响。
- **T5c**（advisory，需要模型）：`prompt("Run this exact bash command: echo JERRYPI_START_<随机串> && sleep 30")`；
  用 `tool_execution_start` 只为**关联 toolCallId**，
  **启动标记要从 `tool_execution_update.partialResult` 里读**（已核实 `tool_execution_start` 只有
  `toolCallId/toolName/args`，无输出；`bash_execution_update` 是用户 `/bash` 的通道，不是 agent 工具通道）；
  看到标记后再等 2s 调 `session.abort()`，断言 `agent_end` 到达且该工具结果为中止。
  60s 内模型未发起 bash → `SKIP E_NO_TOOLCALL`；发起了但没收到标记 → `FAIL E_NO_SPAWN`。
- **T6**（在 R 上）：临时目录里 `prompt` 让 agent write → read → edit，
  断言磁盘内容与 edit 结果 `details.patch` 非空。
- **T7**（在 R2 上）：`SessionManager.create(cwd, sessionDir)` →
  一次真实 `prompt("Reply with PONG")`（pi 在首条 assistant 消息前不落盘，只 append user 消息会假失败）→
  `await R2.dispose()` → `SessionManager.continueRecent(cwd, sessionDir)`（**同步**，返回 `SessionManager`，不是 Promise）
  → 断言消息数 ≥ 2 且文件存在；把 `sessionFile` 与消息数留给 T9 用。
- **T8**：**自造 PNG**（`node:zlib` + ~20 行 CRC32，不引三方库）生成 3000×3000 纯色图 →
  `new Worker(pathToFileURL(<pi-runtime>/dist/bundle/chunks/image-resize-worker.js))` →
  `postMessage({ inputBytes, mimeType: "image/png", options: { maxWidth: 1000, maxHeight: 1000, maxBytes: 1e6 } })`
  → 10s 内收到响应且尺寸变小 → `terminate()`。
  **只有这一次显式 Worker 往返算 worker 可用的证据**；`resizeImage()` 失败时会**静默回落到主线程**
  （`resizeImageInProcess`），且**可能返回 `null`**（Photon 不可用或压不到 `maxBytes`）——
  单独调它只作补充，断言前先判 `null`，错误码 `E_RESIZE_NULL`。
- **T9**（在 R 上，使用 T7 产出的会话文件）：
  `await R.newSession()` → 断言返回 `cancelled === false`、`R.session` 是**新对象**、会话文件路径不同、
  smoke 的 `session_start` 标记再次写出、`getRegisteredCommands()` 仍含 `smoke`；
  再 `await R.switchSession(<T7 的 sessionFile>)` → 断言 `cancelled === false`、
  历史消息数与 T7 一致、订阅能收到 `agent_start`（用一次 `prompt("Reply with PONG")` 触发，需凭据）。
  两个方法都返回 `Promise<{ cancelled: boolean }>`，**必须检查返回值**（被 `session_before_switch` 取消时会话不变，
  "断言是新对象"会以很误导的方式失败）。

#### 模型相关项的统一要求

T4/T6/T7/T9 依赖模型主动配合：**各重试 1 次**，并把错误码分成两类记录 ——
`E_MODEL_NOT_COOPERATING`（模型没按要求做）与能力错误（`E_NO_CREDENTIALS`、`E_NO_SPAWN`…），
避免"模型一次不听话"被读成"pi 跑不起来"。

#### 超时（每项独立）

| 项 | 超时 | 项 | 超时 |
| --- | --- | --- | --- |
| T1 | 5s | T5c | 90s |
| T2 | 30s | T6 | 120s |
| T3 | 60s | T7 | 60s |
| T4 | 60s | T8 | 30s |
| T5a/T5b | 30s | T9 | 120s |

### 4.7 `src/pi/selftest-ui.ts`

- 实现**完整的** `ExtensionUIContext`：已核实为 **27 个方法 + 1 个只读属性 `theme`**，共 28 个成员；
- `notify` 写 Output；`custom: async () => { throw new Error("jerrypi: custom UI not available") }`；其余 no-op；
- **必须自己写**：pi 的 `noOpUIContext` 是 `dist/core/extensions/runner.js` 里的**模块私有常量**，
  不在任何 `.d.ts`、也不在 bundle 导出里（本机已核实 `"noOpUIContext" in module === false`），
  **根本拿不到**。（原稿写"故意不用"是错的，实际是"用不了"。）

### 4.8 `esbuild.mjs` 守卫

```js
plugins: [{
  name: "forbid-static-pi-import",
  setup(build) {
    build.onResolve({ filter: /^@earendil-works\/pi-coding-agent(\/|$)/ }, () => ({
      errors: [{ text: "禁止静态 import pi；请用 import type + src/pi/loader.ts 的动态 import()" }],
    }));
  },
}]
```

- 正则覆盖深路径（原稿只挡精确裸名）；
- `import type` 会被 esbuild 擦除、不触发 `onResolve`，所以这条只在真的写错时炸；
- 另加**体积上限**：构建后若 `dist/extension.js` 超过 256 KB 即失败（当前 1.92 KB，pi bundle 7.6 MB）。
  体积是"误把 pi 打进来"最省事的探针。

### 4.9 `src/pi/custom-tools.ts`

最小 `wrappedWrite`：用 `createWriteToolDefinition` + `defineTool` 造一个**同名 `write`** 的自定义工具，
经 `customTools: [wrappedWrite]` 传入会话装配。

存在的理由（PLAN.md 第 6 节 S1 第 3 条原文）：**"同名覆盖内置 write"这个机制有风险，要在闸门里验**。
原稿把它悄悄去掉、把 `filechanges` 整体推给 S7，等于把风险推后到 S7 才暴露。T3 的断言里加一条：
会话的活动工具表中 `write` 指向我们的实现（而非内置定义）。

### 4.10 `test-fixtures/ext-smoke/index.ts` 与 `scripts/self-test.mjs`

- fixture 的 `smoke` 处理器**先写标记文件**，再调 `ctx.ui.notify`；
- **两个环境变量名都要用**：`JERRYPI_SMOKE_MARKER`（`session_start` 写，S0 已有）
  与 `JERRYPI_SMOKE_COMMAND_MARKER`（`smoke` 命令写，S1 新增）；
- 该文件被 `tsconfig` 排除在类型检查外，而 **CI 会跑 S0 的校验 ⑦**（加载该 fixture）——改完必须确认 CI 仍绿；
- `scripts/self-test.mjs` 新增用例 5：解析 `src/pi/resources.ts` 的 `REQUIRED_RESOURCE_FILES` +
  `REQUIRED_RESOURCE_DIRS`，与 `scripts/sync-pi-runtime.mjs` 的 `REQUIRED_FILES` + `REQUIRED_DIRS`
  **分别**比对（原稿只比文件常量，会漏掉目录）。

## 5. 自测输出契约（抄自 PLAN.md，不改）

```
flyjancy.jerrypi <扩展版本> selftest-v1 <平台> node=<版本>
T1 PASS
T2 PASS
T3 FAIL E_EXTENSION_ERRORS
...
GATE BLOCKED T3,T6
```

- **首行版本号必须取 `context.extension.packageJSON.version`**（硬编码就失去"核对跑的是不是发布版"的意义）；
- 每项一行 `T<编号> PASS|FAIL|SKIP <短错误码>`；细节（含重试次数、`E_MODEL_*`）写 Output 的后续行；
- 末行 `GATE PASS` 或 `GATE BLOCKED <失败项列表>`。

## 6. 判定标准速查

| 项 | required | 通过标准 | 需要凭据 | 超时 |
| --- | --- | --- | --- | --- |
| T1 | ✅ | Node ≥ 24.15（数值比较），打印三版本号 | 否 | 5s |
| T2 | ✅ | `loadPi()` 成功 + 必需导出名齐 + 全部资源路径（12 文件 + 2 目录）合格 | 否 | 30s |
| T3 | ✅ | 无 smoke 相关扩展错误 + `smoke` 已注册 + 2 个标记文件 + `/smoke-custom` 经 `onError` + `write` 指向 wrappedWrite | 否 | 60s |
| T4 | ✅ | 收到 `message_update` 且 `assistantMessageEvent.type === "text_delta"` | **是** | 60s |
| T5a/T5b | ✅ | `executeBash` 输出正确；`abortBash` 后 3s 内返回且 `cancelled === true` | 否 | 30s |
| T5c | ⚠️ advisory | 见 §4.6（标记从 `tool_execution_update.partialResult` 读） | **是** | 90s |
| T6 | ✅ | 文件内容正确 + `details.patch` 非空 | **是** | 120s |
| T7 | ✅ | `continueRecent` 后消息数 ≥ 2 且文件存在 | **是** | 60s |
| T8 | ✅ | 显式 Worker 往返成功（尺寸变小）+ `resizeImage()` 非 `null` 且尺寸变小 | 否 | 30s |
| T9 | ✅ | 两次替换 `cancelled === false`、rebind 正确、`agent_start` 可达 | **是** | 120s |

> 结论：**没有 API key 就必然 `GATE BLOCKED`**（T4/T6/T7/T9 required）。这是刻意的——
> 闸门要证明的是"能对话"，不是"能加载"。

## 7. 验收

**你来做的（B 系列）**

| # | 项 | 说明 |
| --- | --- | --- |
| B1 | 用 `Pi: Set API Key` 配好 deepseek key | key 与 SecretStorage 都在你机器上，我无法代做 |
| B2 | 在 **Mac 上安装打包后的 `.vsix`**（不是 F5）并跑 `Pi: Run Self-Test`，把 Output 逐行贴给我 | **必须用 .vsix**：F5 时仓库根有 `node_modules`，pi bundle 的裸依赖可能从那里解析，正好掩盖打包遗漏——S0 专门做隔离校验就是为了这个 |
| B3 | （S1 通过后）发布 0.1.1 预发布，让受限机跑同样命令并回报 | 需要 publisher + PAT |

**我做的（A 系列，全部无凭据可跑）**

| # | 项 |
| --- | --- |
| A1 | `npm run typecheck` / `npm run build` |
| A2 | `npm run sync` + `npm run self-test`（含新用例 5）全过 |
| A3 | `npm run package` → 体积门禁 → 解包复跑（S0 的 A5b/A6b/A7 全套） |
| A4 | CI 全绿（含 S0 校验 ⑦ 仍能加载改动后的 fixture） |
| A5 | 静态检查：`dist/extension.js` 中不含 pi 的导入，且体积 < 256 KB |

## 8. 提交计划

1. `feat: load pi runtime dynamically with export and version assertions`
   （**含 esbuild 守卫** —— 评审 17：护栏必须和 loader 同批落地）
2. `feat: add model runtime with api key re-injection`
3. `feat: add session assembly, rebinding and wrapped write tool`
4. `feat: add Pi: Set API Key and Pi: Open Settings File commands`
5. `feat: add Pi: Run Self-Test feasibility gate (T1-T9)`
6. `test: guard resource-list drift and static pi imports`
7. `docs: record S1 implementation results`

## 9. 决策点

| 编号 | 问题 | 建议默认值 |
| --- | --- | --- |
| S1-D1 | 自测命令名 | 命令 ID `jerrypi.runSelfTest`，`title: "Run Self-Test"` + `category: "Pi"` |
| S1-D2 | key 的 provider 范围 | S1 只做 QuickPick 选 provider + 手填 key（deepseek 置顶）；OAuth 不做 |
| S1-D3 | `agentDir` | S1 用 pi 的默认（尊重 `PI_CODING_AGENT_DIR`），不加 `jerrypi.agentDir` 设置（S6 再加） |
| S1-D4 | 自测绑定的 UI 上下文 | 自写最小完整 UIContext（28 成员），非 noOp（后者也拿不到） |
| S1-D5 | 资源清单防漂移 | `scripts/self-test.mjs` 用例 5，文件与目录分别比对 |
| S1-D6 | 静态 import 守卫 | esbuild `onResolve` 构建失败 + `dist/extension.js` 体积上限 |
| S1-D7 | 0.1.1 预发布 | S1 在 Mac 上 `GATE PASS` 后再发（B3） |
| **S1-D8** | T4 网络失败怎么办 | **T4 失败即终止判定**，不把"第 2 层代理 + undici"提前塞进 S1；失败后作为独立评估项（可能单独插一个 S1.5） |
| **S1-D9** | `wrappedWrite` 是否进 S1 | **进**：PLAN 第 6 节 S1 第 3 条点名要验"同名覆盖内置 write"的机制 |
| **S1-D10** | 扩展模式 | `mode: "rpc"`（与 PLAN 5.3 一致；print 是默认值、语义不符） |

## 10. 风险

| # | 风险 | 应对 |
| --- | --- | --- |
| S1-R1 | 扩展宿主里 `import()` 扩展目录内的 ESM 失败（路径/权限类问题） | T2 立刻暴露；回退见 PLAN R4（CJS + shim） |
| S1-R2 | 扩展宿主把 `process.versions.node` 报成 Electron 的 Node | T1 直接打印，闸门要求 ≥ 24.15 |
| S1-R3 | 真 provider 请求被企业网络/CA 拦截 | T4 失败 → 见 S1-D8：**S1 内终止**，代理层另立评估 |
| S1-R4 | `/smoke` 命令在无真实 UI 时行为与预期不同 | fixture 先写标记再调 UI；T3 只断言标记与不崩溃 |
| S1-R5 | 自测耗时过长（多次真实模型调用） | §4.6 的每项独立超时；bash 因 `executeBash` 无 timeout 参数，由外层计时 |
| S1-R6 | 模型不配合导致假 BLOCKED | 模型相关项重试 1 次，并区分 `E_MODEL_*` 与能力错误码 |
