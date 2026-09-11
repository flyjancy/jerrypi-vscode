# S0 实施计划：脚手架与发布链路

> 状态：**已吸收 Codex(gpt-6-astra) 四轮评审**（2026-09-11）。第四轮结论：**无新增阻断项，可进入实施**。
> 依据：[`PLAN.md`](PLAN.md) 第 6 节 S0、5.4 打包规则。本文件是 S0 的落地细化。

## 0. 评审吸收记录

### 0.1 第一轮（结论 `APPROVE-WITH-CHANGES`）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 阻断 | A7/B2 缺可执行证据 | 固定 `verify-isolated-runtime.mjs` CLI 契约，并给出 A7 可复制命令（§4.2、§6） |
| 2 | 阻断 | 7 条校验与脚本职责边界不清 | 新增 §4 职责表 + 退出码 / 失败传播 / 临时目录清理契约 |
| 3 | 重要 | 版本固定策略不一致 | §3 依赖全部改**精确版本**（版本号已实测确认） |
| 4 | 重要 | `test-fixtures/**` 进包需确认 | §5.4 明确"**故意进包**"及理由与体积 |
| 5 | 重要 | `activate()` 缺失处理未定义 | §5.3 定义：不阻断启动，命令触发时校验并报错 |
| 6 | 一般 | `private: true` 取舍 | 实测 vsce 3.9.2 通过 → **采用** |
| 7 | 一般 | 缺最小自检 | 新增 `npm run self-test`（§4.4） |

### 0.2 第二轮（结论仍为 `APPROVE-WITH-CHANGES`）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 阻断 | `npm run package` 未含前置构建 | **唯一入口定为 `vscode:prepublish`**：vsce 打包前自动执行它，因此 `npm run package`、裸 `npx vsce package`、CI、发布走同一条构建路径；并新增 **A5b 干净构建**（§3、§6） |
| 2 | 阻断 | `vscode:prepublish` 与 `package` 责任重复 | 同上：`package` 保持薄，构建只在 `vscode:prepublish`（= `npm run compile`）一处定义；§3 明确"禁止绕过" |
| 3 | 重要 | pi 版本无单一来源 | **单一来源 = `package.json` 的精确钉版**；sync 比对已解析 pi 的 `version` 后写入 `.version`，所有断言只与 `.version` 比较（§5.2） |
| 4 | 重要 | 复制清单可能漏资源 | **版本化白名单（硬门禁）** + **相对资源引用扫描（advisory）**（§5.2） |
| 5 | 重要 | 裸依赖扫描有误报/漏报 | 明确**证据层级**：① 快速门禁；完整性最终依据是 ② + ⑦（§1.2、§5.2） |
| 6 | 重要 | 平台差异未写入验收 | §6 标注 **A1–A7 仅覆盖 macOS 包生成与隔离校验**，Windows 为未覆盖项（B3） |
| 7 | 一般 | 生成物清理未定义 | sync **先删 `pi-runtime/` 再复制**，失败删半成品；verify 临时目录 `finally` 清理（§4.3） |

### 0.3 第三轮（结论 `APPROVE-WITH-CHANGES`，"未发现新的架构级阻断"）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 重要 | `npm run sync` 幂等性需明确 | §4.3：**同步语义 = 删除后重建**，不做增量复制；旧结构/降级残留不可能存活 |
| 2 | 重要 | 失败清理策略缺失 | §4.3：任一失败（含 `SIGINT`）删除半成品 `pi-runtime/` 与临时目录，杜绝"下次复用不完整结果" |
| 3 | 重要 | 资源校验须覆盖链接目标内容 | §5.2 ④⑤：`lstat` 断言目标为普通文件/目录、可读、**非空**，杜绝悬挂链接/空目录通过 |
| 4 | 一般 | 版本升级流程未定义 | 新增 **§9 pi 升级流程**；预期版本来源在第四轮统一为单一来源（见 §0.4） |
| 5 | 一般 | CI 缺"干净工作区"约束 | §7：CI 不缓存 `pi-runtime/`、`dist/`、`*.vsix`，含一次清空后构建（A5b） |
| 6 | 一般 | 包体积门禁未落到脚本 | 新增 `scripts/check-vsix.mjs` 与 **A6b**：`.vsix` 必须 `0 < size < 30 MB`，超限失败 |
| 7 | 低 | `activate()` 行为不够确定 | §5.3：固定为**唯一**最小行为（成功 → information；缺失 → error），B1 增加手工验收记录 |

