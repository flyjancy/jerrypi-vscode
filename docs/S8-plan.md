# S8 计划：工具审批三档 + 项目信任流程（`approval.ts` + `trust.ts`）

> 状态：**计划期，待评审**（先过评审窗确认默认值，用户说"可以"后才动代码）。
> 上游：`docs/PLAN.md` §6 的 S8（含 2026-09-14 用户拍板追加的"项目级设置信任流程"）、§5.3 的
> "工具审批"与"配置来源遵循 pi 自己的约定"两条、§5.1 的 `src/pi/approval.ts`（待建）。
> 前置：S7 已关闭（0.1.9）。本阶段**不改** pi 的会话/文件格式，也不新增运行时依赖。
> 本步的验收（PLAN 原文，两条）：
> 1. **开 `all` 后每次工具调用停在面板等确认；拒绝后 agent 收到 block 原因；待审批时点中止，待审批项被清除且 agent 结束。**
> 2. **项目级设置的信任流程**（今天固定 `projectTrusted: false`；具体形态 PLAN 明写"留到 S8 计划期按流程走"）。
> 相关判据：G5/G6 不受影响；R8（agent 默认全权限）由本阶段第一次给出**用户可控的闸门**。

## 0. 本计划已核实的事实（都带证据，不靠记忆）

对着 pi 0.85.1 的产物 + **我实跑出来的探针**逐条核过（2026-09-15，隔离临时目录，不碰用户 `~/.pi/agent`）。
**下面每一条都决定了本计划的一个设计选择。**

> **探针已落盘，可重跑**（`npm run sync` 之后）：
> `node scripts/probes/s8-approval-probe.mjs`（§0.1 的 F1–F8）、`node scripts/probes/s8-trust-probe.mjs`（§0.2 的 F11–F15）。
> 两个脚本自己断言并打印实测值，末尾打 `OK`；它们是**证据**，不是门禁的一部分（不进 `self-test`）。

### 0.1 工具审批：钩子在哪、什么时候问、拦住之后长什么样

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `tool_call` 事件由**扩展**注册（`pi.on("tool_call", handler)`），处理器拿 `(event, ctx)`：`event = { type, toolName, toolCallId, input }`（内置工具有各自的窄类型），`ctx.signal` 是**当前这一轮 agent run 的 AbortSignal**（不在跑就是 `undefined`） | `dist/core/extensions/types.d.ts:678-724`、`:209-236`（`signal` 的注释）；`agent-session.js:2063` 的 `getSignal: () => this.agent.signal`；`extensions/runner.js:745-762`（`createContext()` 后逐个 handler 调用） |
| F2 | ⚠️ **`tool_call` 在 `tool_execution_start` 之后触发**（pi 文档原话："Fired after `tool_execution_start`, before the tool executes"）——所以**审批时卡片已经存在**（`pending: true`）。探针实测事件序：`tool_execution_start → tool_execution_end → agent_settled`（拒绝时）／`tool_execution_start → tool_execution_update → tool_execution_end → agent_settled`（允许时） | `pi-runtime/docs/extensions.md:780`；探针 §2 的「事件序」行；`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:293-345`（`executeToolCallsSequential` 的 `:298` 与 `executeToolCallsParallel` 的 `:334` 都是**先** `emit({type:"tool_execution_start"})`、**再** `await prepareToolCall(...)`） |
| F3 | `beforeToolCall`（= `tool_call` 的宿主）返回 `{block:true, reason}` → **工具不执行**，落一条 `isError:true`、正文 = `reason` 的 toolResult；`terminate:true` 只在**整批**都被拦时提前结束 | `node scripts/probes/s8-approval-probe.mjs` §2 的原文：`deny: marker=false results=[{"toolName":"bash","isError":true,"text":"Rejected by user: bash"}]`；`allow: marker=true`；`pi-agent-core/dist/agent-loop.js:412-435`（`beforeToolCall` 在 `:413`、`block` 分支在 `:426`）；`types.d.ts:818-827`（`terminate` 的注释） |
| F4 | ⚠️ **处理器抛错不是"放行"也不是"我们的原因"**：`emitToolCall` 不 catch（对比 `emitToolResult` 是 catch 的），错误一路冒到 `_installAgentToolHooks` 包成 `Extension failed, blocking execution: …`，最终变成一条**我们看不懂的** error toolResult。⇒ 我们的处理器**任何路径都不许抛** | `extensions/runner.js:745-762` vs `:693-724`；`agent-session.js:220-236`；`agent-loop.js:412-435` 的 catch |
| F5 | 同一个 assistant 消息里的**多个工具调用是"逐个预检"**（前一个没答完，后一个连 `tool_execution_start` 都还没发）⇒ 面板上**同时只会有一个待审批项** | `agent-loop.js:330-352`（`executeToolCallsParallel` 的 for 循环里 `await prepareToolCall`）、`:293-310`（串行版同）；`pi-runtime/docs/extensions.md:786`（"sibling tool calls are preflighted sequentially, then executed concurrently"） |
| F6 | 待审批时调用 `session.abort()`：① 我们注册在 `ctx.signal` 上的监听**立刻触发**；② 这一轮会**再调一次模型**（这一步是 pi 的固定流程），模型流尊重 signal 时它返回 `stopReason:"aborted"` → `agent_end` + `agent_settled`；③ 落盘结果是 `Operation aborted`（**不是**我们给的 reason）；④ `pendingToolCalls` 清空、`isIdle === true`、`prompt()` resolve | `scripts/probes/s8-approval-probe.mjs` §3 的原文：`挂起中：isStreaming=true pending=["call-1"]` → `中止后：outcome=resolved isIdle=true pending=[]`、`signal 触发=true marker=false results=[{"isError":true,"text":"Operation aborted"}]`、`模型被调用的次数=2` |
| F7 | ⚠️ **假模型驱动必须尊重 signal**：模型流无视 `signal.aborted` 而继续吐工具调用时，agent 循环会**无限转**（abort 后每个 turn 重新预检一次），探针里表现为每 ~10ms 重复一次 handler，永不结束（我第一版探针就是这么挂住的）。`runLoop` 唯一的退出条件是 `message.stopReason === "error" \| "aborted"` | `pi-agent-core/dist/agent-loop.js:78-171`（整个 runLoop 里**没有** `signal.aborted` 检查；出口只有 `:129` 的 stopReason=error/aborted、`:159` 的 `shouldStopAfterTurn`、`:170` 的「没有更多消息」）；`scripts/probes/s8-approval-probe.mjs` 的 `scriptedStream` 注释 |
| F7b | ⚠️ **被审批拦下的工具调用也不会终止循环**：pi 会把"被拒绝"的 toolResult 喂回模型**再问一次**，所以脚本化假模型必须"第一次吐工具调用、之后收尾"（一条纯文本 `stop`）；否则就是 F7 的另一种挂法（探针第二版挂在这里）。真实世界里的对应现象是"模型换个做法，或者再撞一次审批" | `scripts/probes/s8-approval-probe.mjs` 的 `scriptedStream` 注释（两版探针都挂过）；`pi-agent-core/dist/agent-loop.js:86`/`:132`/`:141`（`hasMoreToolCalls = !executedToolBatch.terminate` ⇒ 模型下一轮还吐工具调用就继续转） |
| F8 | 可以**不用模型、不用凭据、不联网**地跑完整的工具调用：把 `session.agent.streamFunction` 换成脚本化的假流（一个 async iterable + `result()`），再给那个 provider 塞一把**内存** key（`modelRuntime.setRuntimeApiKey`）骗过 `prompt()` 的前置检查。⚠️ **那把假 key 会留在那个 `ModelRuntime` 里**：`getModelRuntime()` 按 agentDir 缓存 ⇒ 用它做断言的会话必须配一个**临时 agentDir**，否则后面「哪些 provider 已配置」的判断会看到一把假 key（自测里会干扰 T4/T6/T7/T9 的模型选择） | 探针 §2：真 `bash` 工具真的执行了（`allow: marker=true`、`deny: marker=false`）；`pi-agent-core/dist/agent.js:39`（`streamFunction` 是 public 字段）、`agent-loop.js:176-248`（`for await (const event of response)` 在 `:199`，只要求 async iterable + `result()`）；`agent-session.d.ts:105` 的 `agent: Agent` |
| F9 | 我们自己的 `write` 包装**不会绕过审批**：评审第 11 轮已实跑确认"审批拒绝时包装层的 `writeFile` 未被调用、文件未创建、无快照产生" | `docs/PLAN.md:514`（DeepSeek 复核第 11 轮） |
| F10 | pi 官方文档自己给的审批写法就是"`ctx.ui.confirm` + `{block:true, reason}`"；我们的 `ExtensionUIContext.confirm` **已经落实了 `signal` 与 `timeout`**（取消时主动关掉已弹出的对话框） | `pi-runtime/docs/extensions.md:68-75`；`src/host/uiContext.ts` 的 `withDialog` |

