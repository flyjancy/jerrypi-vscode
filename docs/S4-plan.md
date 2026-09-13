# S4 计划：模型与思考等级（含「模型 + 状态」可见性改造）

> 状态：**待评审**（写计划 → 外部评审 → 吸收 → 再实现）
> 上游：`docs/PLAN.md` §6 的 S4（G4）；本步新增一条用户要求：**模型与状态要显示在能看到的位置**。

---

## 1. 目标

1. **面板版式**：把「工作状态」从面板最上面挪到**输入框上方**，把「模型 · 思考等级 · 上下文用量」
   放在**输入框下方** —— 也就是 pi TUI 的纵向顺序（证据见 §3.1）。
2. **模型选择器**：QuickPick 列出可用模型（provider、价格、上下文窗口、是否支持图片），
   选中即切换当前会话的模型。
3. **思考等级切换**：QuickPick 列出**该模型支持的**等级（pi 会 clamp），切换后立即生效并显示。
4. **上下文用量显示**：面板元信息行显示 `0.0%/1M`，并加一个 VS Code 状态栏项（G4 要求），
   点击可打开模型选择器。

**验收判据（G4）**：用户能看见当前用的是哪个模型、还能吃多少上下文；
能在不离开面板的情况下换模型、换思考等级。

---

## 2. 本步不做的事（明确划界）

| 不做 | 归属 |
| --- | --- |
| 新建/切换/恢复会话 | S5 |
| 把模型写进 pi 的全局设置（pi TUI 里是 Ctrl+S / `app.models.save`） | S6（设置与密钥） |
| diff 审阅卡片 | S7 |
| 工具审批开关 | S8 |
| pi 包管理 | S9 |
| 自定义快捷键（抢 VS Code 键位） | 不做；用命令面板 + 点击元信息行 |
| 上下文压缩的 UI | pi 自己按阈值压缩，我们只显示 `(auto)` 与否？→ **不显示 auto**，见 D6 |

---

## 3. 已核实的事实（不猜，全部来自类型声明或 pi 源码）

### 3.1 pi TUI 的纵向顺序（**这是本次版式改造的依据**）

`pi-coding-agent/dist/modes/interactive/interactive-mode.js:637-645`：

```js
this.mountInteractiveTui(this.renderer, [
  this.documentContainer,        // 1 转录
  this.pendingMessagesContainer, // 2 待发消息（队列）
  this.statusContainer,          // 3 工作状态
  this.widgetContainerAbove,     // 4
  this.editorContainer,          // 5 输入框
  this.widgetContainerBelow,     // 6
  this.footerContainer,          // 7 底部信息（模型 / 用量）
]);
```

即：**队列 + 工作状态在输入框之上，模型/用量在输入框之下**。
同文件 `:350-355` 还显示输入框构造时带 `embedWorkingStatus: true` ——
工作状态甚至嵌进编辑器内部，进一步说明"状态贴着输入框"是 pi 的刻意设计。

### 3.2 footer 里显示什么（`modes/interactive/components/footer.js` 的 `render()`）

- **左**：`↑输入 ↓输出 R缓存读 W缓存写 CH命中率 $成本 <百分数>%/<上下文窗口>`，
  其中：
  - 上下文百分数 = `session.getContextUsage()?.percent`，**未知时显示 `?`**（原话：刚压缩后未定）；
  - **阈值配色：>90% 用 error 色，>70% 用 warning 色**；
  - 成本为 0 且不是订阅制时不显示成本。
- **右**：`(provider) <model id> • <等级>`；模型 `reasoning: false` 时**不显示等级**。

### 3.3 S4 需要的 API（`dist/core/agent-session.d.ts`、`dist/core/model-runtime.d.ts`）

