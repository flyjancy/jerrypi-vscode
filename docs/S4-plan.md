# S4 计划：模型与思考等级（含「模型 + 状态」可见性改造）

> 状态：**第 1 轮评审已吸收**（详见 §10）；第 2 轮只审增量。
> 上游：`docs/PLAN.md` §6 的 S4（G4）；本步新增一条用户要求：**模型与状态要显示在能看到的位置**。

---

## 1. 目标

1. **面板版式**：把「工作状态」从面板最上面挪到**输入框上方**，把「模型 · 思考等级 · 上下文用量」
   放在**输入框下方** —— pi TUI 的纵向顺序（证据见 §3.1）。
2. **模型选择器**：QuickPick 列出可用模型，选中即切换当前会话的模型。
3. **思考等级切换**：QuickPick 列出**该模型支持的**等级（pi 会 clamp），切换后立即生效并显示。
4. **上下文用量**：面板元信息行显示 `0.0%/1.0M`，并加一个 VS Code 状态栏项（G4），点击可开选择器。

**验收判据（G4）**：用户能看见当前用哪个模型、还能吃多少上下文；不离开面板就能换模型与思考等级。

---

## 2. 本步不做的事（明确划界）

| 不做 | 归属 |
| --- | --- |
| 新建/切换/恢复会话的 UI | S5（但 `jerrypi.newSession` **已存在**，`onRebind` 的交互必须在本步处理，见 D15） |
| 把模型写进 pi 的全局设置（pi TUI 里是 Ctrl+S / `app.models.save`） | S6（设置与密钥） |
| diff 审阅卡片 | S7 |
| 工具审批开关 | S8 |
| pi 包管理 | S9 |
| 自定义快捷键 | 不做；命令面板 + 点击元信息行 |
| 自动压缩开关 `(auto)`、成本、`↑↓R W CH` | 不做（pi footer 有，侧边栏放不下；成本进 tooltip） |

---

## 3. 已核实的事实（全部来自类型声明或 pi 源码；评审已逐条核对）

> **出处说明**：`dist/modes/...`、`dist/core/agent-session.js` 这些**只存在于 `node_modules/` 那份**
> （发布包），我们运行期加载的 `pi-runtime/dist/bundle/index.js` 是打包产物、没有模块路径。
> 所以：**读代码看 node_modules，判断"能不能用"看 bundle 的导出面**。
> 评审第 1 轮纠正了我在这里的两处表述错误（见 §10 A2、A3）。

### 3.1 pi TUI 的纵向顺序（版式改造的依据）

`pi-coding-agent/dist/modes/interactive/interactive-mode.js:634-642`（评审把行号修正为 634-642）：

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

即：**队列 + 工作状态在输入框之上，模型/用量在输入框之下**；输入框构造时带
`embedWorkingStatus: true`（同文件 :350-355），说明"状态贴着输入框"是刻意设计。

### 3.2 footer 里显示什么（`components/footer.js` 的 `render()`）

- **左**：`↑输入 ↓输出 R缓存读 W缓存写 CH命中率 $成本 <百分数>%/<窗口>`；窗口未知时用
  `state.model?.contextWindow` 兜底成 `0`。
- **右**：`(provider) <model id> • <等级>`；`reasoning: false` 时**不显示等级**；
  等级为 `off` 时写作 `thinking off`。
- **阈值配色：`> 90` 用 error 色，`> 70` 用 warning 色**（严格大于）。
- **`?` 的真实触发条件（评审纠正）**：`contextUsage?.percent !== null ? value.toFixed(1) : "?"` ——
  只有 **`percent === null`**（压缩后还没有新的 assistant usage）才显示 `?`；
  `getContextUsage()` 返回 **`undefined`** 时走的是 `0.0`。二者是两种不同状态。

### 3.3 S4 需要的 API

