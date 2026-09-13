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
    // **先把属性值整段删掉再查**：值里的引号已经被 escapeHtml 转成 `&quot;`，
    // 所以 `="[^"]*"` 能准确圈出属性值，而值里的内容（比如 `data-open-path` 存的
    // 一个含 `"` 的路径）不可能是真的事件属性。不这么做的话，
    // `data-open-path="/w/x&quot; onmouseover=&quot;alert(1)"` 会被误报成注入
    // —— 它其实是一个安全的属性值（浏览器解析到的 onmouseover 在引号里）。
    // 事件属性检查要忽略属性值，URL 检查**必须**看属性值（就藏在值里）——
    // 两个检查用的形态不同，别合并。
    const withoutValues = tag.replace(/="[^"]*"/g, "=");
    if (BAD_ATTR.test(withoutValues)) return `标签带事件属性: ${tag}`;
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
      // 「检查检查本身」：上面刚把 audit 放宽（先删属性值再查），
      // 所以必须自证它还认得真正的注入 —— 否则这次放宽等于把安全检查关掉了。
      check("audit 抓得住真实的 script 标签", audit("<div><script>alert(1)</script></div>") !== null);
      check("audit 抓得住真实的事件属性", audit('<img src="x" onerror="alert(1)">') !== null);
      check("audit 抓得住真实的危险 URL", audit('<a href="javascript:alert(1)">x</a>') !== null);
      check("audit 抓得住未加引号的事件属性", audit("<img src=x onerror=alert(1)>") !== null);
      check("audit 不误报：转义后的引号留在属性值内", audit('<a data-x="/w/x&quot; onmouseover=&quot;alert(1)">y</a>') === null);

      // ------------------------------------------------ S3：工具卡片
      //
      // 工具卡片的正文是**最容易漏掉转义**的地方：它是唯一"内容由命令输出决定"的区域，
      // 而且 S3 之后它会随着流式输出每 200ms 重绘一次。
      const LONG = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 行`).join("\n");
      const toolItem = (extra) => ({
        kind: "tool",
        id: "tool-1",
        toolCallId: "c1",
        toolName: "bash",
        summary: '{"command":"echo hi"}',
        isError: false,
        ...extra,
      });

      // 折叠/展开的内容规则（照 pi：bash 折叠给最后 5 行）
      const collapsed = render.renderToolCard(toolItem({ text: LONG }), false);
      const expanded = render.renderToolCard(toolItem({ text: LONG }), true);
      check("bash 折叠时只渲染最后 5 行", collapsed.includes("第 5 行") && !collapsed.includes("第 4 行"), collapsed.slice(0, 120));
      check("bash 折叠态的 HTML 里不含被折叠掉的内容", !collapsed.includes("第 1 行"));
      check("展开时渲染全部内容", expanded.includes("第 1 行") && expanded.includes("第 9 行"));
      check("展开态带 aria-expanded=true", expanded.includes('aria-expanded="true"'));
      check("折叠态带 aria-expanded=false", collapsed.includes('aria-expanded="false"'));

      const readCollapsed = render.renderToolCard(toolItem({ toolName: "read", text: LONG }), false);
      check("read 折叠时不显示正文", !readCollapsed.includes("第 1 行") && readCollapsed.includes("tool-body"));
      check("read 展开时显示正文", render.renderToolCard(toolItem({ toolName: "read", text: LONG }), true).includes("第 9 行"));

      const empty = render.renderToolCard(toolItem({ text: undefined }), true);
      check("空正文给占位（无输出）", empty.includes("（无输出）"), empty.slice(0, 120));
      const waiting = render.renderToolCard(toolItem({ pending: true }), true);
      check("进行中的空正文给占位（等待输出…）", waiting.includes("（等待输出…）"));

      // 正文里的 HTML/脚本必须被转义（这是"命令输出可控"的那条路径）
      for (const evil of [
        '<img src=x onerror="alert(1)">',
        "</pre><script>alert(1)</script>",
        '<iframe src="javascript:alert(1)"></iframe>',
        '<a href="javascript:alert(1)">x</a>',
      ]) {
        const html = render.renderToolCard(toolItem({ text: evil }), true);
        check(`工具正文转义 ${JSON.stringify(evil).slice(0, 40)}`, audit(html) === null, String(audit(html)));
        check(`工具正文里的 ${JSON.stringify(evil).slice(0, 24)} 不生成真实标签`, !html.includes("<img") && !html.includes("<iframe") && !html.includes("<script"));
      }

      // 工具名与参数摘要也是模型可控的
      const evilHead = render.renderToolCard({ ...toolItem({ text: "x" }), toolName: "<script>a</script>", summary: '"><img src=x onerror=alert(1)>' }, true);
      check("工具名与参数摘要被转义", audit(evilHead) === null && !evilHead.includes("<script"), String(audit(evilHead)));

      // 路径：只有登记过的才渲染成可点的 `<a>`
      const pathItem = toolItem({ text: "ok", openablePaths: ["/work/a.ts"] });
      const linked = render.renderPathLink("~/a.ts", "/work/a.ts", pathItem);
      check("登记过的路径渲染成可点元素",
        linked.includes("<a ") && linked.includes('data-open-path="/work/a.ts"') && linked.includes("~/a.ts"), linked);
      const unregistered = render.renderPathLink("/etc/passwd", "/etc/passwd", pathItem);
      check("未登记的路径只是文字（不可点）", !unregistered.includes("<a "), unregistered);
      const evilPath = render.renderPathLink('/w/x" onmouseover="alert(1)', '/w/x" onmouseover="alert(1)', toolItem({ text: "ok", openablePaths: ['/w/x" onmouseover="alert(1)'] }));
      check("路径里的引号被转义（不会造出事件属性）", audit(evilPath) === null, String(audit(evilPath)));

      // 标题（照 pi 的 call 行）：path 形态、可点、以及"两处拼装必须同一份"这条铁律
      const titled = toolItem({
        toolName: "read",
        title: { text: "~/a.ts:10-20", link: { text: "~/a.ts", path: "/work/a.ts" } },
        openablePaths: ["/work/a.ts"],
      });
      const titleHtml = render.renderToolHeadLine(titled, false);
      check("标题渲染成短路径 + 行号范围", titleHtml.includes("~/a.ts") && titleHtml.includes(":10-20"), titleHtml);
      check("标题里的路径是可点的（data-open-path 用绝对路径）",
        titleHtml.includes('data-open-path="/work/a.ts"'), titleHtml);
      check("标题里带展开箭头（未展开是 ▸）", titleHtml.includes("▸"));
      check("展开后箭头变成 ▾", render.renderToolHeadLine(titled, true).includes("▾"));
      check("没有 title 时回退到 JSON 参数摘要",
        render.renderToolHeadLine(toolItem({ text: "x" }), false).includes("{&quot;command&quot;"),
        render.renderToolHeadLine(toolItem({ text: "x" }), false));
      // **铁律**：卡片整体拼装出来的按钮内容必须与 main.ts 用的是同一份
      const cardHtml = render.renderToolCard(titled, true);
      check("renderToolCard 的按钮内容 === renderToolHeadLine 的输出",
        cardHtml.includes(render.renderToolHeadLine(titled, true)), cardHtml.slice(0, 200));
      // 标题里的命令是模型可控的
      const evilTitle = render.renderToolHeadLine(
        toolItem({ title: { text: '<img src=x onerror="alert(1)">' } }), false);
      check("标题文本被转义", audit(evilTitle) === null && !evilTitle.includes("<img"), evilTitle);

      // 耗时：进行中用 Elapsed、结束用 Took；没有 startedAt 就不显示
      const running = render.renderToolHead(toolItem({ pending: true, startedAt: 1000 }));
      const done = render.renderToolHead(toolItem({ startedAt: 1000, endedAt: 3400 }));
      check("进行中的耗时是 Elapsed", running.includes("Elapsed"), running);
      check("结束后的耗时是 Took", done.includes("Took 2.4s"), done);
      check("没有 startedAt 时不显示耗时", !render.renderToolHead(toolItem({})).includes("Took"));

      // pi 的截断摘要与完整输出路径
      const truncated = render.renderToolCard(
        toolItem({ text: "tail", truncation: { truncatedBy: "bytes", totalLines: 4000, outputLines: 100 }, fullOutputPath: "/tmp/pi-x.log", openablePaths: ["/tmp/pi-x.log"] }),
        true,
      );
      check("截断摘要被渲染", truncated.includes("已截断"), truncated.slice(0, 200));
      check("完整输出路径被渲染成可点链接", truncated.includes('data-open-path="/tmp/pi-x.log"'), truncated.slice(0, 300));

      // 我们自己的裁剪：文案与 pi 的脚注不同（来源不同，长得一样会让人以为 pi 又裁了一次）
      const clipped = render.renderToolCard(toolItem({ text: "abc", textTruncated: true }), true);
      check("我们自己的裁剪有独立文案", clipped.includes("开头已省略") && !clipped.includes("已截断"), clipped.slice(0, 200));

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