### 0.2 项目信任：pi 谁在什么时候问、答案存在哪、信任之后有什么变化

| # | 事实 | 证据 |
| --- | --- | --- |
| F11 | SDK 路径**支持注入信任裁决**：`createAgentSessionServices({ resourceLoaderReloadOptions: { resolveProjectTrust } })` —— loader 会先跑一遍"未信任"的扩展加载（`includeInlineFactories: true`，所以我们自己的 inline 扩展在场），再把这个钩子 **await** 出结果，然后 `settingsManager.setProjectTrusted(...)` + 重新 reload 设置。⚠️ **loader 不替我们判断"要不要问"**：只要传了钩子，哪怕 cwd 里一个 `.pi/` 资源都没有，它照样调用一次 ⇒「没资源就别问」这条短路必须写在**我们的**裁决函数里 | `dist/core/agent-session-services.js:53-70`（`await resourceLoader.reload(options.resourceLoaderReloadOptions)`）；`dist/core/resource-loader.js:262-273`；探针 §2 的四行输出（`预信任阶段的扩展数=1` × 3 次、以及"没有 .pi 资源 + 照样传钩子 → 钩子次数=1"） |
| F12 | ⚠️ **只有三个符号从 bundle 导出**：`hasTrustRequiringProjectResources`、`ProjectTrustStore` 是真函数；`resolveProjectTrusted` / `getProjectTrustOptions` / `emitProjectTrustEvent` **不在导出面**（只在 CLI 那个 chunk 里）。⇒"问什么、怎么问"要我们自己定（不必逐字复刻 CLI 的选项文案），但**判据来源（trust.json 格式、父子继承、canonical 路径）必须用 pi 自己的类** | `scripts/probes/s8-approval-probe.mjs` §1 打印的十个 `typeof`；`grep` bundle 导出表 |
| F13 | 信任之后**真的会变**（可观察）：`settingsManager.isProjectTrusted() === true`，且项目级 `.pi/settings.json` 的值生效。可用的观察点有 `theme`（只证明"设置被读了"）与 **`defaultTools`**（会改 `getActiveToolNames()`）；**本计划的断言与人工验收都选后者** —— 它在 `sdk.js` 里决定 `getActiveToolNames()`（不传 `tools` 选项时），是**面板里看得见**的效果 | `scripts/probes/s8-trust-probe.mjs` §2 的原文：`[钩子→true] → 之后{trusted:true theme:proj-theme tools:[read]}`、`[钩子→false] → {trusted:false theme:global-theme tools:[read,bash,edit,write]}`、`[不传钩子（今天的现状）] → tools:[read,bash,edit,write]`；`dist/core/sdk.js:139-146`（`configuredDefaultToolNames` → `initialActiveToolNames`） |
| F14 | `hasTrustRequiringProjectResources(cwd)`：`<cwd>/.pi/{settings.json,extensions,skills,prompts,themes,SYSTEM.md,APPEND_SYSTEM.md}` 或 `<cwd 或祖先>/.agents/skills` 存在即为 true；用户自己的 `~/.agents/skills` **不算**。没有这些资源时 CLI 根本不问（直接视为信任） | `dist/core/trust-manager.js:141-165`；`scripts/probes/s8-trust-probe.mjs` §1：`hasTrustRequiring(proj)=true / (agentDir)=false` |
| F15 | `ProjectTrustStore(agentDir)` 的落盘位置是 **`<agentDir>/trust.json`**，格式是 `{ "<canonical cwd>": true\|false }`；`get(cwd)` 会**逐级向上找最近的记录**（父目录的裁决被子目录继承），两侧都先过 `canonicalizePath`；`set(cwd, null)` 删除该键 | `scripts/probes/s8-trust-probe.mjs` §3（`trust.json` 原文里的 canonical 路径、`子目录继承：get(sub/deep)=true`、`set(proj,null)` 之后只剩父目录那条）；`dist/core/trust-manager.js:11-45`、`:165-198` |
| F16 | ⚠️ **信任决策不能靠面板问**：钩子是在 `controller.ensure()` 里被 await 的，而面板的 `state` 重放要等 `ensure()` 返回 —— 用面板问就是自锁。⇒ 信任询问必须是 **VS Code 原生对话框** | `src/host/chatView.ts`（`ready` → `await controller.ensure()` → `this.replay()`）；F11 的调用点 |
| F17 | `session.reload()` **不会**重跑信任钩子（它调 `resourceLoader.reload()` 时不传 options），所以改判信任要么新建会话、要么重载窗口 | `dist/core/agent-session.js:2217-2230`；`ResourceLoaderReloadOptions` 只在 `reload(options)` 里读（`resource-loader.js:264`） |
| F18 | 现状：我们**固定** `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`，并且没传 `resourceLoaderReloadOptions` ⇒ 项目级资源一律不加载、也不问 | `src/pi/controller.ts:340`、`:396`；`src/pi/session.ts:73` |

