# S5 计划：会话管理（新建 / 列表 / 恢复，与 pi CLI 互通）

> 状态：**三轮评审已完成**（第 1 轮 5B/5S/6N、第 2 轮 4B/5S/6N、第 3 轮只核对转写；裁决与差异均见 §10）。
> **31 条意见**（第 1 轮 16、第 2 轮 15）已全部处置，另修了 3 处我自己的转写不一致；未解决分歧：无。
> **评审结束后又有一处改动（D7 改成确认弹窗）—— 未经复核，见 §10.1。**
> **下一步：按 §9 实施**（§13 的 Q1–Q6 **已全部拍板**，2026-09-13）。
> 上游：`docs/PLAN.md` §6 的 S5（判据 G3）。
> 本步开工前必须先读 §3.1 —— **我们现在把会话写在了一个 pi 看不见的地方**，
> 那是 G3（"与 CLI 会话格式互通"）此刻不成立的原因，也是本步第一件要修的事。

---

## 0. 一句话

把会话目录搬到 pi 的规范位置，让面板写下的会话能被 `pi --resume` / `pi -c` 打开；
窗口启动时自动回到该目录最近的一次会话；给一个会话列表（QuickPick）与可点的会话名；
**每次会话替换后重放整个面板** —— 顺带修掉一个已存在的 bug：现在点 `Pi: New Session`
之后，上一个会话的转写还留在屏幕上。

---

## 1. 目标

| # | 目标 | 可观察的判据 |
| --- | --- | --- |
| 1 | **会话落盘位置与 pi 一致** | 扩展写出的 `.jsonl` 落在 `<agentDir>/sessions/--<编码 cwd>--/`；`SessionManager.list(cwd)`（不传 `sessionDir`，即 CLI 的算法）能列出它 |
| 2 | **窗口启动自动恢复** | 关掉再打开窗口（或 `Reload Window`），面板回到该 cwd 最近一次会话，转写完整 |
| 3 | **列表 + 恢复** | `Pi: Resume Session` 弹出 vs Code 原生 QuickPick：名字、相对时间、消息数、当前项 `$(check)`；选中后转写是**那个**会话的（且不带旧会话的残留） |
| 4 | **新建** | `Pi: New Session` 与列表里的"新建会话"项等价；新建后面板**清空**（现在是坏的，见 §3.7） |
| 5 | **会话名可见** | 输入框下方元信息行多一段会话名（可点 → 打开列表）；未落盘时带"未保存"提示 |
| 6 | **互通** | 在同一个 cwd 下 `pi -c -p "…"` 能接上扩展写的会话（G3 的验证方式，指令见 §7） |

**验收判据（G3）**：会话写入 `~/.pi/agent/sessions/`，与 CLI 会话格式互通；重启 VS Code 后能恢复上一会话。
两台机器各验一半：Mac 上验 CLI 互通（`pi -c`），受限 Windows 机上验"重启后恢复"。

---

## 2. 本步不做的事（明确划界）

| 不做 | 归属 |
| --- | --- |
| 会话**重命名** UI（pi 的 TUI selector 有，用 `appendSessionInfo`） | 本步不做；候选后续（§13 Q4） |
| **删除**会话、导出、树/分支可视化（`getTree()` / `branch()` / `navigateTree`） | 不做 |
| **其他项目**的会话列表（`SessionManager.listAll()`） | 不做（默认只列当前 cwd，§4 D5；候选 §13 Q5） |
| 会话内容的搜索 | 不做 |
| 会话级设置（把模型写进会话 vs 写进 settings） | S6 |
| 项目级信任（`projectTrusted` / `.pi/settings.json`） | S6；本步的切换路径**不引入**信任 UI |
| `jerrypi.agentDir` 设置项 | S6；本步只保证"agentDir 变了，会话目录跟着变"（§4 D2） |
| 迁移那 14 个旧布局会话（见 §3.8） | 不自动搬动用户文件；给恢复命令（§4 D3） |
| **真·后台并行**：切走让上一个会话继续跑（像 Codex / Claude 的插件那样） | **后续候选，不是 S5**。理由：那需要"多会话宿主"（多份 runtime/session + 事件分流 + 多份 UI 状态）—— 而 `AgentSessionRuntime` 物理上只持一个会话，`switchSession()` 的实现就是 `teardownCurrent()`。而且并行会话在本项目里会同时写同一个工作区、两个写者写同一份会话文件（R8）。S5 用 D7 的确认弹窗拿到其中 90% 的价值（用户 2026-09-13 的讨论结论） |

---

## 3. 已核实的事实

> **出处说明**（与 S4 相同）：`dist/core/...`、`dist/modes/...` 这些路径**只存在于 `node_modules/`
> 那份发布包**（用来读语义）；运行期我们只加载 `pi-runtime/dist/bundle/index.js`
> （用来判断"能不能用"）。两者不一致时**以 bundle 的导出面为准**。
> §3.1、§3.8 的数字是本次（2026-09-13）在本机实跑得到的，不是读代码推的。

### 3.1 【关键】`sessionDir` 的语义：我们现在用错了

pi 的 `SessionManager.create/open/list/continueRecent` 的第二个参数 `sessionDir`
**不是"sessions 根目录"，而是"直接装 `.jsonl` 的那个目录"**：

- `dist/core/session-manager.js:1127`：`const newSessionFile = join(this.getSessionDir(), \`${fileTimestamp}_${newSessionId}.jsonl\`)`
  —— 传进去的目录被**原样当作文件的父目录**；
- `:1207`：`const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`
  —— 省略时 pi 自己算的是**per-cwd 的编码子目录**，不是根。

而 pi 的默认布局是 `<agentDir>/sessions/<编码 cwd>/*.jsonl`
（`:240-250`：`safePath = "--" + resolve(cwd).replace(/^[/\\]/,"").replace(/[/\\:]/g,"-") + "--"`）。

补一条**实测**（本次，用发布的 bundle 对 `real` 与指向它的 `link` 各算一次）：
`resolvePath()` 就是 `path.resolve`（`dist/utils/paths.js`，**不做 `realpath`**；
同文件里的 `canonicalizePath` 没被这里调用）→ `real` 与 `link` 得到**两个不同的编码目录**。
即：pi 对符号链接**不归一化**。我们的复刻必须同样不归一化（一致优先），
后果写进 R2。

**我们现在的代码传的是根目录**（`src/pi/controller.ts:227-230`）：

```ts
pi.SessionManager.create(cwd, this.options.sessionsDir ?? join(agentDir, "sessions"))
```

实测后果（探针在临时目录里跑，用我们**发布的那份 bundle**）：

```
A(当前做法) 文件: <root>/agent/sessions/2026-09-13T11-42-28-011Z_<id>.jsonl   ← 平铺在根上
C(默认布局) sessionDir: <默认 agentDir>/sessions/--var-folders-…-ws--        ← pi 的规范位置
```

在本机真实目录上数一遍（`SessionManager` 的三个入口）：

```
list(cwd)                     默认编码目录 -> 5 条     ← pi CLI 看得到的就是这 5 条
list(cwd, <agentDir>/sessions) 当前 jerrypi -> 0 条     ← 平铺文件一条都不匹配（cwd 过滤）
listAll()                                   -> 17 条    ← 只扫编码子目录，**平铺的完全不在内**
list("/Users/fengrui", <agentDir>/sessions) -> 14 条    ← 见 §3.8
```

**结论（三句话）**：

1. 扩展会话**不会被 `pi --resume` 看到**，也**不会被我们的 `list()` 看到** ——
   G3 的"互通"此刻**不成立**，而不是"部分成立"。
2. `docs/PLAN.md:218` 里写的"`sessionDir` 从生效的 agentDir 推导为 `<agentDir>/sessions`"
   **也是同一个误解**，实施时要一起改（§9 第 6 步）。
3. 修法不是"再拼一层路径"，而是**必须复刻 pi 的编码规则**，因为
   `getDefaultSessionDir()` **没有从 bundle 导出**（§3.3），我们不能不传参让 pi 自己算
   （那样 agentDir 只能是默认的，S6 的 `jerrypi.agentDir` 会失效）。

### 3.2 会话文件与列表条目的形状

文件名：`<ISO 时间戳把 : . 换成 ->_<会话 id>.jsonl`（`:1126-1127`）。
会话文件是**append-only 的 JSONL 树**（每行一个 entry，`id`/`parentId`），
首行是 header：`{type:"session", version:3, id, timestamp, cwd, parentSession?}`。
`CURRENT_SESSION_VERSION = 3`（`session-manager.d.ts`）。**我们不做任何自己写文件的事**，
全部走 `SessionManager`（这是"格式一定对"的唯一保证）。

`SessionInfo`（`list()` 的产物）里我们要用的字段，实测样例：

```
name: undefined | firstMessage: "这个项目现在应该做哪一步了，请看一下 STATUS"
messageCount: 114 | cwd: /Users/fengrui/Desktop/prj/jerrypi-vscode
```

- `name`：**最新**一条 `session_info` 条目的 `name`（清空也算，`:465-467`）；
- `firstMessage`：首条 **user** 消息的纯文本（`:485-486`，`extractTextContent`），
  没有则 `"(no messages)"`（`:508`）；
- `modified`：最后一条消息的**活动时间**；无活动时间时回落 header 时间戳，再回落文件 mtime
  （`session-manager.js:492-498`）。所谓"所以新建了但一句话没说的会话不会成为最近"只在**列表**里成立，
  `continueRecent` 用的是另一个键（见下一条）。
**⚠️ "最近"有两个不同的键（评审 S2，已核实）**：

- `list()` / `SessionInfo.modified` = **消息活动时间**（`:492-498`）；
- `continueRecent()` 内部的 `findMostRecentSession()` = **文件 mtime**（`:397-409`，`statSync(path).mtime`）。

两者会分叉：一个会话被 `appendSessionInfo` 改过名（或只追加了非消息条目）→ 文件 mtime 更新、
`modified` 不变 → "自动恢复进来的会话在列表里不是第一条，但打着 `$(check)`"。
**所以任何断言都不许写"第一条就是当前项"**，文档与文案也统一说"文件最后被写过的那次会话"。

- `list()` **已经按 `modified` 倒序**（`:1316`），我们**不要再排一次**（写成断言）。

### 3.3 bundle 的导出面（能用什么、不能用什么）

实测 151 个导出符号，其中与会话有关的只有：

```
AgentSession, AgentSessionRuntime, CURRENT_SESSION_VERSION, SessionManager,
buildSessionContext, createAgentSession, createAgentSessionFromServices,
createAgentSessionRuntime, createAgentSessionServices, migrateSessionEntries,
parseSessionEntries, sessionEntryToContextMessages  （另有 SessionSelectorComponent）
```

- ✅ `SessionManager.create/open/list/listAll/continueRecent` 全都在；`create` 不传
  `sessionDir` 时可以用 `getSessionDir()` 反查 pi 算出来的目录（**这是 §4 D2 的防漂移手段**）。
- ❌ **`getDefaultSessionDir` 不在导出面里**（S4 也踩过同类：`formatTokens` 同理）。
- ❌ `MissingSessionCwdError` **不在导出面**（只有 `CredentialSynchronizationError`）→
  切换失败时只能按 `error.name` / message 判定（§4 D9）。
- ⚠️ `SessionSelectorComponent` 是**终端 TUI 组件**，我们不用（面板里用 VS Code 原生 QuickPick，照 S4 的先例）。

### 3.4 替换会话的四个语义细节（都影响实现）

