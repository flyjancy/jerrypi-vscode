# jerrypi：Pi 聊天面板 VS Code 扩展 —— 实施计划

状态：**终稿**（Codex 5 轮评审 + DeepSeek 11 轮实跑复核，第 11 轮 APPROVE；2026-09-11）。日期：2026-09-10。
**评审记录见文末**（本文档是唯一一份总计划；根目录那份已按用户 2026-09-13 的决定合并进来并删除）。
**进度不写在这里** —— 只看 `docs/STATUS.md`（进度写进文档必然会烂）。

## 1. 目标与成功判据

### 1.1 目标

做一个 VS Code 扩展，在一台**没有 Node.js、不允许运行外部可执行文件**的 Windows 机器上，
安装扩展后无需任何额外依赖，就能在侧边栏用聊天面板驱动 Pi coding agent（`@earendil-works/pi-coding-agent` 0.85.x）。

### 1.2 成功判据（全部可观察）

| # | 判据 | 验证方式 |
|---|---|---|
| G1 | 受限 Windows 机（VS Code ≥ 1.123，Node 24，无 Node 安装）从 Marketplace 安装后，打开面板发一条消息，收到流式回复 | 在受限机上实际操作 |
| G2 | agent 能执行 read / bash / edit / write 四个内置工具；bash 走 Git Bash；文件改动落盘；运行中的 bash 可被中止 | 让 agent 列目录并修改一个文件；让它跑 `sleep 30` 后点中止 |
| G3 | 会话写入 `~/.pi/agent/sessions/`，与 CLI 会话格式互通；重启 VS Code 后能恢复上一会话（pi 的限制：只有完成过至少一轮 assistant 回复的会话才会落盘） | 受限机重启后恢复；Mac 上用 `pi` CLI `--resume` 打开扩展生成的会话 |
| G4 | 模型列表来自 `~/.pi/agent/models.json` 与内置 provider；能在面板里切模型和思考等级 | 切换后下一条回复由新模型产生（看 usage 元数据） |
| G5 | 扩展运行不依赖任何原生 `.node` 模块；可选原生模块缺失不影响启动 | 安装包中不含 `.node` 文件；G1 仍通过 |
| G6 | 用户的 pi TypeScript 扩展（含 `import ... from "@earendil-works/pi-coding-agent"` 与 `typebox`）能被加载，`extensionsResult.errors` 中不含该扩展 | 装一个最小测试扩展；面板显示其注册的命令 |
| G7 | 在 Mac 上 `F5` 调试与 `vsce package` 打包均可用，产物体积 < 30 MB | 本地脚本 |

## 2. 现状与已验证事实

以下均在 2026-09-10 于本机（macOS，Node 26.8.1，pi 0.85.1 全局安装）验证：

- **VS Code 内置 Node 版本**（来源：ewanharris/vscode-versions）：1.100 = Node 20.19；1.105（2025-10）= Node 22.19.0，是第一个满足 pi `engines.node >= 22.19.0` 的版本；**1.123（2026-06）起为 Node 24.15**；当前 1.136/1.137 = Node 24.18.1。**本计划声明的下限是 1.123**：1.105–1.122 的 Node 22 档从未被实测，而受限机可升到最新，没有必要背这个未验证区间。
- **VS Code ≥ 1.100 原生支持 ESM 扩展**（`"type": "module"`），仅限 Node 扩展宿主，桌面版即是。
- **pi 自带一份预打包的 SDK：`dist/bundle/`**（7.6 MB，48 个 chunk，ESM）。它以构建常量 `PI_BUNDLED_NODE=true` 编译，`dist/bundle/index.js` 导出与 `dist/index.js` 相同的全部 SDK 符号。这份 bundle 的对外 `import`/`require`（2026-09-11 用隔离目录实跑 import 核实，不再只靠 grep）：Node 内置模块；**一条静态 import `@earendil-works/chord/context`**（在 `chunks/chunk-JVUZSMYM.js`，被 `index.js` 静态引用，缺失则整个 SDK 无法加载；该子路径自包含，`dist/context/` 约 24 KB，整包 1.1 MB）；动态 `import("@silvia-odwyer/photon-node")`（WASM 图片库，2.2 MB，无原生代码）；以及三个 try/catch 保护的可选包（`bufferutil`、`utf-8-validate`、`supports-color`），缺失时各自降级；另有 `@aws-sdk/signature-v4-crt` 仅作为错误提示中的包名出现（见下文 SigV4a）。typebox 以虚拟模块形式打进了 bundle；**jiti 没有打进去**，chunk 里是 `require3("jiti").createJiti`，是硬 CJS 依赖，而且 `.js` 和 `.ts` 扩展的加载都走 jiti（2026-09-11 隔离目录实跑：缺 jiti 时所有扩展，包括用户自己的，全部报 `Cannot find module 'jiti'`；补上 jiti 2.7.0（无依赖，1.7 MB）后全部正常）。另有 try/catch 保护的 `requireClipboard("@mariozechner/clipboard")`，缺失时 `copyToClipboard` 仍返回成功。**只复制 `dist/bundle/` + `package.json` 到干净目录 import 会报 `ERR_MODULE_NOT_FOUND: @earendil-works/chord`；补上 chord 后加载成功、`VERSION === "0.85.1"`。** 开发机上从仓库目录 import 会因 npm 把 chord 提升到仓库根 `node_modules` 而"碰巧成功"，所以依赖完整性只能在解包后的隔离目录里验证。
- **pi 的扩展加载器有两条路径**（`dist/core/extensions/loader.js`）：非 bundled 模式用 `require.resolve("typebox")`、`import.meta.resolve(...)` 和相对 `index.js` 的文件布局解析模块别名；**bundled 模式（`isBundledNode`）改用虚拟模块**，不依赖 node_modules 布局。→ 自己重新 bundle `dist/index.js` 会走前一条路径并失败；直接消费 `dist/bundle/` 走后一条。
- **pi 的包元数据在模块顶层读取**：`dist/config.js` 在 import 时就调用 `getPackageJsonPath()` 计算 `PACKAGE_NAME`、`VERSION` 等常量。`getPackageDir()` 的优先级：`PI_PACKAGE_DIR` 环境变量 → Bun 二进制目录 → `findNodePackageDir(__dirname)`，后者从 bundle 所在目录向上找第一个 `package.json`。
- **图片缩放**用 `new Worker(new URL("./image-resize-worker.js", import.meta.url))`，bundle 的 `chunks/` 里已带 `image-resize-worker.js`；worker 内部再 `import("@silvia-odwyer/photon-node")` 并 `readFileSync` 同目录的 `photon_rs_bg.wasm`。worker 失败时 `image-resize.js` 会静默退回主线程处理。
- **HTTP 代理**：pi 的 `configureHttpDispatcher()`（`core/http-dispatcher.js`）用 undici `EnvHttpProxyAgent` 读取 `HTTP(S)_PROXY`/`NO_PROXY`，并 `undici.install()` 替换全局 fetch。**它只被 CLI 入口（`main.js`、`rpc-entry.js`）调用，SDK 路径不会自动调用，且没有从 `index.js` 导出。**
- **pi 的 bash 工具在 Windows 上依次查找**：`settings.json` 的 `shellPath` → `C:\Program Files\Git\bin\bash.exe` → PATH 上的 `bash.exe`。另有可选 `powershell` 工具。两者都依赖 `child_process.spawn`。
- **包管理器**（`DefaultPackageManager`）：`parseSource()` 识别 `npm:` 前缀、本地路径（裸路径，**没有 `path:` 前缀**）、git URL；写入 settings 的是 `installAndPersist()` / `removeAndPersist()`，`install()` 不持久化；`npm:` 源和**带 `package.json` 的 git 源**都会调用 `npm`。
- **SDK 关键 API 已确认存在**（`dist/index.d.ts`）：`createAgentSessionServices` / `createAgentSessionFromServices` / `createAgentSessionRuntime` / `AgentSessionRuntime`（生产装配路径，见 5.3；`createAgentSessionFromServices` 内部用 `services.resourceLoader` 调 `createAgentSession`，不重复 `reload()`，也不调 `bindExtensions`）、`createAgentSession`、`AgentSession.prompt/steer/followUp/abort/setModel/setThinkingLevel/subscribe/dispose`、`ModelRuntime.create/getModels/setRuntimeApiKey`、`SessionManager.create/open/list/continueRecent`、`DefaultPackageManager`、`InlineExtension` 与可阻塞的 `tool_call` 事件（返回 `{ block, reason, terminate }`，`ctx.signal` 可感知中止）。
- **扩展绑定**：`createAgentSession()` **不会**调用 `session.bindExtensions()`；CLI 的 print/rpc 模式在创建会话后自己调用它，传入 `uiContext`（select/confirm/input/notify 等 UI 回调）、`mode`、`commandContextActions`、`abortHandler`、`shutdownHandler`、`onError`。不绑定则 `session_start` 不会发给扩展，扩展命令不可用。已注册命令的公开查询入口是 `session.extensionRunner.getRegisteredCommands()`（没有 `getCommands()`）。`newSession()`/`switchSession()` 替换会话后需重新绑定与重新订阅。
- **edit 工具结果自带 diff**：`EditToolDetails` 含 `diff`（展示用）、`patch`（标准 unified patch）、`firstChangedLine`，在工具自身执行边界内计算，天然是该次调用的精确前后对比。write 工具没有对应 details。`WriteToolOptions`/`EditToolOptions` 都接受自定义 `operations`（readFile/writeFile），生产路径通过 `createAgentSessionFromServices({ customTools })` 接收自定义工具（同名覆盖见下）；`createAgentSessionServices` 不传 `modelRuntime` 时会用 agentDir 里的 `auth.json`/`models.json` 新建一个 ModelRuntime，外部注入的 key 不会进入服务。
- **并行工具执行**：pi-agent-core 默认并行执行同一条 assistant 消息里的多个工具调用，`tool_execution_start` 对整批先发完再执行；`tool_call` 也是先逐个预检再并发执行。所以在事件回调里读磁盘做"前快照"对同一文件的两次调用会拿到相同内容。
- **fetch 注入**：pi-ai 的流式请求选项有 `fetch?: FetchFunction`，但 `ModelRuntime` 与 `createAgentSession` 都**没有**把它暴露出来，无法给 pi 的请求注入局部 fetch。pi bundle 内的 undici 8.9.0 用 `Symbol.for("undici.globalDispatcher.2")` 为主槽、`.1` 为兼容槽；`undici.install()` 会同时替换 `fetch`、`Request`、`Response`、`Headers`、`WebSocket` 等全局对象。
- **会话持久化前置条件**：`SessionManager._persist` 在文件里出现第一条 assistant 消息之前不写盘，只标记 `flushed=false`；只有未回答的 user 消息的会话不会出现在 `list()` 里，`continueRecent` 也恢复不到。
- **pi 内置 `deepseek` provider**（`api.deepseek.com`），用户的 `models.json` 只是覆盖/扩展它。受限机上不需要手输 models.json 即可用内置 deepseek 模型；自定义模型才需要。
- **`DefaultPackageManager` 构造必需 `{ cwd, agentDir, settingsManager }`**，缺 `cwd` 会在 `startsWith` 处抛错。`installAndPersist(<绝对本地路径>)` 会把 settings.json 里的源改写成相对 `agentDir` 的相对路径。
- **`fs.cpSync` 与 `cp -R` 默认保留符号链接**（实测 `dereference: true` 才复制内容）。pnpm 布局下 pi 的依赖是指向 `.pnpm` store 的符号链接，原样复制进 `pi-runtime/` 后在开发机上仍可解析、打进 .vsix 后必然失效。
- **会话替换走 `AgentSessionRuntime`，不在 `AgentSession` 上**：`newSession()`、`switchSession(path)`、`fork()`、`importFromJsonl()` 都是 `AgentSessionRuntime` 的方法，`runtime.session` 在替换后指向新对象；`AgentSession` 上只有 `navigateTree()`。官方装配方式（`examples/sdk/13-session-runtime.ts`、rpc 模式）是 `createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions })` + `createAgentSessionFromServices({ services, sessionManager, ... })` 组成工厂，交给 `createAgentSessionRuntime(factory, ...)`；每次替换后重挂 `subscribe` 并重新 `bindExtensions()`。`DefaultResourceLoaderOptions.extensionFactories?: InlineExtension[]` 是内联扩展（审批、smoke）的挂载点。rpc 模式的 `commandContextActions.newSession/switchSession` 直接委托 `runtime.newSession/switchSession`。
- **vsce 3.9.2 打包事实**（DeepSeek 实跑）：`package.json` 有 `main` 就必须有 `activationEvents` 或 `contributes`（如 `contributes.commands`），否则 `vsce package` 直接报错；`--pre-release` 标记写在 `extension.vsixmanifest` 的 `Microsoft.VisualStudio.Code.PreRelease` 属性里，不在 `package.json`；semver 带 `-suffix` 的版本号被 Marketplace 拒绝；遇到符号链接时 vsce 默认报 `not a file` 并留下 0 字节 .vsix，`--follow-symlinks` 才会跟随；`.vscodeignore` 的 `!pi-runtime/**`、`!pi-runtime/node_modules/**`、`!test-fixtures/**` 取反实测有效。
- **`SessionManager.list(cwd, sessionDir?)` / `continueRecent(cwd, sessionDir?)`** 省略 `sessionDir` 时用默认 `~/.pi/agent/sessions`，不跟随自定义 `agentDir`。
- **流式期间的发送语义**：agent 正在流式输出时再调 `session.prompt(text)` 会直接抛 `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')`；`PromptOptions.streamingBehavior` 在流式时必填。`steer()` 与 `followUp()` 可正常排队并各自触发 `queue_update`（含 `steering`/`followUp` 两个数组）。`agent_end` 是一次底层 run 结束，`agent_settled` 才是"彻底空闲、无排队消息与重试"，官方 rpc 模式用它做 `waitForIdle()`；实跑顺序 `agent_start → turn_* → agent_end → agent_settled`。
- **会话文件里只有 `edit` 的 toolResult 持久化 `details`**（`{diff, patch, firstChangedLine}`）；`write`、`bash`、`read` 的 toolResult 没有 details。所以重启/恢复会话后 edit 的 diff 可以从会话文件重建，write 的前后快照只存在于进程内存。
- **pi 自己的 HTML 导出模板已处理 markdown 渲染安全**（`dist/core/export-html/template.js`）：`marked.use({ tokenizer: { html(){return undefined}, tag(){return undefined} } })` 把 HTML 当纯文本原样显示，`renderer.link/image` 用 `sanitizeMarkdownUrl` 做 scheme 白名单并 `escapeHtml`。`marked` 默认不消毒，直接 `innerHTML` 会让 agent 回复、被读取的文件内容、bash 输出里的 `<img onerror>`、`<script>`、`javascript:` 链接在 webview 里执行，而 webview 持有 `acquireVsCodeApi` 能回发消息。
- **bash 直接执行 API**：`session.executeBash(command, onChunk, options)` 与 `session.abortBash()` 配对；`session.abort()` 中止的是 agent 循环（含其发起的工具调用）。
- **`DefaultResourceLoader`**：构造必需 `cwd` 与 `agentDir`，支持 `additionalExtensionPaths` 等额外路径。**传目录时入口必须是 `index.ts`/`index.js`**（目录里只有 `smoke.ts` 会报 `Cannot find module <dir>`）；传文件路径则无此限制（实跑确认）。它默认还会加载 `~/.pi/agent/extensions/` 与 settings 里的包，所以 `extensionsResult.errors` 里会混入用户自己扩展的错误。`createAgentSession()` 只在**自己创建** loader 时才调用 `reload()`；传入现成 `resourceLoader` 时，调用方必须先 `await loader.reload()`，否则不会发现任何资源。
- **同名自定义工具覆盖内置工具已确认**：`AgentSession._refreshToolRegistry()` 用 `customTools` 里的同名定义覆盖内置工具。`createWriteToolDefinition()` 已导出，可在外层 `execute` 里拿到 toolCallId 后再构造该次调用专用的 `operations`。`WriteOperations.writeFile` 本身只收路径和内容，没有调用 ID。
- **`ExtensionUIContext` 的字段几乎全部必填**（select/confirm/input/notify/onTerminalInput/setStatus/setWorking*/setWidget/setFooter/setHeader/setTitle/pasteToEditor/setEditorText/getEditorText/editor/addAutocompleteProvider/setEditorComponent/getEditorComponent/getAllThemes/getTheme/setTheme/getToolsExpanded/setToolsExpanded），runner 直接展开传入对象，不补默认实现。`ExtensionCommandContextActions` 也必需 fork/navigateTree/switchSession/reload。
- **`getThemesDir()` 在 `config.d.ts` 里有声明，但没从 `index.d.ts` re-export**；导出的有 `getPackageDir()`、`getDocsPath()`、`getExamplesPath()`、`getReadmePath()`、`VERSION` 等。它的实现是 `existsSync(join(packageDir,"src")) ? "src" : "dist"` 再拼 `modes/interactive/theme`，**所以 `pi-runtime/` 下绝不能出现 `src/` 目录**，否则主题路径静默指向不存在的位置。系统提示构建会把 `getDocsPath()`、`getExamplesPath()`、`getReadmePath()` 三个路径写进提示词（不在启动时读盘），缺目录不会崩但会把 agent 指向不存在的路径。
- **AWS SigV4a**：bundle 里 `@aws-sdk/signature-v4-crt` 只出现在错误提示字符串里，不是实际 require；需要 SigV4a 的 Bedrock 场景会明确抛错，属按需能力限制而非静默降级。`bufferutil`、`utf-8-validate`、`supports-color` 确有 try/catch。
- **原生模块**：pi 依赖树里只有 `@mariozechner/clipboard`（optionalDependency）与 pi-tui 的两个 TUI 专用模块。`dist/bundle/` 对 clipboard 有 guarded require，允许缺失；对 pi-tui 原生模块无引用。
- **Zetaphor/pi-vscode-extension**（MIT，约 4900 行 TS，最后提交 2026-05-07）锁在旧包名 0.70.2。pi 对接层（`src/pi/*`）必须重写；`webview/main.ts`（2193 行）可移植；`providers/diff.ts` 依赖 `CheckpointManager` 且用"首次保存的原文 + 当前磁盘文件"做对比，**不是按 toolCallId 的单次调用前后对比**；其 esbuild `import.meta` shim 插件只匹配 `node_modules/@mariozechner/`，需改路径才能用。
- **Marketplace 上的 `pi0.pi-vscode` 是终端式**，要求本机已装 pi CLI，不适用。
- 用户已有 `../pi-config` 包（主题 + 一个 TUI footer 扩展）。

