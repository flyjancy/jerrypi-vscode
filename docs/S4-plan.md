# S4 计划：模型与思考等级（含「模型 + 状态」可见性改造）

> 状态：**三轮评审已完成并全部吸收**（第 1 轮事实/决策、第 2 轮设计、第 3 轮转写核对，详见 §10）。
> 下一步是等用户确认默认值，然后按 §9 实施。
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
- **`?` 的完整串是 `?/1.0M`，没有 `%` 号**（`contextPercent === "?" ? \`?/${formatTokens(window)}\` : \`${p}%/${…}\`` 是两个分支）——
  不写死就会被实现成 `?%/1.0M`。
- **`?` 的真实触发条件（评审纠正）**：`contextUsage?.percent !== null ? value.toFixed(1) : "?"` ——
  只有 **`percent === null`**（压缩后还没有新的 assistant usage）才显示 `?`；
  `getContextUsage()` 返回 **`undefined`** 时走的是 `0.0`。二者是两种不同状态。

### 3.3 S4 需要的 API

| 用途 | API | 备注 |
| --- | --- | --- |
| 当前模型 | `session.model: Model \| undefined` | `Model = {id, name, api, provider, baseUrl, reasoning, thinkingLevelMap?, input, cost, contextWindow, maxTokens}` |
| 当前等级 | `session.thinkingLevel` | `ThinkingLevel = off\|minimal\|low\|medium\|high\|xhigh\|max` |
| 列出可用模型 | `session.modelRuntime.getAvailable(providerId?)` | **有副作用**：无参调用触发一次全量可用性刷新（`queueAvailabilityRefresh` → 每个 provider `checkAuth` + 读凭据），OAuth 上可能走网络 |
| 立即拿快照 | `session.modelRuntime.getAvailableSnapshot()` | **同步、零 I/O**；**本步不用**（`showQuickPick` 弹出后改不了 items，见 D7）—— 留作真机明显卡顿时升级 `createQuickPick` 的备选 |
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

### D7 模型列表 —— 第 1 轮修正前提、第 2 轮改做法

只用 `getAvailable()`（它按有效凭据过滤，不可能选中一个一点就报错的模型）。
评审第 1 轮指出：**无参调用 `getAvailable()` 会触发全量可用性刷新**
（每个 provider `checkAuth` + 读凭据），1ms 只是我这台机器（纯 API key）的结果。

我原来打算用 `getAvailableSnapshot()`（同步、零 I/O）先弹窗、再用异步结果替换 items ——
**评审第 2 轮指出这条自相矛盾**：`showQuickPick` 弹出后**改不了 items、也设不了 `busy`**，
要那样做必须换 `window.createQuickPick()`，桩的面积翻倍，而且 `onDidHide`/`onDidAccept`
的先后顺序自己就容易写错。

**结论（采纳）：传一个映射后的 Thenable**（第 3 轮核对：`showQuickPick` 只接受
`string[]` 或**带 `label` 的** `QuickPickItem[]` 的数组/Thenable，**`Model[]` 两者都不是**；
而且裸传空数组会让 VS Code 显示"无匹配项"，D11 的说明项没地方插）：

```ts
showQuickPick(
  modelRuntime.getAvailable().then((models) =>
    models.length > 0 ? models.map(toQuickPickItem) : [SET_API_KEY_ITEM],
  ),
)
```
VS Code **原生支持传 Thenable**，等待期间自带加载态（无需 `busy` 字段）。一行拿到全部效果；
放弃的只是"先显示旧快照"，而在 1ms 的机器上没人看得见，
在 OAuth 慢机上显示一份**可能已失效的**旧列表反而更糟。
真机上真出现明显卡顿，再升级到 `createQuickPick`（记在 §11 已知限制里）。

`getModels()`（全目录，含没 key 的 provider）**不用**；`getAvailableSnapshot()` 也不用。

### D8 等级 QuickPick —— 采纳 + 评审修正前提

