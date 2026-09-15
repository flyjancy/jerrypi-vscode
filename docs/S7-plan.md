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
| F5 | **只有 `edit` 的 toolResult 持久化 `details`**。本机实测：会话文件里 `toolResult(toolName="edit")` 的 `details` 键就是 `['diff','patch','firstChangedLine']`；`write`/`bash`/`read` 的 toolResult 没有 `details` | 上面那个 jsonl（**72 条正常 edit 全部有 details**；3 条失败的见 F5b —— 第一版这里只写了最初看到的 6 条，两处数字不一致是评审 N5 抓到的）；`dist/core/tools/write.js` 的 `return { content: […], details: undefined }` |
| F5b | ⚠️ **失败的 edit 带 `details = {}`（真值空对象）**：本机会话实测有 3 条这样的 toolResult（`Found 2 occurrences of edits[0]…`、`No changes made…`、`Could not find edits[1]…`），`isError: true`、`details` 是 `{}`。所以「details 存在」**不等于**「有 patch」——`if (details)` 这一类判断会给失败的 edit 挂上一个点开是空的死链（正是 C4/R4 要防的） | 本机 `~/.pi/agent/sessions/--Users-fengrui-Desktop-prj-jerrypi-vscode--/2026-09-14T11-43-13-620Z_*.jsonl`：72 条正常 edit 全是 `['diff','patch','firstChangedLine']`，3 条失败的全是 `{}`；抛错点在 `edit.js:105-113`（access 失败）与 `edit-diff.js:258-260`（`getNoChangeError`） |
| F6 | 会话重放拿得到 `details`：`sessionEntryToContextMessages(entry)` 对 `type === "message"` **原样返回 `entry.message`**（除了 `content == null` 时会重建成 `{...message, content: []}` —— 实测过：`details` 照样在，但「原样」这个说法不准确） | `dist/core/session-manager.js:165-177` |
| F7 | 包导出面里有 `generateUnifiedPatch`（漂移守卫可以直接调它），**没有** `parsePatch` / `applyPatch` —— 所以"把 patch 解析回两侧文本"必须我们自己写 | `pi-runtime/dist/bundle/index.js` 的 export 列表（`generateDiffString, generateUnifiedPatch, renderDiff …`，逐个 grep 过 `parsePatch`/`applyPatch`：0 次） |

**⇒ `diff@8.0.4` 的实际输出**（我实跑出来的，直接当断言夹具）：

```
单行文件整行替换     "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n"
多 hunk（改动相隔远） "--- a.ts\n+++ a.ts\n@@ -1,7 +1,7 @@\n L0\n L1\n-L2\n+X2\n L3\n…\n@@ -22,9 +22,9 @@\n L21\n…\n"
纯新增（左空）        "--- a.ts\n+++ a.ts\n@@ -0,0 +1,2 @@\n+l1\n+l2\n"
纯删除（右空）        "--- a.ts\n+++ a.ts\n@@ -1,2 +0,0 @@\n-a\n-b\n"
无尾换行              "…\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"
```

三条判据：① hunk 头**总是带 `,count`**（`-1,1 +1,1`，连 count=1 也不省）；② 空侧写 `-0,0 +1,2` / `-1,2 +0,0`；③ 「无尾换行」用 `\ No newline at end of file` 标记，**0/1/2 次都合法**，作用于**紧邻它的上一行**（评审 N1 实测：`"a\nb" → "a\nb\n"` 只有 1 次、`"" → "a"` 只有 1 次、两侧都无尾换行才有 2 次）。
另外两条要容忍的形态（评审 N2）：④ hunk 头尾部可能有 section heading（`@@ -1,7 +1,7 @@ function foo()`）—— 正则不能 `$` 锚定；⑤ patch 恒以 `\n` 结尾，`split("\n")` 的最后一个空元素要**显式丢掉**（现在靠「首字符落不进任何分类」兜着，是巧合不是规则）。
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
| F15 | `SessionHostController` 是**每个面板一个、活到扩展卸载**；`SessionHost`（含 runtime/session）会在 `newSession`/`switchSession` 时被替换。所以「本进程内兜底」的 store 要挂在 **controller** 上，不能挂在 host 上（否则切一次会话就丢） | `src/pi/controller.ts:1086`（`private view()`）、`:345`（`this.host = host`）、`:780`（`this.host = undefined`）、`:270`（替换后 `onSessionReplaced`）—— 第一版引的 `:129` 是 `SessionView` 接口里的 `isStreaming`，**引用错、结论对**（评审 S1） |
| F16 | `vscode` 桩现在**没有** `workspace.registerTextDocumentContentProvider`、也**没有** `commands` 里的 `diff`；`Uri` 只有 `file/parse/joinPath`（没有 `scheme`/`path`/`from`） | `scripts/fixtures/vscode-stub.mjs`（grep 三个名字：0 命中） |
| F17 | 本步**不需要**新的 VS Code 命令、不动 pi 的装配路径、不加**运行时**依赖：`diff@8.0.4` 只是断言期的对照物（它是 pi 与 `pi-agent-core` 的**传递依赖**，我们的 `package.json` 里**根本没有 `dependencies` 键**，pi 在 `devDependencies`；`package` 脚本还带 `--no-dependencies`）**但**：A8 的 oracle 直接 `import "diff"`，靠传递依赖太脆（pi 换掉它就成了 import 失败，而按本仓纪律 import 失败不算红）→ **把 `diff: "8.0.4"` 写进 `devDependencies`**，并在 A8 里断言版本（不符就**显式失败**，不是 SKIP）。devDependencies 不会进 VSIX，所以这条与本行开头的结论不冲突 | `package.json`（`dependencies` 缺失、pi 在 `devDependencies`）；`npm ls diff` → `@earendil-works/pi-coding-agent@0.85.1 → diff@8.0.4`（评审 S1 的改正、S5 的加固） |
| F18 | **host-check 里已经有「真 pi」**：它把 `loadPi` 打进临时 bundle，并且在 A6b/A7 里真的加载了 `pi-runtime/dist/bundle/index.js`。所以「纯函数、不需要凭据」的漂移守卫必须放 host-check，不能放 controller-check（那支没凭据时整体 SKIP，而 SKIP 不是 PASS） | `scripts/host-check.mjs:166`（导出 `loadPi`）、`:841-842` 的注释、`:881`/`:955`（真的 `await loadPi(REPO_ROOT)`） |

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