| 用途 | API | 备注 |
| --- | --- | --- |
| 当前模型 | `session.model: Model \| undefined` | `Model = {id, name, api, provider, baseUrl, reasoning, thinkingLevelMap?, input, cost, contextWindow, maxTokens}` |
| 当前等级 | `session.thinkingLevel` | `ThinkingLevel = off\|minimal\|low\|medium\|high\|xhigh\|max` |
| 列出可用模型 | `session.modelRuntime.getAvailable(providerId?)` | **有副作用**：无参调用触发一次全量可用性刷新（`queueAvailabilityRefresh` → 每个 provider `checkAuth` + 读凭据），OAuth 上可能走网络 |
| 立即拿快照 | `session.modelRuntime.getAvailableSnapshot()` | **同步、零 I/O** —— QuickPick 先用它立刻弹出，再用 `getAvailable()` 的结果替换 items |
| 切换模型 | `session.setModel(model, {persist?})` | `persist` 默认 false；**async 且会 `checkAuth`**；无凭据抛错 |
| 切换等级 | `session.setThinkingLevel(level, {persist?})` | clamp + 写会话转录 |
| 支持哪些等级 | `session.getAvailableThinkingLevels()` | **`model === undefined` 时返回全部 7 档**（所以必须先 gate `supportsThinking()`） |
| 是否支持思考 | `session.supportsThinking()` | 就是 `!!model?.reasoning`；`reasoning:false` 时等级列表是 **`["off"]`**（不是空数组） |
| 上下文用量 | `session.getContextUsage()` | 正常路径 = `estimateContextTokens(messages)` → **用户消息一进来百分比就变**；`model` 不存在或 `contextWindow <= 0` 时返回 **`undefined`** |
| 等级事件 | `{type:"thinking_level_changed", level}` | 会话事件 ✓ |
| 扩展事件 | `{type:"model_select"}` | 只在**扩展事件**里（`core/extensions/types.d.ts:633`），不是会话事件 → 模型变更仍由我们自己广播 |

**默认思考等级不是固定值**：pi 的 `DEFAULT_THINKING_LEVEL = "medium"`（`core/defaults.js:1`），
我们的机器上 flash 没有 `medium` → clamp 后是 `high`。**所以文档与验收里只写规则、不写 `high`。**
clamp 的方向是**先向上、再向下**取最近可用档（`pi-ai/dist/models.js:562-580`）。

### 3.4 「模型」现在在面板上的位置

`src/webview/main.ts:198` 的 `[model, busy ? "生成中…" : "空闲"]` 就在 `#status`，
而 `#status` 在 `#transcript` **之前**（`src/host/webviewHtml.ts:59`）→ 用户报告"看不到"，证明位置不对。
快照里已带 `model: "provider/id"`（`src/pi/controller.ts:413`），等级与用量尚未传输。

### 3.5 探针实测（2026-09-13，本机 `~/.pi/agent`）

```
ModelRuntime.create() = 7ms；getAvailable() = 1ms；共 4 个模型
  · deepseek/deepseek-v4-flash            reasoning=true  ctx=1M  $2/$8   输入=text
  · deepseek/deepseek-v4-flash-vision-exp reasoning=true  ctx=1M  $2/$8   输入=text+image
  · deepseek/deepseek-v4-pro              reasoning=true  ctx=1M  $9/$27  输入=text
  · deepseek/deepseek-flash               reasoning=true  ctx=1M  $2/$8   输入=text+image
```

1. `getAvailable()` **1 毫秒**（但这台机器只有 API key、没有 OAuth provider，见 §3.3 的副作用说明）。
2. `openai` 不在列表里 → `getAvailable()` 按**有效凭据**过滤 ✓。
3. 四个模型的 `reasoning` 全是 `true`（我原先猜"deepseek 不支持思考"，**错了**）。
   真实等级列表（**有空洞**，由 `thinkingLevelMap` 的 `null` 决定）：

   | 模型 | 等级列表 |
   | --- | --- |
   | `deepseek-v4-flash` | `["off","low","high","max"]` |
   | `deepseek-v4-flash-vision-exp` | `["off","low","high","max"]` |
   | `deepseek-v4-pro` | `["off","high","max"]`（连 `low` 都没有） |

4. `setThinkingLevel()` **静默 clamp**：`medium→high`、`minimal→low`、`xhigh→max` → **必须回读生效值**。
5. `getContextUsage()` 开局是 `{tokens: 0, contextWindow: 1000000, percent: 0}`。
   **显示串是 `0.0%/1.0M`**（评审纠正：`formatTokens(1e6)` 落进 `<1e7` 分支得 `1.0M`）。
6. 价格单位 = **USD / 1M tokens**（`pi-ai/dist/models.js:543-544`）。
7. `formatTokens` 不可用的**真实原因**（评审纠正）：它在 `footer.js` 里**是导出的**，
   但①我们运行期只加载 `pi-runtime/dist/bundle/index.js`，bundle 的导出面里没有它；
   ②包的 `exports` map 不允许深导入 `dist/modes/...`。→ 照抄语义，见 D14。

---

## 4. 设计决策（第 1 轮评审后的版本）

### D1 版式 —— 采纳（其中半条被否决后修订）