- **先 gate `supportsThinking()`**：`model === undefined` 时它也是 `false`，但
  `getAvailableThinkingLevels()` 会返回**全部 7 档** —— 不 gate 就会列出 7 个假等级。
- gate 通过后**原样**列 `getAvailableThinkingLevels()`（**允许空洞**：flash 有 `low`、v4-pro 没有）。
- `off` 一行按 pi 的措辞写作 `thinking off`。
- **当前档位要标出来**（第 3 轮核对发现我改写时把这条丢了）：与模型选择器同一种写法 ——
  **`$(check)` 前缀或 `description: "当前"`**（不是 `picked`，见 §6 B1）。
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
**无模型时 `contextWindow` 是 `0`** → 那种情况走 D11 的"未选择模型"文案，
**不渲染 `?/0`**（§6 有一条 `contextWindow: 0` 的渲染断言）。

**协议注释里必须把两种状态分开写**：
（a）`contextUsage === null` = 根本没有用量信息（无模型 / 窗口 ≤ 0）；
（b）`contextUsage.percent === null` = 刚压缩、等下一次回复（→ 显示 `?`）。

### D13 VS Code 状态栏项 —— 采纳 + 评审补充

`createStatusBarItem(Right, 100)`，文本 `$(hubot) <model id> · 42.3%`，tooltip 带
provider/等级/窗口/成本（**价格要标单位 `$X / 1M tokens`** —— §3.5 第 6 条核实过的口径，
否则 tooltip 里一个裸 `$2` 没人知道是什么），`command = jerrypi.selectModel`，面板 dispose 时隐藏。
评审补充：
- **只在 controller 已 ensure 之后创建**，**不要为了显示它而提前建会话**（否则 VS Code 启动
  就会加载 pi 运行时）；
- **它现在没法自动断言** —— 仓库里没有任何 fake-`vscode` 桩（controller-check 把 `vscode`
  设为 external 且刻意不碰这条路径）→ 见 §9 **第 3 步**：**桩作为独立提交做出来**。

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

### D15 面板选的模型要跨 `newSession` 记住 —— **定案 A（评审第 2 轮）**

问题来源（评审 R14）：面板里选的模型是 `persist: false`（只改本次会话），
而 `jerrypi.newSession` → `onRebind` → `alignPanelModel` 会在"用户从没在 pi 里设过默认"的机器上
**把它改回我们的偏好（flash）** —— 用户会觉得"我选的模型被吞了"。

**评审否决了 B（`persist: true`，替用户改全局默认 —— 与既有纪律冲突）、
C（只写已知限制 —— 把十行的修复包装成文档）、以及我没想到的 D
（newSession 时干脆不跑 `alignPanelModel` —— 那会把受限机上"`openai/gpt-5.5` 卡死"那条路
重新打开，而 `alignPanelModel` 存在的唯一理由就是挡它）。定案 A，并补三条：**

1. **优先级写死，面板选择赢**。`onRebind` 顺序：
   ① 本进程记过面板选择 → 用它；② 否则 pi 设置里有默认 → 不动（pi 已自己应用）；
   ③ 否则 → `pickModel` 兜底。
   规则一句话说得清：**"你在面板里选过模型，本窗口就一直用它，直到你再换或重开窗口。"**
   （我原来写的"用户在 pi 那边改了就以 pi 的为准"会让规则变成"看谁后改"，无法解释也无法断言。）
2. **记住的模型在 `onRebind` 时要重新校验**：凭据可能在两次会话之间失效，
   `setModel` 会 throw → 捕获成 notice（"上次选的 X 现在不可用，已回退到 Y"）并退回第 ③ 步。
3. **只存在内存里**（controller 的一个字段），**不要用 `workspaceState`/`globalState`** ——
   一旦落盘它就是第三份"默认模型"设置，S6 要同时和 pi 的 settings 与它对账。