1. `src/shared/patch.ts`：**纯函数** `sidesOfPatch(patch) → { left, right, hunks: { left: string[]; right: string[] }[] }`（两侧文本给渲染用；`hunks` 是**每个 hunk 各自的行**，给断言与 oracle 对照用 —— 评审 S2 指出：只有扁平两侧时，测试想逐 hunk 比就得拿我们自己插的分隔行去切，那是把 oracle 和实现耦在一起）。另有 `pathLabelOf(patch)`：从 `+++` 取（缺失时退回 `---`）、容忍 GNU diff 的 `\t<时间戳>` 尾巴，**不 import `node:path`** —— `src/shared/` 会打进浏览器产物（`esbuild.mjs:10`），basename 要自己同时按 `/` 与 `\` 切，Windows 的 `C:\a\b.ts` 才取得到 `b.ts`（评审 N2 补的两条）。
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

- `edit` → `kind:"patch"`（F1/F2：patch 自带「该次前后」的语义）。**但只有 `typeof details.patch === "string" && details.patch !== ""` 才登记**（F5b：失败的 edit 是 `details = {}`）。失败的 edit **既不登记、也不给 `unavailable`** —— 那不是「不可用」，是「这次调用根本没改成文件」，卡片上什么都不显示才对。
- `write` → `kind:"snapshot"`；`before === null` 表示**新文件**（`access` 失败）。
- 记不下（文件过大 / 读失败 / 被淘汰）→ `unavailable`（**仍要留一条**：卡片据此显示「不可用」，而不是静默没链接）。

### 3.2 写入时机（三条入口，一个 store）

| 时机 | 路径 | 做什么 |
| --- | --- | --- |
| 实时 edit | `controller.onMessageEnd()` → 拿到 toolResult 的原始 message（F14） | `recordEditsFromMessages([message], ctx)` |
| 实时 write | 我们的 write 包装的 `ops.writeFile`（**在 pi 的互斥队列内**，F8/F9） | `stat` → 读旧内容 → 写 → `store.recordWrite(...)` |
| 重放/重启/切会话回来 | `controller.snapshot()` → `session.messages`（F6/F14） | `recordEditsFromMessages(session.messages, ctx)`（**edit 的实时与重放共用这一个函数**；write 只有实时那一条入口 —— 这句在 write 上从来不成立，评审 N4） |

**三条语义必须写死（B1/B2 两轮评审的共同结论）**：

1. **重放只登记 `edit`，绝不碰 `write` 的记录**。`recordEditsFromMessages` 只可能处理带 patch 的 `toolResult`（F5：write 的 toolResult 没有 details 可登记）；write 的「可用/不可用」是**在序列化时从 store 派生**的（store 里有 snapshot → `diff:"snapshot"`；没有 → `diffUnavailable:"none"`）—— 重放不会往 store 里写 `unavailable`。
2. **按 kind 分开写**（不是一条"upsert-if-absent"套两边 —— 第 1 轮我这么写，第 2 轮 B2 证明它把 edit 锁死了）：
   - `edit` 的 patch：**可覆盖**（含覆盖墓碑）。它由 `details.patch` 唯一确定（F1/F2），覆盖 = 幂等；而且它在会话文件里躺着、每次重放都能免费再生（F6）—— "已有就别动"只会让被淘汰的 patch 永远回不来，与 C3 的承诺（重启后 edit 的 diff 仍可打开）直接冲突，也与 §3.4 给 URI 加序号的理由（"被淘汰后重新登记"）自相矛盾。
   - `write` 的 snapshot：**只有实时那一条入口写它**（`ops.writeFile`），重放从不写。所以"不覆盖"不需要额外规则——它天然只有一个写者；store 的 `set` 语义即可。
3. **同一 id 的两种记录不会互相污染**：墓碑是独立记录，被 patch 覆盖后就不再是墓碑。

> 第 1 轮的 B1（"重放把实时快照改写成 unavailable"）**不成立**（能写 `unavailable` 的只有淘汰/读失败路径）；但它指出的**覆盖缺口是真的**：原 A4 只断言"空 store 重放 → write 不可用"，那条从写下的第一天起就是绿的。而现在这段的第 2 条又修掉了第 1 轮引入的 upsert-if-absent —— 两次评审的方向正好相反，**判据是同一个**：C3 承诺的是"重启后 edit 的 diff 仍可打开"。

三条都遵守同一条纪律：**recorder 的每一步都 try/catch，失败只写 Output，绝不让工具调用失败**（复盘 S6 的 M1：真机才会暴露的恰恰是这些边界）。

### 3.3 patch → 两侧文本（纯函数，规则写死）

```
输入：按 "\n" 切开的 unified patch（**最后那个空元素显式丢掉**；不做任何「行尾归一化」——
      patch 正文行里的 \r 是文件内容的一部分，全局归一化会静默吃掉它（评审 S2 实测：
      generateUnifiedPatch("a.ts","a\r\nb\r\n","a\r\nB\r\n") 的正文里真有 "a\r"/"-b\r"））
1. 丢掉前两行（`--- ` / `+++ `）；hunk 头 `@@ -a[,b] +c[,d] @@` 之后进入该 hunk 的正文
2. 正文行按首字符分类：` ` 两侧都要；`-` 只进左；`+` 只进右；`\ No newline at end of file` 是标记，不进正文
3. 该标记作用于**紧邻它的那一行**：若那行是 `-`/` ` → 左尾无换行；`+`/` ` → 右尾无换行
4. 输出 left = 左行数组 join("\n") +（左尾有换行 ? "\n" : ""）；right 同理
5. 容忍：hunk 头不带 `,count`（`@@ -5 +5 @@`）；hunk 头尾部带 section heading
   （`@@ -1,7 +1,7 @@ function foo()`）；**只剥 hunk 头那一行**的行尾 `\r`，正文不动
6. **hunk 之间插一条两侧相同的分隔行**（如 `⋯（中间省略）`）：不然多 hunk 时左侧会
   让「L6 的下一行就是 L18」，看起来像连续文件 —— 那正是 R1 说的「看起来像真的」
```

**为什么不是"整文件"**：patch 只保证改动附近 4 行（F3）。这是**诚实**的取舍（见 Q1），不是实现简化 —— 我们拿不到"该次调用前的整份文件"（F5：write/edit 的原文都不持久化）。

### 3.4 打开 diff（`src/host/diff.ts`）

- scheme：`jerrypi-diff:`；URI 形如 `jerrypi-diff:/<toolCallId>/<left|right>/<basename>`，query 里放一个自增序号。**每一段都 `encodeURIComponent`**：`#` 会被 `Uri.parse` 当 fragment、`?` 当 query（这个坑本仓已经踩过并写在 `chatView.ts:230-232`；虚拟 scheme 没有 `Uri.file` 可用，只能自己编码）。
  - **为什么要序号**：VS Code 按 URI 缓存虚拟文档，同一个 id 反复打开时同 URI 可能命中旧内容；内容本身是不可变的，但"同 id 换了内容"（比如被淘汰后重新登记）必须换 URI。