## 3. 约束与前提假设

约束：

- 目标机：Windows，VS Code 可升级到最新（当前 1.137，Node 24.18.1），能访问 Marketplace，有 bash（Git Bash），**不能安装 Node，不能运行下载的可执行文件，不能从外部拷入文件**（只能通过 Marketplace 安装扩展）。
- 开发机：本 Mac。
- 不能改 pi 本身；只能以 npm 依赖形式消费它。

假设（方括号是把握程度，低把握的项请评审者优先攻击）：

- **A1 [高]** 扩展宿主的 Node 24.x 能跑 pi 的 `dist/bundle/`。已在 Node 26 隔离目录实跑官方 bundle 成功；受限机 VS Code 可升到最新，Node 24.18.1。声明下限 `engines.vscode ^1.123.0`（Node 24.15）与实测档位同一个 Node 大版本。→ S1 记录扩展进程的 `process.versions` 并在受限机验证。
- **A2 [中]** Windows 上 ESM 扩展的路径处理无问题。1.100 insiders 曾有 `Received protocol 'c:'` 的 bug，稳定版已修。→ 回退：CJS 输出 + 改写过路径过滤器的 `import.meta` shim（参考 Zetaphor，需适配和重新验证，不是现成方案）。
- **A3 [中]** 受限机的安全策略允许 VS Code 进程 `spawn` 已安装的 `bash.exe`。用户说"有 bash"，但"不能运行下载的可执行文件"的策略边界（是按签名、按路径还是按发布者）未知。→ S1 在受限机上直接验证；失败则整个方案降级为"只读 agent"（read/grep/find/ls），需用户重新决策。
- **A4 [中]** pi 的 `DefaultResourceLoader` 与 `SessionManager` 在 Windows 路径下行为正常。pi 官方支持 Windows CLI，SDK 路径与 CLI 共用。→ S1 验证会话恢复。
- **A5 [中]** Marketplace 接受十几 MB 的 .vsix。→ 没有侧载回退（受限机不能拷文件）；失败则减体积。S0 就先发一个空壳预发布版验证发布链路。
- **A6 [低]** 受限机访问模型 API 的网络前提未知：是否需要代理、是否有企业 CA。→ S1 用目标机真实 provider 做一次流式请求；见 5.3 代理策略与 R5。
- **A7 [高]** 不需要 pi CLI 也能安装本地路径的 pi 包：`DefaultPackageManager.installAndPersist()` 已导出。`npm:` 源和带 `package.json` 的 git 源在受限机上**不可用**（要 npm）。
- **A8 [中→高]** 在扩展内复刻 pi 的包布局（`pi-runtime/package.json` + `pi-runtime/dist/bundle/` + `pi-runtime/node_modules/`）后，`findNodePackageDir` 找到的就是这个目录，`VERSION`/主题/文档路径全部正确。隔离目录实跑已确认 `getPackageDir()` 返回 `pi-runtime`。**不设 `PI_PACKAGE_DIR`**，否则它会掩盖布局错误，A8 就没被真实验证。→ S1 断言 `VERSION === "0.85.1"`、`getPackageDir()` 以 `pi-runtime` 结尾，并断言 5.4 sync 脚本第 4 条列出的全部路径存在可读。

## 4. 方案选择

### 4.1 选定方案

**从零起项目；扩展自身代码用 esbuild 打包，pi 则原样复制其官方 `dist/bundle/` 到扩展内并以文件路径动态 `import()`；UI 层从 Zetaphor 移植。** 聊天 UI 用 Webview；两者通过类型化消息协议通信。

### 4.2 被否掉的备选

| 备选 | 否掉理由 |
|---|---|
| 自己用 esbuild 把 `dist/index.js` 及依赖打成单文件（初稿方案） | 走的是非 bundled 扩展加载路径，`require.resolve("typebox")`、`import.meta.resolve` 在删掉 node_modules 后失效；`PI_BUNDLED_NODE` 未定义。pi 官方 bundle 已解决这些问题，没必要重做。 |
| 把 pi 整个 `node_modules` 树（155 MB）塞进 .vsix | 体积大、含原生模块、Windows 路径长度风险；且 `dist/bundle/` 已证明只需 Node 内置模块 + 一个 WASM 包。 |
| fork Zetaphor 仓库 | pi 对接层反正要重写；协议里 auth/model 相关字段也随之变化；diff 实现语义不对（见第 2 节）。移植 UI 比 fork 干净。 |
| 终端 TUI 路线（`ELECTRON_RUN_AS_NODE=1` 用 VS Code 二进制当 node 跑 pi CLI） | 用户明确要聊天面板。另外 Windows 上 `Code.exe` 是 GUI 子系统程序，作为 node 跑 TUI 的控制台行为未验证。 |
| RPC 子进程模式 | 需要一个 node 可执行文件，受限机没有。 |
| pi 官方 Bun 独立二进制 | 受限机不能运行下载的可执行文件。 |
| CJS 输出 + `import.meta` shim | ESM 已被 VS Code ≥ 1.100 原生支持。保留为 A2 的回退（需适配）。 |
| 自己实现 agent loop 只复用 pi-ai | 失去 pi 的会话格式、扩展、技能、压缩等全部生态，与目标背离。 |

## 5. 架构

### 5.1 目录