**配套断言（controller-check，真会话）**：选模型 → 触发 `newSession` → `session.model`
**仍是用户选的那个**。这条比任何 UI 断言都值钱，因为它锁的是**跨会话重建**的行为。

## 5. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | 动版式碰到 S2/S3 已验收行为 | 测试台加**结构位置断言**；Mac 动作②重跑滚动/中止 |
| R2 | QuickPick 抢焦点 | D10 的四条焦点规则（含"Esc 也要回焦点"） |
| R3 | `getAvailable()` 慢 | 实测 1ms；按 D7 **传 Thenable**，VS Code 自带加载态（不再用 snapshot 先弹窗） |
| R4 | 等级列表有空洞 | D8 原样使用 `getAvailableThinkingLevels()`，断言覆盖空洞 |
| R5 | `percent` 为 `null` 或被压缩 | 显示 `?`；断言 `null` 分支不产生 `NaN%`/`null%` |
| R6 | 模型 id/provider 是外部字符串 | 按文本转义；断言模型名里带 `<img>` 不生成元素 |
| R7 | 阈值与 pi 不一致 | 70/90（严格大于），具名常量 + 出处注释；断言 70 与 90 本身是普通/warning |
| R8 | 顶部状态行消失后忙/闲提示无处放 | D1/D2：常驻空行 + 按钮/hint 已足够 |
| R9 | 状态栏项在无面板窗口乱显示 | D13：只在有活动会话时显示，dispose 时 hide |
| **R10** | **`renderStatus()` 结尾有一句无条件 `scrollToBottom()`（`main.ts:209`，已复验）** —— meta 刷新频率一上来，翻历史的用户会被**反复拽回底部** | **采纳评审第 2 轮的结论：从 `renderStatus()` 里删掉它，不做任何替换**（滚动跟随的正确条件是"**转录内容变了**"，meta/busy/queue 都不改内容；改成 `scrollIfFollowing()` 只是把伤害降到"大多数时候没事"，还把这个与状态渲染无关的副作用留在原地）。**但 `applyState()` 末尾要显式补一次 `scrollToBottom()`** —— 快照重放后必须停在底部，漏了会变成"重开面板停在转录顶部"，比 R10 更显眼。跟随只保留在 `delta` / `item` 两条路径 |
| **R11** | 窄栏溢出 | 模型名 `min-width:0; overflow:hidden; text-overflow:ellipsis`；**等级与百分比 `flex:none` 永不被挤掉**（它们是本次改造的目的） |
| **R12** | `setModel` 是 async + `checkAuth`，关闭选择器到生效之间有窗口 | await 完成再广播 meta；**生成中切模型不影响本轮**（pi 只改 `state.model`）→ 写进 README 已知限制 |
| **R13** | `meta` 与 `busy` 的到达顺序竞态 | 只要 D2 被否决就不存在（评审指出这本身就是否决 D2 的理由之一） |
| **R14** | `alignPanelModel` 在 `onRebind` 里覆盖用户的面板选择 | 见 D15 |

---

## 6. 自动化检查（先红后绿；两轮评审逐条纠正过）

**桩的纪律（评审第 2 轮，写进脚本头注释）**：**驱动端必须是真输入**（一条会话事件 /
一条 webview 消息），**桩只能出现在断言端**；两端都是桩的断言一律删掉。
例：不要"我调 `updateStatusBar(x)` 再断言桩记到 `x`"（那是在测赋值），
而是"喂一条 `meta` 刷新，再去桩上读 `statusBar.text`"。

