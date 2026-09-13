# S6 计划：设置与密钥（三项 VS Code 设置 / 密钥管理 / 模型目录刷新）

> 状态：**计划期，待评审**（本文件先给评审窗过一遍，确认默认值后再动代码）。
> 上游：`docs/PLAN.md` §6 的 S6、§5.3 的代理两层策略、§5.1 的 `src/host/config.ts` 与 `src/host/net.ts`。
> 前置：S5 已关闭（0.1.7；会话管理，含"与 pi CLI 互通"）。
> 本步的验收（PLAN 原文）：**清空 `models.json` 里的 key、只靠 SecretStorage 也能完成对话。**
> 相关判据：G4（模型列表来自 pi 的目录、能切换）、G5（不依赖原生模块）。

## 0. 本计划已核实的事实（都带证据，不靠记忆）

写计划前对着 pi 0.85.1 的产物逐条核过。**下面每一条都决定了 S6 的一个设计选择。**

### 0.1 agentDir：它读什么、什么时候读

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `getAgentDir()` = `process.env.PI_CODING_AGENT_DIR`（经 `expandTildePath`），否则 `join(homedir(), ".pi", "agent")`。**每次调用都读环境变量，没有缓存** | `node_modules/@earendil-works/pi-coding-agent/dist/config.js`：`ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\``，`getAgentDir()` 直接读 `process.env[ENV_AGENT_DIR]` |
| F2 | 其余路径**全部**从它派生：`getSessionsDir()` = `<agentDir>/sessions`、`getModelsPath()` = `<agentDir>/models.json`、`getAuthPath()` = `<agentDir>/auth.json`、`getSettingsPath()`、`getCustomThemesDir()`、`getToolsDir()`、`getBinDir()`、`getPromptsDir()` | 同文件；`getSessionsDir` 只是一行 `join(getAgentDir(), "sessions")` |
| F3 | 另有 `PI_CODING_AGENT_SESSION_DIR`（`ENV_SESSION_DIR`）—— **只在 pi 的会话目录推导里用**，我们刻意不跟随（S5 的 R9 会在 Output 记一行诊断） | 同文件；`docs/S5-plan.md` §11 的 R9 |

**⇒ 结论**：想让 `jerrypi.agentDir` 生效，正确做法是**在扩展激活的最开头、任何 `loadPi()` 之前设 `process.env.PI_CODING_AGENT_DIR`**。这是**进程级**副作用（扩展宿主是共享进程），必须写进设置描述与 README。

**⇒ 但"改了设置就生效"做不到**：`ModelRuntime` 被我们按 agentDir 缓存（`src/pi/runtime.ts` 的 `runtimes` Map），pi 模块内部也在首次 import 时就建立了与目录相关的状态（settings-manager、extensions loader、models-store）。所以 S6 的答案是**重载窗口**，不是热切换（见 §3.1、Q1）。

### 0.2 API key：存在哪、优先级、能删什么

| # | 事实 | 证据 |
| --- | --- | --- |
| F4 | key 的解析优先级：**runtime 覆盖（内存）→ auth.json（stored）→ provider 自带的 configured → 环境变量** | `dist/core/model-runtime.js` 的 `getProviderAuthStatus()`：`hasRuntimeApiKey` → `snapshot.storedProviders` → `configuredRequestAuthStatus` → `snapshot.auth` |
| F5 | `RuntimeCredentials` 是**纯内存覆盖层**（文件头注释原话："Async credential store overlay for **non-persistent** runtime API keys"）：`setRuntimeApiKey`/`removeRuntimeApiKey` 只动一个 `Map`；`read()` 覆盖优先；`list()` 把覆盖项与底层合并 | `dist/core/runtime-credentials.js` 全文 |
| F6 | ⚠️ **`RuntimeCredentials.delete()` 会去删底层（auth.json）里的凭据** —— 也就是 `ModelRuntime.logout()` 会**动用户的 auth.json** | 同文件：`async delete(providerId, options) { await this.store.delete(...); this.overrides.delete(...) }` |
| F7 | `ModelRuntime.create()` 接受 `authPath` / `modelsPath` / `modelsStorePath` / `allowModelNetwork` 等；我们**已经显式传了三个路径**（S5 之前的决定） | `dist/core/model-runtime.d.ts` 的 `CreateModelRuntimeOptions`；`src/pi/runtime.ts` 的 `createModelRuntime()` |
| F8 | `ModelRuntime.refresh({ allowNetwork, force, providers, signal })` 可以**显式**联网刷新；`create({ allowModelNetwork: false })` 只影响**创建期** | `model-runtime.d.ts`；`dist/core/model-runtime.js` 的 `refresh` 实现里 `options.allowNetwork ?? true` |

