#!/usr/bin/env node
/**
 * 渲染安全回归（CI 可跑，不需要 VS Code）。
 *
 * 为什么必须自动化：markdown 渲染是 S2 里**唯一有真实安全后果**的部分。
 * agent 的输出、文件内容、bash 输出都可能是恶意 HTML/链接，而 marked 默认**不消毒**。
 * 这类 bug 的表现还很隐蔽——面板看起来一切正常，只是某天点了一个链接。
 *
 * 判据（关键在第一条）：
 *   转义后的文本里不会出现裸 `<`，所以输出里**所有** `<…>` 都是 marked 自己生成的标签。
 *   逐个检查这些标签，禁止出现被禁标签、`on*=`/`srcdoc=` 属性、
 *   `href|src` 指向 `javascript:|data:|vbscript:|file:`。
 *
 * 另外还断言一件容易漏的事：**渲染层与外部打开层的判定必须一致**（同一份 urlPolicy）。
 * 不一致的后果不是崩溃，而是"渲染成可点的蓝字、点了却静默无反应"。
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

function check(name, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const FORBIDDEN_TAG = /<\/?(script|iframe|svg|object|embed|style|link|meta|form|base|body)\b/i;
const BAD_ATTR = /\s(on\w+|srcdoc)\s*=/i;
const BAD_URL = /(href|src)\s*=\s*"(?:\s*(?:javascript|data|vbscript|file):)/i;

/**
 * 审计一段 HTML：先禁掉整类标签，再逐个检查真实标签上的属性与 URL。
 *
 * 为什么可以只扫标签：所有来自输入的数据都已经被 escapeHtml 转义，裸 `<` 不存在，
 * 因此输出里出现的每个 `<…>` 都必然是 marked 的某个 renderer 生成的。
 */
function audit(html) {
  if (FORBIDDEN_TAG.test(html)) return `出现被禁标签: ${html.match(FORBIDDEN_TAG)[0]}`;
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    if (BAD_ATTR.test(tag)) return `标签带事件属性: ${tag}`;
    if (BAD_URL.test(tag)) return `标签带危险 URL: ${tag}`;
  }
  return null;
}

/** 载荷 → 期望：`plain` 表示必须以纯文本形式出现（不生成任何标签）。 */
const PAYLOADS = [
  ["<img src=x onerror>", '<img src=x onerror="alert(1)">'],
  ["<script> 标签", "<script>alert(1)</script>"],
  ["<svg onload>", '<svg onload="alert(1)">'],
  ["<iframe>", '<iframe src="https://evil.example"></iframe>'],
  ["<style> 注入", "<style>body{display:none}</style>"],
  ["<form> 注入", '<form action="https://evil.example"><input name="x"></form>'],
  ["[x](javascript:)", "[x](javascript:alert(1))"],
  ["[x](JaVaScRiPt:)", "[x](JaVaScRiPt:alert(1))"],
  ["[x](java\\x01script:)", "[x](java\u0001script:alert(1))"],
  ["[x](data:text/html)", "[x](data:text/html;base64,PHNjcmlwdD4=)"],
  ["[x](vbscript:)", "[x](vbscript:msgbox(1))"],
  ["[x](file:///)", "[x](file:///etc/passwd)"],
];

/** 正常内容：必须仍然正常渲染（防"为了安全把功能全关了"）。 */
const NORMAL_CASES = [
  ["正常粗体", "**b**", /<strong>b<\/strong>/],
  ["正常删除线", "~~d~~", /<del>d<\/del>/],
  ["正常链接", "[ok](https://example.com)", /<a href="https:\/\/example\.com"[^>]*>ok<\/a>/],
  ["正常行内代码", "`<script>`", /<code>&lt;script&gt;<\/code>/],
  ["中文与换行", "第一行\n第二行", /第一行[\s\S]*第二行/],
];

