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
// 两个已经踩过的坑，别"顺手优化"：
//   1. **不要 `realpath`**：pi 的 `resolvePath()` 就是 `path.resolve`（`utils/paths.js`，
//      同文件里的 `canonicalizePath` 没被它调用），实测符号链接 `link -> real` 会得到
//      **两个不同**的编码目录。我们跟着不归一化 —— 与 pi 一致优先于"看着更对"。
//   2. **只有这一处推导**：调用方一律传 `sessionsRoot`（= `<agentDir>/sessions` 这一层），
//      由本文件加编码子目录。以前那个 `sessionsDir` 选项名就是被当成"根"用错的，
//      S5 把它改名正是为了让编译器抓出每一个误用点。
import { join, resolve } from "node:path";

/** `<agentDir>/sessions` —— **根**，不是某个 cwd 的目录。 */
export function sessionsRootOf(agentDir: string): string {
  return join(agentDir, "sessions");
}

/**
 * 某个 cwd 的会话目录（pi 的规范位置）。逐字符复刻 `session-manager.js:245-246`：
 * `join(agentDir, "sessions", \`--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--\`)`。
 */
export function resolveSessionDir(cwd: string, sessionsRoot: string): string {
  const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot, encoded);
}
