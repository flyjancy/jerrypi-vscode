// 打包期必须存在的资源清单（相对 pi-runtime/）。
//
// 为什么要在扩展里重复一份：`scripts/` 不进 `.vsix`，所以打包后的扩展没法运行 S0 的
// `verify-isolated-runtime.mjs`，自测 T2 必须自查。
// 这份清单与 `scripts/sync-pi-runtime.mjs` 的 REQUIRED_FILES / REQUIRED_DIRS 的一致性，
// 由 `scripts/self-test.mjs` 的用例 5 守护（分别比对文件与目录）。
//
// 注意：解析这份清单的脚本依赖「字符串字面量数组」这个形状，改结构要同步改用例 5。

export const REQUIRED_RESOURCE_FILES = [
  "package.json",
  "README.md",
  "dist/bundle/index.js",
  "dist/bundle/cli.js",
  "dist/bundle/rpc-entry.js",
  "dist/bundle/chunks/image-resize-worker.js",
  "dist/modes/interactive/theme/dark.json",
  "dist/modes/interactive/theme/light.json",
  "dist/core/export-html/template.html",
  "node_modules/@earendil-works/chord/dist/context/index.js",
  "node_modules/jiti/package.json",
  "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
] as const;

export const REQUIRED_RESOURCE_DIRS = ["docs", "examples"] as const;
