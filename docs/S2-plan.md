# S2 实施计划：协议与基础聊天

> 依据：`docs/PLAN.md` 第 6 节 "S2 协议与基础聊天"、5.1/5.2/5.3/5.4、R9、D7-S1、D7-S2、D10-S1。
> 前置：S1 已关闭（Mac 与受限 Windows 机双端 `GATE PASS`，见 `docs/S1-plan.md` 第 12 节）。

## 0. 本计划已核实的事实（都带证据，不靠记忆）

写计划前对着 pi 0.85.1 的 `.d.ts` 与本机产物逐条核实过。**下面是 S2 全部设计的依据。**

### 0.1 事件与状态（`@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`）

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

会话状态读取口（全部是 getter，S2 直接依赖）：

| 成员 | 用途 |
| --- | --- |
| `session.messages` | **"All messages including custom types like BashExecutionMessage"** —— 重放的唯一数据源 |
| `session.state.streamingMessage?` | 进行中的半截 assistant 消息（面板在流式中重开时用它补齐） |
| `session.state.isStreaming` / `session.isStreaming` | 空闲判定 |
| `session.state.errorMessage?` | 最近一次失败/中止的错误文本 |
| `session.isIdle` | 冗余，S2 不用 |

### 0.2 发送语义（本次核实，纠正了旧计划的写法）

- `prompt(text, options?)`：**流式期间调用必须给 `options.streamingBehavior`**，否则抛错。
  非流式时它会**校验模型与 API key**，没有就抛错。另外它**会立即执行扩展命令**（`/smoke` 这类），
  流式期间也执行。
- `steer(text)`：入队，**当前 assistant 轮次执行完工具调用后、下一次 LLM 调用前**投递。
- `followUp(text)`：入队，**只有 agent 没有更多工具调用与 steering 消息时**才投递。
- `steer`/`followUp` 都是 `@throws Error if text is an extension command`。
- `prompt()` 返回的 promise **要到整轮结束才 resolve**（不是"接受即返回"）。

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
→ 见决策点 D2。

### 0.4 渲染安全（实跑验证，不是推断）

pi 自带的 `dist/core/export-html/vendor/marked.min.js` 是 **marked v18.0.5**（UMD）。
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

### 0.5 Webview 宿主 API（`@types/vscode`）

- `WebviewView` 有 `onDidDispose`（**用右键隐藏视图时会 dispose**）。
- `WebviewOptions.retainContextWhenHidden` **对 view 同样有效**（`index.d.ts` 10281/10309）。
- CSP 用 `webview.cspSource` + nonce；本地资源用 `webview.asWebviewUri`。

### 0.6 S1 已有的可复用件

`loader.ts`（`loadPi`/`reloadPi`/`PiModule`）、`runtime.ts`（`ModelRuntime` 单例 + SecretStorage key 注入）、
`session.ts`（`createSessionHost`，已含 rebind、`projectTrusted:false`、`customTools`、`onEvent` 出口）、
`bindings.ts`（`bindSession` + `SessionBinding`）、`commands.ts`、`selftest.ts`。
**S2 不改 S1 自测契约**（首行/`T<n>`/`GATE` 格式与判定规则原样保留）。

---

## 1. 范围

### 1.1 做

1. `src/shared/protocol.ts`：`ClientMessage` / `ServerMessage` 联合类型 + `PROTOCOL_VERSION`。
2. `src/pi/session.ts` 扩展为可长期持有的**面板会话主机**（新增 `SessionHostController`），
   提供 `ensure() / prompt() / steer() / followUp() / abort() / clearQueue() / dispose()` 与事件订阅。
3. `src/host/chatView.ts`：`WebviewViewProvider`，消息路由、**状态重放**、CSP/nonce、
   `openExternal` 代理。