- `provideTextDocumentContent(uri)` 只认 store 里的 id（**从 `uri.path` 与 `uri.query` 取** —— 所以桩的 `Uri.parse` 必须真的拆 scheme/path/query/fragment，见 §6 A3/B3）；找不到就返回空串（VS Code 关闭文档时还会问一次，那时返回空串是正常路径，不记 Output 噪声）。
- `vscode.diff(left, right, title, { preview: true })`；title = basename + 形态：
  - patch：`a.ts（edit 前后 · 仅改动附近）`（basename 用 `pathLabelOf`，同时兼容 `\` 与 `/`）
  - snapshot：`a.ts（write 前 → 后）`，新文件写 `a.ts（新建）`
- **白名单**：`openDiff` 与 `openFile` 同一条纪律（F13）——渲染层按 item 上的 `diff` 字段决定给不给链接，host 侧再 `store.has(toolCallId)` 复核；未登记就记一行 Output 并**不打开**。

### 3.5 协议与渲染增量（最小）

| 位置 | 增量 |
| --- | --- |
| `protocol.ts` 的 tool item | `diff?: "patch" \| "snapshot"`；`diffUnavailable?: "evicted" \| "too-large" \| "read-failed" \| "none"`（**不是一个布尔** —— 三种文案要三种原因，评审 S1）。`none` = store 里什么都没有（重启后的 write 走这档） |
| `serialize.ts` | 从 store 推出上面两个字段（**不把 patch 本体塞进协议**：它可以是几十 KB，协议是每帧都要过的）。**store 要经 `SerializeContext` 传进来**（现在那里只有 `{cwd}` —— 评审 S1 提醒的接线点）。⚠️ **只有工具已结束（`pending !== true`）才给 `diffUnavailable`** —— 运行中的卡片这时候 store 里当然还没有记录，不看 `pending` 就会在卡片刚出现时闪一句「本次会话不可用」（**第 3 轮之后我自己复查发现的，未经复核**） |
| `render.ts` | 加在 **`renderToolHeadLine`**（不是 `renderToolCard`！见 `render.ts:261-267` 的注释：那是唯一产出按钮内容的地方，就地更新路径也走它 —— 加错地方会「断言全绿、真机不出现」，S3 第一次人工验收就是这么被咬的）。`diff` 存在 → 标题行尾渲染 `<a class="tool-diff" data-open-diff="…" role="button" tabindex="0">查看 diff</a>`（**role/tabindex 不能少**，与路径链接同规格）；`diffUnavailable` → `<span class="tool-note">…</span>`，**四值四文案**：`none` → `本次会话不可用`、`evicted` → `较早的改动记录已清理`、`too-large` → `文件过大，未保留`、`read-failed` → `快照读取失败` |
| `main.ts` | 捕获阶段的委托里加一条：`data-open-diff` → `{type:"openDiff", toolCallId}`（与 `data-open-path` 同一条路径），**并且 `onTranscriptKeydown` 也加同一条**（Enter/Space；评审 S4：路径链接有、新链接不能没有） |
| `chatView.ts` | `case "openDiff":` → `controller.isDiffOpenable(id)` → `diff.open(id)`；拒绝要写 Output |

### 3.6 内存上限（Q4 的默认值）

- `write` 快照：**条数 20 / 总量 8 MiB**；`edit` 的 patch：**条数 100 / 总量 8 MiB**（两侧都要有字节上限 —— 一次大范围重写的 patch 约等于新旧两份内容，只卡条数等于没卡，评审 S7）。
- **条数上限只数「活记录」（patch + snapshot），墓碑另算**（评审第 2 轮 B1）：墓碑也占条目的话，淘汰出来的墓碑会让条数永远降不回去 —— 插第 101 条 → 淘汰 → 又是 101 条 → 无限回退，**这是写不出来的实现**。墓碑单独一个上限（500 条，纯标量），**超了就丢最旧的墓碑**；丢墓碑是安全的：write 侧落回 `diffUnavailable:"none"`（文案仍出得来），edit 侧反而**正好是重放把 patch 重新登记回来**的通道（见 §3.2 第 2 条）。
- 淘汰口径是 **FIFO**（按插入序，不是 LRU；第一版把它叫 LRU 是错的，评审 N3）：diff 的用途就在改动后几分钟内，按时间淘汰够用，实现简单到能一眼看懂。**淘汰时把该 id 记成 `unavailable{why:"evicted"}`（write 与 edit 一样），不要直接抹掉**，否则卡片会静默失去说明。
- 读盘/登记前先看大小：单条 > 2 MiB 直接记 `unavailable{why:"too-large"}`（**不读/不存**）——不然一次大 write 就让扩展宿主多背一份内存。
- **超上限之后会发生什么，写在明面上**（第 3 轮之后补的，**未经复核**）：一个会话里 edit 超过 100 次（或 write 超过 20 次）时，**最早那批卡片会显示「较早的改动记录已清理」**——它们不是坏链，是内存上限的直接结果。C3 承诺的"重启后仍可打开"是在**上限之内**说的；这条写进 README 的已知限制。
- 重放登记按**从新到旧**（第 3 轮之后补的，**未经复核**）：cap 先满时留下的是最新的 N 条，且同一次重放里不会互相淘汰（正序登记会在一次重放内制造无谓的来回复活）。

## 4. 决策与默认值（Q1–Q7，等用户拍板）

| # | 问题 | 默认（我的建议） | 备选 / 为什么不选 |
| --- | --- | --- | --- |
| Q1 | 重启后 edit 的 diff 只显示**改动附近 4 行**（补丁视图），不是整文件；多个 hunk 之间插一条两侧相同的「⋯（中间省略）」分隔行 | **接受**（F3/F5：我们拿不到该次调用前的整份文件；分隔行是为了不让人误以为两段是连着的 —— 评审 S3） | 不显示 → 违背 PLAN 验收；给 edit 也做同名包装拿整文件 → 见 §2 不做清单 |
| Q2 | write 的 diff 重启后消失（只活在进程内） | **接受**，卡片显示"本次会话不可用"（PLAN 原文口径） | 存进 VS Code `globalStorage` → 持久化用户文件内容，另立数据生命周期（要用户单独拍板才做） |
| Q3 | 入口与文案：标题行尾的「查看 diff」；不可用时**四值四文案**（`none`→本次会话不可用 / `evicted`→较早的改动记录已清理 / `too-large`→文件过大，未保留 / `read-failed`→快照读取失败） | **接受** | 放正文里 → 折叠时点不到；一律写「不可用」分不出原因 |
| Q4 | 上限口径：write 快照 20 条 / 8 MiB；patch 100 条 / 8 MiB（**两侧都有字节上限**）；单条 > 2 MiB 不读不存；淘汰按 FIFO 并留 `unavailable{why:"evicted"}` 墓碑（**条数只数活记录，墓碑另封顶 500 且可丢**） | **接受** | 只卡条数 → 大 patch 会把内存吃光（S7）；把墓碑也算进条数 → 实现回退不下去（第 2 轮 B1）；真 LRU → 收益不值这份复杂度（N3） |
| Q5 | 只对 `edit` / `write` 提供 diff（`bash` 写文件不管） | **接受** | 见 §2 不做清单 |
| Q6 | v1 不做 `firstChangedLine` 跳转 | **接受** | 要额外一次 `revealRange`，收益小 |
| Q7 | 打开方式：当前列、`preview: true`（再点别的 diff 会复用同一组标签） | **接受** | 固定新列 → 会堆一堆编辑器 |

## 5. 风险

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | patch 解析写错（尤其“无尾换行”与多 hunk） | 打开的是错的左右文本 —— **看起来像真的**，最难发现 | 纯函数 + 夹具（§0.1 的实跑输出）+ **独立实现当 oracle**（`diff@8.0.4` 的 `parsePatch`/`applyPatch`）+ **漂移守卫**（拿 pi 的 `generateUnifiedPatch` 现场生成了再解析；见 A8） |
| R2 | 读盘失败/文件巨大把 write 拖慢或撑爆内存 | 工具调用变慢、宿主内存增长 | `stat` 门槛 + 上限 + try/catch（§3.6） |
| R3 | 虚拟文档 URI 缓存串味（同一个 id 重复打开拿到旧内容） | 看到过期 diff | URI 里带自增序号（§3.4）；内容不可变，不需要 `onDidChange` |
| R4 | 卡片上的链接**看着可点、点了没反应** | S6 的 M5 已经出过一次同类事故（`data-open-path` 死链） | 两层同判（§3.5）+ webview-dom 断言点击真的 post 了消息 |
| R5 | write 包装在未来某次 pi 升级后不再是"同名覆盖" | 快照静默失效（卡片显示"不可用"而不是报错） | T6 继续钉住 `sourceInfo.source === "sdk"`（S1 已建）；升级时先跑 `check:gate` |
| R6 | A8 的 oracle（`diff`）是**我们自己声明之外的传递依赖**：pi 哪天换掉或重排 node_modules，A8 会变成 import 失败 —— 而 import 失败不算红（AGENTS.md §2） | 漂移守卫静默失效 | `diff: "8.0.4"` 进 `devDependencies`（不进 VSIX）+ A8 里断言 `require("diff/package.json").version === "8.0.4"`，不符**显式失败**（评审第 2 轮 S5） |

## 6. 检查清单（自动断言，先红后绿）

**每条都要先看它红**（改坏被测实现 → 断言必须失败），**且不许对着想象中的实现写**（夹具用真的 pi / 真的 `diff@8.0.4` 输出）。

**放哪一条不是随手定的**：不需要凭据的（A1–A6、A8、A10）一律进**无凭据也能跑**的脚本；只有真模型那两条（A7/A9）才放 `controller-check`/`selftest`（评审 S6：`controller-check` 没凭据时整体 SKIP，而 SKIP 不是 PASS）。

| # | 断言 | 放哪 | 能红验证 |
| --- | --- | --- | --- |
| A1 | `sidesOfPatch` 对 §0.1 的 5 组夹具逐字符正确（单行文件整行替换 / 多 hunk 插分隔行 / 纯新增左空 / 纯删除右空 / 无尾换行），外加：只一侧无尾换行、`@@ -5 +5 @@` 不带 count、section heading、正文里的 `\r` 原样保留、`pathLabelOf` 的 `+++`/Windows/时间戳三种形态 | host-check | **实测过的三种破法**：① 把 hunk 头正则改成 `,\count` 必需 + `$` 锚定 → "不带 count"/"section heading" 两条红；② 删掉 `\ No newline` 分支 → 两条"无尾换行"红；③ 摊平时不插分隔行 → "多 hunk"红。**注**：最初写的"改成贪婪匹配 → 多 hunk 红"是**错的**（`/^@@/` 对这批夹具等价，14 条断言一条都不红）—— 这正是"能红验证"要实测的理由 |
| A2 | **store 的两条（对着两种真实形态，不是人造夹具 —— 评审第 2 轮 S6）**：① **条数上限只数活记录**：连插 N+50 条 → 活记录数 === N，且最早那 50 个 id 取回的是 `unavailable{evicted}`；② **patch 可覆盖墓碑**（重放的真实形态：会话里有 >100 次 edit，重放时最早那批已被淘汰）→ 同一 id 先被淘汰成墓碑，再 `record(patch)` → 取回的是 patch、不是墓碑。另：字节超限时最旧的也变墓碑；超大输入**没有**把内容存进来 | host-check | 把墓碑也算进条数 → ① 红（活记录数会小于 N，甚至死循环）；对 patch 也用"不覆盖" → ② 红 |
| A3 | `openDiff`：已登记 → `vscode.diff` 恰好调用一次、两个 URI 都是 `jerrypi-diff:`、左右内容与 `sidesOfPatch` 一致；未登记 → **不调用** + Output 有一行拒绝；标题的文件名从 **Windows 形态的 patch 头**（`--- C:\a\b.ts`）也取得到 `b.ts`；**含 `#`/`?`/空格的路径**：① 构造出的 URI 文本里出现 `%23`/`%3F`/`%20`，② **桩真解析出来的 `uri.fragment`/`uri.query` 里不含路径片段**（`#` 只在 query 里当分隔符用） | host-check（桩要补 `Uri.from` + **把 `Uri.parse` 升级成真拆 scheme/path/query/fragment** + `registerTextDocumentContentProvider` + `diff`） | 去掉白名单 → 未登记那条红；去掉编码 → ② 里 `uri.fragment` 出现路径尾巴 → 红；basename 只用 `/` 切 → Windows 那条红 |
| A4 | **重放口径（两条；第 2 条才是能红的那条）**：① 空 store 重放一组 messages（含一条 edit 的 `details.patch` 与一条 write）→ edit 登记成功、write 的 item 是 `diffUnavailable === "none"`（枚举，不是 `true`）；② **先 `recordWrite` 再重放同一批 messages** → snapshot 仍在、item 是 `diff:"snapshot"`、**没有被写成 unavailable** | host-check | 删掉重放那条调用 → ① 红；把「重放时给没有 details 的 write 补记一条 unavailable」加进去 → ② 红（① 照样绿 —— 那正是原 A4 的盲区） |
| A5 | 渲染/交互：`diff:"patch"` → 渲染出 `data-open-diff`（**且出现在 `renderToolHeadLine` 的产物里** —— 就地更新路径也走它）；`diffUnavailable` 的**四种 why 各渲染出各自的文案**（`none`→本次会话不可用 / `evicted`→较早的改动记录已清理 / `too-large`→文件过大，未保留 / `read-failed`→快照读取失败）且**没有**链接；**`pending: true` 的卡片既无链接也无文案**（否则一开始跑就闪「不可用」）；`toolCallId` 里的 `<`/`"` 被转义；**点击**只 post 一条 `{type:"openDiff"}` 且不展开卡片；**Enter/Space** 也能 post | render-xss-check + webview-dom-check | 渲染条件改成「永远渲染链接」→ 第一条红；把链接加在 `renderToolCard` 里 → 就地更新那条红；四种 why 塌成一种文案 → 文案那条红；去掉 keydown 分支 → Enter 那条红；**去掉 `pending` 判断 → 「运行中无文案」那条红** |
| A6 | 真写工具（真 pi、**不用模型**）：在 `os.tmpdir()` 下的**一次性目录**里对同一文件顺序两次 `execute("id-1"…)` → 记录为 `(before=null,after=X)`、`(before=X,after=Y)`；`finally` 清理，**清理前断言目标路径在该临时目录之下**（AGENTS.md §4） | host-check（它已经加载真 pi，见 F18；`host-check.mjs:160-168` 的导出清单要加 `createCustomTools`/`filechanges`，否则这一步会以"模块不存在"收场 —— 而那不算红） | 把 `before` 改成「写完之后再读」→ 两条都红（第一条从 `null` 变成 `X`，评审 N4） |
| A7 | 真模型（**PLAN 验收的自动版**）：一条消息里两次 edit + 两次 write 同一文件 → 两张 edit 卡片的 patch **互不包含**对方 marker；两张 write 卡片 `卡2.before === 卡1.after` | controller-check | 把 patch 改成"从当前磁盘重建" → edit 那条红 |
| A8 | **漂移守卫（两半，开头先断言 `diff` 版本 === 8.0.4，不符显式失败）**：① 用 pi 的 `generateUnifiedPatch` 现场生成 patch（§0.1 的 5 组输入 + 一组 >2 hunk 的长文件）→ **`sidesOfPatch().hunks`** 与 `diff` 的 `parsePatch` 逐 hunk 行**逐行一致**（独立实现当 oracle；不是「和输入内容一致」—— 后者对多 hunk 恒假，评审 B2/S2）；② **直接用原封不动的整份 patch**：`applyPatch(left, patch) === right`（jsdiff 自带偏移搜索，不需要重写 hunk 头；实测两侧插了分隔行也照样对，评审 S3） | host-check（F18：那里有真 pi） | **① 守行内容**：把 `-` 行也灌进左/右 → ① 红。**② 守尾换行与行序**：把 `\ No newline` 当成正文行（解析器多补了一个尾换行）、漏掉最后一个 hunk、行序颠倒 → ② 红（评审 N1：`\ No newline` 那条红法是 ② 的，不是 ① 的 —— `parsePatch` 把它原样留在 `lines` 里） |
| A9 | `Pi: Run Self-Test` 的 T6 扩展：写包装的记录里 `before/after` 正确（现有断言只查 toolCallId） | selftest（T6，真模型但**复用已有那一轮**） | 记录里塞一个假 before → 红 |
| A10 | **失败的 edit**（`isError: true, details: {}`，本机实测 3 条）：`recordEditsFromMessages` **不登记**；item 上 `diff` 与 `diffUnavailable` **都缺席**（不是「不可用」，是「这次没改成文件」） | host-check | 把判断写成 `if (details)` → 红 |