| 用途 | API | 备注 |
| --- | --- | --- |
| 当前模型 | `session.model: Model \| undefined` | `Model = {id, name, api, provider, baseUrl, reasoning, thinkingLevelMap?, input, cost, contextWindow, maxTokens}` |
| 当前思考等级 | `session.thinkingLevel: ThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`（7 档） |
| 列出可用模型 | `session.modelRuntime.getAvailable(providerId?): Promise<readonly Model[]>` | **只返回已配置凭据的**；S1 的 `pickModel()` 已在用（`src/pi/controller.ts:223`） |
| 切换模型 | `session.setModel(model, {persist?})` | **`persist` 默认 false = 只改本次会话**；无凭据会 throw |
| 切换思考等级 | `session.setThinkingLevel(level, {persist?})` | **pi 内部会 clamp 到模型能力**并写进会话转录 |
| 该模型支持哪些等级 | `session.getAvailableThinkingLevels(): ThinkingLevel[]` | 给 QuickPick 用 |
| 是否支持思考 | `session.supportsThinking(): boolean` | 不支持时明确提示，别让人以为坏了 |
| 上下文用量 | `session.getContextUsage(): ContextUsage \| undefined` | `{tokens: number\|null, contextWindow, percent: number\|null}` |
| 会话统计 | `session.getSessionStats(): SessionStats` | 累计 tokens / cost / contextUsage；**本步只用 contextUsage 部分** |
| 等级变更事件 | `{type: "thinking_level_changed", level}` | 会话事件 ✓ |

**没有 `model_changed` 事件** —— 模型是我们自己调的，所以由我们自己广播（见 D3）。
pi 的默认模型目录刷新**不联网**（`CreateModelRuntimeOptions` 注释：`Allow create() to refresh
model catalogs over the network. Defaults to false`）。

### 3.5 S4 探针的**实测**结果（2026-09-13，本机 `~/.pi/agent`）

写计划时我做了三个假设，**其中两个是错的**，这里以实测为准：

```
ModelRuntime.create() = 7ms；getAvailable() = 1ms；共 4 个模型
  · deepseek/deepseek-v4-flash            reasoning=true  ctx=1M  $2/$8   输入=text
  · deepseek/deepseek-v4-flash-vision-exp reasoning=true  ctx=1M  $2/$8   输入=text+image
  · deepseek/deepseek-v4-pro              reasoning=true  ctx=1M  $9/$27  输入=text
  · deepseek/deepseek-flash               reasoning=true  ctx=1M  $2/$8   输入=text+image
```

1. **`getAvailable()` 只花 1 毫秒** → **不需要缓存**（原 R3 作废）。
2. **`openai` 不在列表里**（那台受限机的自测打印过"已配置 provider: deepseek, openai"）
   —— 证实 `getAvailable()` 按**有效凭据**过滤，D7 成立。
3. **四个模型的 `reasoning` 全是 `true`** —— 我原以为 deepseek 不支持思考，**错了**。
   真实等级列表（`getAvailableThinkingLevels()`，注意**有空洞**）：

   | 模型 | 等级列表 | 说明 |
   | --- | --- | --- |
   | `deepseek-v4-flash` | `["off","low","high","max"]` | `minimal`/`medium` 被 `thinkingLevelMap` 的 `null` 隐藏 |
   | `deepseek-v4-flash-vision-exp` | `["off","low","high","max"]` | 同上 |
   | `deepseek-v4-pro` | `["off","high","max"]` | **连 `low` 都没有** |

   会话默认等级是 **`high`**（不是 `off`）。
4. **`setThinkingLevel()` 静默 clamp**，实测：`medium→high`、`minimal→low`、`xhigh→max`。
   → 所以 UI 只列 `getAvailableThinkingLevels()` 的结果（永远不触发 clamp），
   并且**切完要回读 `session.thinkingLevel`**，不假设我们设进去的就是生效值。
5. `getContextUsage()` 会话开始时是 `{tokens: 0, contextWindow: 1000000, percent: 0}`
   —— **不是 null**（`null` 只出现在刚压缩之后），所以元信息行一开局就显示 `0.0%/1M`。
   上下文窗口是 **1M**，前面示例里写的 128k 只是占位符。
6. 价格单位 = **USD / 1M tokens**（`pi-ai/dist/models.js:543-544` 的 `rates / 1000000 * tokens`）。
7. **pi 的 `formatTokens` 没有导出**（bundle 只导出 `formatSize`/`formatDimensionNote`/`formatSkillsForPrompt`），
   所以 `42.3%`/`1M` 这类格式化要照抄 pi 的语义（见 D14）。

### 3.4 「模型」现在在面板上的位置

