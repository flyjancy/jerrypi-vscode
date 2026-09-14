# S7 计划：diff 审阅（`filechanges.ts` + `diff.ts`）

> 状态：**计划期，待评审**（先过评审窗确认默认值，用户说"可以"后才动代码）。
> 上游：`docs/PLAN.md` §6 的 S7、§5.3 的"diff 审阅"条目、§5.1 的 `src/pi/filechanges.ts` 与 `src/host/diff.ts` 两个待建文件。
> 前置：S6 已关闭（0.1.8；设置与密钥）。**S7 的前置件已经齐了**：`custom-tools.ts` 的"同名覆盖内置 write + 按调用捕获 toolCallId"在 S1 就建好并被 T6 钉住（`PLAN.md` §6 的 S1 第 3 条）。
> 本步的验收（PLAN 原文）：让 agent 在**同一条消息里**对同一文件发出两次 edit，两张卡片各自只显示该次 patch；同一条消息里两次 write 同一文件，两张卡片前后内容各自正确；重启 VS Code 恢复会话后，edit 卡片的 diff 仍可打开，write 卡片显示"本次会话不可用"。
> 相关判据：G2（工具卡片可读）。

## 0. 本计划已核实的事实（都带证据，不靠记忆）

对着 pi 0.85.1 的产物与**本机真实的会话文件**逐条核过（2026-09-14）。

### 0.1 edit：patch 从哪来、长什么样、存在哪

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `edit` 工具的返回值自带三件东西：`details = { diff, patch, firstChangedLine }`。`diff` 是**带行号的展示串**（pi TUI 用），`patch` 是**标准 unified patch**，`firstChangedLine` 是新文件里的首个改动行号 | `dist/core/tools/edit.d.ts` 的 `EditToolDetails`；`dist/core/tools/edit.js:138` 的 `return { content: […], details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine } }` |
| F2 | patch 由**工具自己的执行边界**内生成：`generateUnifiedPatch(path, baseContent, newContent)`，其中 `baseContent`/`newContent` 是**归一化成 LF 后**的内容（`normalizeToLF` → 改 → `restoreLineEndings` 只在写盘时做）。所以 patch 里的行尾恒为 `\n`、且**必然是该次调用前的文件内容 vs 该次调用后的内容** —— 不是"当前磁盘"，也不是"首次保存的原文" | `edit.js:107-130`（`splitBom`/`detectLineEnding`/`normalizeToLF` → `applyEditsToNormalizedContent` → `generateUnifiedPatch`） |
| F3 | `generateUnifiedPatch` = `Diff.createTwoFilesPatch(path, path, old, new, undefined, undefined, { context: 4, headerOptions: FILE_HEADERS_ONLY })` —— **上下文 4 行**、只有 `--- / +++` 头（没有 index 行、没有时间戳） | `dist/core/tools/edit-diff.js:264`；`diff@8.0.4`（`node_modules/diff/package.json`） |
| F4 | patch 头里的路径是**模型给的原始路径**（`generateUnifiedPatch(path, …)` 的 `path` 就是 `params.path`），**不是**解析后的绝对路径。本机会话里看到绝对路径，只因为模型写的就是绝对路径 | `edit.js:130` vs `edit.js:95` 的 `resolveToCwd(path, ctx?.cwd || cwd)`；`~/.pi/agent/sessions/--Users-fengrui-Desktop-prj-jerrypi-vscode--/2026-09-14T11-43-13-620Z_*.jsonl` 里的 patch 头 `--- /Users/fengrui/Desktop/prj/jerrypi-vscode/scripts/controller-check.mjs` |
| F5 | **只有 `edit` 的 toolResult 持久化 `details`**。本机实测：会话文件里 `toolResult(toolName="edit")` 的 `details` 键就是 `['diff','patch','firstChangedLine']`；`write`/`bash`/`read` 的 toolResult 没有 `details` | 上面那个 jsonl（6 条 edit 记录全部有 details）；`dist/core/tools/write.js` 的 `return { content: […], details: undefined }` |
| F6 | 会话重放拿得到 `details`：`sessionEntryToContextMessages(entry)` 对 `type === "message"` **原样返回 `entry.message`**（不挑字段） | `dist/core/session-manager.js:165-177` |
| F7 | 包导出面里有 `generateUnifiedPatch`（漂移守卫可以直接调它），**没有** `parsePatch` / `applyPatch` —— 所以"把 patch 解析回两侧文本"必须我们自己写 | `pi-runtime/dist/bundle/index.js` 的 export 列表（`generateDiffString, generateUnifiedPatch, renderDiff …`，逐个 grep 过 `parsePatch`/`applyPatch`：0 次） |