### 0.3 现状：接哪儿、别碰哪儿

| # | 事实 | 证据 |
| --- | --- | --- |
| F19 | 协议是 **v5**；`ChatItem` 的工具项已有 `pending` / `diff` / `openablePaths` / `title` 等字段，`ClientMessage` 已有 `openDiff` 这一档。**没有**任何审批字段 | `src/shared/protocol.ts` |
| F20 | `SessionHostController` 是"每个面板一个、活到卸载"的宿主；`SessionHost`（含 runtime/session）会在替换时重建。**跨会话存活的东西挂在 controller 上**（S7 的 `fileChanges` 就是这么放的），`resetLiveState()` 是替换后的统一清理点 | `src/pi/controller.ts` 的 `afterSessionChange` / `resetLiveState` / `diffStore` |
| F21 | 工具卡片的渲染有**两条路径**且必须一致：`render.ts` 的 `renderToolCard`（断言用）与 `main.ts` 的 `renderTool`（真机用，就地更新 `view.head` + `view.body`）。S3 的"箭头只在一份里"就是被这件事咬过的 | `src/webview/render.ts:286-315` 的注释；`src/webview/main.ts:241-300` |
| F22 | 点击**一处委托**在捕获阶段（`data-open-path` / `data-open-diff`），键盘可达性另有一条 `onTranscriptKeydown`；两者的判据是"渲染层给不给可点元素"与"host 层认不认"**两层同判** | `src/webview/main.ts:520-583`；`src/host/chatView.ts:216-236` |
| F23 | 配置侧：`jerrypi.approvalMode` 已声明（`enum: off/mutating/all`、`scope: machine`），描述里写着"**尚未生效（S8）**"；`readApprovalModeSetting()` 已存在。`capabilities.untrustedWorkspaces` 已声明的值是 `supported:false` | `package.json` 的 `contributes.configuration`、`capabilities`；`src/host/config.ts` |
| F24 | `scripts/settings-check.mjs` 用一张**写死的状态词表**把 `package.json` 的描述与 README 中英双语钉在一起（`未实现/not implemented`、`尚未生效/not effective yet`、`已生效/effective`）⇒ 把审批改成"已生效"必须**同时**改 README 两处，否则门禁红 | `scripts/settings-check.mjs:33-40`（词表）、`:101-137`（README 三行与 `package.json` 的状态必须**两边都命中同一个档**） |
| F25 | 版本规则：`0.1.x` 是预发布通道，`0.2.0`（偶数次）才是**第一个正式版**；`CHANGELOG.md` **推迟到 0.2.0 才建**、从 0.2.0 起写 ⇒ **S8 仍是 0.1.x，不建 CHANGELOG** | `docs/PLAN.md` §5.4（两处原文） |

## 1. 目标与判据

**目标**：给"agent 能执行任何东西"这件事装上用户可控的闸门，并让项目级配置的加载变成用户显式同意的事。

| # | 判据（PLAN 验收的逐条拆解） |
| --- | --- |
| C1 | `jerrypi.approvalMode = off` 时行为**与今天完全一致**（一次都不问、一个字节都不多发）。 |
| C2 | `mutating` 时：`edit` / `write` / `bash` / `powershell` / **所有未知（含扩展注册的）工具**在面板上停在"等待确认"；`read` / `grep` / `find` / `ls` 直接放行且不产生任何审批记录。 |
| C3 | `all` 时：**每次**工具调用都停一下。 |
| C4 | 点"拒绝" → 工具**没有执行**（副作用不存在），agent 收到的 toolResult 是 `isError` 且正文含我们给的**可读原因**。 |
| C5 | **待审批时点中止** → 待审批项从面板与内部状态里清除、agent 结束（`isIdle`）、工具没有执行。 |
| C6 | 待审批项在面板重开后**还在**（以 toolCallId 为键重放，还能答）。 |
| C7 | 项目里带 `.pi/` 资源时，**第一次**打开面板会问一次"是否信任这个文件夹"；选"信任并记住"之后：项目级设置**真的生效**（`defaultTools` 可见地改变可用工具集），并且**不再问**（读 `<agentDir>/trust.json`）。 |
| C8 | 选"不信任"时项目设置**不生效**，且**不留**一个面板里改不掉的记录（有命令可以改判）。 |
| C9 | 不写用户的 `~/.pi/agent` 之外的东西；`trust.json` 只写**用户明确选择"记住"**的那一次。 |

## 2. 本步做什么 / 不做什么

**做**：

1. `src/pi/approval.ts`：三档判定（纯函数）+ 审批记录表（pending / 已决）+ `InlineExtension` 工厂
   （`tool_call` → 问面板 → `{block:true, reason}`）。
2. 装配接线：`createSessionHost` 收下 `approval`（mode 取值回调 + 提问方），把它作为
   `resourceLoaderOptions.extensionFactories` 注册；controller 持有审批表、发协议、暴露 `decideApproval`。