### 0.4 第四轮（结论：**无新增阻断项，可进入实施**；"静态评审收益已很低，剩余风险由实跑暴露"）

| # | 级别 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 重要 | 验收命令需统一 | **已满足**：本地验收 / CI / 发布统一走 `npm run package`（A5b/A6/A7）；文中 `npx vsce package` 仅作"vsce 会自动执行 `vscode:prepublish`"的说明性文字 |
| 2 | 重要 | 版本不能只靠硬编码 | **撤掉 `SUPPORTED_PI_VERSIONS`**：预期版本唯一来源 = `package.json` 精确钉版；脚本读实际版本与之**只比较一次**（§5.2、§9）。此项与第三轮 4 的"脚本顶部集中声明"冲突，按"单一来源"原则取第四轮方案 |
| 3 | 重要 | 半成品不可复用 | **已满足**（§4.3：删除后重建 + 失败清理 + 信号清理） |
| 4 | 一般 | 体积门禁未落地 | **已满足**（A6b + `scripts/check-vsix.mjs`） |
| 5 | 一般 | fixture 是否随包发布需明确 | **已决定进包**（§5.4），并把用途写入 README 与验收标准 |

### 0.5 实施前实测结论（本机 vsce 3.9.2）

- `private: true` 不影响打包，无错误无警告。
- vsce **拒绝** `@types/vscode` 高于 `engines.vscode`：
  `ERROR @types/vscode 1.125.0 greater than engines.vscode ^1.123.0`。
- npm 上 `@types/vscode` 已发布：`1.120.0 / 1.125.0 / 1.134.0 / 1.136.0 / 1.137.0`（**无 `1.123.0`**）。
  → 保持 `engines.vscode ^1.123.0` 时只能钉 `@types/vscode 1.120.0`（≤ 引擎下限，类型是子集，安全）。
  若日后 npm 上出现 `1.123.x`，优先改用它。

## 1. 目标与范围

### 1.1 目标

让仓库从"只有文档"变成"能 `npm install` → 生成 pi 运行时 → 打包出可安装的 `.vsix`"，
并跑通 `PLAN.md` 5.4 的全部机械校验。

### 1.2 证据层级（评审第二轮 5）

- **快速门禁**：① 裸依赖扫描（朴素正则，可能漏报字符串拼接 / 模板串 / `require3` 重命名 / 跨行）。
- **权威证据**：② 隔离 import + ⑦ 真实扩展加载 + ④ 图片 worker 文件存在性。
  依赖完整性以权威证据为准，① 只用于尽早失败。

### 1.3 明确非目标

- 不实现 `loader.ts` / `session.ts` / `bindings.ts`，不动态 import pi（S1）；
- 不做 Webview UI、不建侧边栏视图（S2）；
- 不实现任何 pi 功能，`activate()` 只注册一个命令。

## 2. 文件清单

```
package.json                         # 元数据 + scripts + contributes.commands
package-lock.json                    # 锁定依赖（npm）
tsconfig.json                        # 仅类型检查（noEmit）
esbuild.mjs                          # 打包 extension（本步不含 webview 入口）
scripts/sync-pi-runtime.mjs          # 清理+复制 pi 运行时；执行 ①③④⑤⑥；编排 verify
scripts/verify-isolated-runtime.mjs  # 隔离环境中执行 ②⑦（独立 CLI，见 §4.2）
scripts/self-test.mjs                # 最小自检：正/负用例（见 §4.4）
scripts/check-vsix.mjs               # .vsix 体积门禁：0 < size < 30 MB（见 §4.5）
.vscodeignore                        # 打包排除/包含规则
src/extension.ts                     # 空 activate()，注册 Pi: Focus Chat
test-fixtures/ext-smoke/index.ts     # 最小 pi TS 扩展，供校验 ⑦
```

