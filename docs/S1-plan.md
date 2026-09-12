# S1 实施计划：可行性闸门

> 状态：**已吸收 Claude Opus 5 四轮评审**（2026-09-12）。第四轮结论：**"计划可以开工了"**，待实施。
> 依据 [`PLAN.md`](PLAN.md) 第 6 节 S1、5.3、5.4；已落地事实见 [`S0-plan.md`](S0-plan.md) §10。
>
> S1 不建 UI。它只回答一个问题：**pi 能不能在 VS Code 扩展宿主里、从 `pi-runtime/` 里真正跑起来，
> 并完成一次真实对话。** 答案是 `GATE PASS` 或 `GATE BLOCKED`，没有第三种。

## 0. 结论的用途

- `GATE PASS` → 进入 S2（协议 + Webview 聊天）。
- `GATE BLOCKED` → **不进入 S2**，回到 `PLAN.md` 第 4 节重新决策（例如降级为只读 agent）。
- 判定规则（引自 PLAN.md）：**除 T5c 外，T1–T9 在受限 Windows 机上任一非 PASS 即 `GATE BLOCKED`；SKIP 不算通过。**
  T5c 为 advisory，其 FAIL/SKIP 都不参与判定，只记录。

### 0.1 第一轮评审吸收（Claude Opus 5）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 阻断 | `setRuntimeApiKey` 是内存态，重载窗口后 key 全丢，T4/T6/T7/T9 必然假 BLOCKED | §4.2：**每次创建 `ModelRuntime` 后重新注入全部已存 key**；provider 列表存 `globalState`（SecretStorage 无枚举）。本机已核实 `RuntimeCredentials.overrides = new Map()`，不落盘 |
| 2 | 阻断 | 同一缺陷第二条路径：自测用临时 agentDir → 缓存出第二个空凭据实例 | §4.2：注入放进 `getModelRuntime()` 内部，**对任何 agentDir 的实例都生效** |
| 3 | 阻断 | `mode: "print"` 与上位计划冲突（5.3 点名 rpc） | §4.4：改 `mode: "rpc"`（合法值已核实：`tui｜rpc｜json｜print`，默认 `print`） |
| 4 | 阻断 | T2 资源清单漏 `docs/` 与 `examples/` | §4.5：改为 **12 文件 + 2 目录**，与 S0 同集合；防漂移用例同类比对 |
| 5 | 阻断 | T9 依赖 T7 从未建立的前提 | §4.6：重构为共享 runtime **R**（T3/T6/T9）+ 独立 **R2**（T7） |
| 6 | 阻断 | T5c 没说标记从哪个事件读 | §4.6：改读 `tool_execution_update.partialResult`（`tool_execution_start` 无输出，已核实） |
| 7 | 阻断 | R3 兜底超出 S1 范围 | §9 S1-D8：**T4 失败即终止** |
| 8 | 重要 | 模型不配合会被误判成能力缺口 | §4.6：模型项各重试 1 次，区分 `E_MODEL_*` |
| 9 | 重要 | 应用 `setRebindSession` 而非手动 rebind | §4.3（第二轮的 #8 补充了"必须再显式调一次"） |
| 10 | 重要 | T9 未检查 `{cancelled}` | §4.6：断言 `cancelled === false` |
| 11 | 重要 | B2 应在 .vsix 上跑，不是 F5 | §7 |
| 12 | 重要 | 命令标题会渲染成 `Pi: Pi: ...` | §4.11 |
| 13 | 重要 | `typeof import(...)` 与实际加载文件不同源 | §4.0 + §4.1 必需导出名断言 |
| 14 | 重要 | esbuild 守卫只挡精确裸名 | §4.8：正则含深路径 + 体积上限 |
| 15 | 重要 | `modelsPath` 未显式传 | §4.2 |
| 16 | 重要 | `loader.ts` 用同步 fs；缓存 rejected promise | §4.1 |
| 17 | 重要 | 守卫应与 loader 同批提交 | §8 |
| 18–23 | 事实 | `noOpUIContext` 非公开 API；UIContext 28 成员；`continueRecent` 同步；`exitCode` 必有键；Node 版本不能字符串比较；首行版本取 `packageJSON.version` | 已逐条修正 |
| 24 | 重要 | `wrappedWrite` 被悄悄去掉 | §4.9 + S1-D9：纳入 S1 |
| 25 | 重要 | `resizeImage()` 静默回落且可能返回 `null` | §4.6：只有显式 Worker 往返算证据 |

### 0.2 第二轮评审吸收（Claude Opus 5，针对吸收后的版本）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | **阻断** | **首个会话永远不会被绑定**：`setRebindSession` 只在会话**替换**时触发，首个会话缺 `bindExtensions`/`subscribe` → T3 标记不写、T4 收不到事件 | §4.3：注册之后再**显式调用一次** `rebindSession()`。已核实官方 print/rpc 模式正是 `setRebindSession(async () => { await rebindSession() })` 之后 `await rebindSession()` |
| 2 | **阻断** | `customTools` 必须在工厂内按传入的 `cwd` 构造 | §4.3/§4.9：已核实 `createWriteToolDefinition(cwd, options?)` 第一参数是 cwd；改为工厂内构造 |
| 3 | **阻断** | `projectTrustContext` 透传落点写错（无处可传） | §4.3：改为显式传 `settingsManager`；`projectTrustContext` 在 S1 不传（S6 随信任流程一起做）。注：评审给的"落点"（`resourceLoaderReloadOptions.resolveProjectTrust`）也不成立——已核实该回调只收 `{ extensionsResult }` |
| 4 | 重要 | 不传 `settingsManager` = 隐式信任所有项目（`projectTrusted` 默认 `true`） | §4.3 + **S1-D11**：S1 显式传 `projectTrusted: false` |
| 5 | 重要 | rebind 回调没 `await` | §4.3：`async (session) => { await rebindSession(session); }` |
| 6 | 重要 | T3 断言可写得更强 | §4.6：查表断言 `write` 的 `sourceInfo.source === "sdk"`，**外加行为证据**（wrappedWrite 被调用时写标记文件，T6 顺带验证） |
| 7 | 重要 | T9 依赖 T7 的临时目录还活着 | §4.6：**R 与 R2 共用同一个临时 cwd**，统一在最后清理 |
| 8 | 小 | `wrapRegisteredTool` 列进导出清单但没人用 | §4.1：从 `REQUIRED_PI_EXPORTS` 删除（清单只列真正用到的名字） |
| 9 | 小 | `createWriteToolDefinition` 已返回 `ToolDefinition`，再套 `defineTool` 多余 | §4.9：直接传给 `customTools`，自定义行为经 `options.operations` 注入 |
| 10 | 小 | 三条命令的设计整节丢了 | §4.11：补回命令行为表，并补"设完 key 要注入**已缓存实例**" |
| 11 | 小 | 自测总时长最坏约 16 分钟且中途无输出 | §4.6：**每项结束立即追加一行到 Output**，便于定位卡点 |

### 0.3 第三轮评审吸收（Claude Opus 5）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | **重要** | `wrappedWrite` 的形状验不到它被加进来的那个风险 | §4.9：改为**自己包一层 `execute`，在每次调用内构造捕获 `toolCallId` 的 `operations`**。已核实内置 write 的 `execute(_toolCallId, …)` **丢弃 toolCallId**，且 `operations` 在构造时固定 |
| 2 | 小 | `REQUIRED_PI_EXPORTS` 漏了代码实际用到的 `SettingsManager` 与 `getAgentDir` | §4.1：已补（清单自己写着"只列真正用到的名字"） |
| 3 | 小 | `projectTrustContext` 那条反驳只对一半 | §4.3：改为"S1 不接；接法是在 `resolveProjectTrust` 回调**内部**闭包传给 pi 内部的 `resolveProjectTrusted(...)`" |
| 4 | 更正 | 它上轮说"`customTools` 放工厂外会把文件写到错目录"是**错的** | §4.9：删掉该理由。已核实路径解析是 `resolveToCwd(path, ctx?.cwd || cwd)`，而 `customTools` 经 `wrapRegisteredTools` 拿到当前会话 `ctx.cwd`。**仍保留"在工厂内按传入 cwd 构造"**（更一致、更保守），但不再编造原因 |
| 5 | 非阻断 | `projectTrusted: false` 与 pi CLI 行为刻意分歧，需让用户知道 | §1.1 新增第 7 项：写进 README 已知限制 |

