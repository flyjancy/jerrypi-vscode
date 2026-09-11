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

> 🚧 **状态**：实施计划已定稿（见 [`docs/PLAN.md`](docs/PLAN.md)），代码正在开发中，**尚未发布到 VS Code Marketplace**。本 README 描述的是目标形态。

`jerrypi` 是一个 VS Code 扩展，把 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) 的 coding agent 能力装进侧边栏聊天面板。它面向一种受限环境：Windows 机器、**没有安装 Node.js、也不允许运行下载的可执行文件**，只能通过 Marketplace 安装扩展。

为此，扩展内部**随包分发 pi 的官方预打包 SDK bundle**，直接运行在 VS Code 扩展宿主（Node/Electron）里，因此：

- 不依赖系统 Node.js，也不依赖任何原生 `.node` 模块；
- 与 pi CLI 共享同一套配置（`~/.pi/agent`）与会话格式，会话可在扩展与 CLI 之间互通；
- 兼容为 pi 编写的 TypeScript 扩展（含 `@earendil-works/pi-coding-agent` 与 `typebox`）。

### 特性

| 能力 | 说明 |
| --- | --- |
| 聊天面板 | 侧边栏 Webview，流式文本、思考块、可折叠工具卡片 |
| 内置工具 | `read` / `bash` / `edit` / `write`（bash 走 Git Bash，运行中可中止） |
| 模型与思考等级 | 模型列表来自 `~/.pi/agent/models.json` 与内置 provider，面板内切换 |
| 会话管理 | 列表、新建、恢复；写入 `~/.pi/agent/sessions/`，与 pi CLI `--resume` 互通 |
| Diff 审阅 | `edit` 直接展示 unified patch；`write` 展示本次调用的前后对比 |
| 工具审批 | 开关式确认，默认 `off`（与 pi CLI 一致），可选 `mutating` / `all` |
| 扩展与包 | 加载用户的 pi TypeScript 扩展；支持安装本地路径 / git / `npm:` 包源 |
| 密钥管理 | API key 存入 VS Code SecretStorage，优先于 `models.json` 中的 key |

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
| `jerrypi.approvalMode` | `off`（默认）/ `mutating` / `all` | 工具调用是否需要确认 |
| `jerrypi.proxy` | 代理 URL（可选） | 显式代理；**启用时会替换进程级 `globalThis.fetch`**，详见已知限制 |
| `jerrypi.agentDir` | 路径（默认留空 = `~/.pi/agent`） | pi 配置目录 |

- 默认模型、`shellPath`、工具白名单等请在 pi 的 `settings.json` 中修改，扩展提供 **`Pi: Open Settings File`** 直接打开它。
- 代理与证书默认交给 VS Code 自身的 `http.proxy` / `http.systemCertificates` 处理，无需额外配置。

### 使用

1. 打开侧边栏 Pi 面板（命令 `Pi: Focus Chat`）；
2. 输入消息发送；回复会流式显示，工具调用以可折叠卡片呈现；
3. 回复过程中可继续输入：发送行为会进入排队（steer / follow-up），或点中止按钮停止；
4. 通过面板顶部的选择器切换模型与思考等级；侧边栏状态栏显示模型与上下文用量。

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
| `npm run self-test` | 1 个正用例 + 3 个负用例（缺依赖必须非零退出、sync 必须幂等） |
| `npm run typecheck` / `npm run build` | 类型检查 / esbuild 打包扩展自身 |
| `npm run package` | 构建 + 打包 `.vsix`；vsce 打包前会自动执行 `vscode:prepublish`（唯一构建入口） |
| `npm run check-vsix -- jerrypi-0.1.0.vsix` | `.vsix` 体积门禁（< 30 MB） |
| `npm run vscode:prepublish` | 等同于 `sync && build` |

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

- **agent 默认全权限执行**：`bash` 可执行任意命令、读写任意路径，与 pi CLI 行为一致。请在受信任的工作区使用，必要时开启 `jerrypi.approvalMode`。
- **无 Node 的机器上不支持 `npm:` 包源**，也不支持带 `package.json` 的 git 包源（二者都需要 `npm`）；本地路径包源可用。
- **Bedrock SigV4a** 需要额外的 `@aws-sdk/signature-v4-crt` 包，本扩展不带，相关场景会明确报错。
- **`jerrypi.proxy` 是进程级副作用**：启用时会包装 `globalThis.fetch`，影响同进程内的其他扩展；默认关闭，关闭或停用时恢复。
- **写入历史提示**：`edit` 的 diff 会随会话持久化；`write` 的前后快照只存在于当前进程内，重启 VS Code 后不再显示。
- **会话落盘条件**（pi 行为）：只有完成过至少一轮 assistant 回复的会话才会写入磁盘。
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

> 🚧 **Status**: the implementation plan is finalized (see [`docs/PLAN.md`](docs/PLAN.md)), the code is under development and the extension is **not yet published to the VS Code Marketplace**. This README describes the intended shape.

`jerrypi` is a VS Code extension that brings the [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) coding agent into a sidebar chat panel. It targets a constrained environment: a Windows machine with **no Node.js installed and no permission to run downloaded executables**, where extensions can only be installed from the Marketplace.