`pi-runtime/`、`dist/`、`*.vsix` 均为生成物，`.gitignore` 已忽略。

## 3. package.json 草案（依赖全部精确版本）

```jsonc
{
  "name": "jerrypi",
  "displayName": "jerrypi",
  "description": "Drive the Pi coding agent from a VS Code sidebar chat panel — no local Node.js required",
  "version": "0.1.0",
  "publisher": "flyjancy",
  "private": true,
  "license": "MIT",
  "type": "module",
  "engines": { "vscode": "^1.123.0" },
  "categories": ["AI", "Other"],
  "keywords": ["pi", "coding-agent", "ai", "chat", "agent"],
  "main": "./dist/extension.js",
  "repository": { "type": "git", "url": "https://github.com/flyjancy/jerrypi-vscode.git" },
  "homepage": "https://github.com/flyjancy/jerrypi-vscode#readme",
  "bugs": { "url": "https://github.com/flyjancy/jerrypi-vscode/issues" },
  "contributes": {
    "commands": [
      { "command": "jerrypi.focusChat", "title": "Pi: Focus Chat", "category": "Pi" }
    ]
  },
  "scripts": {
    "sync": "node scripts/sync-pi-runtime.mjs",
    "self-test": "node scripts/self-test.mjs",
    "build": "node esbuild.mjs",
    "typecheck": "tsc --noEmit",
    "compile": "npm run sync && npm run build",
    "vscode:prepublish": "npm run compile",
    "package": "vsce package --pre-release --follow-symlinks --no-dependencies",
    "check-vsix": "node scripts/check-vsix.mjs"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.85.1",
    "@types/node": "24.13.4",
    "@types/vscode": "1.120.0",
    "@vscode/vsce": "3.9.2",
    "esbuild": "0.28.2",
    "typescript": "5.9.3"
  }
}
```

要点：

- **唯一构建入口 = `vscode:prepublish`（第二轮 1、2）**。vsce 在打包前**自动**执行该脚本，
  所以 `npm run package`、裸 `npx vsce package`、CI、发布都先 `sync + build`，不存在"未构建就打包"。
  `package` 保持薄；**禁止**用其他方式绕过。该保证由 **A5b 干净构建**实测。
- **`contributes.commands` 必需**：否则 vsce 因有 `main` 而无 `activationEvents`/`contributes` 直接拒绝打包（实测）。
- **无 runtime `dependencies`**：pi 通过 `pi-runtime/` 动态 import；本步不引入 undici/marked（S2 再加）。
- **`private: true`**：实测 vsce 3.9.2 接受；用于防止误发 npm。
- **pi 精确钉版 `0.85.1` 是 pi 版本唯一来源**（第二轮 3），见 §5.2。
- **`@types/vscode` 钉 `1.120.0`**：见 §0.4；不得高于 `engines.vscode`。

## 4. 脚本职责与接口契约

### 4.1 职责划分（第一轮 2）

| 校验 | 实现位置 | 执行者 | 说明 |
| --- | --- | --- | --- |
| ① 裸依赖扫描 | `sync-pi-runtime.mjs`（导出 `scanBareImports`） | sync | 扫 `pi-runtime/dist/bundle/**/*.js`；**快速门禁** |
| ② 隔离 import | `verify-isolated-runtime.mjs` | sync 通过子进程调用 | 临时目录里跑；**权威证据** |
| ③ 无 `.node` | `sync-pi-runtime.mjs` | sync | |
| ④ 资源路径存在且为普通文件/目录 | `sync-pi-runtime.mjs` | sync | 含 `bundle/chunks/image-resize-worker.js` |
| ⑤ 无 `src/`、无符号链接 | `sync-pi-runtime.mjs` | sync | |
| ⑥ 写 `pi-runtime/.version` | `sync-pi-runtime.mjs` | sync | 内容 = 已解析的 pi 版本 |
| ⑦ 隔离加载扩展 | `verify-isolated-runtime.mjs` | sync 通过子进程调用 | 临时目录里跑；**权威证据** |