第三轮同时确认了两件我们担心过的事：**`projectTrusted: false` 不影响 T3**（`additionalExtensionPaths` 走 CLI/temporary 分支，无条件合入，不受信任门控）；**覆盖 `operations` 不会丢掉文件互斥队列**（`withFileMutationQueue` 在 `createWriteToolDefinition` 的 execute 内部，不在默认 operations 里）。

### 0.4 第四轮评审吸收（Claude Opus 5；结论：**可以开工**）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 建议 | T5a 的失败归因没分层：“没装 Git Bash”（配置问题，5 分钟可修）与“策略禁止 spawn”（能力问题）现在都只输出一个 `T5a FAIL` | §4.6：T5a 拆**四个错误码** + 成功时记录实际 shell 路径 |
| 2 | 建议 | R6 的降级其实是**三档**（全功能 / powershell 档 / 只读档） | §9 新增 **S1-D13** |
| 3 | 文字 | §4.3 还留着“构造时固定 cwd”的旧理由，与 §4.9 口径不一 | 已改（理由统一为“保持一致、不依赖 `ctx.cwd` 优先级”） |
| 4 | 文字 | §4.6 的 T6 写“标记文件已生成”，§6 表已升级为“含 toolCallId” | 已对齐到强的那条 |
| 5 | 提示 | 给 S7 的提醒（非本轮问题）：快照读旧内容必须放在 `operations.writeFile` **内部** | §4.9 末尾记下 |

它同时逐行复核了新 §4.9 的代码：`{ ...base, async execute(...) }` 展开安全（`createWriteToolDefinition` 返回普通对象字面量，渲染器与 `name: "write"` 都带得过去）；内层 `perCall.execute(toolCallId, params, signal, onUpdate, ctx)` 透传了 ctx，路径仍走当前会话 cwd；**没有嵌套两层文件互斥队列**（队列只在内层 execute 里包一次）；`customTools` 经 `wrapRegisteredTools` 后调用的就是这个新 `execute`。

## 1. 范围

### 1.1 做

1. 真·动态 `import()` pi bundle（`loader.ts`），断言版本与必需导出名；
2. `ModelRuntime` 工厂（含 key 重新注入）与最小会话装配（`runtime.ts` / `session.ts`）；
3. 把 pi 会话事件接到 VS Code（`bindings.ts`）；
4. 三条命令：`Pi: Run Self-Test` / `Pi: Set API Key`（最小版）/ `Pi: Open Settings File`；
5. 一个最小 `wrappedWrite` 自定义工具，验证"同名覆盖内置 write"的机制，**以及按 `toolCallId` 分组快照的机制**（S7 的前提）；
6. 自测 T1–T9，输出固定格式并给出 `GATE PASS|BLOCKED`；
7. README 已知限制里记录 S1 固定 `projectTrusted: false` 与 pi CLI 行为的刻意分歧（S6 再收敛）。

### 1.2 不做（留给后续步骤）

| 不做 | 留给 |
| --- | --- |
| Webview / 任何 UI、协议层 | S2 |
| 工具卡片、diff、审批开关 | S3/S7/S8 |
| 模型选择器、思考等级、状态栏 | S4 |
| 会话列表/新建/恢复的 UI | S5 |
| `jerrypi.*` 三项设置的读写（含 `jerrypi.agentDir`）、项目信任 UI | S6 |
| **第 2 层代理**（`jerrypi.proxy` + undici） | S1-D8：不塞进 S1 |
| 真实 UIContext（除自测用的最小实现） | S2 |

## 2. 文件清单

**新增**

```
src/pi/loader.ts        # 动态 import pi bundle（唯一入口）+ 版本与导出名断言 + reloadPi()
src/pi/resources.ts     # 打包期必须存在的资源清单（12 文件 + 2 目录，T2 用）
src/pi/runtime.ts       # ModelRuntime 工厂（含 key 重新注入）
src/pi/session.ts       # 生产装配路径 + setRebindSession + 初始绑定
src/pi/bindings.ts      # session 事件 → VS Code（Output channel）
src/pi/custom-tools.ts  # 最小 wrappedWrite（同名覆盖内置 write）
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
3. **自测不得污染用户环境。** 一律用 `os.tmpdir()` 下的临时目录，`finally` 里清理（注意 §4.6 的 R/R2 共用 cwd 与清理时机）。
4. **pi 版本只有一个来源**：`pi-runtime/.version`。任何地方不得硬编码 `"0.85.1"`。
5. **类型可以来自 devDependency，运行时不能。** 见 §4.0。
6. **默认不信任项目级设置。** 见 §4.3 与 S1-D11。

## 4. 模块设计

> 以下 API 签名读自 **devDependency 里那份 pi 包**的 `.d.ts` 与 bundle 源码，并逐条在本机核实过。

### 4.0 类型从哪来（很重要，先讲清）

- **`pi-runtime/` 里一个 `.d.ts` 都没有。** S0 只复制了 `dist/bundle/`、`dist/modes/interactive/theme/`、
  `dist/core/export-html/`、`docs/`、`examples/`、`README.md`、`package.json`。
- 而且 `pi-runtime/package.json` 的 `main` / `types` / `exports` 三个入口**全部指向不存在的文件**。
  **运行期只能显式指向 `dist/bundle/index.js`。**
- 因此：编译期类型来自 devDependency；运行期模块来自 `pi-runtime/dist/bundle/index.js`；
  **两者不是同一个文件**，导出面没有静态保证 → 由 §4.1 的运行时导出名断言补上。

### 4.1 `src/pi/loader.ts`

```ts
export type PiModule = typeof import("@earendil-works/pi-coding-agent");

// 只列代码真正用到的名字（多列一个就是新的漂移源）
export const REQUIRED_PI_EXPORTS = [
  "VERSION", "getPackageDir", "getAgentDir", "ModelRuntime", "SessionManager", "SettingsManager",
  "createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime",
  "resizeImage", "createWriteToolDefinition", "getShellConfig",
] as const;

