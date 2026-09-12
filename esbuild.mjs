// jerrypi bundler —— 三个产物：
//   dist/extension.js   扩展宿主（node / esm / external: vscode）
//   dist/webview.js     面板前端（browser / iife，含 marked）
//   dist/style.css      面板样式
//
// 三件事必须守住：
//   1. banner 里的 createRequire（否则打进 CJS 互操作代码后运行时报
//      `Dynamic require of "node:assert" is not supported`）；
//   2. **禁止静态 import pi** —— 由 onResolve 守卫在执行期拦下，另有体积上限兜底；
//   3. webview 产物**不得**引用 node 内置模块或 `vscode`（它是浏览器环境）。
import { readFileSync, statSync } from "node:fs";
import { build } from "esbuild";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const EXTENSION_OUTFILE = "dist/extension.js";
const WEBVIEW_OUTFILE = "dist/webview.js";
const STYLE_OUTFILE = "dist/style.css";
/** 体积上限：正常约 20 KB；pi bundle 是 7.6 MB，一旦误打进产物会立刻超限。 */
const MAX_EXTENSION_BYTES = 256 * 1024;
/** webview 产物上限：marked（约 45 KB）+ 自己的代码，正常远低于此。 */
const MAX_WEBVIEW_BYTES = 512 * 1024;

const banner = [
  'import { createRequire } from "module";',
  "const require = createRequire(import.meta.url);",
].join("\n");

/** 扩展宿主侧。 */
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["vscode"],
  outfile: EXTENSION_OUTFILE,
  sourcemap: true,
  banner: { js: banner },
  logLevel: "info",
  plugins: [
    {
      name: "forbid-static-pi-import",
      setup(pluginBuild) {
        // 只匹配**值导入**：`import type` 会被 esbuild 直接擦除，不会走到这里。
        pluginBuild.onResolve({ filter: /^@earendil-works\/pi-coding-agent(\/|$)/ }, (args) => ({
          errors: [
            {
              text:
                `禁止静态 import "${args.path}"。` +
                "请改用 `import type` 取类型，运行期一律经 src/pi/loader.ts 的动态 import()。",
            },
          ],
        }));
      },
    },
  ],
});

/** 面板前端（浏览器环境）。 */
await build({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: WEBVIEW_OUTFILE,
  minify: true,
  sourcemap: true,
  logLevel: "info",
  // webview 里没有 node，误用会得到一个难查的运行时错误；在打包期直接拦下。
  external: [],
  plugins: [
    {
      name: "forbid-node-and-vscode",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^(node:|vscode$)/ }, (args) => ({
          errors: [{ text: `webview 产物不能引用 "${args.path}"（浏览器环境没有它）` }],
        }));
      },
    },
  ],
});

/** 样式：单独一个入口，产物直接进 .vsix。 */
await build({
  entryPoints: ["src/webview/style.css"],
  bundle: true,
  outfile: STYLE_OUTFILE,
  logLevel: "info",
});

function report(file, limit) {
  const { size } = statSync(file);
  if (size > limit) {
    console.error(
      `[esbuild] FAIL ${file} 体积 ${(size / 1024).toFixed(1)} KB 超过上限 ` +
        `${(limit / 1024).toFixed(0)} KB`,
    );
    process.exit(1);
  }
  console.log(`[esbuild] ${file} ${(size / 1024).toFixed(2)} KB（上限 ${limit / 1024} KB）`);
}

report(EXTENSION_OUTFILE, MAX_EXTENSION_BYTES);
report(WEBVIEW_OUTFILE, MAX_WEBVIEW_BYTES);

// 三个产物都必须存在且非空：断言"产物里没有某个字符串"很脆（注释里出现就误报），
// 而"文件在不在、有没有内容"才是真正关心的东西。
for (const file of [EXTENSION_OUTFILE, WEBVIEW_OUTFILE, STYLE_OUTFILE]) {
  const { size } = statSync(file);
  if (size === 0) {
    console.error(`[esbuild] FAIL ${file} 是空文件`);
    process.exit(1);
  }
}
const webview = readFileSync(WEBVIEW_OUTFILE, "utf8");
if (/require\(\s*["']vscode["']\s*\)/.test(webview)) {
  console.error("[esbuild] FAIL webview 产物里出现了 require(\"vscode\")");
  process.exit(1);
}
console.log(`[esbuild] 三个产物就绪：${EXTENSION_OUTFILE} / ${WEBVIEW_OUTFILE} / ${STYLE_OUTFILE}`);