| 事实 | 出处 | 影响 |
| --- | --- | --- |
| `runtime.newSession()` **继承当前会话的 `sessionDir`** | `agent-session-runtime.js:153` | 只要起始会话的目录对，后续新建就都对 —— 不需要在 `newSession` 处再算什么 |
| `runtime.switchSession(path)` 用 `SessionManager.open(path, undefined, cwdOverride)`，于是 **`sessionDir` 变成该文件的父目录** | `:134` | 只列当前 cwd 的会话时，父目录 == 我们的编码目录，一致；**将来若做跨项目列表，这条会破**（§4 D5） |
| `switchSession` 会 `assertSessionCwdExists`，会话 header 里的 cwd 不存在就抛 | `:135` | 要兜住并给可读提示（§4 D9） |
| `switchSession` 发的 `session_start` 事件 `reason: "resume"`（`newSession` 是 `"new"`、带 `previousSessionFile`） | `:141-145` | 扩展会被重新绑；`onRebind`（S4 D15 的模型记忆）也会跑到 → 用例可以断言 |

`AgentSession` 上 `sessionManager` 是 **public**（`agent-session.d.ts:194`），
`sessionFile` 也是（`:328`）——所以"当前会话的路径/名字"不用另开簿记。

### 3.5 会话名与"落盘了没有"

- 当前会话名：`sessionManager.getSessionName()`（`session-manager.d.ts`，读最新 `session_info`）。
- **`isPersisted()` 不是"写到磁盘了吗"**：它返回的是 `this.persist`，即"这个 manager 会不会落盘"
  （`session-manager.js:721-723`）——**别拿它判断文件存在**。
- 真正的落盘契约在 `_persist()`（`:739-766`）：**文件里出现第一条 assistant 消息之前不建文件**
  （`openSync(..., "wx")` 在 `hasAssistant` 为 true 时才走）。而 `newSession()` 会**提前**把
  `sessionFile` 设好（`:1164`）→ 于是存在一个窗口期：**`getSessionFile()` 有值，但 `existsSync()` 为 false**。
  → §4 D8 用 `existsSync` 判定"未保存"，不用 `isPersisted()`。
- 推论（会直接影响用户观感）：**新建会话后立刻打开列表，看不到它**。这不是 bug，
  要在 UI 里说清楚（D8），并写成断言（D10）。

### 3.6 pi CLI 那一半（我们要对齐的行为）

- CLI 的会话选择器（`dist/modes/interactive/interactive-mode.js:4477-4499`）列的是
  `SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir())` ——
  **用活会话的 `sessionDir`**，不重算编码目录。→ 我们照抄这一点（§4 D5）。
- 它把当前会话路径作为 `currentSessionFile` 传进去，用来标"当前项"（同处）→ 我们照抄。
- 重命名：`SessionManager.open(file).appendSessionInfo(name)`（`:4489-4493`）→ 本步不做，但记着这条路。
- 恢复：`handleResumeSession()`（`:4502`）**不 waitForIdle**，直接 `switchSession`；
  `MissingSessionCwdError` 时**问用户要一个 cwd**再切。
  **为什么它敢不 waitForIdle（评审 B1，已核实）**：`teardownCurrent()`（`agent-session-runtime.js:102-105`）
  第一句就是 `await this.session.abort()`，注释明写 "so the aborted turn (including tool results)
  is persisted to the outgoing session before it is replaced" ——
  **静默 teardown 不会丢已经改了的文件和工具结果**。这条直接推翻了我给 D7 写的理由（见 D7 与 A2）。
- 每一次 `switchSession` / `newSession` 都返回 `{ cancelled }`（`agent-session-runtime.js:78-88`：
  `session_before_switch` 扩展钩子可以 `cancel`；取消时**不 rebind、不换会话**），
  CLI 的每个调用点都检查它（`:4509`、`:4524`）。我们支持 `additionalExtensionPaths`，所以这不是理论问题
  → 见 D6/S1。
- 还有**两个能让 CLI 整体搬走会话目录的开关**（会让 D1 的互通前提失效）：
  ① 环境变量 `PI_CODING_AGENT_SESSION_DIR`（`config.js:407` 用 `APP_NAME` 拼出来，
  `main.js:531-534` 读它，语义与 `--session-dir` 相同 = "直接装 jsonl 的目录"）；
  ② `settings.json` 的 `sessionDir` 键（`core/settings-manager.js:450-453`，CLI 会尊重它）。
  两个我们**都不跟随**（本机当前都没设）→ 写进 R2，并给 §13 Q2 多一个假设（见 N2）。
- CLI 侧的相关参数（`pi --help` 实测）：`--resume/-r`、`--continue/-c`、`--session <path|id>`、
  `--session-dir <dir>`、`--name/-n <name>`、`--print/-p`。
  `--print` 让我们能用**一条命令**验互通，不必去驱动交互式 TUI（§7 动作 ②）。
- `--session-dir` 也是**"直接装 jsonl 的目录"**语义（`main.js:186-336` 全部原样传给
  `SessionManager.*`），所以旧布局的恢复命令成立（§3.8）。

### 3.7 现有代码的两处缺口（本步必须一起补）

**缺口 A：会话替换后没有重放**（已存在的 bug）。

- `chatView` 只在收到 webview 的 `ready` / `requestState` 时发全量 `state`
  —— 全仓唯一调用点是 `src/host/chatView.ts:129`；
- webview 只在启动时发一次 `ready`（`src/webview/main.ts:563`），**从不**发 `requestState`；
- `controller.newSession()` 只做了 `resetLiveState()` + `runtime.newSession()`
  （`src/pi/controller.ts:367-374`），**没有**任何发往 webview 的重放消息。

⇒ 现在点 `Pi: New Session`：控制器内部清干净了，**但面板上仍然是上一个会话的转写**，
之后新消息**追加**在旧内容后面（转写的 id 是 `msg-<下标>`，还会和新会话的历史撞号）。
本步修掉（D6），并且同一个机制正是"切会话"需要的。

**缺口 B：`sessionsDir` 选项的语义**。

`src/pi/controller.ts:63-68` 的注释说它是"会话文件的存放目录，默认 `<agentDir>/sessions`"，
注释本身没错，**错在它被直接当成了 pi 的 `sessionDir` 参数**（§3.1）。
另外 `scripts/controller-check.mjs:113,130,216,499` 与 `src/pi/selftest.ts:287-295,360,422,436`
都在用这个名字传临时目录 → 改语义时要**一处不漏**（D2 用重命名强制编译器抓）。

### 3.8 本机实测：14 个"平铺"遗留会话

`~/.pi/agent/sessions/` 根下直接躺着 **14 个** `.jsonl`（不是子目录里）：
header 的 `cwd` **全部**是 `/Users/fengrui`，时间从 2026-09-12 20:11 到 2026-09-13 17:36，
内容只有 `bash`(27) / `read`(4) 两类工具调用，没有 `write`/`edit`。
它们来自**某个把 `<agentDir>/sessions` 当 `sessionDir` 传进去的 SDK 调用方**
（即 §3.1 那个误解 —— 本仓库的 controller 就是这么传的，但也不排除是别的 SDK 工具：
这些文件里有全局包 `~/Desktop/prj/pi-config` 的 `dsh-timing` 条目，
而**正常 CLI 会话里也有**同样的条目，所以这条不能用来区分）。

**我没有确证它们是 jerrypi 写的**（所有 14 个的 cwd 都是主目录而不是本仓库，
说明当时的扩展宿主没有打开工作区；14 次都这样，可疑）。已列为待用户拍板的问题（§13 Q2）。
无论答案是什么，恢复路径都是现成的（实测 `list("/Users/fengrui", <agentDir>/sessions)` = 14 条）：

```bash
cd ~ && pi --session-dir ~/.pi/agent/sessions --resume
```

**不做**自动搬迁：移动/改名用户的历史文件不属于"实现一个功能"，
而且一旦判断错（比如那些文件其实是别的工具的）就是在替用户改数据。

### 3.9 现有的相关断言（改动会牵到它们）

> ⚠️ **本项目有两个叫 self-test 的东西，别再搞混**（评审 B2 就混了，本轮已实测确认）：
> - `npm run self-test` = `scripts/self-test.mjs`，**构建/打包**检查，`TOTAL = 9`，
>   输出 `SELF-TEST n/9`，末行 `SELF-TEST OK (9/9)`（本次实跑：9/9 全绿）。
> - `Pi: Run Self-Test` = `src/pi/selftest.ts`，**在 VS Code 里的可行性闸门**，
>   项是 T1–T9（T5 拆成 T5a/T5b/T5c）+ 新增的 T10–T12，输出每项一行，
>   末行是裸 `GATE PASS` 或 `GATE BLOCKED <项列表>`（**不带分数**）。
> - `docs/STATUS.md` 里那个 **9/9 指的是前者，没错、不要改**；
>   `docs/S4-plan.md:654` 记的 `GATE PASS 11/11` 指的是后者（10 gating + T5c，人工数的）。

| 脚本 | 现在 | 与本步的关系 |
| --- | --- | --- |
| `Pi: Run Self-Test`（**门禁**，`src/pi/selftest.ts`，**11 行 = 10 个 gating + T5c advisory**） | T7 建持久会话 + `continueRecent` 重开；T9 `newSession`/`switchSession` 替换 | 都用临时 `sessionDir`（`:287-295`）→ 语义改了必须同步改；**新增 T10/T11/T12**（§6） |
| `npm run check:controller`（真模型，59） | 用 `sessionsDir` 传临时目录（`:113,130`） | 同上；新增 §6 的目录断言 |
| `node scripts/host-check.mjs`（39） | 桩 + 真 `ChatViewProvider` 的**唯一**消息校验点 | 新增 `openSessionPicker` 路由断言与 `onSessionReplaced` 回调→重放断言 |
| `npm run check:protocol`（112） | 协议形状 | `PROTOCOL_VERSION` 3→4、`SessionMeta.session`、删 `state.model` |
| `node scripts/webview-dom-check.mjs`（66） | 无头 DOM | 会话名段 + **会话名是 XSS 载荷**的断言 |
| `node scripts/tool-text-check.mjs`（69） | `format.ts` 的纯函数 | 新的会话名/时间格式化纯函数放这里断言（§4 D11） |

---

## 4. 设计决策

> 每条格式：**选择** / 为什么 / 被否的备选 / 断言（先红后绿）。
> 标 ⚠️ 的是我自己没把握、希望评审重点打的（汇总见 §14）。

### D1 会话目录：复刻 pi 的编码规则（而不是"再拼一层"）

**选择**：新增 `src/pi/sessions.ts`，导出

```ts
/** pi 的 per-cwd 会话目录。sessionsRoot 是 <agentDir>/sessions。 */
export function resolveSessionDir(cwd: string, sessionsRoot: string): string;
```

实现照抄 `session-manager.js:245-246`：`--${resolve(cwd).replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`，
拼在 `sessionsRoot` 下。

- **为什么**：`getDefaultSessionDir` 不在导出面（§3.3），而我们必须支持自定义 agentDir（S6）。
- **被否**：不传 `sessionDir` 让 pi 自己算 —— 只能配默认 agentDir，S6 一来就废。
- **被否**：把 `sessionDir` 继续当"根"，只把 `list()` 的调用改成 walk 子目录 ——
  写进去的位置还是错的，CLI 照样看不到。