To make that possible, the extension **ships pi's official pre-bundled SDK** inside the package and runs it directly in the VS Code extension host (Node/Electron). As a result it:

- requires no system Node.js and no native `.node` modules;
- shares pi's configuration (`~/.pi/agent`) and session format, so sessions interoperate with the pi CLI;
- loads TypeScript extensions written for pi (including `@earendil-works/pi-coding-agent` and `typebox`).

### Features

| Capability | Description |
| --- | --- |
| Chat panel | Sidebar webview with streaming text, thinking blocks and collapsible tool cards |
| Built-in tools | `read` / `bash` / `edit` / `write` (bash uses Git Bash and can be aborted mid-run) |
| Models & thinking | Model list from `~/.pi/agent/models.json` plus built-in providers, switchable in the panel |
| Sessions | List, create and resume; stored in `~/.pi/agent/sessions/`, interoperable with `pi --resume` |
| Diff review | `edit` shows the unified patch; `write` shows per-call before/after snapshots |
| Tool approval | Optional confirmation gate (default `off`, matching the pi CLI), plus `mutating` / `all` |
| Extensions & packages | Loads user pi TypeScript extensions; installs local / git / `npm:` package sources |
| API keys | Stored in VS Code SecretStorage, taking precedence over keys in `models.json` |

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
| `jerrypi.approvalMode` | `off` (default) / `mutating` / `all` | Whether tool calls require confirmation |
| `jerrypi.proxy` | proxy URL (optional) | Explicit proxy; **wraps the process-wide `globalThis.fetch`** when enabled |
| `jerrypi.agentDir` | path (empty = `~/.pi/agent`) | The pi config directory |

Use **`Pi: Open Settings File`** to edit pi's `settings.json` for default model, `shellPath`, tool allow-lists, etc. Proxy and certificates are handled by VS Code's own `http.proxy` / `http.systemCertificates` by default.

### Usage

1. Open the Pi panel in the activity bar (command `Pi: Focus Chat`).
2. Send a message; the reply streams in, tool calls appear as collapsible cards.
3. You can keep typing while the agent is streaming — messages are queued (steer / follow-up) — or click abort.
4. Switch model and thinking level from the panel's selectors; the status bar shows the model and context usage.

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
| `npm run self-test` | 1 positive + 3 negative cases (missing dependency must exit non-zero, sync must be idempotent) |
| `npm run typecheck` / `npm run build` | Type checking / bundles the extension itself with esbuild |
| `npm run package` | Build + package the `.vsix`; vsce runs `vscode:prepublish` first (the single build entry point) |
| `npm run check-vsix -- jerrypi-0.1.0.vsix` | `.vsix` size gate (< 30 MB) |
| `npm run vscode:prepublish` | Equivalent to `sync && build` |

> The `.vsix` also ships `test-fixtures/ext-smoke/index.ts`: a **minimal pi extension used for packaging acceptance** (not a user-facing feature), so that verification can be re-run against the unpacked artifact. See [`docs/S0-plan.md`](docs/S0-plan.md).

### Dependencies

**Shipped with the extension** (inside `pi-runtime/` in the `.vsix`):

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 0.85.1 | MIT | Agent SDK (official `dist/bundle` redistributed verbatim) |
| `@earendil-works/chord` | 0.85.1 | MIT | Static runtime dependency of the pi bundle (`/context`) |
| `jiti` | 2.7.0 | MIT | Loads pi TypeScript extensions |
| `@silvia-odwyer/photon-node` | 0.3.4 | Apache-2.0 | Image resizing (WASM, no native code) |

**Build-time only** (not shipped; versions per `package.json`): `@earendil-works/pi-coding-agent` (types), `esbuild`, `typescript`, `marked`, `undici`.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for full notices and license texts.

### Known limitations

- **The agent runs with full permissions by default** — `bash` can run arbitrary commands and read/write arbitrary paths, identical to the pi CLI. Use it in trusted workspaces and enable `jerrypi.approvalMode` when needed.
- **`npm:` and git package sources are unavailable on machines without Node/npm**; local-path sources work.
- **Bedrock SigV4a** requires an extra `@aws-sdk/signature-v4-crt` package that is not bundled; affected setups fail with an explicit error.
- **`jerrypi.proxy` is process-wide**: enabling it wraps `globalThis.fetch` for every extension in the host process. It is off by default and restored on disable/deactivate.
- **Write history**: `edit` diffs are persisted with the session, but `write` before/after snapshots live only for the current process and disappear after a VS Code restart.
- **Session persistence** (pi behavior): a session is written to disk only after at least one assistant reply.
- **Uninstalling the extension does not revert** workspace file changes, nor does it clean up sessions, config or installed packages under `~/.pi/agent`.

### License

Released under the **MIT License** — see [`LICENSE`](LICENSE). Third-party components remain under their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

### Acknowledgements

- [earendil-works/pi](https://github.com/earendil-works/pi) — the core agent runtime (MIT);
- [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension) — source of the ported chat webview UI (MIT);
- [silvia-odwyer/photon](https://github.com/silvia-odwyer/photon) — WASM image processing (Apache-2.0);
- [unjs/jiti](https://github.com/unjs/jiti), earendil-works/chord and other runtime dependencies.