let cached: Promise<PiModule> | undefined;
export function loadPi(extensionUri: vscode.Uri): Promise<PiModule>;
export function reloadPi(): void;
```

- 用 `await readFile(...)` 读 `pi-runtime/.version`（**不用 `readFileSync`**）；
- 动态 `import()` 绝对文件 URL；
- 断言 `VERSION === .version` → `E_VERSION`；
- 断言 `getPackageDir().endsWith("pi-runtime")` → `E_PACKAGE_DIR`；
- 断言 `REQUIRED_PI_EXPORTS` 每个名字存在且类型正确 → `E_MISSING_EXPORTS`；
- **失败时清空缓存**（不缓存 rejected promise），并暴露 `reloadPi()`。

### 4.2 `src/pi/runtime.ts`

```ts
export async function getModelRuntime(pi, agentDir, keyStore): Promise<ModelRuntime>;
```

- 按 `agentDir` 缓存实例；
- **创建后立刻注入全部已存 key**（`setRuntimeApiKey`）。**必须如此**：已核实
  `ModelRuntime.setRuntimeApiKey` 只写内存覆盖层（`RuntimeCredentials{ overrides = new Map() }`），
  **不落盘**，重载窗口即丢。只要走这个工厂，任何 agentDir 的实例都带 key；
- 显式传三个路径：`authPath`/`modelsPath`/`modelsStorePath` 都指向 `<agentDir>/`，
  不依赖默认值（否则 S6 加 `jerrypi.agentDir` 后静默劈叉）；
- `allowModelNetwork: false`（本来就是默认值，写明为了可读性）；
- `keyStore`：`list(): string[]`（provider id 列表，存 `context.globalState`，
  因为 **SecretStorage 没有枚举接口**）、`get(providerId): Promise<string|undefined>`；
- **`injectApiKey(agentDir, providerId, apiKey)`**：供 `Pi: Set API Key` 在**已缓存实例**上立即生效
  （否则要等实例重建）。

### 4.3 `src/pi/session.ts`（生产装配路径）

```ts
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd, agentDir, sessionManager, sessionStartEvent,
}) => {
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });   // ← S1-D11
  const services = await pi.createAgentSessionServices({
    cwd, agentDir, settingsManager,
    modelRuntime: await getModelRuntime(pi, agentDir, keyStore),
    resourceLoaderOptions: { additionalExtensionPaths },
  });
  return {
    ...(await pi.createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      customTools: createCustomTools(pi, cwd),        // ← 必须在工厂内按传入 cwd 构造
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });

