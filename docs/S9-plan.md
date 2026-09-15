# S9 计划：pi 包管理（`Pi: Install Package` / `Pi: List Packages` / `Pi: Remove Package`）

> 状态：**计划期，待评审**（先过评审窗确认默认值，用户说"可以"后才动代码）。
> 上游承诺：`docs/PLAN.md` §6 的 S9 两条（`src/pi/packages.ts` 那行 + 验收那句）。
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
| F3 | 构造参数是 `{ cwd, agentDir, settingsManager }`（缺 `cwd` 会在 `startsWith` 处抛错 —— 这是 S1 就记下的坑） | `dist/core/package-manager.d.ts:66-70`（`PackageManagerOptions`）· PLAN §2 |
| F4 | `SettingsManager` 落盘是**加锁的读-改-写、只合并"本次改过的字段"** ⇒ 两个实例（命令里新建的那个 vs 跑着的会话持有的那个）不会互相覆盖对方的字段 | `dist/core/settings-manager.js:376-400`（`persistScopedSettings` + `storage.withLock`） |

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
| F14 | 装完之后**跑着的会话什么都不变**（命令表为空，连会话那份 `settingsManager.getPackages()` 都是空的 —— 它是启动时的缓存） | 探针 S1 |
| F15 | **`session.reload()` 一步就够**：它内部会 `await this.settingsManager.reload()` → `resourceLoader.reload()` → 重建 runtime；之后包里的**扩展命令**、**工具**、**主题**全都出现 | `dist/core/agent-session.js:2217-2240`；探针 S2/S7 |
| F16 | 只调 `resourceLoader.reload()` **不够**（探针 v1 的 S3：命令表仍为空）—— 重新解析了资源，但扩展注册要等 `session.reload()` 里的 `_buildRuntime` | 探针第一版 S3/S4（代码已并入 S5） |
| F17 | 移除后同样：不 reload 命令表还在，`session.reload()` 之后才消失 | 探针 S6 |
| F18 | `session.reload()` 的开头是 `session_shutdown(reason:"reload")` + `oldRunner.invalidate()` ⇒ **待审批时 reload 会让审批处理器手里的 `ctx` 变 stale**（S8 的 T14/§11 的 6-4 见过这个形态：我们的 fail-closed 会把它拦成 block，不会静默放行） | `dist/core/agent-session.js:2218-2221`；S8-plan §11 的 6-4 |
| F19 | `reload()` 会重新 `emit session_start`（`reason:"reload"`）+ `extendResourcesFromExtensions("reload")`，且保留 `activeToolNames` | `dist/core/agent-session.js:2226-2239` |
| F20 | 包里的资源怎么被认出来：目录里有 `extensions/`/`themes/`/`skills/`/`prompts/` 子目录就全收（`enabled: true`）；有 `package.json` 的 `pi` 清单则按清单；**两者都没有时把"目录本身"当成一个扩展路径**（pi 之后按"目录入口必须叫 `index.ts`/`index.js`"去加载它） | `:1801-1828`（`collectPackageResources`）、`:1046-1069`（`resolveLocalExtensionSource`）、`dist/core/pi-manifest.js:7-20`；探针 F4/F7 |
| F21 | 真包里的资源确实会被收：探针里那个包带 `extensions/rich.ts`（注册工具 `probe_echo`）与一份**真的**主题文件 ⇒ `session.reload()` 之后 `getActiveToolNames()` 里有 `probe_echo`、`resourceLoader.getThemes()` 里有 `gruvbox-dark` | 探针 S7 |

### 0.5 失败的形态（我们要翻译的错误）

