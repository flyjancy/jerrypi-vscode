# S3 实施计划：工具调用卡片

> 状态：**待评审**（本文件先给用户/评审窗过一遍，确认默认值后再动代码）
> 上游：`PLAN.md` 第 6 节 S3（"bash / read / edit / write 的调用参数与结果展示，可折叠，
> bash 输出流式更新，点击文件路径打开文件"），成功判据 G2。

---

## 0. 本计划已核实的事实（都带证据，不靠记忆）

S0/S1/S2 的教训是同一条：**凡是要写进代码的 pi 行为，先在源码或实跑里确认一遍。**
本节的事实来自两部分——(a) 读 pi 0.85.1 的源码/类型，(b) 一段专门写的探针脚本
（`node` 里用生产装配路径起真实会话，跑 4 个 bash 场景，把收到的事件原样打出来）。
探针输出见 §10。

### 0.1 工具事件：S3 要的东西**全都在事件流里**，不用碰私有 API

`AgentEvent` 共 9 种，其中三种与工具有关（`pi-agent-core/dist/types.d.ts:377-415`）：

| 事件 | 字段 |
| --- | --- |
| `tool_execution_start` | `{toolCallId, toolName, args}` |
| `tool_execution_update` | `{toolCallId, toolName, args, partialResult}` |
| `tool_execution_end` | `{toolCallId, toolName, result, isError}` |

`AgentSessionEvent = Exclude<AgentEvent, {type:"agent_end"}> | …`（`core/agent-session.d.ts:40`）
—— **`tool_execution_update` 在联合里**，没有在会话层被过滤掉。
`agent-session.js:385-387` 把每个事件原样 `_emit` 给监听器（只对 `agent_end` 做增强）。

**实测（探针 A）**：一条 `for i in 1 2 3 4; do echo "line-$i"; sleep 0.4; done`
收到 5 条 `tool_execution_update`，事件类型序列为

```
agent_start, turn_start, message_start, message_end, message_update,
tool_execution_start, tool_execution_update, tool_execution_end,
entry_appended, turn_end, agent_end, agent_settled
```

### 0.2 流式数据的三个"反直觉"细节（写错就是静默错）

1. **第一次更新的 `content` 是空数组**（探针 A 的 update#1：`text = null`）。
   原因在 `core/tools/bash.js:198-200`：只要 `onUpdate` 存在，它**先**发一次
   `onUpdate({content: [], details: undefined})` 占位，再发真正的输出。
   → `partialResult.content[0]?.text` **不能假定存在**。
2. **`text` 是累积快照，不是增量**（update#2..5 = `line-1\n` → `…line-2\n` → … → 4 行全量）。
   → 必须**整体替换**。当成增量拼接会得到 `line-1line-1line-2…`。
3. **`details` 在小输出时是 `undefined`，命令失败时是 `{}`**（探针 A/D/E）。
   → 不能写 `details.truncation`，要先判 `details` 存在。

4. **快照会"换头"：超过 50KB 后保留的是最后 50KB，先前流出的开头会消失**（探针 G）。
   实测 160KB 输出：`update#2` = 82 字符（从"行 1"起）、`update#3` = 48,971 字符（从**"行 2888"**起）。
   → 断言**不能**写"正文单调增长"：流式期间要断"正文 === 当次快照"，
     最终态要断"以最后一次快照为**前缀**"（最终态还会多出 pi 的截断脚注）；
   UI 上展开态看到顶部内容被顶掉是**预期行为**（pi 的 TUI 同样如此，它用 `... (N earlier lines)` 提示）。

5. **被中止的工具*会*产生 toolResult，而且 pi 自己把已流出的正文带上了**（探针 H，**推翻了本计划的初版假设**）。
   实测：流式中途 `abort()`，1ms 内得到
   `tool_execution_end isError=true content=[{text:"行 1\n\n\nCommand aborted"}]`
   → `message_start/message_end(role=toolResult)` → `agent_settled`；
   中止后 `pendingToolCalls` **已空**，历史里那条 toolResult 的正文以中止前的最后一次快照为前缀。
   两个推论：
   - **正常中止路径不丢正文**（最终 item 由这条 toolResult 构建，本来就带正文）；
   - `settlePendingTools()` 在正常中止时**根本不会触发**（`pendingToolCalls` 已经空了）
     —— 它是"工具永不返回"的真兜底路径（§4.4 第 2 条）。
   附带观察：中止后 pi 会**追加一条 `stopReason=error` 的空 assistant 消息**，
   S2 的序列化器会把它渲染成一条提示 —— M13 顺带确认这条提示不误导人。

### 0.3 只有 bash 会流式（`onUpdate(` 的真实调用次数）

| 工具 | `onUpdate(` 调用 |
| --- | --- |
| `bash` | 2（占位 + 每次输出） |
| `read` / `write` / `edit` / `ls` / `find` / `grep` / `powershell` | **0** |

→ S3 的"流式"只对 bash 有意义；其它工具的结果**一次性**到达。
（这不影响协议设计：`tool_execution_update` 是通用通道，扩展工具也能用。）

### 0.4 bash 的截断与"完整输出"路径（`core/tools/bash.js` + 探针 C）

- 节流 `BASH_UPDATE_THROTTLE_MS = 100`（`core/tools/renderers/bash.js:15`）。
- 单条结果上限：**2000 行 / 50KB**（`DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES = 50 * 1024`，
  `core/tools/truncate.js:11`），谁先到算谁。
- 超限时把**完整输出写进临时文件**，路径在 `details.fullOutputPath`。
- 实测 120KB 输出：最终文本 51,343 字符，尾部是
  `[Showing last 50.0KB of line 1 (line is 117.2KB). Full output: /var/folders/…/pi-bash-xxxx.log]`；
  `details.truncation = {truncated: true, truncatedBy: "bytes", totalLines: 1, totalBytes: 120000,
  outputLines: 1, outputBytes: 51200, lastLinePartial: true, maxLines: 2000, maxBytes: 51200, content: …}`。

> ⚠️ **由此得出一条协议约束：`details` 不能整体透传。**
> `truncation.content` 里**又装了一份 51KB 的文本**，和 `content[0].text` 重复。
> 我们只取 `truncated / truncatedBy / totalLines / outputLines / maxBytes` 这些标量。

> ⚠️ **第二个约束：pi 的最终文本可能超过 50KB。** 它在 50KB 正文之后**还要追加一行脚注**
> （`[Showing lines 2888-4000 of 4000 (50.0KB limit). Full output: …]`）。
> 实测单行 120KB 的极端情况：正文 51,343 字符 > 我们原先定的 51,200 上限 → 会被我们自己再裁一次，
> **正好裁掉 M5 要验的那行脚注**。所以上限取 64KB（见 D3）。

### 0.5 pi 自己的展示方式（S3 要对齐的"设计"，`core/tools/renderers/*.js`）

| 工具 | 标题行 | 折叠时 | 展开时 |
| --- | --- | --- | --- |
| bash | `$ <command>`（有 timeout 时后缀 ` (timeout Ns)`） | **最后 5 行** + `... (N earlier lines, <key> to expand)` | 全量 |
| read | `read <path>`（带 `:10-20` 行号范围） | 无正文 | 最多 10 行 + `... (N more lines, …)` |
| edit / write | `edit/write <path>` | 无正文 | diff / 文件内容 |

- **耗时**：进行中 `Elapsed 1.2s`，结束后 `Took 1.2s`（`renderers/bash.js`）。
- **截断脚注**：`[Full output: <path>. Truncated: showing X of Y lines]`。
- **空输出**：bash 用 `(no output)` 占位（`bash.js` 的 `formatOutput`）。
- **路径怎么变成可点的**（这就是 pi 里"点击路径打开文件"的做法）：
  `renderToolPath`（`core/tools/render-utils.js:57-64`）=
  `linkPath(theme.fg("accent", shortenPath(value)), value, cwd)`，而
  `linkPath`（`core/tools/render-utils.js:16`）用 **OSC-8 超链接**指向 `pathToFileURL(resolvePath(raw, cwd))`，
  受终端能力 `hyperlinks` 开关控制。→ 目标 URL 是 **`file://` + 绝对路径**，`~` 只是显示层的简写。
- **文本净化**：`getTextOutput`（`core/tools/render-utils.js:35-52`）对每个 text 块做
  `stripAnsi` → `sanitizeBinaryOutput` → 去 `\r`；图片块在终端不支持图片时降级为
  `imageFallback(mimeType, dims)` 文本提示。**这两个净化函数没有从 bundle 导出**（§0.7），
  我们得自己写等价实现（`stripAnsi` = `dist/utils/ansi.js:39`，
  `sanitizeBinaryOutput` = `dist/utils/shell.js:135`）。

### 0.6 我们自己的现状：S2 留下三处**必须一起改**的地方

1. `src/webview/main.ts:112-116`：tool 行是 `setHtml(node, renderToolLine(item))` ——
   **整体重写 innerHTML**。bash 每 100ms 一次 upsert 会：重置 `<details>` 展开态、
   打断文本选中、把输入光标位置弄丢。→ S3 必须**就地更新**。
2. `src/webview/main.ts:180-182`：`scrollToBottom()` 无条件把视图拽到底。
   流式输出期间用户往上翻看历史会被持续打断。→ S3 必须**粘底策略**。
3. `src/pi/serialize.ts` 的 `toolResult` 分支**只填参数摘要，没有结果正文**
   （S2 明确不做，见该文件头注释）。→ S3 在**同一个序列化器**里补结果正文。

另外两条现状（是 S3 的基础，别推翻）：

- `state.pendingToolCalls` 是 `Set<string>`，**只有 toolCallId**，没有参数也没有输出
  （`pi-agent-core/dist/agent.js:392-403`；实测 prompt 结束后 size = 0）。
  重放时的参数靠我们的 `toolCalls` 索引（从 assistant 消息的 toolCall 块重建）——
  S2-M9 已验证"运行中那一行能重放出来"。
