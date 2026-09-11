# S1 实施计划：可行性闸门

> 状态：**待评审**（2026-09-11）。依据 [`PLAN.md`](PLAN.md) 第 6 节 S1、5.3、5.4；
> 已落地事实见 [`S0-plan.md`](S0-plan.md) §10。
>
> S1 不建 UI。它只回答一个问题：**pi 能不能在 VS Code 扩展宿主里、从 `pi-runtime/` 里真正跑起来，
> 并完成一次真实对话。** 答案是 `GATE PASS` 或 `GATE BLOCKED`，没有第三种。

## 0. 结论的用途

- `GATE PASS` → 进入 S2（协议 + Webview 聊天）。
- `GATE BLOCKED` → **不进入 S2**，回到 `PLAN.md` 第 4 节重新决策（例如降级为只读 agent）。
- 判定规则（抄自 PLAN.md）：**除 T5c 外，T1–T9 在受限 Windows 机上任一非 PASS 即 `GATE BLOCKED`；SKIP 不算通过。**
  T5c 为 advisory，其 FAIL/SKIP 都不参与判定，只记录。

## 1. 范围

### 1.1 做

1. 真·动态 `import()` pi bundle（`loader.ts`），并断言版本与 `pi-runtime/.version` 一致；
2. 建立 `ModelRuntime` 单例与最小会话装配（`runtime.ts` / `session.ts`）；
3. 把 pi 会话事件接到 VS Code（`bindings.ts`：`subscribe` + `bindExtensions`）；
4. 三条命令：`Pi: Run Self-Test` / `Pi: Set API Key`（最小版，写 SecretStorage）/ `Pi: Open Settings File`；
5. 自测 T1–T9，输出固定格式并给出 `GATE PASS|BLOCKED`。

### 1.2 不做（留给后续步骤）

| 不做 | 留给 |
| --- | --- |
| Webview / 任何 UI、协议层 | S2 |
| 工具卡片、diff、审批开关 | S3/S7/S8 |
| 模型选择器、思考等级、状态栏 | S4 |
| 会话列表/新建/恢复的 UI | S5 |
| `jerrypi.*` 三项设置的读写 | S6 |
| 真实 UIContext（除自测用的最小实现） | S2 |

## 2. 文件清单

**新增**

```
src/pi/loader.ts        # 动态 import pi bundle（唯一入口）+ 版本断言
src/pi/resources.ts     # 打包期必须存在的资源路径清单（T2 用，随扩展发布）
src/pi/runtime.ts       # ModelRuntime 工厂/缓存 + agentDir 解析
src/pi/session.ts       # 生产装配路径：services → session → runtime
src/pi/bindings.ts      # session 事件 → VS Code（Output channel）
src/pi/selftest.ts      # T1–T9 + GATE 判定 + PNG 生成工具
src/pi/selftest-ui.ts   # 最小 ExtensionUIContext（自测专用）
src/commands.ts         # 三条命令的注册
```

**修改**

```
src/extension.ts                    # activate() 里注册命令；保持非阻断
esbuild.mjs                         # 加「禁止值导入 pi」守卫
package.json                        # contributes.commands 增三条
test-fixtures/ext-smoke/index.ts    # smoke 处理器写标记文件（T3 需要证据）
scripts/self-test.mjs               # 新增第 5 用例：资源清单一致性
```

## 3. 不可违反的约束

1. **绝不静态 import pi。** 只能 `import type` + 运行时 `import()` 文件 URL。
   `esbuild.mjs` 加 `onResolve` 守卫：一旦出现值导入就**构建失败**（见 §4.8）。
2. **扩展宿主里不做同步 IO、不阻塞。** activate() 仍然只注册命令。
3. **自测不得污染用户环境。** 一律用 `os.tmpdir()` 下的临时 `cwd` / `agentDir`，
   `finally` 里清理；唯一例外是 T7 的持久会话（也在临时目录内）。
4. **pi 版本只有一个来源**：`pi-runtime/.version`（S0 已建立）。任何地方不得硬编码 `"0.85.1"`。