> A5 的两条检查分别落在 render（字符串层）与 webview-dom（真 DOM 事件层）—— S6 的 M5 死链就是后者能抓、前者抓不到的形态。

## 7. 人工验收（Mac，**2 个动作**，一次 F5 会话里做完）

**M1（活的 diff）**：在面板里粘一句现成话术（我来提供），然后**点四张卡片的「查看 diff」**。话术必须让**第二次 edit 的 oldText 只有在第一次生效后才存在**（如「先把 A 改成 B，改完再把 B 改成 C」）—— pi 的 edit 指南里明写「同一文件的多处改动用一次调用的多个 entries」，直说「分两次改」是在跟系统提示对着干（评审 S5）。话术里同时含：同一文件两次 write、一个新文件 write。检查点：

- 两次 edit 的 diff **各只含自己那次改动**（第一次看不到第二次的 marker）；
- 两次 write 的 diff 是**整文件前后**，且第二次的"前"等于第一次的"后"；
- 新建文件的 diff 左侧是空的、标题写「新建」；
- 改动相距较远时，diff 里能看到 hunk 之间的「⋯（中间省略）」分隔行（评审 S3）。

**M2（重启后的口径）**：`Developer: Reload Window` → 同一个会话 → 同一批卡片：**edit 的 diff 还能打开**（补丁视图）、**write 的卡片显示「本次会话不可用」**（不是死链）。

