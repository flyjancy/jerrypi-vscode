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
| F10b | `resourceLoaderOptions.extensionFactories` 有**两种形态**：裸函数 → 路径是 `<inline:${下标+1}>`、**没有** `hidden`；`{name, factory, hidden}` → 路径是 `<inline:name>`、`hidden` 生效。⚠️ **工厂抛错会被 catch 进 `errors`，扩展静默缺席** —— 那时"审批没问"与"审批没装上"在外部**观察等价** | `dist/core/resource-loader.js:743-757`；探针 P6（具名形态的实测输出：`[{"path":"<inline:jerrypi-approval>","hidden":true}]`、`errors=[]`） |

### 0.2 项目信任：pi 谁在什么时候问、答案存在哪、信任之后有什么变化

| # | 事实 | 证据 |
| --- | --- | --- |
| F11 | SDK 路径**支持注入信任裁决**：`createAgentSessionServices({ resourceLoaderReloadOptions: { resolveProjectTrust } })` —— loader 会先跑一遍"未信任"的扩展加载（`includeInlineFactories: true`，所以我们自己的 inline 扩展在场），再把这个钩子 **await** 出结果，然后 `settingsManager.setProjectTrusted(...)` + 重新 reload 设置。⚠️ **loader 不替我们判断"要不要问"**：只要传了钩子，哪怕 cwd 里一个 `.pi/` 资源都没有，它照样调用一次 ⇒「没资源就别问」这条短路必须写在**我们的**裁决函数里 | `dist/core/agent-session-services.js:53-70`（`await resourceLoader.reload(options.resourceLoaderReloadOptions)`）；`dist/core/resource-loader.js:262-273`；探针 §2 的四行输出（`预信任阶段的扩展数=1` × 3 次、以及"没有 .pi 资源 + 照样传钩子 → 钩子次数=1"） |
| F11b | inline 扩展在**预信任阶段**就被实例化，而最终集合**复用同一批实例**（`filter(path.startsWith("<inline:"))`），不会重新构造 ⇒ 「审批扩展 + `resolveProjectTrust` 同时启用」**不会**双注册 `tool_call` 处理器（否则每次工具调用会问两遍） | `dist/core/resource-loader.js:262-273`（`loadProjectTrustExtensions` → `includeInlineFactories: true`）与 `:446`（挑出 inline）/`:450`（拼回最终集合）—— 行号经第 2 轮评审 N3 校正；探针 s8-trust-probe §2 的"预信任阶段的扩展数=1" |
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
| F26 | ⚠️ **未实测**：`WebviewView.onDidDispose` 在"把侧边栏切到别的容器 / 折叠"时到底发不发 —— 本仓没测过（`retainContextWhenHidden: true`，`chatView.ts:271`）。**Q10 的裁决不依赖它**（靠的是"销毁即取消"与 C6 的重放**互斥**），这一条只是把"我们不知道"写在明面上 | `src/host/chatView.ts:271`；第 2 轮评审 S5 要求（上一版拿它当论据，已删） |

## 1. 目标与判据

**目标**：给"agent 能执行任何东西"这件事装上用户可控的闸门，并让项目级配置的加载变成用户显式同意的事。

| # | 判据（PLAN 验收的逐条拆解） |
| --- | --- |
| C1 | `jerrypi.approvalMode = off` 时行为**与今天完全一致**：一次都不问、卡片上不多任何字段（协议里没有 `approval`）。**"没问"必须与"审批扩展根本没装上"区分开**（F10b：后者是静默的，而 R7 把它列成了最坏形态）—— 所以这条的断言是"同一个会话里三档分别表现"（A3）+ "扩展在场"的阳性证据，而不是数一次回调次数。 |
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
2. 装配接线：`createSessionHost` 收下 `approval`（mode 取值回调 + 提问方），以**具名 + `hidden`** 的形态
   （`{name:"jerrypi-approval", factory, hidden:true}`，F10b）放进 `resourceLoaderOptions.extensionFactories`；
   controller 持有审批表、发协议、暴露 `decideApproval`。
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
   **还要改 `PLAN.md` 的 §5.3 一句**（第 1 轮评审 B3）：那一行把取消路径写成四条、其中"Webview 被销毁"
   与"面板重开时重放"互相打架，按 Q10 的裁决改成三条 + 重放（改 PLAN 正文 = 改项目的承诺，见 AGENTS.md §0）。

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
3. **一个 map，但上限只数已决**（第 1 轮评审 N2：把"pending 永不淘汰"与"上限 200"写在同一句里
   是有歧义的）：pending 与 decided 存在同一张表里，**计数只算 decided**（200 条 FIFO）——
   pending 因为 F5 天然 ≤ 1，永远不会被淘汰；已决记录只为"回放一次拒绝"存在（`denied` 在工具结束后
   仍派生，`allow` 结束就什么都不派生）。这与 S7 §3.6 的墓碑教训是同一类错误的正面写法。
4. **`cancel` 不是一个 UI 状态，但它的 reason 与拒绝必须分开**（第 1 轮补、第 2 轮复核并收窄为漂移守卫，见 §10.2 的 S2）：`cancelled` 之后 `fieldsOf` 什么都不派生
   （卡片回到普通"运行中/已中止"形态）；而 `block` 的 reason 用 `Cancelled: session ended`，
   **不能沿用** `Rejected by user: …` —— 用户没拒绝（第 1 轮评审 S1：`signal?.aborted` 的检查在
   `block` 之前，只有 signal 真被触发时 pi 才会把它覆盖成 `Operation aborted`）。

`InlineExtension` 工厂（`createApprovalExtension({ mode, approvals, log })`）就是 F10 的形状：

```ts
api.on("tool_call", async (event, ctx) => {
  if (!needsApproval(mode(), event.toolName)) return undefined;      // 放行 = 什么都不返回
  const outcome = await approvals.ask({...}, ctx.signal);            // 绝不抛（见上）
  if (outcome === "allow") return undefined;
  // cancelled 与 deny **必须分开**（§3.1 第 4 条；A5b 钉住）：用户没拒绝的时候别替他拒绝
  return {
    block: true,
    reason: outcome === "cancelled" ? "Cancelled: session ended" : `Rejected by user: ${title}`,
  };
});
```

**不做 `terminate`**（F3：它只在整批都被拦时生效，而我们要让模型有机会换个做法）。

### 3.2 装配与"谁在什么时候问"

```
controller.ensure()
  └─ createSessionHost({ …, approval: { mode: readApprovalModeSetting, approvals: this.approvals } })
       └─ createAgentSessionServices({ …, resourceLoaderOptions: { extensionFactories: [
              { name: "jerrypi-approval", factory: approvalExtension, hidden: true }   // 具名才有 hidden（F10b）
            ] } })
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
| `render.ts` | `renderToolCard` 里在**标题按钮之后、正文之前**插一行 `<div class="tool-approval">`：`pending` → `<button data-approve="<id>">允许</button><button data-deny="<id>">拒绝</button>` + 一句提示；`denied` → `<span class="tool-note">已拒绝</span>`。**用真 `<button>` 而不是 `<a role=button>`**，且必须放在标题按钮**之外**：① HTML 解析器会把嵌套的 `<button>` 拆掉（S7 用的是 `<a role=button>` 才绕过去）；② 展开/折叠的监听器挂在 head **元素自己**身上（`main.ts:292/296`），所以"点审批按钮不会顺带展开卡片"是**这个兄弟关系**的推论 —— 断言要钉的是结构本身（第 1 轮评审 B1） |
| `main.ts` | `createToolView` 多一个 `view.approval`（在 head 与 body 之间，常驻可见——折叠时也要能答）；点击委托加 `data-approve`/`data-deny` 两条；**审批控件不进 `onTranscriptKeydown`** —— 它们是真 `<button>`，
浏览器原生的激活行为（Enter 的 keydown / Space 的 keyup）会自己补一次 `click`，而上面那条捕获阶段的
点击委托正好接住它 ⇒ "一次按键只发一条"是**构造保证**，不需要我们手写键盘分支。
（第 2 轮评审 B1 的教训：手写"keydown + `preventDefault()`"会让"恰好一条"变成一条**测不出来的**行为断言
—— 实跑确认 happy-dom 20.14.5 **不实现** `<button>` 的原生激活，加不加 `preventDefault` 在测试台里都是
一条消息。S7 的 diff 链接用 `<a role=button>` 才需要手写键盘分支，真 `<button>` 不需要。）
`stopPropagation` 保留（它守的是"将来有人把审批行挪进某个可点祖先"这种改法，不是现在这条）；状态行 `#status` 在有待审批时多一句可点提示（点了滚动到最后一张待审批卡片） |

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
  ⚠️ **"信任父文件夹"要写两条 update**（第 1 轮评审 S6）：`[{ path: parent, decision: true }, { path: cwd, decision: null }]`
  —— `findNearestTrustEntry` 是从 cwd 逐级向上找**最近**的一条（F15），不清掉子目录那条，父目录的裁决
  永远轮不到（CLI 自己也是这么写的：`trust-manager.js:42-54`；子目录那条很可能是 CLI 写的 `false`）。