```
┌───────────────────────────────┐
│ #transcript   转录（占满，滚动）│
├───────────────────────────────┤
│ #queue        取回编辑 / 队列   │  ← 不动
│ #status       生成中… / 已中止   │  ← 从面板顶部挪到这里；**常驻占一行高度**
│ ┌ #input ───────────────────┐ │
│ │ textarea                  │ │
│ └───────────────────────────┘ │
│ #composer-hint      [追加][中止][发送] │
│ #composer-error               │
│ #meta  模型 • 等级 • 42.3%/1.0M │ ← 新增（pi footer 位置）
└───────────────────────────────┘
```

**评审否决了"空闲时隐藏状态行"这半条**（我原以为能多出一行高度）：在 VS Code 里
composer 是底部锚定的，状态行每轮出现/消失会让**输入框上下跳一行**。
改成：`#status` **常驻、保留一行高度，空闲时内容为空**（`aria-live` 留在这一行）。
收益（多一行）归零，但换来不抖动 —— 采纳。

### D2 「空闲」字样 —— **否决**（评审意见，采纳其否决）

原打算把"空闲"放进元信息行。评审三条理由，我全部认同：

1. 窄栏里那行要塞最长 28 字的 `deepseek-v4-flash-vision-exp` + 等级 + 百分比，
   **"空闲"是第一个该砍的**；
2. 会造出 **busy 的第二个真相来源**（`busy` 消息与 `meta` 消息各带一份，到达顺序不同就打架）
   —— S2 已经踩过一次 `lastBusy` 的坑（`controller.ts` 那段注释）；
3. 忙/闲已有两个可见信号：中止/追加按钮出现、`composer-hint` 文案。
   "S2 验收时看过空闲"是**实现的历史，不是需求**。

→ **全项目不再出现"空闲"这个词**（与 pi 一致）。

### D3 广播 —— 采纳 + 评审补充

新增 `{type:"meta", meta}`（**整块替换**）；pi 没有可靠的模型变更事件，只能我们自己广播。
评审补充两条：
- **幂等 + host 侧去重**（与 `busy` 同样的 `lastX` 机制）；
- **快照之后必须清掉 `lastMeta`** —— 否则重开面板时第一条相同的 meta 会被当重复吞掉，
  正是 `lastBusy = undefined` 那段注释写的同一个坑。
- 模型/等级/用量三者总是一起变 → 不做增量。

### D4 选择器放宿主（QuickPick）—— 采纳

`showQuickPick` 是原生控件，键盘/输入法/无障碍免费；模型列表在宿主侧；自绘毫无收益。
协议只加 `{type:"openModelPicker"}` / `{type:"openThinkingPicker"}`。

### D5 刷新时机 —— 采纳 + 评审补齐四个漏点

刷新点：①`message_end`②`tool_execution_end`③`requestState`/快照④切换模型/等级后
⑤ **`compaction_start` / `compaction_end`**（压缩后 percent 变 `null` → 不刷就一直是旧数字，
pi 的 `?` 就是为这个）⑥ **会话重建**（`newSession` 已存在，`onRebind` 可能换模型）
⑦ **用户消息落地**（`getContextUsage()` = `estimateContextTokens(messages)`，用户消息一进就变）
⑧ `agent_settled` 兜底对账。

`message_end` 每条消息都来（含工具结果）→ **与 busy 一样做去重**，否则每轮多刷十几次。

### D6 不放 `(auto)`、成本、`↑↓R W CH` —— 采纳

成本与窗口放 D13 的 tooltip。元信息行只放 **模型 · 等级 · 用量**。

### D7 模型列表 —— 采纳 + 评审修正前提

只用 `getAvailable()`（它按有效凭据过滤，不可能选中一个一点就报错的模型）。
评审修正：**无参调用 `getAvailable()` 会触发全量可用性刷新**（每个 provider `checkAuth` + 读凭据），
1ms 只是我这台机器（纯 API key）的结果。做法改为：

1. `getAvailableSnapshot()` **同步**拿列表 → QuickPick **立刻**弹出（零 I/O）；
2. 同时发起 `getAvailable()`，回来后**替换 items**（`busy: true` 的加载态）。

`getModels()`（全目录，含没 key 的 provider）**不用**。

### D8 等级 QuickPick —— 采纳 + 评审修正前提

- **先 gate `supportsThinking()`**：`model === undefined` 时它也是 `false`，但
  `getAvailableThinkingLevels()` 会返回**全部 7 档** —— 不 gate 就会列出 7 个假等级。