- `src/webview/main.ts:198`：`const parts = [model === "" ? "未选择模型" : model, busy ? "生成中…" : "空闲"];`
  —— 模型**已经**在状态行里了，但那行在**面板最上面**（`src/host/webviewHtml.ts:59` 的 `#status`
  排在 `#transcript` 之前）。用户报告"看不到"，**正好证明位置不对**。
- 快照里已带 `model: "provider/id"`（`src/pi/controller.ts:413`），思考等级与上下文用量**尚未**传输。

---

## 4. 设计决策（每条都给默认值，评审可逐条否决）

### D1 版式（本次核心）—— 默认采纳

```
┌───────────────────────────────┐
│ #transcript   转录（占满，滚动）│
├───────────────────────────────┤
│ #queue        取回编辑 / 队列   │  ← 已在输入框上方（不动）
│ #status       生成中… / 已中止   │  ← **从面板顶部挪到这里**
│ ┌ #input ───────────────────┐ │
│ │ textarea                  │ │
│ └───────────────────────────┘ │
│ #composer-hint      [追加][中止][发送] │
│ #composer-error               │
│ #meta  模型 • 思考等级 • 42.3%/1M │ ← **新增**（pi 的 footer 位置；本机窗口是 1M）
└───────────────────────────────┘
```

- 顶部不再有任何常驻行 → 转录区**多出约一行高度**。
- `#status` 只在**非空闲**时显示（`空闲` 时隐藏），空闲与否看 `#meta` 行 —— 与 pi 的
  `statusContainer`（空闲时无内容、不占高度）一致。
  **但 S2 验收时明确看过"状态行显示空闲"**，所以这条要评审确认（见 D2）。
- 元信息行**常显**，内容：`<model id> • <等级|thinking off> • <百分比>/<窗口>`，与 pi footer 右侧一致。
  （实测本机开局就是 `deepseek-v4-flash • high • 0.0%/1M`。）

### D2 「空闲」还要不要显示 —— 默认：显示，但放在元信息行

理由：S2 的 M0/M2 人工验收看过 `空闲`，删掉会让人以为"状态没了"。
所以 `#status` 只承担**瞬态**（生成中… / 已中止 / 错误），`#meta` 常驻显示
`<模型> • <等级> • <用量> • <空闲|生成中>`。

> 这条属于"用户可见行为变更"，**请评审重点看**：它与"pi 的空闲不占高度"有细微差异，
> 我选择保留 S2 已验收的语义（显示空闲），把差异放在元信息行里。

### D3 模型切换后的广播 —— 默认：host 主动广播整块 `meta`

因为 pi 没有 `model_changed` 事件，且模型/等级/用量三者总是一起变：
新增 `{type:"meta", meta}` 消息（**整块替换**，不做增量），并在
`tool_execution_end`、`message_end`、快照、`requestState` 之后各刷一次（见 D5）。

### D4 选择器放在**宿主**（QuickPick），不在 webview 里画

理由：①`showQuickPick` 是 VS Code 原生控件，键盘/输入法/无障碍免费；
②模型列表来自宿主侧的 `session`；
③webview 里自绘列表要处理 CSP、焦点、键盘，收益为零。
协议只加两个客户端消息：`{type:"openModelPicker"}` / `{type:"openThinkingPicker"}`。

### D5 元信息的刷新时机 —— 默认：事件驱动，**不轮询**

刷新点：①`message_end`（用量变了）②`tool_execution_end` ③`requestState`/快照
④模型/等级切换后 ⑤会话重建（S5 之前只有①-④）。
理由：上下文用量只在模型回复后变化，轮询纯属浪费电。

### D6 不显示 `(auto)` 与成本

`(auto)` 是 pi 的自动压缩开关状态，属 S6/S7 范围；成本在面板里意义不大（用户关心的是"还能吃多少"）。
元信息行只放：**模型 · 等级 · 用量**。pi footer 里的 `↑↓R W CH` 四项也**不放**
（窄侧边栏放不下，且价值低于"百分比"）。

### D7 模型列表只列 `getAvailable()` 的结果 —— 默认

`getAvailable()` 只返回**已配置凭据**的模型，于是不可能选中一个一点就报错的模型。
`getModels()` 是全目录（含没 key 的 provider），**不用**。
`getAvailable()` 抛错时（凭据文件损坏等）：QuickPick 显示一条说明项 + 引导到 `Pi: Set API Key`。