| # | 事实 | 证据 |
| --- | --- | --- |
| F22 | 路径不存在：pi 抛 `Path does not exist: <绝对路径>`（`install()` 里的 `existsSync` 检查） | `:777-781`；探针 F8 |
| F23 | **没有 npm 时**：`npm:` 源抛的是**裸的 spawn 错误**，没有"需要 npm"这种话：`spawn /nonexistent/npm-binary ENOENT`（把 `npmCommand` 指到不存在的地方实测到）；**settings.json 没有被写脏**（`installAndPersist` 是"先 install 再写"，install 抛了就不写） | 探针 F9；`:786-789`（`await this.install()` 在前） |
| F24 | CLI 的措辞（我们尽量对齐，不发明新词）：装成功 `Installed <source>`；移除成功 `Removed <source>`；移除没匹配到 `No matching package found for <source>`（并且退出码 1）；列表空 `No packages installed.`，非空分 `User packages:` / `Project packages:`，`filtered` 的加 `(filtered)` 后缀 | `dist/bundle/chunks/chunk-JVUZSMYM.js:1544`（`package` 命令的 switch） |

### 0.6 现状：接哪儿、别碰哪儿

| # | 事实 | 证据 |
| --- | --- | --- |
| F25 | 命令都在 `src/commands.ts` 里注册（`registerCommands(context, output, pickers?)`），`agentDir` 取自 `module.getAgentDir()`、cwd 取自 `workspaceCwd().cwd` —— 与 S8 的 `Pi: Project Trust…` 同一套 | `src/commands.ts:37-46`、`:254-296` |
| F26 | 我们的面板**没有斜杠命令**：扩展注册的命令（`getRegisteredCommands()`）目前**没有任何 UI 入口** ⇒ 包里"注册命令"这件事在面板里看不见；**看得见的是工具**（agent 调用时出卡片） | `grep -rn "getRegisteredCommands" src/` 只命中自测两处；`src/webview/main.ts` 无斜杠处理 |
| F27 | 用户的真实 `~/.pi/agent/settings.json` **已经**有 `"packages": ["../../Desktop/prj/pi-config"]`，且 `theme: "catppuccin-mocha"` 正是 pi-config 的主题 ⇒ 拿 pi-config 当"新装一个包"的验收夹具会**撞上幂等分支**（装完什么都不变）；它更适合当"已经装过"的分支夹具 | 实读 `~/.pi/agent/settings.json`（2026-09-15） |
| F28 | `Pi: Run Self-Test` 的**大部分**项用**真实 agentDir**（`module.getAgentDir()`）；只有 T14 这类自带隔离夹具的项例外 ⇒ 包管理的自测项**必须**自带临时 agentDir，否则会在用户配置里写 `packages` | `src/pi/selftest.ts`（T14 的夹具）+ `src/commands.ts:47-60`（`agentDir: module.getAgentDir()`） |

## 1. 目标与判据

上游两条（PLAN §6）拆成可判的条目。断言编号见 §6。

| # | 判据（用户视角） | 自动断言 |
| --- | --- | --- |
| C1 | `Pi: Install Package` 接受 **pi 原生源格式**（裸本地路径 / `npm:name` / git URL），**不发明** `path:` 之类前缀；只装 **user 作用域**（写 `<agentDir>/settings.json`），**绝不写工作区** | A1/A2/A3 |
| C2 | 装成功后：`settings.json` 里出现该包（本地路径是**相对 agentDir** 的形态）、面板给出人话的反馈（安装了哪个源、写去了哪个文件、**怎么让它生效**） | A4/A5 |
| C3 | 装完之后**包真的能生效**：空闲时自动 `session.reload()`（或明确告诉用户"新建会话/重载窗口后生效"），之后的会话里，包里的**工具**能用、**主题**在列表里 | A6/A7 |
| C4 | `Pi: List Packages` 显示 `listConfiguredPackages()` 的**全部**条目，标明作用域与解析后的路径；**本地路径已经失效**的条目要明说（这是 README 里那条"扩展升级后失效"的可见化） | A8 |
| C5 | `Pi: Remove Package` 移除配置里的条目；pi 说"没匹配到"时**不许**报告成功（`removeAndPersist()` 返回 `false` ⇒ 明确提示"未移除"） | A9/A10 |
| C6 | 受限机上 `npm:`（以及要 npm 的 git 源）失败时，给出**能懂的**提示（"这个源需要 npm"），而不是把 `spawn … ENOENT` 直接甩给用户；**不许**把失败说成成功，也不许留下写脏的 settings | A11/A12 |
| C7 | 不碰用户数据：安装只动 `<agentDir>/settings.json`；自测项自带临时 agentDir；`Pi: Install Package` 在**没打开过面板**时也能用（不需要会话） | A3/A13/A14 |