- **`extensionsResult` 这个入参我们不用**（不做 `project_trust` 事件，Q7）；签名照样吃下它，便于将来接上。

### 3.5 与 S7 的组合、以及"什么变了"

- `write` 的审批与 S7 的前后快照**天然不冲突**：拒绝 → 包装层根本没被调用（F9）⇒ 也就没有快照记录，
  卡片上不会出现"点了 diff 是空的"这种事（S7 的 A10 已经钉住"失败的调用不给 diff 入口"这个方向）。
- 信任打开之后**多出来的东西**（必须写进 README）：项目级 `.pi/settings.json`（可改 `shellPath`、
  `defaultTools` 等）、`.pi/extensions/*`、`.pi/skills`、`.pi/prompts`、`SYSTEM.md`、项目级包。
  **它改不了 `jerrypi.approvalMode`** —— 那是 VS Code 的 `machine` scope 设置（S6 的 Q9 就是为此定的），
  这条要写进 README，它是"仓库带一份 `.vscode/settings.json` 就能关掉审批"这个风险的正面回答。
- **两层信任的分工**（第 1 轮 S8 提出、第 2 轮 S6 改定措辞；README 也要写）：VS Code 的**工作区信任**管"这个窗口里要不要激活
  扩展"，而我们已经声明 `capabilities.untrustedWorkspaces.supported === false`（F23）—— 也就是说**面板只在
  VS Code 已信任的工作区里跑**。pi 的**项目信任**是另一层、粒度也不同：它管"要不要把 `<cwd>/.pi/` 里的
  设置/扩展/技能读进来并执行"。两者的时序也不同：VS Code 那一次是在**打开文件夹**时问的、且只问一次
  （之后记住），我们这一次是在**首次打开面板**时问 —— 所以用户**可能连着看到两个对话框，也可能只看到
  我们这一个**（目录已被 VS Code 信任过时）。
  **触发我们的询问的不只是 `.pi/`**（F14）：`<cwd 或祖先>/.agents/skills` 也算，文案里必须把两种来源
  都写出来，否则用户会去仓库里找一个根本不存在的 `.pi/` 目录。

### 3.6 上限与内存

审批表只存标量（id/toolName/title/decision/时间），一条几十字节；`title` 进协议前按 200 字符截断
（复用 `SUMMARY_MAX` 的量级）。**待审批项数天然 ≤ 1**（F5），所以没有"待审批积压"的上限问题；
已决记录 200 条封顶（FIFO，见 §3.1 第 3 条）。

## 4. 决策与默认值（Q1–Q10，等用户拍板）

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
| Q10 | **Webview 被销毁**算不算一条取消路径（PLAN §5.3 原文列了四条，含它） | **不算**：销毁**不**取消待审批项 —— 记录留着、面板重开时重放（C6）；**同时补一次提醒**（第 2 轮评审 S4）：视图销毁（`onDidDispose`）时、以及面板重建后仍有待审批项时，**再弹一次 Q9 的那条通知**（"有 1 个工具调用还等着确认，打开面板"），因为「中止」按钮在面板里、用户看不到卡片时没有别的出口 | 照 PLAN 原文在销毁时取消：那 C6 的"重放"就永远不会发生（**互斥**这一条就够支撑裁决）。⚠️ 上一版用来加权的"视图销毁比看上去频繁"是**未实测**的说法（第 2 轮评审 S5 要求删掉或去测）⇒ **不采用、不作为论据**（`onDidDispose` 在隐藏容器/重挂面板时到底发不发，本仓没测过；`retainContextWhenHidden: true` 下是版本相关行为）。选定后**要同步改 PLAN §5.3 那一句**（AGENTS.md §0：改它的正文 = 改项目的承诺） |

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
`controller-check` 没凭据时整体 SKIP，而 SKIP 不是 PASS）；只有真模型那条 A15 进 `controller-check`。
**A2 那个夹具（真 pi + 假模型 + 临时 agentDir）是 A3/A4/A5/A6b 共用的**，只写一次。