- gate 通过后**原样**列 `getAvailableThinkingLevels()`（**允许空洞**：flash 有 `low`、v4-pro 没有）。
- `off` 一行按 pi 的措辞写作 `thinking off`。
- 选中后 `setThinkingLevel(level)` → **回读 `session.thinkingLevel`** 再显示。
- `supportsThinking() === false` 的分支：**用"没有模型的真会话"覆盖**（比喂假模型真实），
  评审指出这是真实可达状态。
- `reasoning:false`（自定义 provider）时列表是 `["off"]`，渲染逻辑要能吃下。

### D9 切换模型时的等级 —— 采纳

交给 pi 的 `_getThinkingLevelForModelSwitch()` + `_clampThinkingLevel()`（先上后下取最近档）；
我们**不自己算**，切换后重新读。

### D10 元信息行的交互 —— 采纳 + 评审补充

- 模型段点开模型选择器，等级段点开等级选择器；命令面板提供等价命令。
- **`#meta` 不在 `#transcript` 里，现有捕获委托覆盖不到 → 新挂一处**（评审指出）。
- 用 `<button>` 而非 `<span>`+click；`aria-label` 给**全句**
  （"当前模型 deepseek-v4-flash，点击切换"），否则读屏软件念一串 id。
- **焦点规则（评审给的，比原计划细）**：
  1. **只有从面板发起时才回 `focusInput`**；从命令面板发起时不回（那时用户焦点可能在编辑器）；
  2. **QuickPick 的两条退出路径（选中 / Esc 取消）都要回** —— 只写在 `if (picked)` 里，
     会导致"按 Esc 取消后光标没了"；
  3. webview 侧 `input.focus()` **不需要**判断 `document.hasFocus()`（iframe 无焦点时只设置
     文档内 activeElement，拿回焦点时正好落在输入框）；
  4. **禁止**用 `webviewView.show()` / `jerrypi.focusChat` 来"确保焦点" —— 那才是真会抢用户焦点的写法。

### D11 无模型 / 无凭据 —— 采纳 + 评审纠错

- `session.model === undefined`：元信息行显示 `未选择模型（Pi: Select Model）`。
- 宿主侧 `getAvailable()` 为空 → QuickPick 只有一条说明项
  `$(warning) 没有可用模型：请先用 Pi: Set API Key 配置一个 provider`，选中即执行 `jerrypi.setApiKey`。
- **评审纠正**：VS Code 的 `QuickPickItem` **没有 `isEnabled` 字段**（只有
  label/kind/description/detail/iconPath/picked/alwaysShow/buttons）→ 原计划那句删掉。

### D12 协议 v2 → v3 —— 采纳 + 评审改形状

- 快照新增 `meta`（必填）；新增 `{type:"meta", meta}`；新增两个客户端消息。
- 形状（评审改）：

```ts
{
  model: string;            // "provider/id"（沿用快照既有写法）
  provider: string;         // 供 tooltip 用；行内只渲染 id
  modelName: string;        // 目录里的 Model.name
  thinkingLevel: string;
  supportsThinking: boolean;
  contextWindow: number;    // **顶层必填**，来自 model.contextWindow（usage 未知时也用它兜底）
  contextUsage: { tokens: number | null; percent: number | null } | null;
}
```

理由：原来把 `contextWindow` 塞进 `contextUsage`，一旦 usage 是 `null`，前端连窗口都不知道，
只能渲染 `?/?` 而pi 在这种情况渲染的是 `?/1.0M`。
**协议注释里必须把两种状态分开写**：
（a）`contextUsage === null` = 根本没有用量信息（无模型 / 窗口 ≤ 0）；
（b）`contextUsage.percent === null` = 刚压缩、等下一次回复（→ 显示 `?`）。

### D13 VS Code 状态栏项 —— 采纳 + 评审补充

`createStatusBarItem(Right, 100)`，文本 `$(hubot) <model id> · 42.3%`，tooltip 带
provider/等级/窗口/成本，`command = jerrypi.selectModel`，面板 dispose 时隐藏。
评审补充：
- **只在 controller 已 ensure 之后创建**，**不要为了显示它而提前建会话**（否则 VS Code 启动
  就会加载 pi 运行时）；
- **它现在没法自动断言** —— 仓库里没有任何 fake-`vscode` 桩（controller-check 把 `vscode`
  设为 external 且刻意不碰这条路径）→ 见 §9 第 2 步：**桩作为独立提交做出来**。

### D14 数字格式化 —— 采纳 + 边界修正