4. `src/webview/render.ts`：markdown（marked + pi 的消毒配置）、思考块、（S2 极简）工具行、错误块。
5. `src/webview/main.ts`：输入框、流式文本、思考块折叠、中止按钮、队列条、状态行。
6. `src/webview/style.css`：只用 VS Code 主题变量。
7. `esbuild.mjs` 增加 webview 入口（`platform: browser`、`format: iife`）与 CSS 入口。
8. `package.json`：`viewsContainers.activitybar`、`views`、`media/jerrypi.svg` 图标；
   `jerrypi.focusChat` 真正聚焦视图。
9. `scripts/render-xss-check.mjs`：**CI 可跑**的渲染安全回归（0.4 的 12 个载荷）。
10. README 补安装/使用说明与已知限制（远程图片不加载、队列只能整体清空、窗口重载不恢复历史）。

### 1.2 不做（留给后续步骤）

| 不做 | 留给 |
| --- | --- |
| bash/read/edit/write 的**卡片**（参数、结果、折叠、bash 输出流式、点路径开文件） | S3（S2 只显示一行"工具名 ✓/✗"） |
| 模型选择器、思考等级切换、状态栏用量 | S4 |
| 会话列表 / 恢复 / 窗口重载后 `continueRecent` | S5 |
| VS Code 设置项、`Clear Stored API Keys`、项目信任 UI | S6 |
| diff 审阅 | S7 |
| 工具审批 | S8 |
| 语法高亮（hljs）、图片附件、复制按钮、搜索 | 未排期 |
| `session.prompt` 的 skill / 模板展开 | 已由 `expandPromptTemplates` 默认行为覆盖 |
| 面板内 `!` 直接执行 bash | 未排期 |

---

## 2. 文件清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/shared/protocol.ts` | 新增 | 两端共享的唯一契约 |
| `src/pi/controller.ts` | 新增 | `SessionHostController`：懒加载 + 单会话生命周期 |
| `src/pi/serialize.ts` | 新增 | `AgentMessage[] → ChatItem[]`（重放与增量共用） |
| `src/host/chatView.ts` | 新增 | View provider、路由、重放、CSP |
| `src/host/webviewHtml.ts` | 新增 | 生成带 nonce 的 HTML（便于单测） |
| `src/webview/render.ts` | 新增 | markdown 消毒渲染（纯函数，可在 Node 里测） |
| `src/webview/main.ts` | 新增 | DOM 与交互 |
| `src/webview/style.css` | 新增 | 主题变量 |
| `media/jerrypi.svg` | 新增 | 活动栏图标（单色 24×24） |
| `src/extension.ts` | 改 | 注册 view provider；`focusChat` 聚焦视图 |
| `src/commands.ts` | 改 | `jerrypi.focusChat` 改为聚焦视图；新增 `Pi: New Session`（面板内入口，S5 再扩展） |
| `src/pi/session.ts` | 改 | `createSessionHost` 增加可选 `systemPromptHint`/暴露 `session`（已具备）——**仅在需要时改** |
| `esbuild.mjs` | 改 | 双入口三产物 |
| `package.json` | 改 | contributes + `marked` 精确版本 devDependency |
| `scripts/render-xss-check.mjs` | 新增 | CI 安全回归 |
| `scripts/self-test.mjs` | 改 | 增加 case：render 安全脚本必须通过（防漂移） |
| `.github/workflows/ci.yml` | 改 | 增加 `npm run check:render` |
| `README.md` | 改 | 使用说明 + 已知限制（中英） |

**新增依赖**：`marked`，**精确 18.0.5**（与 pi 自带的 vendor 版本一致，不加 `^`）。
不引入 hljs（见 1.2），不引入任何前端框架。

---

## 3. 不可违反的约束

1. **`render.ts` 是唯一的 HTML 生成点。** webview 里除了它返回的字符串，任何地方不得把数据写进
   `innerHTML`；流式文本一律用 `textContent` 追加。