**⇒ `diff@8.0.4` 的实际输出**（我实跑出来的，直接当断言夹具）：

```
单行文件整行替换     "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n"
多 hunk（改动相隔远） "--- a.ts\n+++ a.ts\n@@ -1,7 +1,7 @@\n L0\n L1\n-L2\n+X2\n L3\n…\n@@ -22,9 +22,9 @@\n L21\n…\n"
纯新增（左空）        "--- a.ts\n+++ a.ts\n@@ -0,0 +1,2 @@\n+l1\n+l2\n"
纯删除（右空）        "--- a.ts\n+++ a.ts\n@@ -1,2 +0,0 @@\n-a\n-b\n"
无尾换行              "…\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"
```

三条判据：① hunk 头**总是带 `,count`**（`-1,1 +1,1`，连 count=1 也不省）；② 空侧写 `-0,0 +1,2` / `-1,2 +0,0`；③ "无尾换行"用 `\ No newline at end of file` 标记，且**两侧各出现一次**（`-` 行后面一次、`+` 行后面一次）。
**但解析器仍要容忍不带 `,count` 的写法**（`@@ -5 +5 @@`）—— 那是 unified diff 的合法写法，别人家的 patch 可能有（F7 的漂移守卫只保证**今天这份** pi + diff）。

### 0.2 write：前后内容从哪儿来（这里有个"什么时候读盘"的陷阱）

| # | 事实 | 证据 |
| --- | --- | --- |
| F8 | 内置 `write` 的执行体是 `withFileMutationQueue(absolutePath, async () => { await ops.mkdir(dir); await ops.writeFile(absolutePath, content) })` —— **我们包进去的 `ops.writeFile` 一定在文件互斥队列之内** | `dist/core/tools/write.js` 的 `execute()`（S1 已核实过一遍，这次复核：两行 ops 调用都在队列回调里） |
| F9 | ⇒ 在 `ops.writeFile` 里"先读旧内容、再写新内容"是**原子**的：同一条消息里两次 write 同一文件时，第二次读到的正是第一次写完的内容（互斥队列串行化）。**这比在事件回调里读盘可靠** —— 回调的时机与文件状态可能对不上（并行工具调用），这正是计划 §5.3 划掉"快照式 diff"第一版的理由 | `write.js` 同上；`PLAN.md` §5.3 的"diff 审阅"条（"不在事件回调里读磁盘做快照（并行执行下会串）"）；S5 复核结论（`PLAN.md` 评审记录 D5 行："`withFileMutationQueue` 串行化后两张快照各自正确"） |
| F10 | 调用点已经现成：`session.ts` 把 `options.writeProbe` 传给 `createCustomTools(pi, cwd, probe)`，probe 的 `record(toolCallId, absolutePath)` 在 `ops.writeFile` 里被调用（S1 为了让"同名覆盖 + 按调用捕获 ID"这两件事可验证而建的） | `src/pi/session.ts:91`、`src/pi/custom-tools.ts`、`src/pi/selftest.ts:370`（T6 用它的证据） |
| F11 | **不能**指望 `write` 也带 patch：它的 details 恒为 `undefined`（F5）。所以 write 的 diff 只能靠我们在进程内存里存的前后内容；重启后**必然**拿不到 —— 这不是缺陷，是 F5 的直接推论 | F5 的两条证据 |

### 0.3 现有骨架：接哪儿、别碰哪儿