照抄 pi 的 `formatTokens`（`components/footer.js`）放进 `src/shared/format.ts`：

```
<1000 → "N"；<10k → "N.Nk"；<1M → "NNNk"（取整）；<10M → "N.NM"；否则 → "NNM"（取整）
```

**边界表（评审修正两个值）**：`999 → "999"`、`1000 → "1.0k"`、`9999 → "10.0k"`、
`10000 → "10k"`、`999999 → "1000k"`（**不是 `1M`**）、`1000000 → "1.0M"`、
`9999999 → "10.0M"`、`10000000 → "10M"`。

百分比：`percent.toFixed(1)`；`percent === null` → `?`。
**断言并进 `tool-text-check.mjs`**（self-test 已挂它；新建脚本容易忘挂 → CI 根本不跑）。

### D15 【新增，待第 2 轮评审】面板选的模型要跨 `newSession` 记住吗

问题来源（评审 R14）：面板里选的模型是 `persist: false`（只改本次会话），
而 `jerrypi.newSession` → `onRebind` → `alignPanelModel` 会在"用户从没在 pi 里设过默认"的机器上
**把它改回我们的偏好（flash）** —— 用户会觉得"我选的模型被吞了"。

三个选项：

| 选项 | 说明 |
| --- | --- |
| **A（我倾向）** | 参数 `rememberPanelModel`：进程内记住用户在面板里选过的模型，`onRebind` 优先用它；**不写 pi 设置**（设置是 S6 的事）。用户在 pi 那边改了默认模型时，以 pi 的为准 |
| B | 面板切模型时也 `persist: true`（等于替用户改全局默认）—— 与"不覆盖用户选择"的既有纪律冲突 |
| C | 什么都不做，只在 README 已知限制里写明"新建会话后模型回到默认" |

## 5. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | 动版式碰到 S2/S3 已验收行为 | 测试台加**结构位置断言**；Mac 动作②重跑滚动/中止 |
| R2 | QuickPick 抢焦点 | D10 的四条焦点规则（含"Esc 也要回焦点"） |
| R3 | `getAvailable()` 慢 | 实测 1ms，但仍按 D7 用 snapshot 立即弹窗 + 异步替换 |
| R4 | 等级列表有空洞 | D8 原样使用 `getAvailableThinkingLevels()`，断言覆盖空洞 |
| R5 | `percent` 为 `null` 或被压缩 | 显示 `?`；断言 `null` 分支不产生 `NaN%`/`null%` |
| R6 | 模型 id/provider 是外部字符串 | 按文本转义；断言模型名里带 `<img>` 不生成元素 |
| R7 | 阈值与 pi 不一致 | 70/90（严格大于），具名常量 + 出处注释；断言 70 与 90 本身是普通/warning |
| R8 | 顶部状态行消失后忙/闲提示无处放 | D1/D2：常驻空行 + 按钮/hint 已足够 |
| R9 | 状态栏项在无面板窗口乱显示 | D13：只在有活动会话时显示，dispose 时 hide |
| **R10** | **`renderStatus()` 结尾有一句无条件 `scrollToBottom()`（`main.ts:209`）** —— meta 刷新频率一上来，正在往上翻历史的用户会被**反复拽回底部** | meta/busy 路径一律走 `scrollIfFollowing()` 或干脆不滚；**加一条断言：收到 `meta` 不得写 `transcript.scrollTop`**（给 `#transcript.scrollTop` 装 setter 探针，测"有没有调用"而不是"滚到哪"） |
| **R11** | 窄栏溢出 | 模型名 `min-width:0; overflow:hidden; text-overflow:ellipsis`；**等级与百分比 `flex:none` 永不被挤掉**（它们是本次改造的目的） |
| **R12** | `setModel` 是 async + `checkAuth`，关闭选择器到生效之间有窗口 | await 完成再广播 meta；**生成中切模型不影响本轮**（pi 只改 `state.model`）→ 写进 README 已知限制 |
| **R13** | `meta` 与 `busy` 的到达顺序竞态 | 只要 D2 被否决就不存在（评审指出这本身就是否决 D2 的理由之一） |
| **R14** | `alignPanelModel` 在 `onRebind` 里覆盖用户的面板选择 | 见 D15 |

---

## 6. 自动化检查（先红后绿；评审逐条纠正过）