3. 协议 v6：工具项加 `approval?: "pending" | "denied"`；`ClientMessage` 加 `approvalDecision`。
4. 面板：卡片上的「允许 / 拒绝」（两条渲染路径 + 真 DOM 点击 + 键盘）；状态行加一句
   "有 N 个工具调用等待确认"的可点提示（**避免卡片滚出视口后静默卡住**）。
5. 宿主：`chatView` 路由审批决定；面板**不可见**时弹一条通知（点击聚焦面板）。
6. `src/pi/trust.ts`：信任裁决（memo / `trust.json` / `defaultProjectTrust` / 注入的"问"回调）；
   `src/host/trustPrompt.ts`：VS Code 模态询问；新命令 **`Pi: Project Trust…`**（`jerrypi.projectTrust`：
   信任并记住 / 信任父文件夹 / 仅本次 / 不信任 / 清除记录）—— 要同时改 `package.json` 的 `contributes.commands`
   与 `src/commands.ts`。
7. 自测加 **T14**（工具审批，**不用模型**，见 F8）——于是 `check:gate`（无头真宿主）与 Windows W0 都会自动覆盖审批。
8. 文档：`package.json` 里 `approvalMode` 的描述（"已生效" + 三档语义）、README 中英的**四处**
   （配置表 `:69`/`:243`、已知限制 中`:156`/英`:322` 的"没有确认环节"、中`:163`/英`:331` 的"项目级设置不被信任"、
   特性表 `:42`/`:219`）；`pi-traps` 两条新坑（见 §0.1 的 F7/F7b 与 F11）。
   **顺带补一处 S7 漏改**：README 的特性表还把 Diff 审阅写成"计划中（S7）"（中 `:41`、英 `:218`），
   而 S7 早已关闭（0.1.9）—— 在同一片文档里顺手改成"已实现"，理由与位置都写在这里，不算夹带。

**不做**（每条都有理由）：

| 不做 | 理由 |
| --- | --- |
| 用 `ctx.ui.confirm`（模态）做**审批**的默认交互 | 卡片就在转写里，拒绝要给"是哪次调用"的上下文；模态会遮住它。F10 记下了官方 example 的写法，作为 Q1 的备选 |
| "允许本批次剩下的所有调用" / "本会话内不再问这个工具" | F5：同时只有一个待审批项，"剩下的"在 UI 上还不存在；"不再问"是**降低**安全档位的捷径，要单独设计（本轮不做） |
| 让审批拦住 **bash 里写文件**这类间接副作用 | 做不到也不该假装做到：`bash` 本身就是一档权限。README 已知限制写明"批准 `bash` = 批准那条命令能做的一切" |
| 复刻 `emitProjectTrustEvent`（把 `project_trust` 发给用户装的扩展） | 符号没导出（F12），复刻要自己定"第一个非 undecided 胜出"的语义，而我们**没有第二份实现可以对照**（AGENTS.md §2 的"能红验证"过不了）。方向是安全的：少一个自动同意，多问一次。记已知限制（Q7） |
| 把信任决策写进 VS Code 的 `globalState`/配置 | 两份真相：CLI 读 `trust.json`，面板读别处。用户会看到"终端里信任了、面板里还问" |
| 在面板/`globalStorage` 里持久化审批记录 | 审批是**此刻**的事；重启后旧卡片的「允许」按钮点下去只会更困惑（Q6 的 `denied` 标记已经够用） |
| 网络/证书（`jerrypi.proxy`）、模型目录、diff —— | 分别为 S6 已决、S9/S10 范围 |

## 3. 关键设计

### 3.1 审批的数据形状与生命周期（`src/pi/approval.ts`）

```ts
export type ApprovalMode = "off" | "mutating" | "all";
export function parseApprovalMode(raw: unknown): ApprovalMode;      // 非法值 → "off"（并记一次）
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export function needsApproval(mode: ApprovalMode, toolName: string): boolean;

export interface ApprovalRequest {
  toolCallId: string; toolName: string;
  /** pi 风格的标题（bash 是命令、write/edit 是路径），复用 serialize.ts 的 titleOf */
  title: string;
  requestedAt: number;
}
export type ApprovalOutcome = "allow" | "deny" | "cancelled";

/** 审批表：既是 controller 的状态，也是扩展拿到的"提问方"。 */
/** 造审批表的参数（`onPending` = 面板侧"有人要问"的信号，由 controller 注入）。 */
export function createApprovals(options: {
  onPending: (request: ApprovalRequest) => void;
  log: { appendLine(line: string): void };
  maxDecided?: number;
}): Approvals;

export interface Approvals {
  ask(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalOutcome>;
  /** 面板答一次。返回 false = 没有这条待审批（可能已经中止/已答过）。 */
  decide(toolCallId: string, decision: "allow" | "deny"): boolean;
  /** 会话替换/卸载时调用：把待审批的全部以 cancelled 结掉并清空。 */
  reset(): void;
  get(toolCallId: string): ApprovalRecord | undefined;
  /** 协议派生（与 S7 的 diffFieldsOf 同一个位置、同一个理由）。 */
  fieldsOf(toolCallId: string, pending: boolean): { approval?: "pending" | "denied" };
  size(): { pending: number; decided: number };
}
```

四条写死的语义：

1. **`ask` 永不抛错、永不无限挂**：`signal.aborted` 在进入时先查一次；否则注册 `abort` 监听
   → 解析成 `"cancelled"`。**这是 F6 的直接落地**（中止时 pi 会把这一轮 abort 掉）。
2. **只有 `pending` 才可能被答**：`decide` 对已决/未知的 id 返回 `false`，**不抛错**（面板可能重发、
   也可能拿到一个过期 id）；host 侧对这一类记一行 Output（"看着能点却没反应"是最烦的失败形态）。
3. **已决记录只为"回放一次拒绝"存在**：`denied` 在工具结束后仍派生出去（卡片留一个标记），
   `allow` 结束就什么都不派生。**已决记录条数封顶（200，FIFO），待审批项永不淘汰** ——
   否则一个长会话会把还没答的那条挤掉（与 S7 §3.6 的"墓碑不能占活记录额度"是同一类错误）。
