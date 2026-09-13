// 会话目录的推导 —— **本项目最容易搞错的一处**，所以单独一个文件。
//
// pi 的 `SessionManager.create/open/list/continueRecent` 的第二个参数 `sessionDir`
// **不是"sessions 根目录"，而是"直接装 .jsonl 的那个目录"**：
// `session-manager.js:1127` 直接 `join(this.getSessionDir(), <文件名>)`。
// 而 pi 的默认布局是 per-cwd 的编码子目录：
//
//   <agentDir>/sessions/--<把绝对 cwd 里的 / \ : 换成 -，并去掉开头的分隔符>--/
//
// 写错这一层的后果是**静默的**：文件照样写成功，只是写到了没人看的地方 ——
// `pi --resume` 找不到它，连 pi 自己的 `listAll()` 也扫不到（它只遍历编码子目录）。
// S5 之前我们就是这样，实测数据见 docs/S5-plan.md §3.1。
//
// 为什么不干脆不传 `sessionDir`、让 pi 自己算：
//   - `getDefaultSessionDir(cwd, agentDir)` **没有从 bundle 导出**，而运行期我们只加载
//     `pi-runtime/dist/bundle/index.js`（S4 的 `formatTokens` 同理）；
//   - 它默认吃 `getAgentDir()`，S6 的 `jerrypi.agentDir` 一套上就失效。
// → 所以只能复刻规则，并用**两条断言**把它钉在 pi 身上（都在 `Pi: Run Self-Test` 里）：
//   · T10：默认 agentDir + 真实 cwd 下，`SessionManager.usesDefaultSessionDir()` 必须为 true
//     —— 那是 pi 自己的判据（全路径相等）；
//   · T12：如果能找到**用户终端里那份 pi**，直接 import 它的 `session-manager.js` 比一次
//     —— 那是另一份独立安装（会各自升级），我们的自测本来打不到它。
//
// 三个已经踩过的坑，别"顺手优化"：
//   1. **要 `realpath`（这是 S5 验收期实测改的）**：pi 的 `resolvePath()` 只做 `path.resolve`，
//      但 `pi` CLI 拿到的 cwd 是 `process.cwd()` —— 而 Node 的它**是物理路径**。
//      实测（macOS）：子进程在 `cwd=/var/folders/…` 里看到的是 `/private/var/folders/…`，
//      于是 CLI 写 `--private-var-…--`、我们写 `--var-…--`：**同一个文件夹、两个会话目录**，
//      互通静默断掉。所以这里做与 `canonicalizePath`（pi 的 `utils/paths.js` 里有，但
//      session-manager 没用它）相同的规范化：能 realpath 就 realpath，失败就退回原路径。
//   2. **只有这一处推导**：调用方一律传 `sessionsRoot`（= `<agentDir>/sessions` 这一层），
//      由本文件加编码子目录。以前那个 `sessionsDir` 选项名就是被当成"根"用错的，
//      S5 把它改名正是为了让编译器抓出每一个误用点。
//   3. 与 pi SDK 侧的 `getDefaultSessionDir(cwd)`（不传 sessionDir 时用的那个）在
//      **非物理路径**下会不一致 —— 这是刻意的：我们的对端口是**终端的 CLI**，而 CLI 的
//      cwd 是物理的。生产代码从不依赖 pi 的默认推导（一律显式传 sessionDir）。
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** `<agentDir>/sessions` —— **根**，不是某个 cwd 的目录。 */
export function sessionsRootOf(agentDir: string): string {
  return join(agentDir, "sessions");
}

/**
 * 某个 cwd 的会话目录（pi 的规范位置）。编码规则逐字符复刻 `session-manager.js:245-246`：
 * `join(agentDir, "sessions", \`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--\`)`。
 *
 * **cwd 先物理化**（见文件头注释 3）：`pi` CLI 的 cwd 来自 `process.cwd()`，是物理路径；
 * 我们要是用 VS Code 给的（可能带符号链接的）fsPath，两边就会写到两个不同的目录里。
 * 物理化失败（路径不存在等）就退回原路径 —— 不因为解析失败而丢会话。
 */
export function resolveSessionDir(cwd: string, sessionsRoot: string): string {
  const physical = realpathSyncSafe(cwd);
  const encoded = `--${physical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot, encoded);
}

/** `realpathSync` 失败时退回 `path.resolve`（与 pi 的 `canonicalizePath` 同一个策略）。 */
function realpathSyncSafe(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}