/** 渲染层与 urlPolicy 各打一份（后者要单独 import 才能做"判定一致"的断言）。 */
async function loadModules(tempDir) {
  await esbuild.build({
    entryPoints: [
      path.join(REPO_ROOT, "src", "webview", "render.ts"),
      path.join(REPO_ROOT, "src", "shared", "urlPolicy.ts"),
      path.join(REPO_ROOT, "src", "host", "webviewHtml.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outdir: tempDir,
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  return {
    render: await import(pathToFileURL(path.join(tempDir, "render.mjs")).href),
    urlPolicy: await import(pathToFileURL(path.join(tempDir, "urlPolicy.mjs")).href),
    html: await import(pathToFileURL(path.join(tempDir, "webviewHtml.mjs")).href),
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jerrypi-render-check-"));
  let failed = 0;
  try {
    const { render, urlPolicy, html: htmlModule } = await loadModules(tempDir);

    console.log("[render-check] 攻击载荷");
    for (const [name, payload] of PAYLOADS) {
      const html = render.renderMarkdown(payload);
      const problem = audit(html);
      check(`${name} → 无危险输出`, problem === null, problem ?? "");
    }

    console.log("[render-check] 正常内容");
    for (const [name, input, pattern] of NORMAL_CASES) {
      const html = render.renderMarkdown(input);
      check(`${name} → 正常渲染`, pattern.test(html), html.slice(0, 120));
    }

    console.log("[render-check] 图片策略（比 pi 更严：只允许 data:image/）");
    const remoteImage = render.renderMarkdown("![alt](https://example.com/a.png)");
    check("远程图片降级为纯文本（不生成 <img>）", !/<img/i.test(remoteImage), remoteImage);
    check("远程图片保留了 alt 文本", remoteImage.includes("alt"), remoteImage);
    const dataImage = render.renderMarkdown("![alt](data:image/png;base64,iVBORw0KGgo=)");
    check("data:image 正常渲染", /<img src="data:image\/png;base64,/.test(dataImage), dataImage);
    const htmlImage = render.renderMarkdown("![alt](data:text/html;base64,PHNjcmlwdD4=)");
    check("data:text/html 不当图片渲染", !/<img/i.test(htmlImage), htmlImage);

    console.log("[render-check] 转义与其它");
    check("renderPlain 转义全部五个字符",
      render.renderPlain(`<>&"'`) === "&lt;&gt;&amp;&quot;&#39;", render.renderPlain(`<>&"'`));
    const toolLine = render.renderToolLine({
      kind: "tool",
      id: "tool-x",
      toolCallId: "x",
      toolName: "<b>bash</b>",
      summary: "echo <script>",
      isError: false,
    });
    check("工具行转义名字与参数", audit(toolLine) === null && toolLine.includes("&lt;b&gt;"), toolLine);
    const notice = render.renderNotice({ kind: "notice", id: "notice-1", level: "warn", text: "<img src=x>" });
    check("提示行转义内容", audit(notice) === null && notice.includes("&lt;img"), notice);
    const assistant = render.renderAssistant({
      kind: "assistant",
      id: "msg-1",
      text: "<script>alert(1)</script>",
      thinking: "",
      stopReason: "stop",
    });
    check("助手正文走同一套消毒", audit(assistant) === null, assistant);
    // toolUse 轮次本来就没有正文，不能报"没有内容"（实测误导过一次）
    const toolUseTurn = render.renderAssistant({
      kind: "assistant",
      id: "msg-t",
      text: "",
      thinking: "",
      stopReason: "toolUse",
    });
    check("工具调用轮次不显示「没有内容」提示", toolUseTurn === "", JSON.stringify(toolUseTurn));
    const emptyAssistant = render.renderAssistant({
      kind: "assistant",
      id: "msg-2",
      text: "",
      thinking: "",
      stopReason: "aborted",
    });
    check("中止的空回复有占位文字（不留空壳）", emptyAssistant.includes("已被中止"), emptyAssistant);

    // 面板 HTML 与 CSP：CSP 写错不会报错，只会让样式/脚本静默失效。
    console.log("[render-check] 面板 CSP");
    const fakeSource = "vscode-webview://test";
    const csp = htmlModule.contentSecurityPolicy(fakeSource, "NONCE123");
    check("default-src 'none'（默认全禁）", csp.includes("default-src 'none'"), csp);
    check("放行 style-src（少了它面板没有样式）", csp.includes(`style-src ${fakeSource}`), csp);
    check("放行 script-src 且只认 nonce", csp.includes("script-src 'nonce-NONCE123'"), csp);
    check("放行 img-src 且含 data:", csp.includes(`img-src ${fakeSource} data:`), csp);
    check("没有 unsafe-inline / unsafe-eval",
      !/unsafe-inline|unsafe-eval/.test(csp), csp);
    check("禁掉 connect-src（面板不需要出网）", csp.includes("connect-src 'none'"), csp);
    const pageHtml = htmlModule.buildWebviewHtml({
      scriptUri: "vscode-webview://test/dist/webview.js",
      styleUri: "vscode-webview://test/dist/style.css",
      cspSource: fakeSource,
      nonce: "NONCE123",
    });
    check("脚本标签带 nonce", /<script nonce="NONCE123"/.test(pageHtml), pageHtml.slice(0, 200));
    check("样式表用本地 URI", pageHtml.includes('href="vscode-webview://test/dist/style.css"'));
    // 注意：这里不能直接用 audit()——页面里的 <link>/<meta> 是合法的，
    // 要检查的是"脚本是否都带 nonce"与"有没有事件属性"。
    check("每个 script 标签都带 nonce",
      [...pageHtml.matchAll(/<script[^>]*>/g)].every((match) => match[0].includes('nonce="NONCE123"')),
      JSON.stringify([...pageHtml.matchAll(/<script[^>]*>/g)].map((m) => m[0])));
    check("页面里没有内联事件属性",
      ![...pageHtml.matchAll(/<[^>]*>/g)].some((match) => /\son\w+\s*=/.test(match[0])));
    check("nonce 是随机的两次不同",
      htmlModule.createNonce() !== htmlModule.createNonce());

    // 渲染层与外部打开层必须同源（N8：不能断言"常量等于它自己"，要断言行为一致）
    console.log("[render-check] 与 urlPolicy 的一致性");
    if (urlPolicy === undefined) {
      check("urlPolicy 可加载", false, "无法导入 urlPolicy");
    } else {
      for (const url of ["https://example.com", "tel:123", "ftp://example.com", "javascript:alert(1)"]) {
        const rendered = render.renderMarkdown(`[x](${url})`);
        const clickable = /<a\s/.test(rendered);
        const allowed = urlPolicy.isExternalUrlAllowed(url);
        check(`渲染与 openExternal 对 ${url} 判定一致（可点=${allowed}）`, clickable === allowed,
          `rendered=${rendered}`);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`RENDER-CHECK FAILED (${checks - failures}/${checks} passed)`);
    failed = 1;
  } else {
    console.log(`RENDER-CHECK OK (${checks} checks)`);
  }
  return failed;
}

process.exit(await main().catch((error) => {
  console.error(`RENDER-CHECK ERROR ${error?.stack ?? error}`);
  return 1;
}));