### D8 思考等级的 QuickPick 内容 —— 默认（**已按探针结果改写**）

- 列 `getAvailableThinkingLevels()` 的结果 **原样**（**允许空洞**：flash 是 `off/low/high/max`，
  v4-pro 是 `off/high/max`）。**不要**自己拼 `off..max` 的连续列表 —— 那会列出模型不支持的等级。
- 每项显示：等级名 + `$(check)` 标记当前项；`off` 一行按 pi 的措辞写作 **`thinking off`**。
- 选中后 `setThinkingLevel(level)`，然后**回读 `session.thinkingLevel`** 再显示
  （探针证明 pi 会静默 clamp，虽然列表里不会出现被 clamp 的值，但回读是零成本的保险）。
- `supportsThinking() === false` 的分支仍然要实现（自定义 provider 可能关掉 reasoning）：
  QuickPick 只显示一项 `该模型不支持思考等级（<model id>）`（`isEnabled: false`），不弹空列表。
  **本机四个模型都不走这条分支** → 它只由自动化断言覆盖（喂一个 `reasoning: false` 的假模型对象）。
- 切换模型后**等级列表会变**（flash 有 `low`、v4-pro 没有）—— 这是 M3 的实测点，也是 D9 的验证方式。

### D9 切换模型时思考等级怎么办 —— 默认：交给 pi

pi 自己有 `_getThinkingLevelForModelSwitch()` + `_clampThinkingLevel()`。
我们**不自己算**，切换后重新读 `session.thinkingLevel` 显示。这与"尽可能 follow pi"一致。

### D10 元信息行可点击 —— 默认：模型段可点开模型选择器，等级段可点开等级选择器

只加这一个交互，不加快捷键（不抢 VS Code 键位）。
命令面板同时提供 `Pi: Select Model` / `Pi: Select Thinking Level` 两个命令（与点击等价）。
**可访问性**：两个段用 `<button class="meta-link">` 而不是 `<span>`+click，
键盘 Tab 能到达、Enter 能触发（`#transcript` 的捕获阶段委托已有一套先例可循）。

### D11 无模型 / 无凭据时的表现 —— 默认

`session.model === undefined`：元信息行显示 `未选择模型（Pi: Select Model）`，
状态行若在生成中则照常显示。
宿主侧 `getAvailable()` 返回空 → QuickPick 只有一条说明项：

```
$(warning) 没有可用模型：请先用 Pi: Set API Key 配置一个 provider
  （本机实测 `openai` 因无有效凭据被 `getAvailable()` 过滤掉 —— 说明这条过滤确实生效；
  也就是说"列表里没有的模型"不是 bug，而是没配 key。）
```

选中该说明项 → 直接执行 `jerrypi.setApiKey` 命令（少一步跳转）。

### D12 协议版本 v2 → v3 —— 默认

- 快照新增 `meta` 字段（必填，`model` 可以是空串）；
- 新增 `{type:"meta", meta}`；
- 新增客户端 `{type:"openModelPicker"}` / `{type:"openThinkingPicker"}`。
- `meta` 形状：`{ model: string; modelName: string; thinkingLevel: string; supportsThinking: boolean; contextUsage: { tokens: number|null; contextWindow: number; percent: number|null } | null }`。
  `model` 为 `"provider/id"`（沿用 S2 快照里的既有写法），`modelName` 是目录里的 `Model.name`（可能更可读）。
- **`contextUsage: null` 的语义 = 未知**（刚压缩后），前端显示 `?/128k`（见 R5）。

### D14 数字格式化照抄 pi 的语义 —— 默认

`formatTokens` 没被导出，所以照抄 pi 的实现（`modes/interactive/components/footer.js`）：

```ts
// 出处：pi-coding-agent/dist/modes/interactive/components/footer.js 的 formatTokens()
// <1000 → "N"；<10k → "N.Nk"；<1M → "NNNk"（取整）；<10M → "N.NM"；否则 → "NNM"（取整）
export function formatTokens(count: number): string
```