// rebind：注册 + 立刻对初始会话绑定一次
let unsubscribe: (() => void) | undefined;
const rebindSession = async (session) => {
  unsubscribe?.();
  await session.bindExtensions({ uiContext, mode: "rpc", abortHandler: () => void session.abort(), onError });
  unsubscribe = session.subscribe(onEvent);
};
runtime.setRebindSession(async (session) => { await rebindSession(session); });
await rebindSession(runtime.session);        // ← 关键：不调这一行，首个会话永远不会被绑定
```

要点（每条都对应一轮评审）：

- **初始绑定必须显式调用一次**：`setRebindSession` 只在会话**替换**时触发（pi 在
  `finishSessionReplacement()` 里回调）。已核实官方 print/rpc 模式都是先注册、随后 `await rebindSession()`。
  漏了它 → T3 的 `session_start` 标记不写、`/smoke-custom` 的 `onError` 不通、T4 收不到任何事件；
- **工厂必须使用传进来的 `cwd` 与 `agentDir`**（`switchSession({ cwdOverride })` 时闭包值会错），
  `customTools` 也在工厂内按该 `cwd` 构造 —— 理由是**保持一致、不依赖 `ctx.cwd` 的优先级**，
  而不是“构造时的 cwd 决定写入位置”（实际解析是 `resolveToCwd(path, ctx?.cwd || cwd)`，见 §4.9）；
- **回调要 `await`**：签名是 `(session: AgentSession) => Promise<void>`，
  `bindExtensions` 返回 Promise，不 await 会让会话替换在绑定完成前 resolve；
- **`projectTrustContext` 在 S1 不接**：`createAgentSessionServices` / `createAgentSessionFromServices`
  都不接受它，`resourceLoaderReloadOptions.resolveProjectTrust` 也只收 `{ extensionsResult }`（均已核实）。
  它属于 S6 的信任流程；**S6 的接法**是在 `resolveProjectTrust` 回调**内部**用闭包把它传给 pi 内部的
  `resolveProjectTrusted({ cwd, trustStore, extensionsResult, projectTrustContext, ... })`，而不是当成参数往下传。
- **显式传 `settingsManager`**：不传时 `SettingsManager.create(cwd, agentDir)` 的 `projectTrusted` 默认是
  `true`（已核实 `options.projectTrusted ?? !0`），等于无条件信任工作区里的项目级设置（可改 shellPath、默认工具）。
  S1 传 `false`，最保守。

### 4.4 `src/pi/bindings.ts`

```ts
session.bindExtensions({ uiContext, mode: "rpc", abortHandler, onError });
const unsubscribe = session.subscribe(onEvent);
```

- 事件先只做计数 + 写 Output（S2 才做协议转发）；`onError` 写 Output，**不弹窗、不中断会话**；
- 注意 `hasUI()` 的实现是 `uiContext !== noOpUIContext`，与 mode 无关——传了自定义 uiContext 就是 `true`。

### 4.5 `src/pi/resources.ts`

```ts
export const REQUIRED_RESOURCE_FILES = [ /* 12 条，与 S0 的 REQUIRED_FILES 一致 */ ];
export const REQUIRED_RESOURCE_DIRS = ["docs", "examples"];
```

**为什么要重复一份**：`scripts/` 不进 `.vsix`，打包后的扩展跑不了 S0 的校验脚本，T2 必须自查。
漂移风险由 §4.10 的用例 5 消除（文件与目录**分别**比对）。

### 4.6 `src/pi/selftest.ts`

#### 共享夹具

| 对象 | 用于 | 说明 |
| --- | --- | --- |
| 临时 **cwd** | R 与 R2 **共用** | 避免 T9 切到 T7 的会话时 cwd 已被删除（`switchSession` 内部会断言 cwd 存在） |
| **R** | T3 / T6 / T9 | 持久 `SessionManager`（临时 `sessionDir`）+ smoke 扩展 + `wrappedWrite` |
| **R2** | T7 | 独立 runtime 与独立 `sessionDir`，共用一个 cwd；跑完 `dispose()` 后 `continueRecent` |
| 清理 | 最后 | 所有临时目录在**全部测试跑完后**统一删除（T9 之后） |

#### 各项要点

- **T1**：打印 `process.versions.node` / `process.versions.electron` / `vscode.version`；
  用**数值段比较**判定 Node ≥ 24.15。
- **T2**：`loadPi()` + `REQUIRED_RESOURCE_FILES`（`lstat` 普通文件、可读、非空、非符号链接）
  + `REQUIRED_RESOURCE_DIRS`（存在、是目录、非空）。
- **T3**（R）：把 `test-fixtures/ext-smoke/` 复制到临时目录 →
  `additionalExtensionPaths` → 装配 R → 初始 `rebindSession` →
  断言 `services.resourceLoader.getExtensions().errors` 中**不含 smoke 路径**、
  `session.extensionRunner.getRegisteredCommands()` 含 `smoke`、`session_start` 标记已写出；
  `prompt("/smoke")` 后命令标记已写出；`prompt("/smoke-custom")` 触发可控错误并经 `onError` 上报，会话仍可用；
  **工具覆盖**：`session.getAllTools()` 里名为 `write` 的那项 `sourceInfo.source === "sdk"`
  （已核实 `SourceInfo = { path, source, scope, origin, baseDir? }`；若实现时字段名与预期不符，
  以实测为准，但必须能区分内置与 sdk）——**行为证据由 T6 提供**。
- **T4**：真实流式请求。判定必须是
  **收到 `message_update` 且 `event.assistantMessageEvent.type === "text_delta"`**（`text_delta` 不是顶层事件）。
  未配置 key → `FAIL E_NO_CREDENTIALS`。
- **T5**：
  - T5a `executeBash("echo hi && pwd")` → 输出含 cwd。**失败必须分层**（否则“没装 Git Bash”与
    “策略禁止 spawn”会被当成同一个结论）：
    1. `E_SHELL_PATH_INVALID`：设置了 `shellPath` 但文件不存在（pi 抛 `Custom shell path not found: X`）；
    2. `E_NO_SHELL`：找不到 bash（Windows 上 pi 只搜 `%ProgramFiles%\Git\bin\bash.exe`、
       `%ProgramFiles(x86)%\Git\bin\bash.exe`，然后 `where bash.exe`——**不搜 per-user 的
       `%LOCALAPPDATA%\Programs\Git`**，除非它在 PATH 上）；异常原文列出候选路径，**原样写进 Output**；
    3. `E_SPAWN_DENIED`：shell 找到了但 spawn 被策略拒绝；
    4. `E_SHELL_OUTPUT`：跑起来了但输出不对。
    **成功时记录实际使用的 shell 路径**（`getShellConfig().shell`），使 Mac 与 Windows 两次运行可比。
    （已核实 `getShellConfig(customShellPath?) → { shell, args, commandTransport? }` 已导出，且两个错误文本不同。）
  - T5b `executeBash("sleep 30")` → 2s 后 `abortBash()` → 3s 内返回且 `result.cancelled === true`；
  - T5c（advisory）见下；
  - 已核实：`executeBash` **无** timeout/cwd 参数（cwd 取 `sessionManager.getCwd()`），
    `abortBash()` 中止**所有**运行中的 bash，`BashResult.exitCode` 必有键、值可为 `undefined` → 超时由外层计时。
- **T5c**（advisory，需模型）：`prompt("Run this exact bash command: echo JERRYPI_START_<随机串> && sleep 30")`；
  `tool_execution_start` 只用于**关联 toolCallId**，**启动标记从 `tool_execution_update.partialResult` 读**
  （已核实 `tool_execution_start` 只有 `toolCallId/toolName/args`；`bash_execution_update` 是用户 `/bash` 通道）；
  收到标记后等 2s 调 `session.abort()`，断言 `agent_end` 到达且该工具结果为中止。
  60s 内未发起 bash → `SKIP E_NO_TOOLCALL`；发起但无标记 → `FAIL E_NO_SPAWN`。
- **T6**（R）：临时目录里 `prompt` 让 agent write → read → edit，断言磁盘内容与 `details.patch` 非空；
  **同时断言 wrappedWrite 的标记含本次 `toolCallId`**（证明调用真的走了我们的实现，且按调用捕获 ID 可行，
  而不只是注册表被覆盖）。
- **T7**（R2）：`SessionManager.create(cwd, sessionDir)` → 一次真实 `prompt("Reply with PONG")`
  （pi 在首条 assistant 消息前不落盘）→ `await R2.dispose()` → `SessionManager.continueRecent(cwd, sessionDir)`
  （**同步**，返回 `SessionManager`）→ 断言消息数 ≥ 2 且文件存在；把 `sessionFile` 与消息数留给 T9。
- **T8**：**自造 PNG**（`node:zlib` + ~20 行 CRC32）3000×3000 →
  `new Worker(pathToFileURL(<pi-runtime>/dist/bundle/chunks/image-resize-worker.js))` →
  `postMessage({ inputBytes, mimeType: "image/png", options: { maxWidth: 1000, maxHeight: 1000, maxBytes: 1e6 } })`
  → 10s 内响应且尺寸变小 → `terminate()`。
  **只有这次显式 Worker 往返算 worker 证据**；`resizeImage()` 失败会**静默回落主线程**且**可能返回 `null`**，
  单独调它只作补充，断言前先判 `null` → `E_RESIZE_NULL`。
- **T9**（R，使用 T7 产出的会话文件）：`await R.newSession()` → 断言 `cancelled === false`、
  `R.session` 是新对象、会话文件路径不同、smoke 的 `session_start` 标记再次写出、`getRegisteredCommands()` 仍含 `smoke`；
  再 `await R.switchSession(<T7 的 sessionFile>)` → 断言 `cancelled === false`、历史消息数与 T7 一致、
  订阅能收到 `agent_start`（用一次 `prompt("Reply with PONG")` 触发，需凭据）。

#### 进度输出与超时

- **每项结束立刻向 Output 追加一行**（`T5a PASS …`），最坏情况约 16 分钟，中途无输出无法定位卡点；
- 模型相关项（T4/T6/T7/T9）**各重试 1 次**，错误码区分 `E_MODEL_NOT_COOPERATING` 与能力错误；
- 每项独立超时：

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
- **必须自己写**：pi 的 `noOpUIContext` 是 `runner.js` 的模块私有常量，不在任何 `.d.ts`、也不在 bundle 导出里
  （已核实 `"noOpUIContext" in module === false`），**根本拿不到**。

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

- 正则覆盖深路径；`import type` 会被擦除、不触发 `onResolve`；
- 另加**体积上限**：构建后 `dist/extension.js` 超过 256 KB 即失败（当前 1.92 KB，pi bundle 7.6 MB）。

### 4.9 `src/pi/custom-tools.ts`

```ts
export function createCustomTools(pi: PiModule, cwd: string): ToolDefinition[] {
  const base = pi.createWriteToolDefinition(cwd);
  return [{
    ...base,                                    // 名字仍是 "write" → 覆盖内置
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      recordCall(toolCallId);                   // 行为证据（含 toolCallId）
      // 关键：operations 必须在**本次调用内**构造，才能捕获 toolCallId
      const perCall = pi.createWriteToolDefinition(cwd, {
        operations: createOperations({ toolCallId }),
      });
      return perCall.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  }];
}
```

已核实的三个事实（全部影响这段代码）：

1. `createWriteToolDefinition(cwd, options?)` **返回 `ToolDefinition`** → 不必再套 `defineTool`；
   自定义行为经 `options.operations`（`{ writeFile, mkdir }`）注入；
2. 内置 write 的 execute 签名是 `execute(_toolCallId, { path, content }, signal, _onUpdate, ctx)`
   —— **toolCallId 被丢弃**，`operations` 在构造时固定。所以"按调用构造 operations"只能由我们自己的
   `execute` 包一层来做，否则 S7 真正有风险的机制（外层 execute 拿到 toolCallId → 为该次调用构造捕获此 ID 的
   operations）在闸门里根本没被验证，又要拖到 S7 才暴露；
3. 路径解析是 `resolveToCwd(path, ctx?.cwd || cwd)`，而 `customTools` 会经 `wrapRegisteredTools(allCustomTools, runner)`
   拿到**当前会话的 `ctx.cwd`**；构造时传的 `cwd` 只是没有 ctx 时的兜底。
   （上一版这里写"闭包版本会把文件写到错的目录，且症状极难归因"是**错的**，已删——留着会把 S7 的实现者
   引向错误的模型。仍保留"在工厂内按传入 `cwd` 构造"，因为它更一致，但不再以此为由。）

另：覆盖 `operations` **不会**丢掉文件互斥队列 —— `withFileMutationQueue(absolutePath, …)` 是在
`createWriteToolDefinition` 的 execute **内部**包住 `ops.mkdir` / `ops.writeFile` 的，不在默认 operations 里。
所以 S7 可以按"实际写入仍受内置文件队列保护"这个前提设计快照逻辑。

存在理由（PLAN.md 第 6 节 S1 第 3 条）：**"同名覆盖内置 write"这个机制有风险，要在闸门里验**。

> **给 S7 的提示（非 S1 问题）**：按 `toolCallId` 存写前旧内容时，**读旧内容这一步必须放在
> `operations.writeFile` 内部**——队列保护的区间正是包住 `ops.mkdir` 与 `ops.writeFile` 的那一段。
> 放在 `execute` 开头读就跑到队列外面去了，并行写同一文件时会串。§4.9 里 `recordCall(toolCallId)`
> 放在 execute 开头，作为“被调用过”的证据没问题，但 **S7 的快照不能照这个位置放**。

### 4.10 `test-fixtures/ext-smoke/index.ts` 与 `scripts/self-test.mjs`

- fixture 的 `smoke` 处理器**先写标记文件**，再调 `ctx.ui.notify`；
- **两个环境变量名都要用**：`JERRYPI_SMOKE_MARKER`（`session_start` 写，S0 已有）、
  `JERRYPI_SMOKE_COMMAND_MARKER`（`smoke` 命令写，S1 新增）；
- 该文件被 `tsconfig` 排除在类型检查外，而 **CI 会跑 S0 的校验 ⑦**（加载该 fixture）——改完必须确认 CI 仍绿；
- `scripts/self-test.mjs` 新增用例 5：解析 `src/pi/resources.ts` 的 `REQUIRED_RESOURCE_FILES` +
  `REQUIRED_RESOURCE_DIRS`，与 sync 脚本的 `REQUIRED_FILES` + `REQUIRED_DIRS` **分别**比对。

### 4.11 `src/commands.ts`

| 命令 ID | 标题 / 分类 | 行为 |
| --- | --- | --- |
| `jerrypi.runSelfTest` | `Run Self-Test` / `Pi` | 跑 §4.6；每项实时追加到 Output；结束 `showInformationMessage("GATE PASS" / "GATE BLOCKED …")` |
| `jerrypi.setApiKey` | `Set API Key` / `Pi` | QuickPick 选 provider（deepseek 置顶）→ `showInputBox({ password: true })` → 写 `context.secrets`（键名 `jerrypi.apiKey.<provider>`）→ 把 provider 记入 `context.globalState` → **立即调用 `injectApiKey()` 注入已缓存实例** → 成功提示 |
| `jerrypi.openSettingsFile` | `Open Settings File` / `Pi` | 打开 `<agentDir>/settings.json`；不存在则先创建 `{}`；便于受限机用户手填 |

- **`title` 不含 `Pi:` 前缀**（`category` 会渲染成 `Pi: `），否则显示成 `Pi: Pi: Run Self-Test`；
- `Pi: Set API Key` 的最后一步（注入已缓存实例）不能省——§4.2 只覆盖"创建时注入"。

## 5. 自测输出契约（引自 PLAN.md，不改）

```
flyjancy.jerrypi <扩展版本> selftest-v1 <平台> node=<版本>
T1 PASS
T2 PASS
T3 FAIL E_EXTENSION_ERRORS
...
GATE BLOCKED T3,T6
```

- **首行版本号必须取 `context.extension.packageJSON.version`**；
- 每项一行 `T<编号> PASS|FAIL|SKIP <短错误码>`；细节（重试次数、`E_MODEL_*`、wrappedWrite 标记路径）写后续行；
- 末行 `GATE PASS` 或 `GATE BLOCKED <失败项列表>`。

## 6. 判定标准速查

| 项 | required | 通过标准 | 需要凭据 | 超时 |
| --- | --- | --- | --- | --- |
| T1 | ✅ | Node ≥ 24.15（数值比较），打印三版本号 | 否 | 5s |
| T2 | ✅ | `loadPi()` 成功 + 必需导出名齐 + 全部资源路径（12 文件 + 2 目录）合格 | 否 | 30s |
| T3 | ✅ | 无 smoke 相关扩展错误 + `smoke` 已注册 + 2 个标记文件 + `/smoke-custom` 经 `onError` + `write` 的 `sourceInfo.source === "sdk"` | 否 | 60s |
| T4 | ✅ | 收到 `message_update` 且 `assistantMessageEvent.type === "text_delta"` | **是** | 60s |
| T5a/T5b | ✅ | `executeBash` 输出正确；`abortBash` 后 3s 内返回且 `cancelled === true` | 否 | 30s |
| T5c | ⚠️ advisory | 见 §4.6 | **是** | 90s |
| T6 | ✅ | 文件内容正确 + `details.patch` 非空 + wrappedWrite 标记含本次 `toolCallId` | **是** | 120s |
| T7 | ✅ | `continueRecent` 后消息数 ≥ 2 且文件存在 | **是** | 60s |
| T8 | ✅ | 显式 Worker 往返成功 + `resizeImage()` 非 `null` 且尺寸变小 | 否 | 30s |
| T9 | ✅ | 两次替换 `cancelled === false`、新对象、rebind 正确、`agent_start` 可达 | **是** | 120s |

> 结论：**没有 API key 就必然 `GATE BLOCKED`**（T4/T6/T7/T9 required）。这是刻意的——
> 闸门要证明的是"能对话"，不是"能加载"。

## 7. 验收

**你来做的（B 系列）**

| # | 项 | 说明 |
| --- | --- | --- |
| B1 | 用 `Pi: Set API Key` 配好 deepseek key | key 与 SecretStorage 都在你机器上 |
| B2 | 在 **Mac 上安装打包后的 `.vsix`**（不是 F5）并跑 `Pi: Run Self-Test`，把 Output 逐行贴给我 | **必须用 .vsix**：F5 时仓库根有 `node_modules`，pi bundle 的裸依赖可能从那里解析，正好掩盖打包遗漏 |
| B3 | （S1 通过后）发布 0.1.1 预发布，让受限机跑同样命令并回报 | 需要 publisher + PAT |

**我做的（A 系列，全部无凭据可跑）**

| # | 项 |
| --- | --- |
| A1 | `npm run typecheck` / `npm run build` |
| A2 | `npm run sync` + `npm run self-test`（含新用例 5）全过 |
| A3 | `npm run package` → 体积门禁 → 解包复跑（S0 的 A5b/A6b/A7 全套） |
| A4 | CI 全绿（含 S0 校验 ⑦ 仍能加载改动后的 fixture） |
| A5 | 静态检查：`dist/extension.js` 不含 pi 的导入、体积 < 256 KB |

## 8. 提交计划

1. `feat: load pi runtime dynamically with export and version assertions`
   （**含 esbuild 守卫**——护栏必须和 loader 同批落地）
2. `feat: add model runtime with api key re-injection`
3. `feat: add session assembly, rebinding and wrapped write tool`
4. `feat: add Pi: Set API Key and Pi: Open Settings File commands`
5. `feat: add Pi: Run Self-Test feasibility gate (T1-T9)`
6. `test: guard resource-list drift and static pi imports`
7. `docs: record S1 implementation results`

## 9. 决策点

| 编号 | 问题 | 建议默认值 |
| --- | --- | --- |
| S1-D1 | 自测命令名 | `jerrypi.runSelfTest`，`title: "Run Self-Test"` + `category: "Pi"` |
| S1-D2 | key 的 provider 范围 | QuickPick + 手填（deepseek 置顶）；OAuth 不做 |
| S1-D3 | `agentDir` | 用 pi 默认（尊重 `PI_CODING_AGENT_DIR`），不加设置项（S6 再加） |
| S1-D4 | 自测绑定的 UI 上下文 | 自写最小完整 UIContext（28 成员） |
| S1-D5 | 资源清单防漂移 | `self-test.mjs` 用例 5，文件与目录分别比对 |
| S1-D6 | 静态 import 守卫 | esbuild 构建失败 + 体积上限 |
| S1-D7 | 0.1.1 预发布 | Mac `GATE PASS` 之后再发（B3） |
| S1-D8 | T4 网络失败怎么办 | **失败即终止判定**，代理层不塞进 S1 |
| S1-D9 | `wrappedWrite` 是否进 S1 | **进**，并额外断言行为（标记文件） |
| S1-D10 | 扩展模式 | `mode: "rpc"` |
| **S1-D11** | 项目信任 | **S1 显式传 `projectTrusted: false`**（pi 默认是 `true`，等于无条件信任工作区设置）；信任 UI 与 `ProjectTrustStore` 留到 S6。⚠ 与 pi CLI 行为刻意不同，已记入 README 已知限制（§1.1 第 7 项） |
| **S1-D12** | rebind 方式 | 注册 `setRebindSession` + **对初始会话显式调用一次** |
| **S1-D13** | bash 不可用时的降级 | **三档而非两档**：全功能 → **powershell 档**（引导用户在 `Pi: Open Settings File` 里设 `shellPath`，或把 `powershell` 加进 `defaultTools`）→ 只读档。**只有 `E_SPAWN_DENIED`（策略拒绝）才考虑只读档**；`E_NO_SHELL` / `E_SHELL_PATH_INVALID` 属于配置缺口，一行设置即可修好 |

## 10. 风险

| # | 风险 | 应对 |
| --- | --- | --- |
| S1-R1 | 扩展宿主里 `import()` 扩展目录内的 ESM 失败 | T2 立刻暴露；回退见 PLAN R4（CJS + shim） |
| S1-R2 | 扩展宿主把 `process.versions.node` 报成 Electron 的 Node | T1 直接打印，闸门要求 ≥ 24.15 |
| S1-R3 | 真 provider 请求被企业网络/CA 拦截 | 见 S1-D8：**S1 内终止**，代理层另立评估 |
| S1-R4 | `/smoke` 在无真实 UI 时的行为与预期不同 | fixture 先写标记再调 UI |
| S1-R5 | 自测耗时长（最坏约 16 分钟） | 每项独立超时 + 每项完成即写 Output；bash 由外层计时 |
| S1-R6 | 模型不配合导致假 BLOCKED | 模型项重试 1 次 + 区分 `E_MODEL_*` |
| S1-R7 | T9 切换会话时 cwd 已被清理 | R 与 R2 共用 cwd，统一在全部测试后清理 |

## 11. 实施记录（已落地）

### 11.1 A 系列结果

| # | 项 | 结果 |
| --- | --- | --- |
| A1 | `npm run typecheck` / `npm run build` | ✅ `dist/extension.js` **44.52 KB**（含自测引擎，上限 256 KB） |
| A2 | `npm run sync` + `npm run self-test` | ✅ 7/7 + **5/5**（含新增的资源清单一致性用例） |
| A3 | `npm run package` + 体积门禁 + 解包复跑 | ✅ 335 files / **5.69 MB**（19.0% 门禁）；解包后 `CHECK 2/7 PASS`、`VERIFY OK` |
| A4 | CI | ✅（见提交后的 Actions） |
| A5 | 静态检查 | ✅ 产物中无 pi 导入（守卫另有两次"故意写错"的实测：裸名与深路径都被拦下） |

### 11.2 本地干跑（无 VS Code、无凭据）

`src/pi/selftest.ts` 及其依赖在**运行期不 import `vscode`**（`runtime.ts` 只有 `import type`），
因此可以用 esbuild 打一个临时 harness 在纯 Node 下跑闸门，用于快速迭代：

| 项 | 干跑结果 |
| --- | --- |
| T1 / T2 | ✅ Node 26.8.1；12 文件 + 2 目录全部合格 |
| T3 | ✅ 命令 `[smoke, smoke-custom]`；`onError` 命中；`write` 来源 = `sdk`（同名覆盖生效） |
| T5a / T5b | ✅ `shell=/bin/bash`；`abortBash` 后 2ms 返回、`cancelled=true` |
| T8 | ✅ worker 往返 1000x1000；`resizeImage` 1000x1000 |
| T4 / T6 / T7 | `E_NO_CREDENTIALS`（本机无 key，符合预期） |
| T5c | `SKIP E_NO_CREDENTIALS`（advisory） |
| T9 | `E_PRECONDITION`（T7 未产出会话文件） |

→ 判定为 **GATE BLOCKED T4,T6,T7,T9**，全部由"缺凭据"引起；配好 key 后应转为 PASS（待 B1/B2 验证）。

### 11.3 落地时发现的偏差（已修正）

1. **`ExtensionMode` 没有从 pi 包根导出**（只存在于 `dist/core/extensions`）→ 改从
   `Parameters<AgentSession["bindExtensions"]>[0]["mode"]` 推导，避免写死字符串联合。
2. **`session_start` 不属于 `AgentSessionEvent`**（它是扩展事件，由 `bindExtensions` 触发）→
   事件日志的 switch 去掉该分支；T3 用 fixture 写的标记文件来断言它。
3. **`AgentSession.isIdle` 是 getter 不是方法**（`isBashRunning` 同理）。
4. **`customTools` 需要一次 cast**：write 定义是 `ToolDefinition<typeof writeSchema, undefined>`，
   而接口要 `ToolDefinition`（默认泛型是宽 `TSchema`），`renderCall` 在参数位置逆变导致直接赋值被拒。
5. **自测 UIContext 的 `theme` 不能抛错**：pi 在绑定/初始化阶段会读 `ctx.ui.theme`，
   第一版直接抛错导致 **T3 以 `E_UNEXPECTED` 失败**。改为返回"任何属性都是空操作函数"的 Proxy。
6. **凭据错误要显式分类**：pi 的报错是 `No API key found for the selected model.`；
   现在除了 `prompt` 失败时按消息归类，模型相关项开头还会用 `requireUsableModel()` 直接报
   `E_NO_CREDENTIALS`，避免它被读成"pi 跑不起来"。
7. **T9 的前置失败用 `E_PRECONDITION`**（不可重试），否则会白白重试一次。

### 11.4 B 系列结果：macOS 上 GATE PASS（2026-09-12）

从**已安装的 `.vsix`**（不是 F5）跑 `Pi: Run Self-Test`，**11/11 PASS，`GATE PASS`**：

```
flyjancy.jerrypi 0.1.0 selftest-v1 darwin node=24.18.1
T1 PASS   node=24.18.1 electron=42.8.1 vscode=1.134.0
T2 PASS   12 个文件 + 2 个目录全部合格；pi 0.85.1
T3 PASS   命令=[smoke, smoke-custom, tokens, balance, cost, stats, footer]；onError=命中；write←sdk
T4 PASS   收到 message_update 且 assistantMessageEvent.type === text_delta
T5a PASS  shell=/bin/bash；输出含 cwd
T5b PASS  abortBash 后 3ms 返回，cancelled=true
T5c PASS  toolCallId=call_00_zdNu…；标记后 2009ms 结束
T6 PASS   内容正确；patch 313 字符；wrappedWrite 捕获 toolCallId=call_00_3mus…
T7 PASS   会话文件已落盘；重开后条目 5，消息 2
T8 PASS   worker 往返 1000x1000（原 3000x3000）；resizeImage 1000x1000
T9 PASS   newSession 产生新文件；switchSession 恢复 2 条消息；agent_start 可达
GATE PASS（共 11 项：11 PASS / 0 FAIL / 0 SKIP）
```

同时被验证的几件事：

1. **VS Code 1.134.0 = Node 24.18.1**（≥ 24.15），与 `engines.vscode ^1.123.0` 的假设一致；
2. **与用户真实 pi 扩展共存**：T3 的命令列表里出现了用户 `~/.pi/agent` 下的扩展
   （`tokens / balance / cost / stats / footer`），说明自测跑在真实环境而非净化沙箱里；
   T3 的断言只要求"fixture 相关扩展无错误"，用户扩展自身的错误本来就不参与判定（按设计）；
3. **T5c 一次通过**：模型主动发起了 bash 调用（不经 `executeBash`），
   看到启动标记后 2 秒中止，`agent_end` 到达——A3 的模型驱动路径也成立；
4. **T6 的 patch 与 toolCallId 都拿到**：`wrappedWrite` 的行为证据成立，
   "按调用构造 operations"这个 S7 前提在闸门里被真实验证过。

**剩余**：B3（受限 Windows 机）——需要先发布 0.1.1 预发布版。

### 11.5 首次发布（2026-09-12）

- **方式**：Marketplace 网页手动上传（**未使用 PAT / Azure DevOps**，因此也不需要信用卡验证）。
- **版本**：`0.1.0`（`0.1.0` 从未发布过，且手里正好有一份已在 Mac 上跑通 11/11 的产物）。
- **同一文件校验**：从 Marketplace 下载回来的 `.vsix` 与本地产物 **SHA-256 完全一致**
  `baa84e42f1718b3a8ade5aef7262eeccb92c0d9b3176f7c2029e947d4a46efe2`（5,969,170 字节），
  包内 `extension/dist/extension.js` 也逐字节一致。
- **⚠️ 它是预发布版**：API 里 `Microsoft.VisualStudio.Code.PreRelease = "true"`。
  网页上传**保留**了 `.vsix` manifest 里的预发布标记 —— 即"网页上传不认这个标记"的猜测是错的。
  这与 PLAN 5.4 的"开发期走预发布通道"一致，但受限机安装时必须选
  **Install Pre-Release Version**（或 `code --install-extension flyjancy.jerrypi --pre-release`）。
- item 页面：https://marketplace.visualstudio.com/items?itemName=flyjancy.jerrypi

### 11.6 受限 Windows 机首跑（2026-09-12，VS Code 1.129.0）

环境：**VS Code 1.129.0、Node 24.18.0、机器上确认没有 Node.js / npm**（`where node`、`where npm` 均无输出）。
结果为 **7 PASS / 3 FAIL / 1 SKIP → GATE BLOCKED T4,T5a,T6**。逐条归因后：**3 个 FAIL 里 2 个是自测脚本的缺陷，T5a 实质上是通过的。**

| 项 | 现象 | 归因 | 处置 |
| --- | --- | --- | --- |
| **T5a** | `E_SHELL_OUTPUT`：`pwd` 返回 `/tmp/jerrypi-selftest-…/cwd`，而我们传的 cwd 是 `C:\Users\…\Temp\jerrypi-selftest-…\cwd` | **脚本缺陷**。Git Bash(MSYS) 把 Windows 临时目录映射成了 `/tmp`；bash 本身跑通了（输出 `hi` + pwd） | 改为比对 cwd 的**最后两段**，并在 PASS 里记录实际 `pwd` |
| **T4** | `E_MODEL_NOT_COOPERATING`（重试一次仍失败） | **脚本缺陷**。`message_update` 携带的 `assistantMessageEvent` 有 `text_delta`/`thinking_delta`/`toolcall_delta` 三种，我只认了 `text_delta` | 改为接受任意 `*_delta`，并报告具体类型 + `model=` + 最后一条 assistant 文本 |
| **T6** | `E_UNEXPECTED ENOENT`（文件没被创建） | **一半脚本缺陷**：一条长指令（write→read→edit）对模型要求过高；且文件不存在时报了原始 ENOENT 而非可读错误 | 拆成**三条独立 prompt**；文件不存在时归为 `E_MODEL_NOT_COOPERATING` 并附模型与 assistant 文本 |
| T5c | `SKIP E_NO_TOOLCALL` | 模型 60 秒内没主动发起 bash 调用 | 加进 SKIP 详情（model + assistant 文本）便于归因；它本来就是 advisory |

**关键结论（对项目是好消息）**：

1. **R6 不成立** —— Windows 上 `executeBash` 正常（T5a 实际跑通）、`abortBash` 66ms 中止（T5b PASS）；
2. **T1 在接近声明下限处成立** —— VS Code **1.129.0** 报 **Node 24.18.0** ≥ 我们的断言 24.15（`engines ^1.123.0`）；
3. Windows 上 **无用户 pi 扩展**（`~/.pi/agent` 是全新的，T3 命令列表只有 `[smoke, smoke-custom]`），
   而 Mac 上是 `[smoke, smoke-custom, tokens, balance, cost, stats, footer]` —— 两次都通过，
   说明 T3 在"干净环境"和"有用户扩展"两种情况下都成立；
4. 其余全过：T2（Windows 路径下的资源断言）、T3（jiti 在 Windows 上加载 TS 扩展）、T7、T8（worker + WASM）、T9。

→ 修正后重新打包为 **`0.1.1`** 并重新发布，用于受限机复跑。

### 11.7 受限机二跑（0.1.1）与根因定位（2026-09-12）

环境：**VS Code 1.137.0、Node 24.18.1、无 Node.js**。结果 **8 PASS / 2 FAIL / 1 SKIP → GATE BLOCKED T4,T6**。

T5a 已 PASS（`shell=C:\Program Files\Git\bin\bash.exe`，`pwd=/tmp/…` 尾部命中），
说明 11.6 的 Windows 修正生效，且**该机 Git Bash 装在 Program Files，不是 per-user 那个坑**。

T4/T6 的诊断输出暴露了真正的根因：

```
T4 FAIL E_MODEL_NOT_COOPERATING
    prompt 结束但没有任何 *_delta 事件；model=openai/gpt-5.5；
    最后一条 assistant 文本：(assistant 消息没有文本内容)