```
jerrypi-vscode/
  package.json              "type": "module"；engines.vscode ^1.123.0；main: dist/extension.js
  esbuild.mjs               两个入口：extension（platform node, format esm, external: vscode）、webview（browser, iife）
  scripts/sync-pi-runtime.mjs  从 node_modules 复制 pi 运行时到 pi-runtime/（见 5.4）；写入版本戳
  pi-runtime/               （生成物，进 .vsix，不进 git）
    package.json              pi 自己的 package.json（供 findNodePackageDir / VERSION）
    dist/bundle/index.js      pi 官方 SDK bundle 入口
    dist/bundle/chunks/*.js   含 image-resize-worker.js
    dist/modes/interactive/theme/*.json
    dist/core/export-html/    模板（/export 用）
    docs/ examples/ README.md pi 文档、示例、README（三者路径会被写进系统提示；docs 2.7 MB，examples 1.3 MB）
    node_modules/@earendil-works/chord/        整包复制（去掉 map/src），bundle 静态 import 其 /context 子路径
    node_modules/jiti/                          整包复制（1.7 MB，无依赖），所有扩展加载的硬依赖
    node_modules/@silvia-odwyer/photon-node/   JS + photon_rs_bg.wasm
  src/extension.ts          activate()：设环境、动态 import pi-runtime、注册视图/命令/状态栏
  src/pi/loader.ts          唯一 import pi 的地方：解析 pi-runtime 路径，`await import(pathToFileURL(...))`，导出类型化句柄
  src/pi/runtime.ts         ModelRuntime 单例；SecretStorage 里的 key 通过 setRuntimeApiKey 注入
  src/pi/session.ts         createSessionHost：包装 AgentSessionRuntime；替换会话后 rebind；事件 → 协议消息
  src/pi/controller.ts      会话主机（最终版）：pi 事件 → 协议消息、id 唯一权威、重放、会话替换与守卫
  src/pi/serialize.ts       pi 消息 → ChatItem 的唯一转写器（实时与重放共用）
  src/pi/model-choice.ts    从模型目录里挑一个可用的（面板不钉模型时的兜底）
  src/pi/custom-tools.ts    同名覆盖内置 write（按调用捕获 toolCallId，给 S7 用）
  src/pi/resources.ts       sync 脚本与自测共用的"必须存在的资源路径"清单
  src/pi/selftest.ts        `Pi: Run Self-Test` 的闸门实现（T1–T13 + GATE 判定）
  src/pi/selftest-ui.ts     自测专用的最小 ExtensionUIContext（custom 会抛可控错误）
  src/pi/sessions.ts        会话目录推导（resolveSessionDir/sessionsRootOf，复刻 pi 的 per-cwd 编码规则）+ list/continueRecent 封装
  src/pi/bindings.ts        bindExtensions 的 uiContext（QuickPick/InputBox/通知）、onError→Output、commandContextActions
  src/pi/approval.ts        （**S8 待建**）InlineExtension：tool_call 阻塞 + webview 审批（默认关）
  src/pi/packages.ts        （**S9 待建**）DefaultPackageManager 封装：installAndPersist / listConfiguredPackages / removeAndPersist（返回 boolean，false 时提示"未移除"）
  src/pi/filechanges.ts     （**S7 待建**）按 toolCallId 收集 edit 的 patch 与 write 的前后内容（见 5.3）
  src/host/chatView.ts      WebviewViewProvider；消息路由；v1 单会话
  src/host/diff.ts          （**S7 待建**）pi-diff: 虚拟文档 + 打开 diff 编辑器（自写，读 filechanges）
  src/commands.ts           命令注册：自测 / 设 key / 清 key / 刷新模型目录 / 打开设置 / 模型与等级选择器 / 新建会话 / 恢复会话
  src/host/statusBar.ts     模型名 + 上下文用量
  src/host/modelPicker.ts   模型 / 思考等级选择器（宿主侧 QuickPick，不认识 session）
  src/host/sessionPicker.ts 会话选择器（宿主侧 QuickPick；sessionToItem 是纯函数，便于断言）
  src/host/sessionActions.ts 会话替换的"忙时先问一句"与结果文案（弹窗在宿主层）
  src/host/config.ts        读 VS Code 配置（三项设置）+ 变更时提示重载；SecretStorage 存取 API key（**S6 已建**）
  src/host/net.ts           （**未建**：Q2 决定不做第二层代理；第一层交给 VS Code 与 `NODE_USE_ENV_PROXY`，并在 T13 里报告）代理/证书策略（见 5.3）
  src/host/uiContext.ts     VS Code UI → pi ExtensionUIContext（QuickPick/InputBox/通知）
  src/host/webviewHtml.ts   面板 HTML 外壳（CSP + nonce + localResourceRoots 的约定）
  src/host/workspace.ts     会话 cwd 的确定（第一个 workspace folder；没打开工作区时退回主目录并明说）
  src/shared/protocol.ts    ClientMessage / ServerMessage 联合类型
  src/shared/format.ts      照抄 pi 语义的纯格式化函数（tokens / 上下文用量 / 会话名 / 会话时间）
  src/shared/toolText.ts    工具正文净化（剥 ANSI、滤控制字符、按 UTF-8 字节裁剪）
  src/shared/urlPolicy.ts   链接/图片的 scheme 白名单（渲染层与宿主层共用同一判定）
  src/webview/main.ts       聊天 UI（移植自 Zetaphor，去掉多 tab 与 checkpoint）
  src/webview/render.ts     markdown（marked，照抄 pi export-html 模板的消毒配置：HTML 当纯文本 + URL scheme 白名单 + escapeHtml）、工具卡片、思考块
  src/webview/style.css
  media/                    图标
  test-fixtures/ext-smoke/index.ts  一个最小 pi TS 扩展（入口必须叫 index.ts；import pi-coding-agent + typebox；session_start 时写标记文件；注册 /smoke 与 /smoke-custom），供 sync 脚本第 7 项与 G6/S1
```

### 5.2 数据流

1. Webview `postMessage(ClientMessage)` → `chatView` 路由 → `PiSession` 调 `AgentSession` 方法。
2. `AgentSession.subscribe()` 收到事件 → `PiSession` 序列化为 `ServerMessage` → Webview 增量渲染。
3. 转发的事件子集：`agent_start/end`、**`agent_settled`**、`turn_start/end`、`message_start/update/end`（含 text_delta、thinking_delta、toolcall）、`tool_execution_start/update/end`、`bash_execution_update`、`queue_update`、`session_info_changed`、`thinking_level_changed`、`compaction_start/end`、`auto_retry_*`。
4. Webview 断开重连（面板折叠再展开）时，`chatView` 用 `AgentSession` 的消息历史重放一次全量状态。
5. **发送语义**（`ClientMessage` 区分 `prompt` / `steer` / `followUp` 三种动作）：空闲时 Enter = `prompt`；流式期间 Enter = `steer`（**在"当前这段模型输出结束、下一次调用模型之前"注入，不是掐断正在生成的文字**—— pi 的 TUI 也是这个行为，实测确认；输入框提示写"这段写完后注入新指令"），另有"排队"按钮 = `followUp`（等整轮全部结束后再发）；流式期间绝不调 `prompt`。排队中的消息用 `queue_update` 的 `steering`/`followUp` 数组渲染成待处理条。**只能整体清空**（pi 只提供 `clearQueue()`，没有按条移除/编辑的 API；伪实现会让投递顺序与用户所见不一致），清空前先把文本退回输入框。
6. **空闲判定以 `agent_settled` 为准**（或 `session.isStreaming`），不以第一个 `agent_end` 为准：`agent_end` 后若还有 followUp 队列或 `auto_retry_*`，输入态仍保持"生成中"。

### 5.3 关键设计决定

- **初始化顺序**：`extension.ts` 对 pi **只做动态 `import()`，绝不静态 import**。`activate()` 先确定 `pi-runtime` 绝对路径、应用网络策略，然后才 `await loader.load()`。**不设 `PI_PACKAGE_DIR`**（见 A8）。import 失败时给出含 `pi-runtime` 路径与原始错误的清晰提示，不要静默失败。**生产与自测使用同一条装配路径**：`createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions: { additionalExtensionPaths, extensionFactories: [approvalExtension] } })` → `createAgentSessionFromServices({ services, sessionManager, customTools: [wrappedWrite] })` → `createAgentSessionRuntime`。**`modelRuntime` 必须是 `runtime.ts` 的单例**（否则 SecretStorage 注入的 key 永远不进服务，`runtime.ts` 成死代码），且会话替换时复用同一个；**`customTools` 必须带 `filechanges.ts` 造好的同名 write 包装**（否则 S7 写快照不生效）；`createAgentSessionRuntime` 不返回 `extensionsResult`，扩展加载诊断从 `runtime.services.resourceLoader.getExtensions().errors` 读取（或在工厂闭包里保存 `createAgentSessionFromServices` 的返回值）；S1 与 sync 脚本第 7 条不再单独用 `createAgentSession({ resourceLoader })`，避免测的不是真实路径。原因：pi 的 `config.js` 在模块求值时就读取包元数据。
- **扩展绑定**（`bindings.ts`）：会话由 `AgentSessionRuntime` 持有；首次创建与每次 `runtime.newSession()` / `runtime.switchSession()` 之后，都对 `runtime.session` 执行一次 rebind：先取消旧订阅，再 `session.bindExtensions()`，再重新 `subscribe()`，传入一个**完整、经 TypeScript 类型检查、不用断言掩盖缺字段**的 `ExtensionUIContext`，以官方 rpc 模式的 `createExtensionUIContext()` 为蓝本：select/confirm/input 用 VS Code QuickPick / InputBox 实现并落实 `signal` 与 timeout；notify 用 VS Code 通知；`editor()` 返回 `undefined` 表示取消；`custom<T>()` 没有统一取消值，实现为明确 reject 的 `Promise<never>`，错误经 `onError` 通道显示；终端专用方法（onTerminalInput、setStatus、setWorking*、setWidget、setFooter、setHeader、setTitle、编辑器读写、主题查询、工具展开）提供明确的 no-op 或固定值。`mode` 填 `"rpc"`；`onError` 写 Output channel 并在面板提示；`abortHandler` 接面板中止；`commandContextActions` 提供 waitForIdle/newSession/fork/navigateTree/switchSession/reload 全部必需项：newSession/switchSession 直接委托 `runtime.newSession/switchSession` 并触发 rebind（与官方 rpc 模式一致）；navigateTree 委托 `session.navigateTree`；fork 在 v1 返回"已取消"；reload 委托 loader reload 后 rebind。事件订阅同样在会话替换后重挂。
- **cwd**：一个 VS Code 窗口 = 一个会话 cwd = 第一个 workspace folder；没有 workspace 时用用户主目录并在面板里提示。
- **配置来源遵循 pi 自己的约定**：`~/.pi/agent/settings.json`、`models.json`、`auth.json` 全部原样生效。扩展只**叠加**三项 VS Code 设置：`jerrypi.approvalMode`（off / mutating / all）、`jerrypi.proxy`（可选，显式代理 URL）、`jerrypi.agentDir`（默认留空即 `~/.pi/agent`）。shellPath、defaultTools、默认模型等一律引导用户改 pi 的 `settings.json`，扩展提供 "Pi: Open Settings File" 命令直接打开它。
- **API key**：`Pi: Set API Key` 命令 → 存 VS Code SecretStorage → 每次创建 `ModelRuntime` 后 `setRuntimeApiKey(provider, key)`。`models.json` 里已有的 key 照常生效，SecretStorage 优先。
- **网络与代理策略**（`net.ts`）：pi SDK 路径不会安装代理 dispatcher，`configureHttpDispatcher` 未导出，且没有向 pi 请求注入局部 fetch 的管道。方案分两层，第二层**默认关闭**：
  1. 默认只依赖 VS Code 自身的 `http.proxy` / `http.proxySupport` / `http.fetchAdditionalSupport` / `http.systemCertificates`，它们已注入扩展宿主的 `http`/`https` 与全局 `fetch`。S1 第 4 项在受限机上验证这一层是否足够。
  2. 仅当用户显式设置 `jerrypi.proxy` 时启用：扩展自带 `undici`（devDependencies 锁精确版本，S0 时选定 8.x 的一个具体版本并写进 package.json，不用 `^`），把 `globalThis.fetch` 替换为"undici fetch + 绑定该代理的 `ProxyAgent`"的包装函数。**不调用 `undici.install()`，不动 `Request`/`Response`/`Headers`/`WebSocket`，不调用 `setGlobalDispatcher`**。这仍是进程级改动，设置项说明里明确写出。已知跨实现问题：undici 8 只把自己的 `Request` 当 `RequestInfo`，其他实现的 `Request` 对象会被当字符串处理。因此包装器对**非字符串/非 URL 的输入一律委托原 fetch**，只对字符串与 `URL` 输入走代理；文档写明覆盖范围。生命周期：关闭设置或 `deactivate()` 时，**仅当 `globalThis.fetch` 仍是自己的包装器时才恢复**原 fetch；若已被别的扩展再次包装，则把自己的包装器切换为纯委托原 fetch 的状态，不动全局引用；`ProxyAgent` 等自身在途请求结束后再 `close()`。启用该层的验收必须包含宿主网络回归：Marketplace 搜索、另一个联网扩展、原全局 `Request` 输入、带 body/signal 的请求、`http.proxyStrictSSL` 行为均不变；以及"另一包装器后安装，再关闭 `jerrypi.proxy`"的顺序不破坏后者。该验收必须针对**esbuild 打进扩展产物里的那份 undici** 跑（从解包后的 .vsix 或 F5 的 `dist/extension.js`），不是仓库 `node_modules` 里那份。
  3. 企业 CA：扩展进程启动后无法再设 `NODE_EXTRA_CA_CERTS`；只能依赖 VS Code 的 `http.systemCertificates`。若受限机需要额外 CA 且该设置不生效，记为已知限制并上报用户。