## 4. 模块设计

> 以下 API 签名全部读自 pi 0.85.1 的 `.d.ts`（`dist/core/*.d.ts`），不是猜的。

### 4.1 `src/pi/loader.ts`

```ts
export type PiModule = typeof import("@earendil-works/pi-coding-agent");

let cached: Promise<PiModule> | undefined;

export function loadPi(extensionUri: vscode.Uri): Promise<PiModule> {
  cached ??= (async () => {
    const bundlePath = join(extensionUri.fsPath, "pi-runtime", "dist", "bundle", "index.js");
    const expected = readFileSync(join(extensionUri.fsPath, "pi-runtime", ".version"), "utf8").trim();
    const pi = (await import(pathToFileURL(bundlePath).href)) as PiModule;   // 关键：动态 import 文件 URL
    if (pi.VERSION !== expected) throw new Error(`E_VERSION pi=${pi.VERSION} runtime=${expected}`);
    if (!pi.getPackageDir().endsWith("pi-runtime")) throw new Error("E_PACKAGE_DIR");
    return pi;
  })();
  return cached;
}
```

要点：

- 失败时缓存 **rejected promise** —— 不要吞掉错误后允许重试导致状态不一致；命令层负责把错误显示给用户。
- `import()` 的实参是变量，esbuild 不会尝试打包它。

### 4.2 `src/pi/runtime.ts`

- `resolveAgentDir()`：优先用 pi 的 `getAgentDir()`（它已经处理 `PI_CODING_AGENT_DIR`），
  S1 不引入 `jerrypi.agentDir` 设置（S6 再做）。
- `getModelRuntime(pi, agentDir)`：按 `agentDir` 缓存单例。

```ts
pi.ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsStorePath: join(agentDir, "models-store.json"),
  allowModelNetwork: false,     // S1 不联网刷模型目录，避免不可控等待
})
```

⚠ 已核实（PLAN.md 5.3 的教训）：**这个单例必须真的传进 `createAgentSessionServices({ modelRuntime })`**，
否则 `Pi: Set API Key` 设的 key 不会生效。

- `setApiKey(pi, agentDir, providerId, apiKey)`：`runtime.setRuntimeApiKey(providerId, apiKey)`（`Promise<void>`）。

### 4.3 `src/pi/session.ts`（生产装配路径）

完全照 pi 官方 SDK 文档的 runtime 装配，不自创：

```ts
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await pi.createAgentSessionServices({
    cwd, agentDir, modelRuntime,
    resourceLoaderOptions: { additionalExtensionPaths },
  });
  return {
    ...(await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, customTools })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
```

- `sessionManager`：S1 用 `pi.SessionManager.create(cwd, sessionDir)`；T7 验证 `continueRecent`。
- 返回 `{ runtime, services, rebind() }`；`rebind()` 在每次 `newSession()/switchSession()` 后调用。

### 4.4 `src/pi/bindings.ts`

```ts
session.bindExtensions({ uiContext, mode: "print", abortHandler: () => void session.abort(), onError });
const unsubscribe = session.subscribe(onEvent);
```

- 事件先只做一件事：按类型计数并写进 Output channel（S2 才做协议转发）。
- `onError` 把扩展错误写到 Output，**不弹窗、不中断会话**。
- 已核实的绑定语义（`ExtensionBindings`）：`{ uiContext?, mode?, commandContextActions?, abortHandler?, shutdownHandler?, onError? }`。

### 4.5 `src/pi/resources.ts`

导出 `REQUIRED_RESOURCE_PATHS: readonly string[]`（相对 `pi-runtime/`），与 S0 的 `REQUIRED_FILES` 同集合：

```
package.json, README.md, dist/bundle/index.js, dist/bundle/cli.js, dist/bundle/rpc-entry.js,
dist/bundle/chunks/image-resize-worker.js, dist/modes/interactive/theme/dark.json,
dist/modes/interactive/theme/light.json, dist/core/export-html/template.html,
node_modules/@earendil-works/chord/dist/context/index.js, node_modules/jiti/package.json,
node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm
```