`npm run sync` 是**唯一入口**，负责清理 + 复制 + ①③④⑤⑥ + 编排 ②⑦；②⑦ 的实现只在
`verify-isolated-runtime.mjs`，避免"本地通过、VSIX 解包复跑失败"。

### 4.2 `verify-isolated-runtime.mjs` CLI 契约（第一轮 1）

```
node scripts/verify-isolated-runtime.mjs --pi-runtime <dir> [--fixture <index.ts>] [--expect-version <v>] [--keep-temp]
```

- `--pi-runtime <dir>`：**必填**。一个 pi-runtime 目录，可来自仓库 `pi-runtime/`，
  或解包 `.vsix` 后的 `extension/pi-runtime/`。
- `--fixture <index.ts>`：可选。默认 `<dirname(dir)>/test-fixtures/ext-smoke/index.ts`
  （仓库布局与解包布局都成立）。默认路径不存在时，⑦ 判 FAIL。
- `--expect-version <v>`：可选。默认读取 `<dir>/.version`（由 sync 写入，§5.2 单一来源）。
- `--keep-temp`：保留临时目录用于排查。
- **只允许使用 `node:` 内置模块与目标目录内的 bundle**；严禁 import 仓库根 `node_modules`
  或任何 npm 包。bundle 一律用临时副本的绝对 `file://` URL 动态 import。
- 输出逐行 `CHECK <id> PASS|FAIL <detail>`，末行 `VERIFY OK` 或 `VERIFY FAILED`。
- 退出码：`0` 全过；`1` 有检查失败；`2` 用法错误。
- 检查 ②：把 `<pi-runtime>` 复制进 `fs.mkdtempSync(join(os.tmpdir(), "jerrypi-verify-"))` 下的
  `pi-runtime/`（其上层无 `node_modules`），在临时目录内以 `node --input-type=module` import
  bundle，断言 `VERSION === <expect-version>` 且 `getPackageDir()` 以 `pi-runtime` 结尾。
- 检查 ⑦：同一临时目录 + 另一空 `agentDir`（`mkdtemp`），用 **bundle 导出的**
  `createAgentSessionServices` → `createAgentSessionFromServices` → `createAgentSessionRuntime`
  装配，`additionalExtensionPaths: [<fixture>]`，断言
  `runtime.services.resourceLoader.getExtensions().errors` 为空，且
  `extensionRunner.getRegisteredCommands()` 含 `smoke`。
  `agentDir` 为空是关键：用户目录里的扩展错误不会混入，⑦ 的失败只可能来自打包内容。

### 4.3 幂等性、失败传播与清理（第一轮 2、第二轮 7、第三轮 1、2）

- **幂等语义 = 删除后重建**：sync 首先 `fs.rmSync("pi-runtime", { recursive: true, force: true })`，
  再做全新复制；**不做增量复制**。因此 pi 降级、目录结构变化、上次失败残留都不可能存活。
- **失败清理**：复制或任一校验失败时，删除半成品 `pi-runtime/`，打印 `SYNC FAILED`，退出码 `1`；
  同时注册 `process.on("SIGINT"/"SIGTERM")` 清理后退出，避免中断留下不完整目录被下次运行复用。
- `sync-pi-runtime.mjs` 用 `execFileSync(process.execPath, [verifyScript, "--pi-runtime", absDir], { stdio: "inherit" })`
  调用 ②⑦；子进程非 0 时 `execFileSync` 抛错，sync 捕获后清理并 `process.exit(1)`。
