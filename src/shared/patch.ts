// unified patch → 两侧文本（**纯函数**，S7 的 diff 审阅靠它）。
//
// 为什么必须自己写：pi 的包**导出**了 `generateUnifiedPatch`，但**没有**导出
// `parsePatch`/`applyPatch`（`pi-runtime/dist/bundle/index.js` 的导出面里 grep 过：
// 0 命中）。而我们要把会话文件里持久化的 `details.patch`（`EditToolDetails`，见
// `docs/S7-plan.md` §0.1 的 F1）重新变成可打开的两侧文本，只能自己解析。
//
// 四条不能想当然的规则（都来自实跑，见 S7-plan §0.1/§3.3）：
//   1. patch 正文行里的 `\r` **是文件内容**，不是 patch 的行终止符 —— 全局"归一化行尾"
//      会静默吃掉它（评审 S2 实测：`generateUnifiedPatch("a.ts","a\r\nb\r\n","a\r\nB\r\n")`
//      的正文里真有 `a\r`/`-b\r`）。所以这里只按 `\n` 切，只剥 hunk 头那一行的 `\r`。
//   2. `\ No newline at end of file` 作用于**紧邻它的上一行**，而且 0/1/2 次都合法
//      （评审 N1）：它决定"这一侧的最后一行有没有尾换行"。
//   3. hunk 头可能不带 `,count`（`@@ -5 +5 @@`）、尾部可能带 section heading
//      （`@@ -1,7 +1,7 @@ function foo()`）—— 别的 patch 源会给这两种（评审 N2）。
//   4. 头两行只可能是 `--- `/`+++ `；进了 hunk 之后 `--- xxx` 这种行**是正文**
//      （删掉一行 `-- xxx` 就会长这样），不能再按头解析。
//
// hunk 之间插一条两侧相同的分隔行（`HUNK_GAP`）：不然多 hunk 时左侧会让"第 6 行之后
// 直接是第 21 行"，看起来像连续文件 —— 那正是 S7-plan 的 R1（"看起来像真的"）。

/** hunk 之间的分隔行（两侧相同，所以不会被 diff 算成差异）。 */
export const HUNK_GAP = "⋯（中间省略）";

/** 每个 hunk 各自的行（断言与 oracle 对照用；渲染用扁平的 left/right）。 */
export interface PatchHunkSides {
  left: string[];
  right: string[];
}

export interface PatchSides {
  /** 左侧（改动前）：各 hunk 的旧侧行用 `\n` 连接，hunk 之间是 `HUNK_GAP`。 */
  left: string;
  /** 右侧（改动后）。 */
  right: string;
  /** 每个 hunk 的旧/新行（不含分隔行）。 */
  hunks: PatchHunkSides[];
}

/** `@@ -a[,b] +c[,d] @@` —— `,count` 可省，`@@` 之后允许有 section heading。 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const NO_NEWLINE = "\\ No newline at end of file";

/** 只剥一个行尾 `\r`（给头行用；正文行**不动** —— 见文件头第 1 条）。 */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * 解析 unified patch。
 *
 * 认不出来的行**忽略**（不抛错）：patch 是别人产的（pi / 别的 diff 实现 / 手改过的
 * 会话文件），宁可少显示几行也不要让面板炸掉。
 */
export function sidesOfPatch(patch: string): PatchSides {
  const lines = patch.split("\n");
  // patch 恒以 `\n` 结尾 → 最后那个空元素要**显式**丢掉（不能靠"首字符落不进分类"兜着）。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const hunks: PatchHunkSides[] = [];
  let current: PatchHunkSides | undefined;
  let leftNoNewline = false;
  let rightNoNewline = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (current === undefined) {
      // 还没进 hunk：只可能是两个头行（进了 hunk 之后同样形状的行是正文，见第 4 条）。
      if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    }
    if (HUNK_HEADER.test(stripCr(raw))) {
      current = { left: [], right: [] };
      hunks.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (stripCr(raw) === NO_NEWLINE) {
      // 作用于**紧邻的上一行**：由它的首字符决定影响哪一侧。
      const prefix = (lines[i - 1] ?? "")[0] ?? " ";
      if (prefix === "-" || prefix === " ") leftNoNewline = true;
      if (prefix === "+" || prefix === " ") rightNoNewline = true;
      continue;
    }
    const prefix = raw[0] ?? "";
    const text = raw.slice(1);
    if (prefix === " ") {
      current.left.push(text);
      current.right.push(text);
    } else if (prefix === "-") {
      current.left.push(text);
    } else if (prefix === "+") {
      current.right.push(text);
    }
    // 其余（空行、垃圾行）忽略。
  }

  return {
    left: flatten(hunks, "left", leftNoNewline),
    right: flatten(hunks, "right", rightNoNewline),
    hunks,
  };
}

/** 把各 hunk 的同一侧摊平；hunk 之间插 `HUNK_GAP`。 */
function flatten(hunks: PatchHunkSides[], side: "left" | "right", noNewline: boolean): string {
  const blocks = hunks.map((hunk) => hunk[side]).filter((rows) => rows.length > 0);
  if (blocks.length === 0) return "";
  const body = blocks.map((rows) => rows.join("\n")).join(`\n${HUNK_GAP}\n`);
  return noNewline ? body : `${body}\n`;
}

/**
 * 从 patch 头取文件名（diff 编辑器标题用）。
 *
 * 优先 `+++`（改动后那一侧），它是 `/dev/null` 时退回 `---`；两行都可能带
 * GNU diff 的 `\t<时间戳>`。**不 import `node:path`** —— 本文件会被打进浏览器产物
 * （`esbuild.mjs` 第 10 条），所以 basename 要自己同时按 `/` 与 `\` 切。
 */
export function patchPathOf(patch: string): string {
  const lines = patch.split("\n");
  let minus: string | undefined;
  let plus: string | undefined;
  for (const raw of lines) {
    const line = stripCr(raw);
    if (HUNK_HEADER.test(line)) break; // 头行只在前两行；进了 hunk 就不再找
    if (line.startsWith("--- ") && minus === undefined) minus = line.slice(4);
    else if (line.startsWith("+++ ") && plus === undefined) plus = line.slice(4);
  }
  const clean = (value: string | undefined): string => {
    if (value === undefined) return "";
    const tab = value.indexOf("\t"); // GNU diff 会跟一个 \t<时间戳>
    const path = (tab === -1 ? value : value.slice(0, tab)).trim();
    return path === "/dev/null" ? "" : path;
  };
  return clean(plus) || clean(minus);
}

/** basename（标题用）：同时按 `/` 与 `\` 切 —— Windows 的 `C:\\a\\b.ts` 也要取到 `b.ts`。 */
export function pathLabelOf(patch: string): string {
  const path = patchPathOf(patch);
  if (path === "") return "";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}