| 脚本 | 断言（要点） |
| --- | --- |
| `scripts/tool-text-check.mjs` | **`formatTokens` 的 8 个边界值**（D14 表，实测值）+ `percent` 格式化 |
| `scripts/render-xss-check.mjs` | 元信息行：模型名 + 等级 + 百分比；`percent: null` → **`?/1.0M`（无 `%`）**；**`contextWindow: 0` → 走"未选择模型"文案，不出现 `?/0`**；**70 与 90 本身**（普通 / warning）、`70.1`（warning）、`90.1`（error）、`null` **不着色**（pi 用 `percent ?? 0`）；模型名里的 `<img …>` 不产生元素；`off` 且支持思考时显示 `thinking off` |
| `scripts/webview-dom-check.mjs` | **结构位置**：`#status` 在 `#composer` 之前且在 `#queue` 之后；`#meta` 在 `#input` 之后；空闲时 `#status` 文本为空**且整份 DOM 不含"空闲"**；点模型段/等级段发出对应请求；收到 `meta` 就地更新（不重建节点）；`focusInput` 后 `activeElement === #input`（注释写明**它不覆盖 R2 的真焦点**）；**R10 三条**：收到 `meta` **不写** `transcript.scrollTop`、收到 `busy` **不写**、收到 `state` **写**（setter 探针；单独一条会被"把滚动搬进 busy"绕过去） |
| `scripts/host-check.mjs`（新，配 fake-`vscode` 桩） | ①消息路由：未知消息 → output 多一行**且没有任何 postMessage 发出**；`openModelPicker` → `showQuickPick` 被调用一次；**webview 报旧 protocol → output 里有版本不一致日志**（这是删掉 `PROTOCOL_VERSION === 3` 之后唯一有意义的版本断言）。④错误路径：`setModel` 抛错 → notice 文案**带 `provider/id`**、**且不广播 meta**（别把半截状态推给前端）。②（**随 controller 提交一起补**）`showQuickPick` 收到的 items **与 `getAvailable()` 顺序一致**、当前项用 **`$(check)` 前缀或 `description:"当前"`** 标记（**不是 `picked`** —— 它只在 `canPickMany` 多选时生效）；**空列表 → 只有一条说明项，选中它 `executeCommand("jerrypi.setApiKey")`**。③（**最有价值**）选第 N 项时 `setModel` 收到的是**那个 Model 对象**（不是字符串、不是 `provider/id`）。⑤状态栏项：**喂真输入**后读文本/tooltip/`command`；断言**时机**（ensure 之前不创建、dispose 时 hide） |
| `scripts/controller-check.mjs` | 快照里 `meta` 必填且形状正确（含顶层 `contextWindow`）；一轮对话后 `percent` 变大；无模型会话里 `supportsThinking()===false` 而 `getAvailableThinkingLevels()` 有 7 档（D8 的 gate）；**D15：选模型 → `newSession` → `session.model` 仍是用户选的那个** |

**桩的最小 API 面（评审按"宿主代码真的碰到什么"裁的，不多给）**：
`window.showQuickPick`（await thenable，按预置脚本返回第 N 项或 `undefined`，记录 items 与 options）、
`window.createStatusBarItem`（记录 text/tooltip/command/show/hide/dispose）、
`window.showWarningMessage`/`showErrorMessage`（只记录）、`window.showTextDocument`（只记录）、
`commands.registerCommand`/`executeCommand`（注册表 + 真派发）、`env.openExternal`（只记录）、
`Uri.file/parse/joinPath` + `toString()`（平凡实现）、`StatusBarAlignment`/`Disposable`（常量/平凡类）。

外加一个**不属于 vscode 模块**的假 `WebviewView`：
`{ webview: { options, html, cspSource, asWebviewUri, onDidReceiveMessage, postMessage(记录) }, onDidDispose }`
—— 必须走 `resolveWebviewView` 注册进来的那个回调去驱动消息处理（别直接调私有的 `handleMessage`）。

接线：`scripts/webview-bundle.mjs` 那套之外，host-check 用 esbuild 的 **`alias`** 把 `vscode`
指向 `scripts/fixtures/vscode-stub.mjs`。**桩里不写任何判断逻辑**，只有记录与可编程返回值。

