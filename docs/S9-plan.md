# S9 计划：pi 包管理（`Pi: Install Package` / `Pi: List Packages` / `Pi: Remove Package`）＋ 追加范围：布局 / shell 入口 / 面板内交互

> 状态：**计划期，待评审**（先过评审窗确认默认值，用户说"可以"后才动代码）。
> 上游承诺：`docs/PLAN.md` §6 的 S9 两条（`src/pi/packages.ts` 那行 + 验收那句）。
> **2026-09-17 用户拍板追加**：①面板内对话框 ②API key 卡片 ③面板移右侧 ④shell 路径入口 四项全部并入本阶段
> （§0.8 起的追加范围）。**Astra 第 1 轮（2026-09-17，§10.3）已审：8 条实质意见全部 ACCEPT 并落盘**；
> 本轮修订新写的内容（§3.7 的用户配置预检、§3.8 的 `dialog/close`/就绪独立性/晚到加载过滤、A32–A35）
> 已过 Astra 第 2 轮与末轮转写核对（§10.4/§10.5，末轮 `VERDICT: OK`）；按末轮意见做的转写修正也已落盘。
> 纪律：`AGENTS.md`。**本计划里的每条"pi 的行为"都带 `文件:行号`，每个"我们的观察"都带探针输出。**

## 0. 本计划已核实的事实（都带证据，不靠记忆）

探针：`scripts/probes/s9-package-probe.mjs`（包管理的行为）与 `scripts/probes/s9-reload-probe.mjs`
（装完之后**什么时候生效**）。两个都跑在**我们自己发布的 `pi-runtime/dist/bundle`** 上、临时目录里、
不碰用户的 `~/.pi/agent`。下面的 `F*` 是后面 §3/§6 的引用锚点。

### 0.1 导出面与构造

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `DefaultPackageManager` **在我们发布的 bundle 里**（不是只在 `dist/index.js` 的类型面上）：`typeof pi.DefaultPackageManager === "function"` | 探针 F0；`pi-runtime/dist/bundle/index.js` |
| F2 | `SettingsManager.create(cwd, agentDir, options)` 也可用；**`getExtensionTempFolder` 没有从 bundle 导出**（`typeof === "undefined"`）⇒ 谁都不许依赖它 | 探针 F0 |
| F2b | `isLocalPath` / `parseGitUrl` / `parseSource` **也没有导出**（各 `undefined`）⇒ 源分类只能靠"我们自己的保守判定"，**不能复刻 pi 的规则**（§3.1） | 评审 S3 实跑 |
| F3 | 构造参数是 `{ cwd, agentDir, settingsManager }`（缺 `cwd` 会在 `startsWith` 处抛错 —— 这是 S1 就记下的坑） | `dist/core/package-manager.d.ts:66-70`（`PackageManagerOptions`）· PLAN §2 |
| F4 | `SettingsManager` 落盘是**加锁的读-改-写、只合并"本次改过的字段"** ⇒ 两个实例**改不同字段**时不会互相覆盖。⚠️ **但它防不住同一字段的并发写**：`packages` 数组是在各实例内存里先算好的，锁只覆盖"写入"那一段，后写的会把先写的整份数组盖掉（F33 实测） | `dist/core/settings-manager.js:376-400`（`persistScopedSettings` + `storage.withLock`） |

### 0.2 源解析与作用域

| # | 事实 | 证据 |
| --- | --- | --- |
| F5 | `parseSource()` 只认三种：`npm:` 前缀 → npm；`isLocalPath()` → local；`parseGitUrl()` → git；**都不匹配时兜底成 local**（所以"裸路径"没有 `path:` 前缀这回事） | `dist/core/package-manager.js:1148-1170` |
| F6 | 作用域只由 `options.local` 决定：`local ? "project" : "user"` ⇒ 我们**只提供 user 作用域**就等于只写 `agentDir/settings.json` | `:764-766`（install）、`:790-793`（remove） |
| F7 | 项目作用域会**先查信任**，未信任时抛 `Project is not trusted; refusing to access project package storage` | `:1421-1423`（`assertProjectTrustedForScope`）；探针 F10 实测到这句 |
| F8 | 项目作用域**写进工作区**：`{local:true}` 装完之后落盘的是 `<cwd>/.pi/settings.json`（`"../../my-pkg"`），`agentDir/settings.json` 一个字节没动 | 探针 F11 |

### 0.3 持久化的形态（写进去的到底是什么）

| # | 事实 | 证据 |
| --- | --- | --- |
| F9 | 本地源**被规范化成相对 `agentDir` 的相对路径**再写进 settings：装 `<root>/my-pkg` 之后 settings.json 里是 `"packages": ["../my-pkg"]` | `:1138-1147`（`normalizePackageSourceForSettings` + `path.relative(baseDir, resolved)`）；探针 F2 |
| F10 | 同一个源装两次**不会重复**：`packageSourcesMatch` 命中后只在"形态变了"时改写成新形态并返回 `true`，否则返回 `false`（没改动） | `:618-647`（`addSourceToSettings`，`:627` 那个 `return false`）；探针 F6 |
| F11 | `removeAndPersist()` 的返回值 = `removeSourceFromSettings()`：**没匹配到就是 `false`**（"未移除"），并把 settings 里的 `packages` 变成 `[]`（**保留空数组**，不删键） | `:813-816`、`:649-665`；探针 F5 |
| F12 | 落盘用**全新**的 `SettingsManager` 也读得到 ⇒ 持久化是真的落盘，不是进程内状态 | 探针 F3 |
| F13 | `listConfiguredPackages()` 直接读 `getGlobalSettings()/getProjectSettings()`，返回 `{source, scope, filtered, installedPath?}`；`installedPath` 是**解析后存在**才给（`existsSync` 才返回） | `:741-757`、`:666-682`；探针 F2/F3 |

### 0.4 装完之后"什么时候生效"

| # | 事实 | 证据 |
| --- | --- | --- |
| F14 | 装完之后**跑着的会话什么都不变**（命令表为空，连会话那份 `settingsManager.getPackages()` 都是空的 —— 它是启动时的缓存） | 探针场景 `baseline` |
| F15 | **`session.reload()` 一步就够**：它内部会 `await this.settingsManager.reload()` → `resourceLoader.reload()` → 重建 runtime（`_buildRuntime`）；之后包里的**扩展命令**、**工具**、**主题**全都出现 | `dist/core/agent-session.js:2217-2240`；探针场景 `session-reload` ⇒ `commands: ["pkg-two"]` 且 `getPackages(): ["../pkg"]` |
| F16 | **`settingsManager.reload()` + `resourceLoader.reload()` 两步一起上也不够**（两个单独调更不够）—— 扩展的注册只发生在 `session.reload()` 的 `_buildRuntime` 里 | 探针场景 `settings-only` ⇒ `[]`（但 `getPackages()` 已更新）、`loader-only` ⇒ `[]`、`settings+loader` ⇒ `[]` |
| F17 | 移除后同样：不 reload 命令表还在，`session.reload()` 之后才消失 | 探针场景 `remove` ⇒ 装完+reload `["pkg-two"]` → 移除后**不 reload** 仍 `["pkg-two"]` → reload 后 `[]` |
| F18 | `session.reload()` 的开头是 `session_shutdown(reason:"reload")` + `oldRunner.invalidate()` ⇒ **待审批时 reload 会让审批处理器手里的 `ctx` 变 stale**（S8 的 T14/§11 的 6-4 见过这个形态：我们的 fail-closed 会把它拦成 block，不会静默放行） | `dist/core/agent-session.js:2218-2221`；S8-plan §11 的 6-4 |
| F19 | `reload()` 会重新 `emit session_start`（`reason:"reload"`）+ `extendResourcesFromExtensions("reload")`，且保留 `activeToolNames` | `dist/core/agent-session.js:2226-2239` |
| F20 | 包里的资源怎么被认出来：目录里有 `extensions/`/`themes/`/`skills/`/`prompts/` 子目录就全收（`enabled: true`）；有 `package.json` 的 `pi` 清单则按清单；**两者都没有时把"目录本身"当成一个扩展路径**（pi 之后按"目录入口必须叫 `index.ts`/`index.js`"去加载它） | `:1801-1828`（`collectPackageResources`）、`:1046-1069`（`resolveLocalExtensionSource`）、`dist/core/pi-manifest.js:7-20`；探针 F4/F7 |
| F21 | 真包里的资源确实会被收：探针里那个包带 `extensions/rich.ts`（注册工具 `probe_echo`）与一份**真的**主题文件 ⇒ `session.reload()` 之后 `getActiveToolNames()` 里有 `probe_echo`、`resourceLoader.getThemes()` 里有 `gruvbox-dark` | 探针场景 `rich`（装包前有前置断言：工具表里没有 `probe_echo`、主题表里没有 `gruvbox-dark`） |

**⚠️ 探针纪律（F29）**：每个场景必须跑在**独立进程 + 独立 `agentDir`** 里，并带"装包之前是空的"**前置断言**。
第 1 版把 7 个场景塞在一个进程、共用一个 `agentDir`，于是从第 2 个场景起"全新会话"建好时**已经**带着上一轮的包 ——
那个场景打印的"`session.reload()` 之后有了"是假的（装包之前就有），而它正是 F15 的唯一证据。
同一条纪律在 S6 的 L1 也踩过（"实验也要在干净环境里做"）。现在：`makeWorld` 每场景一个 `mkdtemp`、
`requireClean()` 不干净就 `exit 1`、父进程 `spawnSync` 逐场景起子进程。**评审 B1 用干净进程独立复现过。**

### 0.5 失败的形态（我们要翻译的错误）

| # | 事实 | 证据 |
| --- | --- | --- |
| F22 | 路径不存在：pi 抛 `Path does not exist: <绝对路径>`（`install()` 里的 `existsSync` 检查） | `:777-781`；探针 F8 |
| F23 | **没有 npm 时**：`npm:` 源抛的是**裸的 spawn 错误**，没有"需要 npm"这种话：`spawn /nonexistent/npm-binary ENOENT`；**settings.json 没有被写脏**（`installAndPersist` 是"先 install 再写"，install 抛了就不写）。**未实测**：真实受限机上 `npm` 通常是"不在 PATH 里"，原文可能是 `spawn npm ENOENT` —— 两种形态都含 `ENOENT`，§3.1 的正则都命中（但别以为只有前一种） | 探针 F9（把 `settings.json` 的 `npmCommand` 指到不存在的路径造出来）；`:786-789`（`await this.install()` 在前） |
| F24 | CLI 的措辞（我们尽量对齐，不发明新词）：装成功 `Installed <source>`；移除成功 `Removed <source>`；移除没匹配到 `No matching package found for <source>`（并且退出码 1）；列表空 `No packages installed.`，非空分 `User packages:` / `Project packages:`，`filtered` 的加 `(filtered)` 后缀 | `dist/bundle/chunks/chunk-JVUZSMYM.js:1544`（`package` 命令的 switch） |

### 0.6 现状：接哪儿、别碰哪儿

| # | 事实 | 证据 |
| --- | --- | --- |
| F25 | 命令都在 `src/commands.ts` 里注册（`registerCommands(context, output, pickers?)`），`agentDir` 取自 `module.getAgentDir()`、cwd 取自 `workspaceCwd().cwd` —— 与 S8 的 `Pi: Project Trust…` 同一套 | `src/commands.ts:37-46`、`:254-296` |
| F26 | 我们的面板**没有斜杠命令**：扩展注册的命令（`getRegisteredCommands()`）目前**没有任何 UI 入口** ⇒ 包里"注册命令"这件事在面板里看不见；**看得见的是工具**（agent 调用时出卡片） | `grep -rn "getRegisteredCommands" src/` 只命中自测两处；`src/webview/main.ts` 无斜杠处理 |
| F27 | 用户的真实 `~/.pi/agent/settings.json` **已经**有 `"packages": ["../../Desktop/prj/pi-config"]`，且 `theme: "catppuccin-mocha"` 正是 pi-config 的主题 ⇒ 拿 pi-config 当"新装一个包"的验收夹具会**撞上幂等分支**（装完什么都不变）；它更适合当"已经装过"的分支夹具 | 实读 `~/.pi/agent/settings.json`（2026-09-15） |
| F28 | `Pi: Run Self-Test` 的**大部分**项用**真实 agentDir**（`module.getAgentDir()`）；只有 T14 这类自带隔离夹具的项例外 ⇒ 包管理的自测项**必须**自带临时 agentDir，否则会在用户配置里写 `packages` | `src/pi/selftest.ts`（T14 的夹具）+ `src/commands.ts:47-60`（`agentDir: module.getAgentDir()`） |

### 0.7 第 2 轮评审补的事实（B1–B5 / S3 / S6 的依据）

| # | 事实 | 证据 |
| --- | --- | --- |
| F31 | 🔴 **`SettingsManager.create` 默认 `projectTrusted: true`**（不传就是"信任项目"）⇒ 它会**合并项目 `.pi/settings.json`**；而包管理会读 `getNpmCommand()` 并 **spawn 那个命令** ⇒ 未信任的项目配置能决定我们执行什么程序 | 默认值 `dist/core/settings-manager.js:169-179`；`getNpmCommand` → `runNpmCommand` 见 `package-manager.js:1426-1446`。评审 B1 实测：项目里写 `npmCommand:["/nonexistent/s9-project-command"]` 后，按计划构造的 manager 装 `npm:…` 报 `spawn /nonexistent/s9-project-command ENOENT` |
| F32 | **写盘失败不抛**：settings.json 是坏 JSON 时 `installAndPersist()` **正常返回**、内存里 `getPackages()` 也有那条，但**文件没写**；错误只留在 `SettingsManager` 内部，公开的出口是 **`drainErrors()`**（`d.ts:195`） | 评审 B4 实测：`{invalid-json` 的 settings → `threw:false`、`disk` 仍是坏内容、`errors:[{scope:"global",error:"SyntaxError…"}]`；`dist/core/settings-manager.js:355-366/401-410` |
| F33 | **并发两次安装会丢更新**：两个 `SettingsManager` 各自算好 `packages` 再写 ⇒ 后写的覆盖先写的（实测只剩后一个包），而两次调用都"成功返回" | 评审 S3 实测（同一个临时 agentDir、两个 manager、两个不同本地包）；机制 = F4 的更正 |
| F34 | 🔴 **`session.reload()` 不会重新裁决项目信任**：它沿用活会话 `settingsManager` 上的 `projectTrusted` ⇒ "空目录先建会话（按信任）、之后目录里长出 `.pi/extensions/`"时，`reload()` 会**未经询问**把那个扩展装进来 | 评审 B2 实测（用**已修好的** resolver + 真 pi）：`{"asked":0,"memoSize":0,"trusted":true,"commands":["unapproved-project"]}`；`dist/core/agent-session.js:2217-2239`（reload 里只有 `settingsManager.reload()`，没有信任钩子） |
| F35 | **两个"忙"的口径不等价**：`isStreaming = _isAgentRunActive`、`isIdle = !_isAgentRunActive && !isCompacting` ⇒ **压缩期间** `snapshot().busy` 为 false 而 `controller.isBusy()`（= `pendingSend \|\| !isIdle`）为 true | `dist/core/agent-session.js:616-622`；`src/pi/controller.ts:336-338` vs `:856`；评审 B3 用真 getter 实测 |
| F36 | **"新建会话"是既生效又重裁决的生产路径**：`session.ts:99` 的 `SettingsManager.create(...)` 在 `createRuntime` **闭包之内** ⇒ 每次新建会话都会新读 settings（看得见刚装的包）**并重跑信任钩子**（A10⑪ 就是"新会话必须问"） | `src/pi/session.ts:90-121`（`createRuntime` 内）；S8-plan §6 A10⑪ |
| F37 | git 源在**带 `package.json`** 时也会调 npm（所以"这个源要 npm"确实不止 `npm:` 一种），但 **git 自己缺失**也会产生 spawn ENOENT ⇒ 不许把所有 git ENOENT 都叫成"缺 npm" | `dist/core/package-manager.js:1502-1528`；评审 S2 |

### 0.8 追加范围的事实（F38–F46；2026-09-17 用户拍板后补核；Astra 第 1 轮已复核 F38–F42，F43/F45 已按它的 B1/S6 改写）

背景：用户在 Windows 真机踩中"bash 装在 `%LOCALAPPDATA%` 下且不在 PATH"的盲区（F39），随后拍板把四项
体验修复全部并入 S9。编号沿用与用户对话的口径：**①②＝面板内交互（对话框/API key），③＝布局，④＝shell**。