放在 `src/shared/format.ts`（新文件），并在 `scripts/tool-text-check.mjs` 或新的
`scripts/format-check.mjs` 里断言**边界值**：999 / 1000 / 9999 / 10000 / 999999 / 1000000 /
9999999 / 10000000（照抄就要照抄到边界，凭印象重写必然差一个 `toFixed`）。
百分比用 `percent.toFixed(1)`（pi footer 的原话），`percent === null` → `?`。

### D13 VS Code 状态栏项 —— 默认：加，但只在有活动会话时显示

`vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)`，
文本 `$(hubot) <model id> · 42%`（未知时 `?`），tooltip 显示完整信息
（provider、等级、窗口、成本），`command = jerrypi.selectModel`。
面板 dispose 时隐藏。

---

## 5. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | **动版式会碰到 S2/S3 已验收的行为**（滚动贴底、队列栏、输入框） | CSS/HTML 只增不减地改；测试台加**结构位置断言**（`#status` 必须在 `#composer` 之前、`#meta` 在 textarea 之后）；Mac 上**重跑 S3 的 M7/M8**（滚动人工项） |
| R2 | QuickPick 抢焦点后 textarea 失焦，用户接着打字打不进去 | 选择器关闭后 `panel.webview.postMessage({type:"focusInput"})` + webview 侧 `input.focus()`；人工 M2 里专门验"选完模型直接打字" |
| R3 | ~~`getAvailable()` 慢~~ **实测 1ms，不需要缓存**（§3.5 第 1 条）。残留风险：网络受限机上 auth 文件在漫游目录时可能变慢 | 若选择器打开明显卡顿，再考虑缓存；**不预先优化** |
| R4 | ~~deepseek 不支持思考~~ **实测四个模型都支持**（§3.5 第 3 条）。真实风险变成：某个模型的等级列表**有空洞**（v4-pro 连 `low` 都没有），自造连续列表会列出不支持的值 | D8：原样使用 `getAvailableThinkingLevels()`；自动化断言覆盖"空洞列表照原样渲染" |
| R5 | `percent`/`tokens` 可能为 `null`（刚压缩后） | 显示 `?`（照 pi）；render-check 断言 `null` 分支渲染的是 `?` 而不是 `NaN%` 或 `null%` |
| R6 | 模型 id / provider 是**外部字符串**（模型目录可能被用户自定义 provider 写脏） | 元信息行按文本转义渲染（沿用 S2 的 XSS 纪律），render-check 加一条"模型名里带 `<img>` 不生成元素" |
| R7 | 上下文百分比 >90% 的红/黄阈值写死会与 pi 不一致 | 阈值取自 pi footer 的 70/90（§3.2），并在 `render.ts` 里写成具名常量 + 注释出处 |
| R8 | 面板顶部状态行消失后，某些"忙/闲"提示（`pendingText` 相关）无处显示 | D2 把空闲/生成中放进元信息行；并保留 `#queue` 的取回编辑入口不变 |
| R9 | 状态栏项在没打开面板的窗口里乱显示 | D13：只在有活动会话时显示；`dispose()` 里 hide |

---

## 6. 自动化检查（先红后绿，遵守退休规则）

**顺序很重要**：先写断言 → 跑 → **看到红** → 再实现 → 看到绿。
（S3 的教训：断言从需求写，不从实现写；红/绿是唯一能证明它不是恒真断言的办法。）

| 脚本 | 新增断言（要点） |
| --- | --- |
| `scripts/protocol-check.mjs` | `PROTOCOL_VERSION === 3`；`meta` 在快照里必填；`contextUsage: null` 合法而 `{tokens:0}` 合法；两个新的客户端消息类型被接受；未知客户端消息仍然被拒 |
| `scripts/render-xss-check.mjs` | 元信息行渲染：模型名 + 等级 + 百分比；`percent: null` → `?`（不是 `NaN%`/`null%`）；`70.1` → warning 类、`90.1` → error 类、`42` → 普通类；**模型名里的 `<img src=x onerror=…>` 不产生元素**；等级为 `off` 且 `supportsThinking` 为 true 时显示 `thinking off`（与 pi 措辞一致） |
| `scripts/webview-dom-check.mjs` | **结构位置**：`#status` 在 `#composer` 之前且在 `#queue` 之后；`#meta` 在 `#input` 之后；点击模型段发出 `openModelPicker`、点击等级段发出 `openThinkingPicker`；收到 `meta` 就地更新（不重建节点、不丢焦点）；`focusInput` 后 `document.activeElement === #input`；空闲时 `#status` 隐藏 |
| `scripts/controller-check.mjs` | 真模型下：`meta` 快照里 `model` 非空、`supportsThinking()` 与 `contextUsage` 形状正确；切到一个不可用的 provider 时 `setModel` 抛错被我们捕获成 notice（不崩） |