## 2. 本步做什么 / 不做什么

**做**：

- `src/pi/packages.ts`（纯 Node，可测）：
  - `createPackageManager({ pi, cwd, agentDir })` —— 内部 `SettingsManager.create(cwd, agentDir)` + `new DefaultPackageManager({cwd, agentDir, settingsManager})`；
  - `installPackage(source)` / `removePackage(source)` / `listPackages()`；
  - `translateSourceError(error, source)` —— 把 F22/F23 那两种形态翻成人话（纯函数，断言好写）；
  - `describePackage(entry)` —— `{label, description, detail}`（列表里那一行；纯函数）。
- 三条命令（`src/commands.ts`）：`jerrypi.installPackage` / `jerrypi.listPackages` / `jerrypi.removePackage`
  （**主入口是输入框**；另加**从文件夹选**的辅助路径，见 Q2）。
- 装/卸之后：**空闲时**自动 `session.reload()`（`SessionHost.reloadSession()`），并说清"已经生效"还是"下次新建会话生效"。
- 文档：README 中英（三条命令 + 三条已知限制）、`pi-traps` 加条目、`PLAN.md` §6 那段"已知限制"逐字落地。
- 自测 **T15**（gating，**不用模型**） + host-check 的 A1–A14。

**不做**（每条都要说清为什么）：

| 不做 | 为什么 |
| --- | --- |
| **项目作用域**（`{local:true}` / "装到这个工作区"） | 它会**写进用户仓库的 `.pi/settings.json`**（F8 实测）。这与"别动用户的东西"直接冲突；真要做也得单独设计（问一句、可撤销、写进 README）。v1 只做 user 作用域（= 与 CLI 的默认行为一致） |
| 扩展命令的 UI 入口（把包里的 `/cmd` 搬进面板） | 面板没有斜杠命令（F26），这是个**独立的**功能（还要考虑与 VS Code 命令面板的命名冲突）；S9 的承诺里只有"装/列/卸" |
| `update` / `checkForAvailableUpdates` / 自动更新 | pi 有这些 API，但"联网更新"要单独的网络策略与验收（S6 的代理教训），且用户没要求 |
| 在 VS Code 里编辑 pi 的包清单（过滤 `enabled` 字段、`autoload:false` 的 delta 包） | `PackageSource` 支持对象形态（`{source, extensions:[…]}`），面板要为此设计一套表单；v1 只处理字符串形态（列表里给 `filtered` 的加 `(filtered)` 后缀，与 CLI 一致，F24） |
| 自己实现"包目录扫描/校验"（比如判断一个裸路径"像不像包"） | 那是 pi 的规则（F20），复刻一份就会分叉。我们只把 `false`/报错原样翻译 |
| 装完自动**重启**扩展宿主 | VS Code 不允许扩展重启自己；`session.reload()`（F15）已经够用 |

## 3. 关键设计

### 3.1 `src/pi/packages.ts`（纯逻辑，不认识 vscode）

```ts
export interface PackageDeps {                    // 只依赖 pi 的导出面 + 路径
  pi: PiModule;                                   // DefaultPackageManager / SettingsManager
  cwd: string;
  agentDir: string;
}

export interface PackageManager {
  list(): ConfiguredPackage[];                    // 直接转发 pi（F13）
  install(source: string): Promise<InstallOutcome>;
  remove(source: string): Promise<RemoveOutcome>;
  settingsPath: string;                           // <agentDir>/settings.json（给文案用）
}

export interface InstallOutcome { ok: true; changed: boolean; source: string } | { ok: false; message: string };
export interface RemoveOutcome { ok: true; removed: boolean; source: string } | { ok: false; message: string };
```

- **`changed`**：装之前/之后比 `settingsManager.getPackages()`（F10）——`false` 表示"本来就在配置里"，
  文案走"已经装过了（未改动）"这一支（用户的 pi-config 正好会走这里，F27）。