**删掉的**（评审指出恒真或无意义）：
- ~~`PROTOCOL_VERSION === 3`~~ —— 两端 import 同一个常量，断言它等于 3 只是把数字抄两遍；
- ~~"两个新客户端消息被接受"放 protocol-check~~ —— `protocol.ts` 只有类型、运行期没有校验器，
  真正的接受/拒绝在 `chatView.handleMessage`（import vscode）→ 挪进 `host-check`；
- ~~"QuickPick **弹出**"~~ —— 弹出本身不该断言（见桩的纪律）。

**不许写进自动化的**：任何**滚动结果**（无头 DOM 无排版引擎，`scrollHeight` 恒 0）。
区别：R10 那三条测的是"**有没有调用** `scrollTop`"，允许。

## 7. 人工验收 —— Mac（**用户只做 2 个动作**）

**标记规则**：每条标 `【自动】`/`【人工】`；`【人工】` 只允许属于四类 ——
①排版/外观（无头 DOM 没有排版引擎）②真焦点/真键盘 ③真进程 ④Windows 路径与 shell 形态。

| 项 | 谁来覆盖 | 归属 |
| --- | --- | --- |
| 版式的**位置关系** | 测试台结构断言 | 【自动】 |
| 版式在**真侧边栏**里的样子（挤压/换行/抖动） | 无头 DOM 测不了 | 【人工】动作 ① |
| 点模型段/等级段发出请求 | 测试台断言 | 【自动】 |
| 选中项 → `setModel` 收到正确的 Model 对象（**不是**"弹出了"） | `host-check`（桩）+ `controller-check` | 【自动】 |
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

## 9. 实施步骤（提交切分）—— 采纳评审第 2 轮的重排

**顺序：协议 → 桩 + host-check → controller → webview。**
我原来的顺序（桩在前、协议在后）有一处倒挂：第 2 步要断言 `chatView` 接受
`openModelPicker`，可这两个消息类型要到第 3 步才存在 —— 那写出来的断言会因为
**类型/常量不存在而编译失败**。那不是"看到红"，是"跑不起来"；
**红必须是断言失败**，否则先红后绿这条纪律就退化成走过场。
协议提交只加类型、常量与注释（无行为）→ 天然是绿的，不违反纪律。

1. **探针补充**（已做，见 §3.5）。
2. **`feat(protocol): v3`** —— D12 的 `meta` 形状 + `meta` 消息 + 两个客户端消息 + 注释里写明
   两种 null 状态与 `contextWindow: 0` 的语义。
3. **`test: add a fake-vscode stub and host-check`** —— 桩（§6 的最小 API 面）+ 新脚本 +
   挂进 `self-test`。**这一步只写断言 ①④**（消息路由、错误路径）—— 它们只依赖协议形状，
   不依赖 items 怎么拼、状态栏文案长什么样。**②③⑤ 留到 controller 那个提交里同步补**：
   硬在此时写完，就是对着想象中的实现写断言，最后必然改断言去迁就实现
   —— 那种断言退化成"实现的镜像"，正是 S3 栽过的"断言了 bug 本身"。
4. **`fix(webview): stop scrolling to the bottom on every status render`** —— **单独一个提交**：
   `main.ts` 删掉 `renderStatus()` 里的 `scrollToBottom()` + `applyState()` 末尾**显式补一次** +
   §6 的 R10 断言里的**两条**：`busy` **不写** `scrollTop`（**修之前是真红**：现在 `case "busy"`
   会经 `renderStatus()` 走到 `scrollToBottom()`）与 `state` **写**（修完的回归护栏）。
   **`meta` 不写那条留到第 6 步** —— 第 3 轮核对指出：`meta` 的前端处理要到第 6 步才存在，
   放在第 4 步它必然恒绿，就违反了"红必须是断言失败"这条纪律。它是既有行为的回归修复，单独成提交才能被单独 revert 和引用
   （S3 的 `fix:` 提交都是这么切的）。
