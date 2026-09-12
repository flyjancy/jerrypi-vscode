# 更新日志

本文件记录 jerrypi 每个**已发布**版本的变化。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

> **当前处于预发布阶段**：所有版本在 Marketplace 上均标记为 pre-release。
> 功能按 S0–S9 的切片推进（见 [`docs/PLAN.md`](docs/PLAN.md)），
> 尚未承诺配置项与内部行为的向后兼容。

## [未发布]

- S3（工具卡片）：工具参数与结果的完整展示、bash 输出流式回显、点击路径打开文件。

## [0.1.4] - 2026-09-12

第一个**可日常使用**的版本：侧边栏聊天面板落地。

### 新增

- **侧边栏聊天面板**（活动栏 Pi 图标）：流式输出、markdown 渲染（含代码块与行内代码）、
  思考过程折叠、中止按钮、会话内多轮上下文。
- **排队**：生成过程中输入框保持可用，语义与 pi CLI **完全一致** ——
  `Enter` 是**转向**（等当前这段写完、下一次调用模型之前注入），
  「追加」等整轮结束后再发，「取回编辑」把排队的消息全部放回输入框以便改写。
- **工具行**：每次工具调用占一行（工具名 + 参数摘要 + `✓`/`✗`），
  执行期间先显示「运行中…」，结束后**就地**变成最终状态；
  中途重开面板也不会丢或重复。
- markdown 里的 `https:` 链接可在面板内点击，用**系统默认浏览器**打开。
- 新命令 `Pi: New Session`。

### 安全

- 面板 HTML 使用 **nonce + 严格 CSP**（`default-src 'none'`，脚本与样式仅允许来自扩展自身）。
- 消息**一律按纯文本插入 DOM**，不经过 `innerHTML` 拼接；
  URL 走 scheme 白名单（`http` / `https` / `mailto` / 相对路径），
  `javascript:` 等一律降级为纯文本。
- **远程图片不加载**（只允许 `data:image/...`）：放行远程图片等于让模型可控的 URL
  变成一条出网信道（一张 1×1 像素就能把内容编码进 query 发出去）。

### 修复

- **生成中发送第二条消息被拒**（`Agent is already processing`）：
  判据由"本地是否还有未落地的发送"改为"pi 是否真的接受了这次 prompt"。
- **「取回编辑」会静默丢掉排队的文本**：现在把 `clearQueue()` 的返回值还原回输入框。
- **中止的顺序错误**：先清队列再 `abort()`，否则排队内容会随会话状态一起消失。
- **模型跟随策略**：面板**不再覆盖**你在 pi 设置里选定的模型
  （仅在你从未选过时才兜底避开不可用 provider）；`Pi: New Session` 后也会重新对齐。
- **扩展命令（`/xxx`）执行后状态行永久停在"生成中"**：
  这类命令不产生 `agent_settled`，现在改为与 `isIdle` 对账。
- 发送后输入框不清空（会让人以为没发出去）。
- 工具名、输入框按钮、提示文案被 flex 压成竖排文字（三处）。

## [0.1.3] - 2026-09-12

### 修复

- 自测闸门改为**钉住 `deepseek-v4-flash`**，不再使用 pi 内部的默认模型
  （`deepseek-v4-pro`，单价约 10 倍）。`Pi: Run Self-Test` 一次要跑十几次真实调用。
- 0.1.2 的 provider 修复在此定稿（0.1.2 是中途上传的过渡版本）。

## [0.1.2] - 2026-09-12

### 新增

- 自测输出会打印**已配置凭据的 provider 列表**与最终解析到的模型，便于诊断"跑不起来"。

### 修复

- **自动选择一个真正有凭据的 provider**，不再落到 `openai/gpt-5.5`：
  在受限机器上 `openai` 填了 key 但模型不可用，每次 prompt 都会落一条空的 assistant
  消息 —— 看起来像"pi 起不来"，实际是"模型用不了"。

## [0.1.1] - 2026-09-12

### 修复

- 自测在 Windows 上正确工作：接受任意 `*_delta`
  （`text_delta` / `thinking_delta` / `toolcall_delta`）；
  只认 `text_delta` 会让"只输出思考"的模型误报失败。
- 自测失败时输出可诊断信息：当前解析到的模型、最后一条 assistant 消息的文本。

## [0.1.0] - 2026-09-12

首个发布版本（预发布）：扩展骨架 + 可行性闸门。

### 新增

- **内嵌 pi**：随包分发 pi 0.85.1 的官方 bundle 并在扩展宿主（Node/Electron）里直接运行，
  因此**不需要系统 Node.js，也不运行任何外部可执行文件**。
- **可行性闸门 `Pi: Run Self-Test`**（11 项）：pi runtime 加载与版本、随包资源完整性、
  用户扩展加载与 `onError` 上报、真实 provider 流式、Git Bash 与中止、
  工具调用往返（含 `write` 的 `toolCallId` 捕获）、会话落盘与重开、
  图片缩放 worker、会话切换。