- **`removed`**：`removeAndPersist()` 的返回值**原样透出**（F11）—— `false` 就是"未移除"（C5）。
- 失败一律**不抛**，返回 `{ok:false, message}`；`message` 由 `translateSourceError` 产出。

`translateSourceError(error, source)` 的规则（每一条都要有断言，A11）：

| pi 给的 | 我们给的 |
| --- | --- |
| 消息匹配 `/\bENOENT\b/`（以及 `spawn` 字样），且源不是本地路径 | `这个源需要 npm 才能安装（npm: 包 / 带 package.json 的 git 源都要它）；当前机器上没有可用的 npm。本地文件夹仍然可以装。` |
| `Path does not exist: <p>` | 原样保留（它已经说清了），前缀 `找不到这个路径：` |
| 其它 | 原样透出 pi 的消息（不吞、不重写） |

### 3.2 三条命令的形状（`src/commands.ts`）

```
Pi: Install Package        → showInputBox（placeholder 列出三种源形态）→ installPackage()
                             → 成功：信息消息 + Output 明细（含 settings 路径 / 是否生效）
                             → 失败：警告消息（人话）+ Output 原文
Pi: Install Package from Folder…  → showOpenDialog({canSelectFolders}) → 同上（Q2）
Pi: List Packages          → QuickPick（每项：源 + 作用域 + 解析路径，失效的标"找不到"）
Pi: Remove Package         → QuickPick（候选 = 当前配置里的包）→ removeAndPersist()
                             → removed=false 时提示"未移除（配置里没有匹配的条目）"
```

- 输入框与 QuickPick **都由宿主侧弹**（与 S8 的 `Pi: Project Trust…` 一致），**不经过 webview** ⇒ 协议**不用改**。
- 输入框里 ESC / 空串 → 直接返回（不产生任何副作用）。
- `Pi: List Packages` 用**全新**的 `SettingsManager`（F3/F13），所以看到的是**文件里的真相**，
  不受"跑着的会话缓存"影响（F14）。

### 3.3 装完之后怎么生效（`SessionHost.reloadSession()`）

```ts
// src/pi/session.ts：给 SessionHost 加一个方法（老方法不动）
async reloadSession(): Promise<void> { await session.reload(); }
```

命令里的顺序（C3）：

1. `install()` 成功 → 2. 如果**有** host 且 `session.isStreaming === false` → `await host.reloadSession()`
   → 文案"已生效（当前会话已重载）"；3. 否则 → 文案"已保存；新建会话或重载窗口后生效"。

- **只在空闲时 reload**：F18 —— reload 会让旧 runner 的 `ctx` 变 stale，而"正在跑"包含"正在等审批"
  （那种情况下我们的 fail-closed 会把它 block 掉，不会静默放行，但没必要去撞）。
- reload 之后**不需要**重新绑定我们自己的订阅：`reload()` 保留同一个 `AgentSession` 对象，
  我们的 `subscribe` 挂在会话上（`agent-session.d.ts:252` 也写明"回调在执行时读 `_extensionRunner`，
  所以扩展重载会换上新 runner"）。这一步的**证据**是 A6 里"reload 之后面板仍能收事件"。

### 3.4 自测项 T15（**不用模型**，自带临时 agentDir）

```
T15：包管理的往返（临时 agentDir + 临时 cwd + 一个临时"包"）
  ① install → <tmp>/settings.json 出现 "packages": ["../pkg"]（相对形态，F9）
  ② 同一 cwd 下 cwd/.pi/settings.json **一个字节都不动**（F6/F8，C1）
  ③ list() 命中那条：scope=user、installedPath=绝对路径
  ④ 建一个会话（脚本化模型流，与 T14 同一套）→ 装之前工具表里没有 probe_echo
  ⑤ session.reload() → 工具表里有 probe_echo、主题列表里有那个主题（F15/F21）
  ⑥ remove → 返回 true；再 remove → **false**（F11）
  ⑦ reload → 工具表里 probe_echo 消失（F17）
```