- **partial 输出 pi 不保存**（不在消息里、不在 state 里）→ 面板中途重开时，
  **已经流出来的那些字必须由我们自己缓存**，否则会倒退。这是 C1/N1 家族的第四处。

### 0.7 bundle 的导出面（能复用什么、不能复用什么）

`dist/bundle/index.js` 有 151 个导出。与 S3 相关的：

**能用**：`DEFAULT_MAX_BYTES`、`DEFAULT_MAX_LINES`、`formatSize`、
`isBashToolResult` / `isReadToolResult` / `isEditToolResult` / `isWriteToolResult` 等结果类型守卫、
`truncateTail` / `truncateHead`、`getLanguageFromPath`。

**不能用的**：`stripAnsi`、`sanitizeBinaryOutput`、`getTextOutput`、`renderToolPath`
（都是内部函数，未导出；而 `pi-runtime/` 只同步了 `dist/bundle/**` 与主题/模板，
**没有** `dist/core/**`，所以连深路径 import 都做不到）→ 净化和路径处理我们自己写，
放在一个**纯函数模块**里以便在 CI 里单测（见 §4.2）。

---

## 1. 范围

### 1.1 做

1. **协议**：`ChatItem` 的 `tool` 变体补上结果正文与元信息（正文、截断摘要、耗时、可点路径）；
   新增客户端消息 `openFile`。
2. **序列化**：新增纯函数模块 `src/shared/toolText.ts`（ANSI/控制字符净化、图片降级提示、
   单条上限裁剪），`serialize.ts` 用它把 `toolResult` 消息转成带正文的 item。
   **实时与重放仍然共用这一个序列化器**（S2 的硬约束，不许破）。
3. **控制器**：处理 `tool_execution_update` → 就地 upsert 同一 id 的工具行；
   `tool_execution_start` 记开始时间并铸造路径、`tool_execution_end` 记结束时间；
   缓存每个工具的 partial 文本供重放**和**中止收口使用；登记"可打开的文件路径"白名单。
4. **宿主**：处理 `openFile`（只放行由序列化器铸造过、控制器登记过的**绝对路径**）。
5. **UI**：工具卡片（标题行 + 可展开正文）、bash 折叠显示最后 5 行、耗时、截断脚注、
   **就地更新**（不整体重写 DOM）、**粘底滚动**。
6. **可打开路径**：由 `serialize.ts` 在每次序列化时铸造（重放也会重新铸造，所以历史卡片照样能点），
   控制器登记成白名单，host 只做精确比对后 `Uri.file` 打开。
7. **中止路径**：`settlePendingTools()` 发最终 item 时**必须合并 partial 正文**，
   并清理该工具的 partial 缓存（否则中止一次泄漏一份最多 64KB 的字符串）。
8. **检查**：新增纯函数与渲染断言；`check:controller` 补真实场景（流式、重开、失败、截断、
   中止、帧竞态、快照体积与耗时）。

### 1.2 不做（留给后续步骤，明确边界）

| 不做的事 | 归属 | 为什么现在不做 |
| --- | --- | --- |
| `edit` 的 diff / `write` 的前后对比渲染 | **S7** | PLAN 把 diff 审阅单列一步；S3 只给"结果正文"这一层 |
| 图片内容显示（read 到图片时把 base64 画出来） | 未排期 | 一张图 base64 可达数 MB，会顶爆重放预算（§0.4 的同类问题）。S3 只显示 `[图片 image/png]` 文本提示，与 pi 在无图片能力终端下的降级一致。**README 的已知限制要照这个说法写**（只写"图片不显示"会被当成 bug） |
| 工具审批 / 确认 | **S8** | 独立一步（README 已写明 `approvalMode` 当前无效） |
| 卡片内搜索、复制按钮、导出 | — | pi 的 TUI 没有这些；按"follow pi"原则不自创 |
| 路径识别的启发式 | — | 只认**参数里的 `path`** 与 `details.fullOutputPath`；**不**从 bash 命令文本里正则猜路径（猜错比猜不到更糟） |

---

## 2. 文件清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/shared/toolText.ts` | **新增** | 纯函数：ANSI 剥离、控制字符净化、图片降级提示、单条裁剪 |
| `src/shared/protocol.ts` | 改 | tool item 新字段；`openFile`；三个新常量 |
| `src/pi/serialize.ts` | 改 | `toolResult` 分支补正文与元信息；新收 `ctx = { cwd }`（铸路径）；`itemChars` → `itemBytes`（按 UTF-8 字节） |
| `src/pi/controller.ts` | 改 | `tool_execution_update`；partial 缓存；可打开路径登记；重放合并 |
| `src/host/chatView.ts` | 改 | `openFile` 分发（校验后 `showTextDocument`） |
| `src/webview/render.ts` | 改 | `renderToolCard`（纯函数，仍可在 Node 里跑） |
| `src/webview/main.ts` | 改 | 工具卡片的**就地更新**、展开态保持、粘底滚动 |
| `src/webview/style.css` | 改 | 卡片样式（标题行、正文、脚注、状态色） |
| `scripts/tool-text-check.mjs` | **新增** | `toolText.ts` 的纯函数断言 |
| `scripts/self-test.mjs` | 改 | 用例 6 挂上新的检查脚本 |
| `scripts/protocol-check.mjs` | 改 | tool item 字段、实时/重放一致性的静态断言 |
| `scripts/render-xss-check.mjs` | 改 | 卡片渲染与转义断言 |
| `scripts/controller-check.mjs` | 改 | 真实场景：流式多次 upsert、中途重开、失败、截断、**中止不丢正文**、**帧竞态**、白名单（含运行中的卡片）；并打印两项量测（流式字节率、snapshot 体积与耗时） |
| `README.md` | 改 | 特性表把"工具行"升级为"工具卡片"；已知限制补一条（图片不显示） |
| `docs/PLAN.md` | 改 | S3 状态标记；如发现事实与计划不符，就地更正 |

---

## 3. 不可违反的约束

1. **单点序列化**：一条 pi 消息 → 一个 `ChatItem` 只经过 `serialize.ts`。
   实时路径（事件流）与重放路径（消息数组）不得各写一份。
   **两条路径的分工必须写死**（否则"逐字节相同"的断言写不出来）：

   | 字段 | 谁产出 | 重放时 |
   | --- | --- | --- |
   | `toolName / summary / truncation / isError`（**已完成**的行） | `serialize.ts` | ✅ 有（权威，可做逐字节等价断言） |
   | `text`（**运行中 / 被兜底收口**的行） | `controller.ts` 给的是 `partials` 里的快照 | ⚠️ 运行中的行**有**（从 `partials` 重建）；此类行**不参与**等价性断言 |
   | `openablePaths` | `serialize.ts`（读 `ctx.cwd`） | ✅ 有（每次重放重新铸造） |
   | `startedAt / endedAt` | `controller.ts` 装饰（只在实时路径） | ❌ **没有**（内存时钟，重启后无从得知） |
   | `pending` | `controller.ts` 装饰 | ✅ **有**：`snapshot()` 用 `state.pendingToolCalls` + 我们的 `partials` 重建运行中的行（§4.4 第 2 条）；但它**不由 `serialize.ts` 产出**，所以等价性断言要把它单独排除 |

   → `serializeMessage(raw, index, toolCalls, ctx)` / `serializeMessages(messages, ctx)`，
   `ctx = { cwd }`；等价性断言比较时**显式剔除**实时独占字段（§6.1）。
2. **id 权威在控制器**：工具行 id 恒为 `tool-<toolCallId>`；实时与重放构造方式相同。
3. **只有 `render.ts` 生成 HTML**；其余地方一律 `textContent`。
   结果正文是**不可信输入**（模型可控），必须走 `renderPlain`。
4. **净化 ≠ 转义**：`toolText.ts` 只做"去掉终端控制序列/二进制垃圾"（为了好看），
   安全靠 `render.ts` 的逃逸 + CSP。两者不许混为一谈（谁都不许把 `toolText` 当消毒用）。
5. **卡片就地更新**：流式期间不得重建 DOM 节点（展开态、选中、滚动位置都是用户状态）。
6. **粘底滚动**：只有在用户**本来就在底部附近**（阈值内）时才自动滚。
7. **不给结果文本加解释**：pi 的结果文本自带状态（失败时模型看到的是
   `(no output)\n\nCommand exited with code 3`）。UI 只显示、不二次加工，避免"我们编一句话"。

---

## 4. 模块设计

### 4.1 `src/shared/protocol.ts`（增量）

```ts
// tool item 增补字段（都能缺失，保持向后兼容）
{
  kind: "tool";
  id: string;
  toolCallId: string;
  toolName: string;
  summary: string;              // 参数摘要（S2 已有）
  isError: boolean;
  pending?: boolean;
  // ↓ S3 新增
  text?: string;                // 结果正文（已净化、已按上限裁剪）
  textTruncated?: boolean;      // 是否被**我们的上限**裁过（区分 pi 自己的截断）
  truncation?: {                // §0.4：**只取标量**，绝不带 pi 的 truncation.content
    truncated: true;
    truncatedBy: "lines" | "bytes";
    totalLines: number;
    outputLines: number;
    maxBytes?: number;
  };
  fullOutputPath?: string;      // bash 截断时的完整输出文件（也是可点路径）
  openablePaths?: string[];     // 本条卡片里可点击打开的**绝对路径**（fsPath，不是 URL）
  startedAt?: number;           // ms epoch；重启后消失（重放时没有就不显示耗时）
  endedAt?: number;
}

// 客户端消息
| { type: "openFile"; path: string }   // 绝对路径；host 侧做**精确字符串**白名单比对

export const TOOL_TEXT_MAX_BYTES = 64 * 1024;  // 见 D3：要**大于** pi 自己的 50KB+脚注
// 注意：S2 的 MAX_REPLAY_CHARS 一并改名为 MAX_REPLAY_BYTES，语义从"字符"改成"UTF-8 字节"
// （名字与语义必须一致——混用会让重放预算在中文会话里差 3 倍）
export const TOOL_PREVIEW_LINES = 5;        // = pi 的 BASH_PREVIEW_LINES
export const TOOL_FRAME_MS = 200;           // 工具 upsert 合并窗口
```

