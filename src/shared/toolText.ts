// 工具结果的文本处理：**纯函数**，不 import pi、不 import vscode。
//
// 为什么单独一个模块：工具结果正文是**不可信输入**（模型可控、命令输出可控），
// 而且 pi 不导出它自己那两个净化函数（`utils/ansi.js:39` 的 stripAnsi、
// `utils/shell.js:135` 的 sanitizeBinaryOutput —— 都在 `dist/bundle` 的导出面之外，
// 而 `pi-runtime/` 只同步 `dist/bundle/**`，深路径 import 也做不到）。
// 所以这里写等价实现，并用 `scripts/tool-text-check.mjs` 固定行为。
//
// ⚠️ **净化 ≠ 转义**（S3 约束 #4）：本模块只是把终端控制序列与二进制垃圾去掉（为了好看），
// 真正的安全靠 `src/webview/render.ts` 的逃逸 + CSP。谁都不许把这里当消毒用。

/** 一个多字节字符在 UTF-8 下的字节数。 */
function utf8BytesOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** 字符串的 UTF-8 字节数（按**码点**算，与 `TextEncoder` 等价）。 */
export function utf8Length(value: string): number {
  let total = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    total += utf8BytesOfCodePoint(codePoint);
  }
  return total;
}

/**
 * 去掉终端转义序列（CSI / OSC）。
 *
 * 照 pi 的 `utils/ansi.js` 写：OSC 是 `ESC ] … (BEL | ESC \ | U+009C)`，CSI 是
 * `ESC|U+009B` + 中间字节 + 参数 + 终止字节。只用 `replace`（它自己会重置 `lastIndex`）。
 */
export function stripAnsi(value: string): string {
  if (!value.includes("\u001b") && !value.includes("\u009b")) return value;
  const st = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
  const osc = `(?:\\u001B\\][\\s\\S]*?${st})`;
  const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
  return value.replace(new RegExp(`${osc}|${csi}`, "g"), "");
}

/**
 * 过滤会让显示出问题的字符（照 pi 的 `utils/shell.js`）。
 *
 * 保留 tab / 换行 / 回车；去掉其余 C0 控制字符、孤立代理项与 Unicode 格式字符
 * （后者在终端里会让宽度计算崩掉，在 webview 里则是不可见垃圾）。
 *
 * ⚠️ **与 pi 的一处刻意差异**：pi 的实现只滤 `<=0x1f` 与 `0xfff9-0xfffb`，注释里写
 * "孤立代理项（已被 Array.from 过滤）" —— 但 **`Array.from` 不过滤孤立代理项**
 * （它按码点迭代，孤立代理项本身就是一个"码点" 0xD800-0xDFFF）。
 * 我们显式滤掉这一段：孤立代理项会让字符串结构不完整（JSON 往返后变成 U+FFFD），
 * 在本项目里它只可能来自被破坏的命令输出。这条差异由 `tool-text-check.mjs` 固定。
 */
export function sanitizeBinaryOutput(value: string): string {
  let out = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
      out += char;
      continue;
    }
    if (codePoint <= 0x1f) continue;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    if (codePoint >= 0xfff9 && codePoint <= 0xfffb) continue;
    out += char;
  }
  return out;
}

/** 单个文本块的净化：剥 ANSI → 过滤二进制字符 → 去掉回车（`\r\n` → `\n`）。 */
export function normalizeToolText(value: string): string {
  return sanitizeBinaryOutput(stripAnsi(value)).replace(/\r/g, "");
}

/**
 * 图片块的降级提示。
 *
 * 照 pi 的 `imageFallback`（`pi-tui/dist/terminal-image.js:534`）的格式：`[Image: <mime>]`。
 * pi 在能算出尺寸时会补 `800x600`，我们不算（要解 PNG/JPEG/GIF/WEBP 头，见 S3-plan D9）。
 */
export function imageNote(mimeType: string): string {
  return `[Image: ${mimeType === "" ? "image/unknown" : mimeType}]`;
}

/**
 * pi 的 tool result `content` → 一段可显示的正文。
 *
 * 与 pi 的 `getTextOutput`（`core/tools/render-utils.js:35-52`）同构：
 * text 块逐个净化后用 `\n` 连接；image 块降级成提示、接在后面。
 */
export function toolTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  const images: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text") {
      texts.push(normalizeToolText(String(block.text ?? "")));
    } else if (block.type === "image") {
      images.push(imageNote(String(block.mimeType ?? "")));
    }
  }
  const body = texts.join("\n");
  if (images.length === 0) return body;
  const notes = images.join("\n");
  return body === "" ? notes : `${body}\n${notes}`;
}

export interface ClippedText {
  text: string;
  clipped: boolean;
  /** 被省略掉的字节数（0 表示没裁）。 */
  omittedBytes: number;
}

/**
 * 按 **UTF-8 字节**裁剪：**保留头部**，末尾挂一行说明。
 *
 * 为什么按字节：50K 个汉字是 150KB，按字符算的预算在中文会话里会差三倍（S3-plan D3）。
 * 为什么保留头部：内置工具的结果已经被 pi 自己裁过了（≤50KB + 一行脚注），
 * 能触发我们这条上限的只有"返回超大文本的扩展工具"，这类结果的头部信息量最大。
 * 裁剪点回退到**码点**边界（不能切出半个 emoji）。
 */
export function clipToolText(value: string, maxBytes: number): ClippedText {
  const total = utf8Length(value);
  if (total <= maxBytes) return { text: value, clipped: false, omittedBytes: 0 };

  let used = 0;
  let end = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) break;
    const size = utf8BytesOfCodePoint(codePoint);
    if (used + size > maxBytes) break;
    used += size;
    end += char.length;
  }
  const omittedBytes = total - used;
  return {
    text: `${value.slice(0, end)}\n…（已省略 ${omittedBytes} 字节）`,
    clipped: true,
    omittedBytes,
  };
}
