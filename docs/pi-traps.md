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
| 2 | 会话布局是 `<agentDir>/sessions/--<编码 cwd>--/`，且**不做 realpath**（符号链接 `link` 与 `real` 会得到两个目录） | S5-plan §3.1 |
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

**怎么区分"我踩到新坑了"和"我读错了"**：先写一个**最小探针**（临时目录 + 我们发布的那份 bundle），
把"我以为的行为"和"实际行为"并排打出来 —— S5 的 §3.1、§3.5、§3.8 都是这么定案的。
探针结论要**连数字一起**写进对应 plan，并在这里加一行。