`openablePaths` 只出现在 item 里，**由 `serialize.ts` 铸造**（见 §4.3），也是唯一的白名单来源。
铸造逻辑拆成两个可复用函数（**运行中的卡片也要有可点路径**，见 §4.4 第 3 条）：

```ts
openablePathsOfArgs(args, cwd): string[]    // 工具参数里的 path，相对路径按 cwd 解析
openablePathsOfResult(message, ctx): string[] // 上面那个 + details.fullOutputPath
```
**传路径而不是 `file://` URL**：`vscode.Uri.parse("/tmp/a#b.log")` 会把 `#` 当 fragment，
打开的是另一个文件或直接失败；用 `vscode.Uri.file(path)` 没有这个歧义
（Windows 的 `C:\…` 形态也因此不必转义）。

### 4.2 `src/shared/toolText.ts`（新，纯函数，CI 可测）

```ts
stripAnsi(text): string          // ESI/CSI/OSC 序列 → 去掉；照 pi 的 utils/ansi 行为
sanitizeControl(text): string    // 控制字符（保留 \n \t）与 \r → 处理
imageNote(mimeType, w?, h?): string   // "[图片 image/png]"（pi 的 imageFallback 等价物）
toolTextFromContent(content): string  // text 块拼接 + 图片块降级 + 净化
clipToolText(text, maxBytes): { text, clipped }  // 按 **UTF-8 字节**裁剪：保**头** + 末尾加
                                               // "…（已省略 N 字节）"；用 TextEncoder 量长度，
                                               // 裁剪点回退到字符/代理对边界
```

守卫：`clipToolText` 必须按**字节**量（`TextEncoder`），但裁剪点要回退到**字符/代理对边界**
（不能切出半个 emoji），并且只裁一次（二次裁剪会把"…（已省略 N 字节）"这个标记自己也裁掉）。

### 4.3 `src/pi/serialize.ts`（增量）

`toolResult` 分支补：

```ts
const body = toolTextFromContent(message.content);
const clipped = clipToolText(body, TOOL_TEXT_MAX_BYTES);
const meta = toolMetaOf(message.details);   // 只取标量，**不带** truncation.content
const openablePaths = openablePathsOfResult(message, ctx);  // 参数 path + details.fullOutputPath，按 ctx.cwd 解析
```

`itemChars` 改名 `itemBytes`，并把 `text` 的 **UTF-8 字节数**算进去
（用 `text.length` 计字符会在中文会话里把预算低估 3 倍）。

### 4.4 `src/pi/controller.ts`（增量）

三件事：

1. **流式 upsert + 时间戳**
   ```ts
   case "tool_execution_start":  this.onToolStart(event)   // startedAt = now()
   case "tool_execution_update": this.onToolUpdate(event)  // 正文 upsert（合并发送）
   case "tool_execution_end":    this.onToolEnd(event)     // endedAt = now()；flush 并丢弃过期帧
   ```
   - **`startedAt`/`endedAt` 只在这两个事件里记**（§0.3：其它工具根本不发 update）；
   - `onToolUpdate` 只在 `partialResult.content[0]?.text` 存在时才更新正文
     （占位更新只用来建行，见 §0.2 第 1 条）；
   - upsert 走 **200ms 合并**（`TOOL_FRAME_MS`）：同一工具在窗口内的多次更新只发最后一次
     （pi 自己已经节流到 100ms，这里只是不让"每 100ms 一份 50KB"直接打到 webview）；
   - **`tool_execution_end` 必须 flush 并作废该工具所有待发帧**：否则一帧旧快照会落在最终 item
     **之后**，用不带脚注的旧正文把最终正文覆盖回去。帧带自增序号，落地时比序号丢弃过期帧
     （`check:controller` 里有断言）。
   - **不做前缀增量**（见 §9 风险 R4：先量再优化）。

   注意：正文的**语义是整体替换**，不是追加（§0.2 第 2 条），而且超过 50KB 后快照会"换头"
   （§0.2 第 4 条）—— 我们的 upsert 只是把这个快照原样转达，不要试图做差量或"合并历史"。

2. **partial 缓存 + 重放合并**
   - `private readonly partials = new Map<string, { text: string; truncation?; fullOutputPath? }>()`；
   - `snapshot()` 重建 pending 工具行时，把 `partials` 里的正文一并带上
     → **面板中途重开能看到已经流出来的字，并且继续长**（C1/N1 家族第四处）；
     同时**用 `toolCalls` 索引里的 args 走一遍 `openablePathsOfArgs(args, cwd)`**
     —— 否则"重开后一个仍在运行的卡片"标题上的路径点不开（M11 只覆盖已完成的行，M14 只覆盖实时）；
     这条判据并进 M3。
   - 清理时机：`tool_execution_end` 之后仍保留到该 toolResult 的 `message_end`
     （最终态由消息构建），随后删除；会话替换 / `newSession` 时整体清空。
   - **正常中止路径不需要特殊处理**（探针 H）：中止时 pi 自己会发一条
     `isError=true`、正文为"已流出内容 + `Command aborted`"的 toolResult，
     最终 item 由它构建，正文本来就在。这一格的验收判据见 M13。
   - ⚠️ **兜底路径（`settlePendingTools()`，`controller.ts:501-513`）要改**：
     它对"还在 `pendingToolCalls` 里、但 toolResult 永不到来"的工具发
     `{...item, pending:false, isError:true}`，而那个 `item` 是 `tool_execution_start`
     时建的**只有参数摘要的壳**。正文放进 `partials` 之后，这条最终 item 会**没有正文**，
     同时 `partials` 也永远等不到那个 `message_end` —— **每次触发泄漏一份 ≤64KB 的字符串**。
     所以这里必须 **(a) 合并 partial 正文、(b) 删除 `partials` 中该工具的条目**。
     （正常 abort 走不到这里，探针 H 已证；它只在扩展工具挂死/宿主异常时生效。）

3. **可打开路径白名单**
   - `private openable = new Set<string>()`（值 = **绝对路径**，不是 URL）；
   - 铸造点在 `serialize.ts`（§4.3）：工具参数里的 `path` 与 `details.fullOutputPath`，
     相对路径按**会话 cwd** 解析（`path.resolve`，与 pi 的 `linkPath` 同规则）；
   - **`tool_execution_start` 建行时也要铸造**（它手上就有 `args`）：否则一个**正在执行**的
     `read`/`edit` 卡片，标题里的路径点下去会被 host 拒 —— 而 M1/M11 都是在工具结束后点的，测不到这一格；
   - 控制器在**每次发 item / 每次 `snapshot()` 时**把这些路径登记进来；
     `snapshot()` **重建**集合（不是累加）——因为重放出来的卡片才是 webview 上真实存在的卡片；
   - `isOpenableFile(path: string): boolean` 只做精确字符串比对（外加绝对路径校验）。
     → **重放出来的历史卡片照样能点开**（这是评审抓到的洞：白名单只从事件里铸造的话，
     面板重开之后历史卡片全点不开），也不需要 FIFO 淘汰（上限由重放的条数上限决定）。

### 4.5 `src/host/chatView.ts`（增量）

```ts
case "openFile": {
  if (!controller.isOpenableFile(message.path)) { output.appendLine("拒绝打开未登记的文件：…"); return; }
  await vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: true });
  return;
}
```
- 用 `Uri.file` 而不是 `Uri.parse`：后者会把路径里的 `#` 当 fragment、`?` 当 query（§4.1）。
- 文件不存在时 `showTextDocument` 抛错 → 捕获后 `showWarningMessage`（不静默失败）。
- 二次校验是刻意的：白名单在控制器里，host 只做"它确实登记过"这一条判断，**不自己解析路径**。

### 4.6 `src/webview/render.ts`（增量，仍是纯函数）

```ts
renderToolCard(item): string     // 标题行 + 正文容器 + 脚注（供首次渲染 / 重放）
renderToolHead(item): string     // 只重绘标题行（就地更新时用）
renderToolBody(item): string     // 只重绘正文（就地更新时用）
```

正文规则（照 pi）：
- bash：折叠时取正文**最后 5 行**；展开时全量；行数不足 5 行时原样显示；
- read/write/edit：折叠时不显示正文，展开时全量（最多前 10 行 + `… 还有 N 行`）；
- 空正文：显示灰色 `（无输出）`；
- **pi 的截断**：正文末尾加脚注 `[完整输出：<path>]`（path 可点则渲染成链接）。
- **我们自己的裁剪**（`textTruncated`，D3，只可能被扩展工具触发）：在正文末尾加一行
  灰色 `…（已省略 N 字节）`，**不加 pi 的脚注样式**（两者来源不同，长得一样会让人以为
  pi 又截了一次）。

### 4.7 `src/webview/main.ts`（增量）

- `toolViews: Map<string, { node, head, body, open: boolean }>`；
  upsert 时**只更新 head 与 body 的 innerHTML**，节点本身复用 → 展开态与选中不丢；
  ⚠️ 但 `innerHTML` 重写会**销毁子节点、把正文容器的 `scrollTop` 归零**（§4.8 给正文定了
  `max-height: 40vh` + 内部滚动）：用户展开一个大输出卡片往下读，每 200ms 就被拽回正文顶部。
  所以更新 body 时**必须保存并恢复 `scrollTop`**；更稳的做法是正文内部也做粘底判定
  （本来在底部附近就跟随，否则保位置）。判据并进 M7。