5. **`feat(controller)`** —— 组装/去重/`lastMeta` 清理、D5 的八个刷新点、D7 的
   `showQuickPick(getAvailable())`、QuickPick 与两个命令、D13 状态栏项、D15 的 A 方案（含三条补丁）；
   同步补 host-check 的 ②③⑤ 与 controller-check 的 D15 断言。
6. **`feat(webview)`** —— 版式改造（`#status` 下移**常驻空行**、新增 `#meta`）+ 渲染 +
   新挂委托 + `focusInput` + R11 的溢出规则。
7. **`docs`** —— README（功能表、已知限制：生成中切模型不影响本轮 / D7 暂不做 `createQuickPick`）、
   本文件 §11/§12。
8. 打包 → 自测 → Mac 2 个动作 → 发 0.1.6 → Windows W0–W2。

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

### 第 2 轮（Claude，2026-09-13，5697 字；同一会话）

评审先复核了我的吸收质量：**没有漏条**，13 条采纳 + 1 条否决都对得上，
D14 的 8 个边界值它重算过全对。但指出 **2 处"采纳方式不对" + 3 处小遗漏 + 1 处设计自相矛盾**：

| # | 意见 | 处置 |
| --- | --- | --- |
| B1 | **`picked` 是第二个 `isEnabled`**：`QuickPickItem.picked` **只在 `canPickMany` 多选时生效**，单选时什么都不做 —— 我把原来的 `$(check)` 改成 `picked`，等于换了个真机上不生效的字段，而 host-check 会断言它"被设置了" → **测试全绿、真机没勾** | **采纳**：改回 `$(check)` 前缀或 `description:"当前"`（后者更原生） |
| B2 | host-check 断言②的基准取错了半边：写的是 `getAvailableSnapshot()`，**权威列表是 `getAvailable()`**；D11 的"没有可用模型"也须按最终列表判定（快照非空但凭据刚失效正是要提示的场景） | **采纳**（连 D7 的做法一起重做，见下） |
| B3 | §6 没写 `?` 的**完整串**：pi 渲染 `?/1.0M`，**没有 `%`** | **采纳**（§3.2 + §6 断言） |
| B4 | D12 的 `contextWindow` 顶层必填，但**无模型时它是 `0`** → 要定规则：无模型走"未选择模型"文案，**不渲染 `?/0`** | **采纳**（D12 + §6 断言） |
| B5 | D13 tooltip 的价格要标单位 `$X / 1M tokens` | **采纳** |
| B6 | §7 那行仍叫"QuickPick **弹出**、选中后真的切了模型" —— "弹出了"正是不该断言的部分 | **采纳**（改为"选中项 → `setModel` 收到正确的 Model 对象"） |
| B7 | **D4/D7 自相矛盾**：`showQuickPick` 弹出后改不了 items、设不了 `busy`；要那样做必须换 `createQuickPick`（桩面积翻倍 + 事件顺序自己容易写错） → 改用 **`showQuickPick(Thenable)`**，VS Code 原生支持传 Promise 并自带加载态 | **采纳**（D7 重写；`createQuickPick` 留作真机卡顿时的升级项） |
| B8 | **D15 定案 A**（B/C/以及它自己想到的 D 全部否决：B 与既有纪律冲突、C 是把十行修复包装成文档、D 会把受限机"`gpt-5.5` 卡死"那条路重新打开），并给三条补丁 | **采纳**：①优先级写死且**面板选择赢**（"你在面板里选过模型，本窗口就一直用它"）；②`onRebind` 时**重新校验**（凭据可能失效 → notice + 退回兜底）；③**只存内存**，不用 `workspaceState`/`globalState`（否则就是第三份默认模型设置）。配 controller-check 断言：选模型 → `newSession` → 模型没变 |
| B9 | 桩的最小 API 面（按"宿主真的碰到什么"裁）+ 假 `WebviewView` 必须走 `resolveWebviewView` 的回调驱动，别直接调私有 `handleMessage` | **采纳**（§6 的接口表） |
| B10 | 断言①④可留、②③⑤要等 controller；**⑤有"测桩自己"的风险** → 立规矩：**驱动端必须是真输入，桩只能出现在断言端** | **采纳**（写进 §6 头注释） |
| B11 | ④补两点：notice 文案要带 `provider/id`；**失败时不广播 meta** | **采纳** |
| B12 | **R10 的修法是"不滚"而不是 `scrollIfFollowing()`**；且 `applyState()` 要**显式**补一次滚底（否则"重开面板停在转录顶部"，比 R10 更显眼）；断言要三条一起（`meta` 不写 / `busy` 不写 / `state` 写） | **采纳**（R10 行重写） |
| B13 | **§9 顺序倒挂**：桩在协议前，会导致"编译失败"而不是"断言失败"；红必须是断言失败 | **采纳**（重排为 协议 → 桩+host-check → controller → webview；并规定第 3 步只写 ①④） |
| B14 | **R10 的修正单独切一个 `fix:` 提交**，别混进版式大改 | **采纳**（§9 第 4 步） |

