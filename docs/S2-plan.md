# S2 实施计划：协议与基础聊天

> 依据：`docs/PLAN.md` 第 6 节 "S2 协议与基础聊天"、5.1/5.2/5.3/5.4、R9、D7-S1、D7-S2、D10-S1。
> 前置：S1 已关闭（Mac 与受限 Windows 机双端 `GATE PASS`，见 `docs/S1-plan.md` 第 12 节）。
> **本版已吸收第一轮外部评审（Claude Opus 5，编号 `S2-CL-*`），处置见 §10。**

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
| `session.state.isStreaming` / `session.isStreaming` | 空闲判定 |
| `session.state.errorMessage?` | 最近一次失败/中止的错误文本 |

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
| 正常链接 / 正常图片 / 行内代码 / 粗体删除线 | 正常渲染，URL 未被误杀 |

判据（写进 CI 脚本）：转义后的文本里不会出现裸 `<`，因此输出中**所有** `<…>` 都是 marked
自己生成的标签；逐个检查这些标签，禁止出现被禁标签、`on*=`/`srcdoc=` 属性、
`href|src` 指向 `javascript:|data:|vbscript:|file:`。

### 0.5 Webview 宿主 API（`@types/vscode` 1.120.0，逐行核对）

> ⚠️ **本节是第一版出错处。** 第一版把 `index.d.ts` 里一句 **JSDoc 交叉引用**当成了声明证据，
> 写成"`WebviewOptions.retainContextWhenHidden` 对 view 同样有效"。经 `S2-CL-B1` 指出后重核：

| 事实 | 位置 |
| --- | --- |
| `WebviewOptions` 只有 4 个成员：`enableScripts` / `enableForms` / `enableCommandUris` / `localResourceRoots` | 9902 起 |
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
9. `scripts/render-xss-check.mjs`：**CI 可跑**的渲染安全回归（§0.4 的 12 个载荷）。
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
11. **id 只有一个权威来源：controller。** webview 不得自己造 id，也不得在重放时看到与实时不同的 id
    （`S2-CL-C1`，见 §4.1）。
12. **实时路径与重放路径必须产出同一种 `ChatItem`。** 任何"实时简化、重放完整"的设计都算缺陷
    （`S2-CL-C3`），因为用户重开一次面板就会看到两个样子。

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
  | { type: "composerError"; text: string };