2. **webview 不加载任何远程资源**：`default-src 'none'`，图片只允许 `data:image/*` 与 `webview.cspSource`。
3. **不用 `eval`、不内联脚本**（除带 nonce 的 `<script>`）、不 `enableCommandUris`。
4. **扩展侧的 pi 调用全部走 `controller`**，`chatView` 不认识 pi。
5. **空闲判定以 `agent_settled` 为准**，不以第一个 `agent_end`（D7-S2）。
6. **流式期间绝不调无参 `prompt()`**（D7-S1）。
7. `activate()` 保持**非阻塞**（S0-D3）：视图/provider 同步注册，pi 加载与建会话在首次需要时进行。
8. 新增 `commands` 必须保持 S1 自测 T3 的命令标记检查（`self-test.mjs` case 5 会校验资源清单，命令清单另有断言）。
9. 扩展产物**不静态 import pi**（沿用 S1 的 `loader.ts` 约束）。
10. `.vsix` 体积门禁仍是 30 MB；`check-vsix.mjs` 必须继续通过。

---

## 4. 模块设计

### 4.1 `src/shared/protocol.ts`

```ts
export const PROTOCOL_VERSION = 1;

export type ChatItem =
  | { kind: "user";      id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string;
      toolCalls: { toolCallId: string; name: string; argsText: string }[];
      stopReason: string; errorMessage?: string; streaming?: boolean }
  | { kind: "toolResult"; id: string; toolCallId: string; toolName: string;
      isError: boolean; text: string; truncated: boolean }
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
  | { type: "state"; protocol: number; items: ChatItem[]; streamingItem?: ChatItem;
      queue: { steering: string[]; followUp: string[] }; busy: boolean;
      cwd: string; model: string; errorMessage?: string }
  | { type: "item"; item: ChatItem }                    // 新增一条（user / assistant 开始 / toolResult / notice）
  | { type: "delta"; id: string; kind: "text" | "thinking"; delta: string }
  | { type: "itemEnd"; item: ChatItem }                 // 用最终内容替换
  | { type: "toolPhase"; toolCallId: string; phase: "start" | "end"; toolName: string; isError?: boolean }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "busy"; busy: boolean; errorMessage?: string }
  | { type: "composerError"; text: string };
```

约定：`id` 由扩展侧生成（`crypto.randomUUID()`），webview 只按 `id` 定位 DOM 节点。

### 4.2 `src/pi/serialize.ts`

`serializeMessage(message, index) → ChatItem[]`（一条 pi 消息可能展开成多条 item，例如
assistant 的文本 + 后续 toolResult）。角色映射：

| pi 消息 | 产物 |
| --- | --- |
| `role: "user"` | `{kind:"user"}`，content 里的 text 块拼接；图片块 → 追加 `[图片]` 占位（附件功能未做） |
| `role: "assistant"` | `{kind:"assistant"}`：text 块拼接、thinking 块拼接、toolCall 块列成 `toolCalls`；带 `stopReason`/`errorMessage` |
| `role: "toolResult"` | `{kind:"toolResult"}`：`toolName`、`isError`、content 文本拼接；**单条上限 20 000 字符**，超出截断并置 `truncated` |
| `role: "custom"` / `"bashExecution"` | `{kind:"notice"}`（内容为文本摘要） |
| `role: "compactionSummary"` / `"branchSummary"` | `{kind:"notice"}`（"上下文已压缩"等） |
| 其它未知 role | `{kind:"notice", level:"warn"}` + 原样 `role` —— **不静默丢弃** |

截断上限是常量 `MAX_TOOL_TEXT = 20_000`，导出以便测试。

### 4.3 `src/pi/controller.ts`（面板会话主机）

```ts
export interface SessionHostControllerOptions {
  pi: PiModule; extensionPath: string; extensionVersion: string;
  cwd: string; agentDir: string; keys: ApiKeyStore;
  uiContext: ExtensionUIContext; sink: EventSink;
  onEvent?: (e: AgentSessionEvent) => void;
  onExtensionError?: (e: ExtensionError) => void;
}

export class SessionHostController {
  ensure(): Promise<void>;                 // 幂等；失败抛错，由调用方转成面板提示
  readonly ready: boolean;
  get host(): SessionHost | undefined;
  prompt(text, behavior): Promise<void>;   // 见 4.3.1
  abort(): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };
  snapshot(): ReplaySnapshot;              // 重放数据（消息 + 半截 + 队列 + busy + model）
  dispose(): Promise<void>;
}
```