> 为什么必须人工：① 真焦点/真点击（虚拟文档、diff 编辑器是 VS Code 自绘）；② 真进程（重启后的重放路径）；③ 排版（标题行放不下时会不会挤）。三类都在 AGENTS.md §1 的人工清单里。

## 8. Windows 项（不新增）

- **W0**：`Pi: Run Self-Test`（T6 已含 A9 的新断言）—— 期望仍是 `GATE PASS`。
- **W1**：重启后会话正常（不变）。
- diff **不为它单独加 Windows 动作**，理由不是「没有平台特有风险」（第一版这么写，被评审 S8 指出：Windows 的 `C:\a\b.ts` 会走到 basename 与 URI 编码那两条路径），而是「**这两条已经用 host-check 的断言覆盖了**」（A3 的 Windows 形态标题 + 编码那条）。若 W0 里 T6 红，再单独查。

## 9. 步骤（每步单独提交 + 门禁全绿）

| 步 | 内容 | 结束时的门禁 |
| --- | --- | --- |
| 1 | `src/shared/patch.ts` + A1（先红） | typecheck / self-test |
| 2 | `src/pi/filechanges.ts`（store + `recordEditsFromMessages`）+ A2/A4/A10 | self-test（host-check） |
| 3 | 写包装改名 `WriteProbe → WriteRecorder` 并带 before/after（**改名让编译器抓误用**）+ A6（host-check，含临时目录与清理守卫）+ A9（T6） | self-test（含 host-check）+ `check:gate`（T6 要真模型） |
| 4 | `src/host/diff.ts` + 桩补三件套 + A3 | self-test（host-check） |
| 5 | 协议/渲染/点击链路 + A5 | self-test（render + webview-dom） |
| 6 | controller 接线（三条入口）+ 文档（README 中英、`pi-traps`）+ A7（真模型）/A8（host-check 的漂移守卫） | 全部 + `check:gate` |
| 7 | 版本 0.1.9 + 打包 + Mac M1/M2 + 上传核验 + Windows W0/W1 + §12 回填 → 关阶段 | 发布流程（§4） |

## 10. 评审记录

**评审者**：Claude（herdr 面板 `w60:pC` 里已开着的会话，与本计划同一工作目录）。
**纪律**（承 S4–S6）：**≤3 轮**；第 3 轮只核转写、不审设计；每轮结论**立刻落盘**；每条记 `ACCEPT` / `REJECT`（附实质理由）/ `DEFER`。评审者只读。

### 第 1 轮（2026-09-14，Claude，本仓 `w60:pC` 面板；结论 `VERDICT: BLOCKING`，B3 / S8 / N5）