- **断言**（`controller-check` + 自测 **T10**，评审 B3 已改）：
  1. `dirname(新会话文件) === resolveSessionDir(cwd, root)`（我们的推导与我们的写入一致）；
  2. **T10 用 `usesDefaultSessionDir()` 这个 pi 自己的判据**（`session-manager.js:730-732`，
     CLI 的选择器也用它）——它是**全路径**相等，比 basename 强：
     在默认 agentDir + **真实 cwd** 下建一个 manager，断言 `usesDefaultSessionDir() === true`。
     为什么必须用真实 cwd：`SessionManager.create(cwd)` 不传 `sessionDir` 时，
     `getDefaultSessionDir()`（`:248-253`）会 **`mkdirSync`** —— 拿临时 cwd 去跑，
     每跑一次自测就在用户真实的 `~/.pi/agent/sessions/` 下留一个 `--var-folders-…--` 空目录，
     与 D3"不替用户动 `~/.pi`"自相矛盾。用真实 cwd 时那个目录本来就在（我们的会话就住那里）。
     `jerrypi.agentDir` 非默认时（S6）这条 **SKIP 并注明**，不要静默通过。
  3. **先要给它一个 cwd**（评审 S1）：`SelfTestOptions`（`selftest.ts:40-48`）**现在没有 `cwd`**，
     `commands.ts:36-46` 也没传 —— 实现者到这一步最省事的做法就是退回临时 cwd，
     而那就是这条断言要防的事（而且它会静默通过）。所以 §9 第 1 步的交付判据里要写死：
     "给 `SelfTestOptions` 加 `cwd`，由 `commands.ts` 从 `workspaceCwd().cwd` 传入"；
     没打开工作区时那个值是 `homedir()`（`workspace.ts:18`）—— **断言照样成立**（那也是我们真会用的目录）。
  - 原先写"只比 basename"是在将就临时目录，**删掉**（它比 `usesDefaultSessionDir()` 弱，且多一个自造规则）。

### D2 选项重命名为 `sessionsRoot`，并且只有一处推导

**选择**：`SessionHostControllerOptions.sessionsDir` → **`sessionsRoot`**（`<agentDir>/sessions` 这一层），
控制器内部一律 `resolveSessionDir(cwd, sessionsRoot)`；`scripts/*` 与 `selftest.ts` 全部跟着改，
**测试也只经 `resolveSessionDir` 取目录**（不再自己拼）。

- **为什么**：把"根"和"per-cwd 目录"这两个概念在**编译期**分开 ——
  旧名字被删掉时，每一个误用点都会编译失败（这比注释管用；§3.7 缺口 B 就是这么来的）。
- **被否**：保留名字改语义 —— 静默改变含义，正是当初出错的原因。
- **断言**：`grep` 层面不留 `sessionsDir`；typecheck 通过；T7/T9 与 controller-check 在新语义下全绿。

### D3 旧布局（平铺）文件：不搬、不删，给恢复命令 + 留一个问题给用户

**选择**：本步**不做任何迁移**。在 README 的"已知限制"里写清楚：S5 之前（≤0.1.6）面板写的会话
落在 `~/.pi/agent/sessions/` 根下，`pi --resume` 与面板的列表都看不到；
恢复办法是上面那条 `pi --session-dir … --resume` 命令。是否要写一个一次性搬迁命令，**问用户**（§13 Q2）。

- **为什么**：§3.8 没能确证那 14 个文件是 jerrypi 写的；对**可能是别人的**历史文件做移动/改名，
  风险远大于收益。而"恢复命令"零风险、且已经实测可用。
- **被否**：启动时自动扫平铺目录并搬进编码目录 —— 会替用户改数据、还会把别的工具的文件搅进来。
- **被否**：在 UI 里显示"发现 N 个旧会话" —— 如果那些文件不是 jerrypi 的，这句话就是**假话**。
- **断言**：无（不做的事没有断言）；README 的这条例外要写进人工验收的检查项（§8 W3）。

### D4 启动时 `continueRecent` 而不是 `create` ⚠️

**选择**：`createHost()` 里由 `SessionManager.create(cwd, resolveSessionDir(...))` 改成
`SessionManager.continueRecent(cwd, resolveSessionDir(...))`。

- **为什么**：G3 的判据是"重启 VS Code 后能恢复上一会话"，验证方式写的是"受限机重启后恢复"
  （没有"点一下"）→ 默认自动恢复。而 `continueRecent` 在没有已落盘会话时返回的 manager
  等价于新建（`session-manager.js:1247-1252`），**不需要特判**。
- **⚠️ 它的"最近"是文件 mtime，不是消息活动时间**（评审 S2，见 §3.2）→
  文案与验收一律说"文件最后被写过的那次会话"，不说"最近聊过的"。
- 已核实的隐患（评审顺带查过，**不存在**）：恢复一个已落盘的文件后再回复，会不会撞 `EEXIST`？
  不会 —— `_setSessionFile` 在文件已存在时会把 `flushed` 置 true（`session-manager.js:637`）。
- **语义变化要明说**（README）：窗口启动会接过**该 cwd 最近一次会话**，
  **包括你在终端 `pi` 里聊的那次**（`modified` 只看消息活动时间）。这是"互通"的另一半，
  但也是个惊喜 → §13 Q1 让用户确认默认值。
- **被否**：启动仍新建，只在列表里让用户手动恢复 —— 那样"重启后恢复"要多点一步，
  且 README:167 的已知限制（"重载窗口会开始新会话"）会继续存在。
- **断言**（`controller-check`）：① 同一临时 cwd 下写一个有 assistant 的会话 → dispose →
  用同一目录重新建 controller → `snapshot().items` 与该会话历史一致（而不是空）；
  ② 空目录下启动 → 不抛错、`items` 为空、**没有**多余会话文件被创建（"不特判"要真的成立）。

### D5 列表数据源：用活会话的 `sessionDir`，只列当前 cwd

**选择**：`SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir())`，
照 pi CLI 的选择器（§3.6）。只列当前 cwd 的目录；不做"其他项目"。

- **为什么**：① 目录只有一处权威（活会话），不会和 D1 的推导分叉；
  ② 跨项目列表会让 `switchSession` 之后 `newSession` 落到**别的项目**的目录（§3.4 第二行），
  这是本步不想打开的语义面。
- **被否**：`listAll()` —— 同上；而且它**看不到**平铺的旧会话（§3.1），做了也治不了那个问题。
- **断言**：`controller-check` 里"列表里每一条的 `dirname(path)` 都等于 `resolveSessionDir(cwd, root)`"；
  "列表按 `modified` 倒序、且我们没有二次排序"（用两条已知时间的会话验顺序）。

### D6 会话替换后**重放**（controller 回调，不是协议消息）

**选择**：给 controller 加一个**宿主回调** `onSessionReplaced?()`（不是 `ServerMessage` 的新消息）；
controller 在**替换成功并 rebind 之后**调它；`ChatViewProvider` 收到后自己组装并发一条全量 `state`。

- **为什么是回调而不是协议消息**（评审 S3）：这是**宿主内部**的事件，webview 永远不需要知道它。
  做成 `ServerMessage` 就必须先把出站路径改成可拦截的 —— 而现在
  `src/extension.ts:42` 是 `onMessage: (message) => provider.post(message)`，
  控制器直连 webview，**`ChatViewProvider` 没有任何出站拦截层**；
  且 `webview/main.ts` 的 switch 里没有这个分支，不拦截就会原样投给前端。回调绕开了整件事。
- **为什么 `state` 由 chatView 发**：`state` 的组装（`protocol` 版本、`truncated`）现在只在 chatView 里（`:129`）。
- **为什么是"替换成功之后"**：`newSession()` / `switchSession()` resolve 时 rebind 已经跑完
  （`finishSessionReplacement` → `setRebindSession`），此时 `snapshot()` 读到的才是新会话。
- **顺序（评审 S1 修正）**：
  1. 先调替换（`runtime.newSession()` / `runtime.switchSession(p)`）；
  2. **看 `{ cancelled }`** —— 被扩展的 `session_before_switch` 钩子取消时（§3.6）**不 rebind、不换会话**，
     所以此时必须**什么都不做**（不 `resetLiveState`、不重放），只给一行"切换被取消"的提示并 return；
  3. 成功之后才：`resetLiveState()` → `publishMeta()` → `onSessionReplaced()`。
  - 原先把 `resetLiveState()` 写在替换**之前**是错的：取消时会白清一次内部状态（卡片索引、白名单都没了），
    面板还拿着旧转写。
- **被否**：让 webview 收到 `meta` 变化时自己重新 `requestState` —— "用副作用触发重放"，
  而且 meta 在流式期间会变很多次。
- **断言**：`host-check`：① 控制器回调被触发 → `provider.post` **恰好一条** `state`；
  ② 被取消的替换（`{cancelled:true}`）→ **不**发 `state`、且有可见提示；
  `controller-check`：`switchSession(p)` 之后 `snapshot().items` 与 `p` 的历史一致，
  且 `openableFiles` 白名单**已重建**（`controller.ts:504-505` 本来就是重建而非累加，评审已核实）。

### D7 流式期间切会话/新建：**问一句**（不是拦死、也不是静默切）※用户 2026-09-13 拍板

**选择**：`newSession` 与 `switchSession` 前统一过一次守卫；谓词**与"面板显示忙"同源**：

```ts
// 评审 B2：不能只用 isIdle。
// pi 的 isIdle = !_isAgentRunActive && !isCompacting（agent-session.js:620-622）——
// 它的缺口是"已发送、但 agent_start 还没来"那个窗口（队列本身在续跑循环里已经覆盖，
// 见下面的 N1 说明）；而本仓自己就为那个窗口维护了 pendingSend
// （controller.ts:185-187 的注释与 :291-299 的实现）。
if (this.pendingSend || !session.isIdle) → 弹确认（不是直接拒绝）
```

- **忙的时候弹一个确认**："正在生成，切换会中止这一轮，继续吗？"
  - 「继续」→ 照常切（等价于 pi CLI 的行为：`teardownCurrent()` 先 `abort()`，
    并把被中止的回合**落盘到旧会话**再替换）；
  - 「取消」→ 什么都不做，会话不变。
- **为什么既不拦死、也不静默切（本轮讨论后的结论，用户拍板）**：
  - **静默切** = 不告诉你就做了决定：`teardownCurrent()` 会 `abort()`（评审 B1 已核实：
    **数据不丢**，被中止的回合会先落盘），但"你正在等的那段回复没了"这件事，
    在你正好把侧边栏切走时完全看不到 —— 回头只看到会话已经换了，像面板抽风。
  - **拦死** = 替你做决定：你**主动**想切的时候它不让。
  - **问一句** = 把决定还给你，而且你确实想切的时候只多一次点击。
- **被否**：自动 `abort()` 后直接切 —— 见上。
- **被否**：直接拒绝（本计划第 1/2 轮的默认值）—— 替你做了决定。
- **被否**：**真·后台并行**（切走让旧会话继续跑）—— 见 §2 那张表里新增的一行：
  它需要"多会话宿主"，是独立特性，而且并行会话会同时写工作区与同一份会话文件（R8）。
  **不作为 S5 的一部分，记为后续候选**。
  （参考事实，**未在本机实测**：Codex / Claude 的插件能做到这点，是因为它们的 agent 跑在
  **编辑器之外的独立进程**里 —— 本机可验证的是 `~/.local/bin/{claude,codex}` 都是原生可执行文件 ——
  所以"切视图"与"跑会话"本来就是两件事。而 pi 在我们的架构里跑在**扩展宿主进程内**。）
- **⚠️ 关于 `isIdle` 到底看不看队列（评审 N1 纠正了我的措辞）**：
  它**看得到**队列 —— `_runAgentPrompt()` 的 `while (await this._handlePostAgentRun())` 续跑循环
  整段都在 `_isAgentRunActive = true` 里，直到 `_emitAgentSettled()` 才置 false
  （`agent-session.js:773-784`）。所以**不要写"isIdle 不看队列"**（会误导后人）。
  它真正的缺口只有一个：**`agent_start` 之前那个窗口**，而这正是 `pendingSend` 补的。
  若还想更保守，可以再加一条 `session.pendingMessageCount > 0`（`:1204-1206`），
  覆盖"扩展在空闲时自己排队"的边角。
- **分层（评审 S4）**：守卫与判定住在 **controller**（返回带 code 的结果，例如
  `{ok:false, code:"busy"}`），**文案与弹窗住在 host**。原因：controller 拿不到 `vscode.window`，
  而 `controller-check` 也断言不了"有没有弹窗"。两边各断言各的。