**⇒ 结论**：`Pi: Clear Stored API Keys` **必须**用 `removeRuntimeApiKey()` / SecretStorage.delete，**绝不能用 `logout()`**（那会删掉用户 auth.json 里的凭据 —— 违反"不替用户动 `~/.pi/agent`"）。这条要进 `docs/pi-traps.md`。

### 0.3 代理：为什么它是"两层"的

| # | 事实 | 证据 |
| --- | --- | --- |
| F9 | pi 的代理能力在 `dist/core/http-dispatcher.js`：`configureHttpDispatcher()` 装 undici `EnvHttpProxyAgent` 并**替换 `globalThis.fetch`**（`undici.install()`），另有 `applyHttpProxySettings(httpProxy)` 走 `process.env.HTTP_PROXY ??= proxy` | 同文件；`HTTP_IDLE_TIMEOUT_*` 也在那儿 |
| F10 | 它**只被 CLI / TUI / rpc-entry 调用**（`dist/cli/setup.js`、`dist/modes/interactive/interactive-mode.js`、`dist/rpc-entry.js`）—— **SDK 路径不会自动调用** | `grep -rn configureHttpDispatcher dist/` 的调用点只有这三处 |
| F11 | 而且**拿不到**：包的 `exports` 只有 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`（**没有** http-dispatcher 子路径）；我们 ship 的 `pi-runtime/dist/bundle/index.js` 里 `configureHttpDispatcher` 出现 **0 次** | `node_modules/@earendil-works/pi-coding-agent/package.json` 的 `exports`；`grep -c` 结果 |
| F12 | Node 自带的环境变量代理**用不上**：本机 Node 26.8.1 实测 —— 启动时设 `NODE_USE_ENV_PROXY=1`（并把 `HTTP_PROXY` 指向死端口 `127.0.0.1:9`）`fetch()` 仍返回 200；`--use-env-proxy`（`node --help` 里确实有这个 flag）同样无效；跑完第一次 fetch 之后再设环境变量也无效。`node:undici` 不存在 | 本机实测（三条命令，见提交信息）；`--help` 里那条写着 "apply the setting in global HTTP/HTTPS clients" |

**⇒ 结论**：`jerrypi.proxy` 若要做，只有 PLAN §5.3 第 2 层那条路（**扩展自带 undici**，包装 `globalThis.fetch`）。PLAN §5.3 已经写好了那一层的全套要求（不调 `undici.install()`、不动 `Request/Response/Headers/WebSocket`、只管字符串与 `URL` 输入、恢复语义、`ProxyAgent.close()`、**宿主网络回归验收**）。
**⇒ 但代价**：一份 undici 依赖 + 一个全局副作用 + 一条"宿主网络回归"的人工验收 —— 与我们"Mac ≤2"的预算直接冲突（见 Q2）。

### 0.4 现状：今天这套代码是什么样

| # | 事实 | 证据 |
| --- | --- | --- |
| F13 | `package.json` **没有** `contributes.configuration` —— 三项设置**从来没有被声明过**，`src/` 里也没有任何 `getConfiguration()` 调用。也就是说 `jerrypi.agentDir` / `jerrypi.proxy` / `jerrypi.approvalMode` 今天**写了完全不生效** | 审计见提交 `d63d242`；`python3 -c "json.load(open('package.json'))['contributes'].keys()"` → `commands/viewsContainers/views` |
| F14 | 现有 key 链路：`src/pi/runtime.ts` 的 `ApiKeyStore`（SecretStorage + globalState 里的 provider 列表）、`getModelRuntime()` 按 agentDir 缓存、`createModelRuntime()` 显式传三个路径并在创建时注入、`injectApiKey()` 立刻给已缓存实例注入。**缺 `removeApiKey`** | `src/pi/runtime.ts` |
| F15 | 现有命令：`Pi: Set API Key`（**硬编码**候选 provider 列表、**没有任何校验**）、`Pi: Open Settings File`（用 `module.getAgentDir()`，文件不存在时写 `{}`） | `src/commands.ts` |
| F16 | `RuntimeCredentials.list()` 会把 **auth.json 里的凭据也列出来**（`{ providerId, type }`，不含 key 本身） | `dist/core/runtime-credentials.js` 的 `list()` |
| F17 | `dist/core/session-manager.js` 的 `sessionCwdMatches()` 是**严格字符串比较**；自定义 agentDir 会让 `list(cwd, sessionDir)` 走 `filterCwd = true` 那条路（S5 的 R10） | `docs/S5-plan.md` R10 · §12.3（W0 实测同一台 Windows 上存在 `c:\…` 与 `C:\…` 两种写法） |

## 1. 目标与判据

**目标**（PLAN §6 原文）：三项 VS Code 设置、`Pi: Clear Stored API Keys`，并把 S1 的最小版 `Pi: Set API Key` / `Pi: Open Settings File` 补完整（provider 选择、校验）。

**判据**（PLAN 原文）：清空 `models.json` 里的 key、只靠 SecretStorage 也能完成对话。

把它拆成**可自动断言**的三条（§6 逐条对应）：

1. **C1**：一个**没有任何凭据文件**（`auth.json` 不存在、`models.json` 里没有 key）的 agentDir，只要 SecretStorage 里有 key，就能完成一轮真实对话。
2. **C2**：`Pi: Clear Stored API Keys` 之后，同一个 agentDir **不能再**对话（模型列表为空），且 **auth.json 一个字节没变**。
3. **C3**：`jerrypi.agentDir` 指向别的目录时，**会话、模型、设置三条链路都在新目录上**（不是只有一条跟着走）。

## 2. 本步做什么 / 不做什么

**做**：

- 三项设置的**声明**（`contributes.configuration`）+ 一处读取（新建 `src/host/config.ts`）
- `jerrypi.agentDir` 生效（§3.1）+ 变更后提示重载
- `Pi: Clear Stored API Keys`
- `Pi: Set API Key` 补完：provider 候选来自 pi 自己、标注"已配置"、本地校验
- `Pi: Refresh Model Catalog`（Q5；`refresh({ allowNetwork: true })`）
- `Pi: Open Settings File` 的目标文件跟着生效的 agentDir（现状已如此，S6 只补断言）
- 代理：**第一层的验证**（便宜）+ 设置描述与 README 的诚实标注（第二层是否做见 Q2）

**不做**（明确划出去）：

- `jerrypi.approvalMode` 的**实现**（S8；S6 只登记 + 在描述里写明"尚未生效"）
- 第 2 层代理（除 Q2 决定做）
- 任何形式的"替用户搬/改 `~/.pi/agent` 下的数据"（含 auth.json）
- "发一条真请求验证 key 有效性"（除 Q3 决定做）
- 把 `PI_CODING_AGENT_SESSION_DIR` 也做成设置（S5 已决定不跟随，R9 只记诊断）

## 3. 关键设计

### 3.1 `jerrypi.agentDir` 怎么生效（进程级环境变量 + 重载窗口）

```
activate() 第一件事
  └─ applyAgentDirSetting(context)          // 新增，在任何 loadPi() 之前
       const configured = getConfiguration("jerrypi").get<string>("agentDir")
       if (configured && !process.env.PI_CODING_AGENT_DIR)   // ← 只在"环境变量没设"时写
           process.env.PI_CODING_AGENT_DIR = configured
  └─ 之后所有 loadPi() / getModelRuntime() / workspace 逻辑不变（它们都问 pi.getAgentDir()）