4. **`cancel` 不是一个 UI 状态**：`cancelled` 解析出去之后，`fieldsOf` 什么都不派生（卡片回到普通
   "运行中/已中止"形态）——因为此时 pi 给模型看的是 `Operation aborted`（F6），我们再多标一句
   "已取消"只会让人以为是我们干的。

`InlineExtension` 工厂（`createApprovalExtension({ mode, approvals, log })`）就是 F10 的形状：

```ts
api.on("tool_call", async (event, ctx) => {
  if (!needsApproval(mode(), event.toolName)) return undefined;      // 放行 = 什么都不返回
  const outcome = await approvals.ask({...}, ctx.signal);            // 绝不抛（见上）
  if (outcome === "allow") return undefined;
  return { block: true, reason: `Rejected by user: ${title}` };      // cancelled 也走这里
});
```

**不做 `terminate`**（F3：它只在整批都被拦时生效，而我们要让模型有机会换个做法）。

### 3.2 装配与"谁在什么时候问"

```
controller.ensure()
  └─ createSessionHost({ …, approval: { mode: readApprovalModeSetting, approvals: this.approvals } })
       └─ createAgentSessionServices({ …, resourceLoaderOptions: { extensionFactories: [approvalExtension] } })
            └─ pi 在**每次** prepareToolCall 时 emit("tool_call")
                 └─ approvals.ask()  → onPending → controller 就地更新那张卡片（approval:"pending"）
                                      → host 侧（面板不可见时发一条通知）
                 └─ 面板发 {type:"approvalDecision"} → chatView → controller.decideApproval(id, d)
                                                → ask() 的 promise resolve → 工具放行或 block
```

- **mode 每次调用现读**（`readApprovalModeSetting`）：`approvalMode` 是 `machine` scope，改了不需要
  重载窗口（与 `agentDir` 不同，S6 的 §3.1 已经把这三种设置的重载代价分开写清了）。
- **`approvals` 挂在 controller 上**（F20）：跨会话替换活着，替换时由 `reset()` 清空。
- **`onPending` 在 `ask` 内部同步调用**，所以"卡片先出现（F2）→ 立刻加上按钮"是同一帧里的事。

### 3.3 面板：两条渲染路径 + 一处委托

| 位置 | 增量 |
| --- | --- |
| `protocol.ts` | 工具项加 `approval?: "pending" \| "denied"`；`ClientMessage` 加 `{type:"approvalDecision"; toolCallId: string; decision: "allow"\|"deny"}`；`PROTOCOL_VERSION` → 6 |
| `serialize.ts` | `SerializeContext` 加 `approvals`；工具项按 `fieldsOf()` 派生（**实时与重放共用**，与 S7 的 diff 字段同一个位置） |
| `controller.ts` | ① `onToolExecutionStart` 建卡后按审批表补一次派生；② `onPending` 时**就地重发同 id 的 item**；③ `snapshot()` 里"运行中的卡片"那条路同样补派生（面板重开靠它，C6）；④ `decideApproval()` / `approvals.reset()` |
| `render.ts` | `renderToolCard` 里在**标题按钮之后、正文之前**插一行 `<div class="tool-approval">`：`pending` → `<button data-approve="<id>">允许</button><button data-deny="<id>">拒绝</button>` + 一句提示；`denied` → `<span class="tool-note">已拒绝</span>`。**用真 `<button>` 而不是 `<a role=button>`**：它不在标题按钮**内部**（HTML 解析器会把嵌套的 `<button>` 拆掉），所以不需要 S7 那套妥协 |
| `main.ts` | `createToolView` 多一个 `view.approval`（在 head 与 body 之间，常驻可见——折叠时也要能答）；点击委托加 `data-approve`/`data-deny` 两条（**`stopPropagation` 掉，不能顺带展开/折叠**）；`onTranscriptKeydown` 同规格；状态行 `#status` 在有待审批时多一句可点提示（点了滚动到最后一张待审批卡片） |

### 3.4 项目信任（`src/pi/trust.ts` + `src/host/trustPrompt.ts`）

**裁决顺序**（复刻 CLI 的语义，去掉 `--approve/--no-approve` 这个 CLI 专有开关）：

```
resolve(cwd):
  1) memo 里有 → 用它                       // 同一个进程里同一个 cwd 只裁决一次（CLI 的 projectTrustByCwd）
  2) !hasTrustRequiringProjectResources(cwd) → true（不问）      // F14
  3) trustStore.get(cwd) !== null → 用它（**不问**）             // F15：CLI 写的 false 我们照样尊重
  4) settings.json 的 defaultProjectTrust：always → true / never → false（不问）
  5) ask(cwd) → { trusted, remember }
        remember → trustStore.set(cwd, true)     // ⚠️ 只写 true，从不写 false（Q5）
        memo.set(cwd, trusted)
```

- **`ask` 的宿主实现**（`src/host/trustPrompt.ts`，F16 决定了它必须是原生对话框）：
  `vscode.window.showWarningMessage(<为什么问 + 哪个文件夹>, { modal: true }, "信任并记住", "仅本次信任", "不信任")`；
  **返回值 `undefined`（ESC/关掉）一律当"不信任且不写文件"**。
- **`Pi: Project Trust…` 命令**（QuickPick）：信任并记住 / 信任父文件夹（记住）/ 仅本次信任 / 不信任（仅本次）/
  清除这里的记录 → 具体动作落到 pi 的 `ProjectTrustStore`；命令结束后**清 memo** 并提示"新建会话生效"
  （F17：`session.reload()` 不重跑钩子）。
- **`extensionsResult` 这个入参我们不用**（不做 `project_trust` 事件，Q7）；签名照样吃下它，便于将来接上。

### 3.5 与 S7 的组合、以及"什么变了"

- `write` 的审批与 S7 的前后快照**天然不冲突**：拒绝 → 包装层根本没被调用（F9）⇒ 也就没有快照记录，
  卡片上不会出现"点了 diff 是空的"这种事（S7 的 A10 已经钉住"失败的调用不给 diff 入口"这个方向）。
- 信任打开之后**多出来的东西**（必须写进 README）：项目级 `.pi/settings.json`（可改 `shellPath`、
  `defaultTools` 等）、`.pi/extensions/*`、`.pi/skills`、`.pi/prompts`、`SYSTEM.md`、项目级包。
  **它改不了 `jerrypi.approvalMode`** —— 那是 VS Code 的 `machine` scope 设置（S6 的 Q9 就是为此定的），
  这条要写进 README，它是"仓库带一份 `.vscode/settings.json` 就能关掉审批"这个风险的正面回答。