- **工具审批**（`approval.ts`）：pi 默认全权限执行。v1 提供开关，默认 `off`。开启时用 `InlineExtension` 监听 `tool_call`：
  - `mutating` 档：`edit`、`write`、`bash`、`powershell` 以及**所有未知/自定义工具**都需确认；`read`、`grep`、`find`、`ls` 直接放行。`all` 档：全部确认。
  - 批准 → 返回 undefined 放行；拒绝 → `{ block: true, reason: "Rejected by user" }`。
  - 生命周期：`ctx.signal` 触发（用户点中止）、`AgentSession.dispose()`、Webview 被销毁、会话切换，四种情况都把待审批 promise 以"cancelled"解决并返回 `block`。待审批项以 toolCallId 为键，面板重开时重放。
- **diff 审阅**（`filechanges.ts` + `diff.ts`）：不在事件回调里读磁盘做快照（并行执行下会串）。
  - **edit**：直接展示工具结果 `details.patch`（工具执行边界内生成的 unified patch），按 toolCallId 存内存。**只展示 patch，不反向应用去"还原"完整文件**：后续调用可能改了同一文件的其他位置，反向应用成功不代表还原出的是当时的真实内容。
  - **write**：用 `createWriteToolDefinition()` 包一层自定义工具，同名覆盖内置 write（已确认覆盖机制）。外层 `execute(toolCallId, ...)` 拿到 toolCallId 后，为该次调用构造捕获此 ID 的 `operations`；旧内容读取、实际写入、快照保存都发生在内置文件队列保护的 `writeFile` 内。前后快照按 toolCallId 存内存，双栏展示。
  - **重启/恢复后的口径**：状态重放遇到 `toolResult(toolName === "edit")` 时**优先读会话文件里持久化的 `details.patch`** 重建 diff 卡片，内存中的 `filechanges` 只是本进程内的兜底；write 的前后快照不持久化，重启后其卡片只显示"本次会话不可用"。README 已知限制写明这个不对称。
  - **不复用 Zetaphor 的 diff.ts 实现，只借它的虚拟文档 provider 写法。**
- **pi 包安装**（`packages.ts`）：`Pi: Install Package` 输入框接受 pi 原生格式（裸本地路径、git URL、`npm:name`），不发明 `path:` 前缀；调 `installAndPersist()`；构造时必须传 `{ cwd, agentDir, settingsManager }`。受限机上 `npm:` 与含 `package.json` 的 git 源会失败，命令捕获错误并提示"此源需要 npm，受限机不可用"。已知限制：本地路径源会被持久化为相对 `agentDir` 的相对路径，若源在扩展安装目录内（如 S9 用的 fixture），扩展升级后目录变化会让该包失效；README 写明。
- **pi 主题不映射到 webview**：webview 用 VS Code 主题变量。

### 5.4 打包

- `sync-pi-runtime.mjs`：定位 pi 包目录 `piDir = dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"))`，复制 5.1 列出的文件到 `pi-runtime/`。**chord 与 photon 不能按仓库根固定路径找**（本机它们嵌套在 pi 自己的 `node_modules/` 下，npm 是否提升取决于安装布局）：用 `createRequire(join(piDir, "package.json"))` 分别 `resolve("@earendil-works/chord/context")`、`resolve("jiti")` 和 `resolve("@silvia-odwyer/photon-node")`，向上找到各自的包根再整包复制（chord 剔除 map/src 后约 364 KB，jiti 1.7 MB）到 `pi-runtime/node_modules/` 下。**所有复制一律 `fs.cpSync(src, dest, { recursive: true, dereference: true })`**，否则 pnpm 布局下会把符号链接原样带进产物。脚本必须做的机械校验，任一失败即退出非零：
  1. **裸依赖扫描**：对 `dist/bundle/**/*.js` 匹配四种形状：无空白的 `from"X"`、`import"X"`、`import("X")`，以及**任意名字里含 `require` 的函数调用** `<ident>("X")`（打包器会把 `require` 重命名成 `require3`、`moduleRequire2`、`requireClipboard` 等，只匹配字面 `require(` 正是漏掉 jiti 的原因）。X 必须匹配 `^[A-Za-z@][A-Za-z0-9._@/-]*$`。每个 X 必须满足 `node:module` 的 `isBuiltin(X)`，或落在三档白名单之一：**必须复制** `@earendil-works/chord/context`、`jiti`、`@silvia-odwyer/photon-node`；**允许缺失（guarded）** `bufferutil`、`utf-8-validate`、`supports-color`、`@mariozechner/clipboard`；**仅错误字符串** `@aws-sdk/signature-v4-crt`。扫到任何未知标识符即失败。若 pi 升级后正则失效，改用 `es-module-lexer` + `cjs-module-lexer`（纯 JS）。
  2. **隔离 import**：把 `pi-runtime/` 复制到一个临时目录（其上层没有任何 `node_modules`），在那里 `node --input-type=module -e "import(...)"`，断言 `VERSION` 与 `getPackageDir()`。仓库目录里的 import 不算数。
  3. 复制后的树里**没有任何 `.node` 文件**。
  4. 资源路径全部存在可读：`dist/modes/interactive/theme/*.json`、`dist/core/export-html/template.html`、`docs/`、`dist/bundle/chunks/image-resize-worker.js`；`examples/`、`README.md`、`node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm`、`node_modules/@earendil-works/chord/dist/context/index.js` 存在。
  5. **`pi-runtime/src` 不存在**（见第 2 节 `getThemesDir()`）；**`pi-runtime/` 下没有任何符号链接**（`find -type l` 为空）。开发机上的隔离校验解析得了符号链接，受限机解析不了，所以这条必须是机械断言。
  6. 写入 `pi-runtime/.version`。
  7. **隔离加载扩展**：在第 2 条的同一个临时目录里，用临时 `agentDir`（空目录，避免混入用户扩展）和 `additionalExtensionPaths: [<test-fixtures/ext-smoke/index.ts 的文件路径>]` 按生产装配路径创建会话，断言 `runtime.services.resourceLoader.getExtensions().errors` 为空且 `extensionRunner.getRegisteredCommands()` 含 `smoke`。**只 import bundle 不会触发扩展加载路径，jiti 这类依赖只有这一步能在打包期暴露。**
- 扩展自身：esbuild bundle `src/extension.ts`，`platform: node`、`format: esm`，`external` 只留 `vscode`。**必须加 banner** `import { createRequire } from "module"; const require = createRequire(import.meta.url);`：undici 等 CJS 依赖内部 `require("node:assert")`，esbuild 的 ESM 输出默认把 CJS 的 `require` 换成抛 `Dynamic require of "node:assert" is not supported` 的 shim（实测），banner 提供真实 `require` 后正常。undici 打进 `dist/extension.js`（约 +1.1 MB）。**不把 pi 打进来**，pi 通过 `loader.ts` 动态 import `pi-runtime/dist/bundle/index.js`。
- 类型：devDependency 装 pi 以获得 `.d.ts`；`loader.ts` 把动态 import 的结果断言为 `typeof import("@earendil-works/pi-coding-agent")`。
- 锁定 pi **精确版本**（`0.85.1`）。`sync-pi-runtime.mjs` 把版本写进 `pi-runtime/.version`，`activate()` 校验它与 `VERSION` 一致。升级 pi 是独立任务，走单独验证。
- 扩展标识：name `jerrypi`，publisher `flyjancy`，需要在 Marketplace 创建该 publisher 并生成 PAT。
- **分发只走 Marketplace**，受限机不能拷入 .vsix。开发期用预发布版通道（版本号奇数次版本 0.1.x），受限机上安装时选 "Install Pre-Release Version"；正式版用偶数次版本（0.2.0 起），之后的预发布转入 0.3.x。**Marketplace 不允许覆盖已发布版本**：S0 用 0.1.0，S1 从 0.1.1 起，每次发布严格递增；**版本号必须是纯数字三段，不得带 `-beta` 之类后缀**（Marketplace 拒绝 semver 预发布后缀，预发布身份只靠 `--pre-release` 标记）。用户运行自测前先确认扩展页面显示的版本号与作者指定的一致并重载窗口。
- **发布的必须是已验收的同一个文件，且预发布标记在打包阶段写入**：预发布版先 `vsce package --pre-release --follow-symlinks` 得到 .vsix（标记写在 `extension.vsixmanifest` 的 `Microsoft.VisualStudio.Code.PreRelease` 属性，不在 `package.json`；publish 时检查该属性，缺失会拒绝。`--follow-symlinks` 是对 sync 脚本 dereference 的第二层保险），本地检查（.vsix **非 0 字节且能解包**；解包后含 `pi-runtime/`、Photon WASM、smoke fixture、无 `.node`；`extension.vsixmanifest` 含 PreRelease 属性；记录版本、文件大小、SHA-256），再 `vsce publish --packagePath <同一个 .vsix>`。正式版用不带 `--pre-release` 的 `vsce package`，验收后同样 `vsce publish --packagePath`。不允许用不带 `--packagePath` 的 publish 重新打包。
- **变更记录（`CHANGELOG.md`）推迟到第一个正式版**：0.1.x 全部走预发布通道，此时 changelog 的读者（真正的用户）还不存在，而 Marketplace 的 Changelog 标签页会把中英双语全文整段渲染出来（它不像 README 那样能按语言跳转）。在此之前，每个切片的变更记录就在 `docs/S*-plan.md` 里。到第一个非预发布版本（0.2.0）再建立 `CHANGELOG.md`，**从 0.2.0 起写**，更早的版本指向 `docs/S*-plan.md`。（0.1.4 那版曾写过一份双语 changelog，文本保留在提交 `8c944db`，需要时可直接取回。）
- **每个已发布版本打注解 tag**：`v0.1.0`…`v0.1.5` 指向**构建该产物的提交**，注解里写清产物字节数与 SHA-256。tag 在"从市场下载回来比对一致"之后才打，因此 tag 一定对应一份确实发布出去的产物；将来有人说"某个版本有问题"时能直接定位。
  - **比对用 `node scripts/compare-vsix.mjs <version>`，比的是内容不是字节**：`.vsix` 的字节**不可复现**（zip 里存文件 mtime，而 `dist/*.js` 每次重建 mtime 都变）。实测 0.1.5：同一棵树重建后 338 个文件逐个字节相同，整个 `.vsix` 的 SHA-256 不同。该脚本做的是"解包后文件列表 + 每个文件的 SHA-256 全等"。
  - **从市场 `curl` 下来的是 gzip 流**（响应头不带 `Content-Encoding`，curl 不解压），脚本会嗅探魔数自动解压 —— 0.1.5 核验时曾因此误判成"上传了旧包"，虚惊一场。
  - **留档**：脚本会把"确证已发布"的那一份复制到仓库外的 `~/jerrypi-releases/jerrypi-<version>.vsix`（`.vsix` 不进仓库）。