**处置：13 条 ACCEPT、1 条 REJECT（B1 的机制部分，但它指出的覆盖缺口照单全收）、其余按 ACCEPT 落地。**

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | 重放会把实时 write 快照改写成 `unavailable`（replay 一生中会发生很多次：容器迁移、`switchSession`、`requestState`），于是 C2/M1 会静默退化 | **REJECT（机制）／ACCEPT（加固）** | 机制不成立：`recordEditsFromMessages` 只处理带 patch 的 toolResult（F5：write 没有 details 可登记），write 的可用性是**序列化时从 store 派生**的 —— 能写 `unavailable` 的只有 write 快照的淘汰/读失败路径，重放碰不到它。**但它指出的覆盖缺口是真的**：原 A4 只断言"空 store 重放 → write 不可用"，这条**从写下的第一天起就是绿的**（判据的主语被换掉了）。⇒ §3.2 把两条语义写死（重放只登记 edit；登记是 upsert-if-absent），A4 拆成两条，**第 ② 条（先有快照、再重放）才是能红的那条** |
| **B2** | A8 写成了恒假（patch 只含 4 行上下文，>9 行的输入不可能"与输入内容一致"），且"能红验证"验的是断言过拟合（正确的解析器不该对 context 行数有假设） | **ACCEPT** | A8 换成两半：① oracle 改成 **`diff@8.0.4` 的 `parsePatch`**（独立实现，逐 hunk 比旧/新行）；② 逐 hunk `applyPatch` 往返。能红列改成"漏最后一个 hunk / 把 `-` 行灌进右侧" |
| **B3** | 失败的 edit 带 `details = {}`（真值空对象），`if (details)` 会给失败卡片挂一个点开是空的死链 | **ACCEPT（已复核）** | 自己跑了本机会话：**72 条正常 edit** 全是 `['diff','patch','firstChangedLine']`，**3 条失败的**全是 `{}`（`Found 2 occurrences…` / `No changes made…` / `Could not find edits[1]…`）。⇒ §3.1 定死"`details.patch` 必须是非空 string 才登记"，失败的 edit 既不登记也不给 `unavailable`；新增 **A10** 钉住 |
| **S1** | §0 两条引用不属实：F15 的 `controller.ts:129` 是 `SessionView.isStreaming`（`private view()` 在 `:1086`）；`package.json` 没有 `dependencies` 键（pi 在 `devDependencies`，且 `--no-dependencies`） | **ACCEPT（已复核）** | 两条都自己核了，改成 `:1086` / `:345` / `:780` 与"devDependencies + `--no-dependencies`"（结论反而更强：diff 本来也进不了 VSIX） |
| **S2** | §3.3 第 5 条的"容忍 `\r\n`（先归一化）"会把文件内容里的 `\r` 吃掉 | **ACCEPT（已复核）** | 复跑：`generateUnifiedPatch("a.ts","a\r\nb\r\n","a\r\nB\r\n")` 的正文里确实有 `-b\r`。⇒ 删掉"归一化"，只剥 hunk 头那一行的行尾 `\r` |
| **S3** | 多 hunk 直接 join 会让两段看起来连着（正是"看起来像真的"） | **ACCEPT** | §3.3 加第 6 条：hunk 之间插一条两侧相同的「⋯（中间省略）」；M1 的检查点也加上它 |
| **S4** | 「查看 diff」缺 `role/tabindex` 与键盘分支；且必须加在 `renderToolHeadLine`（加错地方会"断言全绿、真机不出现"） | **ACCEPT（已复核）** | 核了 `render.ts:261-267` 的注释与 `main.ts:557-565`（键盘只认 `data-open-path`）。⇒ §3.5 点名 `renderToolHeadLine`、补 role/tabindex、补 keydown 分支；A5 增加"就地更新路径也有"与"Enter/Space 也能 post" |
| **S5** | A7/M1 让模型"同一文件两次 edit"是在跟 pi 的系统提示对着干（`editToolSystemPromptContribution.guidelines[1]` 明写要用一次调用的多个 entries） | **ACCEPT** | 话术改成**制造顺序依赖**（"先把 A 改成 B，改完再把 B 改成 C"）；A7 照 `controller-check.mjs:418` 的先例加**可区分 SKIP**（"模型没照做" ≠ 断言挂） |
| **S6** | A8 放 `controller-check` = 没凭据就 SKIP，而它是纯函数；host-check 里其实有真 pi | **ACCEPT（已复核）** | 核了 `host-check.mjs:166/881/955`：它真的 `await loadPi(REPO_ROOT)`。⇒ 新增 F18 记录这件事，A8/A6 都放 host-check，§6 开头写明"放哪一条不是随手定的" |
| **S7** | patch 侧只有条数上限、没有字节上限（write 侧反而有 8 MiB） | **ACCEPT** | §3.6 两侧都上限（patch 100 条 / 8 MiB，单条 > 2 MiB 不存）；Q4 与 A2 同步 |
| **S8** | URI 没写编码（`#`/`?`/空格）；`patchPathLabel` 若用 `/` 切 basename 在 Windows 上取错；§8 的"没有平台特有风险"因此不成立 | **ACCEPT（已复核）** | 核了 `esbuild.mjs:10`（webview 产物不得引用 node 内置）与 `chatView.ts:230-232`（`Uri.parse` 的坑已经踩过）。⇒ §3.4 写死"每段 `encodeURIComponent`"、`pathLabelOf` 同时切 `/` 与 `\`；A3 加 Windows 形态标题与编码两条；§8 的理由改成"已用断言覆盖" |
| **N1** | "无尾换行标记两侧各出现一次"过强（0/1/2 次都合法） | **ACCEPT（已复核）** | 复跑三组：`"a\nb"→"a\nb\n"` 1 次、`""→"a"` 1 次。改成"0/1/2 次都合法，作用于紧邻的上一行" |
| **N2** | 漏两种合法形态：hunk 头的 section heading；`split("\n")` 的尾部空元素 | **ACCEPT** | §0.1 判据 ④⑤、§3.3 第 5 条都补上（"靠落不进分类兜着是巧合不是规则"） |
| **N3** | 按插入序淘汰是 FIFO 不是 LRU；patch 侧淘汰要不要也留 `unavailable`？ | **ACCEPT** | 正名为 FIFO 并写明"为什么不真做 LRU"；淘汰时两类记录都留 `unavailable{why:"evicted"}` |
| **N4** | A6 的"能红"写得不准（第一条也会红） | **ACCEPT** | 改成"两条都红（第一条从 `null` 变成 `X`）" |
| **N5** | F6 的"原样返回"不准（`content == null` 会重建） | **ACCEPT** | 按它给的行号改写（`details` 照样在，但"原样"不准确） |

**STRONGEST_OBJECTION（它写的是 §3.2 把实时与重放压成同一个函数是"信息少的那条去覆盖信息多的那条"）**：
机制部分同 B1 的驳回（重放不写 write 记录）；但它指出的**为什么这个 bug 值得防**——"覆盖的时机（容器迁移、`switchSession`）全不在 §7 的两个动作里，所以人工验收会全绿，用户第一次把面板拖到另一侧时静默退化"——**照单全收**：A4 的第 ② 条就是为它写的，M2 重载之外**不加人工动作**，改成让断言覆盖容器迁移/切会话这两条路径（这正是 AGENTS.md §2 那条"能搬到自动的就别留人工"）。

**本轮没有新增教训条目**（L1 的"实验先红"与"判据主语被换掉"两条已经在 S6 记进 AGENTS.md §2，本轮 B1/B2 正是那两条纪律的又一次命中）。

### 第 2 轮（2026-09-14，同一评审者，复核第 1 轮的修订；结论 `VERDICT: BLOCKING`，B3 / S6 / N5）

**处置：14 条全部 ACCEPT。**它先**确认了 B1 的 REJECT 站得住**（"按修订后的语义，我给不出反例"），然后用两节之间的相互矛盾打出两条新洞 —— 两条都在 **edit 侧**，而且都是静默的。

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | 「FIFO 淘汰留墓碑」+「条数上限」= **写不出来的实现**：墓碑仍占条目 → 插第 101 条就淘汰出墓碑 → 还是 101 条 → 无限回退；字节上限会掉、条数上限不会，而 A2 只查"最旧的变 unavailable"、不查条数，所以这个死锁在 A2 下是绿的 | **ACCEPT** | 自核 §3.6：确实如此（`unavailable` 在 §3.1 里是一条完整记录，不是空位）。⇒ 条数上限**只数活记录**（patch + snapshot），墓碑另设上限（500 条、可丢最旧）：write 侧丢墓碑只是落回 `diffUnavailable:"none"`（文案照样出得来），edit 侧丢墓碑**正好是重放把 patch 登记回来的通道**（与 B2 的修法合成一条路）。A2 改成 ①：连插 N+50 条后活记录数 === N |
| **B2** | `upsert-if-absent` 把墓碑锁死：patch 明明能从 `details.patch` 免费再生，却因 `store.has(id)` 永远跳过 → 超过 100 次 edit 的会话里，最早那批卡片重启后集体变「本次会话不可用」，而 C3 承诺的是"仍可打开"；并且 **§3.4 自己写的"被淘汰后重新登记"与 §3.2.2 直接矛盾** | **ACCEPT** | §3.2 第 2 条改成**按 kind 分开写**：patch **可覆盖**（含覆盖墓碑，值由 `details.patch` 唯一确定 → 覆盖即幂等）；snapshot **不需要"不覆盖"这条规则** —— 它只有 `ops.writeFile` 一条入口，重放从不写它。A2 ② 用**重放的真实形态**（会话里 >100 次 edit，重放时最早那批已被淘汰）钉住"patch 能把墓碑救回来" |
| **B3** | A3 的"编码后不会被解析成 fragment/query"在**恒等桩**下恒绿（`Uri.parse` 只存 `.value`，根本不拆 `#`/`?`）；而且 §3.4 的 provider 要从 `uri.path/query` 取 id，在这个桩下也跑不起来 | **ACCEPT** | 采用它给的 (a) 方案（与 S6 的教训一致：桩不够忠实，断言就是自欺）：桩的 `Uri.parse` **升级成真拆 scheme/path/query/fragment**（+ `Uri.from`），A3 改成"① URI 文本里有 `%23`/`%3F`/`%20` ② **桩真解析出的** `fragment`/`query` 里不含路径片段" |
| **S1** | 协议字段 `diffUnavailable?: true` 装不下 Q3 的三种文案（同一次修订里 §3.5 的表内自相矛盾）；也没写 store 怎么传进 `serialize.ts` | **ACCEPT** | 协议改成四值枚举 `"evicted" \| "too-large" \| "read-failed" \| "none"`；§3.5 写明"store 经 `SerializeContext` 传进来（现在只有 `{cwd}`）"；A5 加"四种 why 各渲染各自的文案" |
| **S2** | A8① 要"逐 hunk 比"，但 `sidesOfPatch` 声明的是**扁平两侧**（还带分隔行）—— 那测试只能拿我们自己插的分隔行把 left 切回去，等于把 oracle 和实现耦在一起 | **ACCEPT** | `sidesOfPatch` 多返回 `hunks: {left, right}[]`（渲染不用它，断言与 oracle 用）；A8① 直接比 hunks，§2 的签名同步 |
| **S3** | A8② 的"把 hunk 头重写成 1 基"是多余的：实测 `applyPatch(left, 原封不动的整份 patch) === right`（jsdiff 自带偏移搜索），而重写头那一步自己就可能写错、还会掩盖"少数了一行" | **ACCEPT** | A8② 改成直接用整份 patch 往返；顺带它替我们确认了"分隔行不会打断 applyPatch"（S3 的担心不成立） |
| **S4** | A6 搬进 host-check 后是**第一次真执行 pi 工具、真写盘**（`grep` 过：host-check 里 0 处 `execute(`/`createWriteToolDefinition`），但计划没写临时目录与清理守卫 | **ACCEPT** | A6 那行补"`os.tmpdir()` 下的一次性目录 + `finally` 清理 + **清理前断言路径在该目录之下**"（AGENTS.md §4），并点名 `host-check.mjs:160-168` 的导出清单要加 `createCustomTools`/`filechanges`（否则那一步会以"模块不存在"收场 —— 而那不算红，AGENTS.md §2） |
| **S5** | A8 的 oracle 用的是**未声明的传递依赖** `diff`：pi 换掉它就成了 import 失败，大概率表现为脚本静默崩溃 | **ACCEPT** | `diff: "8.0.4"` 进 `devDependencies`（`--no-dependencies` 保证不进 VSIX，F17 的结论不受影响）+ A8 开头断言版本、不符**显式失败**；新增 **R6** |
| **S6** | A2 的"upsert-if-absent 不覆盖"只有**人造夹具**能观察（生产里一个 toolCallId 只有一份 patch），而且它钉死的正是 B2 的 bug —— 以后想修 B2 会先被 A2 拦住 | **ACCEPT** | 已被 B2 的处置取代：A2 拆成两条，**两条都对着真实形态**（①条数只数活记录 ②重放时 patch 覆盖墓碑） |
| **N1** | A8 的能红列把"`\ No newline` 当正文行 → ① 红"挂错了：`parsePatch` 把它原样留在 `lines` 里，真正守尾换行的是 ② | **ACCEPT** | A8 的两半写明分工：**① 守行内容、② 守尾换行与行序** |
| **N2** | `pathLabelOf` 没说从 `---` 还是 `+++` 取，也没说容忍 GNU diff 的时间戳尾巴 | **ACCEPT** | §2 第 1 条写明：从 `+++` 取（缺则退回 `---`）、容忍 `\t<时间戳>` |
| **N3** | §9 步骤 3 的门禁还写着 `check:controller`，但 A6 已搬走、A7 在步骤 6 —— 步骤 3 现在没有 controller-check 断言 | **ACCEPT** | 步骤 3 的门禁改成 `self-test`（含 host-check 的 A6）+ `check:gate`（T6/A9 要真模型） |
| **N4** | §3.2 表格第 3 行还写着"同一个函数，所以实时与重放不可能各写一套"，而它只对 edit 成立 | **ACCEPT** | 改成"**edit 的**实时与重放共用这一个函数；write 只有实时那一条入口" |
| **N5** | F5 的证据还写着"6 条 edit 记录全部有 details"，与 F5b 的"72 正常 + 3 失败"两个数字 | **ACCEPT** | F5 改成 72 条，并注明"第一版只写了最初看到的 6 条" |