**为什么要重复一份**：`scripts/` 不进 `.vsix`，所以打包后的扩展无法运行 S0 的校验脚本，T2 必须在扩展内自查。
漂移风险由 §4.9 的第 5 个自测用例消除。

### 4.6 `src/pi/selftest.ts`

输出契约见 §5。内部实现要点：

- **T1**：`process.versions.node` / `process.versions.electron` / `vscode.version`；断言 Node ≥ 24.15。
- **T2**：`loadPi()` + 遍历 `REQUIRED_RESOURCE_PATHS`（`lstat` 普通文件、可读、非空、非符号链接）。
- **T3**：把 `test-fixtures/ext-smoke/` 复制到临时目录 → 临时 `cwd`/`agentDir` →
  `additionalExtensionPaths: [<临时目录>/index.ts]` → 走 §4.3 装配 → `bindExtensions` →
  断言 `services.resourceLoader.getExtensions().errors` 中**不含 smoke 路径**（用户自己扩展的错误单独列诊断，不参与判定）、
  `session.extensionRunner.getRegisteredCommands()` 含 `smoke`、`session_start` 标记文件已写出；
  `prompt("/smoke")` 后命令标记文件已写出；`prompt("/smoke-custom")` 触发可控错误并经 `onError` 上报，会话仍可用。
- **T4**：真实 provider 流式请求。前置：用户已用 `Pi: Set API Key` 配好 deepseek。
  未配置 → `FAIL E_NO_CREDENTIALS`（属配置缺口而非能力缺口，需提示先设 key）。
- **T5**：
  - T5a `session.executeBash("echo hi && pwd")` → `BashResult.output` 含 cwd；
  - T5b `executeBash("sleep 30")` → 2s 后 `abortBash()` → 3s 内返回且 `result.cancelled === true`；
  - T5c（advisory）`prompt("Run this exact bash command: echo JERRYPI_START_<随机串> && sleep 30")`，
    用 `tool_execution_start` 关联 toolCallId；**看到启动标记后**再等 2s 调 `session.abort()`，
    断言 `agent_end` 到达且该工具结果为中止。60s 内模型未发起 bash → `SKIP E_NO_TOOLCALL`；
    发起了但没收到标记 → `FAIL E_NO_SPAWN`。
    已核实字段：`BashResult = { output, exitCode?: number, cancelled: boolean, truncated, fullOutputPath? }`。
- **T6**：临时目录里通过 `prompt` 让 agent write → read → edit，断言磁盘内容与 edit 结果 `details.patch` 非空。
- **T7**：`SessionManager.create` 持久会话 → 一次真实 `prompt("Reply with PONG")`（pi 在首条 assistant 消息前不落盘，
  只 append user 消息会假失败）→ `dispose()` → `SessionManager.continueRecent(cwd, sessionDir)` 重开 →
  断言消息数 ≥ 2 且文件存在。
- **T8**：图片 worker。**自造 PNG**（`node:zlib` + 20 行 CRC32，不引第三方库）生成 3000×3000 纯色图 →
  `new Worker(pathToFileURL(<pi-runtime>/dist/bundle/chunks/image-resize-worker.js))` →
  `postMessage({ inputBytes, mimeType: "image/png", options: { maxWidth: 1000, maxHeight: 1000, maxBytes: 1e6 } })`
  → 10s 内收到响应且尺寸变小 → `terminate()`；再单独调 `resizeImage()` 断言尺寸变小。两者都要过。
  已核实的 worker 协议：请求 `{ inputBytes, mimeType, options? }`，响应 `{ result }` 或 `{ error }`。
- **T9**：在第 7 项的 runtime 上 `await runtime.newSession()` → rebind → 断言新 `session` 对象、
  会话文件路径不同、smoke 的 `session_start` 标记再次写出、`getRegisteredCommands()` 仍含 `smoke`；
  再 `await runtime.switchSession(<第 7 项会话文件>)` → rebind → 断言历史消息数与第 7 项一致、
  订阅能收到 `agent_start`。