要点：

- `ensure()` 里才做 `ModelRuntime` 创建（每次创建后**重新注入** SecretStorage 里的 key，
  因为 `setRuntimeApiKey` 是内存态）→ 建 `SessionManager.create(cwd, <agentDir>/sessions)`
  → `createSessionHost(...)`，`onEvent` 接到 S2 的事件出口。
- **模型对齐沿用 S1 的做法**：`ensure()` 后按 `PREFERRED_PROVIDERS` / `PREFERRED_MODEL_IDS`
  对齐（把 0.1.3 里已经验证过、且在受限机上救过命的 `alignModel` 从 `selftest.ts`
  **提取到 `src/pi/model-choice.ts` 共用**，自测与生产都调它，避免两套逻辑漂移）。
- `snapshot()` = `serialize(session.messages)` + （`state.streamingMessage` 存在时再补一条
  `streaming:true` 的 assistant item）+ 队列 + `isStreaming` + 模型名 + `state.errorMessage`。

#### 4.3.1 `prompt(text, behavior)` 的竞态处理

```
if (session.isStreaming)  → prompt(text, { streamingBehavior: behavior === "followUp" ? "followUp" : "steer" })
else                      → prompt(text)                     // 让 pi 校验模型/凭据
catch (e):
  若错误文本匹配 /already processing|streamingBehavior/i  → 用 streamingBehavior:"steer" 重试一次
  其它错误 → 把 e.message 原样回给面板（composerError）
```

pi 的原始报错文本（已从 `agent-session.js` 取出，用于确定重试判据）：

```
Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
```

- **不 `await` 到整轮结束**：`prompt()` 的 promise 到 `agent_end` 才 resolve，
  路由层必须立刻返回（否则 `onDidReceiveMessage` 一直挂着），错误经 `.catch` 走 `composerError`。
- 扩展命令（`/smoke`）由 pi 在 `prompt()` 内处理，S2 不特殊对待。

### 4.4 `src/host/chatView.ts`

- `resolveWebviewView(view)`：
  - `view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri], retainContextWhenHidden: true }`
    （S2-D3 默认 true：流式期间切走再切回来不掉字；重放逻辑**照样实现**，因为 dispose 与窗口重载都会走到）
  - `view.webview.html = buildWebviewHtml(...)`（nonce 每次随机）
  - `onDidReceiveMessage` 路由；`view.onDidDispose` 只清理订阅，**不动 pi 会话**（会话归 controller）
- 路由表：

| ClientMessage | 处理 |
| --- | --- |
| `ready` / `requestState` | `controller.ensure()` → `post(state)`；失败 post `notice(error)` + `busy:false` |
| `prompt` | `ensure()` → `controller.prompt(text, behavior)`；失败 post `composerError` |
| `abort` | `controller.abort()` |
| `clearQueue` | `controller.clearQueue()` → 随后以 `queue_update` 为准刷新 |
| `openExternal` | 校验 scheme ∈ {http,https,mailto} 后 `vscode.env.openExternal`；否则忽略并记 Output |

- 事件 → `ServerMessage` 的映射（收到 `AgentSessionEvent` 时）：

| pi 事件 | 协议消息 |
| --- | --- |
| `message_start`（assistant） | `item`（空 assistant，`streaming:true`）+ 记 `currentAssistantId` |
| `message_update.text_delta` | `delta {kind:"text"}` |
| `message_update.thinking_delta` | `delta {kind:"thinking"}` |
| `message_start`（user） | `item`（user；用 `serializeMessage` 生成） |
| `message_end` | `itemEnd`（该消息的最终 `ChatItem`） |
| `tool_execution_start` | `toolPhase {phase:"start"}` |
| `tool_execution_end` | `toolPhase {phase:"end", isError}` |
| `queue_update` | `queue` |
| `agent_start` / `agent_settled` | `busy {busy:true/false}`（**空闲只认 `agent_settled`**） |
| `agent_end` | 仅在有 `willRetry` 时发 `notice`（"将自动重试"） |
| `compaction_start/end`、`auto_retry_*` | `notice` |
| `session_info_changed` / `thinking_level_changed` | S4 再用，S2 忽略 |