**STRONGEST_OBJECTION（"堵法本身被无差别套在两种记录上：write 侧是保护、edit 侧是牢笼"）**：**照单全收**——B2 的修法（patch 可覆盖、snapshot 只有一条入口）就是按这个判断写的。它附的那句方法论更要记牢：**C3 的主语是"这个会话里所有 edit 卡片"，而 A4① 只喂一条 edit、A2 只数一次淘汰 —— 两条都不会跨过 100 这个门槛**。所以 A2 ② 特意用">100 次 edit 之后重放"的真实形态，而不是再造一个人造夹具。

**本轮教训（准备写进 AGENTS.md §2 的候选，等第 3 轮核完再落）**：**自相矛盾要跨节读**。B2 的两条（§3.4 的"被淘汰后重新登记" vs §3.2.2 的"不覆盖"）单独看都对 —— 是评审把两节放在一起才暴露的；这与"判据的主语被悄悄换掉"是同一类错误的两个方向（前者是节与节，后者是判据与断言）。



### 第 3 轮（2026-09-14，同一评审者，**只做转写核对**；结论 `TRANSCRIPTION: 14/14 落实，但有 4 处转写错误`）

**处置：4 条全部 ACCEPT 并已修**。这一轮按纪律不审设计，只核"我声称改掉的，是不是真改成那样了"——结果抓到 4 处**我自己改文档时引入**的错误（两个是硬矛盾、一个是结构错位、一个是表格被我改坏）：

| # | 转写错误 | 处置 |
| --- | --- | --- |
| T1 | A4① 还写着 `diffUnavailable === true`，而协议本轮已改成四值枚举 → 枚举字符串永远 `!== true`，**这条断言写下去就是恒红的**（而红的不是实现） | ✅ 改成 `=== "none"` |
| T2 | §3.5 的 render 行与 Q3 把 `none`/`evicted` 合成一句文案，而 A5 要求"四种 why 各渲染各自的文案" → A5 那条**永远绿不了** | ✅ 定死**四值四文案**（`none`→本次会话不可用 / `evicted`→较早的改动记录已清理 / `too-large`→文件过大，未保留 / `read-failed`→快照读取失败），§3.5/Q3/A5 三处同步 |
| T3 | §10 结构错位：第 1 轮的 STRONGEST_OBJECTION 落进了第 2 轮小节，导致第 1 轮丢了它、第 2 轮同时写着"本轮有教训候选"与"本轮没有新增教训条目" | ✅ 整块挪回 §10.1 |
| T4 | 三行表格（F5b/F15/F17）行首各多一个 `'`（F6 单元格里也有一处），渲染不成表格行 | ✅ 删掉（`grep -n "^'"` 现在 0 命中） |

> **这 4 条修完没有再复核**（纪律：三轮之后的改动一律标"未经复核"）。它们全是转写级（枚举值、文案对齐、块的归属、一个多余的引号），不涉及设计判断。

## 11. 实施期发现

