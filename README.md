<div align="center">

# jerrypi

**在 VS Code 侧边栏用聊天面板驱动 Pi coding agent，目标机无需安装 Node.js**<br>
**Drive the Pi coding agent from a VS Code sidebar chat panel — no local Node.js required**

<p>
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

</div>

---

<a id="中文"></a>

## 中文

> 🚧 **状态**：**S0–S5 已实现**（聊天面板 / 工具卡片 / 模型与思考等级 / 会话管理），并在 macOS 与那台受限 Windows 机上完成了历次人工验收。目前只发布了**预发布版**；下文标注「计划中」的能力尚未实现。

`jerrypi` 是一个 VS Code 扩展，把 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) 的 coding agent 能力装进侧边栏聊天面板。它面向一种受限环境：Windows 机器、**没有安装 Node.js、也不允许运行下载的可执行文件**，只能通过 Marketplace 安装扩展。

为此，扩展内部**随包分发 pi 的官方预打包 SDK bundle**，直接运行在 VS Code 扩展宿主（Node/Electron）里，因此：

- 不依赖系统 Node.js，也不依赖任何原生 `.node` 模块；
- 与 pi CLI 共享同一套配置（`~/.pi/agent`）与会话格式，会话可在扩展与 CLI 之间互通；
- 兼容为 pi 编写的 TypeScript 扩展（含 `@earendil-works/pi-coding-agent` 与 `typebox`）。

### 特性

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 聊天面板 | **已实现** | 侧边栏 Webview：流式文本、思考块折叠、中止、排队、面板重开/重载后不丢历史 |
| 排队语义 | **已实现** | 与 pi CLI 一致：`Enter` = **转向**（写完当前这段就注入），「追加」= 等整轮结束再发，「取回编辑」= 把排队消息放回输入框 |
| 工具卡片 | **已实现** | 标题行（名字 + 参数摘要 + `✓`/`✗` + 耗时）可展开看正文；**bash 输出流式回显**（折叠时显示最后 5 行）；输出被 pi 截断时给出摘要与完整输出文件的链接；卡片里的文件路径**可点开**（用编辑器打开） |
| 内置工具 | **已实现** | `read` / `bash` / `edit` / `write`（bash 可中止） |
| 密钥管理 | **已实现** | API key 存入 VS Code SecretStorage，优先于 `models.json` 中的 key；可在面板里设置 |
| 模型与思考等级 | **已实现** | 输入框**上方**是工作状态行（空闲时不占内容但那行仍在，避免输入框跳动），**下方**是 `模型 · 思考等级 · 42.3%/1.0M`（**点模型/等级即可切换**，也可用命令面板 `Pi: Select Model` / `Pi: Select Thinking Level`）；VS Code 状态栏同时显示模型与用量，点击开选择器。**不覆盖**你在 pi 里选定的模型；面板里选过的模型在本窗口内一直生效（含新建会话），但**不写回 pi 的设置** |
| 会话管理 | **已实现** | 窗口启动**自动接过上一会话**（与 `pi -c` 同行为）；`Pi: Resume Session` 或点输入框下方的**会话名**打开列表（首项永远是“新建会话”，当前项带 `✓`，另一项 `Pi: New Session`）；忙时切换会**先问一句**。会话写在 `<agentDir>/sessions/--<编码 cwd>--/`，**与 pi CLI 互通**（`pi -c` / `pi --resume` 能打开它，反之亦然） |
| Diff 审阅 | **已实现** | `edit` 展示该次调用的 unified patch 视图；`write` 展示本次调用的前后对比（重启后只剩 `edit` 那份，见已知限制） |
| 工具审批 | **已实现** | 三档确认（`off` / `mutating` / `all`）：开启后工具调用**停在卡片上**等「允许 / 拒绝」；拒绝后 agent 收到原因；待确认时面板状态行会喊、面板不可见时弹通知。默认 `off`（与 pi CLI 一致） |
| 项目信任 | **已实现** | 工作区里有 `.pi/` 或 `.agents/skills` 时问一次"要不要信任这个文件夹"；选择可记进 `<agentDir>/trust.json`（与 pi CLI 共用），改判用 `Pi: Project Trust…` |
| 扩展与包 | 计划中（S9） | 加载用户的 pi TypeScript 扩展；支持本地路径 / git / `npm:` 包源 |

### 环境要求

- **VS Code ≥ 1.123**（该版本起扩展宿主为 Node 24；随包分发的 pi bundle 要求 Node ≥ 22.19，本项目只承诺实测过的 Node 24 档）。
- **Windows 上需要 Git Bash**（`bash.exe`），或在 pi 的 `settings.json` 里配置 `shellPath`。
- 一个可用的 pi 配置目录 `~/.pi/agent`：
  - `settings.json`：默认模型、工具、shell 等；
  - `models.json`：自定义 provider / 模型（可选）；
  - `auth.json`：provider 凭据（也可改用扩展的 `Pi: Set API Key` 存进 SecretStorage）。
- 扩展宿主能访问模型 API 的网络（如需代理见下文配置）。

### 安装

> 尚未发布。发布后：

1. 在 VS Code 扩展面板搜索 **`jerrypi`**（发布者 `flyjancy`）；
2. 开发期使用预发布通道：扩展详情页选择 **Install Pre-Release Version**；
3. 安装后打开侧边栏的 Pi 图标即可开始对话。

### 配置

扩展叠加三项 VS Code 设置，其余一律沿用 pi 自己的配置 —— 三项的状态各不相同（下面逐条标明）：

| 设置 | 取值 | 说明 |
| --- | --- | --- |
| `jerrypi.approvalMode` | `off`（默认）/ `mutating` / `all` | 工具调用是否需要确认。**已生效**：`mutating` = `read`/`grep`/`find`/`ls` 之外的工具（含扩展注册的工具）都要确认；`all` = 全部确认；`off` = 与 pi CLI 一样直接执行。**改动立即生效**（不需要重载窗口） |
| `jerrypi.proxy` | 代理 URL（可选） | 显式代理。**未实现**：现在设置它没有任何效果 —— 代理与证书交给 VS Code 的 `http.proxy` / `http.systemCertificates`；企业网必须走代理时，可以在**启动 VS Code 之前**设 `NODE_USE_ENV_PROXY=1` 与 `HTTP(S)_PROXY`（整进程的 `fetch` 都会走代理） |
| `jerrypi.agentDir` | 路径（默认留空 = `~/.pi/agent`） | pi 配置目录。**已生效**：会话、`auth.json`、`models.json`、`settings.json` 都跟着它走；**改动后需要重载窗口**（pi 在模块加载时读定）。环境变量 `PI_CODING_AGENT_DIR` 已设时以它为准 |