| # | 事实 | 证据 |
| --- | --- | --- |
| F12 | 工具卡片的协议项在 `src/shared/protocol.ts`（`kind:"tool"`）：已有 `toolCallId` / `toolName` / `summary` / `text` / `openablePaths` / `title.link` 等；**没有**任何 diff 字段 | `src/shared/protocol.ts` |
| F13 | 卡片里的可点路径走的是一条**两层同判**的链路：渲染层按 `openablePaths` 决定"渲染成可点还是纯文字"（`render.ts:250`），host 侧 `chatView.ts` 再用 `controller.isOpenableFile(path)` **精确比对**才真的打开（白名单键是绝对路径）。点击在 `main.ts` 的**捕获阶段一处委托**里分派（`data-open-path` → `{type:"openFile", path}`） | `src/webview/render.ts:246-252`、`src/host/chatView.ts:216-236`、`src/webview/main.ts:536-560` |
| F14 | host 侧的两个序列化入口：实时是 `onMessageEnd`（`raw = session.messages[last]` → `serializeMessage`），重放是 `snapshot()`（`serializeMessages(session.messages)`）。**两个入口都能拿到带 `details` 的原始 message**（F6） | `src/pi/controller.ts:889-905`、`:706` |
| F15 | `SessionHostController` 是**每个面板一个、活到扩展卸载**；`SessionHost`（含 runtime/session）会在 `newSession`/`switchSession` 时被替换。所以"本进程内兜底"的 store 要挂在 **controller** 上，不能挂在 host 上（否则切一次会话就丢） | `src/pi/controller.ts:129`（`view()` 取 host）、`:270`（替换后 `onSessionReplaced`） |
| F16 | `vscode` 桩现在**没有** `workspace.registerTextDocumentContentProvider`、也**没有** `commands` 里的 `diff`；`Uri` 只有 `file/parse/joinPath`（没有 `scheme`/`path`/`from`） | `scripts/fixtures/vscode-stub.mjs`（grep 三个名字：0 命中） |
| F17 | 本步**不需要**新的 VS Code 命令、不动 pi 的装配路径、不加依赖（`diff` 只作为断言期的对照物存在于 `node_modules` 里，是 pi 的传递依赖，**不进我们的 `package.json`**） | `package.json` 的 `dependencies`（当前只有 `@earendil-works/pi-coding-agent`） |

## 1. 目标与判据

**目标**：让 `edit` / `write` 的卡片能打开**该次调用自己的**前后对比，并且重启后 edit 的那份还能打开。

| # | 判据（PLAN 验收的逐条拆解） |
| --- | --- |
| C1 | 同一条消息里**两次 edit 同一文件** → 两张卡片各自只显示该次 patch（不是两次的并集、不是"当前磁盘 vs 首次原文"） |
| C2 | 同一条消息里**两次 write 同一文件** → 两张卡片的前后内容各自正确（卡 1：`before=X, after=Y`；卡 2：`before=Y, after=Z`） |
| C3 | **重启 VS Code 恢复会话后**：edit 卡片的 diff 仍可打开；write 卡片显示"本次会话不可用" |
| C4 | 打不开的时候**不许静默**：卡片上要看得出来（C3 的 write 就是这一条），host 侧拒绝要记 Output |

## 2. 本步做什么 / 不做什么

**做**：

1. `src/shared/patch.ts`：**纯函数** `sidesOfPatch(patch) → { left, right }`（unified patch → 两侧文本）+ `patchPathLabel(patch)`（取文件名给标题用）。
2. `src/pi/filechanges.ts`：按 `toolCallId` 的 store（`edit` 存 patch，`write` 存前后内容）+ `recordEditsFromMessages(messages, context)`（实时与重放**共用同一个函数**）。
3. 把 `custom-tools.ts` 的 `WriteProbe` 泛化成 `WriteRecorder`（多带 before/after），生产路径接上 store。
4. `src/host/diff.ts`：`jerrypi-diff:` 虚拟文档 + `vscode.diff`；`openDiff(toolCallId)` 只认 store 里登记过的 id。
5. 协议加 `diff` 字段、渲染加「查看 diff」链接、点击链路（`openDiff`）与 host 白名单。
6. README（中英）的已知限制一条：**write 的前后快照只在本次 VS Code 进程内**；edit 的重启后只显示**补丁视图**（改动附近 4 行上下文，不是整文件）。

