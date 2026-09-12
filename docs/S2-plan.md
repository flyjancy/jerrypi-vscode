# S2 实施计划：协议与基础聊天

> 依据：`docs/PLAN.md` 第 6 节 "S2 协议与基础聊天"、5.1/5.2/5.3/5.4、R9、D7-S1、D7-S2、D10-S1。
> 前置：S1 已关闭（Mac 与受限 Windows 机双端 `GATE PASS`，见 `docs/S1-plan.md` 第 12 节）。
> **本版已吸收两轮外部评审（Claude Opus 5）：第一轮 `S2-CL-*`、第二轮 `S2-CL2-*`，处置见 §10。**

## 0. 本计划已核实的事实（都带证据，不靠记忆）

写计划前对着 pi 0.85.1 的 `.d.ts` 与本机产物逐条核实过。**下面是 S2 全部设计的依据。**
第 0.5 节是第一版出错、经评审指出后重核的一节，标了 ⚠️。

### 0.1 事件与状态（`pi-coding-agent/dist/core/agent-session.d.ts`）

```ts
export type AgentSessionEvent = Exclude<AgentEvent, {type:"agent_end"}> 
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual"|"threshold"|"overflow" }
  | { type: "compaction_end"; ... }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "auto_retry_start" | "auto_retry_end" | ... }
  | { type: "bash_execution_update"; id?: string; delta: string };
```

`AgentEvent`（`pi-agent-core/dist/types.d.ts`）提供 `agent_start / turn_start / turn_end /
message_start / message_update / message_end / tool_execution_start / update / end`。
`message_update` 里携带 `assistantMessageEvent`，其 `type` 为
`start | text_start | text_delta | text_end | thinking_start | thinking_delta | thinking_end |
toolcall_start | toolcall_delta | toolcall_end`（`pi-ai/dist/types.d.ts`）。

**`message_start` / `message_end` 的发出点（`pi-agent-core/dist/agent-loop.js`，逐行核过）：**

| 行 | 消息 | 说明 |
| --- | --- | --- |
| 52 | 本次 prompt 的 user 消息 | `prompt()` 送的 |
| 114 | steering 注入的 user 消息 | 与 52 同形，路由可合并处理 |
| 205 / 236 / 249 | assistant | 三者**互斥**（`addedPartial` 标志），一条 assistant 只发一次 `message_start` |
| **557** | **toolResult** | `emitToolResultMessage()`：紧接 `message_start` 再发 `message_end` |

→ **结论：`message_start` 不是"assistant 专用"。** 第一版路由表只写了 assistant 与 user 两行，
漏了 toolResult，会导致 webview 收到"从未创建过节点的 `itemEnd`"。已按 `S2-CL-C2` 改为
**统一的 `message_end` 驱动 + upsert 语义**（见 §4.4）。

会话状态读取口（全部是 getter，S2 直接依赖）：

| 成员 | 用途 |
| --- | --- |
| `session.messages` | **"All messages including custom types like BashExecutionMessage"** —— 重放的唯一数据源 |
| `session.state.streamingMessage?` | 进行中的半截 assistant 消息（面板在流式中重开时用它补齐） |
| `session.state.isStreaming` / `session.isStreaming` | 是否有一轮 agent run 在跑 |
| **`session.isIdle`** | 实现是 `!_isAgentRunActive && !isCompacting`（`agent-session.js:620`）。**不能用它判 UI 空闲**（它不看队列），但它是"发送对账"的唯一正确口径（§4.3.1，`S2-CL2-N2`） |
| **`session.state.pendingToolCalls: ReadonlySet<string>`** | 正在执行中的工具调用 id。由 `Agent.processEvents` 在 `tool_execution_start`/`_end` 时维护（`agent.js:392-403`）。**面板在工具执行中重开时，靠它把"运行中…"那一行补回来**（`S2-CL2-N3` 同族的第三处，见 §4.3） |
| `session.state.errorMessage?` | 最近一次失败/中止的错误文本 |

#### 0.1.1 `message_end` 那一刻的下标（`S2-CL2-N3`，全局最脆的一环）

id 规则要用到"这条消息在 `session.messages` 里的下标"，而**只有一种算法是对的**：

- `session.messages` 就是 `agent.state.messages`（`agent-session.js:681-683`）；
- `Agent.processEvents` 收到 `message_end` 时**先** `_state.messages.push(event.message)`（`agent.js:390`），
  **之后**才 `for (const listener of this.listeners) await listener(...)`（`agent.js:417`）。

→ **在 `message_end` 监听器里，下标恒等于 `session.messages.length - 1`。**

⚠️ 同一份代码里有**两个陷阱**，实现的人极容易踩：

1. **`message_start` 时消息还不在数组里**（那时只设 `_state.streamingMessage = event.message`，`agent.js:383`；
   `message_update` 同理，`agent.js:386`）。
   想在 `message_start` 时算下标一定是错的 —— 所以进行中的那条 assistant 只能用 controller
   铸造并持有的 id（§4.1）。
2. **读 `agent-loop.js` 会得出相反结论**：那边 toolResult 是在整批工具跑完后才
   `currentContext.messages.push(result)`（`agent-loop.js:142-144`），而 `emitToolResultMessage()`
   在 277/318/376 行就发出去了。**`agent-loop` 那份数组是 `createContextSnapshot()` 的副本，
   不是 `state.messages`** —— 两份数组的时序相反。

并行工具调用下踩中陷阱 2 的后果很具体：N 个 toolResult 会算出**同一个下标**，N 条工具行塌成 1 条；
重开面板重放时又变回 N 条。

**因此 S2 的工具行 id 刻意不走下标**（改用 `toolCallId`，`S2-CL2-N4`），
下标只用于历史消息的**批量重放**——那时全部消息已经落定，没有时序问题。

### 0.2 发送语义（本次核实，纠正了旧计划的写法）

- `prompt(text, options?)`：**流式期间调用必须给 `options.streamingBehavior`**，否则抛错。
  非流式时它会**校验模型与 API key**，没有就抛错。另外它**会立即执行扩展命令**（`/smoke` 这类），
  流式期间也执行。
- `steer(text)`：入队，**当前 assistant 轮次执行完工具调用后、下一次 LLM 调用前**投递。
- `followUp(text)`：入队，**只有 agent 没有更多工具调用与 steering 消息时**才投递。
- `steer`/`followUp` 都是 `@throws Error if text is an extension command`。
- `prompt()` 返回的 promise **要到整轮结束才 resolve**（不是"接受即返回"）。

pi 的原始报错文本（从 `agent-session.js` 取出，用于确定重试判据）：

```
Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
```

### 0.3 队列 API 的真实能力（**这条推翻旧计划的一处措辞**）

`agent-session.d.ts` 里与队列有关的**全部**成员是：

```
clearQueue(): { steering: string[]; followUp: string[] }   // 清空全部，返回被清掉的内容
pendingMessageCount: number
getSteeringMessages(): readonly string[]
getFollowUpMessages(): readonly string[]
```

**没有"按条目移除"或"编辑队列中消息"的 API。** 旧计划 5.2 写的"可编辑、可移除"无法实现
（伪实现 = 清空后按剩余项重新入队，会造成投递顺序与内容与用户所见不一致，属于制造假象）。
→ 见决策点 D2，并**同时修正 `PLAN.md` 5.2**（`S2-CL-P3`）。

`abort()` 的实现只有 4 行（`abortRetry / abortCompaction / abortBranchSummary / agent.abort` + `waitForIdle`），
**不清队列**；pi 的 rpc 模式把 `clear_queue` 做成独立命令，由调用方决定。
`clearQueue()` 的文档注释写着 "Useful for restoring to editor when user aborts"。
→ 见决策点 D9。

### 0.4 渲染安全（实跑验证，不是推断）

pi 自带的 `dist/core/export-html/vendor/marked.min.js` 是 **marked v18.0.5**（UMD，版本号在文件头）。
其模板 `template.js` 里的消毒配置可直接照抄：`html()/tag()` tokenizer 返回 `undefined`（HTML 当纯文本）、
`link`/`image` renderer 走 `sanitizeMarkdownUrl` 白名单、`escapeHtml`。

本机用这份 marked + 照抄的配置跑了 **12 个载荷**，全部安全：

| 载荷 | 输出 |
| --- | --- |
| `<img src=x onerror="alert(1)">` | `&lt;img src=x onerror=&quot;alert(1)&quot;&gt;`（纯文本） |
| `<script>alert(1)</script>` | `&lt;script&gt;alert(1)&lt;/script&gt;`（纯文本） |
| `<svg onload="alert(1)">` | 转义为纯文本 |
| `<iframe src=…>` | 转义为纯文本 |
| `[x](javascript:alert(1))` | `<p>x</p>`（链接被降级为纯文本） |
| `[x](JaVaScRiPt:alert(1))` | `<p>x</p>` |
| `[x](java\x01script:alert(1))` | 不成链接，原样文本 |
| `[x](data:text/html;base64,…)` | `<p>x</p>` |
| 正常链接 / 行内代码 / 粗体删除线 | 正常渲染，URL 未被误杀 |
| 正常图片 `![](https://…)` | **用 pi 的原始配置**会渲染成 `<img src="https://…">`；但 **S2 必须降级为 alt 文本**（D1），见下 |

⚠️ 上面这张表是**用 pi 的原始配置**跑出来的（12 条）。S2 在 `image` 上比 pi 更严（D1：只允许 `data:image/`），
所以 **CI 语料必须把图片这条单独断言**（`S2-CL2-N6`：原表里"正常图片→正常渲染"与 D1 自相矛盾）：

| 第 13 条 | 期望 |
| --- | --- |
| `![alt](https://example.com/a.png)` | 降级为纯文本 `alt`，**不产生 `<img>`** |
| `![alt](data:image/png;base64,iVBORw0KGgo=)` | 正常渲染成 `<img src="data:image/png;base64,…">` |

判据（写进 CI 脚本）：转义后的文本里不会出现裸 `<`，因此输出中**所有** `<…>` 都是 marked
自己生成的标签；逐个检查这些标签，禁止出现被禁标签、`on*=`/`srcdoc=` 属性、
`href|src` 指向 `javascript:|data:|vbscript:|file:`。