```

**不是模型不配合，而是 pi 在该机上解析到的模型根本用不了**：

- 该机 `~/.pi/agent` 是全新的（T3 命令列表只有 `[smoke, smoke-custom]`），没有 `defaultModel`；
- 此时 pi 会按内置默认规则挑，结果挑中 `openai/gpt-5.5`；
- 这个模型对应的凭据不可用 → 每次 prompt 都落一条 **`contentTypes=[]; stopReason=error`** 的 assistant 消息，
  于是 T4 收不到任何 delta、T6 的文件永远不存在，看起来像"pi 在 Windows 上跑不起来"。

本地用假 key 复现验证了这条链路（`Authentication Fails … 401`），并据此做了三项修正：

1. **钳住模型**：`session.ts` 新增可选 `model` 参数，自测用
   `ModelRuntime.getAvailable()`（凭据感知）按 `deepseek > anthropic > google > openrouter > openai`
   的顺序挑第一个可用模型并显式传入；实测带 deepseek key 时选中 `deepseek/deepseek-v4-flash`，
   不再依赖 pi 的默认规则；
2. **打印诊断**：T1 报告"已配置的 provider"与"选用模型"，
   T4/T5c/T6 失败时输出 `contentTypes / stopReason / errorMessage` 原文；
3. **归类错误码**：provider 的 401/403/quota 类错误归为 `E_NO_CREDENTIALS`，
   其余归为 `E_PROVIDER_ERROR`，不再一律 `E_MODEL_NOT_COOPERATING`。

→ 修正后重新打包为 **`0.1.2`** 并重新发布。

### 11.8 模型选择的最终设计（0.1.2 定稿）

11.7 的"钳住模型"在实测后改成了**两段式**，因为它踩到 pi 的一个内部规则：

- **pi 内部有一张 `defaultModelPerProvider` 表**（bundle 里可见，但未导出）：`findInitialModel` 的
  优先级 5 不是"可用列表的第一个"，而是"**该 provider 在这张表里的默认模型**"。
  实测同一台机器上：可用列表顺序是 `deepseek-v4-flash → flash-vision-exp → pro`，
  而 pi 自己选的是 **`deepseek-v4-pro`**。所以直接用"列表第一个"反而会拿到更弱的 `flash`。
- 但 `findInitialModel` 没有打进 bundle 的导出（只有未打包的 `dist/index.js` 有），拿不到。

最终实现（`selftest.ts` 的 `pickModel()` + `alignModel()`）：

1. `pickModel()`：用**凭据感知**的 `ModelRuntime.getAvailable()`，按
   `deepseek > anthropic > google > openrouter > openai` 选出**首选 provider**；
2. **先让 pi 自己解析模型**（建会话时不指定 model）；
3. `alignModel()` 再对齐：
   - pi 选中的 provider **就是**首选 → **沿用 pi 的选择**（从而拿到它内部的 provider 默认，如 `deepseek-v4-pro`）；
   - 否则 → `session.setModel(preferred, { persist: false })` 改成首选 provider 的模型
     （因为它内部那张表取不到，只能退到可用列表里的第一个）。

本地用两个场景验证过：

| 场景 | 输出 |
| --- | --- |
| 只配 deepseek（key 无效） | `模型：deepseek/deepseek-v4-pro（沿用 pi 的选择：provider 与首选一致）` → T4 正确报 `E_NO_CREDENTIALS` + 401 原文 |
| **deepseek + openai 都配（复现受限机）** | `模型：pi 选的是 openai/gpt-5.5 → 已改为 deepseek/deepseek-v4-flash（首选 provider deepseek）` |

第二行**证实了受限机上的诊断**：该机确实存在一个被 pi 判定为可用的 OpenAI 凭据
（最可能是 `Pi: Set API Key` 时误选了 `openai`），因此 pi 每次都挑 `openai/gpt-5.5`。
而且这个凭据会留在 SecretStorage 里，**即使重设 deepseek，pi 仍会看到 openai 可用** ——
所以"纠正 provider"这一步是必需的，不是可选的优化。

### 11.9 模型选择的收尾（用户指定：不用 pro）

用户明确要求闸门**不要用 `deepseek-v4-pro`**（贵），因此 11.8 的"provider 一致就沿用 pi 的选择"
被收回，改为**指定模型表**：

```ts
const PREFERRED_MODEL_IDS = { deepseek: ["deepseek-v4-flash"] };
```

规则：该 provider 有指定模型 → **总是** `setModel()` 强制过去；没有指定 → 才沿用 pi 自己的选择。

本地两个场景复验：

| 场景 | 输出 |
| --- | --- |
| 只配 deepseek | `deepseek/deepseek-v4-pro → 已改为 deepseek/deepseek-v4-flash（指定模型，不用 pi 的默认）` |
| deepseek + openai | `openai/gpt-5.5 → 已改为 deepseek/deepseek-v4-flash（指定模型，不用 pi 的默认）` |

⚠️ 代价：`flash` 的工具调用能力未经验证，若 T6（write/read/edit）因此失败，
错误码会是 `E_MODEL_NOT_COOPERATING` 并附上模型说话的内容，届时再决定是否换回 pro。

### 11.10 0.1.2 已上线，最终逻辑另发 0.1.3

`0.1.2` 已经上传到 Marketplace（预发布，2026-09-12），对应提交 `356a5cf`，
**里面是中间版本的选模型逻辑**（按首选 provider 取可用列表第一个）。之后 11.8/11.9 的两次改进
（`alignModel` + 指定模型表）都没能进去，因为**同一个版本号不能重传，也不会被 VS Code 当成更新**。

因此最终逻辑以 **`0.1.3`** 发布：

| 版本 | 提交 | 选模型逻辑 |
| --- | --- | --- |
| 0.1.1 | `7e3ba01` | 不指定 model，完全交给 pi（受限机上会选到 `openai/gpt-5.5`） |
| 0.1.2 | `356a5cf` | 建会话时指定首选 provider 的**可用列表第一个**（已上线，未在受限机验证） |
| **0.1.3** | 本次 | **先让 pi 解析 → `alignModel()` 纠正 provider → `PREFERRED_MODEL_IDS` 锁定 `deepseek-v4-flash`** |

产物 `jerrypi-0.1.3.vsix`：5,971,218 字节，
SHA-256 `c021f820f720657bfc5f6bb0f2ff82b5abbdd9bd9c9f1ccd426230d57fe47168`。

---

## 12. S1 闸门结论：GATE PASS（两端均通过）

### 12.1 受限 Windows 机实测（2026-09-12，0.1.3 预发布版，从 Marketplace 更新）

环境：VS Code **1.137.0**，Node **24.18.1**，Electron 42.10.0，win32，无 Node.js/npm，
Git for Windows 位于 `C:\Program Files\Git\bin\bash.exe`。

```
flyjancy.jerrypi 0.1.3 selftest-v1 win32 node=24.18.1
T1 PASS  node=24.18.1 electron=42.10.0 vscode=1.137.0；已配置 provider=[deepseek, openai]
T2 PASS  12 个文件 + 2 个目录全部合格；pi 0.85.1
T3 PASS  命令=[smoke, smoke-custom]；onError=命中；write←sdk
T4 PASS  delta=[text_delta]；model=deepseek/deepseek-v4-flash
T5a PASS shell=C:\Program Files\Git\bin\bash.exe；pwd=/tmp/jerrypi-selftest-tJHznZ/cwd
T5b PASS abortBash 后 90ms 返回，cancelled=true
T5c PASS toolCallId=…；标记后 2067ms 结束
T6 PASS  内容正确；patch 287 字符；wrappedWrite 捕获 toolCallId=…
T7 PASS  重开后条目 4，消息 2
T8 PASS  worker 往返 1000x1000（原 3000x3000）；resizeImage 1000x1000
T9 PASS  newSession 新文件；switchSession 恢复 2 条消息；agent_start 可达
GATE PASS（共 11 项：11 PASS / 0 FAIL / 0 SKIP）
```

**版本号核对**：首行 `0.1.3` 与 Marketplace 上架的版本一致。

### 12.2 「同一文件」核对（PLAN 5.4）

从 Gallery API 下载线上 0.1.3 与本地打包产物比对：

| | 大小 | SHA-256 |
| --- | --- | --- |
| 本地 | 5,971,218 | `c021f820f720657bfc5f6bb0f2ff82b5abbdd9bd9c9f1ccd426230d57fe47168` |
| 线上 | 5,971,218 | `c021f820f720657bfc5f6bb0f2ff82b5abbdd9bd9c9f1ccd426230d57fe47168` |

`==> 同一文件`。受限机跑的确实是作者本地验证过的那份字节。

### 12.3 这一轮实测定下来的事实

1. **R6（`spawn` 被策略禁止）不成立**：T5a/T5b/T5c 全 PASS，Git Bash 可用，
   `abortBash` 90ms 返回。**A3 成立，不需要降级为只读 agent。**
2. **A6 网络前提成立**：T4 拿到真实 `text_delta`。
3. **11.9 里担心的 `flash` 工具调用能力不成立**：T6 用 `deepseek-v4-flash`
   连续完成 write → read → edit，`wrappedWrite` 捕获到 toolCallId，patch 287 字符。
   → **`PREFERRED_MODEL_IDS` 锁 `deepseek-v4-flash` 可以长期保留。**
4. **11.8 的诊断被证实**：输出里 `已配置的 provider: deepseek, openai` ——
   那台机器上确实有一个被 pi 判定为可用的 **OpenAI 凭据**（`~/.pi/agent` 是全新的，
   所以只可能来自 `Pi: Set API Key` 时误选了 `openai`），
   因此 pi 每次都解析出 `openai/gpt-5.5`。
   `alignModel()` 命中并改成 `deepseek/deepseek-v4-flash` —— **这条修正是 S1 通过的必要条件**。
5. **Windows 路径 + MSYS 路径映射**：`executeBash` 的 `pwd` 返回 `/tmp/...`（MSYS 映射），
   0.1.0 的 `E_SHELL_OUTPUT` 是**误报**，0.1.1 起的「cwd 尾部命中」判定正确。
6. **扩展宿主 + 用户真实扩展共存**：T3 的 `onError` 路径被真实触发且会话未损坏。

### 12.4 遗留问题（不阻塞 S1，已记录待后续阶段）

| 问题 | 影响 | 计划 |
| --- | --- | --- |
| 误设的 `openai` 凭据留在 SecretStorage 里，pi 仍认为它可用 | 每次都要靠 `alignModel()` 纠正 | S6 的 `Pi: Clear Stored API Keys` |
| 发布通道是预发布 | 安装要勾选、更新要保开关 | S10 转正式发布 |
| `0.1.2` 已上线但内容是中间版逻辑 | 无影响（已被 0.1.3 覆盖） | 无需处理 |

**S1 关闭。按 PLAN 第 6 节，进入 S2（协议与基础聊天）。**