- **不做节流**：`text_delta` 逐条转发（S2 先求正确与简单；若实测卡顿，S2-D5 记为待优化）。
  webview 侧对每个 `delta` 只做 `textContent +=`（不重排 DOM、不重渲染 markdown）。

### 4.5 `src/webview/render.ts`

- `import { marked } from "marked"`，`marked.use(...)` **照抄** 0.4 的 tokenizer/renderer 配置
  （`html()/tag()` 返回 `undefined`、`sanitizeMarkdownUrl`、`escapeHtml`、`strictStrikethroughRegex`）。
- **比 pi 更严的一处**（S2-D1）：`image` 的 scheme 白名单收窄为只允许 `data:image/`，
  其它一律降级为纯文本（`![](https://…)` 显示为 alt 文本）——因为 webview 发远程请求等于
  把"模型可控的 URL"变成出网信道。与 PLAN R9 "只加载本地资源 + 图片 data URI" 一致。
- `renderMarkdown(text) → html`、`renderNotice(item)`、`renderToolLine(name, phase, isError)`。
- 纯函数、**不碰 DOM**，因此可在 Node 里直接跑（CI 的 0.4 用例）。

### 4.6 `src/webview/main.ts`

- DOM 骨架：`#transcript`（消息列表）、`#queue`（队列条）、`#composer`（textarea + 发送/中止按钮）、`#status`。
- 消息处理：
  - `state` → 清空并按 `items` 全量重建；有 `streamingItem` 时接上流式节点；恢复 `busy` → 输入态
  - `item` → 追加节点（user/notice 立即 markdown 渲染；assistant 建空节点 + 流式区）
  - `delta` → 追加到流式区（`textContent`），并在**流式期间**用 `white-space: pre-wrap` 呈现纯文本
  - `itemEnd` → 用最终文本替换流式区为 `renderMarkdown` 结果（S2-D2）
  - `queue` → 渲染待处理条（steering 标"将打断"、followUp 标"排队"）+ "清空队列"按钮
  - `busy` → 按钮/输入框状态；`composerError` → 输入框下方红字，**保留用户输入不清空**
- 输入语义（PLAN 5.2 第 5 条）：
  - 空闲：`Enter` → `prompt auto`（`Shift+Enter` 换行）
  - 流式中：`Enter` → `prompt steer`（按钮文案与提示条写明"将打断当前回复"）；
    另有"排队"按钮 → `prompt followUp`
  - 流式中输入框**不禁用**（要能发 steering），但状态行显示"生成中…"
- 链接：`click` 事件里判断 `a[href]` → `postMessage({type:"openExternal"})` + `preventDefault`。
- 无 `vscode` 之外的依赖；不使用 `innerHTML`（除 `render.ts` 的返回值）。

### 4.7 `esbuild.mjs`

新增两个入口，保持既有扩展入口不变：

```js
entryPoints: { extension: "src/extension.ts", webview: "src/webview/main.ts", style: "src/webview/style.css" }
// 扩展：platform node / format esm / external: ["vscode"] / banner(createRequire)
// webview 与 style：platform browser / format iife / target es2022 / minify
```

产物：`dist/extension.js`、`dist/webview.js`、`dist/style.css`。构建后断言
`dist/webview.js` 里**不出现** `require(`、且包含 `marked` 的痕迹（防止入口漏配）。

### 4.8 `package.json`

```jsonc
"contributes": {
  "viewsContainers": { "activitybar": [{ "id": "jerrypi", "title": "Pi", "icon": "media/jerrypi.svg" }] },
  "views": { "jerrypi": [{ "type": "webview", "id": "jerrypi.chat", "name": "Chat" }] },
  "commands": [ /* 既有 4 条 + jerrypi.newSession */ ]
}
```