| # | 事实 | 证据 |
| --- | --- | --- |
| F38（③） | `contributes.viewsContainers` 的合法键是 `activitybar` / `panel` / **`secondarySidebar`**；版本下限 **1.104**（1.100–1.103 均无）。本仓 `engines ^1.123.0` ⇒ 余量 19 个 minor。官方贡献点文档至今只写 activitybar/panel —— **文档滞后，不是特性不存在** | 源码 `src/vs/workbench/api/browser/viewsExtensionPoint.ts`（GitHub tag 逐个实取 grep）；本机 VS Code 1.134 的 workbench bundle：schema 三键 + `additionalProperties:false` + `case "secondarySidebar"` 注册进 AuxiliaryBar |
| F39（④） | pi 在 win32 找 bash 的瀑布：①`settings.json` 的 `shellPath`（最高优先，`existsSync` 校验）→ ②`%ProgramFiles%\Git\bin\bash.exe` → ③`%ProgramFiles(x86)%\…` → ④`where bash.exe`（PATH）→ ⑤报错（自带三条出路与已搜路径清单）。**盲区（用户 2026-09-17 真机踩中）**：Git **按用户安装**落在 `%LOCALAPPDATA%\Programs\Git`（⇒②③不存在），而安装器默认 PATH 选项只把 `<安装目录>\cmd`（git.exe）加进 PATH、**不加 `bin`**（bash.exe 所在）⇒ ④也落空。附：`shellPath` 指到旧式 WSL `System32\bash.exe` 有 stdin 传输的特殊兼容 | `pi-runtime/dist/bundle/chunks/chunk-JVUZSMYM.js` 的 `getShellConfig`（逐行读过）；用户实测报告（2026-09-17 对话） |
| F40（④） | 写穿入口类型完备：`SettingsManager.create(cwd, agentDir?, {projectTrusted?})`、`setShellPath(string \| undefined)`（写 **global** 作用域并即存）；`withLock(scope, fn)` 是**文件级**锁且读改写都在锁内 ⇒ 与包管理写并发安全。B1 信任边界同样适用（F31） | `settings-manager.d.ts:163/253-254`、`settings-manager.js`（`withLock` 实现） |
| F41（④） | `getShellConfig` 已从 bundle 导出 ⇒ 扩展侧可**预检**"现在会解析到哪个 bash / 会不会抛"。**⚠️ 签名是 `getShellConfig(customShellPath?)`（Astra B2，实测）**：无参 = 纯自动探测（**不读 settings.json 的 `shellPath`**）；显式路径存在则用、不存在抛 `Custom shell path not found: <path>`。生产 bash 工具调它时会传入设置值 ⇒ 预检要**自己先读已保存的用户配置（global）**（§3.7 的 `resolveCurrentShell`，R2-B2 定的口径）。配套读面：`SettingsManager.getShellPath(): string \| undefined` | 实测：`getShellConfig()` → `/bin/bash`、`getShellConfig('/bin/sh')` → `/bin/sh`、`getShellConfig('/nonexistent')` → 抛 `Custom shell path not found`；`node_modules/…/pi-coding-agent/dist/index.d.ts:35`、`core/settings-manager.d.ts:253`；对 bundle 实测 151 个导出含它 |
| F42（①②） | `showQuickPick` / `showInputBox` 的渲染位置是 VS Code **硬编码在窗口顶部**，无任何 API 能移。接出面：`uiContext.ts:135/146/155`（pi 扩展的 select/confirm/input）、`modelPicker.ts:93/102/148`、`sessionPicker.ts:100`、`commands.ts:94-117`（Set API Key）。`modelPicker.ts` 文件头留着 S4 "为什么用原生"的四条硬要求（✓标记 / Thenable 加载态 / 焦点归还两条退出路径 / fromPanel 分流）—— 面板版必须**逐条平移**，不是删注释了事 | VS Code API 文档（QuickPick/InputBox 无位置参数）；各文件行号实读 |
| F43（①②） | **被 pi `await` 的钩子不能依赖面板重放**：面板重放（`chatView.ts` ready 处理）目前排在 `await controller.ensure()` **之后**，而 `ensure()` 内含 `bindExtensions()`（会等待 session_start 处理器，处理器可调 `ctx.ui.select/confirm/input`）。**自锁的一般形态**（Astra B1）：初始化期间处理器挂起在对话框上 → 销毁视图 → 重开 → ready 先等 ensure（仍 pending，等那个对话框的回答）→ 卡片重放不来 → 永远无法回答。信任模态只是最典型的实例（S8-plan §0.2 F16，保持原生居中模态，是**显式例外**）；一般解法是 §3.8 的"对话框链路独立于 ensure" | `src/host/chatView.ts:241`（ready → `await controller.ensure()` → `this.replay()`）；`pi-runtime/dist/bundle/chunks/chunk-JVUZSMYM.js`（`bindCurrentSessionExtensions` → `session.bindExtensions({uiContext,…})`，扩展的 select/confirm/input 都从 uiContext 走）；S8-plan §0.2 F16 |
| F44（①②） | 宿主挂起 ↔ 面板作答的骨架已存在（S8 审批卡）：卡片 `approval` 态、`approvalDecision` 回传、面板不可见时通知 + 状态行 + 重开重放。对话框卡片复用同一骨架（含"销毁不取消"的 Q10 裁决） | `protocol.ts:126/172`、`chatView.ts:137-147`（`announcePendingApproval`） |
| F45（①②） | 键盘验证要分**两层**（Astra S6 收窄口径）：**测不了的是**"原生激活 / 真焦点 / 真输入法"——happy-dom 不实现 `<button>` 的原生激活（S8 §10.2 的 STRONGEST_OBJECTION：按 Enter 会不会发两条在那里加不加 `preventDefault` 都一样）；**测得了的是**我们自己代码对 `KeyboardEvent` 的反应——仓库 `scripts/webview-dom-check.mjs` 已在无头派发 KeyboardEvent 验 Enter 发送与 `isComposing` 守卫 ⇒ 面板卡片的 ↑↓/Enter/Esc/IME 守卫**自动断言**（A33），真机只留原生激活与真焦点（M1⑥/W1④ 收窄后） | S8-plan §10.2；`scripts/webview-dom-check.mjs`（Enter 发送、`isComposing=true` 不发送的先例） |
| F46（③） | VS Code 对视图位置有**工作区级记忆**。已装用户（0.1.x 容器在左栏）升级后位置如何迁移**未实测**；保守口径：README/发版说明写"若仍在左侧：右键视图标题 → 移至辅助边栏"（Q16） | 未实测（明说）；VS Code 视图位置记忆机制（workspace state） |

## 1. 目标与判据

上游两条（PLAN §6）拆成可判的条目。断言编号见 §6。

| # | 判据（用户视角） | 自动断言 |
| --- | --- | --- |
| C1 | `Pi: Install Package` 接受 **pi 原生源格式**（裸本地路径 / `npm:name` / git URL），**不发明** `path:` 之类前缀；只装 **user 作用域**（写 `<agentDir>/settings.json`），**绝不写工作区** | A1/A2/A3 |
| C2 | 装成功后：`settings.json` 里出现该包（本地路径是**相对 agentDir** 的形态）、面板给出人话的反馈（安装了哪个源、写去了哪个文件、**怎么让它生效**） | A4/A5 |
| C3 | 装完之后**包真的能生效**，而且**生效路径只有"新建会话 / 重载窗口"**（不自动 `session.reload()`，理由见 §3.3/§5 R9）；界面必须**明说**怎么生效。新建之后的会话里，包里的**工具**能用、**主题**在列表里 | A6/A7（生产路径 = `runtime.newSession()`） |
| C4 | `Pi: List Packages` 显示 `listConfiguredPackages()` 的**全部**条目，标明作用域与解析后的路径；**本地路径已经失效**的条目要明说（这是 README 里那条"扩展升级后失效"的可见化） | A8 |
| C5 | `Pi: Remove Package` 移除配置里的条目；pi 说"没匹配到"时**不许**报告成功（`removeAndPersist()` 返回 `false` ⇒ 明确提示"未移除"） | A9/A10 |
| C6 | 受限机上 **`npm:` 源**失败时给出**能懂的**提示（"这个源需要 npm"），而不是把 `spawn … ENOENT` 甩给用户；**git 源**（含要 npm 的 git 源）保留 pi 的原文（F37：缺 git 与缺 npm 在 spawn 错误里分不开，硬翻译会撒谎）；**不许**把失败说成成功，也不许留下写脏的 settings | A11/A12 |
| C7 | 不碰用户数据、也不许**未信任的项目配置**影响我们：①`agentDir` **必须显式给**（不许回退 pi 默认目录）；②**写路径**显式 `projectTrusted: false`（否则项目的 `npmCommand` 决定我们 spawn 什么，F31）；③配置只写 **user 作用域**，**不碰工作区**（`{local:true}` 一律不用）；④npm/git 的包存储由 pi 在它自己的目录里管（不是"只动一个文件"）；⑤自测项自带临时 agentDir；⑥`Pi: Install Package` 在没打开过面板时也能用 | A2/A3/A13a/A13b/A14/A18 |
| C8（③） | 新装用户的面板默认在**辅助边栏（右侧）**打开，与资源管理器并排；`Pi: Focus Chat` 仍可用 | A23 + M1/W1 肉眼 |
| C9（④） | Windows 上 bash 不在 pi 探测瀑布内时，`Pi: Set Shell Path` 给出候选（**含按用户安装位置**）或手输路径，写进 pi 的 `settings.json`（`shellPath`）并明说生效方式；**已保存的用户配置（global）预检**（`{projectTrusted:false}` 的 manager 读 `getShellPath()` 再传参 `getShellConfig`，F41；不受项目配置影响，Astra R2-B2）把"会抛"提前暴露；自测 T16 报告解析结果 | A24/A25/A26 |
| C10（①②） | 聊天中的 select/confirm/input、**面板发起**的模型/思考等级/会话选择、API key 输入都停在**面板里**，不再弹窗口顶部；Esc/取消语义与原生版一致；模型列表**加载期间有 loading 指示**，失败/取消后焦点还给聊天输入框（F42 第 4 条扩到三条退出路径）；挂起的对话框**不依赖会话 ensure**（初始化期间销毁重开也能作答，F43）；面板不可见时通知喊话（对齐 S8）；**命令面板发起**的保留原生（Q11） | A27/A28/A30–A35 |
| C11（②） | API key 只经 postMessage 进宿主（SecretStorage），**不进重放、不进 Output 日志、不进 webview 状态** | A29 |

## 2. 本步做什么 / 不做什么

**做**：

- `src/pi/packages.ts`（纯 Node，可测）：
  - `createPackageManager({ pi, cwd, agentDir })` —— 内部 `SettingsManager.create(cwd, agentDir)` + `new DefaultPackageManager({cwd, agentDir, settingsManager})`；
  - `installPackage(source)` / `removePackage(source)` / `listPackages()`；
  - `translateSourceError(error, source)` —— 把 F22/F23 那两种形态翻成人话（纯函数，断言好写）；
  - `describePackage(entry)` —— `{label, description, detail}`（列表里那一行；纯函数）。
- **四个 VS Code 命令**（`src/commands.ts`）：`jerrypi.installPackage` / `jerrypi.installPackageFromFolder` /
  `jerrypi.listPackages` / `jerrypi.removePackage`（**三项能力、四条命令** —— 安装有两个入口，见 Q2/N1）
  （**主入口是输入框**；另加**从文件夹选**的辅助路径，见 Q2）。
- 装/卸之后：**写盘 + 写后回读校验**（§3.1），然后明说 **"新建会话（或重载窗口）后生效"** —— **不热重载**（Q3 改了，理由见 §3.3/B2）。
- 文档：README 中英（四个命令 + 三条已知限制）、`pi-traps` 加条目、`PLAN.md` §6 那段"已知限制"逐字落地。
- 自测 **T15**（gating，**不用模型**） + host-check 的 A1–A14。
- **追加范围（同样做，§3.6–§3.8）**：
  - `package.json`：`viewsContainers.jerrypi` 从 `activitybar` 移到 `secondarySidebar`（③，一行）+ README 迁移说明；
  - `src/pi/shell.ts`（纯逻辑）：`shellCandidates()` 候选生成 + `resolveCurrentShell()`（包 `getShellConfig`）+ `setShellPath` 写穿（`{projectTrusted:false}` 的 manager，对齐 B1）；
  - 命令 **`Pi: Set Shell Path`** + 自测 **T16**（advisory，打印解析结果）；
  - 协议加 `dialog/open` / `dialog/answer`（§3.8）+ 宿主侧 `DialogHost`（复用 `withDialog` 的竞争骨架）+ webview 三种卡片与 password 卡 + `modelPicker`/`sessionPicker`/`setApiKey` 的面板内入口；
  - 夹具（`test-fixtures/ext-smoke` 与 Mac 的 `s9-pkg-demo`）加 **`/smoke-ask`** 命令（走 `ctx.ui.select/confirm/input` 的真弹窗链，不用模型）。

**不做**（每条都要说清为什么）：

| 不做 | 为什么 |
| --- | --- |
| **项目作用域**（`{local:true}` / "装到这个工作区"） | 它会**写进用户仓库的 `.pi/settings.json`**（F8 实测）。这与"别动用户的东西"直接冲突；真要做也得单独设计（问一句、可撤销、写进 README）。v1 只做 user 作用域（= 与 CLI 的默认行为一致） |
| 扩展命令的 UI 入口（把包里的 `/cmd` 搬进面板） | 面板没有斜杠命令（F26），这是个**独立的**功能（还要考虑与 VS Code 命令面板的命名冲突）；S9 的承诺里只有"装/列/卸" |
| `update` / `checkForAvailableUpdates` / 自动更新 | pi 有这些 API，但"联网更新"要单独的网络策略与验收（S6 的代理教训），且用户没要求 |
| 在 VS Code 里编辑 pi 的包清单（过滤 `enabled` 字段、`autoload:false` 的 delta 包） | `PackageSource` 支持对象形态（`{source, extensions:[…]}`），面板要为此设计一套表单；v1 只处理字符串形态（列表里给 `filtered` 的加 `(filtered)` 后缀，与 CLI 一致，F24） |
| 自己实现"包目录扫描/校验"（比如判断一个裸路径"像不像包"） | 那是 pi 的规则（F20），复刻一份就会分叉。我们只把 `false`/报错原样翻译 |
| **装完自动 `session.reload()`**（第 1 轮 Q3 的默认值，第 2 轮 B2 推翻） | F34：`reload()` **不重新裁决项目信任** —— "空目录先建会话、之后目录里长出 `.pi/extensions/`"时，它会**未经询问**把那个扩展装进来（实测 `asked:0` 而 `commands:["unapproved-project"]`）。而"新建会话"这条路每次都会新读 settings **并重跑信任钩子**（F36）。为一个"省一次新建会话"的便利去开这个口子不划算（F18 的 stale ctx、F35 的忙口径也跟着一起来） |
| **让"已信任的项目"影响包管理**（第 2 轮 B1 的备选） | 要做得对得起信任，就得把 S8 的裁决接进命令层再逐条断言；而 v1 只写 user 作用域（Q1），显式 `projectTrusted: false` 既够用又最安全。写路径**不许**复用"读列表"那份 manager |
| 装完自动**重启**扩展宿主 | VS Code 不允许扩展重启自己；`session.reload()`（F15）已经够用 |
| **键盘的无头断言：只跟"原生激活/真焦点/真输入法"三层**（追加范围） | F45（收窄后）：我们自己的 keydown handler（↑↓/Enter/Esc/IME 守卫）**能**无头测（A33，仓库已有 KeyboardEvent 派发先例）；测不了的是 button 原生激活、真焦点、真输入法 —— 那三层留给 M1⑥/W1④ 真机 |
| **项目信任模态进面板**（追加范围） | F43 自锁死；保持原生（S8-plan §0.2 F16，它是居中模态、不在顶部） |
| `jerrypi.shellPath` VS Code 设置（追加范围） | pi 的 `settings.json` 已是唯一真相源，命令写穿即可；两层设置必然分叉（Q14） |
| 通知类 toast 面板化（追加范围） | 收益低：原生通知在**右下角**、不在顶部，不属于本次抱怨的痛点 |
| 自动扫描全盘找 bash（追加范围） | 越权且慢；候选只跟已知安装位置 + PATH + `where`（§3.7） |

## 3. 关键设计

### 3.1 `src/pi/packages.ts`（纯逻辑，不认识 vscode）

**形状是"依赖 + 一次性函数"，不是"长命的 manager 对象"**：每次命令都新建 `SettingsManager` +
`DefaultPackageManager`（它们会读盘，成本是几次 `readFileSync`），所以"看到的是文件里的真相"
（§3.2）**天然成立**；反过来，"在构造期缓存一份"这种退化要能被断言抓住（A10 的红法就靠这个形状）。