| # | 断言 | 放哪 | 能红验证 |
| --- | --- | --- | --- |
| A1 | `parseApprovalMode`（含 `undefined`/`"ALL"`/`"yes"` → `off`）与 `needsApproval` 的真值表（三档 × 八个内置名 + 两个自造名）**＋漂移守卫**：`READ_ONLY_TOOLS` 逐字等于 `pi.createReadOnlyTools(临时 cwd).map(t => t.name)`（第 1 轮评审 S3 给的 oracle；已实跑确认导出面里有它，返回 `read,grep,find,ls`） | host-check（纯函数 + 真 pi） | `mutating` 里把 `read` 也算进去 → 红；`all` 返回 `false` → 红；往 `READ_ONLY_TOOLS` 手塞一个 `edit` → 守卫红 |
| A2 | **真 pi + 假模型（不用凭据、不联网，F8）**：`createSessionHost({approval})` + `session.agent.streamFunction` → ① **拒绝**：`touch marker` 后文件**不存在**、toolResult `isError` 且正文含我们给的 reason、`pendingToolCalls` 空；② **允许**：文件存在。夹具用**临时 agentDir**（F8 的假 key 不能污染别的断言），临时 cwd 在 `os.tmpdir()` 下、`finally` 里清理且**清理前断言目标在该目录之下**（AGENTS.md §4）。**这个夹具（真 pi + 假模型 + 临时 agentDir）是 A3/A4/A5/A6b 共用的一个工厂函数**，写一次 | host-check（`host-check.mjs:160-168` 的入口导出清单要加 `createSessionHost`/`createApprovals`/`createApprovalExtension`/`SessionHostController`，否则这一步会以「模块不存在」收场 —— 而那不算红） | 把 block 改成 `false` → ① 红；`reason` 丢掉 → 正文那条红 |
| A3 | **三档只拦该拦的，且在同一个会话里切**（第 1 轮评审 S2：换了会话就分不清"没问"与"扩展没装上"）：一个 session，`mode` 是个可变 getter（§3.2 保证每次调用现读）→ ① `off` + `bash` → 审批方**一次都没被叫**、命令真的执行（C1）；② `mutating` + 读一个真实临时文件 → 一次都没被叫、工具真的执行（正文含文件内容）；③ `all` + 同一个读操作 → **被叫了一次**（阳性证据：扩展在场）；④ `mutating` + 夹具扩展注册的自造工具 → 被叫了一次（第 1 轮评审 S4；已实跑确认扩展工具默认就在 active tool set 里，脚本化 toolCall 打得到它）。另断言 `host.runtime.services.resourceLoader.getExtensions().errors` 为空（路径已核：`agent-session-runtime.d.ts:53` 的 `get services()` ⇒ `services.resourceLoader`，**零生产改动**就能拿到） | host-check | 把 `read` 从只读集里去掉 → ② 红；`off` 档也去问 → ① 红；**让工厂抛错**（F10b 的静默缺席）→ ③ 与 `errors` 那条红，而 ①/② 照样绿 —— 这正是 S2 要防的形态 |
| A4 | **待审批时点中止**（F6）：审批方挂着不答 → `session.abort()` → ① 我们的 signal 监听触发；② `prompt()` 在 3s 内 resolve 且 `isIdle === true`；③ 文件不存在；④ `approvals.size().pending === 0`；⑤ 记录 `decision === "cancelled"` 且 `fieldsOf()` 什么都不派生 | host-check | 不监听 `ctx.signal` → ② 超时红（探针实测过会一直挂着） |
| A5 | **会话替换清干净**：跑出一次待审批 → `host.runtime.newSession()`（或 `host.dispose()`）→ 审批表 `pending === 0`、旧 id `decide()` 返回 `false` | host-check | 去掉 `reset()` → 红 |
| A5b | **`cancelled` 的理由与 `deny` 分开**（纯函数层：把同一个 handler 的 `approvals.ask` 分别喂成 `deny` 与 `cancelled`，两次 `block` 的 `reason` **必须不同**、cancelled 那次不含 `Rejected by user`）。**它的定位是漂移守卫、不是修今天的 bug**（第 2 轮评审 S2 更正）：今天 pi 的两条 reset 路径**都先 abort**（`agent-session-runtime.js:105` 的 `teardownCurrent` → `await this.session.abort()`；`agent-session.js:590` 的 `dispose()` → `this.agent.abort()`），而 `agent-loop.js:419` 的 `signal?.aborted` 检查在 `:426` 的 `block` 之前 ⇒ 今天 reason 恒被覆盖成 `Operation aborted`。这条守的是"pi 哪天不再 abort" | host-check（纯函数） | 两条路径共用一个 reason → 红。**为什么不做端到端**：今天它必然被覆盖成 `Operation aborted` ⇒ 端到端那条**恒绿**（AGENTS.md §2 的"判据主语"问题） |
| A6 | **协议派生与上限**：`fieldsOf` 五态（pending / denied（工具结束后仍在）/ allow 结束（无字段）/ cancelled（无字段）/ **没问过（`off` 档，F5 的常态）**）+ 上限**只数 decided**：连插 300 条已决 → 最早的被丢；在**有一条 pending** 时再插 300 条已决 → pending 仍在 | host-check | 把已决也算进上限并淘汰 pending → 红；`denied` 在工具结束后丢掉 → 红；`fieldsOf` 无条件派生 `pending` → 第五态红 |
| A6b | **真 `SessionHostController` 的 `snapshot()`（C6 的主守卫；第 1 轮 B2 把它从 controller-check 搬过来、第 2 轮 S3 补齐三个接缝 —— 它不需要模型）**：用 A2 的假模型夹具、但经**真 controller**。`SessionHostControllerOptions.pi` 本来就允许传句柄（`PiModule \| (() => Promise<PiModule>)`）⇒ **不改生产代码**，但包装句柄要接**三个**接缝（第 2 轮评审 S3）：① `createAgentSessionFromServices` → 换成脚本化 `streamFunction` + 显式 `model`；② `ModelRuntime.create` → 造好之后 `setRuntimeApiKey(probeModel.provider, "k")`（内存假 key 没有别的注入点，而 controller 内部是 `getModelRuntime(pi, agentDir, keys)`）；③ `sessionsRoot` 给临时目录（controller 的选项已有）。resourceLoader 从 `host.runtime.services.resourceLoader` 取（不需要新选项）。**顺带白捡一条**：`onMessage` 的协议流能一起断言"实时 `onPending` 的就地重发"（§3.3 controller 行第 ②）→ ① `onApprovalPending` 里**先** `snapshot()`：卡片带 `approval:"pending"`；**再** `decideApproval("deny")`；② 第二轮（allow）之后再 `snapshot()`：字段消失（N3 的时序）；③ `off` 档跑一次 → 卡片**不带** `approval`（C1 的"不多发"） | host-check | `snapshot()` 那条路漏掉派生（只在实时 `onToolExecutionStart` 里加）→ ① 红；`decide` 后不移除字段 → ② 红；`off` 档也派生 → ③ 红。**退路（成本失控时怎么裁，第 2 轮评审 S3 要求先写下来）**：若这个夹具做不出来，退成"断言派生函数在实时与 `snapshot()` 两条路都被调用"（在 controller 里注入一个记数的假派生）+ 把这条放回 `controller-check` 当真模型兜底，并**在 §11 记为降级** |
| A7 | **宿主接线**：真 `ChatViewProvider` + 假 controller → 发一条 `approvalDecision` 恰好调 `decideApproval(id,"deny")` 一次；未知 id / 畸形消息不崩且 Output 有一行；面板不可见时弹一次通知、点按钮执行聚焦命令；**有待审批项时视图销毁（`onDidDispose`）再弹一次通知**（Q10 的补洞），面板重建后仍有 pending **也**弹 | host-check | 不转发 → 红；把 `visible` 判断去掉 → 通知那条红；去掉销毁时的再通知 → 那条红 |
| A8 | **渲染字符串**：`pending` → 两个按钮（带 `data-approve`/`data-deny` 与转义后的 toolCallId）；`denied` → 「已拒绝」且**无按钮**；`toolCallId` 里的 `<`/`"` 被转义；**`renderToolCard` 与真 `main.ts` 两条路径都产出它** | render-xss-check（字符串）+ webview-dom-check（真 DOM） | 只在 `renderToolCard` 里渲染 → 真 DOM 那条红（S3 的箭头教训） |
| A8b | **两条结构不变量**：（a）审批行是 `.tool-head` 的**兄弟**——`document.querySelector(".tool-head .tool-approval") === null`（不是后代），且 `.tool-approval.previousElementSibling` 是 head；这条守的是"点审批按钮不会顺带展开/折叠"（`toggleTool` 只挂在 head 自己的监听器上，`main.ts:292/296/303`）。（b）两个控件是**真 `<button>` 且 `type === "button"`**（第 2 轮评审 N4）—— 这条守的是**键盘可达性**：Tab 能停、Enter/Space 能激活，都是原生 `<button>` 给的，换成 `<div data-approve>` 就全没了（而且 §3.3 决定不再手写键盘分支，所以它是键盘路径的唯一守卫） | webview-dom-check | (a) 把审批行渲染进 head 里面 → 红；(b) 控件改成 `<div>` 或去掉 `type` → 红。**注**："点了不展开"本身是 (a) 的**推论**，不单独当断言 —— 兄弟节点上根本没有通往 `toggleTool` 的路，那种断言从写下第一天起就是绿的 |
| A9 | **真点击**：点「允许」→ **恰好一条** `{type:"approvalDecision",decision:"allow"}`；点「拒绝」→ `deny`；状态行出现可点提示且点了滚动到那张卡片。**键盘路径不在这里测**（第 2 轮评审 B1/N5）：happy-dom 不实现 `<button>` 的原生激活，任何"按 Enter 会怎样"的断言在这台测试上都是**恒绿**的；键盘可达性由 A8b(b) 的"真 `<button>`"守住，真浏览器行为留给 M1 的一次手点（话术里包含一次 Tab+Enter） | webview-dom-check | 去掉 `data-approve` 的委托分支 → 那条红；把消息发成 `deny` → 红 |
| A10 | **项目信任真的生效（真 pi、临时目录）**：`.pi/settings.json` = `{"defaultTools":["read"]}` → `createAgentSessionServices(...)` + 我们的 resolver 返回 `true` 时：`settingsManager.isProjectTrusted() === true` **且**新会话的 `getActiveToolNames()` 只有 `read`；返回 `false` 时四个工具都在 | host-check | resolver 直接把 `settingsManager` 设成 true（或用 `projectTrusted:true` 硬编码）→ 后一条红；忽略钩子 → 前一条红（F13/F18） |
| A11 | **裁决顺序**：① memo（同一 cwd 只问一次）；② 持久化的 `true`/`false` 直接用、不问；③ `hasTrustRequiringProjectResources === false` → 不问且 true；④ `defaultProjectTrust` = `always`/`never` → 不问 | host-check（注入假的"问"与假的 store） | 去掉 memo → ① 红；把 `false` 当"没记录"→ ② 红 |
| A12 | **只写 true、只写一次**：选"信任并记住" → `trust.json` 出现该 cwd（canonical 形态）；选"仅本次" → 文件**一个字节都没变**（空目录时仍然不存在）；选"不信任" → 文件不变 | host-check | 把"仅本次"也写进去 → 红（这条是 C9 的唯一守卫） |
| A13 | **模态询问的映射**（真 `vscode` 桩）：`showWarningMessage` 的标题含 cwd 与"信任"；三个按钮；`undefined`（ESC）→ `{trusted:false, remember:false}` | host-check | 把 `undefined` 当信任 → 红（安全方向：红法必须能说明是**安全**判据） |
| A14 | **`Pi: Project Trust…` 命令**的 QuickPick 映射：五个选项各自对应的 `trustStore`/memo 变化；执行后 memo 被清；**"信任父文件夹"写两条 update**（先 `set(cwd,true)` 再选它 → `trust.json` 里 cwd 那条**消失**、parent 那条出现，第 1 轮评审 S6） | host-check | 把"清除记录"写成 `set(cwd,false)` → 红；"信任父文件夹"只写 parent → 那条红（子记录会永远遮住它，F15） |
| A15 | **真模型端到端**（PLAN 验收 1 的自动版）：`approvalMode:"all"` + `onApprovalPending → decideApproval("deny")`，让模型跑一条 `touch <临时文件>` 的命令 → 文件不存在 + 卡片 `approval:"denied"` + 正文含原因；第二轮改成 allow → 文件存在 | controller-check（真模型，不进 CI） | 把 `deny` 改成 `allow` → 红 |
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
- 把面板切到别的侧边栏（视图隐藏）再触发一次 → 应该弹一条通知，点它能回到面板；
  **并且通知里的数字要等于"当前"待确认数**（答一个或中止一个之后再触发一次，数字**不能累加** —— M1 第一次验收就是在这里抓到宿主侧那份副本只增不减）；