**不做**（每条都有理由）：

| 不做 | 理由 |
| --- | --- |
| 在事件回调里读盘做快照 | 并行工具调用下时机与文件状态对不上（F9；PLAN §5.3 已划掉这一版） |
| 自己拼/改会话 JSONL 来持久化 write 快照 | AGENTS.md §4：**不自己拼会话 JSONL**（格式一定对是 pi 的义务，不是我们的） |
| 把 write 快照写进 VS Code 的 `globalStorage` | 那是**持久化用户的文件内容**，数据治理问题；PLAN 的验收口径就是"重启后不可用"（见 Q2） |
| 复用 Zetaphor 的 `providers/diff.ts` | 它的语义是"首次保存的原文 + 当前磁盘"，不是按调用的前后对比（PLAN §2 已核实）。只借"虚拟文档 provider"这个写法 |
| 给 `bash`/`grep`/`ls` 也做 diff | 无法可靠归属"这次调用改了哪个文件的哪一段"；宁可没有 |
| `firstChangedLine` 跳转、diff 内联渲染（不打开编辑器） | v1 不值得；先要"能打开真实 diff" |
| 我们自己给 edit 做同名包装以拿整文件前后 | 会把内置 edit 的行为纳入我们的修改面（多一个可能坏的地方），而且**实时与重启后会看到两种形态** —— 统一成"补丁视图"更诚实（见 Q1） |

## 3. 关键设计

### 3.1 数据形状（store 里存什么）

```ts
type FileChange =
  | { kind: "patch";    toolCallId: string; path: string; patch: string; at: number }
  | { kind: "snapshot"; toolCallId: string; path: string; before: string | null; after: string;
      newFile: boolean; at: number }
  | { kind: "unavailable"; toolCallId: string; path: string; why: "too-large" | "read-failed" | "evicted"; at: number };
```

- `edit` → `kind:"patch"`（F1/F2：patch 自带"该次前后"的语义）。
- `write` → `kind:"snapshot"`；`before === null` 表示**新文件**（`access` 失败）。
- 记不下（文件过大 / 读失败 / 被 LRU 淘汰）→ `unavailable`（**仍要留一条**：卡片据此显示"不可用"，而不是静默没链接）。

### 3.2 写入时机（三条入口，一个 store）

| 时机 | 路径 | 做什么 |
| --- | --- | --- |
| 实时 edit | `controller.onMessageEnd()` → 拿到 toolResult 的原始 message（F14） | `recordEditsFromMessages([message], ctx)` |
| 实时 write | 我们的 write 包装的 `ops.writeFile`（**在 pi 的互斥队列内**，F8/F9） | `stat` → 读旧内容 → 写 → `store.recordWrite(...)` |
| 重放/重启/切会话回来 | `controller.snapshot()` → `session.messages`（F6/F14） | `recordEditsFromMessages(session.messages, ctx)`（**同一个函数**，所以实时与重放不可能各写一套） |

三条都遵守同一条纪律：**recorder 的每一步都 try/catch，失败只写 Output，绝不让工具调用失败**（复盘 S6 的 M1：真机才会暴露的恰恰是这些边界）。

### 3.3 patch → 两侧文本（纯函数，规则写死）

```
输入：以 "\n" 分行的 unified patch
1. 丢掉前两行（`--- ` / `+++ `）；hunk 头 `@@ -a[,b] +c[,d] @@` 之后进入该 hunk 的正文
2. 正文行按首字符分类：` ` 两侧都要；`-` 只进左；`+` 只进右；`\ No newline at end of file` 是标记，不进正文
3. 该标记作用于**紧邻它的那一行**：若那行是 `-`/` ` → 左尾无换行；`+`/` ` → 右尾无换行
4. 输出 left = 左行数组 join("\n") +（左尾有换行 ? "\n" : ""）；right 同理
5. 容忍不带 `,count` 的 hunk 头（`@@ -5 +5 @@`）；容忍 `\r\n`（先归一化）
```

**为什么不是"整文件"**：patch 只保证改动附近 4 行（F3）。这是**诚实**的取舍（见 Q1），不是实现简化 —— 我们拿不到"该次调用前的整份文件"（F5：write/edit 的原文都不持久化）。