为什么放进 `Pi: Run Self-Test` 而不是只留在 host-check：它是**用户机器上的端到端**（真 pi bundle +
真文件系统 + 真会话），且不用凭据/网络 ⇒ 在受限机上也会真跑（与 T14 同一个理由）。

⚠️ **绝不用真实 agentDir**（F28）：整个 T15 在 `mkdtemp` 里，`settings.json` 是临时目录里的那份。

### 3.5 上限与内存

- 列表不分页（`listConfiguredPackages()` 一般是几条到几十条）；QuickPick 天然可搜索。
- 不缓存任何东西：每次命令都新建 `SettingsManager` + `DefaultPackageManager`（它们会读盘，成本是几次 `readFileSync`）。

## 4. 决策与默认值（Q1–Q8，等用户拍板）

| # | 问题 | 默认值（我的建议） | 备选 |
| --- | --- | --- | --- |
| Q1 | 作用域 | **只做 user 作用域**（写 `<agentDir>/settings.json`），与 pi CLI 默认一致；不提供项目作用域 | 加 `{local:true}`（会写进用户仓库），需要单独的确认与撤销 |
| Q2 | 本地路径怎么输入 | **两个入口**：`Pi: Install Package`（输入框，三种源都能填）+ `Pi: Install Package from Folder…`（原生文件夹选择器）。理由：Windows 上手输 `C:\Users\…\.vscode\extensions\flyjancy.jerrypi-0.1.x\test-fixtures\ext-smoke` 不现实 | 只留输入框（少一条命令，但 Windows 验收要手输长路径） |
| Q3 | 装完要不要**自动** reload | **空闲时自动 reload**（F15 一步够），正在跑就不动、并说明"新建会话生效" | 从不自动 reload（更保守，但用户会以为装失败了） |
| Q4 | 已经装过的源再装一次 | 报告 **"已经在配置里了（未改动）"**（`changed=false`，F10），**不**当失败 | 静默成功（分不清"装了"和"早就有了"） |
| Q5 | `Pi: List Packages` 里"配好了但路径没了"的条目 | 照常列出，标注 **"找不到（路径已失效）"**（`installedPath === undefined`，F13）；**不**自动删除（那是用户的数据） | 直接过滤掉（会让用户以为配置丢了） |
| Q6 | 移除时的确认 | **不**再弹一次确认（QuickPick 选中的动作本身就是意图），但移除**后**要说清移除了什么 | 二次确认（多一次点击） |
| Q7 | `npm:` / git 源在受限机上的文案 | 翻译成"需要 npm"（§3.1 的表），并**保留 pi 的原始消息**在 Output | 只透出 pi 的原文（用户看不懂 `spawn … ENOENT`） |
| Q8 | README 里那条"扩展升级后路径失效" | 写进**已知限制**（PLAN §6 已承诺），并在 `Pi: List Packages` 里可见化（Q5） | 只在 README 写 |

## 5. 风险

| # | 风险 | 触发条件 | 处理 |
| --- | --- | --- | --- |
| R1 | **把用户的 settings.json 写脏** | `installAndPersist` 写的是 `packages` 一个字段 | F4（加锁 + 只合并改过的字段）+ A3（"只动 settings.json 的 `packages`，其他字段一个字节不变"）；失败路径天然不写（F23） |
| R2 | 装完"看起来成功了但没生效" | 用户不知道要 reload | Q3：空闲时自动 reload；否则**明说**怎么生效（C3）。断言 A6/A7 |
| R3 | 在**忙碌**（尤其待审批）时 reload 造成中断/审批被 block | 用户在 agent 跑着的时候装包 | 只在 `isStreaming === false` 时 reload（§3.3）；F18 记下"万一撞上会怎样"（fail-closed，不会静默放行） |
| R4 | 自测项污染用户配置 | T15 用了真实 agentDir 就会写 `packages` | §3.4：临时 agentDir + 临时 cwd；断言 A13（跑完真实 `~/.pi/agent/settings.json` 的 mtime/内容不变） |
| R5 | 相对路径的包在**扩展升级后失效** | 源在扩展安装目录里（Windows 验收正是这个形态） | README 已知限制（Q8）+ 列表里可见（Q5）；**不自动修**（不替用户改路径） |
| R6 | 我们翻译错误信息时把"路径不存在"误判成"需要 npm" | 正则过宽 | A11 三态断言（`ENOENT`+npm / `Path does not exist` / 其它），并**只对非本地源**套 npm 分支 |