`jerrypi.focusChat` 实现改为 `vscode.commands.executeCommand("jerrypi.chat.focus")`。
`.vscodeignore` **无需改动**：已核实 `media/` 与 `dist/` 都不在排除列表中（排除的是 `src/`、`scripts/`、`docs/`、
`.github/`、`.vscode/`、根 `node_modules/`、map 文件），所以 `media/jerrypi.svg` 会自然进包。
但 `check-vsix.mjs` 需新增断言：解包后 `extension/media/jerrypi.svg`、`extension/dist/webview.js`、
`extension/dist/style.css` 三个文件必须存在。

### 4.9 `scripts/render-xss-check.mjs`（CI）

用 `esbuild` 把 `src/webview/render.ts` 打成 CJS（`platform: node`）后在 Node 里跑 0.4 的
**12 个载荷**，按 0.4 的判据断言；任一不通过即退出非零。同时断言
`MAX_TOOL_TEXT` 截断行为与未知 role 的降级不为空。
由 `npm run check:render` 触发，并加入 `scripts/self-test.mjs` 的 case 与 CI。

---

## 5. 重放契约（面板重开 / 窗口重载）

| 场景 | VS Code 行为 | 我们的处理 |
| --- | --- | --- |
| 切到别的视图再切回 | `retainContextWhenHidden: true` → DOM 保留 | 不重放（页内状态原样） |
| 右键隐藏视图 / 面板被 dispose | 触发 `onDidDispose`，再拉开时重新 `resolveWebviewView` | 新 webview 发 `ready` → 全量 `state` |
| 窗口重载 / 扩展重载 | 一切重来 | S2：**新建会话**（历史恢复属 S5 的 `continueRecent`） |
| 流式中重开 | 同上 | `state` 带上 `streamingItem`（来自 `state.streamingMessage`）与 `busy:true` |

**唯一数据源是 `session.messages`**（扩展侧不另存一份转录），避免与 pi 的真实历史漂移。

---

## 6. 验收

### 6.1 CI（每个 PR 都跑）

| 编号 | 内容 |
| --- | --- |
| C1 | `npm run typecheck` 通过 |
| C2 | `npm run build` 产出三个文件，且 `dist/webview.js` 无 `require(` |
| C3 | `npm run check:render`：12 个 XSS 载荷 + 截断 + 未知 role 降级 |
| C4 | `npm run self-test`（5/5，含新 case） |
| C5 | `npm run package` + `check-vsix.mjs`（≤30 MB）+ 解包后再跑隔离 runtime 校验 |

### 6.2 macOS（F5，人工）

| 编号 | 步骤 | 期望 |
| --- | --- | --- |
| M1 | 打开面板，发"你好，用一句话自我介绍" | 流式出现文字；结束后 markdown 渲染；状态行回到空闲 |
| M2 | 连发三轮（其中一轮要求它写一段带代码块的中文） | 多轮上下文正确；代码块等宽显示 |
| M3 | 中途点"中止" | 立刻停止；状态行回到空闲；可继续对话 |
| M4 | 流式中先按 `Enter`（steer）再按"排队"（followUp） | 两条都进队列条且标注不同；不出现 "Agent is already processing"；steer 生效于本轮、followUp 在本轮结束后被处理 |
| M5 | 队列非空时等 `agent_end` | 输入态**仍显示生成中**，直到 followUp 被处理完（`agent_settled`）才解除 |
| M6 | 把面板拉到别处再拉回；再右键视图选隐藏后重新打开 | 前者历史原样；后者历史完整重建 |
| M7 | **XSS（三条）**：把三个载荷**直接粘进输入框发送** | 不弹任何对话框；`<img …>`/`<script>` 以**文字**显示；`[x](javascript:alert(1))` 只显示 `x` 且不可点 |
| M8 | 让模型读一个内容含 `![x](https://…)` 与 `[a](https://example.com)` 的文件 | 远程图片不加载（显示为文本）；https 链接可点且用系统浏览器打开 |

### 6.3 受限 Windows 机（人工，从 Marketplace 更新后）

