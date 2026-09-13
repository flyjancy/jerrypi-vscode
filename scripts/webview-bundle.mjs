// webview 前端产物的**唯一**构建配置。
//
// 为什么单独一个文件：生产产物（`esbuild.mjs`）与无头 DOM 测试台
// （`scripts/webview-dom-check.mjs`）必须用**完全相同**的配置。两份各写一遍的
// 后果不是崩溃，而是慢慢漂成两个东西 —— 测试台测的是配置 A 产出的代码、
// 用户跑的是配置 B，而我们引入测试台的全部意义就是"它代表真产物"。
// （这条是 S3 计划评审第 2 轮第 3 条。）改动本文件即同时改动两边。
import { build } from "esbuild";

export const WEBVIEW_ENTRY = "src/webview/main.ts";
export const WEBVIEW_OUTFILE = "dist/webview.js";

/** webview 产物上限：marked（约 45 KB）+ 自己的代码，正常远低于此。 */
export const MAX_WEBVIEW_BYTES = 512 * 1024;

/**
 * 禁止 webview 产物引用 node 内置模块与 `vscode`。
 *
 * webview 是浏览器环境，误用它们会得到一个**难查的运行时错误**；在打包期直接拦下，
 * 报错信息里带上原始路径。
 */
export const forbidNodeAndVscode = {
  name: "forbid-node-and-vscode",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(node:|vscode$)/ }, (args) => ({
      errors: [{ text: `webview 产物不能引用 "${args.path}"（浏览器环境没有它）` }],
    }));
  },
};

/** 生产与测试台共用的打包参数。 */
export function webviewBuildOptions(options = {}) {
  const {
    entry = WEBVIEW_ENTRY,
    outfile,
    minify = true,
    sourcemap = true,
    logLevel = "info",
  } = options;
  return {
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    outfile,
    minify,
    sourcemap,
    logLevel,
    external: [],
    plugins: [forbidNodeAndVscode],
  };
}

/** 供测试台使用：不写 dist/、不压缩、不打 sourcemap、安静。 */
export async function buildWebviewForTest(outfile) {
  await build(
    webviewBuildOptions({ outfile, minify: false, sourcemap: false, logLevel: "silent" }),
  );
}