### 3.6 上限与内存

审批表只存标量（id/toolName/title/decision/时间），一条几十字节；`title` 进协议前按 200 字符截断
（复用 `SUMMARY_MAX` 的量级）。**待审批项数天然 ≤ 1**（F5），所以没有"待审批积压"的上限问题；
已决记录 200 条封顶（FIFO，见 §3.1 第 3 条）。

## 4. 决策与默认值（Q1–Q9，等用户拍板）

| # | 问题 | 默认（我的建议） | 备选 / 为什么不选 |
| --- | --- | --- | --- |
| Q1 | 审批交互放哪 | **面板卡片上的「允许/拒绝」** + 面板不可见时一条可点通知 | 全用 VS Code 模态（官方 example 的写法，F10）：模态遮住转写、也答不了"是哪次调用"；但它代码更少 |
| Q2 | `mutating` 覆盖哪些工具 | **除 `read/grep/find/ls` 以外全部**（含未知/扩展工具） | 只列 `edit/write/bash` → 扩展工具静默放行，与 PLAN §5.3 明写的"未知工具默认确认"相反 |
| Q3 | 拒绝的理由文案（模型也读得到） | `Rejected by user: <标题>`（标题超 200 字符截断） | 中文理由：用户读着顺，但与 pi 自己的 `Rejected by user` 不一致 |
| Q4 | 待审批时点中止 | 用 `ctx.signal` 结掉 → 返回 block（**pi 落盘的是 `Operation aborted`**，不是我们的 reason，F6）；卡片不留"已取消"标记 | 撤掉 pi 的 abort 流程（做不到）；在卡片上再造一个状态（多一个状态就多一处分叉） |
| Q5 | 信任询问的形态与"记不记住" | **VS Code 模态三按钮**（信任并记住 / 仅本次 / 不信任）；ESC = 不信任且不写文件；**只写 `true`**，从不写 `false` | 照 CLI 那样把 `false` 也记下来：面板里没有天然的"改判"入口，一个误点就变成永不再问（我们用 §3.4 的那个命令补这个缺口，但**不主动**写 false） |
| Q6 | `project_trust` 扩展事件 | **不做**（记已知限制）：全局扩展里声明"我信任某些目录"的用户，在面板里会被多问一次 | 复刻 `emitProjectTrustEvent`：符号没导出（F12），语义只能靠猜，且没有第二份实现能对照（§2 不做清单） |
| Q7 | `defaultProjectTrust` 是否生效 | **生效**（`always`/`never` 直接短路，不问） | 忽略它：那是用户写在 pi `settings.json` 里的显式表态，"配置来源遵循 pi 自己的约定"（PLAN §5.3） |
| Q8 | 状态行要不要那句"有 N 个工具调用等待确认" | **要**（可点、跳到最后一张待审批卡片） | 不要：卡片滚出视口时用户只看到"生成中…"，属于**静默**卡住 |
| Q9 | 面板不可见时的通知 | **弹一条信息通知**（"有工具调用等待确认：<标题>"，按钮"打开面板"） | 不弹：面板没开面板就永远卡住；换成模态（=备选 Q1） |

## 5. 风险

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 审批的"安全"被误解为"沙箱" | 用户以为拒绝按钮能防住一切 | README 明写：批准 `bash` = 批准那条命令能做的一切；审批拦的是**工具调用**，不是文件系统 |
| R2 | 假模型驱动（F8）写错：忘了尊重 signal（F7）、或忘了「工具调用之后要收尾」（F7b） | 断言自身**挂死**（不是失败 —— CI 上会一直占着） | 驱动的三条纪律写进断言注释：① `opts.signal.aborted` → `stopReason:"aborted"`；② 第一次吐工具调用、之后收尾；③ 每条 `prompt()` 都套超时（`Promise.race`） |
| R3 | 面板不可见 / 卡片滚出视口 = 静默卡住 | 用户以为扩展坏了 | Q8 的状态行提示 + Q9 的通知；两条都有断言 |
| R4 | 会话替换后待审批项残留 | 新会话里冒出一个答不了的按钮 | `afterSessionChange` → `approvals.reset()`（F20），并有断言 |
| R5 | `trust.json` 的路径写法与 CLI 分叉（同一个文件夹两把钥匙） | "终端里信任了、面板里还问" | 一律经 pi 的 `ProjectTrustStore`（F15 的 canonical 化在它内部）；我们**不自己拼 JSON**（与 AGENTS.md §4 的"不自己拼会话 JSONL"同一条纪律） |
| R6 | 信任之后项目扩展**能**注册 `tool_call` 处理器 | 看起来像"项目能绕过审批" | 裁决顺序决定了绕不过（我们的 inline 扩展总会给出 block，`emitToolCall` 取第一个 block，F1/F3）；README 写一句 |
| R7 | pi 升版后 `tool_call` / `resolveProjectTrust` / `setProjectTrusted` 漂移 | 审批静默失效（最坏：`tool_call` 不再触发，而"没问"看起来像"放行了"） | 断言全部放在**跑真 pi 的 host-check** 与 **T14**（不是纯函数层）；升级 pi 时先跑 `check:gate` |
| R8 | `createAgentSessionServices` 里那个钩子被 `await` 在**面板首次重放之前**（F16） | 信任询问用了面板 → 死锁（面板永远空着） | 设计上写死"信任只能用原生对话框"；断言里不存在面板路径 |
| R9 | `readApprovalModeSetting()` 返回非法值（用户手改 settings.json） | 静默降级成 `off` = 以为有闸门其实没有 | `parseApprovalMode` 非法值 → `off` + **Output 记一行**，并且自测 T14 断言这条路径 |

## 6. 检查清单（自动断言，先红后绿）

**每条都要先看它红**（改坏被测实现 → 断言必须失败），**且不许对着想象中的实现写**。
**放哪一条不是随手定的**：不需要凭据的一律进**无凭据也能跑**的脚本（与 S7 §6 的分工结论一致：
`controller-check` 没凭据时整体 SKIP，而 SKIP 不是 PASS）；只有真模型那两条进 `controller-check`。