| # | 发现 | 处置 |
| --- | --- | --- |
| 1-1 | **计划里 A1 的"能红验证"是错的**：写着"把 hunk 头正则改成贪婪匹配 → 多 hunk 红"，实测 `/^@@/` 对那批夹具**等价**，14 条断言一条都不红 | 换成三种实测过的破法（`,count` 必需 + `$` 锚定 → 两条红；删 `\ No newline` 分支 → 两条红；不插分隔行 → 一条红），并把计划那一列改写成实测结果 |
| 2-1 | A2① 的夹具与语义打架：测试里设了 `maxTombstones: 5`，而"淘汰 7 条"会让最早的墓碑按设计被丢掉 → "最早的记录变成墓碑"那条永远红 | 拆成 **A2①**（活记录上限，墓碑上限放宽）与 **A2①b**（墓碑上限单独测：最旧的被丢掉、最新的还在） |
| 3-1 | ⚠️ **改名没能强迫编译器抓误用**：`writeProbe → writeRecorder` 之后 typecheck 照样过 —— 因为 selftest 里那个选项是放在 `const hostOptions = {...}` 里、再靠 `{...hostOptions}` 展开传进去的，**spread 会绕过 excess property check** | 手工把 selftest 一并改掉（否则 T6 会以 `E_TOOL_OVERRIDE` 收场）。**教训**：AGENTS.md §5 的"改名强迫编译器抓误用"在对象 spread 面前失效，改名前先 `grep` 一遍所有出现处 |
| 4-1 | 桩的 `Uri.toString` 少写了真 vscode-uri 的一条规则（`scheme === "file"` 要写 `//`）→ S6 时代的"白名单里的路径用 Uri.file 打开"断言**当场变红** | 补上规则（`file` 或有 authority → `//`）。这是桩忠实度的又一次体现：升级桩会把旧断言的真实含义暴露出来 |
| 6-1 | A7 的第一版断言写错了：我写成"p1 不含 `STAGE-3`"，但**每个 patch 本来就会同时含自己那次的旧文本与新文本**（`-旧`/`+新`） | 判据改成"不含**对方**的文本"（p1 不含 `STAGE-4`、p2 不含 `STAGE-2`），这才是"只显示该次"的真正含义 |
| 6-2 | 协议从 4 升到 5；`host-check` 里那条断言写死了 `protocol === 4` → 一升版就红 | 断言改成读 `PROTOCOL_VERSION` 常量（不再写数字） |
| M1-1 | 用户看第一张 diff 时问"这样对吗"：新建文件的左侧出现**红色条**（空文档的那 1 个空行被替换） | 核过是 VS Code 对"空 → 有内容"的标准画法，非 bug；已解释 |
| M1-2 | 用户指出第三张 diff 里**还能看到 `tail`** | 核过是**上下文行**（pi 的 patch 固定 4 行上下文，F3；这个文件只有 2 行所以整份都进来）。`tail` 两侧都无增删底色 = 没动过；判据要的是"不含**别次**调用的改动"，满足。**决定不改**（去掉上下文就看不出改动在文件哪儿，也与 patch 语义不一致）—— 用户 2026-09-14 未反对 |
| M1-3 | 用户问 `Took 0.0s` 是不是坏了 | 核过是真实值（write/edit 毫秒级），且 pi 自己的格式就是 `(ms/1000).toFixed(1)`（`dist/core/tools/renderers/bash.js:23`）→ 与 pi 一致，不改 |
| M1-4 | 用户问"第二张应该是上下？"：窄列里 VS Code 把 diff 渲染成 inline（上下）而不是左右 | 核过是 VS Code 自己的启发式（`diffEditor.useInlineViewWhenSpaceIsLimited`），`vscode.diff` 的 options 里没有 `renderSideBySide`（只有 viewColumn/preview/selection/preserveFocus），我们控制不了。README 的"改动历史"条目补一句说明 |

## 12. 实施与验收结果

### 12.1 自动检查（**全绿**，2026-09-14）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ |
| `npm run self-test` | **9/9**（protocol 112 / render **121** / tool-text 91 / settings 16/16 / webview-dom **81** / host-check **173/173**） |
| `npm run check:controller`（真模型，不进 CI） | **104/104**（含 A7：同一条消息两次 write + 两次 edit） |
| `npm run check:gate`（无头跑 `Pi: Run Self-Test`，不进 CI） | **15/15 GATE PASS**（T6 现在会核对 `before=null/newFile`） |
| `npm run package` + `check-vsix` | **0.1.9：338 文件 / 5.76 MB**（与 0.1.8 的文件数相同） |

### 12.2 提交切分（实际）

| 提交 | 内容 |
| --- | --- |
| `249a9d0` | 第 1 步：patch 解析（A1） |
| `91c49d9` | 第 2 步：store + 重放登记（A2/A4/A10） |
| `3d69dc8` | 第 3 步：写包装记 before/after（A6/A9） |
| `47a246e` | 第 4 步：虚拟文档 + `vscode.diff`（A3） |
| `9e438e0` | 第 5 步：协议 + 卡片链接 + 点击链（A5） |
| `c4ec695` | 第 6 步：漂移守卫 A8 + 端到端 A7 + README/pi-traps |
| `cac4551` | 发布物：0.1.9 + 协议 v5 |

（计划与三轮评审的文档改动见 `git log --oneline -- docs/S7-plan.md`。）

### 12.3 人工验收

**Mac（M1/M2）—— ✅ PASS（2026-09-14）**

| 项 | 结果 |
| --- | --- |
| M1 活的 diff | ✅ 一句话让模型跑五步（两次 write 同一文件、两次 edit 同一文件、一次新建 write）：五张卡片都有入口；新建的标题写「新建」、左侧空；write#2 左 `STAGE-1` / 右 `STAGE-2`；edit#1 只有 `-STAGE-2/+STAGE-3`、edit#2 只有 `-STAGE-3/+STAGE-4`（**没有**互相带出） |
| M2 重载后的口径 | ✅ `Developer: Reload Window` 后同一会话恢复（Output 里的会话文件路径不变）；两张 **edit** 卡片的「查看 diff」**仍可打开**且内容正确（从会话文件里的 `details.patch` 重建）；三张 **write** 卡片显示「本次会话不可用」且**不可点** |
| 用户在验收中提的 4 个问题 | 全部核过并记进 §11（M1-1…M1-4）：红条 / `tail` / `Took 0.0s` / 窄列的上下视图**都是预期行为**；只有第 4 条顺带补了 README 一句话 |

**Windows（W0/W1）—— ✅ PASS（2026-09-15，0.1.9 从 Marketplace 装，Verified）**

| 项 | 结果 |
| --- | --- |
| W0 `Pi: Run Self-Test` | **`GATE PASS`：14 PASS / 0 FAIL / 1 SKIP**（`T12 SKIP E_NO_PI` 预期 —— 那台机器没有 `pi`）。首行确认是 `flyjancy.jerrypi 0.1.9 selftest-v1 win32 node=24.18.1`；`T6` 的返回行带上了 S7 的新核对（`before=null/newFile 已核对`）；`T13` 仍是 advisory（`fetch=wrapped；http.proxySupport=override；http.proxy=(未设)；代理环境变量存在=[…]；PI_OFFLINE=未设`） |
| W1 重启 VS Code → 面板 | ✅ 用户确认"没问题"（自动接过上一会话、能直接打字） |
| diff 的 Windows 项 | **不新增人工动作**（§8 的口径）：解析与虚拟文档与平台无关，Windows 形态的路径与 URI 编码已由 host-check 的 A3 覆盖 |

### 12.4 已知未覆盖

| 项 | 为什么 | 记在哪 |
| --- | --- | --- |
| `write` 的前后快照**只活在进程内** | 重放拿不到它的 details（F5）；存进 VS Code 的 `globalStorage` 等于"持久化用户的文件内容"，是另一个决定 | Q2 · README 已知限制 |
| 超过上限（edit 100 / write 20）之后 | 最早那批卡片显示「较早的改动记录已清理」—— 上限的直接结果，不是坏链 | §3.6 · README 已知限制 |
| 窄列里的 diff 布局（上下 / 左右） | 由 VS Code 的 `diffEditor.useInlineViewWhenSpaceIsLimited` 决定，`vscode.diff` 的参数控制不了 | §11 M1-4 · README 已知限制 |
| 大 patch 的**真实**体验（>2 MiB） | 只断言了"不读不存"，没有真造一份大 patch 点开看 | §3.6 |
| compaction 之后的旧 edit 卡片 | 那些卡片本来就不在重放里（pi 的上下文只保留压缩点之后的消息） | §3.2（不适用，非缺陷） |

## 13. 待用户拍板

见 §4 的 **Q1–Q7**。**默认值都是我的建议**；用户说"可以"之后才动代码。