## 6. 检查清单（自动断言，先红后绿）

**能红验证是硬要求**：每条断言都要有一条"故意改坏实现"的破法（最后一列），我会逐条实跑并记录到 §11。

| # | 断言（在哪） | 怎么让它红 |
| --- | --- | --- |
| A1 | `packages.ts`：`install("npm:foo")` 不会把源当成本地路径（`isLocalSource` 的判定顺序：先 `npm:`、再 git、最后本地） | 把判定顺序改成"先本地" → A1 红 |
| A2 | `install()` **只**写 `<agentDir>/settings.json`：装完之后 `cwd/.pi/settings.json` **不存在** | 给 install 传 `{local:true}` → A2 红 |
| A3 | 写盘只动 `packages` 字段：预置一份带 `theme`/`defaultTools` 的 settings.json，装完这两项**逐字节不变** | 手工把实现改成"整份覆写" → A3 红 |
| A4 | `changed` 语义：第一次 `true`；同一个源再装一次 `false`（F10） | 恒返回 `true` → A4 红 |
| A5 | 命令层：输入框给 `"<tmp>/pkg"` → 信息消息里有源名与 `settings.json` 路径 | 把消息里的路径换成 agentDir → A5 红 |
| A6 | 空闲时装包 → 调用了 `reloadSession()`（桩计数 1）；正在流式（`isStreaming=true`）时 → **不**调，且文案是"新建会话生效" | 去掉 `isStreaming` 判断 → A6 红（忙时也 reload） |
| A7 | reload 之后**同一个会话**里包的工具真的出现（host-check 用真 pi + 临时包；与探针 S7 同一条路径） | 不调 reload（只写文件）→ A7 红 |
| A8 | `describePackage()`：`filtered` 加 `(filtered)`、`installedPath === undefined` 加"找不到（路径已失效）"、scope 显示 user/project | 去掉"找不到"分支 → A8 红 |
| A9 | `removePackage()`：`removeAndPersist()` 返回 `false` 时 → `removed=false` **且不当成功** | 恒返回 `removed=true` → A9 红 |
| A10 | 命名不变式：`Pi: Remove Package` 的候选来自**当前文件**的 `list()`（不是进程内缓存） | 改成读会话缓存 → A10 红（先手工写文件再问命令，看不到） |
| A11 | `translateSourceError()` 三态（npm 缺失 / 路径不存在 / 其它原样） | 去掉 `ENOENT` 分支 → 第一态红；分支放宽到所有源 → 第二态红 |
| A12 | 失败**不留脏**：`install("npm:foo")` 在 npm 不可用时抛 → settings.json 与装之前逐字节相同（F23） | 改成"先写 settings 再 install" → A12 红 |
| A13 | **不碰用户数据**：跑完 host-check 的全部包管理断言之后，真实 `~/.pi/agent/settings.json` 的内容与 mtime 不变 | 把夹具的 agentDir 改成真实 agentDir → A13 红 |
| A14 | `Pi: Install Package` 在**没有会话**时也能成功（`packages.ts` 不依赖 `SessionHost`） | 让 install 走一次 `host.session` → A14 红（桩里 host 为 undefined 时抛） |
| A15 | 自测 **T15**（gating，不用模型）：§3.4 的七步全过 | 把 `session.reload()` 那一步删掉 → ⑤⑦ 红 |
| A16 | `Pi: List Packages` 的 QuickPick 项数与 `list()` 一致（不是硬编码，也不是"只显示本地源"） | 过滤掉 `filtered` 的条目 → A16 红 |

