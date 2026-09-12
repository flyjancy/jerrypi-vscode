// URL 策略：**唯一**一份 scheme 白名单。
//
// 为什么必须只有一份：渲染层（webview 里把 markdown 变成 HTML）与外部打开层
// （扩展宿主里的 `vscode.env.openExternal`）必须对"什么链接能点"给出**同一个**答案。
// 两份各写一遍的后果不是崩溃，而是更糟的静默不一致——例如渲染层放行 `tel:`，
// 而 openExternal 把它当非法 scheme 丢掉，用户在面板里点了半天没反应，也没有任何提示。
//
// 本文件不 import 任何 pi 或 vscode 的类型，两端都能用。

/** 允许出现在 `<a href>` 并被 `openExternal` 打开的 scheme。 */
export const EXTERNAL_SCHEMES: readonly string[] = ["http", "https", "mailto"];

/**
 * 允许出现在 `<img src>` 的 scheme。
 *
 * **只有 data:** —— 与 PLAN R9 的"只加载本地资源 + 图片 data URI"一致。
 * 放行 `https:` 图片等于把"模型可控的 URL"变成一条出网信道（一张 1×1 的追踪像素
 * 就能把对话内容编码进 query 发出去），所以远程图片一律降级为纯文本。
 */
export const IMAGE_SCHEMES: readonly string[] = ["data"];

/**
 * 取出 URL 的 scheme（小写）。没有 scheme（相对路径、锚点）时返回 `undefined`。
 *
 * **先剥掉 C0 控制字符再判断**：浏览器会忽略 `java\u0001script:` 里的控制字符，
 * 于是 `java\u0001script:` 会被当成 `javascript:` 执行，而朴素的字符串匹配看不出问题。
 * 这条路是 pi 的 export-html 模板验证过的写法。
 */
export function schemeOf(value: string): string | undefined {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "");
  if (cleaned === "") return undefined;
  const match = cleaned.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  return match ? match[1].toLowerCase() : undefined;
}

/** 清洗 URL：剥掉空白与控制字符。没有 scheme 的相对路径原样返回。 */
export function cleanUrl(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * 链接是否可点。
 *
 * 三条规则：
 *  1. **必须显式带一个白名单 scheme**：相对路径、锚点、空串一律不可点。
 *  2. **内部不得含空白**。合法 URI 里没有空白字符，而"带空白的 URL"正是各家解析器
 *     开始各解各的的地方（markdown 解析器、本函数、VS Code 的 `Uri.parse` 可能给出
 *     三种不同的结果）。我们只需要一个答案：不可点。
 *  3. 控制字符在 `schemeOf` 里已经剥掉。
 *
 * 这样"看起来能点的"与"点了有反应的"是同一个集合——渲染层只对通过本判定的链接
 * 生成 `<a>`，外开层用同一个函数再判一次，两层不可能各说各话。
 */
export function isExternalUrlAllowed(value: string): boolean {
  const cleaned = cleanUrl(value);
  if (/\s/.test(cleaned)) return false;
  const scheme = schemeOf(cleaned);
  return scheme !== undefined && EXTERNAL_SCHEMES.includes(scheme);
}

/**
 * 图片是否可显示。
 *
 * **只允许 `data:image/…`**：既要求 scheme 是 `data`，也要求 mediatype 是 `image/`
 * （`data:text/html,…` 不能当图片），同时排除相对路径与 `https:` 远程图片。
 */
export function isImageUrlAllowed(value: string): boolean {
  const cleaned = cleanUrl(value);
  if (schemeOf(cleaned) !== "data") return false;
  return /^data:image\//i.test(cleaned);
}