### 3.4 打开 diff（`src/host/diff.ts`）

- scheme：`jerrypi-diff:`；URI 形如 `jerrypi-diff:/<toolCallId>/<left|right>/<basename>`，query 里放一个自增序号。
  - **为什么要序号**：VS Code 按 URI 缓存虚拟文档，同一个 id 反复打开时同 URI 可能命中旧内容；内容本身是不可变的，但"同 id 换了内容"（比如被淘汰后重新登记）必须换 URI。
- `provideTextDocumentContent(uri)` 只认 store 里的 id；找不到就返回空串（VS Code 关闭文档时还会问一次，那时返回空串是正常路径，不记 Output 噪声）。
- `vscode.diff(left, right, title, { preview: true })`；title = basename + 形态：
  - patch：`a.ts（edit 前后 · 仅改动附近）`
  - snapshot：`a.ts（write 前 → 后）`，新文件写 `a.ts（新建）`
- **白名单**：`openDiff` 与 `openFile` 同一条纪律（F13）——渲染层按 item 上的 `diff` 字段决定给不给链接，host 侧再 `store.has(toolCallId)` 复核；未登记就记一行 Output 并**不打开**。

### 3.5 协议与渲染增量（最小）

| 位置 | 增量 |
| --- | --- |
| `protocol.ts` 的 tool item | `diff?: "patch" \| "snapshot"`；`diffUnavailable?: true` |
| `serialize.ts` | 从 `details`/store 推出上面两个字段（**不把 patch 本体塞进协议**：它可以是几十 KB，协议是每帧都要过的） |
| `render.ts` | `diff` 存在 → 标题行尾渲染 `<a class="tool-diff" data-open-diff="<toolCallId>">查看 diff</a>`；`diffUnavailable` → 渲染 `<span class="tool-note">本次会话不可用</span>`（**文案固定，见 Q3**） |
| `main.ts` | 捕获阶段的委托里加一条：`data-open-diff` → `{type:"openDiff", toolCallId}`（与 `data-open-path` 同一条路径，避免"看着可点、点了没反应"的第二次事故） |
| `chatView.ts` | `case "openDiff":` → `controller.isDiffOpenable(id)` → `diff.open(id)`；拒绝要写 Output |

### 3.6 内存上限（Q4 的默认值）

- `write` 快照：**条数 20 / 总量 8 MiB**（先到先淘汰，LRU 按插入序即可，因为 diff 只在最近几分钟有用）；淘汰时把该 id 改成 `unavailable{why:"evicted"}`（**不要直接删**，否则卡片会静默失去说明）。
- 读盘前先 `stat`：单文件 > 2 MiB 直接记 `unavailable{why:"too-large"}`（**不读**）——不然一次 write 一个大文件就让扩展宿主多背一份内存。
- `edit` 的 patch 一律保留（它是文本、且是重启后唯一的来源）；上限只对 patch 条数生效（100 条）。

## 4. 决策与默认值（Q1–Q7，等用户拍板）

| # | 问题 | 默认（我的建议） | 备选 / 为什么不选 |
| --- | --- | --- | --- |
| Q1 | 重启后 edit 的 diff 只显示**改动附近 4 行**（补丁视图），不是整文件 | **接受**（F3/F5：我们拿不到该次调用前的整份文件） | 不显示 → 违背 PLAN 验收；给 edit 也做同名包装拿整文件 → 见 §2 不做清单 |
| Q2 | write 的 diff 重启后消失（只活在进程内） | **接受**，卡片显示"本次会话不可用"（PLAN 原文口径） | 存进 VS Code `globalStorage` → 持久化用户文件内容，另立数据生命周期（要用户单独拍板才做） |
| Q3 | 入口与文案：标题行尾的「查看 diff」；不可用时「本次会话不可用」 | **接受** | 放正文里 → 折叠时点不到；另一个文案"（快照已过期）"更含糊 |
| Q4 | write 快照上限 20 条 / 8 MiB；单文件 > 2 MiB 不读 | **接受** | 不设上限 → 长会话里内存只增不减；上限调大 → 收益边际 |
| Q5 | 只对 `edit` / `write` 提供 diff（`bash` 写文件不管） | **接受** | 见 §2 不做清单 |
| Q6 | v1 不做 `firstChangedLine` 跳转 | **接受** | 要额外一次 `revealRange`，收益小 |
| Q7 | 打开方式：当前列、`preview: true`（再点别的 diff 会复用同一组标签） | **接受** | 固定新列 → 会堆一堆编辑器 |

