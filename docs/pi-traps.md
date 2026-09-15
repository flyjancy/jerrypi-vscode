# pi 的语义陷阱（**索引**）

> **这只是一张索引**：每条一句话 + 指针。理由、实测数据、失败现象都在指针处，**不在这里复制**
> （复制出来的副本一定会烂掉 —— 与 `docs/STATUS.md` 同一条规矩）。
>
> **用法**：改任何与 pi 交互的代码前扫一遍；踩到新坑时**同时**在这里加一行。
> 版本锚点：**pi 0.85.1**（`package.json` 的 devDependencies 与 `pi-runtime/.version` 钉死）。
> 上游升版后这张表要重验 —— 见 S5-plan 的 R1（T10/T11/T12 就是为它准备的守卫）。

| # | 陷阱（一句话） | 出处 |
| --- | --- | --- |
| 1 | 它的 `sessionDir` 参数是"**直接装 `.jsonl` 的目录**"，不是"sessions 根" —— 差一层就写到没人看得见的地方 | S5-plan §3.1（含实测；根 `PLAN.md` 的 **D5-N3 是错的那条**） |
| 2 | 会话布局是 `<agentDir>/sessions/--<编码 cwd>--/`；它的 `resolvePath()` **只做 `path.resolve`、不 realpath** —— 但**终端 CLI 拿到的 cwd 是 `process.cwd()`，那是物理路径**（macOS：`/var/…` → `/private/var/…`）。所以双方必须自己对齐：我们对 cwd 做了 `realpathSync`（失败退回 `path.resolve`），否则同一个文件夹会有两个会话目录、互通静默断掉 | S5-plan §3.1 · §11 的 6-8/6-9 · R2 |
| 18 | 同一台机器上**同一个路径可以有多种写法**：Windows 上 VS Code 给 `c:\…`，而 `os.tmpdir()` 是 `C:\…`（W0 实测）。`sessionCwdMatches` 是**严格字符串比较** → 自定义 agentDir（`filterCwd` 变 true）时会把会话整批滤掉 | S5-plan R10 · §12.3 |
| 19 | ⚠️ `RuntimeCredentials.delete()`（= `ModelRuntime.logout()`）**会去删底层 auth.json 里用户自己的凭据**。清我们存在 SecretStorage 里的 key **绝不能用 `logout()`**，要用 `removeRuntimeApiKey()` | S6-plan §0.2 F6 · §11 的 3-3（能红验证：换成 `logout()` → A5③ 报出新 sha256 是 `44136fa…`，正是 `{}` 的 sha256） |
| 20 | 任何一次**带锁的**凭据读都会在 agentDir 里惰性建一个**空的** `auth.json`（内容 `{}`）——`FileAuthStorageBackend.withLock/withLockAsync` 第一句就是 `ensureFileExists()`（`auth-storage.js:47-50`），而 `ModelRuntime.create()` 的首个 refresh 就会走凭据读。所以“我们不碰 auth.json”的准确说法是 **“不写凭据进去”**（空壳是 pi 建的） | S6-plan §11 的 5-1（A4③ 第一版就是红在这里） |
| 21 | `models.refresh({allowNetwork:true})` 对**没有凭据**的 provider 在联网前就 `return`（`if (!credential) return`）→ “刷新”在空凭据目录里**一次请求都不发**，这不是探针坏了 | S6-plan §11 的 6-1（`pi-ai/dist/models.js:150-155`） |
| 22 | `refresh()` 的联网默认值来自 `modelNetworkEnabled`（= `PI_OFFLINE === undefined`），**不是** `create({allowModelNetwork:false})`（后者只管创建期那次）；而且 `models-store.json` 的 `checkedAt` 未满 4 小时时直接 return（`REMOTE_CATALOG_REFRESH_INTERVAL_MS`）。要测“真的会联网”必须用全新 store 或 `force: true` | S6-plan §0.2 F8 · §6 A12（能红：`allowNetwork` 改 false → A8/A12 红） |
| 3 | 只有出过**至少一条 assistant 消息**才建会话文件；`getSessionFile()` 在此之前就有值但文件不存在 | S5-plan §3.5 |
| 4 | `isPersisted()` 返回的是"**会不会**落盘"，不是"落盘了没" —— 判落盘用 `existsSync(getSessionFile())` | S5-plan §3.5 |
| 5 | `isIdle` 覆盖续跑循环与压缩，但**不覆盖**"已发送、`agent_start` 还没到"那个窗口（本仓用 `pendingSend` 补） | S5-plan D7 |
| 6 | `teardownCurrent()`（换会话时）第一句就是 `await abort()`，**被中止的那一轮会先落盘**，不丢数据 | S5-plan §3.6（评审 B1） |
| 7 | "最近"有**两个键**：`continueRecent` 用文件 mtime，`list()` 的 `modified` 用消息活动时间 | S5-plan §3.2 |
| 8 | `listAll()` **只遍历编码子目录** → 平铺在 sessions 根上的文件谁也看不见 | S5-plan §3.1 |
| 9 | `switchSession` 之后 `sessionDir` 变成**所选文件的父目录**（后续 `newSession` 跟着走） | S5-plan §3.4 |
| 10 | `switchSession`/`newSession` 返回 `{cancelled}`：扩展的 `session_before_switch` 可以取消，取消时不 rebind | S5-plan §3.6 |
| 11 | `SessionManager.create(cwd)` 与 `create(cwd, dir)` 都会 **`mkdirSync`** → 别拿临时 cwd 去调（会在用户真实 agentDir 里留目录） | S5-plan D1（评审 B3） |
| 12 | 会话目录还有两个**上游开关**：环境变量 `PI_CODING_AGENT_SESSION_DIR`、`settings.json` 的 `sessionDir`（优先级都高于默认）—— 我们**不跟随** | S5-plan R9 |
| 13 | `MissingSessionCwdError` **不在 bundle 导出面**，但有结构化的 `issue` → 按 `error.name` + `issue` 判定 | S5-plan D9 |
| 14 | `getDefaultSessionDir`、`formatTokens` 这类**没有从 bundle 导出**（包的 `exports` map 也不允许深导入 `dist/modes/...`） | S4-plan §3.3 · `src/shared/format.ts` 头注释 |
| 15 | `configureHttpDispatcher()`（代理）**只被 CLI 入口调用**，SDK 路径不会自动调用，也没从 `index.js` 导出 | `docs/PLAN.md` §2 |
| 16 | bash 工具在 Windows 上按 `settings.json.shellPath` → `C:\Program Files\Git\bin\bash.exe` → PATH 顺序找 | `docs/PLAN.md` §2 |
| 17 | 模型目录是"内置 + `<agentDir>/models-store.json`"合并出来的，**联网刷新是另一个开关**（我们写死 `allowModelNetwork: false`） | README 已知限制 · S4-plan §12.5 |

