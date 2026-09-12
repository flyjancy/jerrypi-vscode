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
   → 断言**不能**写"正文单调增长"，只能写"正文 === 最后一次快照"；
   UI 上展开态看到顶部内容被顶掉是**预期行为**（pi 的 TUI 同样如此，它用 `... (N earlier lines)` 提示）。

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
   缓存每个工具的 partial 文本供重放使用；登记"可打开的文件路径"白名单。
4. **宿主**：处理 `openFile`（只放行控制器铸造过的 `file://` URL）。
5. **UI**：工具卡片（标题行 + 可展开正文）、bash 折叠显示最后 5 行、耗时、截断脚注、
   **就地更新**（不整体重写 DOM）、**粘底滚动**。
6. **可打开路径**：由 `serialize.ts` 在每次序列化时铸造（重放也会重新铸造，所以历史卡片照样能点），
   控制器登记成白名单，host 只做精确比对后 `Uri.file` 打开。
7. **检查**：新增纯函数与渲染断言；`check:controller` 补真实场景（流式、重开、失败、截断、
   帧竞态、快照体积与耗时）。

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
| `src/pi/serialize.ts` | 改 | `toolResult` 分支补正文与元信息；`itemChars` 计入正文 |
| `src/pi/controller.ts` | 改 | `tool_execution_update`；partial 缓存；可打开路径登记；重放合并 |
| `src/host/chatView.ts` | 改 | `openFile` 分发（校验后 `showTextDocument`） |
| `src/webview/render.ts` | 改 | `renderToolCard`（纯函数，仍可在 Node 里跑） |
| `src/webview/main.ts` | 改 | 工具卡片的**就地更新**、展开态保持、粘底滚动 |
| `src/webview/style.css` | 改 | 卡片样式（标题行、正文、脚注、状态色） |
| `scripts/tool-text-check.mjs` | **新增** | `toolText.ts` 的纯函数断言 |
| `scripts/self-test.mjs` | 改 | 用例 6 挂上新的检查脚本 |
| `scripts/protocol-check.mjs` | 改 | tool item 字段、实时/重放一致性的静态断言 |
| `scripts/render-xss-check.mjs` | 改 | 卡片渲染与转义断言 |
| `scripts/controller-check.mjs` | 改 | 真实场景：流式多次 upsert、中途重开、失败、截断、白名单 |
| `README.md` | 改 | 特性表把"工具行"升级为"工具卡片"；已知限制补一条（图片不显示） |
| `docs/PLAN.md` | 改 | S3 状态标记；如发现事实与计划不符，就地更正 |

---

## 3. 不可违反的约束

1. **单点序列化**：一条 pi 消息 → 一个 `ChatItem` 只经过 `serialize.ts`。
   实时路径（事件流）与重放路径（消息数组）不得各写一份。
   **两条路径的分工必须写死**（否则"逐字节相同"的断言写不出来）：

   | 字段 | 谁产出 | 重放时 |
   | --- | --- | --- |
   | `toolName / summary / text / truncation / isError` | `serialize.ts` | ✅ 有 |
   | `openablePaths` | `serialize.ts`（读 `ctx.cwd`） | ✅ 有（每次重放重新铸造） |
   | `startedAt / endedAt / pending` | `controller.ts` 装饰 | ❌ 没有（内存态） |

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
  truncation?: { truncatedBy: "lines" | "bytes"; totalLines: number; outputLines: number };
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
（不能切出半个 emoji），并且只裁一次（二次裁剪会把"已截断"标记也裁掉）。

### 4.3 `src/pi/serialize.ts`（增量）

`toolResult` 分支补：