| # | 断言 | 放哪 | 能红验证 |
| --- | --- | --- | --- |
| A1 | `parseApprovalMode`（含 `undefined`/`"ALL"`/`"yes"` → `off`）与 `needsApproval` 的真值表（三档 × 八个内置名 + 两个自造名） | host-check（纯函数） | `mutating` 里把 `read` 也算进去 → 红；`all` 返回 `false` → 红 |
| A2 | **真 pi + 假模型（不用凭据、不联网，F8）**：`createSessionHost({approval})` + `session.agent.streamFunction` → ① **拒绝**：`touch marker` 后文件**不存在**、toolResult `isError` 且正文含我们给的 reason、`pendingToolCalls` 空；② **允许**：文件存在。夹具用**临时 agentDir**（F8 的假 key 不能污染别的断言），临时 cwd 在 `os.tmpdir()` 下、`finally` 里清理且**清理前断言目标在该目录之下**（AGENTS.md §4） | host-check（`host-check.mjs:160-168` 的入口导出清单要加 `createSessionHost`/`createApprovals`/`createApprovalExtension`，否则这一步会以「模块不存在」收场 —— 而那不算红） | 把 block 改成 `false` → ① 红；`reason` 丢掉 → 正文那条红 |
| A3 | **三档只拦该拦的**：同一驱动下 ① `off` + `bash` → 审批方**一次都没被叫**、命令真的执行（C1）；② `mutating` + 读一个真实临时文件 → 一次都没被叫、工具真的执行（正文含文件内容）；③ `all` + `read` → 被叫了一次 | host-check | 把 `read` 从只读集里去掉 → ② 红；`off` 档也去问 → ① 红 |
| A4 | **待审批时点中止**（F6）：审批方挂着不答 → `session.abort()` → ① 我们的 signal 监听触发；② `prompt()` 在 3s 内 resolve 且 `isIdle === true`；③ 文件不存在；④ `approvals.size().pending === 0`；⑤ 记录 `decision === "cancelled"` 且 `fieldsOf()` 什么都不派生 | host-check | 不监听 `ctx.signal` → ② 超时红（探针实测过会一直挂着） |
| A5 | **会话替换清干净**：跑出一次待审批 → `host.runtime.newSession()`（或 `host.dispose()`）→ 审批表 `pending === 0`、旧 id `decide()` 返回 `false` | host-check | 去掉 `reset()` → 红 |
| A6 | **协议派生与上限**：`fieldsOf` 四态（pending / denied（工具结束后仍在）/ allow 结束（无字段）/ cancelled（无字段））+ 已决记录超 200 条时最早的被丢、**待审批项不被丢** | host-check | 把已决也算进上限并淘汰 pending → 红；`denied` 在工具结束后丢掉 → 红 |
| A7 | **宿主接线**：真 `ChatViewProvider` + 假 controller → 发一条 `approvalDecision` 恰好调 `decideApproval(id,"deny")` 一次；未知 id / 畸形消息不崩且 Output 有一行；面板不可见时弹一次通知、点按钮执行聚焦命令 | host-check | 不转发 → 红；把 `visible` 判断去掉 → 通知那条红 |
| A8 | **渲染字符串**：`pending` → 两个按钮（带 `data-approve`/`data-deny` 与转义后的 toolCallId）；`denied` → 「已拒绝」且**无按钮**；`toolCallId` 里的 `<`/`"` 被转义；**`renderToolCard` 与真 `main.ts` 两条路径都产出它** | render-xss-check（字符串）+ webview-dom-check（真 DOM） | 只在 `renderToolCard` 里渲染 → 真 DOM 那条红（S3 的箭头教训） |
| A9 | **真点击**：点「允许」→ 恰好一条 `{type:"approvalDecision",decision:"allow"}` 且卡片**不展开**；点「拒绝」→ `deny`；Enter/Space 同效；状态行出现可点提示且点了滚动到那张卡片 | webview-dom-check | 去掉 `stopPropagation` → 展开态那条红；去掉键盘分支 → Enter 那条红 |
| A10 | **项目信任真的生效（真 pi、临时目录）**：`.pi/settings.json` = `{"defaultTools":["read"]}` → `createAgentSessionServices(...)` + 我们的 resolver 返回 `true` 时：`settingsManager.isProjectTrusted() === true` **且**新会话的 `getActiveToolNames()` 只有 `read`；返回 `false` 时四个工具都在 | host-check | resolver 直接把 `settingsManager` 设成 true（或用 `projectTrusted:true` 硬编码）→ 后一条红；忽略钩子 → 前一条红（F13/F18） |
| A11 | **裁决顺序**：① memo（同一 cwd 只问一次）；② 持久化的 `true`/`false` 直接用、不问；③ `hasTrustRequiringProjectResources === false` → 不问且 true；④ `defaultProjectTrust` = `always`/`never` → 不问 | host-check（注入假的"问"与假的 store） | 去掉 memo → ① 红；把 `false` 当"没记录"→ ② 红 |
| A12 | **只写 true、只写一次**：选"信任并记住" → `trust.json` 出现该 cwd（canonical 形态）；选"仅本次" → 文件**一个字节都没变**（空目录时仍然不存在）；选"不信任" → 文件不变 | host-check | 把"仅本次"也写进去 → 红（这条是 C9 的唯一守卫） |
| A13 | **模态询问的映射**（真 `vscode` 桩）：`showWarningMessage` 的标题含 cwd 与"信任"；三个按钮；`undefined`（ESC）→ `{trusted:false, remember:false}` | host-check | 把 `undefined` 当信任 → 红（安全方向：红法必须能说明是**安全**判据） |
| A14 | **`Pi: Project Trust…` 命令**的 QuickPick 映射：五个选项各自对应的 `trustStore`/memo 变化；执行后 memo 被清 | host-check | 把"清除记录"写成 `set(cwd,false)` → 红 |
| A15 | **真模型端到端**（PLAN 验收 1 的自动版）：`approvalMode:"all"` + `onApprovalPending → decideApproval("deny")`，让模型跑一条 `touch <临时文件>` 的命令 → 文件不存在 + 卡片 `approval:"denied"` + 正文含原因；第二轮改成 allow → 文件存在 | controller-check（真模型，不进 CI） | 把 `deny` 改成 `allow` → 红 |
| A15b | **待审批时 `controller.snapshot()` 的卡片带 `approval:"pending"`**（C6：面板重开还能答的判据）；随后 `decideApproval("allow")` → 按钮字段消失 | controller-check（与 A15 复用**同一个**挂起的审批项，不额外花模型调用） | 只在实时路径加字段、`snapshot()` 那条路漏掉 → 红（S7 的重放漏字段就是这么暴露的） |
| A16 | **自测 T14（gating）**：A2/A3/A4 的同一批断言在**真 VS Code 宿主**里跑一遍（假模型 + `getModels()[0]` 的内存 key + **独立的临时 agentDir**，见 F8），输出 `T14 PASS <细节>`；T14 排在 T4/T6/T7/T9 **之后**，并加进 `REQUIRED_ITEMS` | `Pi: Run Self-Test`（`npm run check:gate`；Windows W0 也跑它） | 同 A2/A4；`REQUIRED_ITEMS` 加 T14 后不 PASS 即 `GATE BLOCKED` |
| A17 | **设置与文档同步**：`package.json` 的 `approvalMode` 描述不再含"尚未生效"、README 中英两处改成"已生效/effective"（F24 的词表），且描述里写清三档语义 | `scripts/settings-check.mjs`（既有脚本扩一条） | 只改 `package.json` 不改 README → 红 |