| 编号 | 内容 |
| --- | --- |
| W1 | `Pi: Focus Chat` 打开面板，完成 M1 + M2 |
| W2 | M7 的三条 XSS（这台机器是最终目标环境） |
| W3 | M4/M5 的队列与空闲判定 |

输出证据格式：面板截图无法读取，**用文字回报**（每步的可见结果 + 是否弹窗 + 状态行文本）。

### 6.4 判据

- C1–C5 全绿；
- M1–M8 全部符合期望；
- W1–W3 全部符合期望；
- 任一 XSS 用例出现弹窗/执行即 **BLOCKED**，停下来重做渲染层。

---

## 7. 提交计划

1. `feat: add the shared chat protocol and message serialization`（protocol.ts + serialize.ts + 单测 case）
2. `feat: add the panel session controller with model alignment`（controller.ts + 从 selftest.ts 提取 model-choice.ts）
3. `feat: add markdown rendering with pi's sanitizer configuration`（render.ts + check:render 脚本 + CI）
4. `feat: add the chat webview view with replay and CSP`（chatView.ts + webviewHtml.ts + assets + esbuild + package.json）
5. `feat: add the chat webview UI with streaming, queue and abort`（main.ts + style.css）
6. `docs: record S2 implementation results and known limitations`（README 中英 + S2 记录）

---

## 8. 决策点（默认值已给，用户可改）

| 编号 | 决策 | 默认 | 理由 |
| --- | --- | --- | --- |
| D1 | 远程图片是否允许加载 | **不允许**（只 `data:image/*`） | 避免把模型可控 URL 变成出网信道；与 PLAN R9 一致 |
| D2 | 队列条能否删除单条 | **不能**，只提供"清空队列" | pi 无单条移除 API；伪造会与真实投递不一致（见 0.3） |
| D3 | `retainContextWhenHidden` | **true** | 流式中切走再回来不掉字；内存开销对本面板可忽略 |
| D4 | 流式期间是否实时渲染 markdown | **否**，纯文本流式 + 结束转 markdown | 半截 markdown 会闪烁；实现简单 |
| D5 | 是否对 delta 节流 | **不节流**（先求正确） | 若实测卡顿再优化，记入 S2.5 |
| D6 | 版本号与通道 | **0.1.4 预发布** | PLAN 5.4 把正式版放 S10；预发布更新链路已在受限机验证可用 |
| D7 | 工具卡片 | S2 只显示一行"工具名 ✓/✗" | 完整卡片是 S3 |
| D8 | 是否新增 `Pi: New Session` 命令 | **是** | 面板需要清空入口；S5 再扩展成完整会话管理 |

---

## 9. 风险

| # | 风险 | 应对 |
| --- | --- | --- |
| S2-R1 | CSP/nonce 配置错误导致脚本不执行（白屏） | 视图加载失败时在面板显示可读错误；`webviewHtml.ts` 纯函数化便于单测 |
| S2-R2 | `prompt()` 竞态（检查与调用之间进入流式） | 4.3.1 的 catch + 重试一次 |
| S2-R3 | 路由层 `await prompt()` 导致消息处理挂死 | 明确不 await；code review 检查点 |
| S2-R4 | marked v18 的 renderer 签名与 pi 模板假设不一致 | 已在本机实跑 12 个载荷验证（0.4），CI 固化 |
| S2-R5 | 长工具输出灌爆 webview | `MAX_TOOL_TEXT` 截断（20 000 字符/条） |
| S2-R6 | 面板重开后状态与 pi 不一致 | 重放只读 `session.messages`，不维护第二份转录 |
| S2-R7 | 受限机上 Electron/Chromium 版本差异导致 webview 行为不同 | W1–W3 在受限机实测；CSP 只用标准指令 |
| S2-R8 | 视图 dispose 时机与 `retainContextWhenHidden` 组合出未预期行为 | M6 专门覆盖两种重开路径 |

---

## 10. 评审记录

（本轮由 Claude / Codex 复核后填写，编号前缀 `S2-CL-` / `S2-CX-`。）
