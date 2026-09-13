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
| Diff 审阅 | 计划中（S7） | `edit` 展示 unified patch；`write` 展示本次调用的前后对比 |
| 工具审批 | 计划中（S8） | 开关式确认，默认 `off`（与 pi CLI 一致），可选 `mutating` / `all` |
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

扩展只叠加三项 VS Code 设置，其余一律沿用 pi 自己的配置：

| 设置 | 取值 | 说明 |
| --- | --- | --- |
| `jerrypi.approvalMode` | `off`（默认）/ `mutating` / `all` | 工具调用是否需要确认。**尚未生效（S8）**：现在设置它没有任何效果，工具调用一律直接执行 |
| `jerrypi.proxy` | 代理 URL（可选） | 显式代理；**启用时会替换进程级 `globalThis.fetch`**，详见已知限制 |
| `jerrypi.agentDir` | 路径（默认留空 = `~/.pi/agent`） | pi 配置目录 |

- 默认模型、`shellPath`、工具白名单等请在 pi 的 `settings.json` 中修改，扩展提供 **`Pi: Open Settings File`** 直接打开它。
- 代理与证书默认交给 VS Code 自身的 `http.proxy` / `http.systemCertificates` 处理，无需额外配置。

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
| `npm run self-test` | 6 个用例：打包断言的正/负用例、`sync` 幂等性、协议与渲染断言 | 
| `npm run check:protocol` | 63 条聊天协议断言（纯函数，不需要网络） |
| `npm run check:render` | 42 条渲染与 XSS 断言（12 个载荷 + 图片策略 + CSP） |
| `npm run check:controller` | 27 条面板控制器断言；**需要凭据与网络**（没有凭据时打印 SKIPPED 并跳过） |
| `npm run package` | 构建 + 打包 `.vsix`；vsce 打包前会自动执行 `vscode:prepublish`（唯一构建入口） |
| `npm run check-vsix -- jerrypi-0.1.4.vsix` | `.vsix` 体积门禁（< 30 MB）与必需文件校验 |
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

装好扩展后，用 `Pi: Run Self-Test` 跑可行性闸门（T1–T9，结果写在 `jerrypi` Output 频道）：它会验证 pi 运行时能否在扩展宿主里真实加载、扩展生命周期、真实模型流式对话、子进程与中止、文件读写编辑、会话持久化与替换、图片 worker 往返。**跑之前先用 `Pi: Set API Key` 配一把 provider key**（默认 DeepSeek），否则 T4/T6/T7/T9 会以 `E_NO_CREDENTIALS` 失败。

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

- **工具调用没有任何确认环节**：`bash` / `write` / `edit` 一律**直接执行**，面板不会弹确认，`jerrypi.approvalMode` 开关在 S8 之前**写了也没用**。因此 agent 能执行任意命令、读写任意路径，与 pi CLI 的默认行为一致 —— 请在受信任的目录里使用。
- **没打开工作区时，会话的 cwd 是用户主目录**：`bash` 与文件工具会以 `~`（Windows 上是 `C:\Users\<你>`）为工作目录运行，Output 里会写一行提示。**请先打开一个工作区**再用面板，否则模型的操作范围不受任何目录约束。
- **无 Node 的机器上不支持 `npm:` 包源**，也不支持带 `package.json` 的 git 包源（二者都需要 `npm`）；本地路径包源可用。
- **Bedrock SigV4a** 需要额外的 `@aws-sdk/signature-v4-crt` 包，本扩展不带，相关场景会明确报错。
- **`jerrypi.proxy` 是进程级副作用**：启用时会包装 `globalThis.fetch`，影响同进程内的其他扩展；默认关闭，关闭或停用时恢复。
- **写入历史提示**：`edit` 的 diff 会随会话持久化；`write` 的前后快照只存在于当前进程内，重启 VS Code 后不再显示。
- **会话落盘条件**（pi 行为）：只有完成过至少一轮 assistant 回复的会话才会写入磁盘。
- **项目级设置默认不被信任**：pi CLI 会解析信任并询问用户，而 jerrypi 固定以 `projectTrusted: false` 初始化会话，因此工作区里的 `.pi/settings.json`、`SYSTEM.md` 等项目级资源不会被加载，也**不会有任何提示**。这是刻意的安全默认值（项目级设置能改 `shellPath` 与默认工具），信任流程待 S6 补上；在此之前如需使用项目级配置，请改用全局 `settings.json`。
- **生成中切换模型不影响本轮**：pi 只改 `state.model`，正在跑的那轮仍用旧模型（下一轮生效）。切模型本身是**异步**的（要校验凭据），面板在切换完成前仍显示旧值。
- **面板里选的模型只在本窗口有效**：面板内的选择不写入 pi 的 `settings.json`（等价于 pi TUI 里"选了但没按 Ctrl+S 保存"），重开窗口会回到 pi 的默认/你自己的设置。写入设置属于 S6。
- **模型列表是"这台机器上 pi 的目录"，而且不会自己联网更新**：面板直接用 pi 的 `getAvailable()`（不硬编码、不过滤），而 pi 会把**内置目录**与 `<agentDir>/models-store.json`（缓存）合并。我们的运行时**显式关掉了联网刷新**（`allowModelNetwork: false`），所以面板不会替用户往外发请求 —— 代价是新模型名（例如 `deepseek-flash`）**不会自动出现**。判断标准：`models-store.json` 是 pi 的文件格式，任何能刷新它的 pi 环境（另一台装了 pi CLI 的机器）刷出来的文件**可以直接复制**到这台机器的 `<agentDir>` 下，重启面板即生效。将来会提供 `Pi: Refresh Model Catalog`（点了才联网）。
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
| Diff review | Planned (S7) | `edit` shows the unified patch; `write` shows per-call before/after snapshots |
| Tool approval | Planned (S8) | Optional confirmation gate (default `off`, matching the pi CLI), plus `mutating` / `all` |
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