> A8/A9 一分为二的理由与 S7 相同：`render-xss-check` 能抓"字符串里有没有"，**只有真 DOM** 能抓"接上了没有"。

## 7. 人工验收（Mac，**2 个动作**，一次 F5 会话里做完）

**M1（审批三档 + 中止）**：把 `jerrypi.approvalMode` 改成 `all` → 重载窗口 → 在面板里说一句现成话术
（我来提供，含"跑一条无害命令"与"写一个文件"）。检查点：

- 卡片上出现「允许 / 拒绝」，**没有**在执行（文件还没被写）；
- 点「拒绝」→ 该卡片变成 `已拒绝` + 正文里能看到原因；**文件不存在**；模型还能继续说话（不是死循环）；
- 第二轮点「允许」→ 工具照常执行（文件出现）；
- 第三个工具调用**故意不答** → 面板状态行出现"有 1 个工具调用等待确认" → 点面板的「中止」→
  待审批项消失、面板回到可输入状态（`生成中…` 结束）；
- 把面板切到别的侧边栏（视图隐藏）再触发一次 → 应该弹一条通知，点它能回到面板。

**M2（项目信任）**：在一个**带 `.pi/settings.json`** 的目录里打开窗口，文件内容写
`{"defaultTools":["read"]}`（**这是唯一一个面板里看得见的项目级效果**，F13）→ 打开面板：

- **第一次**：弹一个模态问"是否信任 <这个文件夹>"；点「不信任」→ 模型仍然四个工具都在（`bash` 可用）；
- `Pi: Project Trust…` → 信任并记住 → **新建会话** → 面板里模型只剩 `read` 一个工具（用一句
  "跑一条 echo 命令"验证它会说没有这个工具）；
- 重载窗口 → **不再问**（信任已记住）；
- `Pi: Project Trust…` → 清除记录 → 新建会话 → 恢复成四个工具。

> 为什么必须人工：①真焦点/真点击（webview 里的按钮、状态行、原生模态按钮）；②真进程（重载后的
> memo/trust.json 读取）；③排版（卡片上多一行、状态行多一句会不会挤）。三类都在 AGENTS.md §1 的清单里。

## 8. Windows 项（不新增人工动作）

- **W0**：`Pi: Run Self-Test` —— T14 会自动覆盖"审批拦住 bash / 拒绝不产生副作用 / 中止能收口"。
  期望仍是 `GATE PASS`（14 PASS / 0 FAIL / 1 SKIP = T12，现在多一项 T14）。
- **W1**：重启后会话正常（不变）。

## 9. 步骤（每步单独提交 + 门禁全绿）

| 步 | 内容 | 结束时的门禁 |
| --- | --- | --- |
| 1 | `src/pi/approval.ts`（三档纯函数 + 审批表 + 扩展工厂）+ A1/A6 | typecheck / self-test（host-check） |
| 2 | 装配接线（`session.ts` 的 `extensionFactories`、controller 的审批表与 `decideApproval`、协议 v6）+ A2/A3/A4/A5 | self-test（host-check） |
| 3 | 渲染与点击链路（`serialize.ts` 派生、`render.ts` 那一行、`main.ts` 的 `view.approval`/委托/键盘/状态行）+ A8/A9 | self-test（render + webview-dom） |
| 4 | 宿主接线（`chatView` 路由 + 通知/聚焦）+ A7 | self-test（host-check） |
| 5 | 项目信任（`trust.ts` + `trustPrompt.ts` + 装配 + 命令 + README 里的信任一节）+ A10/A11/A12/A13/A14 | self-test（host-check） |
| 6 | 自测 **T14** + controller-check 的 A15/A15b + 文档（README 中英配置表/已知限制、`pi-traps` 两条）+ A16/A17 | 全部 + `check:gate`（T14 要真宿主）|
| 7 | 版本 **0.1.10** + 打包 + Mac M1/M2 + 上传核验 + Windows W0/W1 + §12 回填 → 关阶段 | 发布流程（STATUS §4） |

> 版本为什么还是 `0.1.x`：`PLAN.md` §5.4 规定预发布走奇数段、**第一个正式版是 0.2.0（偶数段）**，
> 而"Windows 全量验收 + 正式发布"是 **S10** 的事；`CHANGELOG.md` 也按同一条规则推迟到 0.2.0（F25）。

## 10. 评审记录

**评审者**：Claude（同一工作目录的面板会话）。
**纪律**（承 S4–S7）：**≤3 轮**；第 3 轮只核转写、不审设计；每轮结论**立刻落盘**；
每条记 `ACCEPT` / `REJECT`（附实质理由）/ `DEFER`。评审者只读。

### 第 1 轮（待送审）

## 11. 实施期发现

（待实施）

## 12. 实施与验收结果

（待实施）

## 13. 待用户拍板

见 §4 的 **Q1–Q9**。**默认值都是我的建议**；用户说"可以"之后才动代码。