## 5. 风险

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | patch 解析写错（尤其“无尾换行”与多 hunk） | 打开的是错的左右文本 —— **看起来像真的**，最难发现 | 纯函数 + 夹具（§0.1 的实跑输出）+ **漂移守卫**（拿 pi 的 `generateUnifiedPatch` 现场生成再解析） |
| R2 | 读盘失败/文件巨大把 write 拖慢或撑爆内存 | 工具调用变慢、宿主内存增长 | `stat` 门槛 + 上限 + try/catch（§3.6） |
| R3 | 虚拟文档 URI 缓存串味（同一个 id 重复打开拿到旧内容） | 看到过期 diff | URI 里带自增序号（§3.4）；内容不可变，不需要 `onDidChange` |
| R4 | 卡片上的链接**看着可点、点了没反应** | S6 的 M5 已经出过一次同类事故（`data-open-path` 死链） | 两层同判（§3.5）+ webview-dom 断言点击真的 post 了消息 |
| R5 | write 包装在未来某次 pi 升级后不再是"同名覆盖" | 快照静默失效（卡片显示"不可用"而不是报错） | T6 继续钉住 `sourceInfo.source === "sdk"`（S1 已建）；升级时先跑 `check:gate` |

## 6. 检查清单（自动断言，先红后绿）

**每条都要先看它红**（改坏被测实现 → 断言必须失败），**且不许对着想象中的实现写**（夹具用真的 pi / 真的 `diff@8.0.4` 输出）。

| # | 断言 | 放哪 | 能红验证 |
| --- | --- | --- | --- |
| A1 | `sidesOfPatch` 对 5 组夹具（单行文件整行替换 / 多 hunk / 纯新增 / 纯删除 / 无尾换行）逐字符正确；`@@ -5 +5 @@`（不带 count）也能解析 | host-check | 把 hunk 头正则改成贪婪匹配 → "多 hunk"那条红 |
| A2 | store：`edit`/`write`/`unavailable` 三种记录都能取回；超过条数上限时最旧的变 `unavailable{why:"evicted"}`（**不是消失**）；`recordWrite` 收到超大 `before` 时**没有**把内容存进来 | host-check | 去掉淘汰逻辑 → 上限那条红 |
| A3 | `openDiff`：已登记 → `vscode.diff` 恰好调用一次，两个 URI 都是 `jerrypi-diff:`、左右内容与 `sidesOfPatch` 一致、标题含文件名；未登记 → **不调用** `vscode.diff` + Output 有一行拒绝 | host-check（桩要补 `registerTextDocumentContentProvider` / `diff` / `Uri.from`） | 把 host 侧的白名单去掉 → "未登记"那条红 |
| A4 | 重放登记：给一组 `messages`（含 `toolResult(toolName="edit", details.patch)` 与一条 `write`）→ `recordEditsFromMessages` 之后 edit 能打开、write 的 item 是 `diffUnavailable === true` | host-check | 把重放那条调用删掉 → 红 |
| A5 | 渲染/交互：`diff:"patch"` → 渲染出 `data-open-diff`；`diffUnavailable` → 有说明文字、**没有**链接；`toolCallId` 里的 `<`/`"` 被转义；点击链接只 post 一条 `{type:"openDiff"}` 且**不**展开卡片 | render-xss-check + webview-dom-check | 把渲染条件改成"永远渲染链接" → 第一条红 |
| A6 | 真写工具（真 pi、**不用模型**）：对同一文件顺序两次 `execute("id-1"…)` → 记录为 `(before=null,after=X)`、`(before=X,after=Y)` | controller-check | 把 `before` 改成读"写完之后"的内容 → 第二条红 |
| A7 | 真模型（**PLAN 验收的自动版**）：一条消息里两次 edit + 两次 write 同一文件 → 两张 edit 卡片的 patch **互不包含**对方 marker；两张 write 卡片 `卡2.before === 卡1.after` | controller-check | 把 patch 改成"从当前磁盘重建" → edit 那条红 |
| A8 | **漂移守卫**：调用 pi 的 `generateUnifiedPatch` 现场生成 patch（5 组输入）→ 我们的解析器还原出的两侧，与输入内容一致 | controller-check（在 host-check 里也能做，但那里没有真 pi） | 关掉 `context: 4` 的假设（改成 1） → 至少一条红 |
| A9 | `Pi: Run Self-Test` 的 T6 扩展：写包装的记录里 `before/after` 正确（现有断言只查 toolCallId） | selftest（T6，真模型但**复用已有那一轮**） | 记录里塞一个假 before → 红 |