```ts
const body = toolTextFromContent(message.content);
const clipped = clipToolText(body, TOOL_TEXT_MAX_BYTES);
const meta = toolMetaOf(message.details);   // 只取标量，**不带** truncation.content
const openablePaths = openablePathsOf(message, ctx);  // 参数 path + details.fullOutputPath，按 ctx.cwd 解析成绝对路径
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
   - 清理时机：`tool_execution_end` 之后仍保留到该 toolResult 的 `message_end`
     （最终态由消息构建），随后删除；会话替换 / `newSession` 时整体清空。

3. **可打开路径白名单**
   - `private openable = new Set<string>()`（值 = **绝对路径**，不是 URL）；
   - 铸造点在 `serialize.ts`（§4.3）：工具参数里的 `path` 与 `details.fullOutputPath`，
     相对路径按**会话 cwd** 解析（`path.resolve`，与 pi 的 `linkPath` 同规则）；
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
- 截断：正文末尾加脚注 `[完整输出：<path>]`（path 若是可点路径则渲染成链接）。

### 4.7 `src/webview/main.ts`（增量）

- `toolViews: Map<string, { node, head, body, open: boolean }>`；
  upsert 时**只更新 head 与 body 的 innerHTML**，节点本身复用 → 展开态与选中不丢；
- 展开/折叠由用户点击标题行切换（`<button aria-expanded>`），状态记在 `toolViews` 里；
- 粘底：`isAtBottom()` 阈值约 40px；`renderItem` 只在 `isAtBottom()` 为真时滚到底；
  用户点发送/回车时强制滚到底；
- 进行中的耗时：`setInterval(1s)` 只更新"进行中"卡片的耗时文本（不重发协议消息）。

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
| M7 | **把 bash 卡片展开**，然后等它继续输出 | 展开态**不被重置**（就地更新），且新增内容可见 |
| M8 | 流式期间**往上滚动**看历史 | 视图**不被拽回底部**；点发送后自动回到底部 |
| M9 | 发 `echo '<img src=x onerror=alert(1)>'` | 面板里是**文字**，不弹窗（结果正文是不受信输入） |
| M10 | 让 agent `edit` 一个小文件 | 卡片标题是可点路径；正文是结果文本（**没有 diff** —— 那是 S7） |
| M11 | **重开面板（`Developer: Reload Webviews`）后点历史卡片里的路径** | 仍能在编辑器里打开（白名单由重放重新铸造 —— 这是评审抓到的洞） |
| M12 | 让 agent 输出超过 50KB（如 `seq 1 4000`）并展开卡片 | 正文能看到尾部与 pi 的截断脚注 `[Showing … Full output: …]`；**顶部内容被顶掉是预期的**（§0.2 第 4 条） |

### 6.3 受限 Windows 机（人工，从 Marketplace 更新后）—— W 系列

| 编号 | 做什么 | 判据 |
| --- | --- | --- |
| W0 | **先跑 `Pi: Run Self-Test`** | 仍须 `GATE PASS`（本步动了 `serialize.ts`/`controller.ts`，属于 S1 已验证路径的邻居，必须先自证没破坏） |
| W1 | M1 + M2 | 同 Mac |
| W2 | M3 + M7（重开 + 展开态） | 同 Mac —— 这两条是 S3 最容易在两台机器上表现不同的地方 |
| W3 | M5（截断 + 打开完整输出） | Windows 的临时目录路径形态不同（`C:\Users\…\AppData\Local\Temp\…`），要确认可点路径在 Windows 上也能打开 |
| W4 | M4 + M9 | 失败态与 XSS 回归 |
| W5 | M11（重开后点历史路径） | Windows 的路径形态（`C:\…`）与 Mac 不同，白名单比对必须仍然精确命中 |

### 6.4 判据

- CI 全绿；Mac 的 M1–M10 全 PASS；Windows 的 W0–W4 全 PASS。
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

---

## 9. 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | **把快照当增量**拼接（§0.2 第 2 条） | 协议里 tool 正文是"整体替换"语义；controller-check 断言"**正文 === 最后一次快照**"。⚠️ **不能**断言"单调增长"：超过 50KB 后快照会换头（探针 G，§0.2 第 4 条） |
| R2 | **第一次更新的 `content: []`** 被当成"空输出"覆盖掉已有正文 | `onToolExecutionUpdate` 只在 `content[0]?.text` 存在时才更新正文（占位更新只用来建行） |
| R3 | 就地更新写错 → 展开态在流式期间被重置 | M7 作为回归点；`toolViews` 只改 head/body 的 innerHTML |
| R4 | 50KB/次 × 5 次/秒的 postMessage 体积 | 先量：`check:controller` 里统计一个 5 秒命令的消息数/字节数并打印；若持续 >100KB/s 再引入"前缀增量 + 最终整体 upsert" |
| R5 | 重放时正文与实时不一致（历史里没有我们的裁剪标记） | 单点序列化 + `itemBytes` 计入正文 + protocol-check 的等价性断言 |
| R6 | `details` 里的 `truncation.content` 让单条 item 翻倍 | 只取标量字段（§0.4 的结论），render/protocol 两侧各有一条断言 |
| R7 | 路径白名单失效（伪造 `file://` 打开任意文件） | 白名单由控制器铸造；host 侧再校验一次；render-xss-check 里有"未登记 URL 不可点"的断言 |
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
- **探针 G（流式 + 超过 50KB，约 160KB 输出）**：
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