### 0.5 Webview 宿主 API（`@types/vscode` 1.120.0，逐行核对）

> ⚠️ **本节是第一版出错处。** 第一版把 `index.d.ts` 里一句 **JSDoc 交叉引用**当成了声明证据，
> 写成"`WebviewOptions.retainContextWhenHidden` 对 view 同样有效"。经 `S2-CL-B1` 指出后重核：

| 事实 | 位置 |
| --- | --- |
| `WebviewOptions` 共 **5** 个成员：`enableScripts` / `enableForms` / `enableCommandUris` / `localResourceRoots` / `portMapping` | 9902–9950 |
| `retainContextWhenHidden` 声明在 `WebviewPanelOptions` 里 | 10058 / 10082 |
| `WebviewView.webview` 的类型是 `Webview`，其 `options` 是 `WebviewOptions` —— **不含该开关** | 10236 |
| **该开关对视图的正确入口是 `registerWebviewViewProvider` 的第三参数**：`{ webviewOptions: { retainContextWhenHidden?: boolean } }` | 11754–11776 |
| 右键隐藏视图会 dispose（JSDoc 说明） | 10281 |

→ 因此 `view.webview.options = { …, retainContextWhenHidden: true }` **既过不了 `tsc`
（对象字面量多余属性），运行时也不生效**。§4.4 已改为第三参数形态。

其余（本机核对无误）：

- `localResourceRoots` 是**白名单**：脚本/样式在 `dist/`、图标在 `media/`，**两者都要进名单**，
  否则得到"面板打开但空白/无样式"（`S2-CL-B2`）。S2 直接放行 `extensionUri`（整仓根），
  并在 §6 的 F5 项里验证。
- `<viewId>.focus`（`jerrypi.chat.focus`）由 VS Code 自动注册。
- CSP 用 `webview.cspSource` + nonce；本地资源用 `webview.asWebviewUri`。

### 0.6 S1 已有的可复用件

`loader.ts`（`loadPi`/`reloadPi`/`PiModule`）、`runtime.ts`（`ModelRuntime` 单例 + SecretStorage key 注入）、
`session.ts`（`createSessionHost`，含 rebind、`projectTrusted:false`、`customTools`、`onEvent` 出口）、
`bindings.ts`（`bindSession` + `SessionBinding`）、`commands.ts`、`selftest.ts`。
**S2 不改 S1 自测契约**（首行/`T<n>`/`GATE` 格式与判定规则原样保留）。

---

## 1. 范围

### 1.1 做

1. `src/shared/protocol.ts`：`ClientMessage` / `ServerMessage` 联合类型 + `PROTOCOL_VERSION`。
2. `src/pi/controller.ts`：面板会话主机 `SessionHostController`，提供
   `ensure() / prompt() / steer() / followUp() / abort() / clearQueue() / snapshot() / dispose()`。
3. `src/pi/model-choice.ts`：把 S1 `selftest.ts` 里的模型对齐逻辑提取出来共用（见 §4.3 的重构纪律）。
4. `src/host/chatView.ts` + `src/host/webviewHtml.ts`：`WebviewViewProvider`、消息路由、
   **状态重放**、CSP/nonce、`openExternal` 代理。
5. `src/webview/render.ts`：markdown（marked + pi 的消毒配置）、思考块、工具行、错误块。
6. `src/webview/main.ts` + `src/webview/style.css`：输入框、流式文本、思考块折叠、中止按钮、
   队列条、状态行；只用 VS Code 主题变量。
7. `esbuild.mjs` 增加 webview 入口（`platform: browser`、`format: iife`）与 CSS 入口。
8. `package.json`：`viewsContainers.activitybar`、`views`、`media/jerrypi.svg` 图标；
   `jerrypi.focusChat` 真正聚焦视图。
9. `scripts/render-xss-check.mjs`：**CI 可跑**的渲染安全回归（§0.4 的 **12 + 1** 个载荷）。
10. README 补使用说明与已知限制（远程图片不加载、队列只能整体清空、窗口重载不恢复历史）。

### 1.2 不做（留给后续步骤）

| 不做 | 留给 |
| --- | --- |
| bash/read/edit/write 的**卡片**（完整参数与结果、折叠、bash 输出流式、点路径开文件） | S3。**S2 只显示一行**：`工具名 + 参数摘要 + ✓/✗`，且**实时与重放两条路径完全一致**（见 §4.2） |
| 模型选择器、思考等级切换、状态栏用量 | S4 |
| 会话列表 / 恢复 / 窗口重载后 `continueRecent` | S5 |
| VS Code 设置项、`Clear Stored API Keys`、项目信任 UI | S6 |
| diff 审阅 | S7 |
| 工具审批 | S8 |
| 语法高亮（hljs）、图片附件、复制按钮、搜索 | 未排期 |
| 面板内 `!` 直接执行 bash | 未排期 |

---

## 2. 文件清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/shared/protocol.ts` | 新增 | 两端共享的唯一契约 |
| `src/shared/urlPolicy.ts` | 新增 | 链接/图片 scheme 白名单的**唯一**常量（render 与 openExternal 共用，`S2-CL-S2`） |
| `src/pi/controller.ts` | 新增 | `SessionHostController`：懒加载 + 单会话生命周期 + id 权威 |
| `src/pi/serialize.ts` | 新增 | `AgentMessage[] → ChatItem[]`（重放与增量共用） |
| `src/pi/model-choice.ts` | 新增 | 从 `selftest.ts` 提取的 `ALIGN` 逻辑（`alignModel` / `PREFERRED_*`） |
| `src/host/chatView.ts` | 新增 | View provider、路由、重放、CSP、`openExternal` |
| `src/host/webviewHtml.ts` | 新增 | 生成带 nonce 的 HTML（纯函数，可单测） |
| `src/webview/render.ts` | 新增 | markdown 消毒渲染（纯函数，可在 Node 里测） |
| `src/webview/main.ts` | 新增 | DOM 与交互 |
| `src/webview/style.css` | 新增 | 主题变量 |
| `media/jerrypi.svg` | 新增 | 活动栏图标（单色 24×24） |
| `src/extension.ts` | 改 | 注册 view provider（三参数形态）；`focusChat` 聚焦视图 |
| `src/commands.ts` | 改 | `jerrypi.focusChat` 改为聚焦视图；新增 `Pi: New Session` |
| `src/pi/selftest.ts` | 改 | 改为调用 `model-choice.ts`（**行为等价重构，单独 commit**） |
| `esbuild.mjs` | 改 | 双入口三产物 |
| `package.json` | 改 | contributes + `marked` 精确版本 devDependency |
| `scripts/render-xss-check.mjs` | 新增 | CI 安全回归 |
| `scripts/check-vsix.mjs` | 改 | 增加三个新产物的存在性断言 |
| `scripts/self-test.mjs` | 改 | 增加 case：render 安全脚本必须通过（`TOTAL` 5 → 6） |
| `.github/workflows/ci.yml` | 改 | 增加 `npm run check:render` |
| `PLAN.md` | 改 | 5.2 的"可编辑、可移除"按 §0.3 改写（`S2-CL-P3`） |
| `README.md` | 改 | 使用说明 + 已知限制（中英） |

**新增依赖**：`marked`，**精确 18.0.5**（与 pi 自带的 vendor 版本一致，不加 `^`）。
不引入 hljs（见 §1.2），不引入任何前端框架。

---

## 3. 不可违反的约束

1. **`render.ts` 是唯一的 HTML 生成点。** webview 里除了它返回的字符串，任何地方不得把数据写进
   `innerHTML`；流式文本一律用 `textContent` 追加。
2. **webview 不加载任何远程资源。** CSP 全串（`S2-CL-B3`：`default-src 'none'` 是"全都不许"，
   必须显式放开 `style-src`，否则样式表被拦、面板无样式）：

```
default-src 'none';
img-src ${webview.cspSource} data:;
style-src ${webview.cspSource};
font-src ${webview.cspSource};
script-src 'nonce-${nonce}';
connect-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

3. **不用 `eval`、不内联脚本**（除带 nonce 的 `<script>`）、不 `enableCommandUris`、不 `enableForms`。
4. **扩展侧的 pi 调用全部走 `controller`**，`chatView` 不认识 pi。
5. **空闲判定以 `agent_settled` 为准**，不以第一个 `agent_end`（D7-S2）。
6. **流式期间绝不调无参 `prompt()`**（D7-S1）。
7. `activate()` 保持**非阻塞**（S0-D3）：视图/provider 同步注册，pi 加载与建会话在首次需要时进行。
8. 新增 `commands` 必须保持 S1 自测 T3 的命令标记检查。
9. 扩展产物**不静态 import pi**（沿用 S1 的 `loader.ts` 约束）。
10. `.vsix` 体积门禁仍是 30 MB；`check-vsix.mjs` 必须继续通过。
11. **id 只有一个权威来源：controller；同一实体的 id 在它的整个生命周期里不得改变。**
    进行中的 assistant 用 `activeAssistantId`，**`message_end` 时必须继续用它**（`S2-CL2-N1`）；
    工具行用 `tool-<toolCallId>`（`S2-CL2-N4`）。webview 不得自己造 id。
12. **实时路径与重放路径必须产出同一种 `ChatItem`。** 任何"实时简化、重放完整"的设计都算缺陷
    （`S2-CL-C3`），因为用户重开一次面板就会看到两个样子。
    **允许的例外只有两类，都必须显式登记**：
    1. 实时可以**先**给一个"进行中"的中间态，而重放只产出最终态 —— 前提是两者用**同一个 id** upsert，
       例如工具行的 `运行中…` → `✓`；
    2. **不落入 `session.messages` 的易失提示**：运行时 notice（compaction / auto_retry / willRetry）
       与"无 toolResult 的中止标记"，**重开后不重现**。这类内容不得承载用户需要留存的信息。

---

## 4. 模块设计

### 4.1 `src/shared/protocol.ts`

```ts
export const PROTOCOL_VERSION = 1;