```ts
export interface PackageDeps {                    // 只依赖 pi 的导出面 + 路径
  pi: PiModule;                                   // DefaultPackageManager / SettingsManager
  cwd: string;
  agentDir: string;                               // **必填**：没有它直接抛（C7；不许回退 pi.getAgentDir()）
}

export type InstallOutcome =
  | { ok: true; changed: boolean; source: string }
  | { ok: false; message: string };
export type RemoveOutcome =
  | { ok: true; removed: boolean; source: string }
  | { ok: false; message: string };

export function listPackages(deps: PackageDeps): ConfiguredPackage[];      // 转发 pi（F13）
export function installPackage(deps: PackageDeps, source: string): Promise<InstallOutcome>;
export function removePackage(deps: PackageDeps, source: string): Promise<RemoveOutcome>;
export function settingsPathOf(deps: PackageDeps): string;                 // <agentDir>/settings.json（给文案用）
```

- **`changed`**：装之前/之后比 `settingsManager.getPackages()`（F10）——`false` 表示"本来就在配置里"，
  文案走"已经装过了（未改动）"这一支（用户的 pi-config 正好会走这里，F27）。
- **`removed`**：`removeAndPersist()` 的返回值**原样透出**（F11）—— `false` 就是"未移除"（C5）。
- 失败一律**不抛**，返回 `{ok:false, message}`；`message` 由 `translateSourceError` 产出。
- `agentDir` 为空/缺失 ⇒ **直接抛**（`jerrypi: 包管理需要明确的 agentDir`）。理由见 C7：
  一次"忘了传 agentDir，于是悄悄写进了用户真实配置"的事故，比一条显式的错误贵得多。

**两份 `SettingsManager`，职责不重叠**（第 2 轮 B1/B5）：

| 用途 | 构造 | 为什么 |
| --- | --- | --- |
| **写**（install/remove） | `SettingsManager.create(cwd, agentDir, { projectTrusted: false })` | F31：默认值 `true` 会合并**未信任项目**的 `.pi/settings.json`，而包管理会 spawn `npmCommand` ⇒ 那等于让项目配置决定我们执行什么程序。写 user 作用域本来也不需要项目配置 |
| **读**（list） | `SettingsManager.create(cwd, agentDir, { projectTrusted: true })`，**只读** | 只为了把项目级条目也列出来（C4/pi CLI 的显示约定）。它**绝不**传给 install/remove —— A13b 用源码不变式钉住这一点（"读的那份不许出现在写函数里"） |

**三件"看起来啰嗦但都有判例"的事**：

1. **写后回读校验**（第 2 轮 B4）：`installAndPersist()` 正常返回**不等于**落盘成功（F32：坏 JSON 时它照样返回，
   内存里还有那条）。所以写完用**一个新的 manager** 读回来确认那条源真的在文件里；不在 ⇒
   报失败并把 `drainErrors()` 的内容写进 Output（**不许**报"已保存"）。
2. **同一模块内的串行化**（第 2 轮 S3）：`installPackage`/`removePackage` 共用一个模块级 promise 链
   （`withPackageLock`），保证"算数组 → 写文件"这一步不并发；F33 的丢更新就是这么来的。
   **跨进程**（终端 `pi`、另一个窗口同时改同一个字段）**不在覆盖范围**，README/§12.4 明说 ——
   不假装 F4 已经解决了它。
3. **失败一律不抛**，返回 `{ok:false, message}`（`message` 由 `translateSourceError` 或校验失败产出）。

`translateSourceError(error, source)` 的规则（每一条都要有断言，A11）：

| pi 给的 | 我们给的 |
| --- | --- |
| 消息匹配 `/\bENOENT\b/`（以及 `spawn` 字样），且**源以 `npm:` 开头** | `这个源需要 npm 才能安装（npm: 包 / 带 package.json 的 git 源都要它）；当前机器上没有可用的 npm。本地文件夹仍然可以装。` |
| `Path does not exist: <p>` | 原样保留（它已经说清了），前缀 `找不到这个路径：` |
| 其它 | 原样透出 pi 的消息（不吞、不重写） |

⚠️ **这里刻意"不复刻 pi 的 `parseSource`"**（评审 S3）：pi 的 `isLocalPath` / `parseGitUrl` / `parseSource`
**一个都没从 bundle 导出**（实测 `undefined`，F2b），而复刻一份就会分叉 —— §2 的"不做"清单里
已经写死了这条。我们只需要一个**保守的否定条件**`isNpmSource(source) = source.startsWith("npm:")`：
判错的代价是"git 源在没 npm 的机器上退回 pi 的原文（用户看到 `spawn … ENOENT`）"，属于安全方向；
而放宽成"含 `:` 就算 npm"会误伤 `C:\…` 这种 Windows 路径（A1 的红法就是这一条）。

### 3.2 命令的形状与作用域边界（`src/commands.ts`）

```
Pi: Install Package        → showInputBox（placeholder 列出三种源形态）→ installPackage()
                             → 成功：信息消息 + Output 明细（含 settings 路径 / 是否生效）
                             → 失败：警告消息（人话）+ Output 原文
Pi: Install Package from Folder…  → showOpenDialog({canSelectFolders}) → 同上（Q2）
Pi: List Packages          → QuickPick（每项：源 + 作用域 + 解析路径，失效的标"找不到"）
Pi: Remove Package         → QuickPick（候选 = **只有 user 作用域**的包）→ removeAndPersist()
                             → removed=false 时提示"未移除（配置里没有匹配的条目）"
```

- **为什么候选要过滤作用域**（第 2 轮 B5）：`listConfiguredPackages()` 同时给 user/project 两类，
  而我们的 remove 固定 user 作用域 ⇒ 若两边都有同一个本地源，用户选了 project 那一行、我们删的是
  **user 那一行**（`removed:true`，但删错了对象）；只有 project 行时则永远"未匹配"。
  ⇒ **移除候选只列 user**；project 行在 `Pi: List Packages` 里照常展示（C4），但标注
  **"（项目作用域：本版本不管理）"** 且不可选中移除。

- 输入框与 QuickPick **都由宿主侧弹**（与 S8 的 `Pi: Project Trust…` 一致），**不经过 webview** ⇒ 协议**不用改**。
  文件夹选择器必须用 `uri.fsPath`（**不是** `uri.toString()`，那会给出 `file:///…`）；这正是
  `scripts/fixtures/vscode-stub.mjs:150` 注释里记着的那次事故形态，所以桩里也要有它（A17）。
- 输入框里 ESC / 空串 → 直接返回（不产生任何副作用）。
- `Pi: List Packages` 用**全新**的 `SettingsManager`（F3/F13），所以看到的是**文件里的真相**，
  不受"跑着的会话缓存"影响（F14）。

### 3.3 装完之后怎么生效：**不自动 reload，走"新建会话"**

**决定（第 2 轮 B2 推翻第 1 轮的 Q3）：装/卸之后什么都不"热重载"，只写盘 + 告诉用户怎么让它生效。**

理由（三条，都有实测）：

1. 🔴 **`session.reload()` 不重新裁决项目信任**（F34）：它只做 `settingsManager.reload()`（重读文件），
   而 `projectTrusted` 是**活会话**上那个值 ⇒ "空目录先建会话（按信任）、之后目录里长出
   `.pi/extensions/foo.ts`"时，reload 会把 foo **未经询问**装进当前会话（实测 `asked:0`、
   `commands:["unapproved-project"]`）。我们**没有**能力在 reload 之前"补问一次"（那需要重建会话，
   代价和"新建会话"一样）。
2. **`reload()` 会让旧 runner 的 `ctx` 变 stale**（F18）+ 会重发 `session_start`（F19），
   而我们正在跑一轮的时候不该动这些。
3. **忙的口径**也不干净：`snapshot().busy` 与 `controller.isBusy()` 在**压缩期间**不等价（F35）——
   要做到"只在真空闲时 reload"就得再引入一套判断，而收益只是省掉用户一次"新建会话"。

而**"新建会话"这条路本来就是对的**（F36）：`session.ts` 的 `SettingsManager.create(...)` 在
`createRuntime` 闭包**之内** ⇒ 每个新会话都会**新读 settings**（看得见刚装的包）**并重跑信任钩子**
（A10⑪ 那条"长出 `.pi/` 之后必须问"就是它）。所以：

| 阶段 | 行为 |
| --- | --- |
| install/remove 成功且**写后回读校验通过** | 信息消息：`已安装/已移除 <source>`（写进 `<agentDir>/settings.json`）＋**`新建会话（或重载窗口）后生效`** |
| 正在跑（`snapshot().busy`） | 文案一样，只是多说一句"当前这一轮不受影响" |
| 校验失败 / pi 抛错 | 警告消息（人话）+ Output 里放 pi 的原文与 `drainErrors()` |

**不做 `SessionHost.reloadSession()`、也不给 `PickerCommands` 加忙/重载接缝**（第 1 轮 B3/S6 想要的那套
随 B2 一起取消）。命令层与 `session.ts` 的接触面因此是**零**（C7 的第 ⑥ 条：没打开过面板也能用）。
**验证点**：A6（文案 + 源码里不出现 `reload(`）+ A7（新建会话之后工具/主题真的出现）。
第 1 轮 F15/F16/F17 仍然是**事实**（"`session.reload()` 一步就够"），但它们是**探针层的机制证据**，
不是我们要走的路径 —— 留着是为了下次有人问"为什么不能原地生效"时有答案。

### 3.4 自测项 T15（**不用模型**，自带临时 agentDir）

```
T15：包管理的往返（临时 agentDir + 临时 cwd + 一个临时"包"）
  ① **先**建会话（脚本化模型流，与 T14 同一套）→ 工具表里**没有** probe_echo   ← 基线，必须在 install 之前
  ② install → <tmp>/settings.json 出现 "packages": ["../pkg"]（相对形态，F9）
  ③ 同一 cwd 下 cwd/.pi/settings.json **一个字节都不动**（F6/F8，C1）
  ④ list() 命中那条：scope=user、installedPath=绝对路径
  ⑤ **新建会话**（`host.runtime.newSession()`，**生产路径**，F36）→ 工具表里有 probe_echo、
     主题列表里有那个主题（F21）
  ⑥ remove → 返回 true；再 remove → **false**（F11）
  ⑦ **再新建一个会话** → 工具表里 probe_echo 消失
```

⚠️ **①必须在②之前**（评审 B2）：装完之后**任何**新建会话都已经带着那个包了（F29 的机制）——
按上一版"先装后建会话再断言'装之前没有'"的顺序，①恒假、⑤恒绿，而 T15 是 **gating**，
那会让 `check:gate` 永远红。探针里的 `rich` 场景就是正确顺序的样板（装包前有前置断言）。

⚠️ **⑤⑦ 必须走生产封装**（评审 S4）：调用 `host.runtime.newSession()`（= 面板里"新建会话"按的那条路），
**不是**在夹具里直接 `session.reload()`。否则红法变成"删掉夹具里的一步"（证明的是实验步骤变了），
而不是"生产接线坏了"。**这条的红法**：把 `session.ts` 里那份 `SettingsManager` 从 `createRuntime`
闭包里提到外面（复用启动时那份）→ 新会话看不见包 → ⑤红（这是一次**真实可能发生**的重构）。

为什么放进 `Pi: Run Self-Test` 而不是只留在 host-check：它是**用户机器上的端到端**（真 pi bundle +
真文件系统 + 真会话），且不用凭据/网络 ⇒ 在受限机上也会真跑（与 T14 同一个理由）。

⚠️ **绝不用真实 agentDir**（F28）：整个 T15 在 `mkdtemp` 里，`settings.json` 是临时目录里的那份。

### 3.5 上限与内存

- 列表不分页（`listConfiguredPackages()` 一般是几条到几十条）；QuickPick 天然可搜索。
- 不缓存任何东西：每次命令都新建 `SettingsManager` + `DefaultPackageManager`（它们会读盘，成本是几次 `readFileSync`）。

### 3.6 ③ 面板默认移右侧（F38 已过 Astra 第 1 轮复核，NOTE-1；设计未变）

- 一行 manifest：`contributes.viewsContainers` 里 `jerrypi` 容器从 `activitybar` 改到 **`secondarySidebar`**
  （F38）。容器 `id` 不变 ⇒ `jerrypi.chat.focus`、视图 id、激活事件都不受影响；图标同一张
  （`media/jerrypi.svg`，从活动栏徽标变成辅助边栏顶部图标）。
- 老用户：F46 未实测 ⇒ README/发版说明写"右键视图标题 → 移至辅助边栏"（Q16）；M1 验收用**全新
  profile** 验干净默认位置。
- 断言：A23（manifest 不变量）。

### 3.7 ④ shell 路径入口（已过 Astra 两轮设计 + 末轮转写；口径 = 已保存用户配置（global）预检）

- `src/pi/shell.ts`（纯逻辑，依赖注入，不认识 vscode）：
  - `shellCandidates({env, exists})` → 有序候选：`where bash.exe` 的结果（用户 PATH 的显式意愿，最优先）、
    `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\…`、**`%LOCALAPPDATA%\Programs\Git\bin\bash.exe`**
    （F39 盲区）、`~\scoop\apps\git\current\bin\bash.exe`、`~\scoop\shims\bash.exe`（shim 可执行，
    `getBashShellConfig` 把它当普通 bash）；不存在的候选被滤掉。**不复刻 pi 的探测** —— 候选只用来给用户选，
    生效仍由 pi 自己的瀑布（`shellPath` 写进去之后）决定。
  - `resolveCurrentShell({cwd, agentDir})` → **已保存的用户配置（global）预检**（Astra R2-B2 定口径）：新建
    **`{projectTrusted:false}`** 的只读 manager → `getShellPath()` 有值 → `getShellConfig(该值)`（路径已失效则抛
    `Custom shell path not found: …`，原文透出）；无值 → `getShellConfig()`（纯自动探测）。**不许只调无参版本**
    —— 那验的是探测瀑布，不是"用户刚存的配置"（F41 实测）；**也不许用默认信任的 manager** —— 实测全局
    `/bin/sh`、项目 `/nonexistent/project-shell` 时：`projectTrusted:true` 读到**项目的失效路径**，`false`
    读到全局值；而实际会话从 `projectTrusted ?? false` 起步再走信任裁决（`session.ts:88`）⇒ 默认 manager 会把
    用户已拒绝的项目配置报出来。**corner case 明说**：项目已信任且项目级 `shellPath` 覆盖存在时，实际会话用
    项目值，预检报的是 global 值 —— 预检口径就是"我们写入的那份（global）"，与 `setShellPathWrite` 同源
    （F40：`setShellPath` 写 global）；不假装覆盖项目场景。写穿成功后再调它，看到的**立即**是新值（对跑着的
    会话仍要重载窗口，文案分开说："已写入，重载窗口（或新建会话）后生效"）。
  - `setShellPathWrite({cwd, agentDir, path})` → `SettingsManager.create(cwd, agentDir, {projectTrusted:false})`
    （B1 纪律）+ `setShellPath` + **写后回读**（对齐 A19：坏 JSON / 没写上都不许报成功）。
- 命令 **`Pi: Set Shell Path`**（原生 QuickPick，Q12）：首项显示"当前：`<resolveCurrentShell() 或找不到>`"（"当前"= **已保存用户配置（global）的解析结果**，末轮 S1 定的展示口径），
  其后列探测候选 + "手动输入路径…" + "清除 shellPath（恢复 pi 自动探测）"。写完提示
  **"重载窗口（或新建会话）后生效"**（`_buildRuntime` 在会话构建时读 `getShellPath()`，与 `agentDir` 同款口径）。
- 自测 **T16（advisory，Q13，不用模型）**：一行报告 `resolveCurrentShell()` 的结果（路径 / 抛错原文 +
  "下一步：`Pi: Set Shell Path`"）。advisory 理由：T16 自身不挡 GATE；但**既有** gating 项 T5a/T5b（testBashBasic/
  testBashAbort，`REQUIRED_ITEMS` 含之）在无 bash 的机器上**仍会失败**（Astra NOTE：不能说"整个 GATE 不会被
  bash 缺失挡住"）⇒ 无 bash 的机器 GATE 本来就过不了，W2 的端到端修复才有意义。
- README 已知限制收敛："装在其他路径"的三条出路收敛成"跑 `Pi: Set Shell Path`"（手动改 JSON 仍作为埋底写一句）。

### 3.8 ①② 面板内对话框（已过 Astra 两轮设计 + 末轮转写；含 dialog/close、就绪独立性、晚到加载过滤）