**不许写进自动化的**：任何滚动行为（无头 DOM 没有排版引擎，`scrollHeight` 恒 0 —— S3 已栽过一次）。

---

## 7. 人工验收（Mac，一项一步）

| # | 步骤 | 期望 |
| --- | --- | --- |
| M1 | 打开面板看版式 | 顶部**没有**状态行；转录区更靠上；输入框上方有状态行（空闲时隐藏）、下方有 `模型 • 等级 • 用量` |
| M2 | 点元信息行里的模型 → 选一个（如 `deepseek-v4-flash-vision-exp`） | 列表显示 provider/价格/上下文；选中后元信息行立刻更新；**选完直接打字回车能发出去**（R2 焦点） |
| M3 | 点等级段，选 `max`；再切到 `deepseek-v4-pro` 后重开等级段 | ①列表是 `off/low/high/max`（**中间空着**，没有 minimal/medium）；②选 `max` 后元信息行显示 `max`；③切到 v4-pro 后列表变成 `off/high/max` —— **`low` 消失了**（等级列表随模型变） |
| M4 | 发一句话 | 元信息行的百分比**变一次**（用量的确刷新了） |
| M5 | 发一条长回复直到超阈值 | 百分比 >70% 变黄、>90% 变红（若构造不出来，记录为"未覆盖"而不是"通过"） |
| M6 | 看 VS Code 状态栏 | 显示模型 + 百分比；点击打开选择器；关闭面板后消失 |
| M7 | 回归：流式中滚上去、点标题、点路径、中止 | 与 S3 验收时一致（滚动贴底/不贴底、卡片展开、路径可点、中止不丢正文） |
| M8 | 回归：队列（转向/追加/取回编辑） | 状态行位置变了但行为不变：忙时排队、`取回编辑` 能取回 |
| M9 | 重开面板（`Developer: Reload Webviews`） | 元信息行与状态行按快照恢复正确；模型没有变成"未选择模型" |

---

## 8. Windows 验收（W，并入下一次 Windows 轮次）

| # | 步骤 | 期望 |
| --- | --- | --- |
| W0 | `Pi: Run Self-Test` | `GATE PASS`（本步动了协议与 webview，必须自证没破坏受限机路径） |
| W1 | 版式 + 元信息行 | 与 Mac 一致 |
| W2 | 模型选择器 + 切换后能继续对话 | 切换生效（用 `deepseek-v4-flash` → `deepseek-v4-flash-vision-exp`） |
| W3 | 思考等级段 | 明确显示"该模型不支持思考等级" |
| W4 | 状态栏项 + 点击 | 能打开选择器 |

---

## 9. 实施步骤（提交切分）

1. **探针**：实测 `getAvailable()` 耗时；确认 `setModel` 传 `Model` 对象（不是字符串）的用法；
   确认切换后 `session.thinkingLevel` 的实际取值（clamp 行为）。
2. `feat(protocol)`: v3 —— `meta` 快照字段 + `meta` 消息 + 两个选择器请求（**先写断言，看红**）。
3. `feat(controller)`: 组装 `meta`、事件驱动的刷新、切换模型的宿主逻辑、QuickPick 与两个命令、
   状态栏项。
4. `feat(webview)`: 版式改造（`#status` 下移、新增 `#meta`）+ 渲染 + 点击委托 + `focusInput`。
5. `docs`: README 的功能表与已知限制；`docs/S4-plan.md` §11/§12 记录结果。
6. 打包 → 自测 → Mac 人工验收 → Windows。

---

## 10. 评审记录

（待填：外部评审的每一条意见、采纳/否决与理由）

## 11. 实施与验收结果

（待填）