- 默认模型、`shellPath`、工具白名单等请在 pi 的 `settings.json` 中修改，扩展提供 **`Pi: Open Settings File`** 直接打开它。
- API key 存在 **VS Code SecretStorage**（`Pi: Set API Key`，候选来自 pi 自己认识的 provider、并标注每个 provider 当前的凭据来源），**不会写进 pi 的 `auth.json`**；删除用 **`Pi: Clear Stored API Keys`**（它只删本扩展存的那份，**不碰** `auth.json` / `models.json` —— 那两份是 pi 自己的文件）。
- 模型目录默认**不联网刷新**；**`Pi: Refresh Model Catalog`** 是唯一的联网入口（点了才发请求，刷新 `<agentDir>/models-store.json`）。
- 项目级配置的信任：打开面板时如果工作区里有 `.pi/` 或 `.agents/skills`，会弹一次原生对话框问"信任这个文件夹吗"。改判用 **`Pi: Project Trust…`**（信任并记住 / 信任父文件夹 / 仅本次 / 不信任 / 清除记录）。
- 代理与证书默认交给 VS Code 自身的 `http.proxy` / `http.systemCertificates` 处理，无需额外配置。

### pi 包管理（装 / 列 / 卸）

四个命令，走 pi 自己的包管理器（与终端 `pi install` / `pi remove` 改的是**同一份配置**）：

| 命令 | 作用 |
| --- | --- |
| `Pi: Install Package` | 输入源：本地文件夹绝对路径 / `npm:包名`（含 `npm:@scope/包`）/ git URL —— 与 pi CLI 接受的格式完全一致，扩展**不发明**新前缀 |
| `Pi: Install Package from Folder…` | 原生文件夹选择器（Windows 上装 `...\test-fixtures\ext-smoke` 这种长路径时省事） |
| `Pi: List Packages` | 列出配置里的包：源 + 作用域 + 解析后的路径；路径已失效的标「找不到（路径已失效）」，被过滤的加 `(filtered)` 后缀，项目作用域的标「（项目作用域：本版本不管理）」 |
| `Pi: Remove Package` | 从候选里选一个移除（**只列 user 作用域的条目**）；配置里没有匹配项时明说「未移除」，不假装成功 |

- **只写 user 作用域**：改动落在 `<agentDir>/settings.json` 的 `packages` 里，**绝不写工作区**（项目级包管理这一版不做）。
- **装/卸之后不会自动生效**：提示里会写「新建会话（或重载窗口）后生效」。不自动热重载是**刻意的** —— pi 的重载不会重新裁决项目信任，会把「先建会话、之后目录里长出 `.pi/extensions/`」这种情况下的扩展未经询问地装进来；新建会话则每次都重读设置并重跑信任流程。
- 已经装过的源再装一次会走幂等分支，提示「已经在配置里了（未改动）」，**不是**失败。
- 列表里看到的是**文件里的真相**（每次都新读 `<agentDir>/settings.json`），与终端 `pi` / 新建会话看到的一致。

### 使用

1. 打开侧边栏 Pi 面板（命令 `Pi: Focus Chat`）；
2. 输入消息、按 `Enter` 发送；回复流式显示，结束后按 markdown 渲染；
3. **回复过程中**面板不会禁用输入，可以继续打字，此时有三种选择：
   - `Enter` = **转向**：等当前这段输出结束、下一次调用模型之前，把新指令注入进去（**不会掐断正在生成的文字**）；
   - 「**追加**」= 等整轮全部结束后再作为新的一轮发送；
   - 「**取回编辑**」= 把排队里的消息全部放回输入框，方便改写；
   - 「**中止**」= 立刻停止（排队中的消息会一并放回输入框）；
4. 状态行显示当前模型与是否"生成中"；生成中时状态行**不会**因为一轮回答结束就提前变回"空闲"——队列里还有消息时它保持"生成中"。

### 从源码构建