- 展开/折叠由用户点击标题行切换（`<button aria-expanded>`），状态记在 `toolViews` 里；
- 粘底：`isAtBottom()` 阈值约 40px；`renderItem` 只在 `isAtBottom()` 为真时滚到底；
  用户点发送/回车时强制滚到底；
- 进行中的耗时：`setInterval(1s)` 只更新"进行中"卡片的耗时文本（不重发协议消息）。
  **停表条件**：没有 running 卡片时清掉定时器；`window` 的 `pagehide`/`unload` 时也要清。

### 4.8 `src/webview/style.css`（增量）

标题行（图标 + 工具名 + 参数摘要 + 耗时）、正文（等宽、`white-space: pre-wrap`、可滚动上限
`max-height: 40vh`）、脚注、状态色（ok/error/running）、可点路径的样式（下划线 + 手型）。

---

## 5. 重放契约（面板重开 / 窗口重载）

| 状态 | 重放时从哪来 | 断言 |
| --- | --- | --- |
| 已完成的工具行 | `session.messages` 的 `toolResult` | 正文、截断、路径与实时**逐字节相同** |
| **正在执行的工具行** | `state.pendingToolCalls`（id）+ 我们的 `partials`（正文） | 已有输出**不丢**，且随后继续增长 |
| 卡片的展开/折叠 | **不进协议**，webview 自己维护；重开后面板重置为默认折叠 | 不承诺跨重开保持（VS Code 侧的 `retainContextWhenHidden` 场景下本来就不重建） |
| 可点路径 | 每次序列化重新铸造（§4.4 第 3 条） | **重开之后历史卡片的路径仍可点** |
| 时间戳 | 内存里有就显示，没有就不显示 | **不编造**（重启后不显示耗时） |

`MAX_REPLAY_CHARS` 从 1MB **提到 4MB 并改名 `MAX_REPLAY_BYTES`**（理由：bash 单条结果可达 51KB，
1MB 只装得下 ~20 条，长会话里会把正文挤掉；改名是因为 S2 的名字说"字符"、现在的口径是字节）。
`MAX_REPLAY_ITEMS = 500` 不变。

---

## 6. 验收

### 6.1 CI（每个提交都跑）

- `npm run typecheck`（两个 tsconfig）
- `npm run self-test`（用例 6 现在跑三份断言：protocol / render / **tool-text**）
- 新增断言点（示例，实施时按实际数量写进文档）：
  - toolText：ANSI 序列（CSI/OSC）、`\r`、**按字节裁剪且不切坏代理对**、多字节字符的预算、图片降级、空内容；
  - protocol：tool item 新字段的默认值、`itemBytes` 计入正文、
    实时/重放两条路径的**等价性**（比较时**剔除**实时独占字段 `startedAt/endedAt/pending`，
    其余字段逐字节相同）；
  - render：折叠/展开两态、`<script>` 在工具正文里被转义、路径链接的 HTML 属性、
    `（无输出）`、截断脚注。

另外 `check:controller`（需要凭据与网络，不进 CI）要**打印量测数字**，因为有两处"先量再优化"
的判断依赖它们：

| 量什么 | 为什么 |
| --- | --- |
| 一个 5 秒流式命令的 `item` 消息数与总字节数 | R4：超过 100KB/s 就回来做前缀增量 |
| 一次 `snapshot()` 的 JSON 字节数与序列化耗时 | D4：4MB 预算是不是太大 |

### 6.2 macOS（F5，人工）—— M 系列

| 编号 | 做什么 | 判据 |
| --- | --- | --- |
| M1 | 让 agent `read` 一个文件（比如自身的 `README.md` 前 30 行） | 卡片标题显示路径；点击路径**在编辑器里打开**；折叠时不显示正文，展开后显示内容 |
| M2 | 发 `for i in $(seq 1 20); do echo "行 $i"; sleep 0.3; done` | 文字**持续出现**（不是 6 秒后才一次性出现）；折叠态显示最后 5 行并随输出滚动；结束后显示 `Took X.Xs` |
| M3 | **在 M2 的流式中途**执行 `Developer: Reload Webviews` | 重开后卡片**仍有已流出的输出**，且**继续增长**到最后一行（partial 缓存在起作用） |
| M4 | 发 `bash: exit 3` | 行首是红色 ✗，正文含 `Command exited with code 3`，**没有**我们自己编的解释 |
| M5 | 发 `head -c 120000 /dev/zero \| tr '\0' 'x'` | 正文尾部有 `[Showing last 50.0KB …]` 与可点的完整输出路径；点它能打开那个临时文件 |
| M6 | 让它**一次**同时调两个工具（如 `echo AAA` + `read 一个文件`） | 两条卡片各自独立、顺序与调用一致，不合并成一行。（**依赖模型行为**：它没并发调用时重试即可，不算 FAIL —— 探针 F 已证明这种调用会发生） |
| M7 | **把 bash 卡片展开**，等它继续输出，并且**把正文往下滚到中部** | 展开态**不被重置**；新增内容可见；**正文的滚动位置不被拽回顶部**（§4.7 的 `scrollTop` 保持） |
| M8 | 流式期间**往上滚动**看历史 | 视图**不被拽回底部**；点发送后自动回到底部 |
| M9 | 发 `echo '<img src=x onerror=alert(1)>'` | 面板里是**文字**，不弹窗（结果正文是不受信输入） |
| M10 | 让 agent `edit` 一个小文件 | 卡片标题是可点路径；正文是结果文本（**没有 diff** —— 那是 S7） |
| M11 | **重开面板（`Developer: Reload Webviews`）后点历史卡片里的路径** | 仍能在编辑器里打开（白名单由重放重新铸造 —— 这是评审抓到的洞） |
| M12 | 让 agent 输出超过 50KB（如 `seq 1 4000`）并展开卡片 | 正文能看到尾部与 pi 的截断脚注 `[Showing … Full output: …]`；**顶部内容被顶掉是预期的**（§0.2 第 4 条） |
| M13 | **M2 流式中途点「中止」** | 已经流出来的正文**仍在**（状态变 ✗、不再增长），末尾是 pi 自己加的 `Command aborted` —— 探针 H 已证实这条由 **pi 的结果**带来（不是我们拼的）。顺带确认中止后那条 `stopReason=error` 的空 assistant 提示文案不误导人 |
| M14 | **让 agent `read` 一个文件，在它执行期间点卡片标题上的路径** | 能打开 —— 运行中的卡片也要有可点路径（§4.4 第 3 条） |

### 6.3 受限 Windows 机（人工，从 Marketplace 更新后）—— W 系列

| 编号 | 做什么 | 判据 |
| --- | --- | --- |
| W0 | **先跑 `Pi: Run Self-Test`** | 仍须 `GATE PASS`（本步动了 `serialize.ts`/`controller.ts`，属于 S1 已验证路径的邻居，必须先自证没破坏） |
| W1 | M1 + M2 | 同 Mac |
| W2 | M3 + M7（重开 + 展开态） | 同 Mac —— 这两条是 S3 最容易在两台机器上表现不同的地方 |
| W3 | M5（截断 + 打开完整输出） | Windows 的临时目录路径形态不同（`C:\Users\…\AppData\Local\Temp\…`），要确认可点路径在 Windows 上也能打开 |
| W4 | M4 + M9 | 失败态与 XSS 回归 |
| W5 | M11 + M14（重开后点历史路径 / 运行中点路径） | Windows 的路径形态（`C:\…`）与 Mac 不同，白名单比对必须仍然精确命中 |
| W6 | M13（中止不丢正文） | 受限机上中止走的是 Git Bash + 进程树回收，路径与 Mac 不同，值得单独回归一次 |

### 6.4 判据

- CI 全绿；Mac 的 **M1–M14** 全 PASS；Windows 的 **W0–W6** 全 PASS。
- 任一 FAIL 都记录在 `docs/S3-plan.md` 的实施记录里（含截图/日志），**不许口头放过**。

---

## 7. 提交计划

1. `feat: add the pure tool-output text helpers`（`toolText.ts` + `tool-text-check.mjs` + self-test 挂载）
2. `feat: carry tool results in the chat protocol`（protocol + serialize + protocol-check）
3. `feat: stream tool output through the controller`（controller 的 update/partial/白名单 + controller-check）
4. `feat: render tool cards with folding`（render + render-xss-check）
5. `feat: update tool cards in place and keep the scroll anchored`（main + style）
6. `feat: open files from tool cards`（chatView + openFile）
7. `docs: record S3 implementation results`

---

## 8. 决策点（默认值已给，用户可改）