- **代价**（要接受）：`Pi: New Session` 的行为会变（以前流式中点它直接换）。写进 README。
- **断言**：
  - `controller-check`：`{pendingSend:true && isIdle:true}` 与 `{isStreaming:true}` **两格**
    都要求返回"忙"判定、且 `sessionFile` 不变；**用户确认后的路径要单独断言真的换了**
    （不能只测拒绝路径 —— 那样"确认后仍然不切"会静静通过）；空闲时**不弹确认**、直接替换。
  - `host-check`：忙时**恰好弹一次确认**且**不发** `state`；确认 → 发 `state`；取消 → 不发。

### D8 元信息行加"会话名"段；未落盘时显式标注

**选择**：
- `SessionMeta` 增加 `session: { path: string; name: string; persisted: boolean }`（`path` 未落盘时为空串）；
  （评审 N3 问 `path` "前端用不到" —— **给它一个用途**：会话名段的 `title`/`aria-label`
  显示绝对路径。"我的会话存哪了"是这个项目里已被问过一次的问题（§7 动作② 也要靠它），
  放在 tooltip 里比让人去翻 Output 好。不用它的话就该删字段，不该白留在协议里。）
- 渲染成第三个**可点段**（`data-meta-action="session"`，点击 → 打开列表），
  名字取 `session_info` 名 → 首条 user 消息前 60 字（单行化）→ `"新会话"`；
- `persisted === false` 时显示 `新会话 · 未保存`（提示"列表里暂时看不到它"，§3.5）。

- **为什么放 `meta`**：meta 已经是"整块替换 + 前端不滚动"的通道（S4 R10 的语义正好适用），
  会话名与模型/等级一样是"当前会话的状态"。
- **被否**：新加一条独立的 `sessionInfo` 消息 —— 会多出第二个"整块替换"的通道。
- **XSS 边界**：`name` 来自会话文件（**模型可以往文件里写**、`--name` 也可以），
  必须走 `escapeHtml`；dom-check 里用 `<img src=x onerror=…>` 当会话名（§6）。
- **断言**：`protocol-check`（形状 + 必填）、`webview-dom-check`（渲染 + 点击发 `openSessionPicker` + XSS）、
  `controller-check`（新建后 `persisted:false`、一轮回复后 `true`）。

### D9 切换失败要可读（`MissingSessionCwdError` 不在导出面）

**选择**：`switchSession` 包一层 try/catch：按**结构化判据**识别（评审 N1）：
`error.name === "MissingSessionCwdError" && error.issue`（构造时就显式设了 name，
`core/session-cwd.js:24-31`；`issue` 含 `{ sessionFile, sessionCwd, fallbackCwd }`）
→ 提示"这个会话的工作目录已不存在：<issue.sessionCwd>（先恢复该目录，或用终端 `pi` 打开）"，
并在 Output 记一行。**不静默**、也不自动 `cwdOverride`。

- **不要按 message 字符串匹配**（本类没从 bundle 导出，只能按 name，但 name 是稳定契约，message 不是）。
- **分层（评审 S4）**：分类在 controller（返回 `{ok:false, code:"missing-cwd", detail}`），
  文案在 host —— 与 D7 一致。
- **原子性已核实**（评审）：`assertSessionCwdExists` 在 `teardownCurrent` **之前**
  （`agent-session-runtime.js:135` vs `:136`）→ 失败时当前会话没被动过。

- **为什么**：pi CLI 在这里是**问用户要一个 cwd**（§3.6）；我们没有可信的 UI 去问
  （"把这一堆历史挂到哪个目录"是个危险决定），所以给明确提示、让用户去终端处理。
- **被否**：静默 `cwdOverride` 到当前 cwd —— 会让该会话里的相对路径含义悄悄改变。
- **断言**：`controller-check` 构造一个 header cwd 指向已删目录的会话文件 → 调用 → 断言
  抛出的错误被转成可读文案、**且当前会话没变**（失败必须是原子的：不能已经 teardown 了）。

### D10 列表里**永远**有"新建会话"项

**选择**：QuickPick 第一项固定为 `$(add) 新建会话`（无条件），其余是会话；
当前会话用 `$(check)` 前缀标（照 modelPicker 的规矩，**不用 `picked`**，`src/host/modelPicker.ts:64-72`）。
列表为空（或只有未落盘的）时，第一项照样在，另加一条说明项。

- **为什么**：§3.5 的落盘契约意味着"刚建的会话不在列表里"是常态 ——
  与其骗用户"列表就是全部"，不如让"新建"成为列表的一部分。
- **⚠️ 评审 B4 删掉了我原来的理由**：我说"pi TUI 的 selector 也是这么做的"——**写错了**。
  通读 `session-selector.js`（866 行）：它**只有会话条目，没有"新建"**；空列表时给的是
  `"  No sessions found"` / `"  No sessions in current folder. Press Tab to view all."`（`:355-363`）——
  pi 对"列表空的"的答案是**换 scope（Tab）**。我们没那个键位，QuickPick 也没底部提示行，
  入口只能放进列表 —— 结论不变，**理由换成这个**。
- **被否**：面板里再加一个"新建"按钮 —— 入口已经有两个（命令面板 + 列表首项），够用。
- **断言**：`host-check`：列表为空 → 仍有可回车的新建项；回车 → 发 `newSession`；
  `controller-check`：`list()` 结果里**不含**未落盘会话（锁住我们对 pi 契约的理解，pi 变了我们先红）。

### D11 纯函数（名字摘要、相对时间）放 `format.ts`，断言放 `tool-text-check`

**选择**：新增

```ts
export function sessionDisplayName(name: string | undefined, firstMessage: string): string; // 单行化 + 截断 60
export function formatSessionTime(then: Date, now: Date): string;                            // 刚刚 / 12 分钟前 / 今天 14:03 / 昨天 / 9月12日
```

`now` 显式传入（可断言），不读系统时钟。

- **为什么**：照 S4 D14 的先例（`format.ts` 的纯函数只在 `tool-text-check.mjs` 有一处断言；
  再开一个脚本会出现"同一函数两处期望"）。
- **⚠️ 我不确定的**：把时间格式化塞进 `tool-text-check.mjs`（那脚本名字是"工具正文"）是否合适 ——
  若评审认为脚本边界比"单一断言点"更重要，就新开 `scripts/session-format-check.mjs`（§14 A5）。
- **断言**：边界值：空名 + `"(no messages)"`、名字全是换行、超长名字截断到 60 且带省略号、
  时间跨"今天/昨天/更早"三条分支（含跨月边界的固定值）。

### D12 协议 v3 → v4：删掉 `state.model`

**选择**：`PROTOCOL_VERSION = 4`；删 `ServerMessage.state.model` 与 `ReplaySnapshot.model`
（`src/shared/protocol.ts:136-147` 的注释已经写明"等 S5 把两端都换完之后删掉"）。

- **为什么**：那条 deprecated 字段的存在理由就是"给旧 webview 兜底"，S5 正好是约定的清理点。
- **被否**：留着 —— 协议里不该有"两个真相"。
- **断言**：`protocol-check`：`state` 消息里**没有** `model` 键；`PROTOCOL_VERSION === 4`；
  `renderMeta` 只读 `meta`（`webview-dom-check` 里给一份不含 `model` 的 state 也要渲染正确）。

---

## 5. 风险与对策

| # | 风险 | 应对 |
| --- | --- | --- |
| R1 | **CLI 单方面改了编码规则 → 互通静默断掉，而我们的门禁全绿**（评审 B4；第 2 轮 B1 把守卫补回来了） | T10/T11 跑的是**我们自己打包的那份 pi**（`pi-runtime/`），而用户终端里的 `pi` 是**另一份独立安装**（实测：`which pi` → `~/.local/state/fnm_multishells/…/bin/pi` → 全局 node_modules，且有 `pi update` 自更新）—— **T10/T11 结构上打不到它**。对策：**T12 直接问那份 pi**（不再比版本号）：`which pi` → realpath → 包根 → `import(<包根>/dist/core/session-manager.js)` → `getDefaultSessionDir(cwd, agentDir)` → 与我们的 `resolveSessionDir` 比。**已实测可行**（本机跑通，不联网、不要模型：它算出 `~/.pi/agent/sessions/--Users-fengrui-Desktop-prj-jerrypi-vscode--`）；机制现成（`loader.ts:106` 已在用同一套 `import(pathToFileURL(…))`）。找不到 / import 失败 → **SKIP 并注明**（照 T5c 的 advisory 先例）。两条诚实的代价：① 会把用户那份 pi 加载进扩展宿主进程（一次性、try/catch 包住）；② 它只证明"路径算法一致"，**不证明"模型读得懂内容"** → §7 动作② 仍然要留 |
| R2 | cwd 是符号链接 / 大小写不同的路径（macOS 上 `/tmp` vs `/private/tmp`）→ 同一份代码在**两个**目录下各存一份会话，看起来像"会话丢了" | **已实测**：pi 自己也不归一化（`resolvePath` = `path.resolve`，§3.1），所以我们**跟着不归一化**（一致优先），并在 README 记一条"面板与 `pi` 要用同一个路径写法打开同一个项目"。**不修**（自己 `realpath` 反而会和 CLI 分叉得更厉害） |
| R9 | （评审 N2 + 我自己查的）CLI 侧有两个"整体搬走会话目录"的开关：环境变量 `PI_CODING_AGENT_SESSION_DIR`（`config.js:407`、`main.js:531-534`）与 `settings.json` 的 `sessionDir` 键（`settings-manager.js:450-452`）。优先级实测是 `--session-dir` > 环境变量 > settings。我们**不跟随** | 不跟随是刻意的（跟随会把目录推导从一份变成三份，而 S6 才管 agentDir）。但按评审 N6：**读一下这两个值成本极低** —— 检测到就在 Output 记一行"CLI 的会话目录被 <来源> 指到了 <路径>，面板不跟随"。不跟随的决定不变，但把"极难自诊"改成"一行日志就自诊"。它同时是 §13 Q2 的一个假设 |
| R3 | 会话文件很大（实测单文件 79KB，长会话可到 MB 级）→ `list()` 卡 UI | `showQuickPick` 传 Thenable，VS Code 自带加载态（照 modelPicker 的先例，`src/host/modelPicker.ts` 头注释第 3 条）；`list()` 自带 `onProgress`，**本步不用**（列表只有几条），真卡了再上 `createQuickPick` |
| R4 | 切换会话时把运行中的回合 teardown 掉 | D7 的守卫 |
| R5 | 重放与事件（`agent_start` 等）的**竞态**：重放拿到的到底是替换后的状态还是替换中的？ | D6 的顺序要求"替换成功后才重放"；`controller-check` 里用一条断言锁住：重放内容的 `items` 必须与新会话 `messages` 长度一致 |
| R6 | 我们改动语义后，`scripts/controller-check.mjs` / `selftest.ts` 的临时目录**仍然用旧写法** → 测试全绿但产品是坏的 | D2 的重命名强制编译失败 + §6 里"断言必须走 `resolveSessionDir`" |
| R7 | 版本漂移：`agent-session-runtime.js` 的 `switchSession` 将来改成 `open(path, sessionDir)`（不再用父目录） | 不依赖它：我们的列表只含当前目录，且 D6 的重放断言会在行为变化时先红 |
| R8 | **多个写者共用同一个 `.jsonl`**（评审 S5）：两个 VS Code 窗口开同一个文件夹、或面板与终端 `pi` 同时在场 —— D4 会让它们接管同一个文件；`_persist` 是 `appendFileSync`，各自的 `leafId` 在内存里独立 → 文件里长成两条交错的支 | 不改设计（避开它就得放弃与 CLI 互通，那是 G3）；但**说清楚**：① README 记一条"同一个项目的会话不要两边同时写"；② §7 动作② 指示用户跑完 `pi` 后**重新选一次会话**再接着打字；③ 风险点上加一句：旧版本会话文件被 `migrateToCurrentVersion` 触发 `_rewriteFile()`（`session-manager.js:677`，`openSync(…, "w")`）时**会真的覆盖**另一侧的追加 —— 所以"同时在场且版本不同"是最坏组合。**评审 S4 提醒还漏了最便宜的一档（检测，而不是加锁）**：记下该 `.jsonl` 的 `size+mtime`，在下一次 `prompt` 前比一次，变了就提醒"这个会话被另一个写者改过，建议重新选一次" —— 一次 `statSync` 的成本，正好把②那条人工纪律变成程序能提醒的事。**S5 不做，记为候选（写进本表就是不让 A9 看起来在回避它）** |
| R10 | （评审 N6）Windows 的盘符大小写：`workspace.ts:16` 用 `folder.uri.fsPath`（实测 VS Code 给小写 `c:\…`），CLI 的 `process.cwd()` 通常大写；`sessionCwdMatches` 是**严格字符串比较**（`session-manager.js:393-394`） | 今天的默认 agentDir 下我们**不受影响**（`filterCwd` 为 false，见 D1）—— 但**S6 一旦允许自定义 agentDir，`filterCwd` 就变成 true**，CLI 写的会话会被整批过滤掉。所以：写进风险表 + §8 W0 的期望里点名，并在 D1 的实现里加一条注释（“这个参数将来会变成过滤器”） |