- **协议**（host→webview）：`{type:"dialog/open", dialogId, kind:"select"|"input"|"confirm"|"password",
  title, message?, items?:[{label, description?, detail?}], current?, placeholder?, loading?:boolean}`；
  （webview→host）：`{type:"dialog/answer", dialogId, value? | cancelled:true}`；**撤卡（Astra B3 补）**
  （host→webview）：`{type:"dialog/close", dialogId, reason:"answered"|"timeout"|"cancelled"|"replaced"|"load-failed"}`。
  协议版本 +1，`ready` 握手的版本不一致警告照旧（chatView.ts 的既有机制）。
  **重放**：pending 的 dialog 重发 `dialog/open`，但**不携带已输入的值**（password/input 一律清空，只恢复
  "有一个待答的框" —— 这是为了 A29 的泄漏面）。**同 `dialogId` 二次 `dialog/open` = 内容更新**（加载态 →
  有 items 的模型列表，见下面 modelPicker）。
  **结算语义**（Astra R1-B3 补齐 + R2-S1 闭合，一张表）：answer（用户作答，撤卡 reason=`answered`，
  webview 可渲染"已选择"终态）/ cancel（Esc，`cancelled`）/ signal（pi 侧 abort → 取 fallback，映射
  `cancelled`）/ timeout（竞争胜出，`timeout`）/ replaced（**会话切换**，`replaced`；宿主/控制器的 dispose
  —— S8 三条取消路径里的那条，**不是**视图销毁 —— 映射 `cancelled`）/ load-failed（列表加载失败）⇒ 宿主一律发
  `dialog/close` 撤卡，之后**晚到的 `dialog/answer` 按 dialogId 查不到 pending 就丢弃**（记一行 Output debug，
  不许再 resolve —— 已结算的挂起重演就是 R1/R2 那类"结算改写"事故的镜像）；**视图销毁不结算**（Q10：销毁 ≠
  拒绝，只断开 post 通道，等重开重放；与会话终止的清理是两回事）。
- **宿主 `DialogHost`**（`src/host/dialogHost.ts`）：把 `uiContext.ts` 的 `withDialog` 竞争骨架（signal /
  timeout / Cancel 的 Promise.race）原样保留，只把 `open()` 从"原生控件"换成"post `dialog/open` + 等
  `dialog/answer`"。**就绪/重放/回答路由独立于会话 ensure**（Astra B1，F43 的一般解）：DialogHost 自持对
  当前 webview 的 post 通道（chatView 构造/重建时注入），`open()` 直接 post 给可见视图；`ready` 处理里
  **先** `dialogHost.replay()` **再** `await controller.ensure()` —— 否则"初始化期间（session_start 处理器
  挂起在对话框上）销毁视图重开"会死锁（ensure 等回答、回答重放等 ensure）；`dialog/answer` 的路由直接查
  DialogHost 的 pending 表，不经过 controller。**面板销毁不取消**（对齐 S8 Q10：销毁 ≠ 拒绝，重开靠重放）；
  面板不可见时 `announcePendingDialog`（通知 + 状态行，对齐 `chatView.ts:137-147`）。
- **接入面与分流（Q11）**：**面板发起**（模型/思考等级/会话芯片、面板内"设置 API Key"入口、pi 扩展的
  select/confirm/input —— 它们都在聊天流内，没有"从哪发起"之分）一律走卡片；**命令面板发起**
  （`Pi: Select Model` 等命令直跑）**保留原生 QuickPick** —— 用户焦点在编辑器/命令面板时，在右侧面板里
  等输入是错位。
- **API key 卡片**：`kind:"password"`（输入框 `type=password`）；answer 后宿主走现有 `setApiKey` 的
  保存/校验链（SecretStorage + `injectApiKey` + 本地校验，`commands.ts:117-143`），卡片值不落任何日志/
  重放/webview 状态（A29）。
- **modelPicker 的四条 S4 硬要求平移**（F42）：当前项 `✓` 前缀；**加载态**（Astra S8 补 + R2-B1 补晚到过滤）：
  点芯片**立即** `dialog/open {loading:true}`（卡片显示"加载模型列表…"，不是点击后无响应），`listModels()`
  完成后**同 dialogId** 重发带 items 的 `dialog/open`，失败发 `dialog/close {reason:"load-failed"}`；**发送
  加载结果（成功或失败）之前必须先查该 dialogId 仍在 pending** —— 已结算（用户已 Esc / 会话已替换）就**丢弃
  结果**（不发 open、不发 close、不抢焦点；否则晚到的列表会把已撤的卡片"复活"成孤儿卡，用户选了也不生效）。
  焦点归还的**三条**退出路径（选中 / Esc / 加载失败都把焦点还给聊天输入框）；fromPanel 分流。
  `modelPicker.ts` 文件头的旧论证同步改写（记下"为什么改主意"：位置硬编码在顶部是产品缺陷，四条硬要求平移
  而非作废）。
- **webview 侧**：卡片渲染在消息流末尾（与审批卡同级）：列表卡（↑↓ + Enter + Esc）、输入卡/密码卡
  （Enter 提交 / Esc 取消）、确认卡（两枚按钮）；`dialog/close` 到达即撤卡（**按 reason 渲染终态**：
  `answered` → "已选择"、`cancelled`/`timeout` → "已取消/已超时"；也可直接移除）；`aria-*` 标签 + Tab 序；键盘 handler 逻辑（↑↓/Enter/Esc/IME 守卫）由 A33 无头断言，原生激活
  与真焦点留给真机（F45 两层口径）。

## 4. 决策与默认值（Q1–Q17，等用户拍板）

| # | 问题 | 默认值（我的建议） | 备选 |
| --- | --- | --- | --- |
| Q1 | 作用域 | **只做 user 作用域**（写 `<agentDir>/settings.json`），与 pi CLI 默认一致；不提供项目作用域 | 加 `{local:true}`（会写进用户仓库），需要单独的确认与撤销 |
| Q2 | 本地路径怎么输入 | **两个入口**：`Pi: Install Package`（输入框，三种源都能填）+ `Pi: Install Package from Folder…`（原生文件夹选择器，取 `uri.fsPath`）。理由：Windows 上手输 `C:\Users\…\.vscode\extensions\flyjancy.jerrypi-0.1.x\test-fixtures\ext-smoke` 不现实 | 只留输入框（少一条命令，但 Windows 验收要手输长路径） |
| Q3 | 装完要不要**自动** reload | **不自动 reload**（第 2 轮 B2 推翻第 1 轮默认值）：只写盘 + 明说"新建会话（或重载窗口）后生效"。理由 F34（reload 不重裁决信任）/F18/F35 见 §3.3 | 自动 reload（要多担一条"未访问就加载项目扩展"的边界，且要另配忙判断 —— 不推荐） |
| Q4 | 已经装过的源再装一次 | 报告 **"已经在配置里了（未改动）"**（`changed=false`，F10），**不**当失败 | 静默成功（分不清"装了"和"早就有了"） |
| Q5 | `Pi: List Packages` 里"配好了但路径没了"的条目 | 照常列出，标注 **"找不到（路径已失效）"**（`installedPath === undefined`，F13）；**不**自动删除（那是用户的数据） | 直接过滤掉（会让用户以为配置丢了） |
| Q5b | 列表里的**项目作用域**条目 | 照常列出并标注 **"（项目作用域：本版本不管理）"**，但**不进移除候选**（B5：否则会删错同名 user 条目） | 完全不显示（用户会以为配置丢了） |
| Q9 | 同一模块内并发 install/remove | **串行**（模块级 promise 链，§3.1 第 2 条）；跨进程不保证（写进 §12.4/README） | 不串行（F33：会静默丢一个包） |
| Q10 | 写盘校验失败怎么办 | **不报成功**：警告消息 + Output 里放 `drainErrors()`（F32 的坏 JSON 形态）；**不回滚**（我们没写任何东西，"回滚"会是谎话） | 只看 `installAndPersist` 没抛就报成功（会让用户以为装上了） |
| Q6 | 移除时的确认 | **不**再弹一次确认（QuickPick 选中的动作本身就是意图），但移除**后**要说清移除了什么 | 二次确认（多一次点击） |
| Q7 | `npm:` / git 源在受限机上的文案 | 翻译成"需要 npm"（§3.1 的表），并**保留 pi 的原始消息**在 Output | 只透出 pi 的原文（用户看不懂 `spawn … ENOENT`） |
| Q8 | README 里那条"扩展升级后路径失效" | 写进**已知限制**（PLAN §6 已承诺），并在 `Pi: List Packages` 里可见化（Q5） | 只在 README 写 |
| Q11（追加） | 命令面板发起的选择器是否也面板化 | **保留原生 QuickPick**：只有面板发起（芯片/聊天流内）走卡片 —— 用户焦点在别处时在右侧面板等输入是错位；`Pi: Set Shell Path` 也属此类 | 全部面板化（命令面板跑命令还得先找到面板在哪） |
| Q12（追加） | `Pi: Set Shell Path` 的 UI 形态 | **原生 QuickPick**（命令入口；不依赖 ①② 协议先行，③④ 可先发） | 面板卡片（依赖 ①② 落地，拖慢 ④） |
| Q13（追加） | 无 bash 时 T16 的定位 | **advisory**（T16 自身不挡 GATE：指引已在 T16 文案与 README。但注意既有 gating 项 T5a/T5b 无 bash 仍会失败 —— 这不是 T16 该管的事，也反证 W2 的价值） | gating（把无 bash 的机器整个挡住，过严） |
| Q14（追加） | 要不要 `jerrypi.shellPath` VS Code 设置 | **不加**：pi 的 `settings.json` 已是唯一真相源，命令写穿即可 | 加（多一个入口，多一处会烂的副本） |
| Q15（追加） | 本阶段发布版本号 | **0.1.13**（预发布序列继续；CHANGELOG 推迟到正式版的约定**完全不用破例** —— 原备选栏写反了；S8 的 R1–R4 随它发。**Astra B5**：0.2.0 是总计划 §5.4/S10 定的**首个正式版**语义（预发布验证 G1–G6 通过后才发），S9 直接跳 0.2.0 等于正式版跳过 Windows 预发布验证门槛；"功能批变大"不构成跳门槛的理由） | 0.2.0（要提前建 CHANGELOG，且抢了 S10 的正式版语义 —— 与 PLAN 冲突，除非显式改总计划） |
| Q16（追加） | 老用户（视图位置记忆在左侧）怎么迁移 | **只写 README/发版说明**（"右键视图标题 → 移至辅助边栏"），不弹提示 | 激活时弹一次性提示（多一个打扰；且 F46 未实测，弹窗时机准不准两说） |
| Q17（追加） | Windows 第三个动作 W2（per-user Git 机的 ④ 端到端）要不要 | **要**（超软上限的辩护：那台机器是唯一有"bash 在 `%LOCALAPPDATA%` 下且不在 PATH"配置的机器，属 AGENTS §1 的 ③真进程/④Windows 形态；自动断言只能验写穿逻辑、验不了真机探测链） | 并进 W1（若那台机器恰好也是此配置就顺手；否则 ④ 的端到端没验过） |

## 5. 风险

| # | 风险 | 触发条件 | 处理 |
| --- | --- | --- | --- |
| R1 | **把用户的 settings.json 写脏** | `installAndPersist` 写的是 `packages` 一个字段 | F4（加锁 + 只合并改过的字段）+ A3（**解析后**除 `packages` 以外的字段深相等，见 N2）；失败路径天然不写（F23） |
| **R7** | 🔴 **未信任的项目配置决定我们执行什么**（B1） | 写路径用默认 `projectTrusted: true` 的 `SettingsManager` 时，项目 `.pi/settings.json` 的 `npmCommand` 会被 spawn（F31） | 写路径**显式** `projectTrusted: false`；读列表那份 manager **永不**传给写函数（A13b 的源码不变式）+ A18（恶意 `npmCommand` 不许被 spawn） |
| **R8** | **并发安装静默丢一个包**（S3） | 两个命令/两次点击同时改 `packages`（F33） | 模块级串行队列（§3.1 第 2 条）+ A20；跨进程边界写进 §12.4 |
| **R9** | **"装完就生效"把未信任的项目扩展带进来**（B2） | 用 `session.reload()` 做自动生效（F34） | **不做自动 reload**（Q3），统一走"新建会话"（F36）；A6 的源码不变式 + A7 的生产路径断言 |
| R2 | 装完"看起来成功了但没生效" | 用户不知道要新建会话 | 文案**明说**"新建会话（或重载窗口）后生效"（A5/A6①）+ A7 用生产路径证明确实能生效 |
| R3 | ~~忙碌时 reload 造成中断~~ | —— | **不再适用**：Q3 决定不自动 reload（§3.3）。F18/F35 作为"为什么不做"的依据保留（F35 还记着两个忙口径在压缩期间不等价） |
| R4 | 自测项污染用户配置 | T15 用了真实 agentDir 就会写 `packages` | §3.4：临时 agentDir + 临时 cwd；**实现层**由 A13a（agentDir 必填、为空即抛）与 A13b（源码里不许出现 `getAgentDir(`）守 —— 上一版用"跑完真实文件不变"来守，那条只在夹具写坏时才红（评审 S1） |
| R5 | 相对路径的包在**扩展升级后失效** | 源在扩展安装目录里（Windows 验收正是这个形态） | README 已知限制（Q8）+ 列表里可见（Q5）；**不自动修**（不替用户改路径） |
| R6 | 我们翻译错误信息时把"路径不存在"误判成"需要 npm" | 正则过宽 | A11 三态断言（`ENOENT`+npm / `Path does not exist` / 其它），并**只对非本地源**套 npm 分支 |
| R10（追加） | `secondarySidebar` 在老用户身上的迁移行为不明 | 升级 0.1.12 → 0.1.13（Q15 改后） | F46 未实测 ⇒ README 手动挪法（Q16）；M1 用全新 profile 验干净路径 |
| R11（追加） | 面板内输入的键盘/输入法/无障碍退化（S4 当年选原生控件的理由） | 自绘卡片 | 只做三种最小卡片；`aria-*` + Tab 序；handler 逻辑由 A33 无头断言，M1⑥/W1④ 真机只盯原生激活/真焦点/真输入法（F45 两层口径） |
| R12（追加） | API key 经 webview 的泄漏面变大 | 重放/日志/webview 状态带出 key | A29（重放与 Output 断言无标记子串）+ 卡片值不进 `webviewState`（§3.8） |
| R13（追加） | shell 写穿与包管理写并发 | 两命令同时跑 | F40：`withLock` 文件级锁 + 读改写在锁内；A25 的回读校验兜底 |
| R14（追加） | 对话卡片把 pi 的 `signal`/`timeout`/结算语义做丢（含：宿主已结算但卡片还在，晚到 answer 被误接；**晚到的加载结果复活已撤卡片**） | 面板版绕过 `withDialog` 竞争骨架 / 撤卡消息缺失（Astra B3）/ 加载结果不查 pending（R2-B1） | 骨架原样保留（§3.8）；**结算语义一张表**（answer→`answered`/cancel/signal→`cancelled`/timeout/replaced/load-failed → `dialog/close`；销毁不结算；**视图销毁 ≠ 会话终止的清理**）；晚到 answer 按 dialogId 丢弃；加载结果发送前查 pending；A27（协议形状）+ A32⑤（真 DialogHost 的撤卡与晚到无效）+ A35④ |
| R15（追加） | 🔴 **初始化期间对话框自锁**：session_start 处理器挂起在 `ctx.ui.select` 上 → 销毁视图 → 重开 → ready 先等 `ensure()`（仍 pending）→ 卡片永远重放不出来 → 死锁 | ①②把对话框接卡片后新开的窗口（S8 审批不在 ensure 期内，没这个风险；F43 只豁免了信任模态） | 就绪/重放/回答路由独立于 ensure（§3.8，Astra B1）；A32① 的专门断言（挂起期销毁→重开→作答→ensure 完成） |
| R16（追加） | 模型列表加载期间点击无响应（listModels 是"初始化/加载可能等待"：`ensure()` 后才读目录，可能数秒。末轮 S2 收回 stronger 说法：`allowModelNetwork:false` 只限**模型目录**联网，不概括整个链路） | 面板化后没有原生 Thenable 加载态（F42 第 2 条的平移没接住） | 立即 `dialog/open {loading:true}` + 同 id 重发（§3.8，Astra S8）；失败 `dialog/close {reason:"load-failed"}` + 焦点归还；**晚到的加载结果先查 pending**（R2-B1）；A35 受控 pending 四态验证 |

## 6. 检查清单（自动断言，先红后绿）

**能红验证是硬要求**：每条都要有一条"故意改坏实现"的破法（最后一列），逐条实跑并记进 §11。
（第 2 轮 S4 的教训：红法要写"改哪一行**生产代码**"，不能写成"删掉夹具里的一步"。）