The extension only adds three VS Code settings; everything else follows pi's own config:

| Setting | Values | Description |
| --- | --- | --- |
| `jerrypi.approvalMode` | `off` (default) / `mutating` / `all` | Whether tool calls require confirmation. **Not effective yet (S8)**: setting it does nothing today, tool calls always run immediately |
| `jerrypi.proxy` | proxy URL (optional) | Explicit proxy; **wraps the process-wide `globalThis.fetch`** when enabled |
| `jerrypi.agentDir` | path (empty = `~/.pi/agent`) | The pi config directory |

Use **`Pi: Open Settings File`** to edit pi's `settings.json` for default model, `shellPath`, tool allow-lists, etc. Proxy and certificates are handled by VS Code's own `http.proxy` / `http.systemCertificates` by default.

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
| `npm run self-test` | 6 cases: positive/negative packaging assertions, `sync` idempotency, protocol and render checks |
| `npm run check:protocol` | 63 chat-protocol assertions (pure functions, no network) |
| `npm run check:render` | 42 rendering and XSS assertions (12 payloads, image policy, CSP) |
| `npm run check:controller` | 27 panel-controller assertions; **needs credentials and network** (prints SKIPPED without them) |
| `npm run package` | Build + package the `.vsix`; vsce runs `vscode:prepublish` first (the single build entry point) |
| `npm run check-vsix -- jerrypi-0.1.4.vsix` | `.vsix` size gate (< 30 MB) and required-file check |
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

Once installed, run the feasibility gate with `Pi: Run Self-Test` (T1–T9, results go to the `jerrypi` output channel): it checks that the pi runtime really loads inside the extension host, extension lifecycle, a real streaming model call, subprocesses and aborts, file read/write/edit, session persistence and replacement, and the image worker round-trip. **Configure a provider key with `Pi: Set API Key` first** (DeepSeek by default), otherwise T4/T6/T7/T9 fail with `E_NO_CREDENTIALS`.

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

- **Tool calls have no confirmation step**: `bash` / `write` / `edit` run **immediately** and the panel never asks. `jerrypi.approvalMode` does nothing before S8. The agent can therefore run arbitrary commands and read/write arbitrary paths, matching the pi CLI default — use it in a directory you trust.
- **With no workspace open, the session cwd is your home directory**: `bash` and the file tools then use `~` (on Windows `C:\Users\<you>`) as the working directory, and the output channel says so. **Open a workspace first**, otherwise nothing constrains where the agent operates.
- **`npm:` and git package sources are unavailable on machines without Node/npm**; local-path sources work.
- **Bedrock SigV4a** requires an extra `@aws-sdk/signature-v4-crt` package that is not bundled; affected setups fail with an explicit error.
- **`jerrypi.proxy` is process-wide**: enabling it wraps `globalThis.fetch` for every extension in the host process. It is off by default and restored on disable/deactivate.
- **Write history**: `edit` diffs are persisted with the session, but `write` before/after snapshots live only for the current process and disappear after a VS Code restart.
- **Session persistence** (pi behavior): a session is written to disk only after at least one assistant reply.
- **Project-level settings are not trusted by default**: the pi CLI resolves trust and asks the user, whereas jerrypi always initialises sessions with `projectTrusted: false`. Project-scoped resources such as `.pi/settings.json` and `SYSTEM.md` are therefore not loaded, and **nothing tells you so**. This is a deliberate safe default (project settings can override `shellPath` and the default tool set); the trust flow lands in S6. Until then, put such configuration in the global `settings.json`.
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