---

## 6. 自动化检查（先红后绿）

**纪律**（承 S3/S4）：每个动作**先写断言、看红**，再实现；
`scripts/host-check.mjs` 的三条桩纪律不变（真输入、桩只在断言端、用真类与真 HTML）。

| 脚本 | 现在 | 本步新增/改动 | 数量（实施后回填） |
| --- | --- | --- | --- |
| `npm run typecheck` | ✅ 2 套 | `sessionsDir`→`sessionsRoot` 的强制改名、协议 v4 | — |
| `npm run check:protocol` | 112 | `SessionMeta.session` 必填且形状正确；`state` 里**没有** `model`；`PROTOCOL_VERSION === 4` | 112 → ? |
| `npm run check:render` | 110 | 无（渲染的断言在 dom-check） | 110 |
| `node scripts/tool-text-check.mjs` | 69 | `sessionDisplayName`（空名/全换行/超长截断）与 `formatSessionTime`（刚刚/分钟/今天/昨天/更早 + 跨月边界）的边界值 | 69 → ? |
| `node scripts/webview-dom-check.mjs` | 66 | ① 会话名段渲染 + 点击发 `openSessionPicker`；② **会话名是 `<img src=x onerror=…>` / `<script>`** 时不执行、以文本显示；③ `persisted:false` 显示"未保存"；④ 不含 `model` 键的 `state` 也能渲染；⑤ **会话名段的 `title`（或 `aria-label`）=== `meta.session.path`**，且 `path` 为空串时**定死**是"不设该属性"还是设空串（评审 S3：N3 把 `path` 留下来了，就得有人守它） | 66 → ? |
| `node scripts/host-check.mjs` | 39 | ① `openSessionPicker` 路由（空列表 → 有"新建"项）；② 控制器回调触发 → 恰好一条 `state`（**允许 0/1 条 `meta`**，评审 N3），且**每条发给 webview 的消息的 `type` 都落在协议的已知集合里**（评审 N2：别写"没有任何内部事件"这种无法执行的全称否定）；③ 被取消的替换（`{cancelled:true}`）→ **不发** `state` + 一条提示；④ 列表项选中 → 控制器收到**目标路径**（不是"弹出了"）；⑤ **忙时替换：恰好弹一次确认 + 不发 `state`；确认 → 发 `state`；取消 → 不发**（D7）；⑥ **断言发了那条 `[controller] 会话文件：<path>` 日志**（§7 动作② 靠它）；⑦ **`sessionToItem(info, currentPath, now)` 纯函数的三段（label/description/detail）与 `$(check)` 前缀**（评审 S2） | 39 → ? |
| `npm run check:controller`（真模型，不进 CI） | 59 | ① `dirname(新会话文件) === resolveSessionDir(cwd, root)`；② 重启等价物：`continueRecent` 恢复上一会话；③ `switchSession` 后 `snapshot()` 是新会话且白名单已重建；④ 列表全部在当前目录 + 已倒序；⑤ 未落盘会话不在 `list()`；⑥ 流式中替换：**两格**（`pendingSend===true && isIdle===true`（B2 的窗口）与 `isStreaming===true`）都要先返回"忙"且 `sessionFile` 不变，**确认后要真的换**（不能只测拒绝路径）；⑦ `cancelled` 时不换会话也不清状态 | **62/62**（实施后实测；总数会随模型是否调工具浮动，见 §11 的 1-5） |
| `npm run self-test`（**构建/打包**，`scripts/self-test.mjs`） | **9/9**（`TOTAL = 9`） | **不动** —— 它里面有一项是"12 个检查脚本都能解析"，所以"不加新脚本"（D11/N5）还顺带保住了这个数 | 9/9 |
| `Pi: Run Self-Test`（**门禁**，`src/pi/selftest.ts`） | **11 行**（10 gating + T5c advisory） | **T10 编码目录漂移守卫**：默认 agentDir + **真实 cwd**（需给 `SelfTestOptions` 加 `cwd`，S1）下 `usesDefaultSessionDir() === true`；非默认 agentDir 则 SKIP；**T11 模块级互通**：写入一条带 assistant 的会话，再用 `SessionManager.list(cwd)`（**不传 sessionDir**，即 CLI 的算法）把它列出来；**T12（advisory）直接问用户那份 pi**（R1，已实测可行） | **14 行**（12 gating + T5c/T12 两条 advisory） |
| `npm run package` + `check-vsix.mjs` | 338 文件 | 不新增文件（无新资源）→ 文件数应不变；体积不变 | 338 |
| **macOS 上的真实互通**（新脚本？） | — | **先不做成脚本**：G3 的 CLI 验收需要网络与真模型，且 `pi` 是交互式程序 —— 用 §7 的**一条命令**做人工验收。⚠️ 评审若认为可以脚本化（例如 `pi -p` 在 CI 里跑），见 §14 A6 | — |

**新增断言的"反例自查"**（S3 的教训：断言要能真的红）：
每一条新断言都要在**故意改坏**的情况下看一眼红，至少这几条必须做：
① 把 `resolveSessionDir` 的编码改成"不编码"→ T10 变红；
② 把 `onSessionReplaced` 的调用时机挪到替换**之前** → controller-check 的重放断言变红；
③ 去掉会话名的 `escapeHtml` → dom-check 的 XSS 断言变红；
④ 去掉 D7 的守卫 → 流式中替换的断言变红；
⑤ 把 T10 换成"只比 basename"的自造规则 → 这条断言应该变**弱**（提醒我们它比 `usesDefaultSessionDir()` 差）。

---

## 7. 人工验收 —— Mac（**用户只做 3 个动作**）

**标记规则**（同 S4）：每条标 `【自动】`/`【人工】`；`【人工】` 只允许属于四类 ——
①排版/外观 ②真焦点/真键盘 ③真进程 ④Windows 路径与 shell 形态。

| 项 | 谁来覆盖 | 归属 |
| --- | --- | --- |
| 新会话文件落在编码目录 | `controller-check` + 自测 T10 | 【自动】 |
| CLI 能打开扩展写的会话 | **必须真跑 `pi`**（另一份实现） | 【人工】动作 ② |
| 重启后自动恢复上一会话 | 真进程重启（扩展宿主生命周期） | 【人工】动作 ① |
| 列表内容/顺序/当前项 | `controller-check` + `host-check` | 【自动】 |
| 选中后转写换成那个会话（不带旧残留） | `controller-check` 的重放断言 | 【自动】 |
| 切换后 `Reload Webviews` 仍正确 | 快照断言（S2 已验同类） | 【自动】 |
| 忙时确认弹窗的**长相与交互** | 无头 DOM 没有真 QuickPick/真模态 | 【人工】动作 ③ |
| 元信息行多一段后的**版式**（窄栏下换行/挤压） | 无排版引擎 | 【人工】动作 ③ |

### 你要做的 3 个动作

**① 重启后自动恢复**：在本仓库窗口里聊两句（有一轮完整回复）→
命令面板 `Developer: Reload Window` → 面板应**自动**显示刚才那段对话
（准确说："文件最后被写过的那次会话"，见 §3.2），且元信息行的会话名段**不是**"新会话"。

**② 一条命令验互通**（G3 的核心，必须在 Mac 上做 —— 受限机没有 `pi`）：

- 先在 Output（`Ctrl+Shift+U` → jerrypi）里找到最近一行 `[controller] 会话文件：<路径>`
  （**这行日志是本步的交付物，见 §9 第 2 步** —— 评审 B5 发现原计划命令它，但仓里根本没有这行）；
- 在终端里跑（`-p` 是非交互，一句话就退）：

  ```bash
  pi --session "<粘贴的路径>" -p "用一句话说我们上面聊了什么"
  ```

- **期望**：`pi` 不报错，回答内容与面板里那段对话对得上。
  （这就是"另一份实现能读我们的文件"——比自己读自己强。）
- **跑完请点一次 `Pi: Resume Session` 重新选这个会话**，不要在面板里直接接着打字
  （评审 S5：此时文件已经被那个写者改过，面板内存里的 `leafId` 还停在旧位置）。
- ❗ **这条验收不是一个一次性动作，有复跑触发条件（评审 B4）**：
  `pi --version` 与我们打包进 VSIX 的 pi 版本**不一致时**（即你升级了终端里的 `pi`），
  **必须重跑动作②**。理由见 R1：自测跑的是我们自己那份 pi，**看不见 CLI 侧的漂移**。

**③ 看一眼两处外观**：
- 元信息行现在是 `会话名 · 模型 · 等级 · 0.0%/1.0M` —— 窄栏（把侧边栏拖窄）下**不换行、不挤压**；
- 生成中（发一条长回复）点 `Pi: Resume Session` 或 `Pi: New Session` →
  弹一个确认（**这是真·模态/QuickPick，无头 DOM 测不了它长什么样**）：
  - 点「取消」→ 会话没变（元信息行的会话名不变）；
  - 再试一次、点「继续」→ 切过去了（旧会话那一轮被中止并已落盘）。

---

## 8. 人工验收 —— Windows（**3 项**）