- 校验 ①③④⑤ 任一失败：立即打印 `CHECK <id> FAIL`，不继续后续步骤，退出码 `1`。
- verify 的所有临时目录在 `try/finally` 中 `fs.rmSync(dir, { recursive: true, force: true })`；
  `--keep-temp` 时跳过删除并打印路径。
- 全部通过后 sync 退出码 `0`，且 `pi-runtime/.version` 已写入。

### 4.4 最小自检 `scripts/self-test.mjs`（第一轮 7）

纯 `node:assert` + 子进程，不引入测试框架：

1. **正用例**：跑完整 `sync-pi-runtime.mjs`，断言退出码 `0` 且 `pi-runtime/.version`
   内容等于 `package.json` 钉版（唯一来源）。
2. **负用例 · 裸依赖**：把一份含 `import"totally-unknown-pkg"` 的临时 `.js` 喂给导出的
   `scanBareImports()`，断言抛错（覆盖 ① 的"未知标识符即失败"）。
3. **负用例 · 缺依赖**：复制 `pi-runtime/` 到临时目录并删除 `node_modules/jiti/`，对该副本跑
   `verify-isolated-runtime.mjs`，断言**非零退出**（覆盖"缺依赖时非零退出"，⑦ 最能暴露它）。
4. **负用例 · 幂等**：在 `pi-runtime/` 里放一个多余的 `stale.js`，再跑一次 sync，断言该文件已消失
   （覆盖第三轮第 1 点的"删除后重建"）。

`npm run self-test` 失败即退出非零；CI 里与 `sync` 一起跑。

### 4.5 `scripts/check-vsix.mjs` 体积门禁（第三轮 6）

```
node scripts/check-vsix.mjs <path-to-vsix>
```

- 断言文件存在、`0 < size < 30 * 1024 * 1024`（`PLAN.md` 的 30 MB 门禁）。
- 打印体积（及占门禁的百分比）；超限或为 0 时退出码 `1`。
- 仅用 `node:fs`，无依赖。

## 5. 各文件要点

### 5.1 `esbuild.mjs`

- extension：`entryPoints: ["src/extension.ts"]`、`bundle: true`、`platform: "node"`、`format: "esm"`、
  `target: "node22"`、`external: ["vscode"]`、`outfile: "dist/extension.js"`、`sourcemap: true`。
- **必须加 banner**：

  ```
  import { createRequire } from "module"; const require = createRequire(import.meta.url);
  ```

  否则以后打进 undici 这类 CJS 依赖会运行时报 `Dynamic require of "node:assert" is not supported`。
- 本步不做 webview 入口（等 S2 有 `src/webview/main.ts` 再加）。

### 5.2 `scripts/sync-pi-runtime.mjs`

1. **版本单一来源（第二轮 3、第四轮 2）**：
   - `pinned = JSON.parse(read("package.json")).devDependencies["@earendil-works/pi-coding-agent"]`
     （精确版本，**唯一**预期版本来源）；
   - `piDir = dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json"))`；
   - `actual = JSON.parse(read(join(piDir, "package.json"))).version`；
   - **只做一次比较**：断言 `actual === pinned`，否则 `SYNC FAILED`；
   - 写入 `pi-runtime/.version = actual`；此后所有校验只与 `.version` 比较，**脚本与文档均不再重复声明版本**。
   - 第三轮 4 曾建议在脚本顶部加 `SUPPORTED_PI_VERSIONS`，因其与钉版形成重复来源，按第四轮 2 撤销。
   - 因依赖是精确钉版，升级 pi 必然是一次显式编辑；该断言即"升级强制复核"的硬门禁（配合 §9）。
2. **清理**：`fs.rmSync("pi-runtime", { recursive: true, force: true })` 后再复制（§4.3）。
3. 复制到 `pi-runtime/`：`dist/bundle/`、`package.json`、`dist/modes/interactive/theme/`、
   `dist/core/export-html/`、`docs/`、`examples/`、`README.md`。
