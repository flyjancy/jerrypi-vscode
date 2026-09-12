// jerrypi bundler — 目前只打包扩展宿主侧入口（webview 入口留到 S2）。
//
// 两件事必须守住：
//   1. banner 里的 createRequire（否则打进 CJS 互操作代码后运行时报
//      `Dynamic require of "node:assert" is not supported`）；
//   2. **禁止静态 import pi** —— 由 onResolve 守卫在执行期拦下，另有体积上限兜底。
import { statSync } from "node:fs";
import { build } from "esbuild";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const OUTFILE = "dist/extension.js";
/** 体积上限：正常约 2 KB；pi bundle 是 7.6 MB，一旦误打进产物会立刻超限。 */
const MAX_EXTENSION_BYTES = 256 * 1024;

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
  outfile: OUTFILE,
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

const { size } = statSync(OUTFILE);
if (size > MAX_EXTENSION_BYTES) {
  console.error(
    `[esbuild] FAIL ${OUTFILE} 体积 ${(size / 1024).toFixed(1)} KB 超过上限 ` +
      `${(MAX_EXTENSION_BYTES / 1024).toFixed(0)} KB —— 大概率是把 pi bundle 打进产物了`,
  );
  process.exit(1);
}
console.log(`[esbuild] ${OUTFILE} ${(size / 1024).toFixed(2)} KB（上限 ${MAX_EXTENSION_BYTES / 1024} KB）`);