| 脚本 | 断言（要点） |
| --- | --- |
| `scripts/tool-text-check.mjs` | **`formatTokens` 的 8 个边界值**（D14 表）+ `percent` 格式化（含 `null → "?"`） |
| `scripts/render-xss-check.mjs` | 元信息行渲染：模型名 + 等级 + 百分比；`percent: null` → `?`（不是 `NaN%`）；**70 与 90 本身**（普通 / warning）、`70.1`（warning）、`90.1`（error）、`percent: null` **不着色**（pi 用 `percent ?? 0`）；模型名里的 `<img …>` 不产生元素；`off` 且支持思考时显示 `thinking off` |
| `scripts/webview-dom-check.mjs` | **结构位置**：`#status` 在 `#composer` 之前且在 `#queue` 之后；`#meta` 在 `#input` 之后；**空闲时 `#status` 文本为空且整份 DOM 不含"空闲"**；点模型段/等级段发出对应请求；收到 `meta` 就地更新（不重建节点）；**收到 `meta` 不得写 `transcript.scrollTop`（setter 探针，锁死 R10）**；`focusInput` 后 `activeElement === #input`（**注释里写明它不覆盖 R2 的真焦点**） |
| `scripts/host-check.mjs`（**新脚本，配 fake-`vscode` 桩**） | ①`chatView.handleMessage` 接受两个新消息、拒绝未知消息（**这里才有真正的运行期校验**）；②QuickPick：交给 `showQuickPick` 的 items 顺序/内容 == `getAvailableSnapshot()`、当前项被 `picked` 标记；③选第 N 项时 `setModel` 收到的是**那个 Model 对象**（不是字符串、不是 `provider/id`）；④`setModel` 抛错 → 变成 notice 且无 unhandled rejection；⑤状态栏项：文本/tooltip/`command`/show-hide 时机 |
| `scripts/controller-check.mjs` | 快照里 `meta` 必填且形状正确（含 `contextWindow` 顶层）；一轮对话后 `percent` 变大；无模型会话里 `supportsThinking()===false` 而 `getAvailableThinkingLevels()` 有 7 档（D8 的 gate） |

**删掉的**（评审指出是恒真或无意义）：
- ~~`PROTOCOL_VERSION === 3`~~ —— 两端 import 同一个常量，断言它等于 3 只是把数字抄两遍；
- ~~"两个新客户端消息被接受"放 protocol-check~~ —— `protocol.ts` 只有类型，运行期没有校验器，
  真正的接受/拒绝在 `chatView.handleMessage`（import vscode）→ 挪进 `host-check`。

**不许写进自动化的**：任何**滚动结果**（无头 DOM 无排版引擎，`scrollHeight` 恒 0）。
注意区别：R10 那条断言测的是"**有没有调用** scrollTop"，允许。

---

## 7. 人工验收 —— Mac（**用户只做 2 个动作**）

**标记规则**：每条标 `【自动】`/`【人工】`；`【人工】` 只允许属于四类 ——
①排版/外观（无头 DOM 没有排版引擎）②真焦点/真键盘 ③真进程 ④Windows 路径与 shell 形态。

| 项 | 谁来覆盖 | 归属 |
| --- | --- | --- |
| 版式的**位置关系** | 测试台结构断言 | 【自动】 |
| 版式在**真侧边栏**里的样子（挤压/换行/抖动） | 无头 DOM 测不了 | 【人工】动作 ① |
| 点模型段/等级段发出请求 | 测试台断言 | 【自动】 |
| QuickPick 弹出、选中后真的切了模型 | `host-check`（桩）+ `controller-check`（真会话） | 【自动】 |
| 选完能**直接打字** | 真焦点 | 【人工】动作 ① 后半 |
| 等级列表带空洞、随模型变 | 渲染断言 + §3.5 探针实测 | 【自动】 |
| 一轮后百分比变化 | `controller-check` | 【自动】 |
| `>70%` 变黄 / `>90%` 变红 | **纯函数，四个值断言（70/70.1/90/90.1）** | 【自动】（评审：不该记成"未覆盖"） |
| 状态栏项创建/更新/隐藏 | `host-check`（桩） | 【自动】 |
| **滚动**：贴底跟随 / 向上滚不被拽回 | 无头 DOM 无排版引擎 —— S3 栽过 | 【人工】动作 ② |
| 队列行为 | 测试台断言 | 【自动】 |
| 重开面板后状态恢复 | 快照断言（S2 已验收同类） | 【自动】 |

### 你要做的 2 个动作

**① 先把模型切到 `deepseek-v4-flash-vision-exp`（最长的 id），再截图**：