- `.vscodeignore` 排除 `src/`、仓库根 `node_modules/`、map 文件；**显式 `!pi-runtime/**`、`!pi-runtime/node_modules/**`、`!test-fixtures/**`**。vsce 的 `node_modules/` 排除规则会误伤 `pi-runtime/node_modules/`，所以必须显式取反。发布前检查（S0/S10）解包 .vsix 后断言 `pi-runtime/node_modules/@earendil-works/chord/dist/context/index.js`、`pi-runtime/node_modules/jiti/`、`.../photon-node/photon_rs_bg.wasm`、`test-fixtures/ext-smoke/index.ts` 都在包内，并在解包目录里再跑一次隔离 import 与隔离加载扩展（sync 脚本第 2、7 条）。预计体积（未压缩）：bundle 7.6 + photon 2.2 + docs 2.7 + jiti 1.7 + examples 1.3 + chord 0.4 + 主题/模板/README < 0.5 + 扩展自身 < 1 ≈ 18 MB，仍低于 30 MB 门禁。

## 6. 执行步骤

每步都可独立验证；括号内是验证方式。

- **S0 脚手架与发布链路** —— **状态：已实现（0.1.0）**。`package.json`（name `jerrypi`，publisher `flyjancy`，`engines.vscode ^1.123.0`，**必须含 `contributes.commands`（至少 `jerrypi.focusChat`），否则 vsce 因有 `main` 而无 `activationEvents`/`contributes` 直接拒绝打包**）、`tsconfig`、`esbuild.mjs`、`sync-pi-runtime.mjs`、空 `activate()` 注册该命令；`npm run package` 产出 .vsix；创建 publisher，按 5.4 的"同一文件"规则发布 0.1.0 空壳预发布版（已含 pi-runtime，验证体积与安装链路）。（Mac 上 F5 能看到 `Pi: Focus Chat`；`sync-pi-runtime.mjs` 全部 7 条校验通过；.vsix 解包到干净目录后无 `.node` 文件、chord/jiti/photon/fixture 都在、隔离 import 与隔离加载扩展都成功；受限机上能从 Marketplace 搜到并安装预发布版；记录受限机实测的 `process.versions.node` 与扩展页面显示的 VS Code 版本，若首个 Node 24 的 VS Code 版本不是 1.123 则修正 `engines`。）
- **S1 可行性闸门（Mac 上从 .vsix 跑一次；受限 Windows 机上从 Marketplace 预发布版跑一次）** —— **状态：已实现（0.1.1–0.1.3）**。实现 `loader.ts`、`runtime.ts`、`bindings.ts`、最小 `session.ts`，**以及最小版 `Pi: Set API Key`（写 SecretStorage 并 `setRuntimeApiKey`）与 `Pi: Open Settings File`**（从 S6 提前，因为受限机的 `~/.pi/agent/` 是空的且不能拷入文件；pi 内置 deepseek provider，只设 key 即可跑 T4），并加一个 `Pi: Run Self-Test` 命令，把结果写到 Output channel。输出格式固定：首行 `flyjancy.jerrypi <扩展版本> selftest-v1 <平台> node=<版本>`；随后每项一行 `T<编号> PASS|FAIL|SKIP <短错误码>`（T1–T9，第 5 项拆成 T5a/T5b/T5c）；末行 `GATE PASS` 或 `GATE BLOCKED <失败项列表>`。**只有全部 required 项 PASS 才是 GATE PASS，SKIP 不算通过；T5c 为 advisory，不参与判定**；作者核对首行版本号与自己发布的版本一致后才采信。Mac 通过后发布预发布版 0.1.1（之后每次递增），用户在受限机确认版本后运行自测，把结果逐行告诉作者。自测项：
  1. 打印 `process.versions.node`、`process.versions.electron`、VS Code 版本；断言 Node ≥ 24.15（对应声明下限 1.123）。
  2. 动态 import pi bundle 成功；`VERSION === "0.85.1"`；`getPackageDir()` 以 `pi-runtime` 结尾；5.4 sync 脚本第 4 条列出的全部路径存在可读（主题、导出模板、docs、examples、README、worker、photon wasm、chord context）。
  3. 扩展生命周期（本项在受限机上验证的是 **Windows 路径 + 扩展宿主 + 用户真实扩展共存** 三件事；jiti 等依赖是否齐全已由 sync 脚本第 7 条在打包期保证）：把 `test-fixtures/ext-smoke/` 复制到临时目录；按生产装配路径建会话：`createAgentSessionServices({ cwd, agentDir, modelRuntime: <runtime.ts 单例>, resourceLoaderOptions: { additionalExtensionPaths: [<临时目录>/index.ts 的文件路径] } })` → `createAgentSessionFromServices({ services, sessionManager, customTools: [wrappedWrite] })` → `createAgentSessionRuntime` → 对 `runtime.session` rebind（`bindExtensions()` + `subscribe()`）；断言 **`runtime.services.resourceLoader.getExtensions().errors` 中不含 smoke 路径**（用户自己扩展的错误单独列为诊断，不参与判定）、`session.extensionRunner.getRegisteredCommands()` 含 `smoke`、session_start 标记文件已写出；`prompt("/smoke")` 后第二个标记文件已写出；`prompt("/smoke-custom")`（该命令调用 `ctx.ui.custom()`）以可控错误结束并经 `onError` 上报，会话仍可用。结束后 `dispose()` 并删除临时目录。（G6。）
  4. 对真实 provider 发一条流式请求，收到 `text_delta`（验证 A6 网络前提；失败则按 5.3 第 2 层配置后重测，并同时跑宿主网络回归）。前置：用户已用 `Pi: Set API Key` 配好 deepseek 的 key（DeepSeek 实跑：空 agentDir + 仅 `setRuntimeApiKey("deepseek", key)` 即可选中内置 deepseek 模型并流式返回，前提是该单例真的传进了服务）；未配置时输出 `FAIL E_NO_CREDENTIALS` 并提示先设 key，这属于配置缺口而非能力缺口。
  5. 子进程与中止（验证 A3、G2 中止部分）：(a) `session.executeBash("echo hi && pwd")` 输出正确；(b) `session.executeBash("sleep 30")` 后 2 秒 `abortBash()`，断言 3 秒内返回且结果标记为中止；(c) `prompt("Run this exact bash command: echo JERRYPI_START_<随机串> && sleep 30")`，`tool_execution_start` 只用来关联 toolCallId，**收到该调用的输出里出现启动标记后**再计 2 秒调用 `session.abort()`，断言 `agent_end` 到达且该工具结果为中止（错误码 `E_NOT_ABORTED`）。60 秒内模型没有发起 bash 调用记 `SKIP E_NO_TOOLCALL`；发起了但没收到标记记 `FAIL E_NO_SPAWN`。**A3 的决定性证据是 5(a)/5(b)**（不经模型，直接 `executeBash`/`abortBash`）；**T5c 是 advisory 项，其 FAIL 或 SKIP 都不计入 GATE BLOCKED**，只记录供作者判断。
  6. 在临时目录依次通过 `prompt` 让 agent 调用 write → read → edit，断言磁盘内容与 edit 结果的 `details.patch` 非空。
  7. 创建持久会话，通过一次真实 `prompt("Reply with PONG")` 产生 user + assistant 各一条（pi 在第一条 assistant 消息前不落盘，只 append user 消息会假失败），`dispose()` 后 `SessionManager.continueRecent(cwd)` 重开，断言消息数 ≥ 2 且文件存在（验证 A4，G3）。
  8. 图片 worker 往返：以 `pi-runtime/dist/bundle/chunks/image-resize-worker.js` 的准确路径构造 `Worker`，`postMessage` 一张 3000×3000 PNG 的 `{ inputBytes, mimeType, options }`，10 秒超时内收到含缩小尺寸的结果，然后 `terminate()`。另外单独调 `resizeImage()` 断言尺寸变小，两者都要过。
  9. 会话替换（新增，覆盖 S5 与 `commandContextActions` 的真实路径）：在第 7 项的 runtime 上 `await runtime.newSession()` → rebind，断言 `runtime.session` 是新对象、会话文件路径不同、smoke 扩展的 session_start 标记再次写出、`getRegisteredCommands()` 仍含 `smoke`；再 `await runtime.switchSession(<第 7 项的会话文件>)` → rebind，断言历史消息数与第 7 项一致且事件订阅仍能收到 `agent_start`。

  **闸门规则：除 T5c 外的全部 required 项（T1–T9）在受限 Windows 机上任一非 PASS，即 GATE BLOCKED，不进入 S2，回到第 4 节重新决策。**（**2026-09-13 补记**：S5 给闸门加了 T10/T11/T12，所以现在共 **14 项 = 12 gating + 2 advisory（T5c/T12）**；见 `docs/S5-plan.md` 的 §6 与 §11。） T5a/T5b 失败意味着 A3 不成立，需用户决定是否接受"只读 agent"。
- **S2 协议与基础聊天** —— **状态：已实现（0.1.4）**。`protocol.ts`、`chatView.ts`、webview 输入框 + 流式文本 + 思考块 + 中止按钮 + 流式期间的 steer/followUp 发送 + 队列条 + 面板重开时的状态重放。（验收：多轮对话；折叠再展开面板不丢历史；流式期间发送不出现 "Agent is already processing" 错误，消息进入队列条；队列非空时 `agent_end` 后输入仍禁用，直到 `agent_settled`；喂入 `<img src=x onerror=…>`、`<script>…</script>`、`[x](javascript:alert(1))` 三种内容，断言不执行、标签以文本显示、链接被降级为纯文本。）
- **S3 工具调用卡片**：bash / read / edit / write 的调用参数与结果展示，可折叠，bash 输出流式更新，点击文件路径打开文件。（让 agent 列目录并改一个文件，G2。）
  **状态：已实现（0.1.5）**。实现记录与验收清单见 [`S3-plan.md`](S3-plan.md)；diff 渲染（`edit` 的 patch）与工具审批按原计划留给 S7/S8。
- **S4 模型与思考等级**：模型选择器（QuickPick）、思考等级切换、状态栏显示模型与上下文用量。（G4。）—— **状态：已实现（0.1.6）**。
- **S5 会话管理** —— **状态：已实现（0.1.7）**：新建（`runtime.newSession()`）、列表（`SessionManager.list(cwd, sessionDir)`，`sessionDir` 从生效的 agentDir 推导为 **`<agentDir>/sessions/--<编码 cwd>--`** —— 见下面的修正注）、恢复（`runtime.switchSession(path)`）、显示会话名；每次替换后 rebind；VS Code 重启后**自动 `continueRecent(cwd, sessionDir)`**；忙时替换先弹确认；替换后宿主全量重放。（G3。）
  > ⚠️ **2026-09-13（S5 实施期）修正**：本行原先写的是 `<agentDir>/sessions`（把 pi 的 `sessionDir` 参数当成了"sessions 根"），**那是错的** —— 那个参数是"**直接装 `.jsonl` 的目录**"（`session-manager.js:1127` 直接 `join` 文件名）。按原写法会话会平铺在根上，`pi --resume` 与 pi 自己的 `listAll()` 都看不到（实测：`list(cwd)` 5 条 / `list(cwd, 平铺目录)` 0 条）。已修：`src/pi/sessions.ts` 的 `resolveSessionDir` 复刻 pi 的编码规则，并用自测 T10/T11/T12 钉住它。详见 `docs/S5-plan.md` 的 §3.1 与 §11。