4. 用 `createRequire(join(piDir, "package.json"))` 解析并整包复制到 `pi-runtime/node_modules/`：
   `@earendil-works/chord`（去 `map`/`src`）、`jiti`、`@silvia-odwyer/photon-node`（含 wasm）。
   **一律 `fs.cpSync(src, dest, { recursive: true, dereference: true })`**。
5. 校验 ①（导出 `scanBareImports` 供 self-test 复用）：
   正则（无空白）`from"X"`、`import"X"`、`import("X")`，以及"函数名含 `require` 的调用"
   `ident("X")`；`X` 形状 `^[A-Za-z@][A-Za-z0-9._@/-]*$`；`X` 必须 `isBuiltin(X)` 或命中三档白名单
   （**必须复制**：`@earendil-works/chord/context`、`jiti`、`@silvia-odwyer/photon-node`；
   **允许缺失**：`bufferutil`、`utf-8-validate`、`supports-color`、`@mariozechner/clipboard`；
   **仅字符串**：`@aws-sdk/signature-v4-crt`）。扫到未知标识符即失败。
   定位见 §1.2。
6. 校验 ③④⑤（第三轮 3 强化结构断言）：
   - ③ 整树无 `.node` 文件；
   - ④ 关键路径**存在 + 类型正确 + 可读 + 非空**：
     对每项 `lstatSync` 断言 `!isSymbolicLink()`；文件断言 `isFile() && size > 0`，
     目录断言 `isDirectory()` 且至少有一个子项；再 `fs.accessSync(p, fs.constants.R_OK)`。
     覆盖：theme `*.json`、`export-html/template.html`、`docs/`、`bundle/chunks/image-resize-worker.js`、
     `examples/`、`README.md`、`node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm`、
     `node_modules/@earendil-works/chord/dist/context/index.js`、`node_modules/jiti/package.json`；
   - ⑤ `pi-runtime/src` 不存在；`lstat` 遍历整树，任何 `isSymbolicLink()` 即失败
     （等价 `find -type l` 为空）。
7. **相对资源引用扫描（advisory，第二轮 4）**：从 bundle 提取
   `new URL("./x", import.meta.url)` / `readFileSync("./x")` / `createRequire(...)("./x")` 的
   **相对字面量**，解析到 `pi-runtime/` 后断言存在；不存在的项打印 `ADVISORY`（不失败），
   供升级时人工核对（硬门禁由第 1 步的钉版断言承担）。
8. 校验 ⑥：写 `pi-runtime/.version`（第 1 步已完成）。
9. 调用 `verify-isolated-runtime.mjs` 执行 ②⑦（见 §4.2、§4.3）。

### 5.3 `src/extension.ts`（第一轮 5、第三轮 7）

- `activate()` **不阻断扩展启动**：
  - 注册 `jerrypi.focusChat`；
  - 建 Output channel `jerrypi`；
  - 若 `pi-runtime/.version` 不存在，仅向 Output 打一条非阻断 warning（不弹窗、不 throw）。
- `jerrypi.focusChat` 的**唯一**行为（不做其它事，不打开面板）：
  - 读 `<extensionUri>/pi-runtime/.version`；
  - **缺失** → `showErrorMessage("jerrypi: pi-runtime 未同步，请运行 npm run sync 后重载窗口")`，`return`；
  - **存在** → `showInformationMessage("jerrypi: pi-runtime <版本> 就绪（聊天 UI 将在 S2 实现）")`。
- 本步**不 import pi**（S1 才引入 `loader.ts`）。
- `export function deactivate() {}`。

### 5.4 `test-fixtures/ext-smoke/index.ts`（第一轮 4）

**决定：故意随扩展发布（进 `.vsix`）。** 理由：

- A7 的核心价值就是"从**打包产物**复跑 ⑦"，fixture 必须在包内才能在解包目录里跑；
- `PLAN.md` 5.4 已明确要求 `.vsix` 内含 `test-fixtures/ext-smoke/index.ts`（S1 的自测门禁也用它）；
- 体积极小（源码 < 1 KB），对 18 MB 预估无实质影响；
- **用途写入 README 构建章节与 §6 验收标准**（说明它是打包/验收用的最小 pi 扩展，非用户功能），见第四轮 5。