> A5 的两条检查分别落在 render（字符串层）与 webview-dom（真 DOM 事件层）—— S6 的 M5 死链就是后者能抓、前者抓不到的形态。

## 7. 人工验收（Mac，**2 个动作**，一次 F5 会话里做完）

**M1（活的 diff）**：在面板里粘一句现成话术（我来提供，包含：同一文件两次 edit、同一文件两次 write、一个新文件 write），然后**点四张卡片的「查看 diff」**：

- 两次 edit 的 diff **各只含自己那次改动**（第一次看不到第二次的 marker）；
- 两次 write 的 diff 是**整文件前后**，且第二次的"前"等于第一次的"后"；
- 新建文件的 diff 左侧是空的、标题写「新建」。

**M2（重启后的口径）**：`Developer: Reload Window` → 同一个会话 → 同一批卡片：**edit 的 diff 还能打开**（补丁视图）、**write 的卡片显示「本次会话不可用」**（不是死链）。

> 为什么必须人工：① 真焦点/真点击（虚拟文档、diff 编辑器是 VS Code 自绘）；② 真进程（重启后的重放路径）；③ 排版（标题行放不下时会不会挤）。三类都在 AGENTS.md §1 的人工清单里。

## 8. Windows 项（不新增）

- **W0**：`Pi: Run Self-Test`（T6 已含 A9 的新断言）—— 期望仍是 `GATE PASS`。
- **W1**：重启后会话正常（不变）。
- diff 的**解析**与平台无关；`vscode.diff` 也是 VS Code 自绘 —— **不为它单独加 Windows 动作**（写了就会超预算，且没有平台特有风险）。若 W0 里 T6 红，再单独查。

## 9. 步骤（每步单独提交 + 门禁全绿）

| 步 | 内容 | 结束时的门禁 |
| --- | --- | --- |
| 1 | `src/shared/patch.ts` + A1（先红） | typecheck / self-test |
| 2 | `src/pi/filechanges.ts`（store + `recordEditsFromMessages`）+ A2/A4 | self-test（host-check） |
| 3 | 写包装改名 `WriteProbe → WriteRecorder` 并带 before/after（**改名让编译器抓误用**）+ A6/A9 | self-test + `check:controller` |
| 4 | `src/host/diff.ts` + 桩补三件套 + A3 | self-test（host-check） |
| 5 | 协议/渲染/点击链路 + A5 | self-test（render + webview-dom） |
| 6 | controller 接线（三条入口）+ 文档（README 中英、`pi-traps`）+ A7/A8 | 全部 + `check:gate` |
| 7 | 版本 0.1.9 + 打包 + Mac M1/M2 + 上传核验 + Windows W0/W1 + §12 回填 → 关阶段 | 发布流程（§4） |

## 10. 评审记录

_（待评审：第 1 轮送 Claude；每轮结论与处置落这里，≤3 轮。）_

## 11. 实施期发现

_（实施时逐条记；红过的东西、真机才暴露的东西、改过的计划都写这里。）_

## 12. 实施与验收结果

_（自动检查 / 提交切分 / 人工验收 / 已知未覆盖。）_

## 13. 待用户拍板

见 §4 的 **Q1–Q7**。**默认值都是我的建议**；用户说"可以"之后才动代码。