- **S6 设置与密钥**：三项 VS Code 设置、`Pi: Clear Stored API Keys`，并把 S1 的最小版 `Pi: Set API Key` / `Pi: Open Settings File` 补完整（provider 选择、校验）。（清空 `models.json` 里的 key 只靠 SecretStorage 也能完成对话。）**状态：已关闭（0.1.8，2026-09-14）** —— `jerrypi.agentDir` 已生效（进程环境变量 + 重载窗口）；`approvalMode` 只登记（S8）；`proxy` 未实现（Q2 不做第二层，T13 只报告）；另有 `Pi: Refresh Model Catalog`（点了才联网）。Mac（M1/M2）与 Windows（W0/W1）都验过；M1 真机抓到并修了两个真问题（通知 markdown、读设置 section/key 搞反）。断言与发现见 `docs/S6-plan.md` §6/§11/§12。
- **S7 diff 审阅**：`filechanges.ts` + `diff.ts`。（验收：让 agent 在**同一条消息里**对同一文件发出两次 edit，两张卡片各自只显示该次 patch；同一条消息里两次 write 同一文件，两张卡片前后内容各自正确；重启 VS Code 恢复会话后，edit 卡片的 diff 仍可打开，write 卡片显示"本次会话不可用"。）
- **S8 工具审批开关**：`approval.ts`，三档。（开 `all` 后每次工具调用停在面板等确认；拒绝后 agent 收到 block 原因；待审批时点中止，待审批项被清除且 agent 结束。）
  > **2026-09-14 用户拍板追加**：项目级设置的**信任流程**（今天固定 `projectTrusted: false`，面板里没有“信任这个项目”的选择）也排进本阶段 —— 与工具审批同属“信任”主题。本条**未经评审、未设计**：具体形态（提示时机、写不写 `trust.json`、与 pi CLI 的 `ProjectTrustStore` 怎么对齐）留到 S8 计划期按流程走。
- **S9 pi 包管理**：`Pi: Install Package` / `Pi: List Packages` / `Pi: Remove Package`。（Mac 上：安装 `../pi-config`（裸路径）后 `~/.pi/agent/settings.json` 出现该包，重启后其主题/扩展被加载。受限机上：用随扩展发布的 `test-fixtures/ext-smoke` 目录作为本地包源验证同一流程，因为该机无法拷入 pi-config；验收只要求"本次安装后重启可用"，扩展升级后失效属已知限制。输入 `npm:xxx` 得到明确的"需要 npm"错误。）
- **S10 Windows 全量验收与正式发布**：发预发布版，用户在受限机上跑 G1–G6 并回报；通过后以偶数次版本按 5.4 规则打正式包并 `vsce publish --packagePath` 发布；写 README（安装、密钥、Git Bash 要求、全权限警告、npm 源限制、SigV4a 限制）。

## 7. 风险、影响范围与回滚

| # | 风险 | 应对 |
|---|---|---|
| R1 | pi bundle 的硬依赖（chord、jiti、photon）漏复制，或可选依赖（bufferutil、clipboard 等）缺失时抛错而非降级；Bedrock SigV4a 属按需能力限制 | S1 第 2–4 项覆盖普通 provider 路径；SigV4a 记入 README 限制；`sync-pi-runtime` 断言无 `.node` |
| R2 | pi 版本漂移导致 API 或 bundle 布局变化 | 锁精确版本；`.version` 校验；升级单独做 |
| R3 | 复刻的包布局仍有资源定位失效（worker、wasm、themes、模板）或 pi 升级后新增外部依赖 | `sync-pi-runtime.mjs` 的裸依赖扫描 + 隔离 import + 资源路径断言；S1 第 2、8 项 |
| R4 | Windows 上 ESM 扩展路径问题 | 回退 CJS + 适配后的 shim |
| R5 | 受限网络需要代理或企业 CA；第 2 层代理会改全局 fetch | 5.3 两层策略，第 2 层 opt-in 且带宿主回归验收；CA 问题可能无解，S1 第 4 项尽早暴露 |
| R6 | 受限机策略禁止 VS Code spawn `bash.exe` | S1 第 5 项；失败则降级为只读 agent，交用户决策 |
| R7 | Marketplace 体积或审核问题 | 受限机无法侧载，此路不通；只能减体积（去掉 docs/、只留必要主题）或拆分 |
| R8 | agent 默认全权限执行命令，误操作风险 | README 明示；审批开关；不做任何"自动信任"之外的放权 |
| R9 | Webview 渲染安全：CSP 之外，`marked` 默认不消毒，agent 输出/文件内容/bash 输出里的 HTML 与 `javascript:` 链接会在 webview 执行 | nonce + 只加载本地资源 + 图片 data URI；`render.ts` 照抄 pi export-html 模板的 `marked.use` 消毒配置（HTML token 置 undefined、link/image scheme 白名单、escapeHtml）；S2 验收含 XSS 用例 |
| R10 | 扩展宿主被长时间同步工作阻塞 | pi 内部已是异步；图片缩放走 worker；扩展层不做同步 IO |
| R11 | 受限机 VS Code 版本 < 1.123 | 用户已确认可升到最新；README 写明下限与原因（Node 22 档未实测） |

**影响范围**（分三类，卸载扩展只撤销第一类）：

1. 扩展自身：扩展安装目录卸载即清除；VS Code 配置项与 SecretStorage 里的 key **卸载不会自动清除**，提供 `Pi: Clear Stored API Keys` 命令，配置项由用户在 settings 里删除。
2. agent 工具的副作用：edit/write 修改工作区文件，bash 可执行任意命令、访问任意路径。**这些改动卸载扩展不会撤销**，和用 pi CLI 完全一样。
3. pi 生态状态：`~/.pi/agent/` 下的会话、settings.json（包安装会改）、已安装的包目录。**首次打开面板时 `ModelRuntime.create` 会自动创建 `~/.pi/agent/` 并写入 `auth.json` 与 `models-store.json`**，README 要提前说明，免得受限机用户觉得可疑。卸载扩展不会撤销；与 CLI 共享，可用 CLI 或手动清理。

**回滚**：扩展本身卸载即可。会话文件是追加写入的 JSONL，与 CLI 兼容。工作区文件改动依赖 git 或 S7 的 diff 手动回退。

## 8. 范围外与后续可做

- DSH（DeepSeek Harness）插件：同一 .vsix 骨架可复用，但需先解决 node-pty 原生 ABI 与 Cordis 插件加载，另立计划。
- 多 tab 并行会话。
- checkpoint 级整轮回滚（Zetaphor 有实现）。
- 编辑器上下文桥：把选区、诊断发给 agent。
- pi 主题映射到 webview。
- provider OAuth `/login` 流程。
- `powershell` 工具的 UI 适配与"只读 agent"降级模式（仅当 R6 触发）。

## 9. 用户决策（2026-09-10 已回答）

- **Q1 分发方式**：Marketplace。受限机不能拷入文件，因此没有 .vsix 侧载回退；开发期用预发布版通道做受限机验证。
- **Q2 扩展标识**：name `jerrypi`，publisher `flyjancy`。
- **Q3 审批默认档位**：用户不熟悉该概念，采纳作者建议：默认 `off`，与 CLI 行为一致，提供开关。
- **Q4 diff 审阅**：采纳作者建议：进 v1。
- **Q5 早期验证**：用户无法往受限机拷文件。改为发布预发布版到 Marketplace，用户在受限机安装后运行 `Pi: Run Self-Test` 并口头回报每项结果。
- **Q6 VS Code 版本**：可升到最新（1.137，Node 24.18.1）。据此把声明下限定为 1.123（首个 Node 24 版本），不承诺未实测的 Node 22 档。

## 评审记录

### 第 1 轮（2026-09-10，评审者 jp-pi-vscode，Codex 只读）

VERDICT: BLOCKING（4 B / 6 S / 1 N）

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| B1 | S1 只发一句 prompt，不触发 bash/文件/会话恢复，无法验证 A3/A4 | ACCEPT | S1 重写为 8 项自测闸门，要求在受限机上从已安装 .vsix 跑；G2/G3 补中止与重启恢复 |
| B2 | 自己 bundle `dist/index.js` 会走非 bundled 扩展加载路径，`require.resolve`/`import.meta.resolve` 失效 | ACCEPT | 核实属实。方案改为原样消费 pi 官方 `dist/bundle/`（`PI_BUNDLED_NODE=true`，虚拟模块分支）；第 2、4.2、5.4 节重写；S1 第 3 项与 G6 验证 TS 扩展加载 |
| B3 | `activate()` 里设 `PI_PACKAGE_DIR` 晚于 `config.js` 顶层读包元数据 | ACCEPT | 核实属实。改为绝不静态 import pi，`loader.ts` 动态 import；复刻包布局让 `findNodePackageDir` 直接命中；S1 第 2 项断言 VERSION |
| B4 | `engines ^1.100` 对应 Node 20.19，不满足 pi ≥ 22.19 | ACCEPT | 查 vscode-versions：1.105 是首个 Node 22.19.0 版本。engines 改 `^1.105.0`；新增 Q6、R11；S1 第 1 项记录 `process.versions` |
| S1 | worker 复制方案漏传递依赖与 WASM，且失败会被静默回退掩盖 | ACCEPT | 用官方 bundle 后 worker 在 chunks 内自带；photon-node 含 wasm 整包复制；S1 第 8 项直接构造 Worker 验证 |
| S2 | `HTTPS_PROXY` 透传不是已成立的方案；SDK 不装 dispatcher | ACCEPT | 核实 `configureHttpDispatcher` 未导出且仅 CLI 调用。5.3 改为两层策略（VS Code 自身代理设置 → 扩展自带 undici EnvHttpProxyAgent）；网络验证提前到 S1 第 4 项；CA 问题记为已知限制 |
| S3 | `path:` 前缀不存在；`install()` 不持久化；git 源也可能要 npm | ACCEPT | 核实属实。改用 pi 原生源格式与 `installAndPersist`；S9 验收改为重启后实际加载；npm/git 限制写进 README |
| S4 | 审批缺少取消生命周期与 mutating 定义 | ACCEPT | 5.3 补四种取消路径、mutating 覆盖集（未知工具默认确认）；S8 验收加"待审批时中止" |
| S5 | Zetaphor diff 不是按调用的前后对比 | ACCEPT | 核实其用首次原文 + 当前磁盘。改为自写 `snapshots.ts` 按 toolCallId 存前后快照；S7 验收改为连续两次 edit 分别查看 |
| S6 | 影响范围与回滚低估副作用 | ACCEPT | 第 7 节改为三类影响，明确卸载只撤销扩展自身 |
| N1 | CJS 回退引用的 shim 只匹配旧包名 | ACCEPT | A2、4.2 改为"需适配和重新验证的参考实现" |

STRONGEST_OBJECTION（本轮）：S1 把"能聊天"当成"嵌入方案成立"，不覆盖子进程、worker/WASM、扩展解析这些最可能推翻方案的路径。→ 已由 B1/B2/S1 的处置覆盖。

本轮之后新增的、评审者尚未复核的内容：第 4.1 方案切换到官方 bundle（含第 2 节新增的 bundle 外部依赖清单）、5.3 网络两层策略、5.3 快照式 diff、S1 八项闸门。请第 2 轮重点复核这些。

### 第 2 轮（2026-09-10）

VERDICT: BLOCKING（1 B / 5 S / 2 N）

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| B5 | S1 引用不存在的 API（`getThemesDir`、`getCommands`），bash 中止 API 配对错误，worker 路径与验证方式不成立 | ACCEPT | 全部核实。S1 第 2、3、5、8 项重写：用 `getPackageDir()` 拼路径；`extensionRunner.getRegisteredCommands()`；`executeBash`/`abortBash` 配对并补 agent 驱动的 `session.abort()`；worker 用 chunks 准确路径做 postMessage 往返并设超时 |
| S7 | undici 跨副本共享结论缺版本条件，槽位应为 `.2` 主 `.1` 兼容 | ACCEPT | 核实 bundle 内两个槽位都出现。第 2 层不再依赖 `setGlobalDispatcher`，改为包装 `globalThis.fetch`；第 2 节补充事实 |
| S8 | 第 2 层 `undici.install()` 替换整套全局对象，破坏宿主与其他扩展 | ACCEPT | 核实 pi-ai 的 `fetch` 选项无法从 SDK 注入。第 2 层改为 opt-in、只包装 fetch、不 install、不改 dispatcher，并加宿主网络回归验收 |
| S9 | 按 toolCallId 在事件回调读盘做快照，在并行执行下会串 | ACCEPT | 核实并行分支先发整批 start。edit 改用 `EditToolDetails.patch`（执行边界内生成）；write 先验证自定义工具替换内置 + 包装 `operations`，不成立则注明限制；S7 验收改为同一消息内两次修改 |
| S10 | `createAgentSession` 不绑定扩展，`extensionsResult.errors` 不代表生命周期正常 | ACCEPT | 核实 sdk.js 不调 `bindExtensions`，rpc/print 模式自己调。新增 `bindings.ts`；S1 第 3 项要求 session_start 与命令执行各写标记文件 |
| S11 | smoke 扩展永久放进用户全局扩展目录 | ACCEPT | 改用临时目录 + `additionalExtensionPaths`，结束清理，诊断分开报告 |
| N2 | AWS CRT 不是实际外部加载依赖 | ACCEPT | 第 2 节与 R1 改为"按需能力限制" |
| N3 | 卸载不会清除配置与密钥 | ACCEPT | 第 7 节改写；S6 增加清除密钥命令 |

