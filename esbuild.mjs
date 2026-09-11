// jerrypi bundler — 目前只打包扩展宿主侧入口（webview 入口留到 S2）。
//
// 关于 banner：esbuild 把 ESM 输出为 CJS 互操作时会注入 `require` 调用，
// 而 ESM 输出里没有 `require` 绑定，运行时会报
//   Dynamic require of "node:assert" is not supported
// 因此必须显式补上 createRequire。S2 起 bundle 里会引入 undici 这类 CJS 依赖，
// 少了这一行会在运行时炸。
import { build } from "esbuild";

const banner = [
  'import { createRequire } from "module";',
  "const require = createRequire(import.meta.url);",
].join("\n");

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["vscode"],
  outfile: "dist/extension.js",
  sourcemap: true,
  banner: { js: banner },
  logLevel: "info",
});