- 顶部**没有**状态行；**输入框上方**是状态行（空闲时**内容为空但占位不跳**）
- **输入框下方**：`deepseek-v4-flash-vision-exp • <pi clamp 后的等级> • 0.0%/1.0M`
  （等级是 pi 决定的值，**不写死 `high`**）
- **长 id 不换行**、**等级与百分比没有被挤掉**、按钮行不换行
- 切模型时状态行出现/消失，**输入框不上下跳**
- 点模型段 → QuickPick 弹出 → 选一个 → **紧接着打字能打进去**（含按 Esc 取消后再打字）

**② 发一条长回复，流式中滚上去，再点「中止」**：

- **meta 每次刷新都不把视图拽回底部**（R10 的真机验证）
- 回到底部后继续跟随
- 中止后：卡片变 `✗`、已流出的行还在、状态行回到空

## 8. 人工验收 —— Windows（**3 项**，评审砍掉了 2 项）

| # | 步骤 | 期望 | 标记 |
| --- | --- | --- | --- |
| W0 | `Pi: Run Self-Test` | `GATE PASS`（动了协议与 webview，必须自证没破坏受限机路径） | 【人工】真进程 |
| W1 | 版式 + 元信息行 + 状态栏项（截图；顺手重开一次 webview 看是否仍显示正确模型） | 与 Mac 一致；状态栏项能点击开选择器 | 【人工】目标机外观 |
| W2 | 切模型后继续对话 + 选完直接打字 | 切换生效 | 【人工】真进程 + 真焦点 |

**评审砍掉的**：W3（等级列表随模型变 —— 没有任何 Windows 独有性，Mac 探针 + 渲染断言已覆盖）、
W4（"重开后模型正确" —— 由 `snapshot()` 带 meta 的断言覆盖，真机上顺手看一眼即可，不值一个独立步骤）。

---

## 9. 实施步骤（提交切分）

1. **探针补充**（已做，见 §3.5；第 2 轮若有新问题再补）。
2. **`test: add a fake-vscode stub and host-check`** —— 桩 + 新脚本 + 挂进 `self-test`；
   **先写断言、看红**（此时功能还没实现）。
3. **`feat(protocol): v3`** —— `meta`（D12 形状）+ `meta` 消息 + 两个客户端消息。
4. **`feat(controller)`** —— 组装/去重/`lastMeta` 清理、D5 的八个刷新点、D7 的 snapshot→替换、
   QuickPick 与两个命令、D13 状态栏项、D15 的选择（若采纳 A）。
5. **`feat(webview)`** —— 版式改造 + `#meta` 渲染 + 新挂委托 + `focusInput` + D1 的常驻空行 +
   R11 的溢出规则 + R10 的滚动修正。
6. **`docs`** —— README（功能表、已知限制：生成中切模型不影响本轮 / D15 的选择）、本文件 §11/§12。
7. 打包 → 自测 → Mac 2 个动作 → 发 0.1.6 → Windows W0–W2。

---

## 10. 评审记录

### 第 1 轮（Claude，2026-09-13，8768 字；会话 `9401a29f-…`）

**A. 事实核对 —— 4 条纠正，全部采纳**

| # | 评审意见 | 处置 |
| --- | --- | --- |
| A1 | `1M` 应为 **`1.0M`**（`formatTokens(1e6)` 落 `<1e7` 分支）；顺带 `999999 → "1000k"` | **采纳**，5 处文字改掉，边界表加这两个值（D14） |
| A2 | "会话默认等级是 `high`"**不是 pi 的默认**（`DEFAULT_THINKING_LEVEL = "medium"`，flash 没有 medium → clamp 到 high）→ 文档与验收**只写规则不写值** | **采纳**（§3.3、§7） |
| A3 | §3.5 第 7 条**理由写错**：`formatTokens` 其实有导出，不可用的真因是"只加载 bundle 导出面"+"`exports` map 不允许深导入" | **采纳**（§3.5.7） |
| A4 | `?` 的触发条件更窄：只有 `percent === null`；`getContextUsage()` 返回 `undefined` 时 pi 显示 `0.0` | **采纳**（§3.2 末、D12 两种状态分开写） |

**B. 计划里漏掉、但影响 D5/D8 的新事实 —— 全部采纳**

- `getContextUsage()` 正常路径是 `estimateContextTokens(messages)` → **用户消息一进来百分比就变**（→ D5 加刷新点）。
- `getAvailableThinkingLevels()` 在 `model === undefined` 时返回**全部 7 档**；`reasoning:false` 时是 `["off"]`（→ D8 必须先 gate）。