STRONGEST_OBJECTION（本轮）：S1 自身不可执行，闸门数量不代表覆盖有效。→ 已由 B5/S10/S11 的处置覆盖。

本轮之后新增的、评审者尚未复核的内容：5.3 扩展绑定条目、网络第 2 层的"只包装 fetch"方案、diff 的 patch/替换工具方案、S1 第 3/5/8 项的新写法。

### 第 3 轮（2026-09-10，最后一轮）

VERDICT: BLOCKING（1 B / 5 S / 0 N）

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| B6 | S1 第 3 项的 `DefaultResourceLoader` 缺必需的 `cwd`/`agentDir`，且传入现成 loader 时 `createAgentSession` 不会 `reload()` | ACCEPT，**本条修复未经复核** | 核实 sdk.js 第 75–77 行只对自建 loader 调 reload。S1 第 3 项改为显式顺序；第 2 节补事实 |
| S12 | uiContext 最小实现不满足 `ExtensionUIContext` 必填字段；`ExtensionCommandContextActions` 也有必需项 | ACCEPT | 核实 types.d.ts。5.3 改为以官方 rpc 的 `createExtensionUIContext()` 为蓝本提供完整对象，明确 no-op 与取消语义 |
| S13 | 只替换 fetch 会导致跨 undici 实现的 `Request` 不兼容 | ACCEPT | 第 2 层包装器对非字符串/URL 输入委托原 fetch；加 deactivate 恢复与连接释放；验收加原 `Request` 输入与 body/signal 用例 |
| S14 | edit patch 反向应用不能还原真实文件 | ACCEPT | 简化为只展示 patch |
| S15 | write 同名覆盖已可确认，但 operations 层没有 toolCallId | ACCEPT | 核实 `_refreshToolRegistry` 覆盖与 `createWriteToolDefinition` 导出。改为外层 execute 捕获 toolCallId 再构造 operations；删除"替换不成立"的回退 |
| S16 | S1 5(c) 从 prompt 计时会把模型慢误判为 A3 失败 | ACCEPT | 改为等 `tool_execution_start` 后计时；分开报告"模型未调用工具"与"子进程未能中止" |

STRONGEST_OBJECTION（本轮）：全局 fetch 包装即使 opt-in 仍有跨实现兼容风险，字符串 URL 成功不足以验收。→ 已按 S13 处置；该层默认关闭，不阻断默认方案。

**收敛状态**：撞到 3 轮上限。第 3 轮的 BLOCKING（B6）在评审结束后修入，没有第二双眼睛看过；其余 5 条 SHOULD-FIX 的修复同样未经复核。评审者三轮都没有对第 4.1 选定方案本身提出反对，所有 BLOCKING 都指向 S1 闸门的可执行性与实现细节。

**留给用户裁决的未解决分歧**：无。评审者与作者没有持续两轮的对立意见。第 9 节 Q1–Q6 已由用户回答，Q3/Q4 按作者建议定。

### 第 4 轮（2026-09-10，用户要求追加）

VERDICT: BLOCKING（1 B / 5 S / 1 N）。评审者确认第 3 轮的 loader 顺序、edit 只展示 patch、write 按调用构造 operations 已正确落地。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| B7 | S0 与 S1 都发 0.1.0，Marketplace 不允许覆盖 | ACCEPT | 5.4/S0/S1：0.1.0 空壳，S1 起 0.1.1 递增，正式 0.2.0，后续预发布 0.3.x；用户运行前核对版本 |
| S17 | 口头回报缺版本身份、固定编号、SKIP 语义 | ACCEPT | S1 输出格式固定为首行身份 + `T<n> PASS/FAIL/SKIP <错误码>` + `GATE PASS/BLOCKED`；SKIP 不算通过 |
| S18 | 本地验收的 .vsix 与实际发布产物没绑定 | ACCEPT | 5.4：发布必须 `--packagePath` 同一文件，记录大小与 SHA-256 |
| S19 | `custom<T>()` 没有统一取消值 | ACCEPT | 实现为 reject 的 `Promise<never>`；S1 第 3 项加 `/smoke-custom` 分支 |
| S20 | 恢复 fetch 会覆盖别的扩展后装的包装器 | ACCEPT | 只在仍是自己的包装器时恢复，否则切为纯委托；在途请求结束后再关代理；验收加顺序用例 |
| S21 | `tool_execution_start` 不等于 bash 已 spawn | ACCEPT | 5(c) 改为命令先回显唯一标记，收到标记后再计时；错误码区分 `E_NO_TOOLCALL`/`E_NO_SPAWN`/`E_NOT_ABORTED` |
| N4 | G1 仍写侧载；S9 在受限机上依赖不存在的 pi-config 目录 | ACCEPT | G1 删侧载；S9 受限机改用随扩展发布的 fixture 目录 |

STRONGEST_OBJECTION（本轮）："口头 PASS"无法绑定版本且 SKIP 未闭合。→ 已由 S17 处置。

### 第 5 轮（2026-09-10，追加复核的最后一轮）

VERDICT: BLOCKING（1 B / 0 S / 0 N）。评审者复核第 4 轮全部修复已落地，全文通读未发现其他阻断。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| B8 | 预发布标记由 `vsce package --pre-release` 写入包内，普通打包再 `publish --pre-release` 会被拒 | ACCEPT，**本条修复未经复核** | 核实 vsce 3.9.2 publish.js 检查包内标记。5.4/S10 改为预发布与正式分别用对应的 package 命令，publish 一律 `--packagePath` |

STRONGEST_OBJECTION（本轮）：B8 阻断唯一发布通道。→ 已处置。评审者声明其结论基于只读静态核查，不代表受限 Windows 实测通过。

**最终收敛状态**：5 轮后停止（3 轮上限 + 用户追加 2 轮）。第 5 轮 B8 的修复未经复核。没有双方僵持的分歧。

### DeepSeek 复核第 1 轮（2026-09-11，pi 会话 deepseek-flash，用户自行发起，**实跑核查**；本节编号前缀 D1-）

VERDICT: BLOCKING（1 B / 3 S / 2 N）。与 Codex 五轮的区别：它把 bundle 拷到干净目录实际 import 了一次。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| B1 | bundle 静态 import `@earendil-works/chord/context`，只复制 bundle 无法加载 | ACCEPT | 作者隔离目录复现：无 chord 时 `ERR_MODULE_NOT_FOUND`，补 chord 后 OK。第 2 节更正；5.1 加 chord；5.4 sync 脚本加裸依赖扫描与隔离 import；S0 加解包后隔离 import |
| S1 | 手拼主题路径是对 pi 内部布局的二次推断 | ACCEPT | S1 第 2 项与 sync 脚本改为断言四个资源路径存在可读 |
| S2 | `.vscodeignore` 未显式包含 `test-fixtures/**`；`node_modules/` 排除会误伤 `pi-runtime/node_modules/` | ACCEPT | 5.4 显式取反三条；S0 解包检查精确到 chord/wasm/fixture 路径 |
| S3 | 5(c) 把模型配合度与 spawn 策略耦合 | ACCEPT | A3 决定性证据改为 5(a)/5(b)；5(c) 允许 SKIP 不阻断 |
| N1 | `PI_PACKAGE_DIR` 双保险会掩盖 A8 验证 | ACCEPT | 去掉双保险；A8 改为断言 `getPackageDir()` 命中 `pi-runtime` |
| N2 | 评审记录应标注每轮验证手段 | ACCEPT | 见下表 |

**各轮验证手段**：Codex 第 1–5 轮均为只读静态核查（读 d.ts/js 源码与文档），未执行过 import 或解包；作者在第 1 轮前用 esbuild 自打包产物跑过一次 Node 26 进程内启动，但那不是官方 bundle 的隔离 import。DeepSeek 一轮为实跑（隔离目录 import）。**教训：依赖解析类问题必须执行验证，本计划已把它落成 `sync-pi-runtime.mjs` 的机械校验与 S0 的解包门禁。** 作者第 1 轮前用 grep 列外部依赖时因 `head -40` 截断漏掉了 chord，这是本次错误的直接原因。

### DeepSeek 复核第 2 轮（2026-09-11，实跑核查；本节编号前缀 D2-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 3 S / 3 N）。确认上一轮 B1/N1 及 Codex B6 的修复成立，并逐一复核了 `SessionManager.list`、`ModelRuntime`、`executeBash/abortBash`、`customTools`、`ToolDefinition.execute` 签名、`EditToolDetails.patch` 与计划一致。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| S1 | 朴素正则扫描压缩产物会命中 18 条伪 import，脚本恒失败 | ACCEPT | 作者复现：严格无空白 + 形状正则正好得到 33 个真实标识符。5.4 第 1 条改为严格正则 + `isBuiltin` + 白名单，备选 es-module-lexer |
| S2 | chord/photon 在本机嵌套在 pi 的 node_modules 下，按仓库根固定路径复制会 ENOENT | ACCEPT | 核实位置。5.4 改为 `createRequire(pi/package.json).resolve()` 定位包根 |
| S3 | 声明下限 1.105（Node 22.19）从未实测 | ACCEPT，选"上调下限" | 受限机可升到最新，没必要承诺未测区间。`engines.vscode ^1.123.0`（首个 Node 24 版本）；G1/A1/R11/Q6 同步 |
| N1 | 体积账目偏小；examples/README 路径会进系统提示但未复制 | ACCEPT | 核实 docs 2.7 MB、examples 1.3 MB。一并复制 examples/README；体积估计改为 ≈ 16 MB |
| N2 | `getThemesDir()` 看 `pi-runtime/src` 是否存在 | ACCEPT | 核实实现。sync 脚本加"`src/` 不存在"断言；第 2 节补充说明 |
| N3 | 闸门措辞自相矛盾 | ACCEPT | T5c 明确为 advisory，不计入 GATE BLOCKED |
| 附 | 第 2 层 undici 验收要针对打进产物的那份 | ACCEPT | 5.3 补一句 |

DeepSeek 结论：修掉 S1–S3 后可进入 S0 实施。三条均已修入，**本轮修复未经复核**。

### DeepSeek 复核第 3 轮（2026-09-11，实跑核查：在隔离 pi-runtime 里真实加载扩展；本节编号前缀 D3-）

VERDICT: BLOCKING（1 B / 3 S / 3 N）

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| B1 | `jiti` 未打进 bundle，`require3("jiti")` 是硬依赖，`.js`/`.ts` 扩展加载全部失败 | ACCEPT | 作者隔离目录复现：缺 jiti 时 smoke 与用户两个扩展全报 `Cannot find module 'jiti'`，补上后全部注册。第 2 节更正；5.1/5.4 加 jiti；体积改 ≈ 18 MB |
| S1 | 依赖扫描要匹配重命名后的 require；隔离校验应升级为真实加载扩展 | ACCEPT | 5.4 第 1 条改为匹配任意含 `require` 的调用，白名单分三档；新增第 7 条隔离加载扩展；S0 解包检查同步 |
| S2 | `additionalExtensionPaths` 传目录时入口必须是 `index.ts` | ACCEPT | 实跑确认。fixture 入口定为 `index.ts`，S1 与 sync 脚本都传文件路径 |
| S3 | `extensionsResult.errors` 为空的断言会被用户扩展的错误误判 | ACCEPT | 实跑确认会混入用户扩展。改为"不含 smoke 路径"；G6 同步 |
| N1 | bundle 对 `@mariozechner/clipboard` 有 guarded require | ACCEPT | 核实。第 2 节更正，白名单"允许缺失"档加入 |
| N2 | 体积再更新 | ACCEPT | ≈ 18 MB |
| N3 | S1 第 3 项在受限机上的定位应聚焦 Windows + 宿主 + 用户扩展 | ACCEPT | S1 第 3 项开头写明 |