| # | 决策 | 默认 | 理由 |
| --- | --- | --- | --- |
| D1 | 折叠默认态 | read/write/edit **折叠**；bash 折叠但显示**最后 5 行** | 照 pi（`BASH_PREVIEW_LINES=5`） |
| D2 | 展开内容上限 | 全量（受 D3 的单条上限约束） | 展开就是"我要看全部" |
| D3 | 单条正文上限 | `TOOL_TEXT_MAX_BYTES = 64 * 1024`（**按 UTF-8 字节**，只可能被扩展工具触发） | 必须**大于** pi 自己的上限：pi 裁到 50KB 正文后**还会追加一行脚注**，实测可达 51,343 字符；取 50KB 会把那行脚注裁掉。64KB 留足余量，内置工具的结果永远不会被我们二次裁剪。**必须按字节而不是字符**：50K 个汉字是 150KB。`clipToolText` 触发时**保留头部**（内置工具的头部信息量最大；bash 的"保尾"是 pi 在工具内部做的，不是我们的职责） |
| D4 | 重放预算 | `MAX_REPLAY_BYTES` 1MB → **4MB** | bash 单条可达 51KB，1MB 装不下长会话。4MB 是**一次 postMessage 的 JSON**、webview 启动时同步解析 → 在 `check:controller` 里顺便量它的实际字节数与耗时（与 R4 同一个口径，别只量流式不量重放） |
| D5 | 流式传输 | **整体 upsert + 200ms 合并**（不做前缀增量） | 先保证"实时与重放同一份数据"；体积问题先量再优化（§9 R4） |
| D6 | 耗时显示与记录点 | `startedAt` 记在 **`tool_execution_start`**、`endedAt` 记在 **`tool_execution_end`**；进行中每秒 tick | 记在 `tool_execution_update` 里是错的：read/write/edit 的 `onUpdate` 调用次数是 **0**（§0.3），那样只有 bash 有耗时。没有时间戳（重放/重启）就不显示 —— 不编造数据 |
| D7 | 可点路径来源 | 只认参数 `path` 与 `details.fullOutputPath` | 不从命令文本猜路径（猜错比猜不到更糟） |
| D8 | 路径打开方式 | `showTextDocument(uri, {preview: true})` | VS Code 里"从链接打开文件"的惯例；不强制占新标签 |
| D9 | 图片内容 | **不显示**，只给 `[图片 image/png]` 文本 | base64 会顶爆重放预算；与 pi 在无图片能力终端下的降级一致 |
| D10 | 展开态是否跨重开保持 | **不保持**（webview 内存态） | 不引入"UI 状态进协议"的复杂度；`retainContextWhenHidden` 场景下本来不重建 |
| D11 | 未知/扩展工具的正文 | 与内置工具同一条路径（有 partial 就流式、有正文就显示） | 不特判，避免"扩展工具的卡片长得不一样" |
| D12 | 卡片正文的最大高度 | `40vh` + 内部滚动 | 一条 `ls -R` 不该把整屏吃掉；与 pi 的"折叠优先"一致 |
| D13 | 借鉴 pi 的界面文案用哪种语言 | **跟 pi 一致用英文**：`Took 1.2s` / `Elapsed 1.2s`（折叠预览的 `... (N earlier lines)` 同理）；我们自己新写的文案（`（无输出）`、`…（已省略 N 字节）`）用中文 | 判据是"这句话 pi 有没有"：有就照抄（省得两处对不上），没有才自己写。pi 的脚注 `[Showing last 50.0KB …]` 本来就无法翻译 |

---

## 9. 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | **把快照当增量**拼接（§0.2 第 2 条） | 协议里 tool 正文是"整体替换"语义。`check:controller` 要写**两条**断言，不能合成一条：<br>① 流式期间每次 upsert 的正文 **=== 当次收到的快照**（不拼接、不合并历史）；<br>② **最终**正文以最后一次快照为**前缀**，可以多出 pi 的截断脚注（探针 G：`最终 = 最后一次快照 + 脚注`）。<br>⚠️ 不能断言"正文单调增长"：超过 50KB 后快照会换头（§0.2 第 4 条） |
| R2 | **第一次更新的 `content: []`** 被当成"空输出"覆盖掉已有正文 | `onToolExecutionUpdate` 只在 `content[0]?.text` 存在时才更新正文（占位更新只用来建行） |
| R3 | 就地更新写错 → 展开态在流式期间被重置 | M7 作为回归点；`toolViews` 只改 head/body 的 innerHTML |
| R4 | 整份快照的传输体积：bash 节流 100ms + 我们 200ms 合并 → **5 帧/秒 × 最多 50KB ≈ 250KB/s** | **S3 只量不改**（与 D5 一致：不做前缀增量，避免"实时与重放两份数据"）。`check:controller` 里打印一个 5 秒命令的消息数与总字节数，量出来的数字**记入 S3 的遗留事项**，要不要优化留到 S4+ 再定。（原先写的">100KB/s 就做增量"与 D5 互相矛盾，且 100KB/s 这个阈值本身没有依据 —— 结构化克隆未必真的卡。） |
| R5 | 重放时正文与实时不一致（历史里没有我们的裁剪标记） | 单点序列化 + `itemBytes` 计入正文 + protocol-check 的等价性断言 |
| R6 | `details` 里的 `truncation.content` 让单条 item 翻倍 | 只取标量字段（§0.4 的结论），render/protocol 两侧各有一条断言 |
| R7 | 路径白名单失效（伪造一个路径打开任意文件） | 白名单由序列化器铸造、控制器登记；host 侧只做**精确字符串**比对（不解析路径）；render-xss-check 里有"未登记路径不可点"的断言 |
| R8 | 大正文把 DOM 拖慢（每次 upsert 重排 50KB） | 折叠态只渲染 5 行；展开态仍重排但受 `max-height` 限制；必要时后续做虚拟滚动（记入 S3 的"遗留事项"） |

---

## 10. 探针证据（原始输出摘要）

探针脚本：临时文件，生产装配路径（`loadPi` → `createSessionHost` → 真实模型 `deepseek-v4-flash`）。

- **探针 A**：`for i in 1 2 3 4; do echo line-$i; sleep 0.4; done`
  → 96 个事件，其中 5 条 `tool_execution_update`；
  update#1 `text=null`（`content: []`）；#2..#5 依次 `line-1\n` / `…line-2\n` / `…line-3\n` / 四行全量；
  `tool_execution_start` 字段 = `["type","toolCallId","toolName","args"]`；
  `tool_execution_end.details = undefined`。
- **探针 B**：`pendingToolCalls` 类型 `Set`，prompt 结束后 size = 0。
- **探针 C**：120KB 输出 → 最终文本 51,343 字符，`truncatedBy=bytes`、
  `totalBytes=120000`、`outputBytes=51200`、`lastLinePartial=true`、`maxBytes=51200`，
  `fullOutputPath=/var/folders/…/pi-bash-bd98….log`。
- **探针 D**：`exit 3` → `tool_execution_end.isError = true`，
  content = `(no output)\n\nCommand exited with code 3`，`details = {}`。
- **探针 E**：`read` 一个 60 行文件 → 530 字符正文，`details = undefined`。
- **探针 F**：一条 assistant 消息里两个工具调用 → `tool_execution_start` 顺序 `bash → read`，
  `toolResult` 顺序一致。
- **探针 G（流式 + 超过 50KB，实测输出 182,893 字节 ≈ 180KB）**：
  `update#1` 占位（`text=null`）；`update#2` 82 字符（首行"行 1"）；
  `update#3` 48,971 字符（首行**"行 2888"** —— 开头已被丢弃）；
  最终正文 49,113 字符，尾部 `… 4000 of 4000 (50.0KB limit). Full output: /var/…/pi-bash-6452….log]`，
  `details.truncation.truncatedBy = "bytes"`、`totalBytes = 182893`；
  **最终正文以最后一次快照为前缀**（即"最终 = 最后一次快照 + 脚注"）。
  → 这条探针直接把 R1 的"单调增长"断言否掉了。

---

## 11. 评审记录

### 第 1 轮（Claude Opus 5，只读；**11 条，10 接受 / 1 不受理**）

评审结论：**第 1/3/4 条会改协议形状，必须在动代码前定掉**；第 5 条要先补探针。逐条处置：

| # | 评审意见 | 处置 |
| --- | --- | --- |
| 1 | D3 的 50KB 上限会裁掉 pi 的截断脚注，M5 必挂 | **接受**。上限提到 64KB（D3），明确 `clipToolText` 保头；§0.4 补了"pi 的最终文本可超 50KB"这条约束 |
| 2 | `startedAt` 记在 `tool_execution_update` 里 → read/write/edit 永远没有耗时；`endedAt` 没写在哪赋值 | **接受**。改成 `tool_execution_start` / `tool_execution_end`（D6 + §4.4） |
| 3 | `openablePaths`/时间戳与约束 #1「单点序列化」冲突，合并点没定义 → 等价性断言写不出来 | **接受**。约束 #1 里写死了三方分工表：序列化器产出内容与路径（带 `ctx.cwd`），控制器只装饰实时独占字段，断言显式剔除后者 |
| 4 | 白名单是内存态 → 面板重开后历史卡片的路径全点不开；FIFO 淘汰会让老链接静默失效 | **接受**。铸造点移到 `serialize.ts`（每次序列化都铸造），`snapshot()` 重建集合；新增 M11/W5 作为回归点 |
| 5 | R1 的"单调增长"断言可能不成立，探针没覆盖"流式 + 超 50KB" | **接受，并已补跑探针 G**：证实快照在 50KB 处**换头**（`update#2` 82 字符从"行 1"起 → `update#3` 48,971 字符从"行 2888"起）。R1 断言改为"正文 === 最后一次快照" |
| 6 | 200ms 合并窗口与最终态之间有竞态：待发帧会覆盖最终正文 | **接受**。`tool_execution_end` 必须 flush 并作废过期帧（带序号丢弃），`check:controller` 加断言 |
| 7 | `Uri.parse` 对含 `#`/`?` 的路径会截断 | **接受**。协议改传**绝对路径**而不是 `file://` URL，host 用 `Uri.file`；白名单做精确字符串比对 |
| 8 | D4 的 4MB 要量（重放也是一次 JSON 解析） | **接受**。`check:controller` 里量快照字节数与耗时（§6.1 的量测表） |
| 9 | D9 的 README 措辞不能只写"图片不显示" | **接受**。写成"显示 `[图片 image/png]`，与 pi 在无图片能力终端下的行为一致"（§1.2） |
| 10 | 命名不一致（`TOOL_TEXT_MAX_CHARS` / `MAX_REPLAY_CHARS` 残留）、M9 撞号、M6 依赖模型行为 | **接受**。三处都已改（`S2-M9`、M6 加注） |
| 11 | §2 文件清单只列 `docs/PLAN.md`，但根目录 `PLAN.md` 还在（内容不同），建议顺手删掉 | **不受理**。这是 S0 就定下的设计：根目录那份是**本地完整版，已被 `.gitignore` 排除**（`git check-ignore` 确认、`git ls-files` 里没有任何 PLAN.md），仓库读者只看得到 `docs/PLAN.md`，两份状态不会对读者分叉。评审看的是工作目录而不是仓库内容 —— 这条在 S2 期间也提过一次，记在这里避免第三次。 |