### 4.7 `src/commands.ts`

| 命令 ID | 标题 | 行为 |
| --- | --- | --- |
| `jerrypi.runSelfTest` | `Pi: Run Self-Test` | 跑 §4.6，结果写 Output 并 `showInformationMessage("GATE PASS/BLOCKED")` |
| `jerrypi.setApiKey` | `Pi: Set API Key` | QuickPick provider（默认 deepseek，内置列表）→ `showInputBox({ password: true })` → 写 `context.secrets`（key 名 `jerrypi.apiKey.<provider>`）→ `setRuntimeApiKey` → 成功提示 |
| `jerrypi.openSettingsFile` | `Pi: Open Settings File` | 打开 `<agentDir>/settings.json`（不存在则先创建空 `{}`），便于受限机用户手填 |

`src/pi/selftest-ui.ts`：实现**完整的** `ExtensionUIContext`（~35 个方法，绝大多数 no-op），
其中 `notify` 写 Output、`custom: async () => { throw new Error("jerrypi: custom UI not available"); }`。
**故意不用 pi 的 `noOpUIContext`**（已核实 `custom: async () => {}` 会静默成功，测不出 `onError` 路径）。

### 4.8 `esbuild.mjs` 守卫

```js
plugins: [{
  name: "forbid-static-pi-import",
  setup(build) {
    build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
      errors: [{ text: "禁止静态 import pi；请用 import type + src/pi/loader.ts 的动态 import()" }],
    }));
  },
}]
```

`import type` 会被 esbuild 擦除、不触发 `onResolve`，所以这条只会在真的写错时炸。

### 4.9 `test-fixtures/ext-smoke/index.ts` 与 `scripts/self-test.mjs`

- fixture 的 `smoke` 处理器**先写标记文件**（`process.env.JERRYPI_SMOKE_COMMAND_MARKER`），再调 `ctx.ui.notify`：
  T3 需要"命令真的执行了"的硬证据，而 `notify` 在 no-op UI 下什么都不会发生。
- `scripts/self-test.mjs` 新增用例 5：解析 `src/pi/resources.ts` 与 `scripts/sync-pi-runtime.mjs` 的路径字面量，
  断言两者集合一致（防止 shipped 清单与打包清单漂移）。

## 5. 自测输出契约（抄自 PLAN.md，不改）

```
flyjancy.jerrypi <扩展版本> selftest-v1 <平台> node=<版本>
T1 PASS
T2 PASS
T3 FAIL E_EXTENSION_ERRORS
...
GATE BLOCKED T3,T6
```

- 首行必须能被作者肉眼核对版本号（防"跑的不是我发布的版本"）。
- 每项一行 `T<编号> PASS|FAIL|SKIP <短错误码>`。
- 末行 `GATE PASS` 或 `GATE BLOCKED <失败项列表>`。
- 错误码用短常量（`E_VERSION`、`E_PACKAGE_DIR`、`E_NO_CREDENTIALS`、`E_NO_SPAWN`…），细节写 Output 的下几行。

## 6. 判定标准速查

| 项 | required | 通过标准 | 需要凭据 |
| --- | --- | --- | --- |
| T1 | ✅ | Node ≥ 24.15，打印三版本号 | 否 |
| T2 | ✅ | `loadPi()` 成功 + 12 条资源路径全部合格 | 否 |
| T3 | ✅ | 无 smoke 相关扩展错误 + `smoke` 已注册 + 2 个标记文件 + `/smoke-custom` 经 `onError` | 否 |
| T4 | ✅ | 收到 `text_delta` | **是** |
| T5a/T5b | ✅ | `executeBash` 正确；`abortBash` 3s 内 `cancelled` | 否 |
| T5c | ⚠️ advisory | 见 §4.6 | **是** |
| T6 | ✅ | 文件内容正确 + `details.patch` 非空 | **是** |
| T7 | ✅ | `continueRecent` 后消息数 ≥ 2 且文件存在 | **是** |
| T8 | ✅ | Worker 往返 + `resizeImage()` 都变小 | 否 |
| T9 | ✅ | 替换后 rebind 正确；`agent_start` 可达 | **是** |