```bash
git clone https://github.com/flyjancy/jerrypi-vscode.git
cd jerrypi-vscode
npm install
npm run package     # 生成 .vsix（会自动先跑 sync + build）
```

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run sync` | 把 pi 运行时复制进 `pi-runtime/`，并跑 7 条打包校验（含隔离 import、隔离加载扩展） |
| `npm run typecheck` | 类型检查（两个 tsconfig：扩展宿主一份、webview 一份带 DOM 类型） |
| `npm run build` | esbuild 产出三个文件：`dist/extension.js`、`dist/webview.js`、`dist/style.css` |
| `npm run self-test` | **9 个用例**：打包断言的正/负用例、`sync` 幂等性，以及协议/渲染/工具文本/设置/DOM/host 各套断言 |
| `npm run check:protocol` | **112** 条聊天协议断言（纯函数，不需要网络） |
| `npm run check:render` | **128** 条渲染与 XSS 断言（12 个载荷 + 图片策略 + CSP） |
| `npm run check:controller` | **110** 条面板控制器断言；**需要凭据与网络**（没有凭据时打印 SKIPPED 并跳过；总数随模型是否发起工具调用略有浮动） |
| `npm run check:gate` | 把 `Pi: Run Self-Test` 这条闸门（T1–T15）搬到终端里跑；**需要凭据与网络** |
| `node scripts/host-check.mjs` | **368** 条宿主接线断言（vscode 桩 + 真命令） |
| `node scripts/settings-check.mjs` | **16** 条设置声明与 README 一致性断言 |
| `npm run package` | 构建 + 打包 `.vsix`；vsce 打包前会自动执行 `vscode:prepublish`（唯一构建入口） |
| `npm run check-vsix -- jerrypi-0.1.8.vsix` | `.vsix` 体积门禁（< 30 MB）与必需文件校验 |
| `npm run vscode:prepublish` | 等同于 `sync && build` |

**发布一个新版本**（目前的流程是手动上传）：

1. 改 `package.json` 的 `version`（预发布用 0.1.x 递增；第一个正式版从 0.2.0 起。Marketplace 不允许覆盖已发布版本，版本号必须是纯三段数字）；
2. `npm run typecheck && npm run self-test && npm run check:controller`；
3. `npm run package`，再 `npm run check-vsix -- jerrypi-<版本>.vsix`；
4. 到 https://marketplace.visualstudio.com/manage 手动上传，**保持"预发布"勾选**；
5. 上传完成后从市场下载回来比对字节数与 SHA-256，确认与本地构建一致；
6. 给**构建该产物的提交**打一个注解 tag：
   `git tag -a v<版本> -m "jerrypi <版本>；产物 <大小> 字节，SHA-256 <指纹>"`，再 `git push --tags`。
   tag 只在第 5 步核对通过后才打 —— 这样每个 tag 都对应一份**确实发布出去**的产物。

装好扩展后，用 `Pi: Run Self-Test` 跑可行性闸门（**T1–T15** = 14 个 gating 项 + 3 个 advisory（T5c/T12/T13），结果写在 `jerrypi` Output 频道）：它会验证 pi 运行时能否在扩展宿主里真实加载、扩展生命周期、真实模型流式对话、子进程与中止、文件读写编辑、会话持久化与替换、图片 worker 往返，**以及会话目录是否落在 pi 的规范位置、`pi` 自己的 `list(cwd)` 能否看到它（T10/T11）**；T13 会报告一行代理身份（fetch 是不是原生、`http.proxy*`、代理环境变量的存在性），**只报告不判定**。**跑之前先用 `Pi: Set API Key` 配一把 provider key**（默认 DeepSeek），否则 T4/T6/T7/T9 会以 `E_NO_CREDENTIALS` 失败。（开发机上也可以 `npm run check:gate` 无头跑同一条闸门。）

> `.vsix` 里还包含 `test-fixtures/ext-smoke/index.ts`：它是**打包验收用的最小 pi 扩展**（不是给用户使用的功能），目的是让「从解包产物复跑校验」成为可能。细节见 [`docs/S0-plan.md`](docs/S0-plan.md)。

### 依赖

**随扩展分发**（打包进 `.vsix` 的 `pi-runtime/`）：

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 0.85.1 | MIT | agent SDK（官方 `dist/bundle` 原样分发） |
| `@earendil-works/chord` | 0.85.1 | MIT | pi bundle 的静态运行时依赖（`/context`） |
| `jiti` | 2.7.0 | MIT | 加载 pi 的 TypeScript 扩展 |
| `@silvia-odwyer/photon-node` | 0.3.4 | Apache-2.0 | 图片缩放（WASM，无原生代码） |

**构建期**（不随 `.vsix` 分发，版本以 `package.json` 为准）：

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | MIT | 类型定义（devDependency） |
| `esbuild` | MIT | 打包扩展自身 |
| `typescript` | Apache-2.0 | 类型检查 |
| `marked` | MIT | Webview markdown 渲染 |
| `undici` | MIT | 可选的显式代理层 |

完整第三方声明与许可证原文见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

### 已知限制

- **`jerrypi.approvalMode` 默认是 `off`，也就是"不问就执行"**：`bash` / `write` / `edit` 一律直接跑，与 pi CLI 的默认行为一致 —— 请在受信任的目录里使用。开启它（`mutating` / `all`）之后：
  - 确认**停在卡片上**（转写里那张工具卡片上出现「允许 / 拒绝」），状态行会写「有 N 个工具调用等待确认」；如果**面板当前不可见**，会弹一条通知（点「打开面板」回到面板）；
  - 点「拒绝」→ 工具**不执行**，agent 收到一句 `Rejected by user: <这次调用要做什么>`（它能看到被拒的是什么，可以换个做法）；
  - 待确认时点「中止」→ 这一轮结束、待确认项被清掉；
  - **它拦的是"工具调用"，不是"权限"**：允许一次 `bash` 就是允许那条命令能做的一切（写文件、删东西、联网都一样）；批准 `write`/`edit` 就是批准那次写。想要更细的边界请用 pi 自己的工具白名单/`shellPath` 和操作系统权限。
  - 面板**重开后**那张卡片还在（按钮还在，可以继续答）；只有重启 VS Code 才会丢掉"待确认"这件事（那时这一轮本来也已经中止了）；
  - **一次只有一个待确认项**：pi 是"逐个预检"的（同一批里前一个没答完，后一个连卡片都还没出现），所以没有"允许本批剩余全部"这种东西。
- **没打开工作区时，会话的 cwd 是用户主目录**：`bash` 与文件工具会以 `~`（Windows 上是 `C:\Users\<你>`）为工作目录运行，Output 里会写一行提示。**请先打开一个工作区**再用面板，否则模型的操作范围不受任何目录约束。
- **pi 包管理的边界**（`Pi: Install Package` / `List Packages` / `Remove Package`）：① **无 `npm` 的机器上不支持 `npm:` 包源**，也不支持带 `package.json` 的 git 包源（二者都需要 `npm`）—— `npm:` 会给出明确的「这个源需要 npm」提示，本地文件夹仍然可以装；git 源保留 pi 的原文（底层错误里“缺 `git`”与“缺 `npm`”都是 `spawn … ENOENT`，硬翻译会撒谎）。② **已装的本地包在扩展升级后可能失效**：本地路径是按「相对 `<agentDir>` 的相对路径」存的（与 pi CLI 一致），如果那个文件夹在扩展的安装目录里（例如拿它自己的 `test-fixtures/ext-smoke` 当包源），升级换代后旧文件夹被删掉，条目就指向不存在的路径 —— `Pi: List Packages` 会标「找不到（路径已失效）」，我们**不替你改路径**（那是你的配置，删掉重装即可）。③ **跨进程并发不保证**：同一个窗口里两个命令同时改 `packages` 由我们串行化；但面板与终端 `pi`、或两个 VS Code 窗口同时改仍可能丢一条（pi 的 `SettingsManager` 文件锁只保护“写入”那一段）—— 别同时改。
- **Bedrock SigV4a** 需要额外的 `@aws-sdk/signature-v4-crt` 包，本扩展不带，相关场景会明确报错。
- **`jerrypi.proxy` 还没实现**（写了不生效）：将来若实现，它会包装**进程级**的 `globalThis.fetch`，从而影响同进程内的其他扩展。现在请用 VS Code 的 `http.proxy`，或在启动 VS Code 之前设 `NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY`。当真机排查时，跑一次 `Pi: Run Self-Test` 看 **T13** 那一行 —— 它会报告 `fetch` 是不是原生、`http.proxySupport` / `http.proxy` 的值（口令会掩掉）与四个代理环境变量是否存在。
- **改动历史（卡片上的「查看 diff」）**：`edit` 显示的是**该次调用自己的补丁视图** —— 改动附近 4 行上下文，多个改动段之间用「⋯（中间省略）」隔开，**不是整文件**；它由 pi 写进会话文件，所以重启 VS Code 后仍可打开。`write` 显示的是**整文件前后**，前后内容只活在**本次 VS Code 进程**的内存里 —— 重启后同一张卡片显示「本次会话不可用」。内存上限：`edit` 保留最近 100 条、`write` 最近 20 条（单条超过 2 MiB 不保留），超出上限后**最早**的卡片显示「较早的改动记录已清理」。失败的工具调用（例如 `edit` 没匹配上）不会给 diff 入口。另外：diff 编辑器在**列太窄**时会被 VS Code 自动切成「上下」（inline）视图 —— 那是它的默认启发式（`diffEditor.useInlineViewWhenSpaceIsLimited`），不是我们的选择；想要一律左右并排，就把 diff 拖到更宽的列，或关掉那个设置。
- **会话落盘条件**（pi 行为）：只有完成过至少一轮 assistant 回复的会话才会写入磁盘。
- **项目级设置要你明确同意才会生效**：工作区里存在 `.pi/settings.json`、`.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`、`SYSTEM.md`、`APPEND_SYSTEM.md`，或**工作区或它的某个上级目录**里有 `.agents/skills` 时，**首次打开面板**会问一次"信任这个文件夹吗"（原生对话框，三个按钮：信任并记住 / 仅本次信任 / 不信任；Esc = 不信任）。要点：
  - 选"信任并记住"会写进 **`<agentDir>/trust.json`** —— 这是 **pi CLI 自己的那个文件**（终端里 `pi` 的信任提示读写同一份，互相认得）；选"仅本次"或"不信任"**不写文件**；
  - 我们**从不把"不信任"写进文件**（那会变成"永不再问"），要改判用命令 **`Pi: Project Trust…`**（内含"清除记录"）；
  - 目录没有这些资源时**根本不问**（此时信任与否不影响任何事）；`settings.json` 里的 `defaultProjectTrust` 是 `always`/`never` 时也不问；
  - 信任之后加载的是**这个仓库自带**的配置：项目 `.pi/settings.json` 能改 `shellPath`、默认工具等。**它改不了 `jerrypi.approvalMode`**（那是 VS Code 的机器级设置，只有你能改）；
  - **这与 VS Code 的「工作区信任」是两回事**：后者决定要不要在这个窗口里启用扩展（我们已声明不受信任的工作区不启用），前者决定要不要加载这个仓库自带的 pi 配置；
  - 改判之后要**新建会话或重载窗口**才生效（信任是在建会话时裁决的，`Pi: Project Trust…` 会提示这一句）；
  - **pi 扩展的 `project_trust` 事件不会被触发**：终端 `pi` 允许全局扩展在信任流程里表态（"我信任这些目录"就自动放行），面板**不支持**这件事 —— 那些扩展在这里只会被**多问一次**（这是刻意的：那个事件的语义只能按猜实现，宁可多问，不能悄悄放权）。
- **生成中切换模型不影响本轮**：pi 只改 `state.model`，正在跑的那轮仍用旧模型（下一轮生效）。切模型本身是**异步**的（要校验凭据），面板在切换完成前仍显示旧值。
- **面板里选的模型只在本窗口有效**：面板内的选择不写入 pi 的 `settings.json`（等价于 pi TUI 里"选了但没按 Ctrl+S 保存"），重开窗口会回到 pi 的默认/你自己的设置。写入设置属于 S6。
- **模型列表是"这台机器上 pi 的目录"，而且不会自己联网更新**：面板直接用 pi 的 `getAvailable()`（不硬编码、不过滤），而 pi 会把**内置目录**与 `<agentDir>/models-store.json`（缓存）合并。我们的运行时**显式关掉了自动联网刷新**（`allowModelNetwork: false`），所以面板不会替用户往外发请求 —— 代价是新模型名（例如 `deepseek-flash`）**不会自动出现**。需要跟上时跑 **`Pi: Refresh Model Catalog`**（点了才联网，刷新的是 `<agentDir>/models-store.json`）；也可以把别的 pi 环境刷出来的同格式文件直接复制到这台机器的 `<agentDir>` 下，重启面板即生效。
- **改了 `jerrypi.agentDir` 之后，旧目录里的东西不会跟过来**：会话、`auth.json`、`models.json` 都按新目录找 —— 旧内容不会丢，但面板与 `pi --resume` 都看不到旧会话（在旧目录下用 `pi` 能看到）。改回去（或在设置里删掉那一项）并重载窗口即可恢复。
- **模型列表只列"配了凭据"的模型**：用 `getAvailable()` 过滤，所以列表里没有的模型不是 bug，而是那个 provider 没配 API key（`Pi: Set API Key`）。
- **模型选择器不做"先显示旧列表再刷新"**：直接传一个 Promise 给 VS Code 的 `showQuickPick`（原生加载态）。这台机器上取列表只要 1ms，而 OAuth provider 上先显示一份可能已失效的旧列表反而更糟；真出现明显卡顿再升级成 `createQuickPick`。
- **远程图片不加载**：markdown 里的 `![](https://…)` 会被降级成 alt 文字。放行远程图片等于让模型可控的 URL 变成一条出网信道（一张 1×1 像素就能把内容编码进 query 发出去），因此消息里的图片**只允许 `data:image/...`**（CSP 里写的是 `img-src <扩展自身资源> data:`，另外放行扩展自己的图标），任何远程 URL 都不会发起请求。
- **图片内容不显示**：`read` 到图片时只显示一行 `[Image: image/png]` 提示。把图片画出来需要把 base64 塞进协议（一张图可达数 MB），会顶爆重放预算；这也正是 pi 在没有图片能力的终端下的降级行为。
- **依赖 `ctx.ui.custom()` 的 pi 扩展在面板里不可用**：那是终端 TUI 专有的全屏自定义渲染入口（需要真实的 TUI 实例），扩展宿主里无法实现。这类命令会**显示一条明确的错误**（而不是静默失败），其余功能不受影响。
- **会话文件存在规范位置，但有两种情况会“看不到”**：① **S5 之前（≤0.1.6）写的会话平铺在 `~/.pi/agent/sessions/` 根上**（那时我们把 pi 的 `sessionDir` 参数当成了“根”，其实是“直接装 `.jsonl` 的目录”）—— 它们在面板与 `pi --resume` 里都看不到，但**没丢**，在 `~` 下跑 `pi --session-dir ~/.pi/agent/sessions --resume` 能翻出来；② 若你设过环境变量 `PI_CODING_AGENT_SESSION_DIR` 或 `settings.json` 里的 `sessionDir`，终端里的 `pi` 会写到别处，**面板不跟随**（遇到时会在 Output 里记一行诊断）。
- **启动会自动接过上一会话** —— 包括你在终端里用 `pi` 聊的那次（判定是“**文件最后被写过**的那次”，不是“消息最多”）。不想要这个行为就开面板后点一次“新建会话”。
- **忙时切换会话会先弹确认**：正在生成时点会话名/`Pi: New Session`，会问一句“切换会中止这一轮，继续吗”。确认后那一轮会被中止（**并保存到原会话**，不丢），**排队中的消息也会被一并处理**（pi 会把它们放进旧会话，然后跟着这一轮一起中止）；取消则什么都不动。旧会话里留下的 `✗` 卡片与中止错误就是这次中断的**真实记录**，不是面板卡住了。
- **同一个项目的会话不要“两边同时写”**：两个 VS Code 窗口、或面板与终端 `pi` 同时开同一个项目时，它们会接管**同一份**会话文件（pi 的 append-only 树能容忍，但面板显示的条数与“当前项”会变得反直觉）。会话目录按 cwd 的**物理路径**算（`realpath` 之后），所以符号链接写法（如 macOS 的 `/tmp` → `/private/tmp`）不会分成两个目录 —— 这一点与终端里的 `pi` 一致。
- **队列只能整体取回**：pi 只提供 `clearQueue()`，没有按条移除/编辑的 API，所以「取回编辑」是全部取回。
- **卸载扩展不会撤销**工作区文件改动，也不清除 `~/.pi/agent` 下的会话、配置与已安装的包。

### 许可证

本项目以 **MIT License** 发布，见 [`LICENSE`](LICENSE)。第三方组件遵循其各自许可证，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

### 致谢

- [earendil-works/pi](https://github.com/earendil-works/pi) —— 本扩展的核心 agent 运行时（MIT）；
- [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension) —— 聊天 Webview UI 的移植来源（MIT）；
- [silvia-odwyer/photon](https://github.com/silvia-odwyer/photon) —— WASM 图片处理（Apache-2.0）；
- [unjs/jiti](https://github.com/unjs/jiti)、[earendil-works/chord](https://github.com/earendil-works/pi) 等运行时依赖。

---

<a id="english"></a>

## English

> 🚧 **Status**: steps **S0–S5** are implemented (chat panel, tool cards, model & thinking level, sessions) and every manual acceptance pass so far has succeeded on macOS and on the constrained Windows machine. Only **pre-release** versions have been published; anything marked "Planned" below is not implemented yet.

`jerrypi` is a VS Code extension that brings the [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) coding agent into a sidebar chat panel. It targets a constrained environment: a Windows machine with **no Node.js installed and no permission to run downloaded executables**, where extensions can only be installed from the Marketplace.

To make that possible, the extension **ships pi's official pre-bundled SDK** inside the package and runs it directly in the VS Code extension host (Node/Electron). As a result it:

- requires no system Node.js and no native `.node` modules;
- shares pi's configuration (`~/.pi/agent`) and session format, so sessions interoperate with the pi CLI;
- loads TypeScript extensions written for pi (including `@earendil-works/pi-coding-agent` and `typebox`).

### Features

| Capability | Status | Description |
| --- | --- | --- |
| Chat panel | **Implemented** | Sidebar webview: streaming text, collapsible thinking blocks, abort, queueing, history survives panel reload |
| Queue semantics | **Implemented** | Same as the pi CLI: `Enter` = **steer** (injected once the current response finishes), "Follow-up" = wait for the whole turn, "Edit queued" = put queued messages back in the composer |
| Tool cards | **Implemented** | A header line (name + argument summary + `✓`/`✗` + duration) expands to the result; **bash output streams in** (collapsed shows the last 5 lines); truncated output gets a summary and a link to the full output file; file paths inside a card are **clickable** and open in the editor |
| Built-in tools | **Implemented** | `read` / `bash` / `edit` / `write` (bash can be aborted) |
| API keys | **Implemented** | Stored in VS Code SecretStorage, taking precedence over keys in `models.json` |
| Model & thinking level | **Implemented** | The working-status line sits **above** the composer (it keeps its height when idle so the composer never jumps), and `model · thinking level · 42.3%/1.0M` sits **below** it — **click the model or the level to switch**, or use `Pi: Select Model` / `Pi: Select Thinking Level`. The VS Code status bar mirrors the model and usage and opens the picker on click. The panel **never overrides** the model you picked in pi; a model you pick *in the panel* stays in effect for this window (including new sessions) but is **not written back** to pi's settings |
| Sessions | **Implemented** | The window **resumes the previous session on startup** (same behaviour as `pi -c`); `Pi: Resume Session` — or clicking the **session name** under the composer — opens the list (the first item is always "New session", the current one is marked `✓`, and `Pi: New Session` still works); switching while the agent is busy **asks first**. Sessions live in `<agentDir>/sessions/--<encoded cwd>--/` and are **interoperable with the pi CLI** (`pi -c` / `pi --resume` can open ours, and vice versa) |
| Diff review | **Implemented** | `edit` shows that call's own unified patch; `write` shows per-call before/after snapshots (only the `edit` one survives a restart — see known limitations) |
| Tool approval | **Implemented** | Three modes (`off` / `mutating` / `all`): when on, a tool call **waits on its own card** for "Allow / Deny"; denying hands the agent a reason; a pending approval is announced on the status line and, if the panel is hidden, via a notification. Default `off` (matching the pi CLI) |
| Project trust | **Implemented** | When the workspace has `.pi/` or `.agents/skills`, asks once whether to trust that folder; the answer can be remembered in `<agentDir>/trust.json` (shared with the pi CLI) and changed via `Pi: Project Trust…` |
| Extensions & packages | Planned (S9) | Loads user pi TypeScript extensions; installs local / git / `npm:` package sources |

### Requirements

- **VS Code ≥ 1.123** (extension host on Node 24; the bundled SDK requires Node ≥ 22.19 and this project only commits to the tested Node 24 line).
- **Git Bash on Windows** (`bash.exe`), or a `shellPath` configured in pi's `settings.json`.
- A working pi config directory `~/.pi/agent` (`settings.json`, optional `models.json` / `auth.json`).
- Network access from the extension host to your model API (proxy settings below if needed).

### Install

> Not published yet. Once released:

1. Search **`jerrypi`** in the VS Code Extensions view (publisher `flyjancy`).
2. During development, pick **Install Pre-Release Version** on the extension page.
3. Open the Pi icon in the activity bar and start chatting.

### Configuration

The extension layers three VS Code settings on top of pi's own config; everything else follows pi's own config — the three are **not all in the same state** (each row says which):

| Setting | Values | Description |
| --- | --- | --- |
| `jerrypi.approvalMode` | `off` (default) / `mutating` / `all` | Whether tool calls require confirmation. **Effective**: `mutating` = everything except `read`/`grep`/`find`/`ls` (including tools registered by extensions) needs confirmation; `all` = everything; `off` = run immediately, matching the pi CLI. **Takes effect immediately** (no window reload) |
| `jerrypi.proxy` | proxy URL (optional) | Explicit proxy. **Not implemented**: setting it does nothing today — proxy and certificates are up to VS Code's `http.proxy` / `http.systemCertificates`; behind a corporate proxy you can set `NODE_USE_ENV_PROXY=1` and `HTTP(S)_PROXY` **before starting VS Code** (then the whole process' `fetch` uses them) |
| `jerrypi.agentDir` | path (empty = `~/.pi/agent`) | The pi config directory. **Effective**: sessions, `auth.json`, `models.json` and `settings.json` all follow it; **changing it requires a window reload** (pi reads it when its modules load). An existing `PI_CODING_AGENT_DIR` wins |

Use **`Pi: Open Settings File`** to edit pi's `settings.json` for default model, `shellPath`, tool allow-lists, etc. Proxy and certificates are handled by VS Code's own `http.proxy` / `http.systemCertificates` by default.

- API keys live in **VS Code SecretStorage** (`Pi: Set API Key` — the candidate list comes from pi itself, with each provider's current credential source shown) and are **never written into pi's `auth.json`**. Remove them with **`Pi: Clear Stored API Keys`**, which only deletes our copy and **does not touch** `auth.json` / `models.json` (those belong to pi).
- The model catalog is **not refreshed over the network by itself**; **`Pi: Refresh Model Catalog`** is the only network entry point (it requests only when you click it, refreshing `<agentDir>/models-store.json`).
- Project-level trust: when the workspace contains `.pi/` or `.agents/skills`, opening the panel asks once via a native dialog. Change the answer with **`Pi: Project Trust…`** (remember / trust the parent folder / this session only / do not trust / clear).

### pi package management (install / list / remove)

Four commands, powered by pi's own package manager (they edit the **same config** as the terminal `pi install` / `pi remove`):

| Command | What it does |
| --- | --- |
| `Pi: Install Package` | Type a source: absolute local folder path / `npm:name` (including `npm:@scope/name`) / git URL — exactly the formats the pi CLI accepts, the extension **invents no new prefixes** |
| `Pi: Install Package from Folder…` | Native folder picker (handy for long Windows paths such as `...\test-fixtures\ext-smoke`) |
| `Pi: List Packages` | Lists configured packages: source + scope + resolved path; entries whose path is gone read "not found (path is stale)", filtered entries get a `(filtered)` suffix, project-scoped entries are marked "(project scope: not managed by this version)" |
| `Pi: Remove Package` | Pick one to remove (**user-scope entries only**); if nothing matches it says "not removed" instead of pretending success |

- **User scope only**: changes go into the `packages` array of `<agentDir>/settings.json` and **never into the workspace** (project-scoped package management is out of scope for this version).
- **Install/remove does not take effect immediately**: the message says "takes effect in a new session (or after reloading the window)". Not hot-reloading is **deliberate** — pi's reload does not re-adjudicate project trust, so it would load extensions from a `.pi/extensions/` folder that appeared after the session was created without asking; a new session re-reads settings and re-runs the trust flow every time.
- Installing a source that is already configured takes the idempotent branch and reports "already configured (unchanged)" — that is **not** a failure.
- The list always shows **the truth from the file** (it re-reads `<agentDir>/settings.json` on every call), matching what the terminal `pi` and new sessions see.

### Usage

1. Open the Pi panel in the activity bar (command `Pi: Focus Chat`).
2. Type a message and press `Enter`; the reply streams in and is rendered as markdown when it finishes.
3. **While the agent is streaming** the input box stays enabled. You then have four options:
   - `Enter` = **steer**: wait for the current response to finish and inject the new instruction before the next model call (**it does not cut off the text being generated**);
   - "**Follow-up**" = send it as a new turn after the whole task completes;
   - "**Edit queued**" = put every queued message back into the composer so you can rewrite it;
   - "**Abort**" = stop immediately (queued messages are returned to the composer as well).
4. The status line shows the current model and whether the agent is busy. It deliberately **stays** "busy" after a single response if the queue is not empty.

### Build from source

```bash
git clone https://github.com/flyjancy/jerrypi-vscode.git
cd jerrypi-vscode
npm install
npm run package     # produces a .vsix (runs sync + build first)
```

Common scripts:

| Command | Purpose |
| --- | --- |
| `npm run sync` | Copies the pi runtime into `pi-runtime/` and runs the 7 packaging checks (including isolated import and isolated extension loading) |
| `npm run typecheck` | Type checking for both tsconfigs (extension host, and the webview one with DOM types) |
| `npm run build` | esbuild produces `dist/extension.js`, `dist/webview.js` and `dist/style.css` |
| `npm run self-test` | 9 cases: positive/negative packaging assertions, `sync` idempotency, plus the protocol/render/tool-text/settings/DOM/host suites |
| `npm run check:protocol` | 112 chat-protocol assertions (pure functions, no network) |
| `npm run check:render` | 128 rendering and XSS assertions (12 payloads, image policy, CSP) |
| `npm run check:controller` | 110 panel-controller assertions; **needs credentials and network** (prints SKIPPED without them; the total drifts slightly with whether the model calls tools) |
| `npm run check:gate` | Runs the `Pi: Run Self-Test` gate (T1–T15) in a terminal; **needs credentials and network** |
| `node scripts/host-check.mjs` | 368 host-side wiring assertions (vscode stub + real commands) |
| `node scripts/settings-check.mjs` | 16 settings-declaration vs README consistency assertions |
| `npm run package` | Build + package the `.vsix`; vsce runs `vscode:prepublish` first (the single build entry point) |
| `npm run check-vsix -- jerrypi-0.1.8.vsix` | `.vsix` size gate (< 30 MB) and required-file check |
| `npm run vscode:prepublish` | Equivalent to `sync && build` |

**Releasing a new version** (currently a manual upload):

1. Bump `version` in `package.json` (pre-releases increment 0.1.x; the first stable release starts at 0.2.0. The Marketplace never allows overwriting a published version, and the version must be plain three-part numeric);
2. `npm run typecheck && npm run self-test && npm run check:controller`;
3. `npm run package`, then `npm run check-vsix -- jerrypi-<version>.vsix`;
4. Upload manually at https://marketplace.visualstudio.com/manage, **keeping the pre-release box ticked**;
5. After the upload, download it back from the Marketplace and compare size and SHA-256 with the local build;
6. Tag **the commit that produced that artifact**:
   `git tag -a v<version> -m "jerrypi <version>; artifact <size> bytes, SHA-256 <digest>"`, then `git push --tags`.
   Only tag after step 5 checks out, so that every tag corresponds to an artifact that was **actually published**.

Once installed, run the feasibility gate with `Pi: Run Self-Test` (**T1–T15** = 14 gating items + 3 advisory (T5c/T12/T13), results go to the `jerrypi` output channel): it checks that the pi runtime really loads inside the extension host, extension lifecycle, a real streaming model call, subprocesses and aborts, file read/write/edit, session persistence and replacement, the image worker round-trip, **and that sessions land where pi expects them (`pi`'s own `list(cwd)` must see them — T10/T11)**; T13 reports one line about the proxy identity (whether `fetch` is native, `http.proxy*`, which proxy env vars exist) and **never judges**. **Configure a provider key with `Pi: Set API Key` first** (DeepSeek by default), otherwise T4/T6/T7/T9 fail with `E_NO_CREDENTIALS`. (On a dev machine you can also run the same gate headlessly with `npm run check:gate`.)

> The `.vsix` also ships `test-fixtures/ext-smoke/index.ts`: a **minimal pi extension used for packaging acceptance** (not a user-facing feature), so that verification can be re-run against the unpacked artifact. See [`docs/S0-plan.md`](docs/S0-plan.md).

### Dependencies

**Shipped with the extension** (inside `pi-runtime/` in the `.vsix`):

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 0.85.1 | MIT | Agent SDK (official `dist/bundle` redistributed verbatim) |
| `@earendil-works/chord` | 0.85.1 | MIT | Static runtime dependency of the pi bundle (`/context`) |
| `jiti` | 2.7.0 | MIT | Loads pi TypeScript extensions |
| `@silvia-odwyer/photon-node` | 0.3.4 | Apache-2.0 | Image resizing (WASM, no native code) |

**Build- and test-time only** (never distributed; versions per `package.json`): `@earendil-works/pi-coding-agent` (types), `esbuild`, `typescript`, `marked`, `undici` (the last two are bundled into `dist/`), and `happy-dom` (used only by `scripts/webview-dom-check.mjs`).

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for full notices and license texts.

### Known limitations

- **`jerrypi.approvalMode` defaults to `off`, i.e. tools run without asking**: `bash` / `write` / `edit` run **immediately**, matching the pi CLI default — use it in a directory you trust. When you turn it on (`mutating` / `all`):
  - the confirmation **waits on the tool's card** (an "Allow / Deny" row appears on that card in the transcript) and the status line says "N tool calls are waiting for confirmation"; if the panel is **not visible**, a notification appears (its button focuses the panel);
  - "Deny" → the tool **does not run**, and the agent receives `Rejected by user: <what this call wanted to do>` so it can try something else;
  - "Abort" while an approval is pending ends that turn and clears the pending item;
  - **It gates tool calls, not permissions**: allowing one `bash` call allows everything that command can do (writing files, deleting things, network); allowing `write`/`edit` allows that write. For finer boundaries use pi's own tool allow-lists/`shellPath` and OS permissions.
  - The card **survives a panel reload** (the buttons come back); only restarting VS Code drops a pending approval (by which point the turn has ended anyway);
  - **only one approval is pending at a time**: pi preflights tool calls one by one (in a batch, the next call's card does not even exist until the previous one is answered), so there is no "allow the rest of this batch".
- **With no workspace open, the session cwd is your home directory**: `bash` and the file tools then use `~` (on Windows `C:\Users\<you>`) as the working directory, and the output channel says so. **Open a workspace first**, otherwise nothing constrains where the agent operates.
- **Boundaries of pi package management** (`Pi: Install Package` / `List Packages` / `Remove Package`): ① **`npm:` package sources are unavailable on machines without Node/npm**, as are git sources that carry a `package.json` (both need `npm`) — `npm:` gets an explicit "this source needs npm" message while local folders still install; git sources keep pi's original error (at the bottom level "git missing" and "npm missing" are both `spawn … ENOENT`, so translating would lie). ② **Installed local packages can go stale after an extension upgrade**: local paths are stored relative to `<agentDir>` (same as the pi CLI), so if the folder lives inside the extension install directory (e.g. its own `test-fixtures/ext-smoke`), an upgrade deletes the old folder and the entry points at a path that no longer exists — `Pi: List Packages` marks it "not found (path is stale)" and we **do not rewrite your paths** (that is your config; remove and reinstall). ③ **Cross-process concurrency is not guaranteed**: two commands in the same window are serialized by us, but the panel plus a terminal `pi`, or two VS Code windows, can still lose one entry (pi's `SettingsManager` file lock only covers the write itself) — do not edit `packages` from two places at once.
- **Bedrock SigV4a** requires an extra `@aws-sdk/signature-v4-crt` package that is not bundled; affected setups fail with an explicit error.
- **`jerrypi.proxy` is not implemented** (setting it does nothing): if it ever lands it will wrap the **process-wide** `globalThis.fetch`, affecting every extension in the host process. For now use VS Code's `http.proxy`, or set `NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY` before starting VS Code. When debugging, run `Pi: Run Self-Test` and look at the **T13** line — it reports whether `fetch` is native, the values of `http.proxySupport` / `http.proxy` (credentials masked) and whether the four proxy env vars exist.
- **Change history (the "View diff" link on a card)**: for `edit` it shows **that call's own patch view** — 4 lines of context around each change, with "⋯ (gap)" between separate hunks, **not the whole file**; pi persists it into the session file, so it still opens after a VS Code restart. For `write` it shows the **whole file before/after**, and those contents live only in the **current VS Code process** — after a restart the same card reads "not available in this session". Memory caps: the latest 100 `edit` patches and the latest 20 `write` snapshots are kept (a single one over 2 MiB is dropped); beyond the cap the **oldest** cards read "earlier change records were cleaned up". Failed tool calls (e.g. an `edit` that did not match) get no diff entry at all. Also note: when the column is **too narrow**, VS Code automatically switches the diff editor to an inline (stacked) view — that is its own heuristic (`diffEditor.useInlineViewWhenSpaceIsLimited`), not our choice; for a permanent side-by-side view, drag the diff into a wider column or turn that setting off.
- **Session persistence** (pi behavior): a session is written to disk only after at least one assistant reply.
- **The model list is "pi's catalog on this machine", and it does not refresh itself over the network**: the panel uses pi's `getAvailable()` directly (no hardcoding, no filtering), and pi merges the **built-in catalog** with `<agentDir>/models-store.json` (a cache). Our runtime **explicitly disables automatic network refresh** (`allowModelNetwork: false`), so the panel never sends requests on its own — the price is that new model names (e.g. `deepseek-flash`) **do not appear by themselves**. Run **`Pi: Refresh Model Catalog`** when you want to catch up (network requests only after you click it; it refreshes `<agentDir>/models-store.json`), or copy a same-format file produced by another pi environment into `<agentDir>` on this machine and restart the panel.
- **Changing `jerrypi.agentDir` does not bring the old directory along**: sessions, `auth.json` and `models.json` are all looked up under the new directory — nothing is lost, but the panel and `pi --resume` will not see the old sessions (run `pi` in the old directory and it will). Change it back (or delete the setting) and reload the window to recover.
- **Project-level config needs your explicit consent**: when the workspace has `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`, or a `.agents/skills` in the workspace **or any of its ancestors**, the **first time you open the panel** a native dialog asks whether to trust that folder ("Trust and remember" / "This session only" / "Do not trust"; Esc = do not trust). Details:
  - "Trust and remember" writes into **`<agentDir>/trust.json`** — the **pi CLI's own file** (the terminal `pi` reads and writes the same file, so the two recognise each other); "this session only" and "do not trust" **write nothing**;
  - we **never persist "do not trust"** (that would mean "never ask again"); to change your mind use **`Pi: Project Trust…`** (which includes "clear the record");
  - a folder with none of those resources is **never asked about** (trust would change nothing there), and `defaultProjectTrust` set to `always`/`never` in `settings.json` skips the dialog too;
  - trusting loads **the repo's own** config: its `.pi/settings.json` can change `shellPath`, the default tool set, etc. It **cannot** change `jerrypi.approvalMode` (that is a machine-scoped VS Code setting only you control);
  - **This is not VS Code's workspace trust**: that one decides whether extensions run in this window at all (we declare that we do not activate in untrusted workspaces); this one decides whether the repo's pi config gets loaded;
  - after changing your answer, **start a new session or reload the window** (trust is resolved when a session is created; the command says so);
  - **the `project_trust` event of pi extensions is never emitted**: the terminal `pi` lets global extensions weigh in on trust ("I trust these folders" ⇒ auto-approve); the panel **does not** do that — such extensions simply cause **one extra prompt** here (deliberate: that event's semantics could only be guessed, and asking again is the safe direction).
- **Remote images are not loaded**: a markdown `![](https://…)` is downgraded to its alt text. Allowing remote images would turn a model-controlled URL into an outbound channel (a 1×1 pixel can encode content in its query string), so inside messages **only `data:image/...` is allowed** (the CSP reads `img-src <extension's own resources> data:` and also allows the extension's own icons); no remote URL is ever fetched.
- **Images are not displayed**: reading an image shows a single `[Image: image/png]` line. Rendering it would mean pushing base64 through the protocol (a single image can be several MB) and blowing the replay budget; this is also exactly how pi degrades on a terminal without image support.
- **pi extensions that rely on `ctx.ui.custom()` do not work in the panel**: that API renders a full-screen TUI component and needs a real TUI instance, which an extension host cannot provide. Such commands show an **explicit error** (rather than failing silently); everything else about the extension keeps working.
- **Session files live in the canonical place, but two things can make them "invisible"**: ① **sessions written before S5 (≤ 0.1.6) are flat** in the root of `~/.pi/agent/sessions/` (back then we treated pi's `sessionDir` argument as the "root", when it actually means "the directory that directly holds the `.jsonl` files") — neither the panel nor `pi --resume` lists them, but they are **not lost**: from `~` run `pi --session-dir ~/.pi/agent/sessions --resume`; ② if you have set `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in `settings.json`, the terminal `pi` writes elsewhere and the panel **does not follow** (it logs a line to the Output channel when it sees this).
- **Startup resumes the previous session** — including one you had in the terminal `pi` (the rule is "the file that was written last", not "the one with the most messages"). If you do not want that, click "New session" once.
- **Switching sessions while busy asks first**: when the agent is generating, clicking the session name or `Pi: New Session` asks "switching aborts this turn — continue?". If you confirm, that turn is aborted **and saved into the old session** (nothing is lost) and **queued messages are handled too** (pi puts them into the old session and they get aborted along with the turn); cancelling does nothing. The `✗` card and the abort error you see in the old session are the **faithful record** of that interruption — the panel is not stuck.
- **Do not write to one session from two places at once**: two VS Code windows or a panel plus a terminal `pi` will take over the **same** session file (pi's append-only tree copes, but the panel's message count and "current" marker become counter-intuitive). The session directory is derived from the **physical** path of the cwd (after `realpath`), so symlinked spellings (e.g. macOS `/tmp` → `/private/tmp`) do not split into two directories — this matches what the terminal `pi` does.
- **The queue can only be emptied as a whole**: pi exposes `clearQueue()` and nothing per-item, so "Edit queued" returns everything.
- **Uninstalling the extension does not revert** workspace file changes, nor does it clean up sessions, config or installed packages under `~/.pi/agent`.

### License

Released under the **MIT License** — see [`LICENSE`](LICENSE). Third-party components remain under their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

### Acknowledgements

- [earendil-works/pi](https://github.com/earendil-works/pi) — the core agent runtime (MIT);
- [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension) — source of the ported chat webview UI (MIT);
- [silvia-odwyer/photon](https://github.com/silvia-odwyer/photon) — WASM image processing (Apache-2.0);
- [unjs/jiti](https://github.com/unjs/jiti), earendil-works/chord and other runtime dependencies.