内容：`export default function (pi: ExtensionAPI)`，`session_start` 写标记文件、
`registerCommand("smoke")`、`registerCommand("smoke-custom")`（调 `ctx.ui.custom()`）、
`registerTool("smoke_tool")`。标记路径读环境变量 `JERRYPI_SMOKE_MARKER`，避免污染。

依赖 `typebox` 与 `@earendil-works/pi-coding-agent`，运行时由 pi 的虚拟模块解析；
**tsconfig 排除 `test-fixtures`**，因此不额外引入 `typebox` 依赖。

### 5.5 `tsconfig.json` 与 `.vscodeignore`

- `tsconfig.json`：

  ```jsonc
  {
    "compilerOptions": {
      "target": "ES2023",
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "lib": ["ES2023"],
      "strict": true,
      "noEmit": true,
      "skipLibCheck": true,
      "esModuleInterop": true,
      "forceConsistentCasingInFileNames": true,
      "resolveJsonModule": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true
    },
    "include": ["src"],
    "exclude": ["node_modules", "dist", "pi-runtime", "test-fixtures"]
  }
  ```

- `.vscodeignore`：排除 `src/**`、`scripts/**`、`**/*.map`、`node_modules/**`；
  **显式取反** `!pi-runtime/**`、`!pi-runtime/node_modules/**`、`!test-fixtures/**`。
  （vsce 的 `node_modules/` 排除会误伤 `pi-runtime/node_modules/`，故必须取反。）

## 6. 验收清单

**A1–A7 仅覆盖 macOS 上的"包生成与隔离校验"（第二轮 6）；Windows 安装/启动为未覆盖项，见 B3。**

| # | 项 | 命令/方式 |
| --- | --- | --- |
| A1 | 安装 | `npm install`（macOS） |
| A2 | 同步 + 7 条校验 | `npm run sync`（①③④⑤⑥ 直接跑，②⑦ 子进程） |
| A3 | 自检 | `npm run self-test`（1 正 3 负用例全过） |
| A4 | 类型检查 | `npm run typecheck` |
| A5 | 构建 | `npm run build` → `dist/extension.js` |
| A5b | **干净构建** | `rm -rf dist pi-runtime && npm run package` 必须成功产出 `.vsix` |
| A6 | 打包 | `npm run package` → `.vsix` 非 0 字节且能解包 |
| A6b | **体积门禁** | `node scripts/check-vsix.mjs <vsix>`：`0 < size < 30 MB`，超限失败 |
| A7 | 解包复跑 | 见下方命令；还须含 `extension.vsixmanifest` 的 `Microsoft.VisualStudio.Code.PreRelease`，并记录大小 / SHA-256 |

A7 可复制命令（第一轮 1）：

```bash
VSIX=jerrypi-0.1.0.vsix
node scripts/check-vsix.mjs "$VSIX"
rm -rf /tmp/jerrypi-unpacked && mkdir -p /tmp/jerrypi-unpacked
unzip -q "$VSIX" -d /tmp/jerrypi-unpacked
# 包内断言：无 .node、关键文件在、PreRelease 标记
find /tmp/jerrypi-unpacked -name '*.node' -print -quit | grep -q . && { echo "FAIL: .node present"; exit 1; }
for f in pi-runtime/node_modules/@earendil-works/chord/dist/context/index.js \
         pi-runtime/node_modules/jiti \
         pi-runtime/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm \
         test-fixtures/ext-smoke/index.ts; do
  test -e "/tmp/jerrypi-unpacked/extension/$f" || { echo "FAIL: missing $f"; exit 1; }
done
grep -q 'Microsoft.VisualStudio.Code.PreRelease' /tmp/jerrypi-unpacked/extension.vsixmanifest || { echo "FAIL: no PreRelease"; exit 1; }
# 从解包目录复跑 ②⑦（不碰仓库 node_modules）
node scripts/verify-isolated-runtime.mjs \
  --pi-runtime /tmp/jerrypi-unpacked/extension/pi-runtime
```