> 结论：**没有 API key 就必然 `GATE BLOCKED`**（T4/T6/T7/T9 required）。这是刻意的——
> 闸门要证明的是"能对话"，不是"能加载"。

## 7. 验收

**你来做的（B 系列）**

| # | 项 | 说明 |
| --- | --- | --- |
| B1 | 用 `Pi: Set API Key` 配好 deepseek key | 我无法代做（key 与 SecretStorage 都在你机器上） |
| B2 | Mac 上 F5 → `Pi: Run Self-Test` → 把 Output 逐行贴给我 | 关键证据 |
| B3 | （S1 通过后）发布 0.1.1 预发布并让受限机跑同样命令 | 需要 publisher + PAT |

**我做的（A 系列，全部无凭据可跑）**

| # | 项 |
| --- | --- |
| A1 | `npm run typecheck` / `npm run build` |
| A2 | `npm run sync` + `npm run self-test`（含新用例 5）全过 |
| A3 | `npm run package` → 体积门禁 → 解包复跑（S0 的 A5b/A6b/A7 全套） |
| A4 | CI 全绿 |
| A5 | 静态检查：确认 `dist/extension.js` 中**不含** `@earendil-works/pi-coding-agent` 的导入（守卫的实测证据） |

## 8. 提交计划

1. `feat: load pi runtime dynamically with version assertion`
2. `feat: add minimal session assembly and vscode bindings`
3. `feat: add Pi: Set API Key and Pi: Open Settings File commands`
4. `feat: add Pi: Run Self-Test feasibility gate (T1-T9)`
5. `test: guard resource-list drift and static pi imports`
6. `docs: record S1 implementation results`

按上述粒度分开提交，便于出问题时二分。

## 9. 决策点

| 编号 | 问题 | 建议默认值 |
| --- | --- | --- |
| S1-D1 | 自测命令名 | 命令 ID `jerrypi.runSelfTest`，标题 `Pi: Run Self-Test` |
| S1-D2 | API key 的 provider 范围 | S1 只做 QuickPick 选 provider + 手填 key（deepseek 置顶）；OAuth 不做（PLAN 范围外） |
| S1-D3 | `agentDir` | S1 用 pi 的默认（尊重 `PI_CODING_AGENT_DIR`），不加 `jerrypi.agentDir` 设置（S6 再加） |
| S1-D4 | 自测绑定的 UI 上下文 | **绑定最小完整 UIContext**（而非 noOp），以便覆盖 `onError` 路径 |
| S1-D5 | 资源清单防漂移 | 用 `scripts/self-test.mjs` 用例 5 守护 |
| S1-D6 | 静态 import 守卫 | esbuild `onResolve` 直接构建失败 |
| S1-D7 | 0.1.1 预发布 | S1 在 Mac 上 `GATE PASS` 后再发（B3） |

## 10. 风险

| # | 风险 | 应对 |
| --- | --- | --- |
| S1-R1 | VS Code 扩展宿主里 `import()` 一个位于扩展目录的 ESM 文件失败（路径/权限/ASAR 类问题） | T2 会立刻暴露；回退方案见 PLAN R4（CJS + shim） |
| S1-R2 | 扩展宿主把 `process.versions.node` 报成 Electron 的 Node | T1 直接打印，闸门要求 ≥ 24.15 |
| S1-R3 | 真 provider 请求被企业网络/CA 拦截 | T4 失败 → 按 PLAN 5.3 第 2 层代理配置后重测 |
| S1-R4 | `prompt("/smoke")` 触发的扩展命令在没有真实 UI 时行为与预期不同 | fixture 先写标记再调 UI；T3 只断言标记与不崩溃 |
| S1-R5 | 自测耗时过长（含多次真实模型调用） | 每项独立超时（T4 60s、T5c 60s、T8 10s…），超时即 FAIL 并给出错误码 |