第 2 轮**没有否决项**、也没有新的设计分歧 → 按既定规则（"全部采纳且是小改就不为了流程而流程"）
不再开第 3 轮；第 3 轮只用于**核对本次吸收的转写**（见 §10.1）。

---

### 10.1 第 3 轮（**只核对转写，不审设计**）—— 已完成

把第 2 轮的 B1–B14 逐条对着 §4/§5/§6/§9 的实际文字核对。结论：**没有新设计问题**，
但查出 **7 处转写漏洞**，全部已修（下面记录，便于复查）：

| # | 漏洞 | 修法 |
| --- | --- | --- |
| C1 | **D8 把"当前档位怎么标记"整条弄丢了**（B1 的连带伤害：我只在 §6 改了字段，没注意到 D8 那句被删） | D8 补回：`$(check)` 前缀或 `description:"当前"` |
| C2 | **D7 的代码行字面上是错的**：`showQuickPick` 只收 `string[]` / **带 `label` 的 `QuickPickItem[]`**，`Model[]` 两者都不是；且裸传空数组会让 VS Code 显示"无匹配项"，D11 的说明项没地方插 | 改成映射后的 Thenable（含空列表分支），写进 D7 |
| C3 | D13 里"见 §9 **第 2 步**"是**过期引用**（B13 重排后桩在第 3 步） | 改为第 3 步 |
| C4 | §3.3 的 `getAvailableSnapshot()` 备注仍写着"先弹窗再替换 items"，**与 D7 打架** | 改为"本步不用…留作升级 `createQuickPick` 的备选" |
| C5 | R3 的对策也停在旧方案 | 改为"按 D7 传 Thenable" |
| C6 | §9 第 4 步里"收到 `meta` 不写 scrollTop"在**那个提交点是恒绿的**（`meta` 的前端处理第 6 步才有）→ 违反刚立的"红必须是断言失败" | 第 4 步只留 `busy 不写`（真红）+ `state 写`；`meta 不写` 挪到第 6 步 |
| C7 | 文档结构错位（§10.1 掉到了 §12 后面）+ 头部状态行过期 | 挪回这里；头部改为"三轮评审已完成" |

## 11. 实施期发现的问题 / 偏离计划的地方

1. **`controller-check` 里有三条既有问题**（不是 S4 引入的，已在 S3 的 `fe3a659` 上复现）：
   两条断言期望"正文里能看到 pi 的截断脚注"，与 S3 的 M5 修复（**故意剥掉**重复脚注）
   正好相反；另一条轮询只等"有 pending 工具行"，而 pending 行在第一个输出到达**之前**
   就存在，于是"已流出的正文还在"偶发假红。已按需求侧改正，现在 59/59。