```

三个刻意的选择：

1. **`??=` 语义（环境变量优先）**：用户若在 shell 里设过 `PI_CODING_AGENT_DIR`，我们**不覆盖**它。理由：那是用户对"整台机器上的 pi"的显式选择，VS Code 设置是更窄的一层；而且 pi 自己的 `applyHttpProxySettings` 用的就是同一个 `??=` 惯用法（F9）。
2. **重载窗口而不是热切换**：agentDir 变了要重建的东西太多（我们的 runtime 缓存、pi 模块内的 settings-manager/models-store/extensions loader），热切换一定会出现"半新半旧"的劈叉。做法：`onDidChangeConfiguration` 命中 `jerrypi.agentDir` 时弹一条**信息**消息，附「重载窗口」按钮（`workbench.action.reloadWindow`）—— 不强制、不静默。
3. **`activate()` 里第一位**：`loadPi()` 是动态 `import()`，pi 模块级状态在**第一次 import** 时建立；我们必须在它之前设好环境变量。

**为什么这条不能省人工验收**：环境变量的进程级效果 + 重载窗口是真实 VS Code 生命周期，无头环境里两者都没有。见 §7 的 M1。

### 3.2 密钥：存、注入、清

- 存：**只** SecretStorage（`jerrypi.apiKey.<providerId>`）+ globalState 里一份 provider 名单（SecretStorage 不能枚举）。**不写 auth.json**（S1 的决定，S6 保持）。
- 注入：`createModelRuntime()` 创建时注入 + `injectApiKey()` 立刻注入已缓存实例（现状，F14）。
- 清：新增 `ApiKeyStore.removeApiKey(providerId)`（`secrets.delete` + 从 globalState 名单移除）+ 命令 `Pi: Clear Stored API Keys`：
  1. QuickPick（`canPickMany`）列出 `keys.listProviders()`，每项标注**来源**：`runtime`（面板存的）／`stored`（auth.json 里的）—— 数据来自 `listCredentials()`（F16）。
  2. 只允许勾选**面板存的**那些；auth.json 里的项**灰掉**并在描述里写"pi 自己的凭据，本扩展不动"。
  3. 二次确认（模态）："将从 VS Code SecretStorage 删除 N 个 provider 的 key；pi 的 auth.json 不受影响"。
  4. 逐个 `removeApiKey` + `runtime.removeRuntimeApiKey(providerId)`（**不用 `logout`**，F6）。
  5. 结束提示里给一句"要让 pi CLI 也忘掉，请用它自己的方式（`auth.json`）"。
- 保留一个断言：**清理后 `auth.json` 的字节与 mtime 都不变**（C2）。

### 3.3 `Pi: Set API Key` 补完：provider 选择与校验

- **候选来源**改掉硬编码（F15）：`runtime.getProviders()` → `{ id, name }`（`createProvider` 里 `name: input.name ?? input.id`）。`DEFAULT_PROVIDER = "deepseek"` 仍置顶；找不到时退回首项。
- **标注已配置**：`runtime.getProviderAuthStatus(id).source` → `runtime`（面板存的）/ `stored`（auth.json）/ `environment`（环境变量）。
- **校验（全部本地、不发请求）**：
  1. provider 必须在 pi 认识的列表里 → 不在就警告"pi 不认识这个 provider，模型列表可能是空的"，但**允许**继续（用户可能在 models.json 里自定义了 provider）；
  2. 保存并注入后 `await runtime.checkAuth(providerId)` → 有结果才算"配好了"；
  3. `await runtime.getAvailable(providerId)` → 空则提示"pi 的目录里这个 provider 没有可用模型"（可能 provider id 拼错、或 models.json 里没有它）。
- **不做**"真发一条请求验证 key"（Q3）：会花用户的钱、发用户的数据。

### 3.4 代理：第一层验证掉，第二层待定（Q2）

- **第一层（默认路径，零代码）**：VS Code 自身的 `http.proxy` / `http.proxySupport` / `http.fetchAdditionalSupport` / `http.systemCertificates`。PLAN §5.3 断言"它们已注入扩展宿主的 `http`/`https` 与全局 `fetch`" —— **这条至今没有被验证过**（S1 的 T4 在受限机上直连成功，代理路径根本没被走到）。
  S6 的便宜做法：加一个**自测项 T13（advisory）**，在真实宿主里报告三件事：`globalThis.fetch` 是不是被替换过（比较 `fetch.toString()` 与 Node 原生形态 / 与 `process.versions` 对照）、`vscode.workspace.getConfiguration("http").get("proxy")` 的值、`process.env.HTTP_PROXY/HTTPS_PROXY` 是否被设过。**只报告不判定**（不 PASS/FAIL），避免把"我读不懂的身份"变成假失败。用户真配了代理时才有人能对着这行判断。
- **第二层（要做就见 PLAN §5.3，工作量与验收都在那儿）**：扩展自带 undici（与 pi 同版本 8.9.0 —— pi 的 dependencies 里就是它）包装 `globalThis.fetch`。
  **我的建议：S6 不做，延期**（Q2）。三条理由：
  1. 现在**没有任何人需要它**：我这台与受限机都是直连（S1 T4 通过）；
  2. 它的验收要求（宿主网络回归：Marketplace 搜索、另一个联网扩展、全局 `Request` 输入、`http.proxyStrictSSL`…）与"Mac ≤2 人工项"预算直接冲突；
  3. 它引入一份依赖 + 一个全局副作用 + 一层永远可能被别的扩展打乱的 fetch 包装，而收益只在"VS Code 的 http.proxy 不够用"这一种场景。
  **不做的同时必须做对**：`jerrypi.proxy` 在 `contributes.configuration` 里的描述里写明"**尚未实现**"，README 配置表与已知限制同步（今天审计刚把它们改成"尚未生效（S6）"，Q2 若选"不做"就再改成"尚未实现（未排期）"）。

### 3.5 `Pi: Refresh Model Catalog`

`runtime.refresh({ allowNetwork: true })` → 结果映射成一句人话："已刷新 N 个 provider（M 个模型）"；`refresh` 返回 `{ aborted, errors: Map }`，把 errors 里每个 provider 的 message 记进 Output。
不变式：**默认仍然不联网**（`create({ allowModelNetwork: false })` 不动）—— 只有用户点这个命令才发请求。

### 3.6 `Pi: Open Settings File`

目标文件 = `<生效 agentDir>/settings.json`（现状已经走 `module.getAgentDir()`，F15）。S6 只补两条：
- 断言它**跟着 `jerrypi.agentDir` 走**（C3 的一部分）；
- 文件不存在时仍创建 `{}`（用户点了才创建，属于用户动作），并在 Output 记一行。

### 3.7 R10（`filterCwd` 的严格比较）：接受，不绕

自定义 agentDir 后 pi 的 `list()` 会带 `filterCwd = true` → 严格比较会话头里的 cwd。**我们自己的会话不会不匹配**：header 的 cwd 就是我们传进去的那个字符串，两边同源。
风险窗口只剩"**CLI 用另一种盘符大小写写的会话**"（Windows + 装了 pi 的机器）—— 那台受限机**没有 pi**，所以现实里没有受害者。**结论：接受**；已记进 README 已知限制与 `docs/pi-traps.md` 第 18 条，S6 不再加代码。

## 4. 决策与默认值（Q1–Q8，等用户拍板）

| # | 问题 | 默认（我的建议） | 备选 |
| --- | --- | --- | --- |
| Q1 | `jerrypi.agentDir` 怎么生效 | **设进程环境变量 + 提示重载窗口**；环境变量已设时不覆盖 | 不提供这个设置（只承认 `PI_CODING_AGENT_DIR`） |
| Q2 | `jerrypi.proxy` 第 2 层（自带 undici）做不做 | **不做**，只标"尚未实现"；第 1 层加一条 advisory 自测项 | 做（照 PLAN §5.3 全套要求，含宿主网络回归） |
| Q3 | `Pi: Set API Key` 的校验强度 | **只本地判定**（checkAuth + getAvailable），不发请求 | 真发一条最小请求 |
| Q4 | `Pi: Clear Stored API Keys` 是否帮忙清 auth.json | **不碰**，灰掉并说明 | 提供"连 auth.json 一起清"（会动用户数据） |
| Q5 | `Pi: Refresh Model Catalog` 做不做 | **做**（点了才联网） | 不做，维持"复制 models-store.json"的土办法 |
| Q6 | `jerrypi.approvalMode` 登记方式 | **登记 + 描述写明"尚未生效（S8）"** | 不登记，等 S8 一起 |
| Q7 | agentDir 变更后的提示 | **信息消息 + 「重载窗口」按钮**（不强制） | 模态强制 / 不提示 |
| Q8 | agentDir 的路径校验 | **存在性 + 是目录**（不存在时警告但允许，因为它会被自动创建） | 不校验 |

## 5. 风险

| # | 风险 | 处置 |
| --- | --- | --- |
| R-S6-1 | 设 `PI_CODING_AGENT_DIR` 是**进程级**副作用，会影响同宿主里其他扩展（以及另一个 pi 类扩展） | 设置描述与 README 写明；只在环境变量未设时写；提供"留空 = 用默认" |
| R-S6-2 | 用户把 agentDir 指到一个**空目录** → 面板"什么都没有"（无 key、无会话、无模型），看起来像坏了 | 提示文案里带上**生效目录的绝对路径**（Output + 设置描述）；`Pi: Set API Key` 之后仍无模型时，提示里点出目录 |
| R-S6-3 | 用户把 agentDir 指到**已有**目录 → 旧会话"看不到"（与 S5 的旧位置同族） | README 已知限制加一句；给"恢复命令"式的指引 |
| R-S6-4 | `Pi: Clear Stored API Keys` 误删 | 只列我们存的（auth.json 项灰掉）+ 二次确认 + 断言"auth.json 字节不变" |
| R-S6-5 | 重载窗口提示被忽略 → 用户以为设置没生效 | 提示里说清"改了 agentDir 需要重载窗口"；Output 里每次激活都打一行实际生效的 agentDir（现状已有：`[controller] … agentDir=…`） |

## 6. 检查清单（自动断言，先红后绿）

| # | 断言 | 脚本 | 对应判据 |
| --- | --- | --- | --- |
| A1 | `package.json` 声明了三项设置，`jerrypi.agentDir` 的默认值/描述/`scope` 与计划一致 | 新 `scripts/settings-check.mjs`（静态读 package.json + 与 `src/host/config.ts` 的常量对照） | — |
| A2 | `applyAgentDirSetting()`：没设过环境变量 → 写入；已设过 → **不覆盖**；设置为空 → 不写 | `host-check`（vscode 桩提供 `getConfiguration`） | C3 |
| A3 | 变更 `jerrypi.agentDir` → 恰好弹一次"需要重载"的信息消息，且带「重载窗口」按钮 | `host-check`（桩记录 `showInformationMessage` 的 items） | — |
| A4 | **空凭据目录也能对话**（C1）：临时 agentDir（无 auth.json、models.json 无 key）+ SecretStorage 里有 key → 一轮真实对话成功 | `controller-check`（真模型） | **C1** |
| A5 | **C2**：`clearStoredApiKeys` 之后 `listProviders()` 为空、`getAvailable()` 为空，且 **auth.json 的 sha256 与 mtime 未变** | `controller-check` + `host-check` | **C2** |
| A6 | `Pi: Set API Key` 的候选来自 `getProviders()`（不是硬编码），已配置的带来源标注 | `host-check`（桩记录 QuickPick 的 items） | — |
| A7 | 校验三态：`checkAuth` 有结果 / 无结果 / `getAvailable` 为空 → 三种提示文案 | `host-check` | — |
| A8 | `Pi: Refresh Model Catalog` 调 `refresh({ allowNetwork: true })`，一次调用、结果文案含 provider 数与错误数 | `host-check` | — |
| A9 | `Pi: Open Settings File` 打开的是 `<生效 agentDir>/settings.json` | `host-check` | C3 |
| A10 | 协议/文档同步：README 中英双语里三项设置的"生效状态"与 `package.json` 描述一致 | `scripts/readme-check`（若有）/ 人工核对 | — |
| A11 | T13（advisory）：报告 fetch 身份、`http.proxy` 值、`HTTP(S)_PROXY` 是否设过 —— **只报告不判定** | `src/pi/selftest.ts` | §3.4 |

**"先红"怎么写**：A1–A3、A6–A9 全部在 `host-check` 的 vscode 桩上加能力（`getConfiguration`、`onDidChangeConfiguration`、记录消息）——**先让它们红**，红的原因是"断言失败"而不是"编译错"。

## 7. 人工验收（Mac，**2 个动作**，一次 F5 会话里做完）

| # | 动作 | 属于哪一类 | 为什么自动化不了 |
| --- | --- | --- | --- |
| M1 | F5 起调试宿主 → 改 `jerrypi.agentDir`（指到一个临时空目录）→ 按提示**重载窗口** → 确认 Output 里那行 `agentDir=` 变了、面板能发一条消息 → 再改回默认 → 重载 → 会话还在 | **③真进程** | ①"重载窗口"是 VS Code 的生命周期，无头环境没有；②进程环境变量只在真实宿主里才有意义；③"设置改了之后 pi 到底用哪个目录"这件事，只有在真宿主里才成立 |
| M2 | 外观/文案：`Pi: Set API Key` 的 provider 列表（含"已配置"标注）、`Pi: Clear Stored API Keys` 的多选 + 二次确认（中英混排、按钮文字）、以及设置页里三项设置的**描述文字** | **①排版/外观** | 原生 QuickPick / 模态框的渲染是 VS Code 的画，我们的桩只能验参数（items 内容、modal=true），渲染与换行验不了 |

- 两条都在**同一次 F5** 里做完，加起来约 3 分钟。
- 合并记录方式：M1 的 Output 行贴给我；M2 只要一句"文案 OK / 哪里别扭"。
- **不新增** Windows 的人工项（Windows 照 §8 的两项老流程走）。

## 8. Windows 项（不新增，沿用 W0/W1）

| # | 动作 | 属于哪一类 | 说明 |
| --- | --- | --- | --- |
| W0 | 0.1.8 装上后跑 `Pi: Run Self-Test`，把结果贴回来 | **④Windows 路径与 shell** | 期望仍是 `GATE PASS`（T12 会 SKIP，那台机器没有 pi）；T13 是 advisory，会多一行 fetch 身份的报告 |
| W1 | 重启 VS Code → 确认面板仍自动接过上一会话、会话列表能选 | **③真进程** | S6 动了 agentDir 的生效方式，重启路径必须自证没坏 |

**⚠️ 明确要求用户不要做**：在那台机器上改 `jerrypi.agentDir`（会把他们的会话指向空目录）。

## 9. 步骤（每步单独提交 + 门禁全绿）

1. **设置声明 + 读取层**：`package.json` 的 `contributes.configuration`；新建 `src/host/config.ts`（读取与校验）；`host-check` 加 `getConfiguration`/`onDidChangeConfiguration` 桩 + A1/A2/A3 先红后绿。
2. **agentDir 贯通**：`activate()` 最开头应用；runtime/commands/sessions 全部走生效值；变更提示重载。断言 A9。
3. **密钥清理**：`ApiKeyStore.removeApiKey` + `clearStoredApiKeys` + `Pi: Clear Stored API Keys`（含灰掉 auth.json 项）。断言 A5（**含 auth.json 字节不变**）。
4. **`Pi: Set API Key` 补完**：provider 来自 pi、已配置标注、三态校验。断言 A6/A7。
5. **空凭据目录也能对话**：断言 A4（真模型，controller-check）。
6. **`Pi: Refresh Model Catalog`**（按 Q5）。断言 A8。
7. **代理**：按 Q2 —— 要么只加 T13 + 诚实标注，要么照 PLAN §5.3 做第 2 层。
8. **文档**：README 中英双语（配置表定稿 + 已知限制）、`docs/PLAN.md` §6 的 S6 状态、`docs/pi-traps.md`（`RuntimeCredentials.delete()` 那个陷阱）、`docs/STATUS.md`。
9. **打包 + 自测 + Mac 验收（M1/M2，2 个动作）**。
10. **发 0.1.8 → Windows W0/W1 → 回填 §12 → 关阶段**。

## 10. 评审记录

_（三轮评审写在这里；评审后的改动记在 §10.1 并标"未经复核"。）_

## 11. 实施期发现

_（实施时遇到的、计划里没预料到的东西写在这里。）_

## 12. 实施与验收结果

_（自动检查 / 提交切分 / 人工验收 / 已知未覆盖。）_

## 13. 待用户拍板

见 §4 的 Q1–Q8。**默认值都是我的建议**；用户说"可以"之后才动代码（S5 的规矩）。