**需要用户操作：**

| # | 项 | 原因 |
| --- | --- | --- |
| B1 | VS Code 里 F5：命令面板见 `Pi: Focus Chat`；执行后**只**出现 information（成功）或 error（缺 `pi-runtime`）；回报观察结果 | 需要 GUI；第三轮 7 的手工验收记录 |
| B2 | Marketplace 发布 0.1.0 预发布 | 需要 Azure DevOps PAT 与已创建的 publisher `flyjancy` |
| B3 | 受限 Windows 机上安装并回报 | 仅用户可访问；覆盖 A1–A7 未覆盖的平台差异 |

## 7. 提交计划与 CI（Conventional Commits）

1. `build: add extension scaffold, esbuild and pi runtime sync`（§2 全部文件 + lockfile）
2. `ci: verify pi runtime sync and vsix packaging`（最小 GitHub Actions）
3. `.vsix` 不入库（`.gitignore` 已忽略）。

**CI 约束（第三轮 5）**：

- 触发：`push` 与 `pull_request`。
- **不缓存** `pi-runtime/`、`dist/`、`*.vsix`；用 `npm ci` 做干净安装；**至少一步**在
  `rm -rf dist pi-runtime` 后构建（即 A5b），避免本地残留掩盖 sync 问题。
- 步骤：`npm ci` → `npm run typecheck` → `npm run sync` → `npm run self-test` →
  `npm run package` → `node scripts/check-vsix.mjs *.vsix`。

## 8. 决策点

已按建议 / 实测收敛为默认值，可覆盖：

| 编号 | 问题 | 采用值 | 依据 |
| --- | --- | --- | --- |
| D1 | 包管理器 | **npm** + 提交 `package-lock.json` | 最简单、可复现 |
| D2 | webview 入口 | **留到 S2** | 避免死文件 |
| D3 | `activate()` 校验 | 非阻断 warning + **命令触发时**校验并报错 | 第一轮 5 |
| D4 | CI | **本步一并加** | 与 A2/A3/A5/A6 同源 |
| D5 | 首次发布 | **只本地验证** `.vsix`，首发跟 S1 的 0.1.1 | 省一个版本号 |
| D6 | `private: true` | **加** | vsce 3.9.2 实测通过 |
| D7 | `test-fixtures` 进包 | **进包** | A7 需从打包产物复跑；`PLAN.md` 5.4 要求 |
| D8 | `@types/vscode` | **1.120.0**（`engines ^1.123.0` 不变） | vsce 拒绝 types > engines，且无 1.123.x |
| D9 | 构建入口 | **唯一定义在 `vscode:prepublish`**，`package` 保持薄 | 第二轮 1、2 |
| D10 | 包体积门禁 | **30 MB 硬断言**（A6b + `check-vsix.mjs`） | 第三轮 6；`PLAN.md` 门禁 |
| D11 | CI 工作区 | **不缓存生成物，含一次清空后构建** | 第三轮 5 |

## 9. pi 升级流程（第三轮 4）

pi 版本升级是一次**显式、可审计**的改动，步骤固定：

1. 改 `package.json` → `devDependencies["@earendil-works/pi-coding-agent"]` 为新精确版本
   （**预期版本的唯一来源**，见 §5.2）。
2. `npm install` 更新 `package-lock.json`。
3. `npm run sync`：若新增/缺失资源，④ 或 advisory 会暴露；据结果更新 §5.2 的复制清单，
   并把新资源补进 ④ 的断言列表。
4. `npm run self-test`。
5. `npm run package` + A5b/A6/A6b/A7 全部复跑，记录新体积。
6. 独立提交，如 `chore: upgrade bundled pi runtime to X.Y.Z`（不与功能改动混提）。