- **键盘一次**：用 Tab 走到「允许」上、按 Enter → 只执行一次（happy-dom 测不到原生激活，A8b(b) 只守结构）。

**M2（项目信任，**3 下**）**：夹具由我准备好（`/tmp/s8-trust-demo/.pi/settings.json` = `{"defaultTools":["read"]}`，
我在实施期就用 `bash` 建好了）：

1. `File > Open Folder…` → `/tmp/s8-trust-demo` → 打开侧边栏的 Pi 面板 →
   **应弹一个原生模态**（⚠️ 面板此刻可能还是空的：信任是在建会话时问的，见 F16，这是预期）：
   标题写清是**哪个文件夹**、三个按钮（信任并记住 / 仅本次信任 / 不信任）、文案里同时提到
   `.pi/` 与 `.agents/skills`、并点明"与 VS Code 的工作区信任是两回事" → 点**「信任并记住」**。
2. 发一句「用 bash 跑 echo hi」→ 模型说没有 bash 这个工具（或做不到）—— **这就是信任生效的可见证据**
   （项目级 `defaultTools: ["read"]` 真的被读了）。
3. `Pi: Project Trust…` → 选「清除这里的记录」→ 应给一句"已清除…（下次会重新问）"。

**为什么只剩这 3 下**（原来那四步去哪了）：①"不信任也照常能用""仅本次不写文件""重载后不再问"
已经由 A11②⑤ / A12 的断言钉住（真 trust.json + 真 pi，含"CLI 写的 false 也认""只写 true"）；
②"信任之后项目设置真的生效"这条的**接线**（extension → controller → session）现在由 **A10⑩** 钉住
（真 controller + `askProjectTrust`，破法实测会红）—— 所以留在人工里的只有自动化**看不见**的两件事：
"模态真的弹出来了、文案对""点下去真的生效"。

> 为什么必须人工：①真焦点/真点击（webview 里的按钮、状态行、原生模态按钮）；②真进程（重载后的
> memo/trust.json 读取）；③排版（卡片上多一行、状态行多一句会不会挤）。三类都在 AGENTS.md §1 的清单里。

## 8. Windows 项（不新增人工动作）

- **W0**：`Pi: Run Self-Test` —— T14 会自动覆盖"审批拦住 bash / 拒绝不产生副作用 / 中止能收口"。
  现在是 15 项（12 gating + T5c/T12/T13 advisory，`selftest.ts:77` 的 `REQUIRED_ITEMS` 12 项），
  加 T14 后 **16 项** ⇒ 期望 **`GATE PASS`：15 PASS / 0 FAIL / 1 SKIP（= T12）**（第 1 轮评审 N1：
  上一版这里写的 14 是加 T14 **之前**的数）。
- **W1**：重启后会话正常（不变）。

## 9. 步骤（每步单独提交 + 门禁全绿）