以上 A1–A14 进 `host-check`（**无需凭据**），A15 进 `Pi: Run Self-Test`（T15，**gating**），
A16 与 A5/A9 的"真命令"部分沿用 S8 的做法：**真命令 + 桩 QuickPick/InputBox**
（S8 的 A14 已经证明这条路可行；`scripts/fixtures/vscode-stub.mjs` 现在有共享状态与 `Uri.fsPath`）。

## 7. 人工验收（Mac，**2 个动作**）

夹具由我准备好（`~/Desktop/s9-pkg-demo/`，含 `extensions/demo.ts` 注册工具 `demo_echo` + 一份主题；
**不放包内任何开发文件**），用户只做：

**M1（1 个动作）**：`Pi: Install Package` → 输入框里选/粘 `~/Desktop/s9-pkg-demo`（或走 Q2 的文件夹选择器）
→ 核对：① 信息消息说的是这个源 + `settings.json` 的**完整路径**；② **面板没坏**（还能发消息）；
③ `Pi: List Packages` 里能看到它（作用域 user + 解析后的绝对路径）；④ **重启 VS Code** 之后
`Pi: List Packages` 仍然有它；⑤ 让 agent "用 demo_echo 工具说 hi" → **卡片上出现这次工具调用**（C3 的可见证据）。

**M2（1 个动作）**：`Pi: Remove Package` → 选中它 → 核对：① 提示是"已移除"；② `Pi: List Packages` 里没有它了；
③ 重启 VS Code 后仍然没有（`settings.json` 里也真的没了）。

> 为什么必须人工（`AGENTS.md` §1 的四类）：**①真焦点/真键盘** —— 输入框与 QuickPick 是原生 UI，
> 自动断言里是桩；**②真进程** —— "重启 VS Code 之后仍然生效"只有真重启能验。

## 8. Windows 项（不新增人工动作）

并进 W0/W1 一起做（那台机器的 `test-fixtures/ext-smoke` 是随扩展发布的，正好当**本地包源**）：

- **W0**：`Pi: Run Self-Test` 期望变成 **17 项**（新增 T15；T12 仍 SKIP）⇒ `16 PASS / 0 FAIL / 1 SKIP`。
- **W1**：`Pi: Install Package` → 选/输 `…\extensions\flyjancy.jerrypi-0.1.x\test-fixtures\ext-smoke`
  （Q2 的文件夹选择器就是为这一步加的）→ `Pi: List Packages` 能看到 → **重启 VS Code** →
  让 agent 调 `smoke_tool`（那个包注册的工具）→ 出现卡片 ⇒ 证明"重启后包真的被加载"；
  然后 `Pi: Remove Package` → 列表里没了。输入 `npm:foo` 应得到**"需要 npm"**的人话提示（C6）。

## 9. 步骤（每步单独提交 + 门禁全绿）

| 步 | 内容 | 断言 |
| --- | --- | --- |
| 1 | `src/pi/packages.ts`（纯函数 + 依赖注入）+ `translateSourceError` + `describePackage` | A1–A4、A8、A9、A11、A12 |
| 2 | `src/pi/session.ts` 的 `reloadSession()` + 会话宿主/控制器接线 | A6、A7、A14 |
| 3 | 三条命令（+ `package.json` 的 `contributes.commands`、i18n 标题）+ 输入框/文件夹选择器 | A5、A10、A16 |
| 4 | 自测 T15 + host-check 的 A13（不碰用户数据） | A13、A15 |
| 5 | 文档：README 中英（三条命令 + Q8 的已知限制）、`pi-traps`（`session.reload()` 才是生效点、`addSourceToSettings` 的返回语义、npm 缺失的错误形态）、`PLAN.md` §6 的"已知限制"逐字落地 | settings-check 的 16 项仍绿 |
| 6 | 版本 0.1.13 + 打包 + Mac M1/M2 → 上传/核验 → Windows W0/W1 → §12 回填 → 关阶段 | — |

## 10. 评审记录

（待第 1 轮）

## 11. 实施期发现

（待实施）

## 12. 实施与验收结果

（待实施）

## 13. 待用户拍板

见 §4 的 **Q1–Q8**。