export type ChatItem =
  | { kind: "user";      id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string;
      stopReason: string; errorMessage?: string; streaming?: boolean }
  | { kind: "tool";      id: string; toolCallId: string; toolName: string;
      summary: string; isError: boolean }          // 一行：参数摘要 + 结果状态
  | { kind: "notice";    id: string; level: "info" | "warn" | "error"; text: string };

/** webview → 扩展 */
export type ClientMessage =
  | { type: "ready"; protocol: number }
  | { type: "prompt"; text: string; behavior: "auto" | "steer" | "followUp" }
  | { type: "abort" }
  | { type: "clearQueue" }
  | { type: "openExternal"; href: string }
  | { type: "requestState" };

/** 扩展 → webview */
export type ServerMessage =
  | { type: "state"; protocol: number; items: ChatItem[]; truncated: boolean;
      queue: { steering: string[]; followUp: string[] }; busy: boolean;
      cwd: string; model: string; errorMessage?: string }
  | { type: "item"; item: ChatItem }        // upsert：id 已存在则替换，不存在则追加
  | { type: "delta"; id: string; kind: "text" | "thinking"; delta: string }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "busy"; busy: boolean; errorMessage?: string }
  | { type: "composerError"; text: string }        // 输入框下方的红字（发送失败等）
  | { type: "restoreComposer"; text: string };     // 把文本**退回输入框**（不是错误，见 N5）
```

**id 规则（唯一权威 = controller，`S2-CL-C1` / `S2-CL2-N1` / `S2-CL2-N4`）**

| 对象 | id | 理由 |
| --- | --- | --- |
| 进行中的 assistant | `controller.activeAssistantId`：`message_start` 时铸造一次，**持有到 `message_end`** | 流式中重开面板时 `snapshot()` **复用它**；否则重开后 delta 打向 webview 不认识的 id，后半截全丢（C1） |
| **同一条 assistant 的最终 item** | **强制复用 `activeAssistantId`**，发出后再清空 | 否则 `message_start` 建的节点（`activeAssistantId`）与 `message_end` 产的节点（`msg-<下标>`）**id 不同 → upsert 找不到 → 每条回复都多出一个空壳节点**（N1） |
| 工具行 | `tool-<toolCallId>` | toolResult 消息自带 `toolCallId`（`agent-loop.js:535-554`）。**构造上实时=重放**，不依赖 §0.1.1 那条脆弱的时序规则；且 `tool_execution_start` 与随后的 `message_end` 能 upsert 成同一行（N4） |
| 历史消息（批量重放） | `msg-<在 session.messages 里的下标>` | 批量重放时全部消息已落定，下标稳定；重放两次 id 相同，按 id upsert 不会重复 |
| 运行时提示 notice | **一律用 `notice-<递增序号>`，禁止 `msg-` 前缀** | notice **不是** `session.messages` 里的消息、**没有下标**。若实现者顺手写成 `msg-${length-1}`，`auto_retry_start` 紧跟在某条 assistant 的 `message_end` 之后就会算出**同一个下标**，upsert 会把刚渲染好的回复**整条替换成一行黄字提示**（`S2-CL3-N2`） |

**`item` 是 upsert 语义**（`S2-CL-C2`）：webview 找不到该 id 就**新建**节点。
这样即使某条消息只发了 `message_end`（例如 toolResult），也不会丢。

### 4.2 `src/pi/serialize.ts`

`serializeMessage(message, index, toolCallIndex) → ChatItem | undefined`。
`toolCallIndex: Map<toolCallId, {name, argsText}>` 由调用方**按顺序增量维护**：遇到 assistant 消息就把它的
toolCall 块登记进去，遇到 toolResult 就用 `toolCallId` 取参数摘要。
（`toolName` 与 `toolCallId` 在 toolResult 消息上**本来就有**，不必依赖索引；索引只用来补参数摘要。）

| pi 消息 | 产物 |
| --- | --- |
| `role: "user"` | `{kind:"user"}`，content 里的 text 块拼接；图片块 → 追加 `[图片]` 占位（附件功能未做） |
| `role: "assistant"` | `{kind:"assistant"}`：text 块拼接、thinking 块拼接；带 `stopReason`/`errorMessage`。**不带 toolCalls 字段**（S2 的卡片范围只在 §1.2） |
| `role: "toolResult"` | `{kind:"tool"}`，**id = `tool-<toolCallId>`**：`toolName` + **参数摘要**（来自 `toolCallIndex`，取不到时留空）+ `isError`。**不显示结果正文**（`S2-CL-C3`：S2 不含工具卡片，正文是 S3 的范围；否则重放一次就把"不做的功能"冒出来了） |
| `role: "custom"` / `"bashExecution"` | `{kind:"notice"}`（内容为文本摘要） |
| `role: "compactionSummary"` / `"branchSummary"` | `{kind:"notice"}`（"上下文已压缩"等） |
| 其它未知 role | `{kind:"notice", level:"warn"}` + 原样 `role` —— **不静默丢弃** |

常量（导出以便测试）：`SUMMARY_MAX = 200`（参数摘要上限）。

**重放总量上限**（`S2-CL-S5`）：`MAX_REPLAY_ITEMS = 500`、`MAX_REPLAY_CHARS = 1_000_000`。
超限时**丢最旧的**，并在 `state` 里置 `truncated: true`，webview 在顶部插一条
"更早的消息已省略"的 notice。

### 4.3 `src/pi/controller.ts`（面板会话主机）

```ts
export class SessionHostController {
  ensure(): Promise<void>;                 // 幂等；失败抛错，由调用方转成面板提示
  readonly ready: boolean;
  get host(): SessionHost | undefined;
  prompt(text: string, behavior: "auto" | "steer" | "followUp"): Promise<void>;  // 见 4.3.1
  abort(): Promise<{ steering: string[]; followUp: string[] }>;  // 返回被退回输入框的文本
  clearQueue(): { steering: string[]; followUp: string[] };
  snapshot(): ReplaySnapshot;              // 重放数据（§4.1 的 id 规则）
  dispose(): Promise<void>;
}
```

要点：

- `ensure()` 里才做：`ModelRuntime` 创建（每次创建后**重新注入** SecretStorage 里的 key，
  因为 `setRuntimeApiKey` 是内存态）→ 建 `SessionManager.create(cwd, <agentDir>/sessions)`
  → `createSessionHost(...)`，`onEvent` 接到 S2 的事件出口 → **模型对齐**。
- **模型对齐抽成 `src/pi/model-choice.ts` 共用**（S1 自测与生产同一条逻辑，避免两套漂移）。
  ⚠️ **重构纪律（`S2-CL-P1`）**：这动了 S1 闸门验过的那条代码路径，所以
  (a) 单独一个 commit，声明行为不变；
  (b) **受限机上必须先重跑 `Pi: Run Self-Test` 确认仍是 `GATE PASS`，再做 S2 的手工验收**（§6.3 的 W0）。
- `snapshot()` 必须把**两类"还没进 `session.messages` 的进行中状态"**都补上，否则重开面板会让它们凭空消失：

  1. `state.streamingMessage` 存在 → 追加一条 `streaming:true` 的 assistant item，**id 用 `activeAssistantId`**；
  2. **`state.pendingToolCalls` 非空 → 为每个 id 补一条 `{kind:"tool", id:"tool-<id>", summary:"运行中…"}`**
     （`S2-CL3-N1`：C1 这一族的第三处。工具执行中重开面板时 toolResult 还没产生，`session.messages`
     里没有任何关于这次调用的东西，不补的话那一行消失、结束后 toolResult 又 upsert 出一行新的，
     看起来像"凭空冒出来"）。`toolName` 与参数摘要从**最后一条含该 toolCallId 的 assistant 消息**里取
     （与 §4.2 的 `toolCallIndex` 同源）。

  另外 `busy` 取 **`session.isStreaming || controller.hasPendingSend`**（`S2-CL3-N5`）：乐观 busy 发生在
  `agent_start` **之前**，那时 `isStreaming` 还是 false，只看它会让冷启动期间重开的面板误报"空闲"。
  `hasPendingSend` 是 controller 自己的在途标志，与乐观 busy 同生命周期。

  最后加上：队列 + 模型名 + `state.errorMessage`。

#### 4.3.1 `prompt(text, behavior)` 的竞态处理

```
if (session.isStreaming)  → prompt(text, { streamingBehavior: behavior === "followUp" ? "followUp" : "steer" })
else                      → prompt(text)                     // 让 pi 校验模型/凭据
catch (e):
  若错误文本匹配 /already processing|streamingBehavior/i  → 用 streamingBehavior:"steer" 重试一次
  其它错误 → 把 e.message 原样回给面板（composerError）