| 步 | 内容 | 结束时的门禁 |
| --- | --- | --- |
| 1 | `src/pi/approval.ts`（三档纯函数 + 审批表 + 扩展工厂）+ A1/A6 | typecheck / self-test（host-check） |
| 2 | 装配接线（`session.ts` 的**具名 + hidden** `extensionFactories`、controller 的审批表与 `decideApproval`、协议 v6）+ A2/A3/A4/A5/A5b | self-test（host-check） |
| 3 | 渲染与点击链路（`serialize.ts` 派生、`render.ts` 那一行、`main.ts` 的 `view.approval`/点击委托/**审批控件不写键盘分支**（§3.3 的理由）/状态行）+ A8/A8b/A9 | self-test（render + webview-dom） |
| 4 | 宿主接线（`chatView` 路由 + 通知/聚焦）+ A7 | self-test（host-check） |
| 5 | 项目信任（`trust.ts` + `trustPrompt.ts` + 装配 + 命令 + README 里的信任一节与"两层信任"）+ A10/A11/A12/A13/A14 | self-test（host-check） |
| 6 | 自测 **T14** + controller-check 的 A15 + 文档（README 中英配置表/已知限制、`pi-traps` 三条、**`PLAN.md` §5.3 那句按 Q10 改口**）+ A6b/A16/A17 | 全部 + `check:gate`（T14 要真宿主）|
| 7 | 版本 **0.1.10** + 打包 + Mac M1/M2 + 上传核验 + Windows W0/W1 + §12 回填 → 关阶段 | 发布流程（STATUS §4） |

> 版本为什么还是 `0.1.x`：`PLAN.md` §5.4 规定预发布走奇数段、**第一个正式版是 0.2.0（偶数段）**，
> 而"Windows 全量验收 + 正式发布"是 **S10** 的事；`CHANGELOG.md` 也按同一条规则推迟到 0.2.0（F25）。

## 10. 评审记录

**评审者**：Claude（同一工作目录的面板会话）。
**纪律**（承 S4–S7）：**≤3 轮**；第 3 轮只核转写、不审设计；每轮结论**立刻落盘**；
每条记 `ACCEPT` / `REJECT`（附实质理由）/ `DEFER`。评审者只读。

### 第 1 轮（2026-09-15，Claude，本仓 `w60:pC` 面板；结论 `VERDICT: BLOCKING`，3 B / 8 S / 5 N）

**处置：16 条全部 ACCEPT**（其中 4 条按我自己的复核**改了改法**：B1 的断言换成结构不变量、
S1 挪到纯函数层、N5 并进 A6/A6b、B3 用新增的 Q10 落裁决）。评审者复跑了我落盘的两个探针，
判定 **§0 的 25 条事实一条都没错**（这是它审的四份计划里事实底子最扎实的一份），16 条全部落在
§6 的断言与跨节口径上。

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | A9 的「点『允许』→ 卡片不展开」**恒真**：审批行是 `.tool-head` 的**兄弟**，而 `toggleTool` 只挂在 head 自己的监听器上 —— 去掉 `stopPropagation` 也红不了 | ACCEPT（已复核） | 核了 `main.ts:292/296/303`：`toggleTool` 只有 head 的 click/keydown 两个入口 ⇒ 兄弟节点的点击到不了它。⇒ A9 把"不展开"降级为**推论**，改成结构断言 **A8b**（`.tool-approval` 不是 `.tool-head` 的后代），能红验证 = 把审批行渲染进 head。**我自己又补了一条**：Enter 必须 `preventDefault()`，否则 `<button>` 的合成 click 会让同一次按键**发两条** `approvalDecision`（能红验证：去掉 `preventDefault` → 两条消息） |
| **B2** | C6 的唯一守卫 A15b 放在 `controller-check`（无凭据整体 SKIP），而它**不需要模型** | ACCEPT | 搬成 **A6b**（host-check）：`SessionHostControllerOptions.pi` 本来就允许传句柄 ⇒ 测试传一个"只换 `createAgentSessionFromServices` 里的模型流/model"的包装句柄，**生产代码不动**。controller-check 只留真模型端到端 A15 |
| **B3** | PLAN §5.3 承诺四条取消路径，计划只落实两条；"Webview 被销毁"既没做也没说不做，且与 C6 冲突 | ACCEPT | 新增 **Q10** 显式裁决"销毁**不**取消、等重放"，并在 §9 第 6 步同步改 `PLAN.md:186-187` 那一句（AGENTS.md §0：改 PLAN 正文 = 改项目的承诺） |
| **S1** | `reset()` 结掉的 `cancelled` 可能以"用户拒绝了"到达模型（`signal?.aborted` 的检查在 `block` 之前） | ACCEPT（已复核）｜**第 2 轮收窄**：见 §10.2 的 S2 —— 今天 pi 的两条 reset 路径都先 abort，所以这是**漂移守卫**而不是今天的 bug。 | 核了 `agent-loop.js:419` 在 `:426` 之前 ⇒ 机制成立。⇒ §3.1 第 4 条：`cancelled` 用 `Cancelled: session ended`；断言放**纯函数层**（**A5b**：两条路径的 reason 必须不同）—— 端到端那条在 signal 已 abort 时会被 pi 覆盖，**写了也恒绿** |
| **S2** | A3① 绿的时候证明不了 C1（"审批方没被叫"与"扩展根本没装上"**观察等价**；工厂抛错被静默 catch） | ACCEPT（已复核） | 核了 `resource-loader.js:743-757` ⇒ 成立。⇒ A3 改成**同一个会话里切 mode** + 断言 `errors` 为空 + 第 ③ 项（`all` + 读操作会问）当"扩展在场"的阳性证据。**这就是 STRONGEST_OBJECTION 要的那条防线** |
| **S3** | A1 是实现的镜像（手抄名单，没有第二份实现对照）；pi 恰好导出了 `createReadOnlyTools` | ACCEPT（已实跑） | 跑出 `typeof pi.createReadOnlyTools === "function"`、`names = read,grep,find,ls` ⇒ oracle 可用。⇒ A1 加漂移守卫（`READ_ONLY_TOOLS` 逐字等于它的名字） |
| **S4** | C2 的"未知/扩展工具也要确认"没有端到端断言 | ACCEPT（已实跑） | 跑出 `activeTools = read,bash,edit,write,probe_tool`（扩展工具默认就在活动集里）⇒ A3 加第 ④ 项，顺带验了 `event.toolName` 的字符串 |
| **S5** | inline 扩展要用「具名 + `hidden`」注册，否则会出现在扩展清单里 | ACCEPT（已实跑） | 跑出具名形态 `path="<inline:jerrypi-approval>"`、`hidden=true`、`errors=[]`；`resource-loader.js:749-752` 证实 `hidden` **只对具名形态**生效。⇒ §3.2 改成具名形态，新增 F10b |
| **S6** | 「信任父文件夹」漏了 pi 的**第二条** update（`{cwd: null}`），子目录已有记录时父记录永远轮不到 | ACCEPT（已复核） | 核了 `trust-manager.js:42-54`（pi 自己就是两条 update）与 `:20-32`（从 cwd 起找**最近**一条）⇒ 成立。⇒ §3.4 照抄两条；A14 加"先 `set(cwd,true)` 再选它 → cwd 那条消失" |
| **S7** | §7 M2 会去改一个 git 跟踪的文件，而**本仓自己就带着** `.pi/settings.json` | ACCEPT（已复核） | `git ls-files .pi` → `.pi/settings.json` ⇒ 成立。⇒ M2 改成"在 `os.tmpdir()` 下**新建**目录 + `File > Open Folder…`"，并明说不要动本仓的 `.pi/` |
| **S8** | VS Code 的工作区信任与 pi 的项目信任是两套闸门，计划一个字没提 | ACCEPT | §3.5 加"两层信任的分工"（含 `untrustedWorkspaces.supported === false` 这条事实），README 与模态文案同步 |
| **N1** | §8 的 W0 期望数字没更新（加 T14 后是 16 项 / 15 PASS） | ACCEPT | §8 改成 **15 PASS / 0 FAIL / 1 SKIP（= T12）**，并写明 15→16 的来由 |
| **N2** | §3.1-3 与 §3.6 对"上限"的口径要合成一句 | ACCEPT | §3.1 写死"**一个 map、上限只数 decided**"，§3.6 改成"所以 200 只对 decided 生效（pending 天然 ≤1）" |
| **N3** | A15/A15b 的时序互斥 | ACCEPT | A6b 写明"`onApprovalPending` 里**先** `snapshot()` 断言 pending、**再** decide；第二轮之后再 `snapshot()` 断言字段消失" |
| **N4** | F11 少记一条关键事实：inline 扩展在预信任阶段实例化、最终集合**复用同一实例** | ACCEPT（已复核） | 核了 `resource-loader.js:444-447` ⇒ 成立，不会双注册 `tool_call`。⇒ 新增 **F11b** |
| **N5** | C1 的"一个字节都不多发"没有断言 | ACCEPT | 并进 A6（第五态：没问过 → `fieldsOf` 恒 `{}`）与 A6b ③（`off` 档的 `snapshot()` 不带 `approval`） |

**STRONGEST_OBJECTION**（"这份计划把『审批确实生效』的举证责任，全压在几条分不清『闸门在工作』与『闸门不存在』的断言上"）：
**照单全收** —— S2 的修法就是冲它写的（同一个会话切三档 + `errors` 为空 + 第 ③ 项阳性证据）。
它附的那句方法论要记牢：**"跑真 pi"只保证断言在场，不保证断言能分辨**；这与 AGENTS.md §2 的
"判据的主语被悄悄换掉"是同一副面孔（C1 的主语是"**off 这一档**"，而 A3① 原来的主语是"回调的调用次数"）。

**本轮之后新增/改动的、评审者尚未复核的内容**（第 2 轮请重点看）：
1. B1 的改法（A8b 的结构断言 + Enter 的 `preventDefault` 那条）；
2. S1 的改法（reason 分开 + A5b 放纯函数层的理由）；
3. **A6b 这个新夹具**（包一层真 pi 的句柄驱动真 controller）—— 它是 C1/C6 的主守卫，也是本阶段最重的装配；
4. Q10（webview 销毁不取消）与随之要改的 `PLAN.md` §5.3 那一句；
5. §3.5 新增的"两层信任的分工"。


### 第 2 轮（2026-09-15，同一评审者，复核第 1 轮的修订；结论 `VERDICT: BLOCKING`，1 B / 6 S / 5 N）

**处置：12 条全部 ACCEPT。** 评审者确认第 1 轮的 16 条**没有一条被降级**、4 条改法的方向都对；
本轮 1 条 B 是冲我**第 1 轮自己补的那条断言**来的（A9 的 `preventDefault`），5 条 N 里有 2 条是转写/引用级。
我自己复跑了它给的每一条关键事实（happy-dom 20.14.5 的原生激活、`teardownCurrent:105` 与 `dispose:590`、
`runtime.services`、`resource-loader:446/:450`），**全部命中**。

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | A9 新加的「去掉 `preventDefault()` → 两条消息 → 红」在 happy-dom 里**不可能红**（它不实现 `<button>` 的原生激活）—— 正是第 1 轮 B1 刚修掉的那一类 | ACCEPT（已实测） | 复跑确认：`Enter + preventDefault: ["keydown:Enter"]`、`Enter 不带 preventDefault: ["keydown:Enter"]`（都不补 click）⇒ 断言的"红法"不存在。**改法选它给的第二条路**：**审批控件不写键盘分支**（真 `<button>` 的原生激活会补 `click`，被捕获阶段的点击委托接住 ⇒ "一次按键只发一条"是**构造保证**），并把"键盘可达性"的守卫交给 **A8b(b) 的 `tagName === BUTTON`**；若真机（M1 的 Tab+Enter 那次）发现激活到不了委托，再回到"keydown + 第 2 轮给的那条 UA 复刻 oracle"（`defaultPrevented === false` 才补一次 `click()`） |
| **S1** | §3.1 的**伪代码**仍把 `cancelled` 写成 `Rejected by user`，与同节第 4 条正面打架 | ACCEPT | 代码块改成按 `outcome` 分支（`Cancelled: session ended` / `Rejected by user: …`），删掉"cancelled 也走这里"那句注释 |
| **S2** | A5b 的"端到端会恒绿"结论对、理由不全；补完理由后它应改写成**漂移守卫**，并更正评审第 1 轮 S1 的机制表述 | ACCEPT（已复核） | 核了两条 abort 链（`agent-session-runtime.js:105`、`agent-session.js:590`）⇒"今天必然被覆盖"成立。⇒ A5b 的行内写明定位（守"pi 哪天不再 abort"）+ 附两条行号；§10.1 的 S1 行也标了"第 2 轮收窄" |
| **S3** | A6b 这条路能走通，但需要**三个**接缝（不是计划里写的一个）；另要给成本失控时的退路 | ACCEPT（已复核） | 核了 `SessionHostControllerOptions.pi` 的两种形态与 `host.runtime.services`（`agent-session-runtime.d.ts:53`）⇒ 不需要新选项。⇒ A6b 写明三个接缝（`createAgentSessionFromServices` 换流 / `ModelRuntime.create` 后塞内存 key / `sessionsRoot` 给临时目录）+ 退路（退成"派生函数在两条路都被调用"+ A15b 回 controller-check，并在 §11 记为降级）+ 白捡的"实时 `onPending` 就地重发"断言 |
| **S4** | Q10 裁掉"销毁即取消"之后留了个洞：视图再也不回来时那条待审批项没有任何后续提示 | ACCEPT | Q10 的裁决里补"**视图销毁时（以及面板重建后仍有 pending 时）再弹一次 Q9 的通知**"；A7 加一条断言。这是它给的第三选择，成本比"取消"低、又不丢 C6 |
| **S5** | Q10 用一条**未实测**的断言（"视图销毁比看上去频繁"）去支撑改 PLAN 正文 | ACCEPT | 删掉那条论据（改由"与 C6 **互斥**"单独支撑），并把"未实测"写成事实 **F26**（`retainContextWhenHidden` 下 `onDidDispose` 的行为本仓没测过） |
| **S6** | §3.5 两处措辞会带偏：①"用户会看到**两次**询问"（VS Code 那次只在打开文件夹时问、且记住）②触发我们询问的不只是 `.pi/`（`.agents/skills` 也算） | ACCEPT | ①改成"**可能连着看到两个对话框，也可能只看到我们这一个**"；②文案与 §3.5 把两种触发源都写出来，M2 的检查点跟着改 |
| **N1** | §6 前言与 A2 的单元格对"共用夹具"的清单不一致，还引用了不存在的 `A3b` | ACCEPT | 两处统一成 **A3/A4/A5/A6b** |
| **N2** | A3 的"`errors` 为空"没写怎么拿到 `resourceLoader` | ACCEPT（已复核） | A3 里写死 `host.runtime.services.resourceLoader.getExtensions().errors`（`agent-session-runtime.d.ts:53` ⇒ 零生产改动） |
| **N3** | F11b 的行号 `:444-447` 略偏（真正复用 inline 的是 `:446`、拼回最终集合是 `:450`） | ACCEPT（已复核） | 按它给的两处行号改写 |
| **N4** | A8b 只钉了"兄弟关系"，没钉"审批控件是真 `<button>`"（键盘可达性的来源） | ACCEPT | A8b 拆成 (a) 兄弟关系 + (b) `tagName === "BUTTON"` 且 `type === "button"`；这也正好接手了 B1 那条"键盘路径的唯一守卫" |
| **N5** | A9 把 Enter 与 Space 写成"同规格"，但真浏览器里激活时刻不同（Enter 在 keydown、Space 在 keyup） | ACCEPT | 选了 B1 的"不写键盘分支"那条路 ⇒ 这条自动消失（A9 的键盘段改成"不在这里测"并写明理由） |

**STRONGEST_OBJECTION**（"『修复恒绿断言』这件事本身刚刚复发了一次 —— 第 1 轮的教训被当成一次修补，而不是一条纪律"）：
**照单全收**。它把那条纪律补成了完整形态：**"这条断言红的时候，是被测实现坏了，还是夹具/测试台变了？"**
—— 答不上来的断言（比如"按 Enter 会怎样"）就不该写在 happy-dom 的测试里。
这与 AGENTS.md §2 的"新断言要有能红验证"是同一句话，我这一轮把它当成了**每次写下断言时**要过的门槛。

**本轮之后改动、评审者尚未复核的内容**（第 3 轮只核转写即可）：
1. §3.1 的伪代码按 outcome 分支（S1）；
2. A5b 的定位与两条 abort 行号（S2）；§10.1 的 S1 行加"第 2 轮收窄"；
3. A6b 的三个接缝 + 退路 + 白捡的断言（S3）；
4. Q10 的"再弹一次通知" + A7 的新断言（S4）、删掉未实测论据 + 新增 F26（S5）；
5. §3.5 的两处措辞 + M2 的检查点 + M1 新增的 Tab+Enter 一步（S6）；
6. A8b 的 (a)/(b) 拆分、A9 的键盘段、§3.3 的"不写键盘分支"（B1/N4/N5）；
7. F11b 的行号、A2 的共用清单、A3 的访问路径（N1/N2/N3）。


### 第 3 轮（2026-09-15，同一评审者，**只做转写核对**；结论 `TRANSCRIPTION: 12/12 落实，3 处转写错误`）

**处置：3 条全部 ACCEPT 并已修**。它机械对照了 §10.2 声称的 12 条处置与 7 处"尚未复核"的改动
（逐条给出正文行号）、编号连续性（F/C/A/Q/R 五类逐类扫）、以及"声称保留、确认没被改坏"的清单；
另有一处它明确判定**不是错**（§2「做」第 4 条的"键盘"指交付的能力、不是要写键盘分支）。

| # | 转写错误 | 处置 |
| --- | --- | --- |
| T1 | **硬矛盾**：§3.3 与 A9 都已改成"审批控件不写键盘分支"，但 §9 第 3 步（**实施时照着做的清单**）还写着要写 `main.ts` 的"键盘 `preventDefault`" ⇒ 照它写出来的正是 B1 刚删掉的那段代码，而 A9 已不再测它 | ✅ 改成"**审批控件不写键盘分支**（§3.3 的理由）" |
| T2 | 三处"未经复核"标记已过期（§3.1-4、§3.5 的两层信任、A6b —— 它们在第 2 轮都被复核并改过），留着等于正文说"没人看过" | ✅ 三处都换成了带追溯的措辞（"第 1 轮补、第 2 轮复核并收窄"/"第 2 轮 S6 改定"/"第 2 轮 S3 补齐接缝"） |
| T3 | F26 插在 F22 与 F23 之间，编号不再单调（无缺号、无重号） | ✅ 移到 F25 之后（表尾） |

> **这 3 条修完没有再复核**（纪律：三轮之后的改动一律标"未经复核"）。它们全是转写级
> （一句实施清单的措辞、三处标记、一行表格的位置），不涉及设计判断。
> 评审者在 T3 里还顺手更正了它自己第 2 轮引的一处行号（`agent-session-runtime.js:105` 才是
> `await this.session.abort()`，第 2 轮它写的 `:104` 是上面那行注释）—— 我正文里写的 `:105` 是对的。

## 11. 实施期发现

| # | 发现 | 处置 |
| --- | --- | --- |
| 2-1 | **`ask` 的"永不无限挂"漏了 `onPending` 这条**：夹具里我把 `answer` 写错成字符串，`onPending` 一抛，`waiting` 里就留下一条永远没人答的记录（`pending` 恒为 1），而 handler 的 catch 又把它变成"fail-closed 拦下"。⇒ 计划只写了 signal 那一段，实际整条路都得包 | `createApprovals` 里把 `options.onPending` 包 try/catch：抛错 → 记一行 + 按 `cancelled` 收口；A6 加一条断言（能红：去掉那个 catch → 那条红） |
| 2-2 | ⚠️ **挂住的 promise 会让 node 以 `exit 13` 静默退出、一行输出都不打**（实测：把 `ask` 的中止监听去掉 → `HOST-CHECK` 连 `ok` 行都没了）。这对"能红验证"是坏形态：红了，但看不出是哪条判据 | host-check 的 S8 段加两个助手：`settled(promise, label, ms)`（等"应该收口"的东西，带超时）与 `safeDispose(host)`（`finally` 里卸载也要带超时 —— 卡住的 `dispose()` 会把整段拖成 exit 13）。现在同样的破法给出 12 条**指名**的 FAIL |
| 1-1 | 夹具用 `os.tmpdir()` 直接建目录时，macOS 的 `/var → /private/var` 会让"清理守卫"里的字符串比较假红（S5 的 6-8 同类坑） | 一次性目录一律建在 `fs.realpathSync(os.tmpdir())` 之下 |
| 5-1 | ⚠️ **`vscode` 桩的 `Uri` 没有 `fsPath`**（只有 scheme/path/query/fragment）⇒ `workspaceCwd()` 静默返回 `cwd: undefined`，命令拿它去问 pi，**在 pi 内部才炸**（`normalizePath` 里 `undefined.startsWith`）。桩缺一个成员时，坏的是**被测代码看到的输入** —— 这类缺口永远不会以"桩不对"的形式报错 | 给桩的 `Uri` 补 `fsPath`（读 `path`），并在注释里写明这次是怎么发现的。顺带把 `workspace.workspaceFolders` 也挪进共享状态（它原先是个裸导出对象，esbuild 内联之后检查脚本改的是**另一份副本**）：新增 `setWorkspaceFolders()` |
| 5-2 | 🔴 **"裁决函数对"与"我们把它接上了"是两件事**：A10 原先直接调 `createAgentSessionServices` 验 resolver 的**机制**，把 `session.ts` 里传钩子的那三行删掉，A10 照样全绿（破法 ⑧ 一条都没红）。这正是第 1 轮 S2「闸门不在场」的同构形态，只是换到了信任这一侧 | A10 补第 ⑨ 条：**经生产装配路径**（`createSessionHost({projectTrust})`）断言 `services.settingsManager.isProjectTrusted() === true` 且项目设置真的改变了可用工具集。补完之后破法 ⑧ 红 |
| 5-3 | 生产路径的可用工具集**不是**"只剩 `read`"：我们自己的 `write` 包装作为 `customTools` 会被追加进活动集（S7 的机制）⇒ 信任打开后项目级 `defaultTools` 拿掉的是 `bash`/`edit` | 断言写成 `includes("read") && !includes("bash") && !includes("edit")`，并把这个组合写进注释（两个阶段的机制叠在一起时才看得见） |
| 6-1 | T14 第一版"等这一轮又问了一次"的条件写成 `asked.at(-1) !== "bash"`，而前面几轮里也有 `bash` ⇒ 循环立刻退出、断言看到 `pending=0`（**假红**） | 改成比对**个数**（`asked.length === beforeHang`）。教训与 A14 最初那条同构：**用"状态"当等待条件时要想清楚它是不是唯一的** |
| 6-2 | A6b 的假模型剧本"用一格少一格"，第二轮不重置回合计数就会拿到 `undefined` ⇒ 那一轮没有工具调用，断言失败但**不是实现的问题** | 夹具暴露 `setScript(steps)`（换剧本 + 回合计数归零），并把这句写进注释 |
| 6-3 | T14 在 `selftest.ts` 里是 **TypeScript**：假流要满足 `StreamFn` 的声明类型（要求 `AssistantMessageEventStream` 的队列细节），而循环实际只用 `for await` + `result()` | 用一次**显式**断言 + 两行注释说明断言的理由（不用 `any`）；host-check 是 JS，同一份假流不需要这层 |
| **M1-1** | 🔴 **真机验收（M1）抓到的真 bug**：宿主侧自己攒了一份"待确认"副本（`chatView.pendingApprovals`），而它**只在"面板点按钮"那条路上被删** —— 被**中止**结掉的（以及会话替换/卸载清掉的）永远留着，于是通知里的计数**只增不减**。用户的证据：Output 里连着三行 `[approval] 面板可见，不再弹通知（1 / 2 / 3 个待确认，最新：bash）` | 去掉那份副本：新增 `ApprovalStore.pending()`（**唯一权威**），`chatView.announcePendingApproval()` 每次都问 `controller.pendingApprovals()`；A7 加**回归断言**（数字跟着 controller 走：2 → 1 → 不弹），破法（宿主自己攒一份）→ 那条红。§7 的 M1 检查点也补了"答一个/中止一个之后再来一次，数字不累加" |
| **M2-1** | M2 第一次写给用户时**太长**（四步 + 手工建夹具 + 反复切窗口/重载），用户反馈"看不懂、好复杂"。而其中真正只有真机能验的只有两件事："模态真的弹出来且文案对""点下去真的生效" | ①夹具改由我 `bash` 建好（`/tmp/s8-trust-demo`）；②"不信任/仅本次/重载不再问"本来就由 A11②⑤/A12 钉着 ⇒ 从人工清单里删掉；③新增 **A10⑩**（真 controller + `askProjectTrust` → 项目设置真的改变工具集），把"接线"也搬进自动断言。M2 从"4 步 + 4 个子场景"缩到 **3 下**（开文件夹 → 点「信任并记住」→ 发一句话）+ 1 次命令 |
| **M2-2** | 真机看到的模态与桩里"一样但多一个按钮"：macOS 的**原生模态会自动加一个 `Cancel`**（我们传给 API 的只有三个：信任并记住 / 仅本次信任 / 不信任），所以用户看到四个。`Cancel` 与 `Esc` 一样返回 `undefined` ⇒ 落到"**不信任且不写文件**"（安全方向）。**但文案上"Cancel"与"不信任"并存会让人犹豫**，而这是 macOS 的原生行为、API 控制不了 | 记成**已知行为**（不改代码）：不动它；A13 的"三个按钮"断言仍然成立（断言的是我们**传进去**的 items，桩记录的就是那三个）。若将来要消掉它，只能去掉 `{modal:true}`（那会变成没有焦点的通知，更差） |
| **M2-3** | 真机同时看到**两层信任**：dev host 窗口里有 VS Code 自己的 `Restricted Mode` 横幅（未信任这个文件夹），而我们的模态照样弹出 —— 因为 **F5 的 dev host 会无条件加载开发中的扩展**，`capabilities.untrustedWorkspaces.supported=false` 在那里不生效。Marketplace 装的正规用户处在这个状态时，扩展**整个不会被激活**（我们声明过），也就看不到这个模态 | 不是缺陷，但值得写清：README 的"两层信任"那段已经写了"后者决定要不要在窗口里启用扩展"，这里补一句 dev host 的例外给将来的验收者看 | 
| **P-1** | `node scripts/compare-vsix.mjs` 在本机**必须带 `NODE_USE_ENV_PROXY=1`**：它用 Node 的 `fetch` 去 Marketplace 取包，而本机的代理只写在环境变量里（`http_proxy=http://127.0.0.1:7897`），Node 的 fetch **默认不看**环境变量 ⇒ 第一次跑是 `UND_ERR_CONNECT_TIMEOUT`（10s 超时）。这正是 S6 的 L1 那条教训的同一机制（`NODE_USE_ENV_PROXY` 只在**进程启动前**设才有效） | 记进 §12.3 的命令示例；将来给 `compare-vsix.mjs` 的用法注释补一行（不是缺陷，是环境约定） |
| **W0-1** | 🔴 **Windows W0 抓到：T14 FAIL `E_APPROVAL_NOT_EXECUTING`（"允许之后 bash 没有执行"）—— 是夹具的锅，不是产品的锅**。T14 里那条 bash 命令用了 **Windows 形态的路径**（`touch C:\Users\…\t14-marker.txt`），而 **Git Bash 会把命令里的反斜杠当转义吃掉** ⇒ 实际建出来的是 cwd 下一个叫 `C:Usersfengrui…t14-marker.txt` 的文件，于是"断言里用 Windows 形态去 `existsSync`"必然为假。本机复现（macOS 的 bash 同一条规则）：`bash -c 'touch C:\Users\x\y.txt'` → `ls` 出来的是 `C:Usersxy.txt` | 凡是**拼进 bash 命令**的路径一律前斜杠（`marker.split("\\").join("/")`，MSYS 会转成 `/c/...`）；T14 里那三处命令 + host-check/controller-check 的同类夹具（7 + 1 处）一起改，并把这句写进 T14 的注释。**教训**：跨平台的夹具里，"路径用哪种写法"和"谁来解释它"是两件事 —— bash 命令里的路径由 **shell** 解释，工具参数里的路径由 **pi** 解释 |
| 6-4 | 顺手确认了一件好事：**待审批时 `dispose()`** 会让 pi 把手里的 `ctx` 判成 stale（`This extension ctx is stale after session replacement or reload`）—— 我们的处理器把它 catch 住并 **fail-closed 拦下**，所以"边挂边卸载"不会变成"静默放行" | 这正是文件头第 2 条想要的行为；A5（host-check）断言了待审批在替换/卸载后清零 |

**实施期的"能红验证"记录（每步都做了，破法 → 红在哪）**：

| 步 | 破法 | 结果 |
| --- | --- | --- |
| 1 | 大小写不敏感 / mutating 连 read 也拦 / 手塞只读名单 / cancelled 沿用 Rejected / 出错直接抛 / off 也去问 / 上限算上待答 / 没问过也派生 | 8 种全部红（见提交 `d167cee`） |
| 2 | `needsApproval` 一律放行（闸门形同不存在） | 红 10 条；**A3①/② 照样绿** —— 这正是第 1 轮 S2 要防的形态，靠 A3③④ 才红 |
| 2 | 审批扩展没挂上（F10b 的静默缺席） | 红 10 条（含"扩展在场"那条） |
| 2 | 拒绝的理由写死 | 红 4 条 |
| 2 | `ask` 不监听 signal | 红 12 条（含 A4/A5 的全部收口判据） |
| 2 | 拒绝理由不带标题 | 红 4 条 |
| 3 | 审批行挪进标题按钮内部 | A8b(a) 红（DOM 层）—— 结构不变量正是"点了不会展开"的守卫 |
| 3 | 控件改成 `<div>` | A8b(b) + A8 的 `type="button"` 红（键盘可达性的唯一守卫） |
| 3 | 点击委托去掉审批两条分支 | A9 的两条点击红 |
| 3 | `denied` 也渲染按钮 | "按钮消失、出现已拒绝"红（render + DOM 两条路） |
| 3 | 状态行不喊"等待确认" | A9/Q8 红（Q8 的判据本身） |
| 3 | `toolCallId` 不转义 | A8 的转义红 |
| 4 | chatView 不转发 `approvalDecision` | A7 的三条红 |
| 4 | 不判 `view.visible`（面板可见也弹通知） | A7"可见时不打扰"红 |
| 4 | 去掉 Q10 的"销毁再喊" / "重建看快照" | A7/Q10 两条各红 |
| 4 | 点了「打开面板」不聚焦 | A7 的聚焦红 |
| 5 | 忽略 trust.json 的记录 / 没资源也照问 / 把 false 也写进去 / 忽略 memo / 忽略 defaultProjectTrust / ESC 当信任 / "信任父文件夹"只写一条 | 各 1–2 条红（A11①–⑥、A12、A13、A14） |
| 5 | **装配里不传 `resolveProjectTrust` 钩子** | 第一次跑**一条都没红** —— 见 §11 的 5-2（补了"生产装配路径"那条断言之后才红） |

## 12. 实施与验收结果

### 12.1 自动检查（**全绿**，2026-09-15）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ |
| `npm run self-test` | **9/9**（protocol 112 / render **128** / tool-text 91 / settings 16/16 / webview-dom **91** / host-check **322/322**） |
| `npm run check:controller`（真模型，不进 CI） | **110/110**（含 A15：`all` 档下拒绝→副作用没发生→允许→真的执行） |
| `npm run check:gate`（无头跑 `Pi: Run Self-Test`，不进 CI） | **16/16 GATE PASS**（新增 T14；本机 T12 也 PASS ⇒ 0 SKIP） |
| `npm run package` + `check-vsix` | **0.1.11：338 文件 / 5.77 MB**（与 0.1.9/0.1.10 文件数相同） |

### 12.2 提交切分（实际）

| 提交 | 内容 |
| --- | --- |
| `d167cee` | 第 1 步：三档判定 + 审批表 + inline 扩展（A1/A5b/A6） |
| `e31b2dc` | 第 2 步：装配接线 + 协议 v6（A2/A3/A4/A5） |
| `78f9044` | 第 3 步：卡片上的「允许 / 拒绝」+ 状态行提示（A8/A8b/A9） |
| `db2995f` | 第 4 步：宿主路由 + 通知（A7） |
| `344e7aa` | 第 5 步：项目信任（A10–A14） |
| `4c547d7` | 第 6 步：A6b + 自测 T14 + 真模型 A15 + 文档 + `PLAN.md` §5.3 改口 |
| `3807eff` | 0.1.10 打包（**验收时被 0.1.11 取代**） |
| `41467b5` | 🐞 **M1 真机验收的修复**：待确认计数只增不减（§11 的 M1-1）+ 回归断言 |
| `4e20832` | A10⑩（controller 的信任接线）+ M2 简化（§11 的 M2-1） |
| `291c068` | M2 的两条发现入档（macOS 的 Cancel 按钮、dev host 忽略 untrustedWorkspaces） |

### 12.3 人工验收

**Mac（M1/M2）—— ✅ PASS（2026-09-15，0.1.10 发现一个 bug → 0.1.11 复验通过）**

| 项 | 结果 |
| --- | --- |
| M1 ① 拒绝 | ✅ 卡片上出现「允许 / 拒绝」，`touch /tmp/s8-m1.txt` 被拒后**文件不存在**（我用 `ls` 独立核对过）、卡片标「已拒绝」、正文 `Rejected by user: touch /tmp/s8-m1.txt` |
| M1 ② 允许 | ✅ 第二个调用被允许 → `/tmp/s8-m2.txt` 内容 `hello`（独立核对） |
| M1 ③ 中止 | ✅ 待审批时点「中止」→ `Operation aborted`、待确认项消失、能继续输入 |
| M1 ④ 键盘 | ✅ **Tab 走到「允许」+ Enter**；`echo kbd >> /tmp/s8-kbd.txt` **恰好一行** ⇒ 一次按键只发一条（真浏览器里的构造保证） |
| M1 ⑤ 通知 | ✅ 面板不可见时弹通知、按钮「打开面板」能回来、卡片上按钮还在、还能答 |
| M1 ⑥ **计数（回归）** | ✅ 0.1.11 上：第一轮答完后再触发 → 通知仍写**"有 1 个"**（0.1.10 上是 1→2→3，见 §11 的 M1-1） |
| M2 模态 | ✅ 文案/按钮/路径都对（截图逐条核对）；macOS 另加了一个 `Cancel`（= 不信任且不写文件，见 §11 的 M2-2） |
| M2 信任生效 | ✅ 点「信任并记住」后模型自述"只有 read 和 write，没有 bash"——项目级 `defaultTools:["read"]` 真的被读了（与 A10/A10⑩ 的断言一致） |
| M2 清除记录 | ✅ 执行后 `~/.pi/agent/trust.json` 里**没有** `s8-trust-demo` 的残留（我独立核对；同文件里另有两条用户自己/CLI 写的记录，未被我们碰过） |

> 验收期间我**没有**动用户的任何数据：临时夹具（桌面那份 + `/tmp` 里的几个文件）都是我建的、测完由我 `rm` 掉；
> `~/.pi/agent/trust.json` 只有"用户点「信任并记住」"那一次写入，随后被用户用命令清掉。

**发布核验（2026-09-15）**：用户上传 0.1.11（Pre-Release）后，运行

```bash
NODE_USE_ENV_PROXY=1 node scripts/compare-vsix.mjs 0.1.11   # 本机代理只写在环境变量里，Node 的 fetch 默认不看（§11 的 P-1）
```

⇒ **`VSIX-COMPARE OK 0.1.11`：338 个文件逐个字节相同，整体 `.vsix` 字节也相同**
（6,050,303 字节 / `bd3cdcde541698cc1e861e9adfb9abcdd5d208d3b1b1dfa024b2e76d86bccd47`）；
留档 `~/jerrypi-releases/jerrypi-0.1.11.vsix`；tag **`v0.1.11`** 已打并推送（注解里带字节数与 SHA-256）。

**Windows（W0/W1）—— 0.1.11 第一次跑：`GATE BLOCKED T14`（14 PASS / 1 FAIL / 1 SKIP），已定位并修复**

| 轮 | 结果 |
| --- | --- |
| 0.1.11（第一次） | `T14 FAIL E_APPROVAL_NOT_EXECUTING`（"允许之后 bash 没有执行"）；其余 14 项 PASS、`T12 SKIP E_NO_PI`（预期）。**根因是 T14 夹具的路径写法**：`touch C:\Users\…` 里的反斜杠被 Git Bash 当转义吃掉（§11 的 W0-1，本机已复现同一机制）—— 产品本身没问题（T14 的拒绝/中止两条都过了，说明审批门在 Windows 上工作） |
| 0.1.12 | 修掉路径写法后重打包：`GATE PASS`（16 项）—— 等 Windows 复跑确认 |

### 12.4 已知未覆盖

（待 Windows 验收完一起写）

## 13. 待用户拍板

见 §4 的 **Q1–Q10**。**默认值都是我的建议**；用户说"可以"之后才动代码。