**教训（第二次同类错误）**：作者第 1 轮前 grep 到 chunk 里有 `createJiti` 就写了"jiti 已打进 bundle"，实际那是 `require3("jiti").createJiti` 的调用。上一轮新增的隔离 import 只验证了 `import bundle`，没有触发扩展加载路径，所以也没抓到。依赖完整性的验证必须覆盖**每一条运行时路径**（import、扩展加载、图片 worker、bash spawn），现已把扩展加载落成 sync 脚本第 7 条。本轮修复未经复核。

### DeepSeek 复核第 4 轮（2026-09-11，实跑核查；本节编号前缀 D4-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 3 S / 4 N）。确认 D3 的 jiti 修复与新的依赖扫描规格正确（按字面复跑得到 8 个非内置标识符，全部落在三档白名单）。同时实跑通过：S8 审批阻塞与 `ctx.signal` 取消、T5b/T5c bash 中止、T8 图片 worker 往返、T4 deepseek 流式、同名 write 覆盖内置、`/smoke-custom` 错误路径、`/smoke` 命令触发。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D4-S1 | T7 只 append user 消息不会落盘，pi 在首条 assistant 消息前不写文件 | ACCEPT | 核实 `_persist` 实现。T7 改为真实 `prompt` 产生 assistant 消息；G3 注明限制；第 2 节补事实 |
| D4-S2 | `cp -R`/`cpSync` 默认保留符号链接，pnpm 布局下产物失效且开发机校验假通过 | ACCEPT | 实测 `dereference: true` 才复制内容。sync 脚本统一 dereference；第 5 条加"无符号链接"断言 |
| D4-S3 | T4 需要凭据，但 `Pi: Set API Key` 在 S6，受限机 `~/.pi/agent/` 为空 | ACCEPT，选方案一 | 核实 pi 内置 deepseek provider。最小版 Set API Key / Open Settings File 提前到 S1；T4 无凭据时 `FAIL E_NO_CREDENTIALS` 并提示 |
| D4-N1 | S0 仍写"四项校验" | ACCEPT | 改为"全部 7 条" |
| D4-N2 | `DefaultPackageManager` 构造需 `{cwd, agentDir, settingsManager}`；本地源持久化为相对路径，扩展升级后失效 | ACCEPT | 核实 d.ts。5.3/S9 写明；列为已知限制 |
| D4-N3 | 1.123 = Node 24.15 是单一数据源 | ACCEPT | S0 记录受限机实测版本，不符则修正 `engines` |
| D4-N4 | 各轮编号重名 | ACCEPT | DeepSeek 各轮加 D<n>- 前缀 |

本轮修复未经复核。

### DeepSeek 复核第 5 轮（2026-09-11，实跑核查：会话替换路径与真实 vsce 打包；本节编号前缀 D5-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 2 S / 3 N）。实跑通过：vsce 预发布标记与 `--packagePath` 校验、`.vscodeignore` 取反、G3 CLI 真能 `--session` 读取 SDK 生成的会话、G4 `setModel` 生效、edit 结果 details 含 patch、依赖扫描规格按字面复跑正确。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D5-S1 | `newSession`/`switchSession` 不在 `AgentSession` 上，计划缺 `AgentSessionRuntime`；S1 装配路径与生产不一致；无一项覆盖会话替换 | ACCEPT | 核实 d.ts 与 rpc 模式。5.1/5.3 改为 `session.ts` 包装 runtime、统一装配路径、替换后 rebind；`commandContextActions` 委托 runtime；S1 T3 改按生产路径；新增 T9 会话替换 |
| D5-S2 | S0 的 `package.json` 无 `contributes`/`activationEvents`，vsce 拒绝打包 | ACCEPT | S0 明确必须含 `contributes.commands` |
| D5-N1 | 预发布标记在 `extension.vsixmanifest`；版本号不得带 `-suffix` | ACCEPT | 5.4 写明；本地检查改为查 manifest 属性 |
| D5-N2 | 符号链接会让 vsce 打包失败并留下 0 字节 .vsix | ACCEPT | 打包加 `--follow-symlinks`；本地检查加"非 0 字节且能解包" |
| D5-N3 | `SessionManager.list(cwd)` 省略 `sessionDir` 不跟随自定义 agentDir | ACCEPT（**结论错，2026-09-13 由 S5 修正**） | 当年的落点是"S5 与 `sessions.ts` 统一传 `<agentDir>/sessions`" —— 察觉了风险，但选出的值用的是同一套错误理解（那个参数要的是**装 `.jsonl` 的目录**）。现在传的是 `resolveSessionDir(cwd, sessionsRoot)` = `<agentDir>/sessions/--<编码 cwd>--`。**教训：多轮评审能抓"论证不自洽"，抓不到"对上游参数的语义理解错" —— 后者只能靠实跑对照上游实现。** |

本轮修复未经复核。

### DeepSeek 复核第 6 轮（2026-09-11，实跑核查：T9 会话替换、S7 并行写快照、代理层二打包；本节编号前缀 D6-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 1 S / 1 N）。实跑通过：按 5.3 装配路径的 T9 全链路（newSession 后 session_start 再触发、命令仍在、switchSession 回旧会话历史恢复）；按 5.3 包装的 write 工具在同一条消息里两次写同一文件，`withFileMutationQueue` 串行化后两张快照各自正确；`write` 无 details、`edit` 有 patch。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D6-S1 | esbuild ESM 输出打进 CJS 的 undici 会在运行时报 `Dynamic require of "node:assert"` | ACCEPT | 作者复现：无 banner 报错，加 `createRequire` banner 正常。5.4 写明 banner 为必需 |
| D6-N1 | undici 版本不要写"随大版本"，应锁精确版本 | ACCEPT | 5.3 改为 devDependencies 锁精确版本 |

本轮修复未经复核。DeepSeek 指出剩余未实测面：Webview UI 与 diff 虚拟文档（需有 UI 的环境）、第 2 层代理的真实企业网络回归，均已在 S2/S3/S7 与 R5 的验收里。

### DeepSeek 复核第 7 轮（2026-09-11，实跑核查：S2 输入/队列语义与转发事件名；本节编号前缀 D7-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 2 S / 0 N）。确认 5.2 转发的事件名在 pi 0.85.1 bundle 里全部真实存在；`agent_settled` 在 `agent_end` 之后触发一次。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D7-S1 | 流式期间再 `prompt()` 会抛错，计划未定义 webview 发送语义 | ACCEPT | 核实 `PromptOptions.streamingBehavior` 流式时必填。5.2 新增第 5 条发送语义；S2 验收补充 |
| D7-S2 | 转发列表缺 `agent_settled`，UI 空闲态不应以 `agent_end` 为准 | ACCEPT | 5.2 事件清单加 `agent_settled`，新增第 6 条空闲判定；S2 验收补充 |

本轮修复未经复核。

### DeepSeek 复核第 8 轮（2026-09-11，实跑核查：runtime 装配路径的参数接线；本节编号前缀 D8-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 2 S / 0 N）。实跑确认：sync 脚本第 7 条在空 agentDir、无凭据下可跑通（model 为占位但不抛错）；空 agentDir 仅 `setRuntimeApiKey("deepseek", key)` 即可流式返回。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D8-S1 | 装配片段未传 `modelRuntime`，服务会自建一个，SecretStorage 的 key 失效 | ACCEPT | 核实 sdk.js `options.modelRuntime ?? ModelRuntime.create(...)`。5.3/S1 T3 显式传单例并跨会话复用；第 2 节补事实 |
| D8-S2 | 装配片段未传 `customTools`，同名 write 包装不生效 | ACCEPT | 核实 `CreateAgentSessionFromServicesOptions.customTools`。5.3/S1 T3 显式传 `[wrappedWrite]`；第 2 节事实句改为生产路径 |

本轮修复未经复核。至此装配链 `loader.ts → runtime.ts → session.ts → filechanges.ts` 的四个注入点（凭据、扩展/审批、写快照、会话替换）都已写明。

### DeepSeek 复核第 9 轮（2026-09-11，实跑核查：S1 T3 走 runtime 装配路径；本节编号前缀 D9-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 0 S / 3 N）。S1 T3 在 `createAgentSessionServices → createAgentSessionFromServices → createAgentSessionRuntime → rebind` 路径上全链路实跑通过（smoke 无错误、命令在、session_start 与命令标记落盘、`/smoke-custom` 经 `onError` 上报一次后会话仍可用）。DeepSeek 声明：可实测的运行时路径已全部覆盖，剩余未知量只有 VS Code 宿主内项与受限机专有项，其这边没有新的实质问题。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D9-N1 | runtime 路径下没有 `extensionsResult`，应读 `runtime.services.resourceLoader.getExtensions().errors` | ACCEPT | 核实 `AgentSessionServices.resourceLoader` 与 `getExtensions()`。5.3、S1 T3、sync 第 7 条改写 |
| D9-N2 | 包管理器没有 `list()`，是 `listConfiguredPackages()`；`removeAndPersist` 返回 boolean | ACCEPT | 核实 d.ts。5.1 改写 |
| D9-N3 | 空 `~/.pi/agent` 首次运行会被自动创建并写入 `auth.json`、`models-store.json` | ACCEPT | 第 7 节影响范围第 3 类补充，README 说明 |

本轮修复未经复核。

### DeepSeek 复核第 10 轮（2026-09-11，实跑核查：工具结果流向 webview 的安全面与持久化；本节编号前缀 D10-）

VERDICT: APPROVE-WITH-CHANGES（0 B / 2 S / 0 N）。确认 `edit.patch` 是标准 unified diff 并被持久化；确认 D9-N2 已落地。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D10-S1 | `marked` 默认不消毒，工具结果进 webview 会 XSS；pi 的 export-html 模板有现成配置 | ACCEPT | 核实模板里的 `html()/tag()` 置 undefined 与 `sanitizeMarkdownUrl`。5.1 render.ts、R9 改写；S2 验收加三种 XSS 用例；第 2 节补事实 |
| D10-S2 | 只有 edit 的 toolResult 持久化 details，diff 卡片重启后的口径不清 | ACCEPT，选"edit 从会话文件重建" | 核实本机会话文件。5.3 写明重放优先读持久化 patch，write 不持久化列为已知限制；S7 验收加重启用例 |

本轮修复未经复核。DeepSeek 声明运行时路径与打包链路已找不到新的实质问题。

### DeepSeek 复核第 11 轮（2026-09-11，实跑核查：S7 写包装 + S8 审批组合；本节编号前缀 D11-）

VERDICT: **APPROVE**（0 B / 0 S / 2 N）。实跑确认：自定义 write 覆盖内置后 `tool_call` 预检仍在执行前触发，审批拒绝时包装层的 `writeFile` 未被调用、文件未创建、无快照产生，S7 与 S8 可安全叠加。

| 编号 | 意见摘要 | 处置 | 理由与落点 |
|---|---|---|---|
| D11-N1 | 第 2 节 SDK API 清单未跟上 runtime 重构 | ACCEPT | 补 `createAgentSessionServices/FromServices/Runtime`、`AgentSessionRuntime` 及其不重复 reload、不调 bindExtensions 的说明 |
| D11-N2 | "四个资源路径"措辞与 sync 第 4 条的 8 个路径不一致 | ACCEPT | A8、S1 第 2 项、sync 第 4 条统一为"第 4 条列出的全部路径" |

DeepSeek 总体判断：可离线实测的路径已全部跑通并有证据；剩余未知量只有 VS Code 宿主内项与受限 Windows 机专有项，均已安排验收；建议直接进入 S0，若 S0/S1 出现 FAIL 再针对具体错误码决策，不再在计划上加注脚。作者同意此判断。