| # | 步骤 | 期望 | 标记 |
| --- | --- | --- | --- |
| W0 | `Pi: Run Self-Test` | **期望写成：`GATE PASS`，12 个 gating 项全 PASS，T5c/T12 为 advisory** —— ⚠️ **不要写 `11/11` 或 `n/n` 这种格式**：`computeGate()` 只返回字符串，那个数字是人工数出来的（评审 B2 指出 §3.9/§6 原先写的"9 项"是错的：实际是 **10 gating + T5c**；
（但 `docs/STATUS.md` 那句 9/9 是对的、勿改 —— 见 §3.9 的头注释）。新增 T10/T11 在**受限机路径**上要过（Windows 路径含 `\` 与 `C:`，正是编码规则的最坏情况）；T12 在受限机上必然 **SKIP**（没有 `pi`），这也是对的。**顺便（评审 N6）**：受限机上 VS Code 给的盘符是**小写** `c:\…`，而它自己的 shell 报大写；今天不影响列表（`filterCwd` 为 false），S6 允许自定义 agentDir 后**会**影响 → 请把实际看到的两种写法写进报告 | 【人工】真进程 |
| W1 | 重启 VS Code → 面板 | 自动回到上一会话（转写完整） | 【人工】目标机重启 |
| W2 | `Pi: Resume Session` → 选另一个 → 输入框里接着打字 | 转写换成那个会话、不带旧内容；打字能打进去 | 【人工】真进程 + 真焦点 |
| W3 | README 已知限制**新增的每一条**（评审 S5：不能只核"旧布局会话"那一句） | 逐条与面板实际行为对一遍：① 旧布局会话列表里看不到；② 启动会自动接过**文件最后被写过**的那次会话（包括终端里那次）；③ 忙时切会话会先弹确认（D7）；④ 两边要用同一种路径写法（符号链接）；⑤ 不要两边同时写同一个会话；⑥ CLI 的两个搬家开关（`PI_CODING_AGENT_SESSION_DIR` / `settings.json` 的 `sessionDir`）我们不跟随 | 【人工】文档核对 |

**不做**的验收项（说明理由，免得看起来是漏了）：
- **CLI 互通**：受限机没有 `pi`（不能装 Node）→ 只能在 Mac 上验（判据本来就是两台机器各验一半）；
- **`MissingSessionCwdError` 的提示文案**：由 `controller-check` 覆盖（构造一个 cwd 已删的会话文件），
  真机上要删目录才能造，不值一个动作。

---

## 9. 实施步骤（提交切分）

> 每步都"先写断言、看红、再实现"（§6 的反例自查）。
> 提交切分的原则与 S4 相同：**每一步结束时仓库是可用的**，且门禁全绿。

1. **`src/pi/sessions.ts` + 目录语义修正（D1/D2）**
   新建 `sessions.ts`（`resolveSessionDir` + `list`/`continueRecent` 封装）；
   `sessionsDir` → `sessionsRoot` 并让编译器抓所有误用点；改 `selftest.ts` / `controller-check.mjs`
   的临时目录；**给 `SelfTestOptions` 加 `cwd` 并由 `commands.ts` 从 `workspaceCwd().cwd` 传入**（S1，
   没有它 T10 会静静地退回临时 cwd）；加 T10/T11/T12 与 §6 的目录断言。
   *交付判据*：新会话文件在编码目录里；`list(cwd)`（不传参）能列出它；T12 在本机能报出
   "两份 pi 算出来的目录一致"。
2. **启动即恢复（D4）+ 会话替换后重放（D6，含修掉 §3.7 缺口 A）**
   *交付判据*：重载窗口回到上一会话；`Pi: New Session` 后面板清空；
   **会话建立与每次替换后 Output 各记一行 `[controller] 会话文件：<绝对路径>`**
   （`session.sessionManager.getSessionFile()`，`agent-session.d.ts` 里是 public）——
   它是 §7 动作② 的前置，host-check 里要断言它出现过（评审 B5）。
   **必测两格**：被取消的替换（`{cancelled:true}`）不换会话也不清状态（评审 S1）。
3. **切换的守卫与错误处理（D7/D9）**
   *交付判据*：忙时切会话**先弹确认**（取消则会话不变、确认则切且旧会话那轮已落盘）；
cwd 不存在的会话切不动且给可读提示、当前会话不变。
4. **列表 UI + 会话名段（D5/D8/D10/D11）+ 协议 v4（D12）**
   *交付判据*：`Pi: Resume Session` 能列能选；元信息行显示会话名；`state` 里没有 `model`。
5. **文档（D3/R2/R8/R9）**：README 的"会话管理"从 Planned 改为 Implemented；已知限制**逐条写清单**（评审 S5：写清单才可验收）——
   ① 旧布局会话看不到 + 恢复命令；② 启动自动恢复（官方说法：**文件最后被写过**的那次，含终端那次）；
   ③ 流式中替换被拦；④ 两边要用同一种路径写法（符号链接/盘符大小写）；⑤ 不要两边同时写同一个会话；
   ⑥ CLI 的两个搬家开关（`PI_CODING_AGENT_SESSION_DIR` / `settings.json.sessionDir`）**我们不跟随**
   （并加 R9 的那行 Output 检测日志）。
   另：`docs/PLAN.md` §6 的 S5 行与 §5 文件清单改正（`<agentDir>/sessions` 的误解）。
   `docs/STATUS.md` 更新 —— **注意：它那句 `npm run self-test` 9/9 是对的、不要改**
   （本轮实跑确认它指构建检查 `TOTAL = 9`，不是 `Pi: Run Self-Test` 的 11 行；§3.9 已把两者分清）。
6. **打包 + 自测 + Mac 验收（§7）**：`npm run package` → `node scripts/check-vsix.mjs` →
   用户在**本地构建**上做那 3 个动作（F5 / 本地 .vsix 都行）。
   **为什么 Mac 在发布之前**：别把 Mac 上就挂掉的包发出去；S4 就是这么走的
   （§9 第 8 步：打包 → 自测 → Mac 2 个动作 → 发 0.1.6 → Windows）。
7. **发布 0.1.7 预发布**（STATUS §4 的流程：用户手动上传 → `compare-vsix.mjs 0.1.7` →
   `git tag -a v0.1.7`）。
8. **Windows 验收（§8）→ 回填 §12 → 阶段关闭**。
   （受限机只能从 Marketplace 装，所以 Windows 必然在发布**之后**。）

---

## 10. 评审记录

**评审者**：Claude（herdr 面板里已开着的会话，与本计划同一工作目录）。
**纪律**（承 S4）：**≤3 轮**；第 3 轮只做转录核对、不审设计；每轮结论**立刻落盘**到本节点（断点恢复锚点）；
每一条意见记 `ACCEPT` / `REJECT`（附实质理由）/ `DEFER`（附在等什么）。
评审者只读：不得修改任何文件。

### 第 1 轮（Claude，2026-09-13，8,427 字；会话 `3e99701f-…`；结论 `VERDICT: BLOCKING`）

> 我已经自己核对了每一条引用的源码行（抽查 `teardownCurrent`、`isIdle`、`emitBeforeSwitch`、
> `findMostRecentSession`、`sessionCwdMatches`、`config.js:407`、`which pi`）—— **除一处外全部属实**。
> 唯一一处需要纠正的是 N2 提到的变量名：`config.js` 里搜字面量搜不到（它用 `APP_NAME` 拼），
> 但 `ENV_SESSION_DIR` 的值**确实**是 `PI_CODING_AGENT_SESSION_DIR` → **该条也成立**。

**BLOCKING（5）**

| # | 意见 | 处置 | 理由 |
| --- | --- | --- | --- |
| B1 | D7 的理由与源码相反：`teardownCurrent()` 先 `await session.abort()`，被中止的回合**会**落盘（`agent-session-runtime.js:102-105`） | **ACCEPT** | 已核对原文与注释，我说的"静默 teardown 会丢数据"**是错的**。D7 改为只留两条 UX 理由；A2 一并改 |
| B2 | D7 的守卫谓词漏掉"已发送但 `agent_start` 未到"的窗口（`isIdle` 只看 `_isAgentRunActive && isCompacting`） | **ACCEPT** | 已核对：`agent-session.js:620-622`，而本仓 `controller.ts:185-187` 自己就为这个窗口维护 `pendingSend`。谓词改成 `pendingSend \|\| !isIdle`，并新增一格断言。顺带记下 pi 的"注释写含队列、实现不含" |
| B3 | T10 的漂移守卫会往用户真实 `~/.pi/agent/sessions/` 下创建目录；且漏了 pi 自己的 `usesDefaultSessionDir()` | **ACCEPT** | 已核对 `create(cwd)` → `getDefaultSessionDir()` → `mkdirSync`（`:248-253`），且 `usesDefaultSessionDir()`（`:730-732`）是全路径相等、确实更强。T10 改成真实 cwd + `usesDefaultSessionDir()`，非默认 agentDir 则 SKIP |
| B4 | T10/T11 跑的是我们自己打包的 pi，**打不到 CLI 侧的漂移**；R1 的"pi 升级后第一条就红"不成立 | **ACCEPT**（最重要的一条） | 已实测 `which pi` 指向另一份独立安装（且有 `pi update` 自更新）。删掉那句不成立的话；加 advisory T12；把 §7 动作② 改成**有复跑触发条件的人工守卫** |
| B5 | §7 动作② 依赖一条现在不存在的 Output 日志（仓里没有任何地方打印会话文件路径） | **ACCEPT** | 已核对：`controller.ts` 只有 `:271` 那行。已把"记一行 `[controller] 会话文件：<path>`"写进 §9 第 2 步的**交付判据**，并加 host-check 断言 |

**SHOULD-FIX（5）**

| # | 意见 | 处置 | 理由 |
| --- | --- | --- | --- |
| S1 | `{cancelled}` 返回值全程没提；取消时不清 rebind，而 D6 却会先清状态再重放 | **ACCEPT** | 已核对 `emitBeforeSwitch`（`:78-88`）与 CLI 的检查点。`resetLiveState()` 挪到替换**成功之后**，取消则不重放、给提示 |
| S2 | "最近一次会话"有两个排序键：`continueRecent` 用 **mtime**，`list()` 用**消息活动时间** | **ACCEPT** | 已核对 `findMostRecentSession` 的 `statSync(path).mtime`（`:397-409`）。§3.2 补上分叉说明；文案统一为"文件最后被写过的那次会话"；并**禁止**写"第一条就是当前项"的断言 |
| S3 | D6 的拦截点在现有代码里不存在（`controller` 直连 `provider.post`，chatView 无出站拦截层） | **ACCEPT** | 已核对 `extension.ts:42`。改成**宿主回调 `onSessionReplaced`**（比协议消息干净），并把 host-check 扩成"回调→恰好一条 state + 任何内部事件不被当协议消息转发" |
| S4 | 守卫/报错住在哪一层没定，断言归属自相矛盾（controller 拿不到 `vscode.window`） | **ACCEPT** | D7/D9 都改成：分类在 controller（返回带 code 的结果），文案/弹窗在 host |
| S5 | D4 打开了"多个写者共用同一个 `.jsonl`"的场景，风险表里没有；而 §7 动作② 直接指示用户这么干 | **ACCEPT** | 新增 R8；§7 动作② 加"跑完重新选一次会话"；并把 `migrateToCurrentVersion` 的 `_rewriteFile()`（`:677`）那格最坏组合写进去 |

**NIT（6）**

| # | 意见 | 处置 | 理由 |
| --- | --- | --- | --- |
| N1 | `MissingSessionCwdError` 有结构化 `issue`，不必按 message 匹配 | **ACCEPT** | D9 改成按 `error.name` + `issue` 判定 |
| N2 | `PI_CODING_AGENT_SESSION_DIR` 环境变量会让 CLI 整体搬家（与那 14 个平铺文件症状一模一样） | **ACCEPT** | 已核实（`config.js:407` 用 `APP_NAME` 拼出该名，`main.js:531-534` 读它）。写进 R9，并给 §13 Q2 多一个假设 |
| N3 | `SessionMeta.session.path` 前端用不到，与"协议里不该有两个真相"相抵 | **ACCEPT（改法）** | 不删字段，而是**给它一个用途**：会话名段的 tooltip 显示绝对路径（§7 动作② 也要靠它）。不用就删，不白留 |
| N4 | `modified` 的回落链不完整（无活动时间 → header 时间戳 → `stats.mtime`） | **ACCEPT** | §3.2 已改 |
| N5 | 几处行号微差（`handleResumeSession` 4502、选择器 4477-4499、`isPersisted` 720-722 等） | **ACCEPT** | 已改。其余抽查全部对上（我另核了 `:245-246`、`:1127`、`:1164`、`:1207`、`:1247-1252`、`:1316`、`agent-session-runtime.js:134/135/154`） |
| N6 | Windows 盘符大小写 + `sessionCwdMatches` 严格比较 → S6 允许自定义 agentDir 后（`filterCwd` 变 true）会整批过滤掉 CLI 写的会话 | **ACCEPT** | 已核对 `session-manager.js:393-394` 与 `list()` 的 `filterCwd` 条件。新增 R10，并在 §8 W0 里点名 |

**本轮我自己额外查出的问题**（评审没提，但没人提也得处理）：

- **`settings.json` 的 `sessionDir` 键**（`core/settings-manager.js:450-453`）—— CLI **会**尊重它，我们**不**尊重
  → 与 N2 同属 R9（两个"整体搬家"开关，不是我一个）。
- **pi 的 `isIdle` 注释与实现不一致**（注释含队列，实现只有 agent run / compaction）
  → 写进 D7，作为"我们为何不直接用 `isIdle` 当唯一判据"的依据。
- **旧布局那 14 个文件的另一种可能解释**：`PI_CODING_AGENT_SESSION_DIR` 被设过
  （如果用户在某个 shell 配置或 harness 脚本里设过，CLI 就会写到平铺且跳 cwd 分目录）
  → 写进 §13 Q2。本机当前 `env | grep PI_` 里**没有**这个变量。

### 第 2 轮（Claude，2026-09-13，6,854 字；同一会话；结论 `VERDICT: BLOCKING`）

> 我逐条回查了它的新引用（`session-selector.js`、`selftest.ts:60`、`agent-session.js:773-784`、
> `SelfTestOptions`）—— **全部属实**；其中 B1 我亲自跑了一遍才收下（见下）。
> **15 条意见：14 条 ACCEPT、1 条部分 REJECT（B2 里关于 `docs/STATUS.md` 的那半句，附实测依据）**。
> 分布：4 BLOCKING / 5 SHOULD-FIX / 6 NIT。

**BLOCKING（4）**

| # | 意见 | 处置 | 理由 |
| --- | --- | --- | --- |
| B1 | A6 可证伪：**不联网也能问用户那份 pi** 算出来的目录（它带未打包的 `dist/core/session-manager.js`）；T12 的"比版本号"两头都不准 | **ACCEPT**（本轮最重要） | 我实跑了一遍：从 `which pi` realpath 到包根 → `import(<包根>/dist/core/session-manager.js)` 成功，`getDefaultSessionDir(cwd, agentDir)` 返回 `~/.pi/agent/sessions/--Users-fengrui-Desktop-prj-jerrypi-vscode--`，**不联网、不要模型**。R1 从"诚实的降级"变回真守卫；T12 改成直接比对（找不到则 SKIP） |
| B2 | 自测项数的基线写错了：`REQUIRED_ITEMS` 是 **10** 项（+T5c = 11 行），`computeGate()` 只返回字符串不带数字 | **ACCEPT（大部分）+ REJECT（一句）** | **接受**：`Pi: Run Self-Test`（`src/pi/selftest.ts`）确实是 10 gating + T5c = 11 行，`computeGate()` 返回裸字符串 —— 我原来在 §3.9/§6 写"9 项"是错的，已改；§8 W0 不再写 `n/n`。**驳回**：`docs/STATUS.md` 那句 **9/9 是对的、不能改** —— 它指的是 `npm run self-test`（`scripts/self-test.mjs` 的 `TOTAL = 9`，构建/打包检查），我在本轮末尾实跑了一遍：`SELF-TEST OK (9/9)`。评审把两个同名东西当成了一个；已把"两个 self-test"写进 §3.9 的头注释防后再犯 |
| B3 | A1 的二选一是假的："不自动恢复"**不等于**放弃互通（互通由 D1 的写入位置决定，与"启动开哪一个"正交） | **ACCEPT** | 跟前一轮 B1 同一类错误（用一个不成立的代价支撑推荐值），而这条正要送给用户拍板。A1/Q1 已改成两条真代价：多一次点击 + README:167 那条限制继续存在 |
| B4 | D10 的理由"pi TUI 的 selector 也这么做"不成立：它只有会话条目，空态是 `No sessions found` / `Press Tab to view all` | **ACCEPT** | 已核对 `session-selector.js:355-363`（且全文没有"新建"条目）。结论保留（VS Code 的 QuickPick 没有 Tab 换 scope），**理由换掉** |

**SHOULD-FIX（5）—— 全部 ACCEPT**

| # | 意见 | 处置 | 理由 |
| --- | --- | --- | --- |
| S1 | T10 要的"真实 cwd"，`runSelfTest` 拿不到（`SelfTestOptions` 没有 `cwd`）→ 实现者会静静退回临时 cwd | ACCEPT | 已核对 `selftest.ts:40-48`。写进 §9 第 1 步的交付判据；"没打开工作区时是 `homedir()`，断言照样成立"也补进 D1 |
| S2 | §1 目标 3 里"名字/时间/消息数/当前项"的**组装**那一步没人管 | ACCEPT | S4 的 `modelToItem` 就是为此单独导出的。新增 `sessionToItem(info, currentPath, now)` + host-check ⑦ |
| S3 | D8 的 tooltip 是本轮新增的承诺，却没有断言（N3 的问题换了个位置） | ACCEPT | dom-check 新增⑤，并**定死** `path` 空串时的行为（否则两种实现都能过） |
| S4 | R8 的备选少了最便宜的一档：**检测**（`size+mtime` 变了就提醒），而不是加锁 | ACCEPT | 已写进 R8（S5 不做，记为候选）。它正好把 §7 动作② 里那条人工纪律变成程序能提醒的事 |
| S5 | README 本轮新增的 4–6 条承诺没有验收项 | ACCEPT | W3 改成"新增的每一条逐条核对"，§9 第 5 步列清单 |

**NIT（6）—— 全部 ACCEPT**

| # | 意见 | 处置 | 理由 |
| --- | --- | --- | --- |
| N1 | 我那句"`isIdle` 不看队列"会误导后人：续跑循环整段都在 `_isAgentRunActive = true` 里 | ACCEPT | 已核对 `agent-session.js:773-784`（`_emitAgentSettled()` 在循环之后）。措辞已改；真正的缺口只有 `agent_start` 前那个窗口。可选再加 `pendingMessageCount > 0` |
| N2 | host-check ② 的"没有任何内部事件"是无法执行的全称否定 | ACCEPT | 改成可执行版：断言每条发给 webview 的消息 `type` 都在协议已知集合里 |
| N3 | D6 里 `publishMeta()` 是多余的一跳 | ACCEPT | 保留但写明"允许 0/1 条 `meta`"，免得以后有人把它收紧成"恰好一条消息"而误伤 |
| N4 | §3.8 的"cwd 全是 `/Users/fengrui`"其实是**支持**"是 jerrypi 写的"的指纹（`workspace.ts:18` 的 homedir fallback） | ACCEPT | 结论不改，**推荐理由换成**"即使确实是我们写的，也不替用户移动历史文件；恢复命令零风险"（比"没确证所以不敢动"站得住，也不会在用户答"那就是我的"之后失效） |
| N5 | A5：维持"`format.ts` 只有一处断言点"是对的，不必改名 | ACCEPT | 只在 `tool-text-check.mjs` 头注释加一句"本脚本覆盖 `format.ts` 的**所有**纯函数" |
| N6 | R9 可以不止写 README：**读一下**那两个开关，命中就记一行日志 | ACCEPT | 优先级已实测：`--session-dir` > 环境变量 > settings。"极难自诊"变成"一行日志就自诊" |

**本轮无 DEFER；15 条意见里 14 条 ACCEPT、1 条（B2 的 STATUS 那半句）REJECT 并附实测依据。**

### 第 3 轮（Claude，2026-09-13，1,527 字；同一会话；**只核对转写、不审设计**）

结论 `FAITHFUL: NO`（3 处转录/落点不一致）+ `DISPUTE(STATUS 9/9): ACCEPT-MY-REJECT`。

| # | 不一致 | 处置 |
| --- | --- | --- |
| M1 | §10 第 2 轮引言写"15 条全部 ACCEPT"，与同节 B2 行及结尾的"14 ACCEPT / 1 REJECT"矛盾 | **ACCEPT**，已改成"14 条 ACCEPT、1 条部分 REJECT"（将来只读引言的人不会被误导） |
| M2 | §3.9 表格首行仍把两个 self-test 混在一起（命令名是 `npm run self-test`，文件与行数是 `src/pi/selftest.ts`） | **ACCEPT**，已把那行改成 `Pi: Run Self-Test` —— 它正好是刚立的头注释要防的错，B2 的落点没落全 |
| M3 | §8 W0 的括注把"STATUS 的 9 项也是错的"记到了评审名下 | **ACCEPT**，已删掉括注里的 `STATUS`（否则计划里同时在说"这句错"和"这句对"） |

**转写核对的总结论**：15 条意见本身一条不多一条不少、编号与要点全部对得上，
处置理由也没有曲解原意（包括 B1 的"已实测跑通"、B4 的"结论留理由换"、S4 的"S5 不做记为候选"）。
不一致全在我自己的落点上，已修。

**评审收敛：三轮已用尽**（第 3 轮按纪律不审设计）。未解决分歧：无。

### 10.1 评审结束后的改动（**未经复核**）

> 按纪律：三轮上限之后写进计划的改动，**没有任何人复核过**。
> 这里逐条列清，不假装它们"已解决、无遗留"。

| # | 触发 | 改了什么 | 影响面 |
| --- | --- | --- | --- |
| U1 | **用户 2026-09-13 拍板**：D7 从"拦死"改为"**问一句**"（忙时弹确认：继续则中止并切换，取消则不动） | D7 全文重写（含代码注释里的谓词说明、被否列表、断言）；§6 的 host-check ⑤ 与 controller-check ⑥ 改成三态（忙→确认→继续/取消）；§7 动作③ 与验收表、§8 W3 ③、§9 第 3 步的措辞；§13 Q3 标为已拍板 | 实现工作量基本不变（谓词与分层都没动，只是把"拒绝"换成"确认"）；**多出一条断言**（确认后必须真的切 —— 否则"确认了仍然不切"会静静通过） |
| U2 | 同一次讨论：把"**真·后台并行**"（切走让旧会话继续跑）明确划出 S5 | §2 表新增一行；D7 的"被否"里记下理由（`AgentSessionRuntime` 只持一个会话 / 需要多会话宿主 / R8 的两个写者） | 无实现影响（只是把一条边界写下来，免得以后再问一遍） |
| U3 | **用户 2026-09-13 拍板"都按默认"** | §13 的 Q1、Q2、Q4、Q5、Q6 全部定案（与建议的默认值一致，无偏离）；§13 标题改为"已全部拍板" | 无 —— 没有一条改动了计划的设计，只是把待定变成定案 |
| U4 | 用户问"是不是全部做完才由我测试"时发现：§9 把**发布**写在了**两次验收之前** | 重排 §9 的 6/7/8：打包 + 自测 + **Mac 验收** → 发布 0.1.7 → **Windows 验收** | 与 S4 的实际流程一致（`S4-plan §9` 第 8 步："打包 → 自测 → Mac 2 个动作 → 发 0.1.6 → Windows"）。动因是真实的：Mac 能在本地构建上验，受限 Windows 机只能从 Marketplace 装 |

**这几条要不要补一轮评审？** 我的判断：**不补**。U1 是产品取舍（已由用户拍板），U2/U4 是划界与顺序；
它们都不新引入事实论断 —— 除了 D7 里那句"Codex/Claude 的插件能把会话跑在后台"，
它**我已经标注了"未在本机实测"**（本机只验证了 `claude` / `codex` 是原生可执行文件、
且那两个插件没装在这台机器上）。若你（用户）认为这句也要核，就在你日常用的编辑器里花 30 秒验一下。

---

## 11. 实施期发现的问题 / 偏离计划的地方

### 第 1 步（会话目录语义修正，2026-09-13）

| # | 现象 | 原因 | 处置 |
| --- | --- | --- | --- |
| 1-1 | 计划里写的自测项数不对 | 本项目有**两个**同名的 self-test（评审 B2 混了，我也混了） | 已在 §3.9 加"两个 self-test"的头注释；本步实际结果：`Pi: Run Self-Test` = **14 项（12 gating + T5c/T12 advisory）/ 14 PASS / GATE PASS**；`npm run self-test` 仍是 9/9 |
| 1-2 | VSIX 文件数从 338 变 339 | `.pi/settings.json`（dfbac0f 于 19:11 加进仓库）被 vsce 打进了包 —— `.vscodeignore` 里没有 `.pi/**`。发布版 0.1.6 的 VSIX 里确认没有它（unzip 验过），所以 338 这个基线是对的 | `.vscodeignore` 加 `.pi/**` 并注明理由（pi 的项目级设置只从**工作区 cwd** 读，扩展目录里那份进包是死重） |
| 1-3 | 排除 `.pi/**` 后还是 339 | `media/jerrypi-mark-j.svg`（20:44 出现的**未跟踪**文件，全仓无人引用，内容是"jerrypi 候选 mark"的 SVG）也会进包 | **没动它**：不是我的文件、不是 S5 的东西。每次包数要对照实际，别拿 338 当硬门禁 |
| 1-4 | T12 两次报 `SKIP E_NO_PI`（看着像"这台机器没装 pi"） | 我自己新写的 `findOnPath` 两个 bug：① 用 `sep` 拆 PATH（应该用 `delimiter`，POSIX 是 `:`）；② 用 `lstatSync().isFile()` 判断可执行，而 npm/fnm 装的 `pi` 是指向 `dist/bundle/cli.js` 的**符号链接**（`lstat` 看到的是链接自身） | 两处都修了（改用 `delimiter` + `statSync`）。教训：**SKIP 必须能区分"真的没有"与"我找错了"** —— 两条都是静默的，不跑真的根本发现不了 |
| 1-5 | `controller-check` 冒出两条与 S5 无关的红：`upsert 之后只剩一个 assistant 节点`、`最终文本非空` | 那两条（S2 时代）假设"模型这一轮不调工具"；实跑中模型对"写一段海洋介绍"调了一次工具 → 多出一个 assistant 节点。在 HEAD 上跑一次是 **59/59 全绿**，所以是**模型侧抖动**，不是 S5 引入的 | **未修，记在这里**：它是门禁的一个真实弱点（会让"改完必须全绿"变得不可信）。候选：把那句 prompt 改成不可能触发工具的形态。（S5 不动它，避开顺手改无关断言） |
| 1-6 | 计划 D2 说"测试也不再自己拼目录"，而我在 `controller-check` 里**复刻了一份编码规则** | 那是故意的：断言要**独立于被测实现**（否则实现改错、断言跟着改，两边一起错），与 S1 的"隔离目录 import"同理 | 已在那段代码上方写明理由。D2 的本意只针对 `sessionsRoot` 那一层（别再把"根"当 pi 的 `sessionDir` 传） |
| 1-7 | `npm run package` 把仓库根那份 `jerrypi-0.1.6.vsix` 覆盖了 | 它是 gitignore 的构建产物，而 `npm run package` 就地重建 | 无害（权威副本在 `~/jerrypi-releases/jerrypi-0.1.6.vsix`），但意味着根目录那份**不再与发布版逐字节相同**，别拿它当发布物的参照；S5 发布的是 0.1.7 |
| 1-8 | 我自己的一次 edit 把 `controller.ts` 注释里的 `setRuntimeApiKey` 误改成了 `setRuntimeKey` | 编辑工具的模糊匹配（我的 `oldText` 写错了却仍然命中） | 看 `git diff` 时发现并改回。教训：**改完一定看 diff**，尤其是极小改动 |

**第 1 步的红→绿证据**（§6 的反例自查 ①）：

- 改写前，`controller-check` 的两条新断言是**红的**：
  `期望 …/sessions/--var-folders-…-cwd--｜实际 …/sessions`（即会话平铺在根上）；
- 实现后：`controller-check` **62/62**（HEAD 是 59/59；差值不完全是"我加的 2 条" ——
  检查总数会随模型是否发起工具调用而变，见 1-5）、闸门 **14/14 GATE PASS**
  （T10/T11/T12 明细：`ours==pi`、`pi 的 list(cwd) 看到了它`、`与终端那份 pi（…/dist/bundle/cli.js）一致`）。

---

## 12. 实施与验收结果

### 12.1 自动检查
### 12.2 提交切分（实际）
### 12.3 人工验收
### 12.4 已知未覆盖

---

## 13. 待用户拍板（**2026-09-13 已全部拍板：Q1–Q6 均按默认**）

| # | 问题 | 定案 | 备选（未采用） |
| --- | --- | --- | --- |
| Q1 | 窗口启动时自动恢复还是新建？ | ✅ **自动恢复**（含终端里那次；官方说法：文件最后被写过的那次会话） | 仍新建，用户自己点"恢复" |
| Q2 | §3.8 那 14 个平铺遗留会话要不要搬？ | ✅ **不搬**（不替用户移动历史文件），只给恢复命令 | 加一个一次性 `Pi: Migrate Legacy Sessions` 命令 |
| Q3 | 流式期间切会话？ | ✅ **问一句**（忙时弹确认：继续则中止并切换，取消则不动） | 静默切（对齐 CLI）；拦死 |
| Q4 | 会话重命名现在做吗？ | ✅ **不做**（名字先取首条 user 消息；`appendSessionInfo` 那条路记着） | 在列表项上加"重命名" |
| Q5 | 列表要不要加"其他项目"的会话（`listAll`）？ | ✅ **不做**（只列当前 cwd；避开 §3.4 的 sessionDir 语义变化） | 加一个分组 |
| Q6 | `Pi: New Session` 也加同一个确认？ | ✅ **接受**（两个入口一致；行为变更写进 README） | 只给 `Resume` 加守卫 |

| # | 问题 | 我的推荐（默认） | 备选 |
| --- | --- | --- | --- |
| Q1 | 窗口启动时**自动恢复**上一会话，还是仍然新建？ | **自动恢复**。理由只有两条（评审 B3 删掉了第三条假代价）：① G3 的字面要求；② 与 `pi -c` 一致 | 仍新建。（**代价只是**：重启后要多点一次"恢复"，且 README:167 那条"重载窗口会开始新会话"的限制会继续存在 —— **不会**影响互通，文件该写在哪还是写在哪） |
| Q2 | §3.8 那 14 个平铺遗留会话要不要我搬进编码目录？ | **不搬**（即使确实是我们写的 —— 理由是不能替用户移动/改写历史文件，而不是"没确证"），只给恢复命令（`pi --session-dir ~/.pi/agent/sessions --resume`，在 `~` 下跑）。**它们更像就是 jerrypi 写的**（评审 N4：`workspace.ts:18` 在没打开工作区时 fallback 到 `homedir()`，正好对上那批 cwd 全是 `/Users/fengrui`），但这对结论没影响 | 加一个一次性 `Pi: Migrate Legacy Sessions` 命令。**判断它们来历的三个可查项**（评审 N2 后新增）：① 你是否在 shell 配置 / 环境变量里设过 `PI_CODING_AGENT_SESSION_DIR`（当前 shell 里没设）；② `settings.json` 里有没有 `sessionDir`（现在没有）；③ 是否用过某个直调 pi SDK 并传了 `~/.pi/agent/sessions` 当 sessionDir 的脚本 |
| Q3 | 流式期间切会话：拦死 / 静默切（对齐 pi CLI）/ 问一句？ | **问一句** ✅**用户 2026-09-13 已拍板**（弹确认：继续则中止并切换，取消则不动） | 静默切（与 CLI 一致）；拦死（本计划第 1/2 轮的默认值） |
| Q4 | 会话重命名（`appendSessionInfo`）现在做吗？ | **不做**（本步已经不小；名字先取首条消息） | 在列表项上加"重命名"（pi TUI 有） |
| Q5 | 列表要不要加"其他项目"的会话（`listAll`）？ | **不做**（会让 `newSession` 落到别的项目目录） | 加一个分组 |
| Q6 | `Pi: New Session` 的流式守卫（D7）会改变现有行为，接受吗？ | **接受**（两个入口一致） | 只给 `Resume` 加守卫 |

---

## 14. 我不确定、请评审重点打的地方

> 这一节是给评审者的靶子：以下每条我都没有充分把握，**请优先攻击**。

| # | 我的假设 | 为什么可能错 |
| --- | --- | --- |
| A1 | **D4 的"启动自动恢复"是对的默认值** | 它会让"打开窗口"从"干净开始"变成"接过上次"，包括**终端里那次**。**【已修正】**我原来写的"否则就得放弃互通"是错的（评审 B3）：互通由 D1 决定，与启动开哪个会话无关。剩下的是一个纯产品判断，而你只需要看 Q1 那两条真代价 |
| A2 | ~~D7 的"拦"是安全的那一侧~~ → **已由用户拍板结案**：不是"拦死"而是"问一句"（忙时弹确认）。前提已经被评审推翻过一次（pi 会先把被中止的回合落盘，所以静默切**不丢数据**）；现在这条剩下的产品判断也已定：把决定还给用户，同时把"真·后台并行"划出 S5（见 §2 与 D7） | — |
| A3 | **D3 不搬旧布局会话** | **【已修正理由】**原来写"因为没确证它们是 jerrypi 写的所以不敢动"—— 评审 N4 指出那条 cwd 指纹其实**支持**"是我们写的"。结论不变，但理由换成更硬的一条：**即使确实是我们写的，也不替用户移动/改写历史文件**；而恢复命令（`cd ~ && pi --session-dir ~/.pi/agent/sessions --resume`）零风险且已实测可用 |
| A4 | **把会话名放进 `meta`（D8）而不是单开消息** | `meta` 的语义是"模型/等级/用量"，会话名是另一类东西。放进 meta 的好处是复用"整块替换 + 不滚动"；坏处是这个结构会越来越像杂物箱 |
| A5 | ~~时间格式化断言的归位~~ → **已定案**（评审 N5）：维持"`format.ts` 只有一处断言点"（新开脚本必然出现同一函数两处期望）；也不改名（会牵动 STATUS/README/S3–S4 的引用），只在 `tool-text-check.mjs` 头注释里声明"本脚本覆盖 `format.ts` 的所有纯函数" | — |
| A6 | ~~CLI 互通只能人工验收~~ → **已被评审推翻**：不联网的自动化写法**存在**（直接 `import` 用户那份 pi 的 `dist/core/session-manager.js` 问它算出来的目录，我已实测跑通）。正确的说法是：**"不依赖第二份安装"的写法没有 —— 因为风险本来就住在第二份安装里，要的正是去问它。** T12 据此重写（R1） | 仍保留一个人工动作（§7 动作②），但它现在只负责验"模型读得懂内容"，不再兼职验"路径算得对不对" |
| A7 | ~~R2 该不该修~~ → **已核实并收敛**：pi 不做 realpath（§3.1 实测），我们跟着不做。留在这里只为说明它曾经是个疑问；**请评审确认"跟着 pi 不做归一化"这个判断**（另一个选择是我们自己做 `realpath`，代价是与 CLI 分叉） | — |
| A8 | **D10 把"新建"放进列表** | **【已修正】**原理由（"pi TUI 也这么做"）被评审 B4 推翻（它没有新建条目，空态是 `Press Tab to view all`）。结论保留（QuickPick 没那个键位），理由换成"我们没有第二个键位"。评审建议的备选已采纳一半：空列表时给一条"当前项目还没有已保存的会话"的说明项（对齐 pi 的空态文案），非空时"新建"项仍然保留 |
| A9 | **多写者（R8）我选择"不改设计"** | 备选是“面板打开时独占锁”或“写前重新读文件”，两者都很重。我判断：多个写者共用一份 append-only 树是 pi **自己的**行为（终端与 TUI 也这样），我们不该在扩展里发明一套锁。**【已补】**评审 S4 指出还漏了中间一档（`size+mtime` 检测 + 提醒），已写进 R8 作为 S5 之后的候选 |
| A10 | **不跟随 `settings.json` 的 `sessionDir`（R9）** | 跟随更“尊重用户配置”，但我们的目录推导就会有两处权威，而且它同样会让 S6 的 `jerrypi.agentDir` 变得复杂。如果用户确实会用那个键，这个选择得反过来。**【已补】**评审 N6：不跟随也**不妨碍检测** —— 读一下环境变量与 settings，命中就记一行日志（已写进 R9） |