### 第 2 轮（Claude Opus 5，只读；**12 条，12 接受 / 0 驳回**）

评审先确认了第一轮的 10 条都已落地，并**主动撤回**了上一轮的第 11 条
（它自己跑了 `git check-ignore` 与 `git ls-files`，确认根目录 `PLAN.md` 不在仓库里）。
这一轮找到两个**会改事件处理形状**的真问题：

| # | 评审意见 | 处置 |
| --- | --- | --- |
| 1 | **中止路径会把已流出的正文抹掉**：`settlePendingTools()`（`controller.ts:501-513`）发的是 `{...item, pending:false, isError:true}`，而那个 `item` 是 S2 的"只有参数摘要的壳"；正文一旦放进独立的 `partials`，中止瞬间发出的这条就不带正文 | **接受**（已对着代码复核）。§1.1 新增第 7 条 + §4.4 第 2 条写明：这一处必须**合并 partial 正文** |
| 2 | 同处的**泄漏**：被中止的工具通常不产生 toolResult → `partials` 永远不会被清理，每次中止泄漏 ≤64KB | **接受**。清理动作放进同一个函数 |
| 3 | R1 的断言措辞会让实施者写出必挂的断言（最终正文 = 最后一次快照 **+ 脚注**） | **接受**。拆成两条断言：流式期间"正文 === 当次快照"；最终态"以最后一次快照为**前缀**" |
| 4 | **运行中的卡片路径点不开**：铸造点在 `toolResult` 分支，而运行中的行由 `tool_execution_start` 造 | **接受**。铸造逻辑抽成 `openablePathsOfArgs(args, cwd)`，`tool_execution_start` 建行时也调用；新增 **M14** |
| 5 | §1.1 第 4 条与 R7 仍写 `file:// URL`（第 7 条已改成传路径） | **接受**。两处措辞同步（R7 是 `render-xss-check` 断言的文案来源，留着会写错） |
| 6 | §6.4 判据仍是 M1–M10 / W0–W4，新增的 M11/M12/W5 不在闸门里 | **接受**。改成 M1–**M14** / W0–**W6** |
| 7 | §3 分工表把 `pending` 和 `startedAt/endedAt` 混成一行标"重放没有" | **接受**。`pending` 单独一行：**重放时确实会重建**，只是不由 `serialize.ts` 产出，等价性断言单独排除 |
| 8 | §2 的 `serialize.ts` 行还写 `itemChars`、没提 `ctx`；`controller-check` 行没提新增断言与量测 | **接受**。两行都同步了 |
| 9 | §10 探针 G 标题写"约 160KB"，正文里却 `totalBytes = 182893` | **接受**。标题改成"实测 182,893 字节 ≈ 180KB"（那 160KB 是估算，实际每行比估算长） |
| 10 | §4.7 的 `setInterval(1s)` 没写停表条件 | **接受**。补"没有 running 卡片时停；`pagehide` 时停" |
| 11 | §4.2 守卫句里的标记名还是旧的 | **接受**。改成"…（已省略 N 字节）" |
| 12 | 建议把意见整理成 §11 草稿 | **不受理**（流程性建议）。实施方自己回填，评审保持只读 |

**这一轮最有价值的第 1 条**是"两个都对的改动的交集"：S3 把正文放进 `partials` 是对的，
S2 的 `settlePendingTools` 兜底也是对的，但两者一合并就产生"中止即丢正文"。
这类问题只有把**改动面**读全（而不是只读计划描述的那几行）才看得出来。


### 第 3 轮（Claude Opus 5，只读；**6 条，6 接受**）

评审先确认第 2 轮的 12 条全部落地，并把**边际收益正在下降**这件事直接说了出来
（"这已经是第三轮，剩下的多是「同一家族的第 N 格」和文字同步"）。这一轮第一条再次证明
"凡是要写进代码的 pi 行为都要先跑一遍"这条规矩的价值 —— **它推翻的是我和评审共同接受的一个假设**：

| # | 评审意见 | 处置 |
| --- | --- | --- |
| 1 | §4.4 的「被中止的工具**通常**不会产生 toolResult」是**推理**不是实测，而两个设计决定押在它上面；且没定义 `message_end` 与 `agent_settled` 的先后 | **接受，并已补跑探针 H —— 结论推翻了这句前提**：中止时 pi **会**发 `tool_execution_end isError=true` + toolResult（正文 = 已流出内容 + `Command aborted`），`pendingToolCalls` 在 `agent_settled` 时**已空**、顺序是 `message_end` → `agent_settled`。所以**正常中止不丢正文**，`settlePendingTools()` 是"工具永不返回"的真兜底；合并正文/清缓存只在那条路径上需要。§0.2 新增第 5 条、§4.4 与 M13 按实测改写 |
| 2 | **展开的大输出卡片每 200ms 被拽回正文顶部**：重写 `innerHTML` 会销毁子节点、`scrollTop` 归零（§4.7 × §4.8 的交叉点），M7 只看 `<details>` 开着没开，测不到 | **接受**。§4.7 规定更新 body 时必须保存/恢复 `scrollTop`（或正文内部粘底）；M7 判据补"把正文往下滚到中部" |
| 3 | R4 的">100KB/s 就做前缀增量"与 D5"不做增量"**自相矛盾**（按默认参数，大输出必然 250KB/s 越线），实施者只能违反其中一条 | **接受**。R4 改为"S3 只量不改，数字记入遗留事项，S4+ 再定"；并注明原阈值本身没有依据 |
| 4 | 约束 #1 的分工表把 `text` 一律标成 `serialize.ts` 产出，但**运行中/被兜底收口**的行其实来自控制器的 `partials` | **接受**。`text` 拆成两种情形写清楚（已完成的行权威、参与等价断言；运行中的行不参与） |
| 5 | **"重开后 + 仍在运行的卡片"这一格没人守**：M14 管实时、M11 管重开后的已完成行；§4.4 第 2 条也没说重建 pending 行时要铸路径 | **接受**。§4.4 第 2 条补"用 `toolCalls` 索引里的 args 走一遍 `openablePathsOfArgs`"，判据并进 M3 |
| 6 | 四小项：`truncation` 只列 3 个字段（§0.4 结论是 5 个）、`textTruncated` 有字段无渲染规则、W 表顺序乱（W0,W1,W6,W2…）、界面文案语言不统一（中文正文 + 英文耗时） | **接受**。字段补齐 5 个；`textTruncated` 补渲染规则（灰色 `…（已省略 N 字节）`，**不加** pi 的脚注样式）；W 表排回 0–6；新增 **D13**：pi 有的文案照 pi（`Took/Elapsed` 用英文），pi 没有的我们自己写中文 |

**第 1 条的教训值得单独记一笔**：那条"被中止的工具通常不会产生 toolResult"是我写的，
依据是 S1 的 T5c 注释（"实测正常 abort 仍会发出 toolResult"）—— 我自己在 S1 就实测过它，
却在写 S3 时又把它当成"通常不会"。**同一条事实在四份计划里被引用过三次，第三次写反了。**
补探针 H 的成本是 4 个模型调用，而它挡住的是一次会让"中止吃掉输出"的错误修复方向。


---

## 12. 实施记录

### 12.1 落地清单（6 个提交）

| 提交 | 内容 |
| --- | --- |
| `8bcd24b` | `src/shared/toolText.ts` + `scripts/tool-text-check.mjs`（56 条）+ self-test 用例 6 挂载 |
| `4737015` | 协议（`PROTOCOL_VERSION` 1→2）、`serialize.ts` 的正文/元信息/路径铸造、protocol-check 63→84 |
| `aca376e` | 控制器的流式 upsert、partial 缓存、过期帧拦截、白名单；controller-check 27→53 |
| `b889ec3` | `render.ts` 的工具卡片（标题/正文/路径/耗时）；render-xss-check 42→74 |
| `319ae98` | `main.ts` 的就地更新、粘底滚动、展开态、耗时 tick；样式；protocol-check →92 |
| 第 6 个 | `chatView.ts` 的 `openFile` |

### 12.2 实施中发现的问题（计划里没预料到的）

1. **`sanitizeBinaryOutput` 里 pi 有一处疏漏**：它的注释写"孤立代理项已被 `Array.from` 过滤"，
   但 `Array.from` 按**码点**迭代，而孤立代理项本身就是码点 `0xD800-0xDFFF` —— 过滤不掉。
   我们显式滤掉这一段（孤立代理项会让字符串结构不完整，JSON 往返后变成 U+FFFD）。
   由 `tool-text-check` 固定，模块注释里写明这是**与 pi 的刻意差异**。
2. **`render-xss-check` 的 `audit()` 太天真**：它直接对整段标签查 `on\w+=`，
   于是把 `data-open-path="/w/x&quot; onmouseover=&quot;alert(1)"`（转义之后的属性值）
   误报成注入。改成"事件属性检查先删属性值，URL 检查必须看属性值"，并补了 5 条
   **"检查检查本身"**的断言（放宽之后必须仍抓得住 `script` / `onerror=` / `javascript:`）。
   顺带踩到一次反向的坑：第一版把两个检查都改成"删属性值之后查"，
   结果 `audit('<a href="javascript:alert(1)">')` 变成漏报 —— 被自己新加的断言当场抓住。
3. **量测结果比估算乐观**（R4 的"先量再优化"）：
   - 大输出（每次快照都是满 50KB）：**13 帧 / 549.4 KB / 5630ms ≈ 98 KB/s**；
   - `snapshot()`：24 条 / 107.3 KB / 5ms。
   结论：98 KB/s 没有越过"结构化克隆会卡"的界限，S3 **不做前缀增量**（D5 成立），
   4MB 的重放预算相对实测有 ~40 倍余量。
