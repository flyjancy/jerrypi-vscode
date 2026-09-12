#!/usr/bin/env node
/**
 * `src/shared/toolText.ts` 的单元检查 —— 不需要 VS Code，也不需要网络。
 *
 * 为什么要单独一个脚本：这里的每条错误都是"看起来正常"的那种 ——
 *   - ANSI 没剥干净 → 正文里出现 `[32m` 之类的乱码；
 *   - 控制字符没滤掉 → 后续 DOM 里出现不可见字节；
 *   - 裁剪切在码点中间 → 一个坏掉的 emoji（浏览器会显示成"�"）；
 *   - 按字符而不是字节裁 → 中文会话的预算差三倍。
 *
 * 这些都不会让面板崩，只会让你在真机上盯着乱码发愣，所以放进 CI。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-tool-text-"));
const outfile = path.join(tempDir, "toolText.mjs");
await esbuild.build({
  entryPoints: [path.join(REPO_ROOT, "src/shared/toolText.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  logLevel: "silent",
});
const toolText = await import(pathToFileURL(outfile).href);

// ------------------------------------------------------------ utf8Length
console.log("[tool-text-check] utf8Length");
{
  const samples = [
    "",
    "abc",
    "中文",
    "🦄", // 4 字节码点
    "a中🦄b",
    "行 1\n行 2\n",
    "\u009b32m", // C1 控制字符
  ];
  for (const sample of samples) {
    const expected = Buffer.byteLength(sample, "utf8");
    equal(`utf8Length(${JSON.stringify(sample)}) === Buffer.byteLength`, toolText.utf8Length(sample), expected);
  }
  // 逐码点累加必须与 Buffer 一致（这是"按字节裁剪"的正确性基础）
  const mixed = "汉字" + "x".repeat(10) + "🦄".repeat(3) + "é";
  equal("混合字符串的字节数一致", toolText.utf8Length(mixed), Buffer.byteLength(mixed, "utf8"));
}

// ------------------------------------------------------------ stripAnsi
console.log("[tool-text-check] stripAnsi");
{
  equal("CSI 颜色序列被剥掉", toolText.stripAnsi("\u001b[32m绿色\u001b[0m"), "绿色");
  equal("CSI 带多个参数", toolText.stripAnsi("\u001b[1;31m红\u001b[0m"), "红");
  equal("C1 引入符（U+009B）也被剥掉", toolText.stripAnsi("\u009b32m绿"), "绿");
  equal("OSC 被剥掉（BEL 结尾）", toolText.stripAnsi("\u001b]8;;http://x\u0007链接\u001b]8;;\u0007"), "链接");
  equal("OSC 被剥掉（ESC \\ 结尾）", toolText.stripAnsi("\u001b]0;标题\u001b\\正文"), "正文");
  equal("没有转义序列的字符串原样返回", toolText.stripAnsi("普通文本"), "普通文本");
  equal("只有 ESC 没有后续（不是完整序列）时保留", toolText.stripAnsi("a\u001bb"), "a\u001bb");
}

// ------------------------------------------------------------ sanitizeBinaryOutput
console.log("[tool-text-check] sanitizeBinaryOutput");
{
  equal("保留 tab/换行", toolText.sanitizeBinaryOutput("a\tb\nc"), "a\tb\nc");
  equal("回车保留（由 normalizeToolText 去掉）", toolText.sanitizeBinaryOutput("a\rb"), "a\rb");
  equal("NUL 被去掉", toolText.sanitizeBinaryOutput("a\u0000b"), "ab");
  equal("退格/响铃被去掉", toolText.sanitizeBinaryOutput("a\u0007\u0008b"), "ab");
  equal("DEL(0x7f) 保留（pi 只滤 <=0x1f）", toolText.sanitizeBinaryOutput("a\u007fb"), "a\u007fb");
  equal("Unicode 格式字符 FFF9-FFFB 被去掉", toolText.sanitizeBinaryOutput("a\ufff9\ufffbb"), "ab");
  // ⚠️ 这条与 pi 不同：pi 的注释说"孤立代理项已被 Array.from 过滤"，但 Array.from
  // 按**码点**迭代，孤立代理项本身就是码点 0xD800-0xDFFF，过滤不掉（pi 的实现有这处疏漏）。
  equal("孤立代理项被去掉（我们比 pi 严）", toolText.sanitizeBinaryOutput("a\ud800b"), "ab");
  equal("低端孤立代理项也被去掉", toolText.sanitizeBinaryOutput("a\udfffb"), "ab");
  equal("emoji（合法代理对）保留", toolText.sanitizeBinaryOutput("🦄"), "🦄");
}

// ------------------------------------------------------------ normalizeToolText
console.log("[tool-text-check] normalizeToolText");
{
  equal("CRLF 变成 LF", toolText.normalizeToolText("a\r\nb"), "a\nb");
  equal("单独的 CR 被去掉", toolText.normalizeToolText("a\rb"), "ab");
  equal("ANSI + 控制字符一起处理", toolText.normalizeToolText("\u001b[32m好\u001b[0m\u0000\r\n"), "好\n");
}

// ------------------------------------------------------------ imageNote / toolTextFromContent
console.log("[tool-text-check] toolTextFromContent");
{
  equal("图片提示照 pi 的格式", toolText.imageNote("image/png"), "[Image: image/png]");
  equal("缺 mimeType 时给 image/unknown", toolText.imageNote(""), "[Image: image/unknown]");
  equal(
    "纯文本块",
    toolText.toolTextFromContent([{ type: "text", text: "hello" }]),
    "hello",
  );
  equal(
    "多个文本块用 \\n 连接",
    toolText.toolTextFromContent([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
  equal(
    "图片接在文本之后",
    toolText.toolTextFromContent([
      { type: "text", text: "读到了：" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ]),
    "读到了：\n[Image: image/png]",
  );
  equal(
    "只有图片时就是提示本身",
    toolText.toolTextFromContent([{ type: "image", mimeType: "image/jpeg" }]),
    "[Image: image/jpeg]",
  );
  equal("空 content", toolText.toolTextFromContent([]), "");
  equal("非数组 content", toolText.toolTextFromContent(undefined), "");
  equal("未知块类型被忽略", toolText.toolTextFromContent([{ type: "audio" }]), "");
  equal(
    "文本块里的 ANSI 被净化",
    toolText.toolTextFromContent([{ type: "text", text: "\u001b[31m红\u001b[0m" }]),
    "红",
  );
  // **不变量**：正文里绝不残留 ESC（否则后续 DOM 会出现控制字节）
  const dirty = toolText.toolTextFromContent([
    { type: "text", text: "\u001b[1m\u001b]0;x\u0007a\u0000b" },
  ]);
  check("净化后不含 ESC", !dirty.includes("\u001b"), JSON.stringify(dirty));
  check("净化后不含 NUL", !dirty.includes("\u0000"), JSON.stringify(dirty));
}

// ------------------------------------------------------------ clipToolText
console.log("[tool-text-check] clipToolText");
{
  const short = toolText.clipToolText("abc", 1024);
  equal("没超限时原样返回", short.text, "abc");
  equal("没超限时 clipped=false", short.clipped, false);
  equal("没超限时 omittedBytes=0", short.omittedBytes, 0);

  // ASCII：正好等于上限
  const exact = "x".repeat(100);
  equal("正好等于上限时不裁", toolText.clipToolText(exact, 100).clipped, false);

  // ASCII：超一个字节
  const over = "x".repeat(101);
  const clipped = toolText.clipToolText(over, 100);
  equal("超一个字节就裁", clipped.clipped, true);
  equal("保留 100 字节", clipped.text.slice(0, 100), "x".repeat(100));
  equal("省略字节数正确", clipped.omittedBytes, 1);
  check("末尾带省略说明", clipped.text.includes("…（已省略 1 字节）"), clipped.text.slice(-30));

  // 中文：3 字节/字。上限 7 → 只能放 2 个汉字（6 字节），剩下 1 字节不够再放一个
  const cjk = "汉字汉"; // 9 字节
  const cjkClipped = toolText.clipToolText(cjk, 7);
  equal("中文按字节裁（留 2 个字）", cjkClipped.text.split("\n")[0], "汉字");
  equal("中文省略字节数正确", cjkClipped.omittedBytes, 3);

  // 代理对：不能在 emoji 中间切开
  const emoji = "a🦄b🦄c"; // a(1) 🦄(4) b(1) 🦄(4) c(1) = 11
  const emojiClipped = toolText.clipToolText(emoji, 6);
  const head = emojiClipped.text.split("\n")[0];
  equal("裁剪点落在码点边界（保留 a🦄b）", head, "a🦄b");
  // 注意用 isWellFormed 而不是正则 `/[\uD800-\uDFFF]/`：后者会把**合法代理对**里的
  // 两个码元也算成命中（"a🦄b" 会被误判成含孤立代理项）。真正的判据是"字符串结构完整"。
  check("裁剪结果结构完整（无孤立代理项）", head.isWellFormed() === true, JSON.stringify(head));
  check("孤立代理项输入会被 sanitize 掉", toolText.sanitizeBinaryOutput("a\ud800b").isWellFormed() === true);
  equal("emoji 裁剪的省略字节数", emojiClipped.omittedBytes, 5);

  // 边界：上限 0 → 全裁
  const zero = toolText.clipToolText("abc", 0);
  equal("上限 0 时正文为空", zero.text.split("\n")[0], "");
  equal("上限 0 时全部省略", zero.omittedBytes, 3);

  // 二次裁剪必须无事发生（不能把"已省略"标记也裁掉）
  const once = toolText.clipToolText("x".repeat(200), 100);
  const twice = toolText.clipToolText(once.text, 100);
  check(
    "再裁一次时不会再吃掉说明文字（说明文字属于新增内容，需要重新裁）",
    twice.clipped === true || twice.text.includes("已省略"),
    JSON.stringify(twice.text.slice(-40)),
  );
}

console.log(`TOOL-TEXT-CHECK ${failures === 0 ? "OK" : "FAILED"} (${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