- 命令 `Pi: Set API Key`（存入 VS Code SecretStorage）与 `Pi: Open Settings File`。
- 打包链：`pi-runtime/` 与 `dist/` 由构建产出、不入库；`.vsix` 有必需文件校验
  与 30 MB 体积闸门；CI 覆盖类型检查、自测、协议/渲染断言与打包校验。

---

# Changelog

All notable changes to jerrypi are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/).

> **Pre-release stage**: every version is published as a pre-release on the Marketplace.
> Work proceeds in slices S0–S9 (see [`docs/PLAN.md`](docs/PLAN.md)); configuration keys and
> internal behaviour are not yet promised to be backward compatible.

## [Unreleased]

- S3 (tool cards): full tool arguments and results, streaming bash output, click a path to open it.

## [0.1.4] - 2026-09-12

The first version that is usable day to day: the sidebar chat panel.

### Added

- **Sidebar chat panel** (Pi icon in the activity bar): streaming output, markdown rendering
  (code blocks and inline code), collapsible thinking, an abort button, multi-turn context.
- **Queueing**: the composer stays enabled while the agent streams, with semantics
  **identical to the pi CLI** — `Enter` is **steer** (injected once the current response finishes,
  before the next model call), "Follow-up" waits for the whole turn, and "Edit queued" puts every
  queued message back into the composer.
- **Tool rows**: one line per tool call (name + argument summary + `✓`/`✗`); it shows
  "running…" while in flight and turns into the final state **in place**. Reopening the panel
  mid-run neither loses nor duplicates it.
- `https:` links in markdown are clickable and open in the **system browser**.
- New command `Pi: New Session`.

### Security

- The panel HTML uses a **nonce plus a strict CSP** (`default-src 'none'`; scripts and styles
  only from the extension itself).
- Messages are **always inserted as plain text**, never concatenated into `innerHTML`;
  URLs go through a scheme allow-list (`http` / `https` / `mailto` / relative),
  and `javascript:` and friends are downgraded to plain text.
- **Remote images are not loaded** (only `data:image/...`): allowing them would turn a
  model-controlled URL into an outbound channel (a 1×1 pixel can encode content in its query).

### Fixed

- **A second message sent while streaming was rejected** (`Agent is already processing`):
  the gate is now "did pi accept this prompt?" instead of "is a local send still pending?".
- **"Edit queued" silently dropped the queued text**: the return value of `clearQueue()` is now
  restored into the composer.
- **Wrong abort order**: clear the queue before calling `abort()`, otherwise queued messages
  disappear along with the session state.
- **Model policy**: the panel no longer overrides the model you picked in pi (it only falls back
  to a credentialed provider when you never picked one), and it re-aligns after `Pi: New Session`.
- **Extension commands (`/xxx`) left the status line stuck on "busy"** — they emit no
  `agent_settled`; the panel now reconciles with `isIdle`.
- The composer was not cleared after sending (which looked like the message had not been sent).
- The tool name, the composer buttons and the hint text were squeezed into one character per line
  by flexbox (three places).

## [0.1.3] - 2026-09-12

### Fixed

- The self-test now **pins `deepseek-v4-flash`** instead of pi's internal default
  (`deepseek-v4-pro`, roughly 10× the price). `Pi: Run Self-Test` makes a dozen real calls.
- The provider fix from 0.1.2 is finalised here (0.1.2 was an intermediate upload).

## [0.1.2] - 2026-09-12

### Added

- The self-test prints the **list of providers with configured credentials** and the resolved
  model, to make "it does not run" diagnosable.

### Fixed

- **Pick a provider that actually has credentials** instead of landing on `openai/gpt-5.5`:
  on the constrained machine `openai` had a key but no usable model, so every prompt produced an
  empty assistant message — it looked like "pi will not start" when the model was simply unusable.

## [0.1.1] - 2026-09-12

### Fixed

- The self-test works correctly on Windows: it accepts any `*_delta`
  (`text_delta` / `thinking_delta` / `toolcall_delta`); accepting only `text_delta` made
  thinking-only models report a false failure.
- Failures now print diagnostics: the resolved model and the last assistant message's text.

## [0.1.0] - 2026-09-12

First release (pre-release): extension scaffold and the feasibility gate.

### Added

- **Embedded pi**: ships the official pi 0.85.1 bundle and runs it inside the extension host
  (Node/Electron), so it needs **no system Node.js and runs no downloaded executables**.
- **Feasibility gate `Pi: Run Self-Test`** (11 checks): pi runtime loading and version,
  shipped-resource integrity, user extension loading and `onError` reporting, real provider
  streaming, Git Bash and abort, tool-call round trip (including `toolCallId` capture for
  `write`), session persistence and reopen, the image-resize worker, and session switching.
- Commands `Pi: Set API Key` (stored in VS Code SecretStorage) and `Pi: Open Settings File`.
- Packaging chain: `pi-runtime/` and `dist/` are build outputs and never committed; the `.vsix`
  has a required-file check and a 30 MB size gate; CI covers type checking, the self-test,
  protocol/render assertions and packaging verification.