| 23 | `EditToolDetails`（`{diff, patch, firstChangedLine}`）只对**成功**的 edit 存在；**失败的 edit 是 `details = {}`（真值空对象）**，所以 `if (details)` 这种判断会给失败卡片挂上一个点开是空的死链。patch 的语义是"**该次调用**的前后"，不是"当前磁盘 vs 首次原文" | S7-plan §0.1 F1/F5b · §6 A10（能红：判断写成 `if (details)` → A10 红） |
| 24 | `write` 工具**没有** details（`details: undefined`），而它的 `ops.mkdir`/`ops.writeFile` 是**在 `withFileMutationQueue` 之内**被调用的 —— 想拿"该次调用前后"，必须在 `ops.writeFile` 里先读旧内容；放到外层 `execute` 里读就跑到队列之外，同一条消息里两次写同一文件会读到同一个"旧"内容 | S7-plan §0.1 F8/F9 · §6 A6（能红：读盘挪到写完之后 → A6 两条红） |
| 25 | `tool_call`（扩展审批钩子）在 **`tool_execution_start` 之后**触发 ⇒ 审批时工具卡片已经存在（可以就地加按钮），`pendingToolCalls` 里也已经有它（面板重开能重放）。**但 `tool_call` 处理器抛错不是"放行"**：`emitToolCall` 不 catch，错误会变成一条 `Extension failed, blocking execution: …` 的 error toolResult ⇒ 处理器必须自己包 try/catch（我们选 fail-closed） | S8-plan §0.1 F2/F4 · §6 A2（能红：把 block 改成 false / 去掉 try-catch） |
| 26 | **待审批时 `session.abort()` 会让 pi 再调一次模型**，那一次必须由模型流尊重 `signal` 才能收口（返回 `stopReason:"aborted"`）；假模型无视 signal 的话 agent 循环会**无限转**。同理：**被拒绝的工具调用不会终止循环** —— pi 把结果喂回模型再问一次 | S8-plan §0.1 F6/F7/F7b · §11 的 1-1（能红：探针挂死两次） |
| 27 | **`resolveProjectTrusted()` / `getProjectTrustOptions()` / `emitProjectTrustEvent()` 没有从 bundle 导出**（只在 CLI 那个 chunk 里）；能用的只有 `hasTrustRequiringProjectResources` 与 `ProjectTrustStore`。而且 `resolveProjectTrust` 钩子一旦传了就**无条件被调用**（哪怕 cwd 里一个 `.pi/` 都没有）——「没资源就别问」得自己短路；`<agentDir>/trust.json` 的键是 **canonical 路径**（父目录的裁决会被子目录继承） | S8-plan §0.2 F11/F12/F14/F15 · §6 A10/A11（能红：删掉那个短路 → A11③ 红） |

**怎么区分"我踩到新坑了"和"我读错了"**：先写一个**最小探针**（临时目录 + 我们发布的那份 bundle），
把"我以为的行为"和"实际行为"并排打出来 —— S5 的 §3.1、§3.5、§3.8 都是这么定案的。
探针结论要**连数字一起**写进对应 plan，并在这里加一行。