```

**id 规则（唯一权威 = controller，`S2-CL-C1`）**

| 对象 | id | 理由 |
| --- | --- | --- |
| 历史消息（重放） | `msg-<在 session.messages 里的下标>` | 确定性；重放两次得到同样的 id，webview 按 id upsert 不会重复 |
| 进行中的 assistant | `controller.activeAssistantId`，在 `message_start` 时铸造一次并**持有到 `message_end`** | 流式中重开面板时，`snapshot()` **复用它**；否则重开后 delta 会打向一个 webview 不认识的 id，回复的后半截全部丢字 |
| 运行时提示（notice / tool 行） | `msg-<下标>`（与历史一致）或 `notice-<递增序号>` | 同上，保证重放稳定 |

**`item` 是 upsert 语义**（`S2-CL-C2`）：webview 找不到该 id 就**新建**节点。
这样即使某条消息只发了 `message_end`（例如 toolResult），也不会丢。

### 4.2 `src/pi/serialize.ts`

`serializeMessage(message, index, toolCallIndex) → ChatItem | undefined`。
`toolCallIndex: Map<toolCallId, {name, argsText}>` 由调用方**按顺序增量维护**：
遇到 assistant 消息就把它的 toolCall 块登记进去，遇到 toolResult 就从里面取参数摘要。

| pi 消息 | 产物 |
| --- | --- |
| `role: "user"` | `{kind:"user"}`，content 里的 text 块拼接；图片块 → 追加 `[图片]` 占位（附件功能未做） |
| `role: "assistant"` | `{kind:"assistant"}`：text 块拼接、thinking 块拼接；带 `stopReason`/`errorMessage`。**不带 toolCalls 字段**（S2 的卡片范围只在 §1.2） |
| `role: "toolResult"` | `{kind:"tool"}`：`toolName` + **参数摘要**（来自 `toolCallIndex`，取不到时留空）+ `isError`。**不显示结果正文**（`S2-CL-C3`：S2 不含工具卡片，正文是 S3 的范围；否则重放一次就把"不做的功能"冒出来了） |
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
- `snapshot()` = `serialize(session.messages)` + （`state.streamingMessage` 存在时追加一条
  `streaming:true` 的 assistant item，**id 用 `activeAssistantId`**）+ 队列 + `isStreaming` +
  模型名 + `state.errorMessage`。

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
- 扩展命令（`/smoke`）由 pi 在 `prompt()` 内处理，S2 不特殊对待。

#### 4.3.2 delta 合帧（`S2-CL-S4`，推翻第一版的 D5）

`text_delta` / `thinking_delta` 不逐条转发，而是在 controller 里按 **~16 ms** 合帧后发一条 `delta`。
理由是合并相邻 delta **不改变内容与顺序**，不是正确性取舍，只是十几行代码；
不合并的话一条长回复会产生几千次 IPC 往返。

#### 4.3.3 `abort()` 同时清队列（`S2-CL-S1`，见决策 D9）

`await session.abort()` 之后调 `clearQueue()`，把返回的文本原样交给 webview 填回输入框。
理由：用户点"中止"的语义是"停下来"，留着 followUp 让它在用户以为已经停下之后继续发出去，
属于违背意图；pi 自己的 `clearQueue()` 注释也把"用户中止时还原到编辑器"列为用途。

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
| `abort` | `controller.abort()` → `queue` 消息清空队列条 + `composerError` 回填被退回的文本 |
| `clearQueue` | `controller.clearQueue()` → 以随后的 `queue_update` 为准刷新 |
| `openExternal` | 校验 scheme ∈ `urlPolicy.EXTERNAL_SCHEMES` 后 `vscode.env.openExternal`；否则忽略并记 Output |

- 事件 → `ServerMessage`。**核心规则：所有 `message_end` 一律走同一个序列化器并发 `item`（upsert）；
  只有"正在流式的那条 assistant"才额外走 `delta` 快路径。**

| pi 事件 | 协议消息 |
| --- | --- |
| `message_start`（assistant） | `item`（空 assistant，`streaming:true`，id = 新铸造并持有） |
| `message_update.text_delta` | 合帧后 `delta {kind:"text"}` |
| `message_update.thinking_delta` | 合帧后 `delta {kind:"thinking"}` |
| `message_end`（**任意 role**，含 toolResult / user / custom） | `item`（同一序列化器产出；upsert 语义；assistant 同时清 `activeAssistantId`） |
| `tool_execution_start` | 只记 `toolCallIndex` 的补充信息（**不发 UI 消息**：UI 由 toolResult 的 `message_end` 驱动，保证与重放一致） |
| `tool_execution_end` | 同上（不发 UI 消息） |
| `queue_update` | `queue` |
| `agent_start` / `agent_settled` | `busy {busy:true/false}`（**空闲只认 `agent_settled`**） |
| `agent_end` | 仅在有 `willRetry` 时发 `notice` |
| `compaction_start/end`、`auto_retry_*` | `notice` |
| `session_info_changed` / `thinking_level_changed` | S4 再用，S2 忽略 |

- **`tool_execution_start/update/end` 为何不直接驱动 UI**：实时用它们建节点、重放用 `session.messages`
  建节点，就是第一版"两种呈现"的来源（`S2-CL-C3/C4`）。统一走 `message_end` 后，实时与重放的
  代码路径**是同一段**。代价是工具行要等该次调用结束才出现（S2 的"一行摘要"本来也只有结束时才有结论），
  S3 做卡片时再为"执行中"状态单独引入 `toolPhase` 消息。

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
  - `busy` → 按钮/输入框状态；`composerError` → 输入框下方红字，**保留用户输入不清空**
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
**12 个载荷**，按 §0.4 的判据断言；任一不通过即退出非零。另断言：
`SUMMARY_MAX` 截断、未知 role 的降级不为空、`urlPolicy` 里 render 与 external 用的是同一份白名单。
由 `npm run check:render` 触发，并加入 `scripts/self-test.mjs` 的 case 与 CI。

---

## 5. 重放契约（面板重开 / 窗口重载）

| 场景 | VS Code 行为 | 我们的处理 |
| --- | --- | --- |
| 切到别的视图再切回 | 视图级 `webviewOptions.retainContextWhenHidden: true` → DOM 保留 | 不重放（页内状态原样） |
| 右键隐藏视图 / 面板被 dispose | 触发 `onDidDispose`，再拉开时重新 `resolveWebviewView` | 新 webview 发 `ready` → 全量 `state` |
| 窗口重载 / 扩展重载 | 一切重来 | S2：**新建会话**（历史恢复属 S5 的 `continueRecent`） |
| **流式中重开** | 同上 | `state` 带上进行中 assistant 的 item（来自 `state.streamingMessage`），**id 复用 controller 持有的 `activeAssistantId`**，后续 delta 才能接上（`S2-CL-C1`） |

**唯一数据源是 `session.messages`**（扩展侧不另存一份转录），避免与 pi 的真实历史漂移。

---

## 6. 验收

### 6.1 CI（每个 PR 都跑）

| 编号 | 内容 |
| --- | --- |
| C1 | `npm run typecheck` 通过（含 `view.webview.options` 无多余属性的编译期检查） |
| C2 | `npm run build` 产出三个非空产物 |
| C3 | `npm run check:render`：12 个 XSS 载荷 + 摘要截断 + 未知 role 降级 + 白名单同源 |
| C4 | `npm run self-test`（**6/6**，含新 case） |
| C5 | `npm run package` + `check-vsix.mjs`（≤30 MB，含三个新产物断言）+ 解包后再跑隔离 runtime 校验 |

### 6.2 macOS（F5，人工）

| 编号 | 步骤 | 期望 |
| --- | --- | --- |
| M0 | 打开面板 | 面板**有样式**（说明 CSP 的 `style-src` 对了）、脚本执行（说明 nonce 与 `localResourceRoots` 对了） |
| M1 | 发"你好，用一句话自我介绍" | 流式出现文字；结束后 markdown 渲染；状态行回到空闲 |
| M2 | 连发三轮（其中一轮要求它写一段带代码块的中文） | 多轮上下文正确；代码块等宽显示 |
| M3 | 中途点"中止" | 立刻停止；**队列被清空且文本退回输入框**；状态行回到空闲；可继续对话 |
| M4 | 流式中先按 `Enter`（steer）再按"排队"（followUp） | 两条都进队列条且标注不同；不出现 "Agent is already processing"；steer 生效于本轮、followUp 在本轮结束后被处理 |
| M5 | 队列非空时等 `agent_end` | 输入态**仍显示生成中**，直到 followUp 被处理完（`agent_settled`）才解除 |
| M6 | 把面板拉到别处再拉回 | 历史原样，**且不触发整页重放**（DOM 未重建 → 说明 `retainContextWhenHidden` 生效） |
| **M6b** | **流式进行中**右键隐藏视图，再拉开 | 文字**继续增长到结束**（这是 `S2-CL-C1` 的回归点；不是流式中段做的话测不出来） |
| M7 | **XSS（三条）**：把三个载荷**直接粘进输入框发送** | 不弹任何对话框；`<img …>`/`<script>` 以**文字**显示；`[x](javascript:alert(1))` 只显示 `x` 且不可点 |
| M8 | 让模型读一个内容含 `![x](https://…)` 与 `[a](https://example.com)` 的文件 | 远程图片不加载（显示为文本）；https 链接可点且用系统浏览器打开 |
| M9 | 发一条会触发工具调用的指令（例如让它读一个文件） | 工具行以**一行**出现（名字 + 参数摘要 + ✓）；**隐藏再重新打开面板后，同一行以同样形态重放出来**（`S2-CL-C3` 的回归点） |

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
- M0–M9 全部符合期望；
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
| D7 | 工具卡片 | S2 只显示一行"工具名 + 参数摘要 + ✓/✗"，**实时与重放一致** | 完整卡片是 S3 |
| D8 | 是否新增 `Pi: New Session` 命令 | **是** | 面板需要清空入口；S5 再扩展成完整会话管理 |
| D9 | 中止时是否清队列 | **清空并把文本退回输入框**（`S2-CL-S1`） | "中止"的语义是停下来；否则队列里的 followUp 会在用户以为已停止后继续发出去 |

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
| S2-R10 | 视图 dispose 时机与 `retainContextWhenHidden` 组合出未预期行为 | M6/M6b 覆盖两种重开路径 |

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