4. **`controller-check` 里我自己踩的一次坑**：新加的独立控制器忘了把消息推进
   同一个 `messages` 数组，于是所有"从视图里取工具行"的断言都拿到 `undefined`
   —— 一次 11 条 FAIL 的假警报。修好后 53/53。

### 12.3 最终检查

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（两个 tsconfig） | OK |
| `npm run self-test` | **6/6** |
| `npm run check:protocol` | **92 条** |
| `npm run check:render` | **74 条** |
| `tool-text-check` | **56 条** |
| `npm run check:controller` | **53/53**（含两项实测打印） |
| `npm run package` + `check-vsix` | OK（8 个必需文件、5.73 MB / 30 MB） |

### 12.4 待人工验收

- macOS（F5）：**M1–M14**（§6.2）
- 受限 Windows 机（0.1.5 发布后）：**W0–W6**（§6.3）


### 12.5 人工验收记录（macOS，0.1.5 源码树）

| 编号 | 项目 | 结果 | 证据 / 发现 |
| --- | --- | --- | --- |
| M1 | 工具卡片基本形态 | ✅ PASS（修了 3 处） | 首次 FAIL：**`▸` 箭头根本不出现**（`render.ts` 与 `main.ts` 各拼一份按钮内容，测试测到的那份有箭头、真机用的那份没有）；**标题还是原始 JSON**（计划 §4.6 没实现）；**路径不可点**（`renderPathLink` 只用在正文里）。三条都修了，并把拼装收敛成 `renderToolHeadLine`，加断言禁止 `main.ts` 自建 caret。 |
| M1b | 折叠/展开 | ✅ PASS | 用户反馈"bash 那一行怎么点都一样" —— 因为 **bash 折叠态本来就显示最后 5 行**（照 pi），输出只有 1 行时两态完全一样。补上 pi 的那行提示 `… 还有 N 行（点击标题展开）` |
| M2 | 流式输出 | ✅ PASS（修了 2 处） | 首次 FAIL：**运行中的卡片显示原始 JSON**（`title` 只在 `toolResult` 时铸造，运行中的行由控制器建）；**`Elapsed` 每秒被重置成 0.0s**（用户实测"0→2→0→3"—— `endedAt ?? startedAt` 在运行中恒等于 0，而每 200ms 的 upsert 会重渲染标题行，把每秒 tick 写的值抹掉）。两条都修了，并把 `now` 做成参数以便断言是确定性的。 |
| M2b | 折叠预览的行数 | ✅ PASS（修了 1 处） | `… 还有 7 行` 却只显示 4 行：计数减掉了末尾换行 split 出的空串、预览没减。统一成 `textLines()`；断言改成对 6/7/12/20 行断言"说的行数 === 总数−5 且显示行数 === 5"。 |
| M3 | **流式中途重开面板** | ✅ PASS | 重开后卡片仍在、**已流出的行（第 4–8 行）仍在**、`Elapsed 7.6s` 是真实值、输出继续长到第 20 行、结束显示 `Took 20.2s`。Output 里 `[webview] ready` 正好落在 `[agent] start` 与 `[tool] bash end` 之间。**C1/N1 家族第四处（partial 缓存）确认生效。** |

**验收过程本身的价值**：M1–M2 一共抓到 **6 个缺陷**，其中 5 个属于"测试全绿但真机上不对"
（两份拼装漂移、运行中缺 title、耗时被重置、两处行定义不一致）。它们都不是崩溃，
而是"看起来像回事、实际不对"，正是自动化检查抓不到、必须靠人眼的那一类。

| M4 | 命令失败（`exit 3`） | ✅ PASS | 红色 `×`；标题为命令 `exit 3`；正文是 **pi 自己写的结果文本**（`(no output)` / `Command exited with code 3`），我们没替它解释 |
| M5a | 大输出截断（`seq 1 4000`） | ✅ PASS（修了 2 处） | 首次 FAIL 是**重复**：pi 把 `[Showing lines 2001-4000 … Full output: …]` 写进正文，我们又渲染了"已截断 / 完整输出"两行 → 同一件事说三遍，而且那段脚注占掉折叠预览 5 个名额中的 2 个。pi 自己的 `renderResult` 就会把它剥掉（我们的两行正是它的 warning），已补上剥离 + 一条反向断言。修后：预览是干净的 5 行数字（3996–4000）、`还有 1995 行`、`已截断：显示 2000 / 共 4000 行`。**第二处**：正文里的「完整输出：<路径>」是**死链**（详见下） |
| M6 | 一回合两个工具 | ✅ PASS | `bash echo AAA` 与 `read /tmp/jerrypi-m8.md` **两张独立卡片**，各自有标题/耗时/箭头，顺序与调用一致（Output 里 read 先 end 只是它先执行完，与顺序无关） |

### 12.6 人工验收抓到的缺陷（共 7 个，**全部**是自动化检查抓不到的）

这 7 个缺陷有同一个特征：**代码看起来是对的、`npm run self-test` 全绿（300+ 条断言），
但真机上不对**。它们的形态是"能跑、不崩、只是不对"，属于必须靠人眼那一类。

| # | 缺陷 | 形态 | 根因 |
| --- | --- | --- | --- |
| 1 | `▸` 展开箭头不出现 | 少一个交互元素 | `render.ts` 与 `main.ts` **各拼一份**按钮内容（测试测的是有箭头的那份） |
| 2 | 标题显示原始 JSON | 同一张卡片运行中/结束后两种样子 | `title` 只在 `toolResult` 时铸造，运行中的行由控制器建 |
| 3 | `Elapsed` 每秒被重置成 0.0s | 数字来回跳（0→2→0→3） | `endedAt ?? startedAt` 在运行中恒等于 0，而每 200ms 的 upsert 会重渲染标题行，抹掉每秒 tick 写的值 |
| 4 | "还有 N 行"与显示行数不符 | 说的和显示的不一致 | 计数与预览用了**两个不同的"行"定义**（一个减掉末尾空行、一个没减） |
| 5 | pi 的截断脚注重复三遍 | 同一件事说三遍 | 我们没像 pi 的 `renderResult` 那样把脚注从正文剥掉 |
| 6 | 正文里的路径是**死链** | 看着可点、点了没反应 | `data-open-path` 出现在标题与正文两处，**只有标题挂了 handler**；正文那条落到 S2 的 markdown 链接处理器里 —— 它 `closest("a")` 命中、`preventDefault()`、发现**没有 `href`**，于是什么都不做 |
| 7 | 折起来的行数少一行（同类于 4） | 计数与预览不一致 | 同上 |

**#1 与 #6 是同一类根因**：同一个东西在两处产出/两处挂载，只有一处是对的。
两次的修法也一样 —— **收敛到一处**（`renderToolHeadLine` / 一次捕获阶段的委托），
并加一条"另一处不许自己实现"的源码断言。

| M5b | 正文里的「完整输出」路径可点 | ✅ PASS（修了 1 处） | 首次 FAIL 是**死链**：`data-open-path` 出现在标题与正文两处，只有标题挂了 handler；正文那条冒泡到 S2 的 markdown 链接处理器，它 `closest("a")` 命中、`preventDefault()`、发现没有 `href` → 什么都不做。改成**捕获阶段的一处委托**（路径优先于链接，命中即 stopPropagation），键盘可达性一并补上。用户复测：能打开，且确实是有 4000 行的日志 |
| M7 | 展开态与正文滚动 | ✅ PASS（修了 1 处） | 首次 FAIL："展开态保持，但每 200ms 被拽回正文顶部"。根因是我搞错了**滚动容器**：`.tool-text` 才有 `max-height: 40vh; overflow: auto`，`.tool-body` 的 `scrollTop` 恒为 0 —— 而"保存/恢复"存的正是后者。**更值得记的是那条断言是照着实现写的**（`/view\.body\.scrollTop = keepScroll/`），它断言的恰恰是这个 bug。现在按需求写：位置取自滚动容器本身 + 必须有"本来在底部就跟随"的分支。顺带让 `delta` 也跟随滚动（S2 只在 `item` 上滚，于是"逐字流式"其实是字往可视区下方长、转写区不动） |
| M8 | 转写区粘底 | ✅ PASS | 停在底部时自动跟随；流式期间往上翻，**视图停在翻到的位置**（不被拽回底部）；点发送后回到底部 |
| M9 | 工具输出里的 XSS | ✅ PASS | `echo '<img src=x onerror=alert(1)>'` —— **没有弹窗**，卡片标题与正文里都是**文字**。正文是命令输出（不可信输入）且每 200ms 重绘一次，这条是 S3 新增的安全回归点 |

### 12.7 面板前端的接线层检查（happy-dom）

**动机**：S3 的人工验收抓到 7 个缺陷，其中两个是"事件没接上"这一类 ——
`▸` 箭头根本没渲染（两处拼装漂移）、正文里的路径是死链（两处挂载，只有一处有 handler）。
纯函数断言与源码断言能兜住一部分，但**"派发一次真点击、看它发出什么消息"只有真 DOM 能测**。

**三条自我约束**（评审第 2 轮定，全部写进脚本头部注释）：

1. **喂真的**：HTML 由 `src/host/webviewHtml.ts` 生成，bundle 用
   `scripts/webview-bundle.mjs` —— 该文件同时被 `esbuild.mjs` 与测试台引用，
   是 webview 打包参数的**唯一**来源（否则测试台与真产物会漂成两个东西）。
   CI 里几个 check 跑在 clean build **之前**，所以测试台**不能**依赖 `dist/webview.js`。
2. **不测滚动**：happy-dom 没有排版引擎，`scrollHeight`/`clientHeight` 恒为 0 ——
   `isAtBottom()` 会永远为真。**滚动类不在覆盖清单里**，M7/M8 保留人工。