2. **host-check 的第一版漏了一个宏任务的等待**：`chatView` 的监听器是
   `void this.handleMessage(...)`（fire-and-forget，产品代码故意的），所以
   `await listener(msg)` 立刻返回，而处理链还在跑 → 所有"await 之后"的断言假红。
   `send()` 现在多等一个宏任务。**教训：假红和假绿一样要查到底。**
3. **第 3 步的断言分配**（与计划略有出入）：`host-check` 先只写"今天就能成立"的那批
   （消息路由、版本日志、prompt 失败、链接/文件白名单、队列取回），
   选择器与状态栏的断言随第 5 步一起补（否则第 3 步就会红着进 CI）。

## 12. 实施与验收结果

### 12.1 自动检查（全绿）

```
typecheck（2 套 tsconfig）· self-test 9/9（含新增的 host-check 用例）
protocol 112 · render 105 · tool-text 69 · webview-dom 66 · host 39
controller-check（真模型）59/59
package：338 文件 / 5.74 MB（19% 的 30MB 门禁）
```

**能红验证**（每条新断言都先证明它会红）：
- 宿主：把白名单判断去掉 → 2 条红；未知消息日志去掉 → 1 条红；`composerError` 去掉 → 1 条红；
- 选择器：当前项标记换成 `picked`（评审判定"真机不生效"的写法）→ 红；
  把 Model 对象换成 `"provider/id"` 字符串 → 红；
- 版式：把 `#status` 放回面板顶部 → 2 条红；
- R10：把无条件 `scrollToBottom()` 放回去 → "busy 不写"红。

### 12.2 提交切分（实际）

| 提交 | 内容 |
| --- | --- |
| `24c2b62` | feat: broadcast session meta and wire the model/thinking pickers（controller + host + 命令 + 状态栏 + 断言） |
| `f3475ba` | test: add a fake-vscode stub and host-side wiring checks |
| `3f3fe91` | fix: stop scrolling the transcript on every status render（R10，独立 fix 提交） |
| （本提交） | feat: move the status line next to the composer and add the meta row + docs + 0.1.6 |

### 12.3 人工验收

**Mac（用户只做 2 个动作）—— ✅ PASS**

| 动作 | 结果 |
| --- | --- |
| ① 切到最长模型 id + 截图 | ✅ 顶部无状态行；输入框下方 `deepseek-v4-flash-vision-exp · high · 0.0%/1.0M` **一行放得下、不换行、等级与百分比都没被挤掉**；VS Code 状态栏同步显示并可点击；Output 里 `[controller] 模型：deepseek/deepseek-pi 设置里的默认 deepseek/deepseek-flash，未覆盖` 证明**没有覆盖用户在 pi 里的选择** |
| ② 流式中往上滚 + 中止 | ✅ **不被拽回底部**（R10 的真机验证）；中止后卡片 `✗`、`Took 11.7s`、**已流出的第 1–12 行仍在**、末尾是 pi 自己的 `Command aborted` |

**截图 2 里发现一处该改的**（用户没提，是我看出来的）：中止时面板多显示一行
`（本次回复没有内容：error）`。原因是 pi 在中止长命令时给的是
`stopReason: "error"` + `errorMessage: "This operation was aborted"`（**不是** `"aborted"`），
所以 render.ts 里那条 `reason === "aborted"` 分支没命中，而且 `error` 是 StopReason
**枚举值**、不是给人看的词。已改成：**已经有具体错误信息时不再补"没有内容"那句**
（两行说的是同一件事，红色那行已经把原因说全）。配 5 条 render-check 断言
（toolUse 不补、aborted 写"已被中止"、有错误信息时不补、错误信息本身仍显示）。

**Windows（W0–W2）**：待做。

### 12.4 已知未覆盖

- `>70%`/`>90%` 的**颜色**只在纯函数层断言（`renderMeta` 的 class），真机上没有构造
  70% 上下文（记录为"未覆盖"，不是"通过"）。
- 滚动行为仍不自动断言（无头 DOM 无排版引擎）；R10 只断言"有没有写 scrollTop"。