| # | 断言（在哪） | 怎么让它红 |
| --- | --- | --- |
| A1 | **`isNpmSource()` 只在 `source.startsWith("npm:")` 时为真**；`npm:` 之外的一切（git URL、`./x`、`C:\x`、`/abs/x`）都为假 | 放宽成"含 `:` 就算 npm" → `C:\Users\…` 那条红。**不测源分类的完整顺序**（那要复刻 pi 的私有 `parseSource`，F2b/§3.1） |
| A2 | `install()` **只**写 `<agentDir>/settings.json`：装完之后 `cwd/.pi/settings.json` **不存在**（第 2 轮 N2：C7 只承诺"配置只写 user 作用域"，npm/git 的缓存/克隆目录由 pi 自己管，那条不在这条断言里） | 给 install 传 `{local:true}` → A2 红 |
| A3 | 写盘只动 `packages`：预置一份**带嵌套值与非标准缩进**的 settings.json，装完之后**解析出来的**其它字段**深相等**（不要求逐字节 —— F32/N2：pi 会 `JSON.stringify(…,null,2)` 重写整份） | 把实现改成"整份覆写" → A3 红 |
| A4 | `changed` 语义：第一次 `true`；同一个源再装一次 `false`（F10） | 恒返回 `true` → A4 红 |
| A5 | 命令层：输入框给 `"<tmp>/pkg"` → 信息消息里有源名、`settings.json` 路径、**"新建会话"** | 消息里去掉"新建会话" → A5 红 |
| A6 | **不热重载**（Q3）：① 信息消息含"新建会话（或重载窗口）后生效"；② **源码不变式**：`src/pi/packages.ts` 与命令层里不出现 `.reload(`（本仓有同类先例：`protocol-check.mjs:418` 读源码断样式） | 在命令里加一次 `session.reload()` → A6② 红（这是 Q3 那次裁决的守卫） |
| A7 | **生产路径生效**：`host.runtime.newSession()`（面板"新建会话"按的那条路）之后，新会话的工具表里有包里的工具、主题列表里有包里的主题（host-check 用真 pi + 临时包） | 把 `session.ts` 里那份 `SettingsManager` 从 `createRuntime` 闭包里提到外面（复用启动那份）→ A7 红 |
| A8 | `describePackage()`：`filtered` 加 `(filtered)`、`installedPath === undefined` 加"找不到（路径已失效）"、scope 显示 user/project、**project 行加"（项目作用域：本版本不管理）"** | 去掉"找不到"分支或去掉 project 标注 → A8 红 |
| A9 | `removePackage()`：`removeAndPersist()` 返回 `false` 时 → `removed=false` **且不当成功**；**真命令**接到 `false` 时不许弹成功文案（第 2 轮 S4：行内写清 UI 断言） | 恒返回 `removed=true` → A9 红；命令层把 false 也报成功 → A9 的第二条红 |
| A10 | 命名不变式：`list()` 每次读**文件里的真相** —— 两次调用之间手工改 `settings.json`，第二次必须看到新内容 | 在构造期缓存一份（"长命 manager"）→ A10 红 |
| A11 | `translateSourceError()` **四态**：① `npm:` + `spawn … ENOENT` → "需要 npm"；② **非 `npm:` 源 + `spawn … ENOENT` → 原样透出**（第 2 轮 S4：这才是能红的那条 —— 把第 1 轮的"放宽到所有源"改法驳回）；③ `Path does not exist: …` → 加前缀；④ 其它 → 原样 | 去掉 `ENOENT` 分支 → ①红；把 npm 分支放宽到所有源 → **②红**；把路径分支删掉 → ③红 |
| A12 | 失败**不留脏**：`install("npm:foo")` 在 npm 不可用时抛 → settings.json 与装之前**解析后相等**（F23） | 改成"先写 settings 再 install" → A12 红 |
| A13a | `agentDir` 为空/缺失时**抛错**（不许有 `?? pi.getAgentDir()` 这种兜底） | 加一个默认值 → A13a 红 |
| A13b | **源码不变式**：`src/pi/packages.ts` 里不出现 `getAgentDir(`；**写函数里不出现"读列表那份 manager"**（`projectTrusted: true`）；写路径上必须出现 `projectTrusted: false` | 各去掉/改一处分 → 对应那条红 |
| A14 | `Pi: Install Package` 在**没有会话**时也能成功（`packages.ts` 不依赖 `SessionHost`；命令层与会话的接触面是零） | 让 install 走一次 `host.session` → A14 红（桩里 host 为 undefined 时抛） |
| A15 | 自测 **T15**（gating，不用模型）：§3.4 的七步全过（⑤⑦ 走 `runtime.newSession()`） | 见 §3.4：把 `SettingsManager` 提到工厂外 → ⑤红；把 remove 那步删掉 → ⑥红 |
| A16 | `Pi: List Packages` 的 QuickPick 项数与 `list()` 一致（不是硬编码，也不是"只显示本地源"） | 过滤掉 `filtered` 的条目 → A16 红 |
| A17 | `Pi: Install Package from Folder…` 把 `uri.fsPath` **原样**交给 `installPackage`（不是 `uri.toString()` 的 `file:///…`） | 改成 `toString()` → A17 红（桩 `vscode-stub.mjs:150` 的注释就是那次事故）。**桩里要先补 `showOpenDialog`**（第 1 轮 S2：现在 0 命中，缺方法会以 `undefined is not a function` 收场 —— 那不算红） |
| **A18** | 🔴 **未信任的项目配置不许影响写路径**（第 2 轮 B1）：cwd 里放 `.pi/settings.json` = `{"npmCommand":["/nonexistent/evil"]}`，然后 `install("npm:whatever")` → 错误信息里**不许出现 `evil`**（说明用的是 user 配置的 npm） | 去掉写 manager 的 `{projectTrusted:false}` → A18 红（实测：错误会变成 `spawn /nonexistent/evil ENOENT`） |
| **A19** | **写后回读校验**（第 2 轮 B4）：把 `<agentDir>/settings.json` 预置成坏 JSON `{invalid-json` → `install(...)` 必须 **`ok:false`**（或 `changed` 校验失败）且**文件不被改写**，消息里带 `drainErrors()` 的原文 | 去掉回读校验（只看"没抛"）→ A19 红（会报成功，而文件根本没写） |
| **A20** | **并发不丢更新**（第 2 轮 S3）：两个 `installPackage` 用受控 barrier 同时发起 → 完成后**两个包都在**文件里 | 去掉模块级串行链 → A20 红（F33 实测只剩后一个） |
| **A21** | **清除记录的反馈不许撒谎**（第 2 轮 S6，含我第 1 轮那条错的建议）：① 父目录有 `true` + default=ask → 提示里**不许**说"改 ask 就能恢复询问"，且必须说清仍受上层记录影响；② 没有继承记录但 `defaultProjectTrust=never/always` → 不许保证"下次会重新问" | 反馈退回"已清除这里的记录（下次会重新问）"/保留"或把 defaultProjectTrust 设为 ask" → A21 红 |
| **A22** | **跨进程持久化**（第 2 轮 S5）：装完之后**起一个独立 node 子进程**（同一临时 agentDir、走生产 `packages.ts`）→ 它能列出那个包并建会话看到包里的工具；卸完之后再起一个 → 都没有了 | 让 `packages.ts` 把状态放在进程内存里 → A22 红（这一条顶掉用户"重启后确认"的人工动作） |
| A23（追加） | **manifest 不变量**（③）：容器贡献在 `secondarySidebar`、视图仍挂 `jerrypi` 容器、命令/激活贡献不变（并进 `check-vsix` 或新 `manifest-check`） | 把键改回 `activitybar` → A23 红 |
| A24（追加） | `shellCandidates()`（④）：候选**有序**且含 `LOCALAPPDATA\Programs\Git\bin\bash.exe` 与 scoop 两处；`where` 结果最优先；不存在的候选被滤掉（桩 `exists`） | 删 LOCALAPPDATA 分支 / 改顺序 → A24 红 |
| A25（追加） | **写穿、信任边界与失败不撒谎**（④，Astra S7 改形状，对齐 A19）：① 正常写：`setShellPathWrite` 返回 ok 后**夹具回读** settings.json 顶层 `shellPath` 相等；② **坏 JSON 夹具**：`<agentDir>/settings.json` 预置 `{invalid-json` → `setShellPathWrite` **不许报成功**（返回失败且带 `drainErrors()` 原文）、文件保持坏内容不被改写 —— **这条断言读的是生产的返回值**（删掉生产回读校验就红，而不是删夹具里的一步）；③ **清除分支**：`setShellPath(undefined)` 后回读该键消失且同样走失败校验；manager 必须带 `{projectTrusted:false}`（源码不变式） | 去掉生产回读校验 → ②红；去掉 `false` → 不变式那条红；清除分支不校验 → ③红 |
| A26（追加） | **已保存用户配置预检**（④，Astra R1-B2 扩 + R2-B2 定口径）：① 配置了 `shellPath`（≠ 自动探测结果）的夹具 → `resolveCurrentShell` 报告的是**配置值**（不是探测值）；② 配置的路径已失效 → 报 `Custom shell path not found: …` 原文；③ 无配置 → 报自动探测值；④ **项目覆盖组合**：全局 `/bin/sh` + 项目 `.pi/settings.json` 写 `shellPath:/nonexistent/…` → 信任与否**都报全局值**（预检的 manager 必须 `{projectTrusted:false}`，实测默认信任会把项目的失效路径报出来）；**T16**（advisory）输出行格式同此四态，找不到时指引含 `Pi: Set Shell Path` | 实现退回无参 `getShellConfig()` → ①红；吞掉抛错 → ②红；删指引 → T16 那条红；manager 改回默认信任 → ④红（报出 `/nonexistent/…`） |
| A27（追加） | **协议三态**（①②，protocol-check 加例）：`dialog/open`（含 `loading` 与二次同 id 更新）/ `dialog/answer(value \| cancelled)` / `dialog/close(reason)` 的消息形状与版本号 | 删 `dialog/close` 或 `loading` 字段 → 形状断言红（**生命周期行为由 A32⑤ 在 host-check 验**，Astra B3：纯协议检查证不了真宿主） |
| A28（追加） | **uiContext 不再弹原生**（①②）：`uiContext.select/input/confirm` 走卡片后，host-check 桩里 `showQuickPick`/`showInputBox`/**modal 型 `showWarningMessage`** 的调用计数 = 0 | 回退成原生调用 → A28 红 |
| A29（追加） | **key 不泄漏**（②）：模拟 password 卡 answer=`sk-TESTMARKER` → 构造重放消息集 + Output 行，断言都不含 `sk-TESTMARKER` | 把 value 塞进重放/日志 → A29 红 |
| A30（追加） | **销毁不取消**（①②）：`dialog/open` 挂起时 dispose 视图 → promise 仍 pending；重开（ready）后重放再次收到 `dialog/open` 且 password 卡不带旧值 | dispose 时 resolve(undefined) / 重放携带旧值 → A30 红 |
| A31（追加） | **分流不变式**（Q11）：命令面板路径（`fromPanel:false`）仍走原生（桩计数 ≥1）—— A28 的对偶 | 把 `fromPanel:false` 也接卡片 → A31 红 |
| A32（追加） | **对话框生命周期正向**（①②，host-check + 桩 webview，Astra B1/B4）：① **ensure 独立性**：夹具扩展的 session_start 处理器调 `ctx.ui.select` 且不 resolve → 销毁视图 → 重开 → **不等 ensure** 即收到 `dialog/open` 重放 → 回 answer → select resolve 且 `ensure()` 随后完成（死锁用超时探测；**夹具必须走真实初始化与真 `ctx.ui.select` 待答链**，不许用独立永久 pending 的 gate 代替；清理带超时 —— 红法不许是测试进程挂死，R2-N1）；② `uiContext.select/confirm/input` 正向：桩 webview 收到内容正确的 `dialog/open`（kind/items/current/placeholder）→ 回 answer → 调用方 resolve 到对应值（含 cancelled → fallback）；③ 模型芯片：`dialog/open` 带 `✓` 当前项 → answer → `setModel` 被调；④ password 正向：面板内 setApiKey → answer(`sk-TESTMARKER`) → 桩 SecretStorage.store 收到该值（输入框清空是 webview 行为，归 A34；泄漏面由 A29 守）；⑤ **撤卡与晚到无效**（oracle 写实，R2-S2）：timeout 竞争胜出 → `dialog/close` 发出 → **旧 dialogId 不在 pending 表**、晚到 answer **不产生副作用**（`setModel`/`SecretStorage.store` 未被调）且不再发 close/focus —— 不能只看"调用方不再 resolve"（Promise 天生忽略二次 resolve，那永远绿） | ①把重放挪回 `await ensure()` 之后（即 chatView 现状）→ 死锁超时红；②路由丢 kind / dialogId 对不上 → 红；③删 setModel 调用 → 红；④删保存调用 → 红；⑤删生产的晚答过滤（照单全收）→ **副作用那条红**（晚答被接住后 setModel/store 被调） |
| A33（追加） | **键盘 handler 逻辑**（①②，dom-check 扩容，Astra S6）：列表卡 ↑↓ 移动高亮、Enter 选中、Esc 取消；输入卡 Enter 提交 / Esc 取消；**IME 守卫**：`isComposing=true` 的 Enter 不提交（仓库已有同款先例：输入框的发送守卫） | 删对应 handler / 删 isComposing 守卫 → 对应条红（**原生激活/真焦点/真输入法不在此列**，F45 两层口径） |
| A34（追加） | **撤卡渲染与输入清理**（①②，dom-check）：收到 `dialog/close` 后卡片移除（或按 reason 渲染终态后移除，`answered` ≠ "已取消"），loading 态能渲染、同 id 二次 `dialog/open` 能更新内容；**password 作答后输入框的值被清除、卡片撤除**（真 DOM，宿主桩验不了这个 —— R2-S3） | webview 忽略 `dialog/close` / 不实现 loading / 作答后输入值残留 → 对应条红 |
| A35（追加） | **加载与退出路径**（①②，host-check，Astra S8 + R2-B1）：受控 pending 的 `listModels`（不 resolve）→ 卡片进入 loading（`dialog/open {loading:true}` 已发出）；resolve → 同 id 重发带 items；reject → `dialog/close {reason:"load-failed"}` + 焦点归还消息发出；④ **晚到结果丢弃**：先 Esc（结算、删 pending）→ 再 resolve/reject 那个受控 promise → **不再发任何 open/close/focus 消息**（否则孤儿卡复活） | 删 loading 分支 → 第一态红；失败不撤卡 → 第三态红；删"发送前查 pending"的有效性检查 → ④红（晚到 resolve 又发了 open） |

以上 A1–A14、A16–A22 进 `host-check`（**无需凭据**；A22 用 `spawnSync` 起子进程复用同一份 esbuild 产物），
A15 进 `Pi: Run Self-Test`（**gating**）。真命令部分沿用 S8 的做法：**真命令 + 桩 QuickPick/InputBox/OpenDialog**。
追加范围：A23 是 manifest 检查（不进 host-check）；A24–A26 进 `host-check`；A27 进 `protocol-check`（只验消息形状，
生命周期行为在 A32⑤）；A28–A32、A35 进 `host-check`（桩 webview 的收发计数与内容）；A33/A34 进 `webview-dom-check`。
**A32（含①的 ensure 独立性）、A33、A34、A35 与 §3.7 的用户配置预检、§3.8 的 `dialog/close` 已全部过完 Astra
的评审窗（两轮设计 + 末轮转写 OK）——可以开写**（实施时仍按先红后绿纪律逐条验证）。

## 7. 人工验收（Mac，**2 个动作**）

夹具由我准备好（`~/Desktop/s9-pkg-demo/`，含 `extensions/demo.ts` 注册工具 `demo_echo` + 一份主题；
**不放包内任何开发文件**），用户只做：

**M1（1 个动作，含一次真重启）**：`Pi: Install Package` → 输入框里选/粘 `~/Desktop/s9-pkg-demo`
（或走 Q2 的文件夹选择器）→ 核对：① 信息消息说的是这个源 + `settings.json` 的**完整路径** + **"新建会话后生效"**；
② **面板没坏**（还能发消息，**当轮不被打断**）；③ `Pi: List Packages` 里能看到它；
④ **重启 VS Code** → 让 agent "用 demo_echo 工具说 hi" → **卡片上出现这次工具调用**（C3 的可见证据）。
（列表内容、跨进程持久化、"包里的工具真的被加载"这三件已由 A22/T15 自动断言 —— 第 2 轮 S5：能自动化的不留给用户，
这里的 ④ 保留是因为它要**真宿主 + 真重启**。）

> **为什么不拿 `../pi-config` 当夹具**（评审 N2）：用户的真实 `~/.pi/agent/settings.json` **已经**有它
> （F27），装它只会走"已经在配置里了（未改动）"那条分支 —— 验不到"新装一个包"。pi-config 反而是
> Q4 那条分支的天然夹具（可选：顺手装一次看文案对不对，**不算验收项**）。
>
> M1 真正只有人工能验的是 **①（真输入框/真焦点）** 与 **④（真重启）**；③⑤ 标成旁证，
> 出问题时先看 `T15` 的输出（`AGENTS.md` §1：能自动化的不留给人）。

**M2（1 个动作，不需要重启）**：`Pi: Remove Package` → 选中它 → 核对：① 提示是"已移除"；
② `Pi: List Packages` 里没有它了；③ 让 agent 再说一次"用 demo_echo 工具" → 这一次**没有那个工具**
（新建会话之后才彻底消失这件事由 T15⑦ 自动断言）。
（第 1 轮那版要求"再重启一次确认 settings.json 里也没了"—— 删掉：文件内容的检查由 A19/A22 与列表本身覆盖，
第二次重启不增加信息量。）

> 为什么必须人工（`AGENTS.md` §1 的四类）：**①真焦点/真键盘** —— 输入框与 QuickPick 是原生 UI，
> 自动断言里是桩；**②真进程** —— "重启 VS Code 之后仍然生效"只有真重启能验。

**追加范围并进 M1/M2（不新增 Mac 动作，软预算仍是 2；F45 决定了键盘只能真机）**：

- M1 的重启之后**加看三眼**：⑤ 面板在**右侧**辅助边栏（全新 profile 装的；老 profile 按 Q16 只查 README 文案）；
  ⑥ `/smoke-ask`（夹具新命令，不用模型）依次触发 select/confirm/input 三张卡片 —— 键盘只剩**真机才能验的三层**：
  原生按钮激活（Enter 对 `<button>` 是否等价 click）、真焦点移动、真输入法（↑↓/Esc/IME 守卫的 handler 逻辑已由
  A33 无头断言，F45 两层口径）；⑦ 点模型芯片弹卡片（真列表、当前项 ✓），Esc 后焦点回到聊天输入框（F42 第 4 条的平移）。
- M2 里**加一眼**：`Pi: Set Shell Path` 在 Mac 上能跑 —— 显示"当前：`/bin/bash`"（未配置 global `shellPath` 时的自动探测值，末轮 S1 补前提）与"手动输入"两项即算过
  （列不出 Windows 候选是正常的）。

## 8. Windows 项（W0/W1 不新增人工动作；W2 是新增第 3 个动作，待 Q17 拍板）

并进 W0/W1 一起做（那台机器的 `test-fixtures/ext-smoke` 是随扩展发布的，正好当**本地包源**）：

- **W0**：`Pi: Run Self-Test` 期望变成 **18 项**（新增 T15 gating + **T16 advisory**；T12 仍 SKIP）⇒ `17 PASS / 0 FAIL / 1 SKIP`。
  （在原 17 项的基础上加 T16 一条 advisory；`REQUIRED_ITEMS` 仍 14 项。T16 在这台机上应报"找到：…\Git\bin\bash.exe"。）
- **W1**（两次交互，都在真宿主里）：① `Pi: Install Package` → 用**文件夹选择器**选
  `…\extensions\flyjancy.jerrypi-0.1.x\test-fixtures\ext-smoke`（长 Windows 路径正是为此加的入口）
  → `Pi: List Packages` 能看到 → **重启 VS Code** → 让 agent 调 `smoke_tool`（包里注册的工具）→ 出现卡片
  ⇒ "Windows 上重启后包真的被加载"；② 输入框里填 `npm:foo` → 应得到**"需要 npm"**的人话提示（C6，且
  **git 源不会**被这样翻译 —— 那一条由 A11 的②态在 Mac 上自动覆盖）。
  **追加范围加看三眼（还是这两个动作里）**：③ 面板在右侧；④ `/smoke-ask` 的卡片键盘（与 M1 ⑥ 同款，只剩
  原生激活/真焦点/真输入法三层，其余 A33 已无头覆盖）；⑤ `Pi: Set Shell Path` 显示当前解析到的 bash 路径。
- **W2（新增第 3 个动作，Q17 待拍板；超 Windows 软上限 2 的辩护写在 Q17）**：在用户 2026-09-17 实测那台
  per-user Git 机上：`Pi: Run Self-Test` 看 T16 报"找不到"及其指引 → `Pi: Set Shell Path` 选中探测到的
  `…\AppData\Local\Programs\Git\bin\bash.exe` → 重载窗口 → agent 跑 `echo ok` 出卡片 ⇒ **C9 端到端**
  （A24/A25 只能验候选与写穿，验不了真机探测链）。

## 9. 步骤（每步单独提交 + 门禁全绿）

| 步 | 内容 | 断言 |
| --- | --- | --- |
| 0 | **（已完成，2026-09-15）S8 的回顾补修**：codex 对已关闭的 S8 报了 4 条（`docs/S8-plan.md` §11.2 的 R1–R4），全部复现、修好、各带能红断言 ⇒ host-check 322 → **329**。这四条**随本阶段的发布（版本号见 Q15，现为 0.1.13）一起发**（不需要新的人工动作），S9 的步骤从 1 开始 | 见 S8-plan §11.2 |
| 1 | `src/pi/packages.ts`（纯函数 + 依赖注入）+ `translateSourceError` + `describePackage` | A1–A4、A8、A9、A11、A12 |
| 2 | **写路径的信任边界 + 串行化 + 写后回读校验**（§3.1 的三件事）：两个 `SettingsManager` 的工厂（写=false / 读=true）、`withPackageLock`、`verifyPersisted()`；**不动 `session.ts`**（Q3 决定不热重载） | A18、A19、A20、A13b |
| 3 | **四个 VS Code 命令**（Install / Install-from-Folder / List / Remove —— 第 2 轮 N1：别把"三项能力"记成三条命令）+ `package.json` 的 `contributes.commands` + i18n 标题 + 输入框/文件夹选择器（桩里补 `showOpenDialog`） | A5、A6、A8–A10、A16、A17 |
| 4 | 自测 T15（**走 `runtime.newSession()` 的生产路径**）+ A13a + **A22（跨进程）** | A13a、A15、A22 |
| 5 | 文档：README 中英（**四个**命令 + Q8 的已知限制 + §12.4 的"跨进程并发不保证"）、`pi-traps`（**`session.reload()` 才是原地生效点、且它不重裁决项目信任**、`SettingsManager.create` 默认**信任项目**（F31）、写盘失败不抛只进 `drainErrors()`（F32）、`addSourceToSettings` 的返回语义、npm 缺失的错误形态、**两个"忙"口径在压缩期间不等价**（F35））、`PLAN.md` §6 的"已知限制"逐字落地 | settings-check 的 16 项仍绿 |
| 6 | **（追加③）manifest 移 `secondarySidebar` + README 迁移说明 + manifest 断言**（独立可发：若后续步骤拖期，可先切一个只含包管理+③的版本） | A23 |
| 7 | **（追加④）** `src/pi/shell.ts`（含已保存用户配置预检的 `resolveCurrentShell`，Astra R1-B2/R2-B2）+ `Pi: Set Shell Path` + T16 + README 已知限制收敛 | A24/A25/A26 |
| 8 | **（追加①②宿主侧）** 协议三条消息（`dialog/open`、`dialog/answer`、`dialog/close`，含 `loading`）+ `DialogHost`（就绪/重放/回答路由独立于 ensure，Astra B1）+ `uiContext` 三件接卡片 + 重放/销毁/结算语义（R14 那张表）+ 分流（Q11） | A27/A28/A30/A32①②⑤ |
| 9 | **（追加①②面板侧）** webview 三卡片 + password 卡 + loading 态与撤卡渲染 + `modelPicker`/`sessionPicker`/`setApiKey` 的面板入口 + 键盘 handler（↑↓/Enter/Esc/IME）+ 夹具 `/smoke-ask` | A29/A31/A32③④/A33–A35 + render/dom 检查扩容 |
| 10 | 文档收尾：README 中英（面板位置、shell 指引、面板内交互）、`pi-traps`、`settings-check` 扩容 | settings-check |
| 11 | 版本 **0.1.13**（Q15，预发布通道；0.2.0 留给 S10 的首个正式版）+ 打包 + Mac M1/M2 → 上传/核验 → Windows W0/W1（+W2 若 Q17 通过）→ §12 回填 → 关阶段 | — |

## 10. 评审记录

**评审者**：Claude（同一工作目录的面板会话 `w60:pC`）。
**纪律**（承 S4–S8）：**≤3 轮**；第 3 轮只核转写、不审设计；每轮结论**立刻落盘**；
每条记 `ACCEPT` / `REJECT`（附实质理由）/ `DEFER`。评审者只读。原文：`/tmp/s9-review-r1.md`（未入库）。

### 第 1 轮（2026-09-15，Claude，本仓 `w60:pC` 面板；结论 `VERDICT: BLOCKING`，3 B / 6 S / 5 N）

**处置：14 条全部 ACCEPT**（其中 B1 我先自己复现、再改探针；S1/S2/S3/S5 的红法都换成"在本设计下真的能红"）。

评审者复跑了两个探针，并**另外做了 6 次干净进程的定向实验**。它的总评：§0.1–§0.3、§0.5、§0.6 的事实
**一条都没错**，问题集中在 **§0.4 的证据链**（探针自己串味）、**T15 的步骤顺序**（gating 项恒假）、
以及**"忙"的口径**（本仓已经为这个盲窗付过一次学费）。

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | `s9-reload-probe.mjs` 的 7 个场景共用一个进程与 `agentDir`，从第 2 个场景起"全新会话"建好时**已经**带着上一轮的包 ⇒ S2（F15 的**唯一**证据）证明的不是 `session.reload()`；而且它打印的 S4/S5 会让人以为"loader 就够了"，与 F16 相反 | ACCEPT（已复核） | **我自己重写完探针再复跑**：每个场景一个 `mkdtemp` 世界 + **装包前的前置断言**（不干净就 `exit 1`）+ 父进程 `spawnSync` 逐场景起**干净子进程**。新输出：`loader-only: []`、`settings-only: []`（但 `getPackages()` 已更新）、`settings+loader: []`、`session-reload: ["pkg-two"]` ⇒ **F15 对，F16 更强**（两步一起也不够）。新增 **F29** 把这条探针纪律写进计划，F16 的"探针第一版"那句**不存在的引用**已删 |
| **B2** | §3.4 的 T15 第④步"建会话 → 装之前没有 `probe_echo`"排在 install **之后** ⇒ 恒假；而 T15 是 **gating**，会把 `check:gate` 卡死（⑤也会恒绿） | ACCEPT | T15 改成 **①先建会话做基线 → ②再 install**（探针 `rich` 场景就是正确顺序的样板），并写明"装完之后任何新建会话都已经带着包"（F29 的机制） |
| **B3** | §3.3/A6 用 `session.isStreaming` 判忙，而它**看不到**"已发送、`agent_start` 还没到"那个窗口 —— 本仓在 D7 就为此专门写了 `controller.isBusy()`（`pendingSend`） | ACCEPT（**第 2 轮 B2 之后已不再适用**） | 第 1 轮改成用 controller 的 busy；**第 2 轮 B2 直接取消了"热重载"这件事**，连忙判断一起取消（详见 §10.2 的 B2/B3）。F35 留档：两个忙口径在压缩期间确实不等价 |
| S1 | A13 是**夹具断言**（只在夹具写坏时红），且它的红法要求**真的往用户 `settings.json` 写一次** | ACCEPT | 换成 **A13a**（`agentDir` 为空必须抛）+ **A13b**（源码不变式：`packages.ts` 里不出现 `getAgentDir(`），§1 的 C7 映射同步改 |
| S2 | 桩里**没有** `showOpenDialog` ⇒ Q2 的文件夹入口一条断言都没有，而 Windows W1 正靠它 | ACCEPT | 桩补 `showOpenDialog`（返回预置 Uri，复用已有的 `fsPath` 与共享状态）+ 新增 **A17**（必须交 `uri.fsPath`，不许 `toString()`） |
| S3 | A1 要复刻 pi 的**私有** `parseSource`，顺序还写反了（真顺序是 `npm:` → local → git → 兜底 local），而 §2 的"不做"清单明说不许复刻 pi 的规则；三个 helper 也没导出 | ACCEPT | A1 收窄成 **`isNpmSource(source) = source.startsWith("npm:")`**（保守的否定条件：判错的代价是"退回 pi 原文"，安全方向），并写明**为什么不复刻**（新增 **F30** 记"三项都没导出"）；红法改成"放宽成含 `:` 就算 npm"⇒ `C:\…` 红 |
| S4 | §3.3 拿 A6 当"reload 之后订阅还活着"的证据，而 A6 只数调用次数、不碰事件（跨节矛盾） | ACCEPT | 担保落到 **A7 的第二步**（reload 之后再触发一次事件，断言订阅仍收到）；§3.3 改成引用 A7 |
| S5 | A10 的红法在本设计下**造不出来**（`PackageDeps` 拿不到会话，要造红得先改设计） | ACCEPT | A10 换成"构造期缓存一份"这种**真实可能的退化**：两次 `list()` 之间手工改 `settings.json`，第二次必须看到 —— 红法 = 构造期缓存。§3.1 顺带改成**一次性函数**（`listPackages(deps)`），让这个形状天然成立 |
| S6 | §3.2 说"协议不用改"容易被读成"什么都不用改"：命令够不着会话宿主（`PickerCommands` 现在没有 busy/reload 出口） | ACCEPT（**第 2 轮 B2 之后已不再适用**） | 第 1 轮点名了接缝；**第 2 轮 B2 取消热重载后这条接缝不需要了** —— 命令层与会话的接触面变成**零**（A14 就是这条不变式）。第 2 轮 N1 另指出 §3.2 的措辞仍要写清"四个命令" |
| N1 | §8 的 W0 数字核过是对的（当前 16 项 ⇒ 加 T15 后 17 项 / `16 PASS / 0 FAIL / 1 SKIP`） | ACCEPT | 把"核过"的依据写进 §8（`REQUIRED_ITEMS` 13 项含 T14 + 3 条 advisory） |
| N2 | F27 属实；建议 §7 里把"为什么不用 pi-config"挑明，免得实施时图省事换回去 | ACCEPT | §7 加一段：pi-config 只在用户配置里**已经**存在（幂等分支），真验"新装"要用新夹具；顺带把它标成 Q4 分支的可选夹具 |
| N3 | M1 的 ③"列表里能看到"与 ⑤"工具出卡片"已被 T15 覆盖，可标旁证 | ACCEPT | §7 的这两条标注"旁证：T15④/T15①⑤ 已自动断言"，并写明 M1 真正只有人工能验的是①（真输入框）与④（真重启） |
| N4 | §3.1 的 `InstallOutcome` 写成了非法 TS（`interface` 不能那样写联合类型） | ACCEPT | 改成 `export type InstallOutcome = {…} \| {…}`；`RemoveOutcome` 同 |
| N5 | F23 的措辞要更准：探针是"把 `npmCommand` 指到不存在的地方"，真实受限机上可能是 `spawn npm ENOENT` | ACCEPT（未实测部分照实说） | F23 补一句"**未实测**：真实受限机上原文可能是 `spawn npm ENOENT`；两者都含 `ENOENT` ⇒ §3.1 的正则仍命中" |

### 第 2 轮（2026-09-16，codex，本仓 `w60:pD` 面板；结论 `VERDICT: BLOCKING`，**5 B / 6 S / 2 N**）

**处置：13 条全部 ACCEPT**（其中 **B2 的采纳让计划变简单**：不做自动 reload ⇒ B3/S6 大半随之消失）。

评审者复跑了两个探针与 host-check（**329/329 通过**，说明当时的断言覆盖不到这些组合），并做了 6 组定向实验
（独立临时 agentDir/cwd、不发模型请求、不动用户配置）。它的结论：第 1 轮的 B1/B2 改法**确实修好了原问题**
（探针场景隔离有效、T15 顺序正确），但"命令操作 / pi 信任 / 持久化错误 / 会话重载"这几个**交界处**还有洞。

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | 🔴 `SettingsManager.create` **默认 `projectTrusted: true`** ⇒ 未信任项目的 `.pi/settings.json` 能通过 `npmCommand` 决定我们 **spawn 什么程序**；`{local:false}` 只决定写入作用域，不隔离设置读取 | ACCEPT（已复核） | 核了默认值（`settings-manager.js:169-179`，与 S1-D11 记过的是同一条）+ `getNpmCommand` → `runNpmCommand`。改成**两份 manager**：写 = `{projectTrusted:false}`，读（只列） = `true` 且**永不**传给写函数。断言 **A18**（恶意 `npmCommand` 不许被 spawn）+ **A13b**（源码不变式）+ **F31** 入库 |
| **B2** | 🔴 **自动 `session.reload()` 会把"空目录后来长出资源"的信任缺口重新打开**（实测 `asked:0` 但 `commands:["unapproved-project"]`）—— S8 R1 修的是**新建会话**那条路，reload 不重裁决 | ACCEPT | **推翻第 1 轮的 Q3：不做自动 reload**（Q3 改为"不自动"），统一走"新建会话"（F36：那条路既重读 settings 又重跑信任钩子）。§3.3 整节重写；F34 入库；A6 的源码不变式（不许出现 `.reload(`）+ A7 改走 `runtime.newSession()` |
| **B3** | 第 1 轮 B3 的修法仍把两个忙口径混为一谈：`snapshot().busy = pendingSend \|\| isStreaming`，而 `controller.isBusy() = pendingSend \|\| !isIdle`（含 `isCompacting`）⇒ **压缩期间**前者 false、后者 true | ACCEPT | 核了源码（`agent-session.js:616-622`）。**随 B2 一起不再需要**：不 reload 就没有"忙时不许 reload"这条判断，第 1 轮要加的 `isBusy()/reloadSession()` 接缝**取消**。事实留档 **F35**（`pi-traps` 里也记一条：判忙别自造口径） |
| **B4** | **"API 正常返回"≠ 已保存**：settings.json 是坏 JSON 时 `installAndPersist()` 照样返回、内存里也有，但**文件没写**（错误只在 `drainErrors()` 里）；reload 资源的加载错误同理 | ACCEPT | §3.1 加 **写后回读校验**（用**新** manager 读回来确认）；失败 ⇒ `ok:false` + Output 里放 `drainErrors()` 原文；**不谎称回滚**。断言 **A19**；F32 入库 |
| **B5** | **移除候选含 project 条目，而删除永远走 user 作用域** ⇒ 同名时删错对象（`removed:true` 但删的是 user 那行）或永远"未匹配" | ACCEPT | **移除候选只列 user**；project 行照常展示但标注"（项目作用域：本版本不管理）"且不可选。断言 **A8** 扩展 + §3.2 写清为什么 |
| S1 | 新 reload 探针**只打印、没有后置断言**；主题夹具依赖仓库外的 `../pi-config`，缺失时退化成"必然无效"的主题 ⇒ `PROBE OK` 可能是假绿 | ACCEPT | 每个场景加**精确后置断言**（不满足就非零退出）；主题夹具改用 **`pi-runtime/dist/modes/interactive/theme/dark.json`**（仓库内、发布时必在、格式一定合法），缺文件**显式失败**；`finally` 里 dispose 会话 + 带根守卫清理 |
| S2 | 第 1 轮把 `isNpmSource` 收窄之后，**C6/Q7/R6 还承诺"要 npm 的 git 源也给'需要 npm'"** ⇒ 跨节矛盾（F37：git 缺 git 也会 ENOENT，硬翻译会撒谎） | ACCEPT | C6/Q7 同步收窄为"**`npm:` 源**明确提示；git 源保留原文"（上游 Windows 验收本来只要求 `npm:xxx`）；A11 增加"非 npm 源 + ENOENT → 原样"这一态 |
| S3 | **每次新建 manager 不防并发**：两个安装各算好数组再写 ⇒ 静默丢一个包（实测只剩后一个），而 F4 的说法会让人以为已经解决 | ACCEPT | §3.1 加**模块级串行链**（`withPackageLock`）；F4 更正（字段锁只防"不同字段"）；断言 **A20**；跨进程边界写进 §12.4/README（**不**假装覆盖） |
| S4 | A11 的第二种红法**不会红**（放宽 npm 分支时 `Path does not exist` 仍走路径分支）；A15 的红法会退化成"改夹具步骤"，证明不了生产接线 | ACCEPT | A11 改成**四态**并把能红的那态写成"非 npm 源 + ENOENT"；A15/A7 明确走 `runtime.newSession()` 生产路径，红法改成"把 `SettingsManager` 提到 `createRuntime` 外面"（一次真实可能的重构） |
| S5 | "标旁证"没有真的减少人工：M1 仍要手工做列表/资源检查、M2 又要重启一次 | ACCEPT | 跨进程持久化改成**自动**（**A22**：`spawnSync` 起独立 node 子进程走生产 `packages.ts`）；M1 保留"真宿主安装 + 一次真重启"（真进程 + 真焦点），M2 **去掉第二次重启**（文件与列表由断言覆盖） |
| S6 | 我给 R3 写的新提示里"或把 `defaultProjectTrust` 设为 ask"**是错的**（resolver 顺序是记录在前、默认在后 ⇒ 父目录有记录时改成 ask 也没用）；且"没有继承记录 + default=never/always"时也不该承诺"下次会重新问" | ACCEPT | 反馈改成按**真实裁决顺序**说：有继承记录 ⇒ 说明是哪个上层目录 + 该在那个目录上处理；无继承记录但默认不是 `ask` ⇒ 说明仍按默认策略；只有"能真的重新问"才说"下次会重新问"。断言 **A21**（三态）。R1/R2/R4 的修复本轮未复发（评审确认） |
| N1 | 第 1 轮新增项的**转写**没过一遍：F30→F2b 的引用、§9 第 3 步漏 A17、"三条命令"实为**四个** VS Code 命令、`agent-session.d.ts:252` 那条注释讲的是 `_installAgentToolHooks` 而不是宿主的 `subscribe()`、`SessionHost.reloadSession()` 示例里的裸 `session` 不存在 | ACCEPT | 逐条改：引用统一 F2b；§9 第 3 步补 A17 与"四个命令"；§3.3 里那条 d.ts 引用**删掉**（那条订阅结论现在由 A7 的真实事件路径支撑，不再引用注释）；`reloadSession` 这一节整个消失（B2 的后果） |
| N2 | A3 的"逐字节不变"与 C7 的"只动 settings.json"**强于实际行为**（pi 会 `JSON.stringify(…,null,2)` 重写整份；npm/git 还会写缓存与克隆目录） | ACCEPT | A3 改成"**解析后**无关字段深相等"（夹具带嵌套值与非标准缩进）；C7 改成"**配置**只写 user 作用域、不碰工作区；npm/git 的包存储由 pi 在自己目录里管" |

> 第 2 轮的净效果：**计划变小**（少了"热重载 + 忙判断"那一整块），但**边界更硬**（信任/作用域/落盘/并发各有一条断言）。
> 第 3 轮按纪律只核转写。

### 2026-09-17 用户拍板（对话裁决，非评审轮）：追加范围 ①–④ 全部并入 S9

四项（①②面板内交互 / ③右侧布局 / ④shell 入口）原拟独立成阶段（我建议过 ③④ 先行、①② 单独走），
用户拍板**全部并入 S9**，并以额外评审补偿预算：**追加范围送 Astra 新开评审窗**（≤2 轮设计 + 末轮只核转写，
与已完成的第 1/2 轮——Claude/codex，包管理主线——互不冲抵；这是用户对"≤3 轮"预算的显式扩展，只对追加范围生效）。
评审时 Astra 只读，重点应打：①② 的挂起态生命周期（销毁/重开/超时与 S8 Q10 的一致性）、password 卡的泄漏面（A29 够不够）、
④ 的信任边界（对齐 B1）、③ 的老用户迁移口径（F46 未实测）。

### 第 3 轮（2026-09-17，Astra ＝ codex/gpt-6-astra medium，本仓 `w60:pD` 面板；结论 `VERDICT: BLOCKING`，**5 B / 3 S / 2 N**）

即用户拍板后开的**追加范围评审窗第 1 轮**（编号上排第 3 轮，预算上算 Astra 的第 1 轮，当时还剩 1 轮设计 + 末轮转写）。
只审 `41ff02d`→`620bba6` 的新增范围（§0.8/§1 C8–C11/§3.6–§3.8/Q11–Q17/R10–R14/A23–A31；基线提交号第 1 次笔误写成
了不存在的 `61ff02d`，R2-N2 抓到后改正）。它实测了
`getShellConfig` 三态、curl 了 GitHub 1.103/1.104 的 `viewsExtensionPoint.ts`、读了本仓的
`chatView.ts`/`uiContext.ts`/`agent-session.js`/`webview-dom-check.mjs`，未动仓库。

**处置：8 条实质意见（5B+3S）全部 ACCEPT；2 条 NOTE 照录并各有一点落地。**

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | 🔴 初始化期对话框自锁没修干净：`chatView.ts:241` ready 处理先 `await controller.ensure()` 再 `replay()`，而 `ensure()` 含 `bindExtensions()`（等 session_start 处理器，处理器可调 `ctx.ui.select/…`）⇒ 初始化期间弹对话框→销毁→重开 = "ensure 等回答、回答重放等 ensure"死循环；A30 只在初始化完成后测，抓不到 | ACCEPT（已复核） | 核了 `chatView.ts:241` 与 bundle 的 `bindCurrentSessionExtensions → session.bindExtensions({uiContext,…})`。**§3.8 重写**：就绪/重放/回答路由独立于 ensure（`ready` 里先 `dialogHost.replay()` 再 `await ensure()`；DialogHost 自持 post 通道）；F43 从"信任模态特例"改写成一般原则；新风险 **R15**；新断言 **A32①**（挂起期销毁→重开→作答→ensure 完成，死锁用超时探测，红法 = 挪回 ensure 之后即现状） |
| **B2** | `getShellConfig()` 无参不读 settings.json（实测三态：无参→探测、传参→生效、失效→抛 `Custom shell path not found`）⇒ §3.7 预检验的是探测瀑布不是用户配置；用户刚存的 shellPath 在 QuickPick/T16 里看不到 | ACCEPT（已复核） | 自跑同款实验复现（含签名 `getShellConfig(customShellPath)`）；配到读面 `SettingsManager.getShellPath()`（`settings-manager.d.ts:253`）。**§3.7 改**：`resolveCurrentShell({cwd,agentDir})` 先读 `getShellPath()` 有值传参、无值才无参；F41 补签名与三态实测；A26 扩成三态（配置值/失效原文/探测值）；C9 措辞同步 |
| **B3** | 协议只有 open/answer：宿主超时/abort 后 webview 卡片怎么撤**未定义**（Promise.race 只结束宿主等待，撤不了前端卡片）；A27 在纯协议检查里验不了真 DialogHost 的竞争分支 | ACCEPT | **§3.8 补**：协议加 `dialog/close {dialogId, reason}`（timeout/cancelled/replaced/load-failed）+ **结算语义一张表**（answer/cancel/signal/timeout/replaced/load-failed → 撤卡；销毁不结算，Q10 保留）+ 晚到 answer 按 dialogId 丢弃（防"结算改写"事故的镜像）；A27 收窄为消息形状检查，生命周期行为移 **A32⑤**（真 DialogHost + 桩 webview） |
| **B4** | A28/A29/A31 全是负向计数：三个方法改成直接返回取消也绿；A29 只查重放/Output 无标记，没证 key 真到 SecretStorage；C10/C11 的正向链路零覆盖 | ACCEPT | 新 **A32②③④**（正向）：select/confirm/input 的 open 内容 + answer 路由回 resolve 值；模型芯片→✓→answer→setModel；password→answer→桩 SecretStorage.store 收到值+卡片清空（A29 保留为泄漏面负向）。红法都落在"删生产调用/丢路由" |
| **B5** | Q15 的 0.2.0 与总计划冲突：PLAN §5.4 定 0.2.0 为**首个正式版**（CHANGELOG 起点），S10 才是"预发布验证 G1–G6 → 正式发布"；S9 直接 0.2.0 且步骤 11 上传后才做 Windows 验收 = 正式版跳过预发布门槛；"功能批变大"不构成理由 | ACCEPT（已复核） | 核了 PLAN 208/210 行（0.1.x 预发布 / 0.2.0 起正式+CHANGELOG）与 250 行（S10 的发布顺序）。**Q15 默认值改为 0.1.13**；原备选栏"0.1.13 要破例 CHANGELOG 约定"是写反了的（预发布期间 CHANGELOG 本就推迟，自洽）—— 这正是"判据主语被换掉"的同款错误，照实改写；步骤 0/11 同步；§13 提醒用户 Q15 已改 |
| S6 | F45 把"原生激活测不了"扩大成"所有键盘逻辑测不了"：仓库 `webview-dom-check.mjs` 已在派发 KeyboardEvent 验 Enter/isComposing，自写 handler（↑↓/Esc/IME 守卫）完全可无头测；否则把可自动化的推给人工 | ACCEPT（已复核） | 核了 dom-check 的 KeyboardEvent 先例（Enter 发送、`isComposing` 不发送）。**F45 改成两层口径**（测不了：原生激活/真焦点/真输入法；测得了：handler 逻辑）；新 **A33**（键盘 handler 无头断言）+ **A34**（撤卡/loading 渲染）；§2 不做清单、M1⑥/W1④ 同步收窄（真机只剩三层） |
| S7 | A25 的"写完后测试自己回读"证明的是写入成功，删生产回读校验不红；清除分支没覆盖 | ACCEPT | **A25 改三态**（正常写穿夹具回读 / 坏 JSON 下生产必须报失败且不改文件 —— 断言读生产的返回值 / 清除分支同样走失败校验），形状对齐 A19；红法改为"删生产校验→②红" |
| S8 | "先等 listModels 再开卡"≠ 保留加载态：等待期用户看到的是点击无响应；"不弹空列表"只保住一半语义 | ACCEPT | **§3.8 modelPicker 改**：点芯片立即 `dialog/open {loading:true}`，listModels 完成后**同 id** 重发带 items，失败 `dialog/close {reason:"load-failed"}`；焦点归还扩到**三条**退出路径（选中/Esc/失败）；F42 第 4 条同步；新风险 R16 + 新断言 **A35**（受控 pending 三态） |
| NOTE-1 | F38 抽查通过（1.103 无 secondarySidebar、1.104 有 schema 键 + AuxiliaryBar 注册分支）；F39 探测顺序与 F41 导出核实一致 | 照录（正面确认） | §0.8 标题更新：F38–F42 已过 Astra 复核；`engines ^1.123.0` 的下限结论不动 |
| NOTE-2 | Q17 辩护形式合格但应先移走可自动化的键盘检查；Q13 的理由要收窄：无 bash 时 T5a/T5b 仍会挡 GATE，不能说"整个 GATE 不被 bash 缺失挡住" | 照录 + 落地 | 键盘自动部分已移（S6 → A33）；**Q13/§3.7 收窄**：T16 自身 advisory，但 `REQUIRED_ITEMS` 含 T5a/T5b（`selftest.ts:78/439-440`，testBashBasic/testBashAbort）⇒ 无 bash 的机器 GATE 本来就过不了 —— 反而强化 W2 的必要性 |

> **本轮净效果**：计划新增了 4 条断言（A32–A35）与 1 条协议消息（`dialog/close`），但消掉了 1 个死锁窗口（R15）、
> 1 个版本语义冲突（Q15 退回预发布）、1 个预检假阴性（B2）与 1 个假绿面（A25②/A27 的断言主语错位）。
> 本轮修订已送 Astra 第 2 轮（见 §10.4）。

### 第 4 轮（2026-09-17，Astra 第 2 轮 ＝ codex/gpt-6-astra medium，本仓 `w60:pD` 面板；结论 `VERDICT: BLOCKING`，**2 B / 3 S / 2 N**）

预算上算 Astra 的第 2 轮（也是**最后一轮设计评审**，末轮只剩转写）。只审 `620bba6`→`a5b41de` 的修订，
重点按上一轮（§10.3 末尾）提出的三个问题。它用 SDK 探针复现了项目覆盖的读值差异、读了 `session.ts`/`controller.ts`/
`settings-manager.js`，未动仓库。

**三个重点的结论（它的原话口径）**：① A32① 死锁探测**能红**（设计链路成立；尚未实现，不能当作已实跑）；
② 结算表与 S8 Q10：**销毁边界自洽，但整体不自洽**（正常回答缺 close reason、加载完成可能复活已撤卡片）；
③ Q15 版本引用**对齐**（剩余 0.2.0 都是 S10/备选/历史说明）。

**处置：5 条实质意见（2B+3S）全部 ACCEPT；2 条 NOTE 照录并全部落地。**

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | 加载完成可能**重新打开已取消的卡片**：结算规则只拦晚到 answer，没拦晚到的**加载结果** —— loading → 用户 Esc（close、删 pending）→ 列表完成 → 再发 open ⇒ 孤儿卡，用户选了也不生效；晚到的 reject 还可能重复撤卡、抢回焦点；A35 的三个独立场景抓不到这个交叉 | ACCEPT | **§3.8 modelPicker 补晚到过滤**：发送加载结果（成功或失败）之前必须先查该 dialogId 仍在 pending，已结算则**丢弃结果**（不发 open、不发 close、不抢焦点）；R14/R16 同步；**A35 加第四态**（先 Esc 再 resolve/reject → 断言不再发任何 open/close/focus；红法 = 删"发送前查 pending"的有效性检查） |
| **B2** | 新建只读 manager ≠ 读取实际生效配置：SDK 默认 `projectTrusted:true` 会把**项目级** shellPath 报出来，而实际会话从 `false` 起步再走信任裁决（`session.ts:88`）⇒ 用户拒绝项目配置后预检仍可能报一个实际不会用的失效路径；项目已信任且有覆盖时"写入 global 后立即看到新值"也不成立 | ACCEPT（已复核） | **自跑 SDK 探针复现**：全局 `/bin/sh` + 项目 `/nonexistent/project-shell` 时，`projectTrusted:true` 读到项目失效路径、`false` 读到全局值。**口径定为"已保存的用户配置（global）预检"**：manager 必须 `{projectTrusted:false}`（与写路径同源，F40：`setShellPath` 写 global）；corner case（项目已信任且项目有覆盖）明说"预检报 global 值，不假装覆盖项目场景"；C9 措辞同步；**A26 加第四态**（项目覆盖组合，信任与否都报全局值；红法 = manager 改回默认信任） |
| S1 | 结算事件与 reason 不闭合：正常 answer 也要撤卡，但 reason 枚举没有"已答"，成功作答会被迫标 `cancelled`（而 webview 会渲染"已取消"）；signal 如何映射未写；view.dispose 与宿主/会话终止的清理要区分 | ACCEPT | **reason 补 `answered`**（正常作答撤卡，可渲染"已选择"终态）；**结算表补映射**：signal → `cancelled`；宿主/控制器的 dispose（S8 三条取消路径之一，**不是**视图销毁）→ `cancelled`；会话切换 → `replaced`；并把"视图销毁 = 只断开 post 通道"与"会话终止 = 清理 pending"写为两回事；R14 同步 |
| S2 | A32⑤ 的 oracle 不实："调用方不再 resolve"拿 Promise 天生忽略二次 resolve 当证据，永远绿；"状态不变"没指定观察对象 | ACCEPT | **A32⑤ oracle 写实**：旧 dialogId 不在 pending 表；晚到 answer **不产生副作用**（`setModel`/`SecretStorage.store` 未被调）且不再发 close/focus；红法改为"删生产的晚答过滤 → 副作用那条红"（不再依赖 Promise 二次结算语义） |
| S3 | "卡片清空"放错测试台：A32④ 的宿主桩验不了真密码框是否清空；收到 close 消息与 DOM 实际撤卡是两件事 | ACCEPT | **A32④ 去掉"卡片清空"**（只留保存链）；**A34 加"password 作答后输入值清除、节点撤除"**（真 DOM）与"按 reason 渲染终态（`answered` ≠ 已取消）"；两个测试台各有独立的红法 |
| N1 | A32① 方向通过，附实施注意：夹具必须走**真实初始化与真 `ctx.ui.select` 待答链**（不许用独立永久 pending 的 gate 代替）；清理要带超时（红法不许是测试进程挂死） | 照录 + 落地 | **A32① 行文补进这两条纪律**（标 R2-N1） |
| N2 | 版本对齐通过；另抓两处文字错：§10.3 基线写成了**不存在的 `61ff02d`**（应为 `41ff02d`）；R16 的"listModels 要网络"不准确（`controller.ts:672` 是 `ensure()` 后读 `getAvailable()`，且 `allowModelNetwork:false`） | 照录 + 落地 | 基线改正并**把这次笔误本身记进 §10.3**（防再犯）；R16 改为"初始化/加载可能等待"（末轮 S2 又把我转写时追加的"不走网络"收了回去 —— `allowModelNetwork:false` 只限模型目录联网，不能概括整个 `ensure()` 链；loading 的合理性不变） |

> **本轮净效果**：没有新增断言编号，但把三个"能绿但不证明判据"的口子焊死（晚到加载过滤、A32⑤ 的副作用 oracle、
> 预检的信任口径），并补齐了 `answered` 这个唯一缺失的结算 reason。
> 本轮之后新写的改动已由末轮转写核对（§10.5，`VERDICT: OK`）。

### 第 5 轮（2026-09-17，Astra 末轮 ＝ codex/gpt-6-astra medium，本仓 `w60:pD` 面板；**`VERDICT: OK`，0 B / 2 S / 2 N**）

预算上的末轮：**只核转写，不审设计**。只对 `a5b41de`→`580a670`，核 §10.4 的 7 条处置与正文对应、编号/枚举一致性、
跨节矛盾与格式。

**结论**：7 条处置均能找到正文对应改动；编号与枚举（reason 五值、A26 四态、A32①–⑤、A34 四项、A35 四态、
R14–R16）无错位；F40–F45、Q12–Q17 与本次改动无新增冲突；§10.3 保留旧枚举/旧三态属历史记录，不算冲突。

**处置：2 S + 2 N 全部 ACCEPT（均为转写修正，直接落盘）**：

| # | 意见 | 处置 |
| --- | --- | --- |
| S1 | global 预检口径同步不完整：F41 仍写"先读生效配置"、步骤 7 仍写"按生效配置"、命令文案与 W1⑤ 的"当前"没体现 global 限定、M2 固定期待 `/bin/bash` 没写前提 | ACCEPT：F41/步骤 7 统一为"已保存用户配置（global）预检"；命令文案处注明"当前 = 已保存用户配置的解析结果"；M2/W1⑤ 补前提 |
| S2 | **转写加强**：R16 与 §10.4-N2 写成"不走网络"，但上轮意见只是"初始化/加载可能等待"；`allowModelNetwork:false` 只限模型目录联网，不能概括整个 `ensure()` 链 | ACCEPT：R16 改回"初始化/加载可能等待"并明说 `allowModelNetwork` 的限定范围；§10.4-N2 处置列同步（教训记入：**转写不许把意见加强成事实**） |
| N1 | §13/STATUS 的"Q15 改过两次"不准（第 1 轮改、第 2 轮只是确认对齐）；STATUS 一处错字"约了"→"有了" | ACCEPT：改为"改过，并经第 2 轮确认"；错字已改 |
| N2 | 处置对应关系通过；格式小收尾：§10.4"按 §10.3 末尾留的三个问题"指代过时、R14 行尾空格、步骤 8 反引号内 `open\|answer\|close` 的竖线会拆表格（基线遗留，非本次新增） | ACCEPT：指代改为"上一轮（§10.3 末尾）提出的三个问题"；空格清除；步骤 8 改为三条消息的顿号列举 |

> **评审窗关闭**：主线两轮（Claude/codex）+ 追加范围 Astra 两轮设计 + 末轮转写，全部落盘。计划待用户拍板 Q1–Q17。

## 11. 实施期发现

### 11.1 步骤 1（2026-09-17）：`src/pi/packages.ts` + A1–A4/A8/A9/A11/A12/A13a

- **落盘**：`src/pi/packages.ts`（`isNpmSource` / `translateSourceError` / `describePackage` /
  `settingsPathOf` / `listPackages` / `installPackage` / `removePackage`）+ host-check **20 条**新断言
  （**329 → 349**）。顺带把 `DefaultPackageManager` 加进 `loader.ts` 的 `REQUIRED_PI_EXPORTS`
  （依赖它就得配漂移守卫；F1 已证 bundle 里有它）。
- **与计划的两处差异（都是"提前"，不是改口径）**：
  1. `requireAgentDir` 与 **A13a** 从步骤 4 提前到步骤 1 —— 它是接口契约（`agentDir` 必填）的一部分，
     而"先写一条没人守的守卫、三步后再补断言"违反先红后绿。步骤 4 只剩 T15 与 A22。
  2. `writeManagerFor` 的 `{ projectTrusted: false }` 在步骤 1 就写上了（计划把它记在步骤 2）：
     没有理由先提交一版"知道不安全"的写路径；步骤 2 补的是**串行化 + 写后回读校验**及
     A18/A19/A20/A13b 的断言。
- **能红验证（每条都实跑过：改坏 `src/pi/packages.ts` → 重跑 host-check → 看红 → 恢复）**：

  | 断言 | 改坏方式 | 结果 |
  | --- | --- | --- |
  | A1 | `isNpmSource` 改成 `source.includes(":")` | 红（`git@…`/`https://…`/`C:\…`/`path:./x` 四条被误判） |
  | A11① / A12① | npm 分支的 `if` 改成 `if (false)` | 两条红（A12① 退回裸 spawn 原文） |
  | A11② | npm 分支条件去掉 `isNpmSource(source)` | 红（git 源被翻译成"需要 npm" = F37 的撒谎形态） |
  | A11③ | 路径分支的 regex 换成 `null` | 红 |
  | A8②③④ | 分别去掉 `(filtered)` / "找不到"分支 / project 标注 | 三条分别红 |
  | A13a | `requireAgentDir` 只拦 `undefined`、放过 `""` | 红 |
  | A4② | `changed` 恒 `true` | 红 |
  | A9① | `removed` 恒 `true` | 红 |
  | A12② | install **之前**手动 `setPackages(...)+flush()`（= "先写 settings 再 install"） | 红（settings 被写脏） |
  | A2 | 写 manager 改回默认信任 **且** `installAndPersist(source,{local:true})` | 红（`cwd/.pi/settings.json` 出现） |
  | A3① | 装完改成整份覆写（丢 `theme`/`retry`） | 红 |

- **计划里 A2 的红法要修正**（计划写的"只加 `{local:true}` → A2 红"在本设计下**不会红**）：
  写 manager 是 `{ projectTrusted: false }`，项目作用域会先被 `assertProjectTrustedForScope` 拦下抛错，
  根本没写工作区 —— 实测只改 `{local:true}` 时 A2 仍然绿。真实红法 = **两处一起改**（信任口径 + 作用域）。
  这不是放松验收：A2 的判据（"装完之后工作区里没有 `.pi/settings.json`"）不变，只是红法要跟着设计写。
- A1/A8/A11 是纯函数（构造对象当输入）；A2/A3/A4/A9/A12 走真 pi + 真文件系统（临时 agentDir/cwd，
  `fs.rmSync` 带 `mkdtempSync` 前缀的自然边界，不碰 `~/.pi/agent`）。

（步骤 2 起继续往下记。）

### 11.2 步骤 2（2026-09-17）：串行化 + 写后回读校验（A18/A19/A20/A13b）

- **落盘**：`withPackageLock`（模块级 promise 链，包住 install/remove 的整个"算数组 → 写盘"段）、
  `persistedSnapshot()`（**全新** manager 读文件）、`notPersistedMessage()`/`describeStorageErrors()`
  （把 `drainErrors()` 原文写进失败消息）；host-check 再加 **8 条**（**349 → 357**）。
- **实施期的一个坑（值得记）**：`SettingsManager.enqueueWrite()` 是**排队**的，
  `installAndPersist()` **不等**那次写盘 —— 只 `await installAndPersist()` 就去读文件会假红。
  所以写完先 `await settingsManager.flush()` 再回读（`flush()` 等的就是那条 `writeQueue`）。
  这也解释了为什么 F32 的"坏 JSON 下文件没动"能稳定复现：`save()` 在 `globalSettingsLoadError`
  非空时**根本不排队**（`settings-manager.js:355-366`），错误只在 `drainErrors()` 里。
- **写后回读的判据**：拿"装之前 / 装之后"两次**全新** manager 的 `getPackages()` 比 ——
  `changed === true` 但文件快照不变 ⇒ `ok:false` + `drainErrors()` 原文。比"逐字节比"稳
  （pi 会 `JSON.stringify(…,null,2)` 重写整份，见 N2），也比"认源字符串"稳（落盘是相对 agentDir 的形态）。
- **A18 的夹具设计**：全局 `npmCommand` 与项目 `npmCommand` 指到**两个不同**的不存在路径
  （`/nonexistent/user-npm` vs `/nonexistent/evil`）—— 错误里出现哪个就证明了用的是哪份配置，
  而且**不需要联网**（不能用真实的 `npm`，那会真的去装）。
- **能红验证（实跑）**：

  | 断言 | 改坏方式 | 结果 |
  | --- | --- | --- |
  | A19①③ | 删掉写后回读那一段 | 两条红（`ok:true` 而文件没写） |
  | A20 | `withPackageLock` 改成直接 `task()` | 红（文件里只剩 `../pkg-b` —— 与 F33 实测一致） |
  | A18 / A18② | 写 manager 改回默认信任 | 两条红（错误变成 `spawn /nonexistent/evil ENOENT`） |
  | A13b① | 同上 | 红 |
  | A13b② | 在 `installPackage` 里插一句 `void readManagerFor(deps)` | 红 |

### 11.3 步骤 3（2026-09-17）：四个 VS Code 命令（A5/A6/A9/A10/A14/A16/A17）

- **落盘**：`src/commands.ts` 四条命令 —— `jerrypi.installPackage`（输入框）、
  `jerrypi.installPackageFromFolder`（文件夹选择器，取 `uri.fsPath`）、`jerrypi.listPackages`（只读 QuickPick）、
  `jerrypi.removePackage`（只列 user 作用域候选）；`package.json` 的 `contributes.commands` 同步加四条；
  桩补 `showOpenDialog` + `queueOpenDialogResponse`。host-check 再加 **9 条**（**357 → 366**）。
- **实施期发现（两条都是"计划写的红法不成立"，与 §11.1 的 A2 同类）**：
  1. 🔴 **A17 的计划红法不成立**：计划写"把 `uri.fsPath` 改成 `uri.toString()` → A17 红"。
     实测：pi 的 `resolvePath()` 会 `fileURLToPath()` 把 `file:///…` 解码回真实路径
     （`chunk-JVUZYM.js` 的 `resolvePath`；还处理了 `%20`）⇒ **装仍然成功**，甚至落盘的相对形态也一样，
     所以"断言装成功了"抓不到这个退化。改后的 A17 追加一条可观测差异：**消息里的源串不出现 `file:`**
     （命令把下游拿到的源串回显出来了，这是唯一区分两种写法的地方）。红法已重跑确认。
  2. **A6②（源码不变式）要先去注释**：第一版直接对整份源码 `includes(".reload(")`，结果被我自己的
     一句注释（“`session.reload()` 不重裁决项目信任”）判红。改为**去行注释/块注释**后再查 ——
     否则注释里提一下就会假红，而"真的加一行 `session.reload()`"照样能红（已重跑确认）。
- **能红验证（实跑）**：

  | 断言 | 改坏方式 | 结果 |
  | --- | --- | --- |
  | A5 / A6① | 消息里去掉“新建会话（或重载窗口）后生效” | 两条红 |
  | A9② | `!outcome.removed` 分支改成弹“已移除”（信息消息） | 红 |
  | A14 | 安装命令开头加 `if (pickers === undefined) return;` | 红（没有会话宿主时不再装） |
  | A6② | 在安装命令里加一句真调用 `(module as …).reload()` | 红 |
  | A10 | `readManagerFor` 改成按 cwd\|agentDir 缓存 | 红（`before:1 / after:1`） |
  | A16 | `listPackages` 过滤掉 `filtered` 条目 | 红（项数 1 ≠ 3） |
  | A17 | 换成 `folder.toString()` | 红（消息里出现 `file:///…`） |

- **A9② 的夹具**：让 QuickPick 返回一个**改了源串**的条目（`…/not-in-config`）—— 模拟“用户选了一个已经不在配置里的条目”，
  这样 `removeAndPersist()` 真的返回 `false`，断言读的是**生产返回值**而不是把状态改坏。
  候选列表故意用 `picked.find(label === "../pkg-input")` 精确取本地条目，避开 npm 条目（删除 npm 源会 spawn `npm uninstall`）。

## 12. 实施与验收结果

（待实施）

## 13. 待用户拍板

见 §4 的 **Q1–Q17**（第 2 轮把 Q3 改成"不自动 reload"、加了 Q5b/Q9/Q10，并新增 B1 那条信任边界；
**2026-09-17 追加 Q11–Q17**，对应 §0.8 起的追加范围）。
**Astra 的两轮设计评审 + 末轮转写核对均已完成**（§10.3–§10.5；末轮 `VERDICT: OK`）；评审窗关闭，待用户拍板。
**⚠️ Q15 的默认值在评审中改过**（0.2.0 → **0.1.13**，Astra R1-B5 改、R2-N2 确认引文对齐：0.2.0 是 S10 首个正式版的语义，
S9 抢跳等于正式版跳过 Windows 预发布验证门槛）—— 用户拍板时请特别看这一条。