3. **不测 CSP**：happy-dom 不执行 CSP。nonce/CSP 由 `check:render` 的静态断言 + 真机覆盖。
   **本脚本全绿不等于面板能在 VS Code 里跑起来**，它不许当发版信号。

时钟是注入的（`Date.now` + `setTimeout/setInterval` 全接管，按到期时间排序触发），
所以 CI 上不会随机挂。

**红/绿验证（退休规则的机械证据）**：把测试台拿到修复前的提交上跑，断言必须变红。

| 修复前提交 | 红的断言 |
| --- | --- |
| `6c2d494^`（箭头不出现） | 3 条：标题行没有箭头、展开后箭头不变 `▾`、标题里的路径不可点 |
| `7a6c519^`（正文死链） | 1 条：点正文里的路径没有发出 `openFile`（详情里只有标题那条） |

**成本**：`happy-dom` 是 devDependency（14 秒安装 / 6 个包），**不进 `.vsix`** ——
打包后仍是 338 个文件、5.73 MB，包内 happy-dom 相关条目 **0**。

**一条流程规则（评审第 2 轮第 1 条）**：
> 一条人工项要退休，必须有一条断言在**修复前的那个 commit** 上是红的、修复后是绿的。
> 逐条退休，不整批砍。

按这条规则，**今天没有任何人工项被退休**：M1 的"箭头/展开态/标题路径"三小项虽然在
`6c2d494^` 上验过红，但 M1 还包含"点路径真的在编辑器里打开文件"（host 侧端到端，必须真机）；
M7/M8（滚动）、M9（XSS 从未坏过，没有红版本）、M10–M14（无红版本）都不满足条件。
**S3/S4 两片并行跑（测试台 + 完整人工），记录"测试台抓到几个 / 人工额外抓到几个"，
用两片的数据再决定退休哪些。**

### 12.8 测试台自身写错的地方（假警报，共 4 处）

写测试台的过程里出现 8 条 FAIL，**逐条查证后全部是测试写错，产品没有问题**：

| 假警报 | 真相 |
| --- | --- |
| 文档里存在 `<script>` 元素 | **真 HTML 骨架里本来就有** `<script src="webview.js">`；该断言应限定在卡片内部 |
| 忙时回车没有变成 steer | 发完之后 `pendingText` 还挂着（等宿主 `promptAccepted`）—— 这是 S2 刻意的防重复发送，测试漏了回一条确认 |
| 点「取回」按钮没发出 `clearQueue` | 点错按钮了：`#queue-button` 是「**追加**」，真正的「取回编辑」是 `renderQueue` **动态创建**的按钮 |
| `restoreComposer` 的值与预期不符 | 设计如此：取回的文本 + 空行 + 当前输入（pi 的 dequeue 语义），断言写成了全等 |
| 折叠后正文没隐藏 / 只显示 5 行不成立 | 两处：①bash 折叠时**本来就显示预览**（"隐藏"只对 read/write/edit 成立）；②我的反向控制点了标题文字，**顺带把卡片展开了**，后续按折叠态断言自然全错 |

**这条经验值得单独记**：假警报比不测更糟 —— 它会让人去修一个不存在的问题。
所以每一条 FAIL 都必须先问"是代码错还是测试错"，并且**把测试错的地方也修进脚本**
（不能只改断言让它变绿）。

### 12.9 S3 验收的收尾方式（人工项的处置）

M1–M9 已由用户逐项确认（截图见会话记录）。**M10–M14 未逐条人工执行**，处置如下 ——
不是"省掉"，是**换了在哪台机器上验**：

| 项 | 宿主侧（自动） | DOM 侧（自动） | 人工 |
| --- | --- | --- | --- |
| M10 `edit` 卡片 | `titleOf` 对 edit/write 的断言（protocol-check） | 与 read/write 共用 `renderToolCard`（harness 覆盖） | — |
| M11 重开点历史路径 | "重放快照仍带路径"、"白名单仍认得"（controller-check） | 路径点击发出 `openFile`（harness） | **W5（Windows）** |
| M12 展开 >50KB | pi 给的就是最后 2000 行（探针 C/G） | 展开态全量 + 截断脚注（render-check） | — |
| M13 中止不丢正文 | 探针 H + "中止后正文没丢/带 `Command aborted`"（controller-check） | pending → **就地**变 ✗、正文仍在、耗时变 Took（harness 新增 4 条） | **W6（Windows）** |
| M14 运行中点路径 | **新增**两条源码断言：`tool_execution_start` 与快照重建两处都必须调 `openablePathsOfToolCall` | 运行中的卡片渲染出可点路径 + 点击发出 `openFile`（harness） | **W5（Windows）** |

**为什么可以把 M11/M13/M14 放到 Windows 上验**：那台机器是**目标环境**，
而且它本来就是这两项更强的证据 —— 中止走 Git Bash + 进程树回收（与 Mac 不同路径）、
文件路径是 `C:\…` 形态。既然 0.1.5 无论如何都要上传才能在那台机器上测，
把它们放在 W5/W6 里做，比在 Mac 上先做一遍更省你一次来回。

**风险**：若那台机器上真出问题，修完要再发一版（0.1.6）—— 这个代价我们付过 4 次
（0.1.1–0.1.4），是可接受的。

### 12.10 Windows 验收结果（0.1.5，win32，node 24.18.1，VS Code 1.137.0）

**W0 `Pi: Run Self-Test` → `GATE PASS`（11 PASS / 0 FAIL / 0 SKIP）** ——
T1–T9 全过，含 T5b（abortBash 96ms 返回，cancelled=true）、T5c（工具调用 2061ms 结束）、
T8（worker 往返 1000×1000）、T9（newSession / switchSession）。
**结论：S3 对 `serialize.ts`/`controller.ts` 的改动没有破坏受限机上的运行路径。**

| 项 | 结果 |
| --- | --- |
| W1 基本形态 | ✅ 有样式、流式、markdown 正常 |
| W2 流式 + 运行中点路径 | ✅ 流式正常；**bash 卡片没有路径链接**（见下） |
| W3 中止不丢正文 | ✅ 卡片变 `✗`、已流出的行仍在、状态回「空闲」 |
| W4 截断 + 完整输出路径 | ✅（Windows 路径形态，`C:\…\AppData\Local\Temp\pi-bash-*.log`） |
| W5 重开 + 点历史路径 | ✅ |
| W6 XSS | ✅ 不弹窗，原样显示为文字 |

**W2 的发现（我的测试说明书写错了，不是代码错）**：
W2 让用户"点运行中卡片标题里的蓝色路径"——但那条命令是 **bash**，
而 **bash 卡片按设计就没有路径**（D7：只从 `args.path` 与 `details.fullOutputPath` 取路径，
**绝不正则 bash 命令**）。用户的判断"这一步本来也不该有链接"**是对的**，
实测反而确认了 D7 生效。

连带结论：**M14（运行中的卡片点路径）在真机上是不可达的场景** ——
带路径的工具（read/write/edit）都是亚秒级完成，抓不到"运行中"那一瞬；
bash 虽然能跑很久但没有路径。所以 M14 由两层自动断言守着（源码级：两处铸造路径；
DOM 级：pending 行渲染可点链接且点击发出 `openFile`），**Manual 版本标注为不可达**。

**W3 的发现（是我的验收说明书写错了）**：我写的是"**底部**状态行回空闲"，
实际状态行在**面板最上面**（`webviewHtml.ts:59` 的 `#status` 在 `#transcript` 之前）。
队列栏（`#queue`，第 61 行）确实在**输入框上方**。用户的备注只是指出与我写的"底部"不符 ——
这一处措辞由我订正；**布局该怎么定，不由我替用户下结论**。

**要不要为更贴近 pi 而把状态行挪到输入框上方，是个待定取舍**：pi 的 TUI 把
"生成中…"这类**工作状态**放在**输入框正上方**（用户键入时视线所在处），
而当前面板把它放在最上面、和标题同一带（S2 定下的版式）。
挪动成本很小（`#status` 从 `#transcript` 之前移到 `#queue` 之前），
但会改动 S2 的版式；两种做法各有理由，**取舍留给用户定**。

### 12.11 Marketplace 产物核验（0.1.5）

```
Marketplace 下载 5961264 B（gzip）→ 解压 6009856 B
SHA-256: 5e03d0fc2b0323cc29bd47f0be272b1a3e6bdaf9b188005afa430241872be5a0
本地构建 SHA-256: 同一个值
```
**⚠️ 教训一**：`curl` 直接下载 Marketplace 的 vsix 拿到的是 **gzip 流**
（响应头不是 `Content-Encoding`，所以 curl 不会自动解压；`file` 会显示
`gzip compressed data … original size modulo 2^32 6009856`）。
0.1.5 一开始就因此被判"不一致、疑似上传了旧包"，虚惊一场。

**⚠️ 教训二（更重要）：`.vsix` 的字节不可复现。** 打完 tag 后我为了别的事
重新执行了一次 `npm run package`，同一个 HEAD、同一棵树，得到的 `.vsix`
SHA-256 却变了：

```
已发布的  5e03d0fc…（6009856 B）
重建的    8938d184…（6009856 B）   ← 只差 zip 里的文件 mtime
```

解包逐文件比对：**338 个文件全部字节相同，0 个不同**；差别只在 zip 元数据。
所以"下载回来比字节"这条路只在**同一份文件**之间成立 —— 一旦本地重新打包，
比字节就会给出假警报。**规则改为：比内容（文件列表 + 每文件 SHA-256）。**

为此新增 `scripts/compare-vsix.mjs <version>`：嗅探并解开 gzip、解包两边、
比对文件列表与逐文件 SHA-256、把已发布的那一份留档到仓库外
`~/jerrypi-releases/`。0.1.5 用它复核通过（`VSIX-COMPARE OK 0.1.5`）。