```

- **不 `await` 到整轮结束**：`prompt()` 的 promise 到 `agent_end` 才 resolve，
  路由层必须立刻返回，错误经 `.catch` 走 `composerError`。
- **乐观 busy**（`S2-CL-S3`）：消息被接受的那一刻就发 `busy:true`，由 `agent_settled` 解除；
  否则冷启动建连的那几秒里状态行显示"空闲"，用户会重复发送。
- ⚠️ **但 `agent_settled` 不是万能解除条件**（`S2-CL2-N2`）：扩展命令（`/smoke`）是 pi 在
  `prompt()` 内部**直接执行**的，**不启动 agent run**，因此既没有 `agent_start` 也没有 `agent_settled` ——
  只靠 `agent_settled` 解除，用户敲一次 `/smoke` 就会把状态行**永久卡在"生成中…"**。
  **必须补一次对账**：`prompt()` 的 promise settle（resolve 或 reject）之后检查
  `session.isIdle`，为真就发 `busy:false`。
  （`isIdle` 不能用来判 UI 空闲——它不看队列；但用它做这次对账口径是唯一正确的，见 §0.1。）

#### 4.3.2 delta 合帧（`S2-CL-S4`，推翻第一版的 D5）

`text_delta` / `thinking_delta` 不逐条转发，而是在 controller 里按 **~16 ms** 合帧后发一条 `delta`。
理由是合并相邻 delta **不改变内容与顺序**，不是正确性取舍，只是十几行代码；
不合并的话一条长回复会产生几千次 IPC 往返。

#### 4.3.3 `abort()` 同时清队列（`S2-CL-S1`，见决策 D9）

`await session.abort()` 之后调 `clearQueue()`，把返回的文本交回 webview 填进输入框。
理由：用户点"中止"的语义是"停下来"，留着 followUp 让它在用户以为已经停下之后继续发出去，
属于违背意图；pi 自己的 `clearQueue()` 注释也把"用户中止时还原到编辑器"列为用途。

**退回通道是 `restoreComposer`，不是 `composerError`**（`S2-CL2-N5`）：`composerError` 在 §4.6 里是
"输入框下方红字"，把用户自己写的话当错误红字塞回去语义错了。多条被退回的消息**用单个换行拼接**，
顺序为 `steering` 在前、`followUp` 在后（与投递顺序一致）；拼接结果**非空时**才发 `restoreComposer`。

### 4.4 `src/host/chatView.ts`

- `resolveWebviewView(view)`：
  - `view.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] }`
    （**不含** `retainContextWhenHidden`，见 §0.5）
  - 视图级开关在注册处：`window.registerWebviewViewProvider("jerrypi.chat", provider, { webviewOptions: { retainContextWhenHidden: true } })`
  - `view.webview.html = buildWebviewHtml(...)`（nonce 每次随机）
  - `onDidReceiveMessage` 路由；`view.onDidDispose` 只清理订阅，**不动 pi 会话**（会话归 controller）
- 路由表：

| ClientMessage | 处理 |
| --- | --- |
| `ready` / `requestState` | `controller.ensure()` → `post(state)`；失败 post `notice(error)` + `busy:false` |
| `prompt` | 乐观 `busy:true` → `ensure()` → `controller.prompt(text, behavior)`；失败 post `composerError` + `busy:false` |
| `abort` | `controller.abort()` → `queue` 消息清空队列条 + `restoreComposer` 退回文本（见 §4.3.3） |
| `clearQueue` | `controller.clearQueue()` → 以随后的 `queue_update` 为准刷新 |
| `openExternal` | 校验 scheme ∈ `urlPolicy.EXTERNAL_SCHEMES` 后 `vscode.env.openExternal`；否则忽略并记 Output |

- 事件 → `ServerMessage`。**核心规则：所有 `message_end` 一律走同一个序列化器并发 `item`（upsert）；
  只有"正在流式的那条 assistant"才额外走 `delta` 快路径。**

| pi 事件 | 协议消息 |
| --- | --- |
| `message_start`（assistant） | `item`（空 assistant，`streaming:true`，id = 新铸造并持有 `activeAssistantId`） |
| `message_update.text_delta` | 合帧后 `delta {kind:"text"}` |
| `message_update.thinking_delta` | 合帧后 `delta {kind:"thinking"}` |
| `message_end`（**任意 role**，含 toolResult / user / custom） | `item`（同一序列化器产出；**id 按下面的硬规则**） |
| `tool_execution_start` | `item`（`{kind:"tool", id:"tool-<toolCallId>", toolName, summary:"运行中…"}`） |
| `tool_execution_update` | 不发（bash 输出流式是 S3 的范围） |
| `tool_execution_end` | 不发 —— 等 toolResult 的 `message_end` 用**同一个 id** upsert 成最终态 |
| `queue_update` | `queue` |
| `agent_start` | `busy {busy:true}` |
| `agent_settled` | `busy {busy:false}` + **把仍处于"运行中"的 tool item 标记为"已中止"**（中止或异常路径下 toolResult 可能永远不来） |
| `agent_end` | 仅在有 `willRetry` 时发 `notice` |
| `compaction_start/end`、`auto_retry_*` | `notice` |
| `session_info_changed` / `thinking_level_changed` | S4 再用，S2 忽略 |

**`message_end` 的 id 硬规则**（`S2-CL2-N1`）：

```
role === "assistant" 且 activeAssistantId 非空 → 强制用它，发完清空
role === "toolResult"                          → `tool-${toolCallId}`
其它（user / custom / bashExecution / …）       → `msg-${session.messages.length - 1}`
```

第一条是 C1 的**收尾端**对应修复：`message_start` 用 `activeAssistantId` 建节点，`message_end`
若改用下标命名，两条 id 不同 → upsert 新建出第二个节点 → 每条回复都留一个空壳。
第三条依赖 §0.1.1 核实过的时序（`message_end` 时消息已在数组里）。

⚠️ **这张规则只适用于 `message_end` 事件。** 运行时提示（compaction / auto_retry / willRetry）不走这条，
它们固定用 `notice-<递增序号>`（§4.1），否则会覆盖真实消息。

- **为什么工具行能既实时又一致**（`S2-CL2-N4`，推翻了第一版"tool_execution_* 不发 UI"的取舍）：
  第一版为了让实时与重放完全一致，规定工具行只在 toolResult 的 `message_end` 时出现 ——
  代价是**一条 `bash sleep 30` 在 30 秒里面板毫无迹象，看起来像卡死**。
  用 `toolCallId` 当 id 之后这个取舍不必付：`tool_execution_start` 发一条 `运行中…` 的中间态，
  toolResult 的 `message_end` 用**同一个 id** upsert 成最终态；而**重放只会产出最终态那一条**。
  约束 12 依然成立（例外只允许"同 id 的中间态 → 最终态"）。

### 4.5 `src/webview/render.ts`

- `import { marked } from "marked"`，`marked.use(...)` **照抄** §0.4 的 tokenizer/renderer 配置
  （`html()/tag()` 返回 `undefined`、`sanitizeMarkdownUrl`、`escapeHtml`、`strictStrikethroughRegex`）。
- **比 pi 更严的一处**（S2-D1）：`image` 的 scheme 白名单收窄为只允许 `data:image/`，
  其它一律降级为纯文本（`![](https://…)` 显示为 alt 文本）——因为 webview 发远程请求等于
  把"模型可控的 URL"变成出网信道。与 PLAN R9 "只加载本地资源 + 图片 data URI" 一致。
- **scheme 白名单与 `openExternal` 共用同一份常量**（`src/shared/urlPolicy.ts`，`S2-CL-S2`）：
  第一版里 render 允许 `https?|mailto|tel|ftp` 而 `openExternal` 只放 `{http,https,mailto}`，
  结果 `tel:`/`ftp:` 会渲染成可点的蓝字、点了静默无反应。
- `renderMarkdown(text) → html`、`renderToolLine(item)`、`renderNotice(item)`。
- 纯函数、**不碰 DOM**，因此可在 Node 里直接跑（CI 的 §0.4 用例）。

### 4.6 `src/webview/main.ts`

- DOM 骨架：`#transcript`（消息列表）、`#queue`（队列条）、`#composer`（textarea + 发送/中止按钮）、`#status`。
- 消息处理：
  - `state` → 清空并按 `items` 全量重建（`truncated` 时先插省略提示）；恢复 `busy` → 输入态
  - `item` → **按 id upsert**：存在则替换该节点内容，不存在则按顺序追加
  - `delta` → 追加到对应 id 的流式区（`textContent`），流式期间用 `white-space: pre-wrap` 呈现纯文本
  - 流式结束（收到该 id 的最终 `item`）→ 用 `renderMarkdown` 结果替换纯文本区（S2-D4）
  - `queue` → 渲染待处理条（steering 标"将打断"、followUp 标"排队"）+ "清空队列"按钮
  - `busy` → 按钮/输入框状态；`composerError` → 输入框下方红字，**保留用户输入不清空**；`restoreComposer` → 把文本**填回**输入框（非错误，不清红字）
- **输入框清空时机**（`S2-CL3-N6`，见 D10）：**发送成功时不清空**；等真实的 user item 回显（`message_end`）时，
  **若输入框内容仍等于刚发送的那段文本**才清空。这样冷启动那几秒里用户的话始终有一处可见，
  又不会把用户在等待期间新打的字一起清掉。在途期间**禁用发送按钮**（不禁用输入框）。
  （评审给的另一个方案是"发送即清空 + 本地乐观插入 `pending-<seq>`，回显时靠内容匹配替换"——
  跨协议的文本匹配太脆，不采纳。）
- 输入语义（PLAN 5.2 第 5 条）：
  - 空闲：`Enter` → `prompt auto`（`Shift+Enter` 换行）
  - 流式中：`Enter` → `prompt steer`（按钮文案与提示条写明"将打断当前回复"）；
    另有"排队"按钮 → `prompt followUp`
  - 流式中输入框**不禁用**（要能发 steering），但状态行显示"生成中…"
- 链接：`click` 事件里判断 `a[href]` → `postMessage({type:"openExternal"})` + `preventDefault`。
- 不使用 `innerHTML`（除 `render.ts` 的返回值）。

### 4.7 `esbuild.mjs`

```js
entryPoints: { extension: "src/extension.ts", webview: "src/webview/main.ts", style: "src/webview/style.css" }
// 扩展：platform node / format esm / external: ["vscode"] / banner(createRequire)
// webview 与 style：platform browser / format iife / target es2022 / minify
```

产物：`dist/extension.js`、`dist/webview.js`、`dist/style.css`。
构建后断言三个产物**存在且非空**（`S2-CL-S6`：第一版想断言 `dist/webview.js` 里不出现 `require(`，
这在注释或字符串里出现就会误报，验的也不是关心的东西；真正的把关由 §4.9 的 Node 侧 render 测试承担）。

### 4.8 `package.json`

```jsonc
"contributes": {
  "viewsContainers": { "activitybar": [{ "id": "jerrypi", "title": "Pi", "icon": "media/jerrypi.svg" }] },
  "views": { "jerrypi": [{ "type": "webview", "id": "jerrypi.chat", "name": "Chat" }] },
  "commands": [ /* 既有 4 条 + jerrypi.newSession */ ]
}
```

`jerrypi.focusChat` 实现改为 `vscode.commands.executeCommand("jerrypi.chat.focus")`。
`.vscodeignore` **无需改动**：已核实 `media/` 与 `dist/` 都不在排除列表中（排除的是 `src/`、`scripts/`、
`docs/`、`.github/`、`.vscode/`、根 `node_modules/`、map 文件），`media/jerrypi.svg` 会自然进包。
但 `check-vsix.mjs` 需新增断言：解包后 `extension/media/jerrypi.svg`、`extension/dist/webview.js`、
`extension/dist/style.css` 必须存在。

### 4.9 `scripts/render-xss-check.mjs`（CI）

用 `esbuild` 把 `src/webview/render.ts` 打成 CJS（`platform: node`）后在 Node 里跑 §0.4 的
**12 个载荷 + 第 13 条（图片两例）**，按 §0.4 的判据断言；任一不通过即退出非零。另断言：
`SUMMARY_MAX` 截断、未知 role 的降级不为空。

**白名单一致性用行为断言，不能用"常量等于它自己"**（`S2-CL2-N8`）：给 `renderMarkdown` 喂
`[x](tel:123)` 与 `[x](ftp://…)`，断言渲染结果与 `urlPolicy` 的判定**一致（要么都放行、要么都降级）**
—— 这才是"render 与 openExternal 不会各说各话"的验证点。

由 `npm run check:render` 触发，并加入 `scripts/self-test.mjs` 的 case 与 CI。

---

## 5. 重放契约（面板重开 / 窗口重载）

| 场景 | VS Code 行为 | 我们的处理 |
| --- | --- | --- |
| 切到别的视图再切回 | 视图级 `webviewOptions.retainContextWhenHidden: true` → DOM 保留 | 不重放（页内状态原样） |
| 右键隐藏视图 / 面板被 dispose | 触发 `onDidDispose`，再拉开时重新 `resolveWebviewView` | 新 webview 发 `ready` → 全量 `state` |
| 窗口重载 / 扩展重载 | 一切重来 | S2：**新建会话**（历史恢复属 S5 的 `continueRecent`） |
| **流式中重开** | 同上 | `state` 带上进行中 assistant 的 item（来自 `state.streamingMessage`），**id 复用 controller 持有的 `activeAssistantId`**，后续 delta 才能接上（C1）；该条**结束时也必须沿用同一个 id**（N1） |

**唯一数据源是 `session.messages`**（扩展侧不另存一份转录），避免与 pi 的真实历史漂移。

---

## 6. 验收

### 6.1 CI（每个 PR 都跑）

| 编号 | 内容 |
| --- | --- |
| C1 | `npm run typecheck` 通过（含 `view.webview.options` 无多余属性的编译期检查） |
| C2 | `npm run build` 产出三个非空产物 |
| C3 | `npm run check:render`：§0.4 的 **12 + 1（图片两例）** 个载荷 + 摘要截断 + 未知 role 降级 + **白名单一致性的行为断言**（`S2-CL3-N4`：本条必须与 §4.9 一致） |
| C4 | `npm run self-test`（**6/6**，含新 case） |
| C5 | `npm run package` + `check-vsix.mjs`（≤30 MB，含三个新产物断言）+ 解包后再跑隔离 runtime 校验 |

### 6.2 macOS（F5，人工）

| 编号 | 步骤 | 期望 |
| --- | --- | --- |
| M0 | 打开面板 | 面板**有样式**（说明 CSP 的 `style-src` 对了）、脚本执行（说明 nonce 与 `localResourceRoots` 对了） |
| M1 | 发"你好，用一句话自我介绍" | 流式出现文字；结束后 markdown 渲染；状态行回到空闲；**transcript 里该回复只有一个节点**（不出现空壳，`S2-CL2-N1`） |
| M2 | 连发三轮（其中一轮要求它写一段带代码块的中文） | 多轮上下文正确；代码块等宽显示 |
| M3 | 中途点"中止" | 立刻停止；**队列被清空且文本退回输入框**；状态行回到空闲；可继续对话 |
| M4 | 流式中先按 `Enter`（steer）再按"排队"（followUp） | 两条都进队列条且标注不同；不出现 "Agent is already processing"；steer 生效于本轮、followUp 在本轮结束后被处理 |
| M5 | 队列非空时等 `agent_end` | 输入态**仍显示生成中**，直到 followUp 被处理完（`agent_settled`）才解除 |
| M6 | **折叠再展开**视图（⚠️ **不要**把视图拖到别的容器：拖到另一个容器 VS Code 会重建 webview，`retainContextWhenHidden` 管不到，会假失败，`S2-CL2-N7`） | 历史原样，**且不触发整页重放**。判据要可观测：`chatView` 每收到一次 `ready` 就往 Output 写一行 `[webview] ready`，本步断言 **Output 里没有新增该行** |
| **M6b** | **流式进行中**右键隐藏视图，再拉开 | 文字**继续增长到结束**（C1 的回归点；不是流式中段做的话测不出来）。断言 Output 里**有且仅有一行**新增的 `[webview] ready` |
| M7 | **XSS（三条）**：把三个载荷**直接粘进输入框发送** | 不弹任何对话框；`<img …>`/`<script>` 以**文字**显示；`[x](javascript:alert(1))` 只显示 `x` 且不可点 |
| M8 | 让模型读一个内容含 `![x](https://…)` 与 `[a](https://example.com)` 的文件 | 远程图片不加载（显示为文本）；https 链接可点且用系统浏览器打开 |
| M9 | 发一条会触发**耗时**工具调用的指令（例如"运行 `sleep 20` 然后告诉我结束时间"） | (a) 调用**进行中**就已出现一行 `运行中…`（不是 20 秒毫无迹象，`S2-CL2-N4`）；**(b2) 在这 20 秒的中途隐藏再拉开面板，`运行中…` 那一行仍在**（`S2-CL3-N1`：C1 家族第三处的回归点）；(b) 结束后**同一行**变成最终摘要（名字 + 参数 + ✓），**不新增第二行**；(c) 结束后再隐藏再打开，重放出来的是**最终形态且只有一行**（C3 的回归点） |
| **M10** | 输入一个已注册的扩展命令（如 `/smoke`）并回车 | 命令被执行；**状态行不会永久停在"生成中…"**（`S2-CL2-N2` 的回归点：扩展命令不启动 agent run，没有 `agent_settled`，靠 `prompt()` settle 后与 `isIdle` 对账解除 busy） |

### 6.3 受限 Windows 机（人工，从 Marketplace 更新后）

| 编号 | 内容 |
| --- | --- |
| **W0** | **先跑 `Pi: Run Self-Test`，必须仍是 `GATE PASS`**（证明 `model-choice.ts` 的提取没有破坏受限机路径，`S2-CL-P1`） |
| W1 | `Pi: Focus Chat` 打开面板，完成 M0 + M1 + M2 |
| W2 | M7 的三条 XSS（这台机器是最终目标环境） |
| W3 | M4/M5 的队列与空闲判定 |

输出证据：截图无法读取，**用文字回报**（每步的可见结果 + 是否弹窗 + 状态行文本）。

### 6.4 判据

- C1–C5 全绿；
- **M0–M10** 全部符合期望（`S2-CL3-N4`：漏写 M10 的话，上轮 N2 那个 bug 的回归网等于没挂）；
- W0–W3 全部符合期望；
- 任一 XSS 用例出现弹窗/执行即 **BLOCKED**，停下来重做渲染层。

---

## 7. 提交计划

1. `refactor: extract the gate model choice into a shared module`（model-choice.ts；**行为不变**，为 W0 留出干净的重构点）
2. `feat: add the shared chat protocol and message serialization`（protocol.ts + urlPolicy.ts + serialize.ts + 单测 case）
3. `feat: add the panel session controller with replay snapshots`（controller.ts + delta 合帧 + abort 清队列）
4. `feat: add markdown rendering with pi's sanitizer configuration`（render.ts + check:render 脚本 + CI）
5. `feat: add the chat webview view with replay and CSP`（chatView.ts + webviewHtml.ts + 资源 + esbuild + package.json）
6. `feat: add the chat webview UI with streaming, queue and abort`（main.ts + style.css）
7. `docs: record S2 implementation results and known limitations`（README 中英 + PLAN.md 5.2 修正 + S2 记录）

---

## 8. 决策点（默认值已给，用户可改）

| 编号 | 决策 | 默认 | 理由 |
| --- | --- | --- | --- |
| D1 | 远程图片是否允许加载 | **不允许**（只 `data:image/*`） | 避免把模型可控 URL 变成出网信道；与 PLAN R9 一致 |
| D2 | 队列条能否删除单条 | **不能**，只提供"清空队列" | pi 无单条移除 API；伪造会与真实投递不一致（§0.3） |
| D3 | 视图是否保留页面状态 | **保留**，但入口是 `registerWebviewViewProvider` 的第三参数 | 第一版写错了位置（`S2-CL-B1`）；流式中切走再回来不掉字 |
| D4 | 流式期间是否实时渲染 markdown | **否**，纯文本流式 + 结束转 markdown | 半截 markdown 会闪烁；实现简单 |
| D5 | 是否对 delta 合帧 | **是，~16 ms**（**推翻第一版的"不节流"**，`S2-CL-S4`） | 合并不改变内容与顺序，不是正确性取舍；否则一条长回复几千次 IPC |
| D6 | 版本号与通道 | **0.1.4 预发布** | PLAN 5.4 把正式版放 S10；预发布更新链路已在受限机验证可用 |
| D7 | 工具卡片 | S2 只显示一行"工具名 + 参数摘要 + ✓/✗"，**实时与重放一致**；但执行中先给一个同 id 的 `运行中…` 中间态（`S2-CL2-N4`） | 完整卡片是 S3；中间态避免"长命令 30 秒毫无迹象像卡死" |
| D8 | 是否新增 `Pi: New Session` 命令 | **是** | 面板需要清空入口；S5 再扩展成完整会话管理 |
| D9 | 中止时是否清队列 | **清空并把文本退回输入框**（`S2-CL-S1`） | "中止"的语义是停下来；否则队列里的 followUp 会在用户以为已停止后继续发出去 |
| D10 | 输入框何时清空 | **等真实 user item 回显时清空，且仅当输入框内容仍等于刚发送的文本**（`S2-CL3-N6`） | 冷启动那几秒里用户的话始终有一处可见，也不会清掉等待期间新打的字 |

---

## 9. 风险

| # | 风险 | 应对 |
| --- | --- | --- |
| S2-R1 | CSP/nonce 配置错误导致白屏或无样式 | §3 的 CSP 全串写进计划可评审；M0 专门验证；`webviewHtml.ts` 纯函数化便于单测 |
| S2-R2 | `prompt()` 竞态（检查与调用之间进入流式） | §4.3.1 的 catch + 重试一次 |
| S2-R3 | 路由层 `await prompt()` 导致消息处理挂死 | 明确不 await；code review 检查点 |
| S2-R4 | marked v18 的 renderer 签名与 pi 模板假设不一致 | 已在本机实跑 12 个载荷验证（§0.4），CI 固化 |
| S2-R5 | **实时与重放的呈现漂移**（第一版的实际缺陷形态） | §3 约束 12 + UI 只由 `message_end` 驱动 + M9 专项回归 |
| S2-R6 | 流式中重开面板丢字 | id 权威归 controller（§4.1）+ M6b 专项回归 |
| S2-R7 | 面板重开后状态与 pi 不一致 | 重放只读 `session.messages`，不维护第二份转录 |
| S2-R8 | **提取 `model-choice.ts` 破坏 S1 已验证的受限机路径** | 单独 commit + W0 先重跑自测 |
| S2-R9 | 受限机上 Electron/Chromium 版本差异导致 webview 行为不同 | W1–W3 在受限机实测；CSP 只用标准指令 |
| S2-R10 | 视图 dispose 时机与 `retainContextWhenHidden` 组合出未预期行为 | M6/M6b 覆盖两种重开路径；`ready` 行写 Output 使其可观测 |
| S2-R11 | **id 不一致导致节点重复或丢字**（C1 与 N1 是同一个坑的两端） | §4.1 的 id 表 + §3 约束 11；M1 断言"只有一个节点"、M6b 断言流式不丢字、M9 断言工具行不重复 |
| S2-R12 | **扩展命令让 busy 永久卡住** | §4.3.1 的 `prompt()` settle 后与 `isIdle` 对账；M10 专项回归 |
| S2-R13 | **进行中的实体不在 `session.messages` 里，`snapshot()` 就会漏掉它**（C1 → N1 → 第三处的同一族病因） | §4.3 明确 `snapshot()` 必须补 `streamingMessage` 与 `pendingToolCalls`；M6b/M9(b2) 各覆盖一处 |
| S2-R14 | **notice 用错 id 命名空间吃掉真实回复** | §4.1 硬规则"notice 一律 `notice-<序号>`"；§4.4 注明 id 硬规则只适用于 `message_end` |

---

## 10. 评审记录

### 第 1 轮（Claude Opus 5，只读；结论：3 BLOCKING / 4 正确性缺口 / 7 建议 / 3 流程）

VERDICT: BLOCKING（3 条）。**已全部处置完毕，逐条如下。**
本轮的 3 条 BLOCKING 与 C1 全部是**第一版计划里的真实缺陷**，不是风格分歧；
其中 B1 源于作者把 JSDoc 交叉引用当成了类型声明证据。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
| --- | --- | --- | --- |
| S2-CL-B1 | `retainContextWhenHidden` 不在 `WebviewOptions` 里，正确入口是 `registerWebviewViewProvider` 第三参数；§0.5/§4.4/D3 三处要改 | **ACCEPT** | 已重核 `@types/vscode` 9902/10058/10082/10236/11754：属实。§0.5 改为逐行核对表并标 ⚠️；§4.4 改用三参数形态；D3 改写 |
| S2-CL-B2 | `localResourceRoots: [mediaUri]` 会把 `dist/` 下的脚本样式挡在门外 → 白屏 | **ACCEPT** | 属实。§4.4 改为 `[context.extensionUri]`；§0.5 记为白名单注意事项；M0 验证 |
| S2-CL-B3 | CSP 缺 `style-src`，`default-src 'none'` 会拦掉样式表 | **ACCEPT** | 属实。§3 约束 2 改为写入完整 CSP 全串（另加 `object-src`/`base-uri`/`form-action`/`connect-src`） |
| S2-CL-C1 | 流式中重开面板时 id 不一致 → 回复后半截丢字，且 M6 测不出来 | **ACCEPT** | 属实且最隐蔽。§4.1 新增 id 权威规则（历史用下标、进行中用 controller 持有的 id）；§3 加约束 11；§5 补说明；新增验收 M6b |
| S2-CL-C2 | toolResult 也发 `message_start`，路由表没接 → 出现无节点的 `itemEnd` | **ACCEPT** | 已核实 `agent-loop.js:557` 的 `emitToolResultMessage()`。§0.1 新增"发出点"表；§4.1 把 `item` 定义成 upsert；§4.4 改为 `message_end` 统一驱动 |
| S2-CL-C3 | 实时只显示工具一行、重放却显示最多 20 KB 正文 —— 重开一次就把"不做的功能"冒出来 | **ACCEPT** | 属实，是设计自相矛盾。§4.2 的 toolResult 改为只出"参数摘要 + ✓/✗"，**去掉正文**；§1.2 注明；§3 加约束 12；新增验收 M9 |
| S2-CL-C4 | `ChatItem.toolCalls` 只有重放路径会填 | **ACCEPT** | 与 C3 同源。S2 的 assistant item **删掉** `toolCalls` 字段；工具活动只以 `kind:"tool"` 一行呈现 |
| S2-CL-S1 | abort 不清队列，followUp 会在用户以为停止后继续发出 | **ACCEPT** | 已核实 `agent-session.js:1222` 的 `abort()` 不碰队列、rpc 模式另有 `clear_queue`。新增决策 D9 + §4.3.3；M3 加断言 |
| S2-CL-S2 | render 与 openExternal 的 scheme 白名单不一致，`tel:`/`ftp:` 会静默无反应 | **ACCEPT** | 新增 `src/shared/urlPolicy.ts` 作为唯一常量；§4.5/§4.9 引用 |
| S2-CL-S3 | 发送到 `agent_start` 之间没有 busy 态 | **ACCEPT** | §4.3.1 加"乐观 busy" |
| S2-CL-S4 | 建议推翻 D5「不节流」，S2 就做 ~16 ms 合帧 | **ACCEPT** | 同意其论证（合并不改变内容与顺序，不是正确性取舍）。§4.3.2 新增；D5 改默认值 |
| S2-CL-S5 | `state` 整包无上限 | **ACCEPT** | §4.2 新增 `MAX_REPLAY_ITEMS`/`MAX_REPLAY_CHARS` + `truncated` 标志 + 顶部省略提示 |
| S2-CL-S6 | "`dist/webview.js` 里不出现 `require(`" 断言脆弱且验错对象 | **ACCEPT** | §4.7 改为断言三产物存在且非空；真正的把关交给 C3 |
| S2-CL-S7 | `self-test.mjs` 的 `TOTAL = 5`，加了 case 应是 6 | **ACCEPT** | §6.1 的 C4 改为 6/6；§2 文件清单注明 |
| S2-CL-P1 | 提取 `alignModel` 动了 S1 闸门验过的路径，需配代价 | **ACCEPT** | §4.3 加"重构纪律"（单独 commit + 行为不变声明）；§6.3 新增 **W0**：受限机先重跑自测确认仍 `GATE PASS`；§9 新增 S2-R8 |
| S2-CL-P2 | 建议把 `@types/vscode` 从 1.120.0 升到 1.123 | **REJECT** | 已核实 npm 上该区间只有 `1.120.0` 与 `1.125.0`，**没有 1.123.x**；升到 1.125 会高于 `engines.vscode` 声明的下限 `^1.123.0`，属于"类型比声明的支持范围还新"，会把"用了新 API 却声称支持旧版本"的风险引入。保持 1.120.0 是保守方向（类型 ≤ 声明下限），S2 需要的那几个 API 在 1.120.0 里都有 |
| S2-CL-P3 | `PLAN.md` 5.2 的"可编辑、可移除"原文还在，两份文档会打架 | **ACCEPT** | §2 文件清单加入 `PLAN.md`；§7 第 7 个 commit 一并修正 |

**总评里那条建议**（§0.5 的 webview 宿主 API 属于"纯读文档得来的一节"，应在 F5 下实测一次再落笔）——
已采纳：§0.5 改为逐行核对表并标注第一版的错误来源，§6.2 的 M0 就是这一节的实测点。

⚠️ **本轮之后的所有改动（即上表全部 17 条）都未经第二轮复核。**

### 第 2 轮（Claude Opus 5，只读；结论：**无 BLOCKING** / 2 条新缺陷 / 1 条必补依据 / 6 条建议）

VERDICT: **NON_BLOCKING**。评审者逐条复核了上一轮 17 条的落实（确认"改对了位置、不是改了字面"），
并**主动撤回**了上一轮的 P2。本轮 8 条全部处置如下。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
| --- | --- | --- | --- |
| S2-CL2-N1【缺陷】 | 同一条 assistant 经历 `message_start`（id=`activeAssistantId`）与 `message_end`（id=`msg-<下标>`）两次 upsert，**id 不同 → 每条回复多留一个空壳节点** | **ACCEPT** | 属实，是上一轮 C1 的**收尾端**对应错误。§4.4 新增"`message_end` 的 id 硬规则"；§3 约束 11 收紧为"同一实体 id 全程不变"；M1 加断言 |
| S2-CL2-N2【缺陷】 | 乐观 busy 只由 `agent_settled` 解除，而**扩展命令不启动 agent run**（无 `agent_start`/`agent_settled`）→ 敲一次 `/smoke` 状态行永久卡在"生成中" | **ACCEPT** | 属实，是上一轮 S3 修复引入的新 bug。§4.3.1 补"`prompt()` settle 后与 `session.isIdle` 对账"；§0.1 把 `isIdle` 加回并注明正确用途（上一轮误删）；新增 M10 |
| S2-CL2-N3【依据缺失】 | 实时路径怎么算 `msg-<下标>` 没写，而这是全局最脆的一环；并指出 `agent.js`（先 push 后 notify）与 `agent-loop.js`（先 emit 后 push）**时序相反**的陷阱 | **ACCEPT** | 已逐行核实：`agent.js:389` push / `416-419` notify；`agent-session.js:681-683` 的 `session.messages === agent.state.messages`；`agent-loop.js:142-144` 与 277/318/376 的确相反。新增 §0.1.1 全文写入行号，并在 §4.4 写明硬规则 |
| S2-CL2-N4【建议，采纳】 | 工具行改用 `toolCallId` 当 id：构造上实时=重放，且能顺便把"执行中"的可见性买回来 | **ACCEPT** | 已核实 toolResult 消息自带 `toolCallId`/`toolName`（`agent-loop.js:535-554`）。§4.1 id 表加一行；§4.4 事件表把 `tool_execution_start` 改为发同 id 的 `运行中…` 中间态；§3 约束 12 写明这条唯一允许的例外；D7 更新；M9 重写为三段断言 |
| S2-CL2-N5【协议缺口】 | 用 `composerError` 回填中止退回的文本语义不对（那是错误红字通道），且多条拼接规则未定义 | **ACCEPT** | §4.1 新增 `restoreComposer` 消息；§4.3.3 写明"steering 在前、followUp 在后，单换行拼接，非空才发"；§4.4 路由表改；§4.6 区分两个通道 |
| S2-CL2-N6【自相矛盾】 | §0.4 的 12 载荷里"正常图片→正常渲染"与 D1（只允许 `data:image/`）打架，CI 一跑就红 | **ACCEPT** | 属实：那张表是**用 pi 的原始配置**跑的。§0.4 加说明并补**第 13 条**（https 图片必须降级为 alt 文本 / `data:image/png;base64,…` 正常渲染）；§4.9 的语料改为 12+1 |
| S2-CL2-N7【假失败】 | M6"把面板拉到别处再拉回"会**重建** webview，此步必然假失败；且"DOM 未重建"人工看不见 | **ACCEPT** | 属实。M6 改为"折叠再展开"并加⚠️说明；判据改为可观测的 Output `[webview] ready` 行计数（`chatView` 每次 `ready` 写一行）；M6b 同步改 |
| S2-CL2-N8【弱断言】 | "断言 `urlPolicy` 里 render 与 external 用的是同一份白名单"等于断言常量等于它自己 | **ACCEPT** | §4.9 改为**行为断言**：喂 `tel:`/`ftp:` 链接，断言渲染结果与 `urlPolicy` 判定一致（都放行或都降级） |
| §0.5 数字 | 表格写"`WebviewOptions` 只有 4 个成员"，实际 **5** 个（漏 `portMapping`） | **ACCEPT** | 属实：接口范围 9902–9950，第 5 个成员是 `portMapping`。已改 |
| S2-CL-P2 | **评审者主动撤回**上一轮"升级 `@types/vscode` 到 1.123"的建议，确认作者的 REJECT 正确 | 记录 | 撤回理由是它自己查了 npm（该区间只有 1.118/1.120/1.125，无 1.123.x），与作者一致 |

本轮评审对上一轮的复核结论（原文要点）：3 条 BLOCKING"改对了位置，不是改了字面"，
C1/C2/C3 的修法"改到了根因而不是打补丁"，§3 新增的约束 11/12"把纪律上升了一级，是正确做法"。

⚠️ **本轮之后的全部改动（即上表 10 条）同样未经第三轮复核。** 其中 N1/N2 是**代码级**影响的改动，
N4 改变了 §4.4 的事件映射，实现时要格外小心。

### 第 3 轮（Claude Opus 5，只读；结论：**无 BLOCKING** / 2 条正确性缺陷 / 1 条规范矛盾 / 1 组验收漂移 / 2 条小项）

VERDICT: **NON_BLOCKING**。评审者对本轮的判断是"剩下的是收尾级问题，改完这 4 条就可以开工；
再评审收益递减，剩下的问题要靠 F5 里跑起来才能发现，而不是靠读 `.d.ts`"。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
| --- | --- | --- | --- |
| S2-CL3-N1【缺陷】 | **工具执行中重开面板会丢行**：`snapshot()` 只读 `session.messages`，而在途工具调用还没有 toolResult → `运行中…` 凭空消失，结束后又 upsert 出一行新的。这是 C1 家族的**第三处**（同一个病因：进行中的实体不在 `session.messages` 里） | **ACCEPT** | 已核实 `AgentState.pendingToolCalls` 存在（`types.d.ts:312`）且由 `agent.js:392-403` 维护。§0.1 加该行；§4.3 的 `snapshot()` 增补第二类进行中状态；M9 新增 (b2) 回归点；§9 加 S2-R13 |
| S2-CL3-N2【缺陷】 | §4.1 的 notice id 写成"`msg-<下标>` **或** `notice-<序号>`"，而这个"或"必须消掉：notice 不是消息、**没有下标**，实现者顺手写成 `msg-${length-1}` 会让 `auto_retry_start` 与刚结束的 assistant **撞同一个下标**，把回复整条替换成黄字提示 | **ACCEPT** | §4.1 改为硬规则"通知一律 `notice-<递增序号>`，禁止 `msg-` 前缀"并写明后果；§4.4 id 硬规则块注明只适用于 `message_end`；§9 加 S2-R14 |
| S2-CL3-N3【规范矛盾】 | 约束 12 说例外"只有一种"，但本版自己又引入了两个方向相反的新例外（易失 notice、无 toolResult 的中止标记）；规范和实现打架时实现者不知道改哪边 | **ACCEPT** | §3 约束 12 改为**显式登记两类例外**，并规定"第二类内容不得承载用户需要留存的信息" |
| S2-CL3-N4【验收漂移】 | 三处改了实现没改门禁：§6.4 写 M0–M9（漏 M10，导致上轮 N2 的回归网没挂上）、§6.1 C3 与 §1.1 第 9 项都还写"12 个载荷"且 C3 仍写"白名单同源" | **ACCEPT** | 三处全部改正（M0–M10 / 12+1 / 行为断言）。这与上轮 `TOTAL = 5 → 6` 是同一类错误，本轮做了全篇一致性自检 |
| S2-CL3-N5【小】 | `snapshot().busy` 取 `isStreaming`，而乐观 busy 发生在 `agent_start` **之前** → 冷启动期间重开面板会误报"空闲" | **ACCEPT** | §4.3 改为 `isStreaming \|\| controller.hasPendingSend` |
| S2-CL3-N6【小】 | 发送后输入框清不清空没定义；若发送即清空，而回显要等 `ensure()` + 模型校验，这几秒里用户的话两头都不在 | **ACCEPT，选"回显再清"** | 新增 D10 + §4.6 规则：发送时不清空，回显时**仅当内容仍等于刚发送的文本**才清空；在途禁用发送按钮。评审给的"乐观插入 `pending-<seq>` + 内容匹配替换"因跨协议文本匹配太脆而**不采纳** |
| 行号 | 上版引用的 `agent.js` 行号差 1（push 在 **390** 非 389；`message_start` 在 **383/386** 非 384–385） | **ACCEPT** | 已用 `grep -n` 精确核准并改正。评审者强调"这一节标着逐行核对，数字要准" |

**评审者额外提供的一条核实**（未被要求）：abort 时**不会**留下孤儿工具行 ——
`executeToolCallsSequential` 在 `break` 前仍会 `emitToolResultMessage`（`agent-loop.js:316-320`），
`executeToolCallsParallel` 的闭包在 aborted 时返回 `"Operation aborted"` 的错误结果并照常发 toolResult（354-360 行）。
已核实属实。因此 §4.4 里"`agent_settled` 时把仍在运行中的 tool item 标为已中止"是**低频兜底**，不是主路径
—— 而它正是 N3 里需要登记的第二类例外之一。

**三轮累计**：26 条意见（7 + 10 + 6，含评审者主动撤回 1 条），0 条被拒（除 P2 由评审者自行撤回）。
计划从 498 行长到 700+ 行，其中 §0（事实核实）与 §4.1/§4.3/§4.4（协议与事件映射）改动最大。

⚠️ **本轮之后的全部改动（即上表 7 条）未经第四轮复核。** 但按评审者的判断与作者的一致意见：
**到此收敛，进入 §8 决策点确认与实施。** 剩余未知量（CSP 是否真的放行样式、`retainContextWhenHidden`
在视图上是否真的生效、Electron 版本差异）**只能靠 F5 与受限机实测发现**，继续静态评审的收益已很低。

---

## 11. 实施记录

### 11.1 落地清单（7 个提交）

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `refactor: extract the gate model choice into a shared module` | `src/pi/model-choice.ts`；`selftest.ts` 改为调用它。**行为不变**（见 11.2） |
| 2 | `feat: add the shared chat protocol, message serialization and url policy` | `src/shared/protocol.ts`、`src/shared/urlPolicy.ts`、`src/pi/serialize.ts`、`scripts/protocol-check.mjs` |
| 3 | `feat: add the panel session controller with replay, framing and abort handling` | `src/pi/controller.ts`、`src/host/uiContext.ts`、`scripts/controller-check.mjs` |
| 4 | `feat: add markdown rendering with pi's sanitizer configuration` | `src/webview/render.ts`、`scripts/render-xss-check.mjs`、CI 加两步 |
| 5 | `feat: add the chat webview view with replay, CSP and the panel UI` | `src/host/chatView.ts`、`src/host/webviewHtml.ts`、`src/host/workspace.ts`、`src/webview/main.ts`、`src/webview/style.css`、`media/jerrypi.svg`、`esbuild.mjs`、`package.json`、`check-vsix.mjs` |
| 6 | `refactor: single source for the protocol version` | 协议版本只留一处 |
| 7 | `chore: keep tsconfig variants out of the vsix` | `.vscodeignore` 的 `tsconfig*.json` |

**与计划的偏差（3 处，都有理由）**

1. **`createVSCodeUIContext` 放在 `src/host/uiContext.ts`，不是 `src/pi/bindings.ts`**（计划 §2/PLAN 5.3 的写法）。
   原因：`bindings.ts` 被 `src/pi/session.ts` **值导入**，在里面 import `vscode` 会让整个 `src/pi` 层
   无法在纯 Node 里加载 —— S1 留下的快速迭代通道（本地 harness）会当场失效。
   已加脚本化约束：`src/pi/**` 只允许 `import type * as vscode`。
2. **`webviewHtml.ts` 不 import vscode**：改成接收三个字符串，于是它成为纯函数，
   `scripts/render-xss-check.mjs` 能在 Node 里逐条断言 CSP 指令（这正是 B3 那类错误的防线）。
3. **新增 `src/host/workspace.ts`**（cwd 推导）与 **`scripts/controller-check.mjs`**（端到端检查）。

### 11.2 重构等价性（`model-choice.ts` 的提取）

用 S1 的两个场景复核，输出**逐字节不变**：

| 场景 | 重构前 | 重构后 |
| --- | --- | --- |
| 只配 deepseek | `deepseek/deepseek-v4-pro → 已改为 deepseek/deepseek-v4-flash（指定模型，不用 pi 的默认）` | 同 |
| deepseek + openai | `openai/gpt-5.5 → 已改为 deepseek/deepseek-v4-flash（指定模型，不用 pi 的默认）` | 同 |

### 11.3 落地时发现并修掉的真问题（都是"看起来正常"的类型）

| # | 问题 | 怎么发现的 | 修法 |
| --- | --- | --- | --- |
| 1 | **中止时排队文本静默丢失**：`abort()` 里先 `session.abort()` 再 `clearQueue()`，而 pi 在中止过程中会把队列一并清掉，之后 `clearQueue()` 只返回两个空数组 | `scripts/controller-check.mjs` 断言"退回文本含两条"，实测为空；随后用单独脚本打印时序确认 | **顺序反过来**：先 `clearQueue()` 取走文本并退回输入框，再 `abort()`。语义上也更对：先停止接收新工作，再停止当前回合 |
| 2 | 发送按钮的禁用条件写成恒假表达式（`busy && x ? false : false`） | 自查 | 按 D10 改为 `sentText !== undefined`（发出到回显之间禁用） |
| 3 | `tsconfig.webview.json` 漏进 `.vsix` | 解包后 `ls` 扩展根目录 | `.vscodeignore` 改 `tsconfig*.json` |
| 4 | 图片白名单只判 scheme，`data:text/html` 会被当图片放行 | `protocol-check` 的断言 | 收紧为 `data:image/` 前缀 |
| 5 | URL 里含空白时各解析器可能各解各的 | 自写的"伪装"用例 | `isExternalUrlAllowed` 增加"不得含空白" |
| 6 | **`newSession()` 之后模型对齐丢失**：新会话由 pi 按自己的规则重新解析模型，于是建会话时做过的对齐被丢掉（实测又变回 `deepseek-v4-pro`）。**这条是"用户选过模型不能被覆盖"的需求带出来的** | `check:controller` 新增的第 6 组断言（新会话后重新检查模型） | `session.ts` 新增 `onRebind` 钩子；模型对齐挂在"每次会话替换"上，而不是建会话之后做一次 |

### 11.3.1 模型策略：面板与自测分开（用户 2026-09-12 决定）

用户的原话是"测试时候做成 flash，实际使用时应该是可选的"。落成为：

| 场景 | 策略 | 实现 |
| --- | --- | --- |
| **自测闸门** | **钉死**便宜的 `deepseek-v4-flash` | `pickModel` + `alignSessionModel`（原样保留）—— 闸门要跑很多次真实调用，需要确定性与低开销 |
| **面板** | **用户选过就听用户的**；用户没选过（全新机器）才用我们的偏好兜底 | 新增 `alignPanelModel`：读 `settingsManager.getDefaultProvider()/getDefaultModel()`，任一非空即不覆盖 |

为什么面板不该钉：PLAN 5.3 明确写着"配置来源遵循 pi 自己的约定"，硬钉模型等于**覆盖用户在 pi 里做的选择**。
兜底仍然必要，因为受限那台机器就是被"凭据填错了但 pi 认为可用"的 `openai/gpt-5.5` 卡住的。

实测数据（本机真实 agentDir，只读探查）：

| 模型 | 图片输入 | 价格（输入/输出，每百万 token） | 备注 |
| --- | --- | --- | --- |
| `deepseek-v4-flash` | ❌ | 0.14 / 0.28 | 自测闸门钉的就是它（最便宜） |
| `deepseek-v4-flash-vision-exp` | ✅ | 0.14 / 0.28 | `exp` = 实验版，没用它做默认 |
| `deepseek-flash` | ✅ | 0.3 / 1.2 | 用户终端里 pi 的默认，面板跟随之 |
| `deepseek-v4-pro` | ❌ | 1.32 / 3.96 | 刻意避开的（约 9 倍价） |

**面板内的模型选择器是 S4 的范围**（"模型与思考等级"）。S2 只做到"不覆盖用户的选择 + 在状态行显示当前模型"。

### 11.4 自动化验收结果（本地，全部通过）

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | OK | 两个 project：宿主（无 DOM）与 webview（有 DOM） |
| `npm run self-test` | **6/6** | case 6 会真正去跑下面两个脚本 |
| `npm run check:protocol` | **54 checks** | serialize 的 id 规则、urlPolicy、webview 元素 id 交叉检查、协议版本单源 |
| `npm run check:render` | **41 checks** | 12 条攻击载荷 + 图片两例 + **CSP 逐条断言** + 渲染/外开判定一致 |
| `npm run check:controller` | **21/21** | **真实模型**端到端；覆盖 C1/N1/N2/N4/D9 全部回归点（需要凭据与网络，不进 CI） |
| `npm run package` + `check-vsix` | 5.72 MB / 19.1% | 8 个必需文件全部在包内 |
| 解包后隔离校验 | `VERIFY OK` | CHECK 2 / CHECK 7 均通过 |

`check:controller` 覆盖的回归点（每条都对应一次评审发现的问题）：

- assistant 在 upsert 之后**只剩一个节点**（N1：收尾端 id 必须复用）；
- 流式中取快照，其 id 与实时 delta 的 id **一致**，且快照之后**仍有 delta 到达**（C1）；
- 工具行 `pending → settled` **同一个 id**，最终视图里每次调用只占一行（N4）；
- 工具执行中的快照**带 pending 工具行**（C1 家族第三处）；
- 中止后被清掉的排队文本**退回输入框**（D9）；
- 扩展命令后 busy **被解除**（N2：扩展命令不启动 agent run，没有 `agent_settled`）；
- `newSession()` 后历史清空。

### 11.5 本机 F5 人工验收（macOS，逐条进行中）

| 编号 | 内容 | 结果 | 证据要点 |
| --- | --- | --- | --- |
| M0 | 打开面板 | ✅ PASS | 状态行 `deepseek/deepseek-flash · 空闲`；**面板有样式** → CSP 的 `style-src` 与 nonce 都对；Output 有 `[webview] ready`；`[controller] 模型：…（沿用 pi 设置里的默认…，未覆盖）` → 模型策略生效 |
| M1 | 一轮对话（流式 + markdown + 单个气泡） | ✅ PASS | 逐字冒出；upsert 后**只有一个回复气泡**（N1 回归点）；思考块折叠成 `▶ 思考过程`；结束后状态行回 `空闲` |
| M2 | 多轮上下文 + 代码块 | ✅ PASS | 第 2 轮答出 `99、42、17`（说明上下文正确，不是照抄）；python 代码块渲染成深底等宽 `<pre class="code">`；四轮历史全部保留 |

**M1 首轮实测发现并修掉的两个真 bug**（都是"看起来正常"的类型）：

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 7 | 工具行的工具名被挤成竖排单字母（`bash` → `b`/`a`/`s`/`h`） | `.tool-line` 的 flex 让参数把工具名挤没了；侧栏只有 ~260px 宽，我写 CSS 时没考虑 | 工具名与图标 `flex: 0 0 auto`，参数允许折行；加源码级回归断言（protocol 54 → 56） |
| 8 | 工具调用那一轮冒出一行橙字"（本次回复没有内容：toolUse）"，紧跟其后的才是工具行与真正回复 | `stopReason === "toolUse"` 的那轮 assistant 消息**本来就只带工具调用、没有正文**，我却按"空回复"补了警告 | 排除 `toolUse`；加行为断言（render 41 → 42） |

### 11.6 验收追加结果（macOS）

| 编号 | 内容 | 结果 | 证据要点 |
| --- | --- | --- | --- |
| M3 | 中止 + 队列退回 | ✅ PASS | 点「中止」后两条排队文本都回到输入框、队列条清空、状态行回「空闲」、之后仍能继续对话（D9 顺序修正生效） |
| M4 | 流式期间发送（steer / followUp） | ✅ PASS | 无 "Agent is already processing"；队列条两条标记正确；输入框按回车即清空 |
| M5 | 队列非空时 `agent_end` 后仍禁用输入 | ✅ PASS | 队列条非空期间状态行一直是「生成中…」 |
| — | pi 的 dequeue（"edit all queued messages"） | ✅ PASS | 点「取回编辑」后两条按 `steering` 在前、空行分隔回到输入框（对齐 `interactive-mode.js`） |
| M6 | 切走再切回 | ✅ PASS | 历史原样；Output **没有**新增 `[webview] ready` → `retainContextWhenHidden` 生效 |
| M6b | 强制重建后再接上流 | ✅ PASS | 改用 `Developer: Reload Webviews` 在**流式中**强制重建：Output 在 `[agent] start` 与 `[agent] end` 之间**新增了一行 `[webview] ready`**，面板里的已写部分重新出现并**继续增长到写完**，全文连贯无缺字。→ **C1 / N1 那个"重开后接不上"的坑在真实 VS Code 里也不会发生** |
| — | 「右键 Hide」是否销毁页面 | 记录 | **不会**：`retainContextWhenHidden` 生效，Output 始终只有一行 `ready`。所以**别再用 Hide 来测重建**，要用 `Developer: Reload Webviews` |
| — | 空闲态 | ✅ PASS | 一切跑完后状态行显示「空闲」，未出现卡在"生成中"（防御性修复已提交） |

### 11.7 待人工验收（剩余步骤）

自动化覆盖不到的是**真实 webview**：CSP 是否真的放行样式、`retainContextWhenHidden` 在视图上是否生效、
受限机的 Chromium 版本差异。这些只能靠 §6.2 的 M0–M10 与 §6.3 的 W0–W3。

产物：`jerrypi-0.1.4.vsix`，5,998,041 字节，
SHA-256 `90a419e761caa57af49c8fdd0af393217127049f32c102265f39280a8d21a7d6`。