**C. D1–D14 逐条 —— 采纳 13 条（含 6 条修正），否决 1 条**

| 决策 | 评审 | 我的处置 |
| --- | --- | --- |
| D1 版式 | 位置对；**"空闲时隐藏"改为"常驻保留高度、内容为空"**（否则输入框跳一行） | **采纳** |
| D2 把"空闲"放进元信息行 | **否决**（空间 / busy 双真相来源 / 已有两个可见信号） | **采纳其否决**，全项目不再出现"空闲" |
| D3 广播 | 加上"幂等 + host 去重 + 快照后清 `lastMeta`" | **采纳** |
| D5 刷新时机 | 补 4 个漏点（压缩、会话重建、用户消息、`agent_settled`）+ 去重 | **采纳** |
| D7 模型列表 | `getAvailable()` 无参调用**有全量刷新副作用** → 用 `getAvailableSnapshot()` 先弹窗再替换 | **采纳** |
| D8 等级列表 | 必须先 gate `supportsThinking()`（无模型时有 7 档假数据）；`reasoning:false` 是 `["off"]` 不是空 | **采纳** |
| D9 clamp | 方向是**先上后下**取最近档 | **采纳**（写进 §3.3） |
| D10 交互 | `#meta` 在 `#transcript` 外需新挂委托；`aria-label` 给全句；**焦点四条规则**（含"Esc 也要回焦点"） | **采纳** |
| D11 说明项 | `QuickPickItem` **没有 `isEnabled`** 字段 | **采纳**（删掉那句） |
| D12 协议形状 | `contextWindow` 提到顶层必填 + 加 `provider`；两种 null 状态分开注释 | **采纳** |
| D13 状态栏项 | 现在**没法自动断言**（无 fake-vscode 桩）→ 桩独立成步；且**不要为了显示它提前建会话** | **采纳**（§9 第 2 步） |
| D14 格式化 | 两个边界值改掉；脚本并进 `tool-text-check`（新脚本容易忘挂 self-test） | **采纳** |

**D. 风险 —— 新增 5 条，全部采纳（R10 是本次最有价值的一条）**

- **R10**：`renderStatus()` 结尾**无条件 `scrollToBottom()`**（`main.ts:209`）—— meta 刷新一频繁，
  翻历史的用户会被反复拽回底部。**这是"重跑 M7/M8"背后的具体机制**，我原来只写了"重跑"没写要改。
- R11 窄栏溢出优先级（模型名可省略、等级与百分比 `flex:none`）。
- R12 `setModel` 是 async + `checkAuth`；生成中切模型**不影响本轮** → 写进已知限制。
- R13 `meta`/`busy` 到达顺序竞态（D2 被否决后消失）。
- R14 `onRebind` → `alignPanelModel` 可能吞掉用户的面板选择 → **D15（待第 2 轮）**。

**E. 断言审查 —— 5 条无效/需挪位，全部采纳**

删 `PROTOCOL_VERSION === 3`（恒真）；"消息接受/拒绝"挪进 `host-check`（protocol-check 里做不到）；
"快照 meta 必填"挪进 controller-check；阈值断言补 **70 与 90 本身**和 `percent: null` **不着色**；
`focusInput` 断言要注明**它不覆盖 R2**。

**F. 新增一条能顶掉人工的断言**：**"收到 `meta` 不得写 `transcript.scrollTop`"**
（setter 探针）—— 测"有没有调用"而非"滚到哪"，**不违反"不测滚动"的红线**，正好锁死 R10。**采纳**。

**G. §7/§8 验收 —— 采纳其压缩方案（Mac 2 个动作不变，Windows 5 → 3）**

动作①改为**先切到最长 id 再截图**（那才测得到溢出）；动作②补"meta 刷新不把视图拽回底部"；
`>70/>90` 从"未覆盖"挪进【自动】；Windows 删 W3、W4 并入 W1。

**H. 我没底的两处 —— 评审给了结论，均采纳**

- **D1/D2**：跟 pi 走（没有"空闲"字样），但**不跟它的"零高度"**（终端里布局底部锚定，
  侧边栏里输入框才是锚）→ 常驻空行。
- **R2 焦点**：只在面板发起时回 `focusInput`；**两条退出路径都要回**；不需要 `document.hasFocus()`；
  **禁止**用 `show()`/`focusChat` 抢焦点。

**I. 待第 2 轮的问题**：**D15**（面板选的模型要不要跨 `newSession` 记住）。

---

## 11. 实施与验收结果

（待填）
