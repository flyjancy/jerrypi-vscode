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
| F3 | 另有 `PI_CODING_AGENT_SESSION_DIR`（`ENV_SESSION_DIR`）：**`getSessionsDir()` 根本不读它** —— 全 dist 里只有 `main.js:531`（CLI 启动路径）与 `cli/args.js:422`（帮助文本）引用它。所以「我们刻意不跟随」的准确说法是：**SDK 路径想跟随还得自己实现**。（S5 的 R9 会在 Output 记一行诊断） | `grep -rn ENV_SESSION_DIR dist/` → 只有 `config.js:407`（定义）、`main.js:531`、`cli/args.js:422`；`docs/S5-plan.md` §11 的 R9 |

**⇒ 结论**：想让 `jerrypi.agentDir` 生效，正确做法是**在扩展激活的最开头、任何 `loadPi()` 之前设 `process.env.PI_CODING_AGENT_DIR`**。这是**进程级**副作用（扩展宿主是共享进程），必须写进设置描述与 README。

**⇒ 但"改了设置就生效"做不到**：`ModelRuntime` 被我们按 agentDir 缓存（`src/pi/runtime.ts` 的 `runtimes` Map），pi 模块内部也在首次 import 时就建立了与目录相关的状态（settings-manager、extensions loader、models-store）。所以 S6 的答案是**重载窗口**，不是热切换（见 §3.1、Q1）。

### 0.2 API key：存在哪、优先级、能删什么

| # | 事实 | 证据 |
| --- | --- | --- |
| F4 | key 的解析优先级：**runtime 覆盖（内存）→ auth.json（stored）→ provider 自带的 configured → 环境变量** | `dist/core/model-runtime.js` 的 `getProviderAuthStatus()`：`hasRuntimeApiKey` → `snapshot.storedProviders` → `configuredRequestAuthStatus` → `snapshot.auth` |
| F5 | `RuntimeCredentials` 是**纯内存覆盖层**（文件头注释原话："Async credential store overlay for **non-persistent** runtime API keys"）：`setRuntimeApiKey`/`removeRuntimeApiKey` 只动一个 `Map`；`read()` 覆盖优先；`list()` 把覆盖项与底层合并 | `dist/core/runtime-credentials.js` 全文 |
| F6 | ⚠️ **`RuntimeCredentials.delete()` 会去删底层（auth.json）里的凭据** —— 也就是 `ModelRuntime.logout()` 会**动用户的 auth.json** | 同文件：`async delete(providerId, options) { await this.store.delete(...); this.overrides.delete(...) }` |
| F7 | `ModelRuntime.create()` 接受 `authPath` / `modelsPath` / `modelsStorePath` / `allowModelNetwork` 等；我们**已经显式传了三个路径**（S5 之前的决定） | `dist/core/model-runtime.d.ts` 的 `CreateModelRuntimeOptions`；`src/pi/runtime.ts` 的 `createModelRuntime()` |
| F8 | ⚠️ **修正（评审 B5 指出，已复核）**：`refresh()` 的默认值是 `options.allowNetwork ?? **this.modelNetworkEnabled**`（`model-runtime.js:517`），而 `modelNetworkEnabled = process.env.PI_OFFLINE === undefined`（`:88` 的构造）—— **与 `create({ allowModelNetwork: false })` 无关**（后者只在 `:91` 决定「创建期那一次 refresh 要不要联网」）。也就是说**我们的进程里 `modelNetworkEnabled === true`**：任何不带参数的 `refresh()` 都会联网。今天它不联网，只是因为 pi 内部每个调用点都显式传了 `false`（`:381/:556/:592/:599`）—— **一个会漂移的内部细节**。 | 上面每条都带行号 |

**⇒ 结论**：`Pi: Clear Stored API Keys` **必须**用 `removeRuntimeApiKey()` / SecretStorage.delete，**绝不能用 `logout()`**（那会删掉用户 auth.json 里的凭据 —— 违反"不替用户动 `~/.pi/agent`"）。这条要进 `docs/pi-traps.md`。

### 0.3 代理：为什么它是"两层"的

| # | 事实 | 证据 |
| --- | --- | --- |
| F9 | pi 的代理能力在 `dist/core/http-dispatcher.js`：`configureHttpDispatcher()` 装 undici `EnvHttpProxyAgent` 并**替换 `globalThis.fetch`**（`undici.install()`），另有 `applyHttpProxySettings(httpProxy)` 走 `process.env.HTTP_PROXY ??= proxy` | 同文件；`HTTP_IDLE_TIMEOUT_*` 也在那儿 |
| F10 | 它**只被 CLI / TUI / rpc-entry 调用**，SDK 路径不会自动调用。精确调用点（`grep -rn "configureHttpDispatcher()" dist/`）：`rpc-entry.js:9`、`cli/setup.js:10`、`main.js:456`；另有三处**带参数**的：`main.js:686`、`interactive-mode.js:1480`、`:3854`（合计 3 处无参 + 3 处带参 = 6） | 上面的 grep（评审 N1 说「没有 cli/setup.js」—— 我自己复核为**它漏了**：`cli/setup.js:10` 确实在） |
| F11 | 而且**拿不到**：包的 `exports` 只有 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`（**没有** http-dispatcher 子路径）；我们 ship 的 `pi-runtime/dist/bundle/index.js` 里 `configureHttpDispatcher` 出现 **0 次** | `node_modules/@earendil-works/pi-coding-agent/package.json` 的 `exports`；`grep -c` 结果 |
| F12 | ⚠️ **推翻并重写（评审 B1 指出，已用干净环境复核）**：`NODE_USE_ENV_PROXY=1`（以及 `--use-env-proxy`）**确实让 Node 的 fetch 走环境变量代理** —— 但它**只在进程启动前设才有效**。实测（`env -u` 清掉全部代理变量；用**不存在的域名**做判别，这样「走了代理」与「没走代理」必然给出不同的错误码）：<br>· 启动前 `NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:1` → **ECONNREFUSED**（走了代理）<br>· 不带那个变量、只设 `HTTP_PROXY=…:1` → **ENOTFOUND**（没走代理）<br>· **进程内**（fetch 之前）再设 `NODE_USE_ENV_PROXY=1` → **ENOTFOUND**（太晚）<br>⇒ 扩展在 `activate()` 里设它**没用**（与 `PI_CODING_AGENT_DIR` 相反 —— 后者 pi 每次调用都现读）。`node:undici` 不存在。<br>**我第一版的错误**：拿「死端口 proxy 仍返回 200」当「没走代理」，而那 200 是**经过我自己 shell 里的小写 `http_proxy=http://127.0.0.1:7897` 真代理**回来的（`env \| grep -i proxy` 可见）。教训见 §10 的 L1 | 上面三条命令；`env \| grep -i proxy`；另：清空代理变量后直连 `https://example.com` → 200（所以「本机不需要代理也能通」这个前提**成立**，评审那句「这台机器不是直连」不成立） |

**⇒ 结论**：`jerrypi.proxy` 若要做，只有 PLAN §5.3 第 2 层那条路（**扩展自带 undici**，包装 `globalThis.fetch`）。PLAN §5.3 已经写好了那一层的全套要求（不调 `undici.install()`、不动 `Request/Response/Headers/WebSocket`、只管字符串与 `URL` 输入、恢复语义、`ProxyAgent.close()`、**宿主网络回归验收**）。
**⇒ 但代价**：一份 undici 依赖 + 一个全局副作用 + 一条"宿主网络回归"的人工验收 —— 与我们"Mac ≤2"的预算直接冲突（见 Q2）。

### 0.4 现状：今天这套代码是什么样

| # | 事实 | 证据 |
| --- | --- | --- |
| F13 | `package.json` **没有** `contributes.configuration` —— 三项设置**从来没有被声明过**，`src/` 里也没有任何 `getConfiguration()` 调用。也就是说 `jerrypi.agentDir` / `jerrypi.proxy` / `jerrypi.approvalMode` 今天**写了完全不生效** | 审计见提交 `d63d242`；`python3 -c "json.load(open('package.json'))['contributes'].keys()"` → `commands/viewsContainers/views` |
| F14 | 现有 key 链路：`src/pi/runtime.ts` 的 `ApiKeyStore`（SecretStorage + globalState 里的 provider 列表）、`getModelRuntime()` 按 agentDir 缓存、`createModelRuntime()` 显式传三个路径并在创建时注入、`injectApiKey()` 立刻给已缓存实例注入。**缺 `removeApiKey`** | `src/pi/runtime.ts` |
| F15 | 现有命令：`Pi: Set API Key`（候选列表是**硬编码常量** `SUGGESTED_PROVIDERS`，位于 `src/pi/runtime.ts:24-32`；`src/commands.ts:64-73` 只是使用者；**没有任何校验**）、`Pi: Open Settings File`（用 `module.getAgentDir()`；**目录不存在时先 `createDirectory` 再写 `{}`**，见 `src/commands.ts:148-151`） | `src/pi/runtime.ts` · `src/commands.ts` |
| F16 | ⚠️ **修正（评审 S2 指出，已复核）**：`RuntimeCredentials.list()` **区分不出来源** —— 它先把底层（auth.json）条目读出来，再用 `entries.set(providerId, { providerId, type: "api_key" })` **覆盖同名项**：两种来源出来都是 `{ providerId, type }`，同名 provider 只剩一条。⇒「这个 key 是我们存的还是 auth.json 里的」**必须问 `getProviderAuthStatus(id).source`（`runtime` vs `stored`）或 `credentials.hasRuntimeApiKey(id)`**，不能用 `listCredentials()` | `dist/core/runtime-credentials.js` 的 `list()` |
| F18 | **`AuthStatus.source` 有 6 档**，不是 3 档：`runtime` / `stored`（`model-runtime.js:412-413`）+ `models_json_command` / `environment`（带 label）/ `fallback` / **`models_json_key`**（`provider-composer.js:388-401` 的 `configuredRequestAuthStatus()`）。**验收判据里说的「`models.json` 里的 key」就是 `models_json_key` 这一档** | 上面两个文件的行号 |
| F19 | 本机 `~/.pi/agent/models.json` **存在**（1816 字节、JSONC、带中文注释的自定义模型定义），但里面**没有任何 `apiKey`/`token`/`secret` 字段**；凭据在 `auth.json`（`deepseek: api_key`，95 字节）。⇒ 判据那句「清空 `models.json` 里的 key」按字面**今天就已经满足**，所以 C1 必须比字面更强才有意义（见 §1）；另：评审第 1 轮说「models.json 根本不存在」是**它自己核错了** | `grep -ciE "apikey\|token\|secret" ~/.pi/agent/models.json` → **1**（唯一那处命中是第 2 行注释里的"每百万 token"）＋ `ls -la ~/.pi/agent/`。**注意**：我这里原来写的那条 `grep -o '"\"[a-zA-Z]*[Kk]ey…"\"'` **没有鉴别力**（无论文件里有没有 key 都是空）—— 评审第 3 轮 N1 抓到的，正是 L1 那条纪律的 grep 版 |
| F17 | `dist/core/session-manager.js` 的 `sessionCwdMatches()` 是**严格字符串比较**；自定义 agentDir 会让 `list(cwd, sessionDir)` 走 `filterCwd = true` 那条路（S5 的 R10） | `docs/S5-plan.md` R10 · §12.3（W0 实测同一台 Windows 上存在 `c:\…` 与 `C:\…` 两种写法） |

## 1. 目标与判据

**目标**（PLAN §6 原文）：三项 VS Code 设置、`Pi: Clear Stored API Keys`，并把 S1 的最小版 `Pi: Set API Key` / `Pi: Open Settings File` 补完整（provider 选择、校验）。

**判据**（PLAN 原文）：清空 `models.json` 里的 key、只靠 SecretStorage 也能完成对话。

把它拆成**可自动断言**的三条（§6 逐条对应）：

1. **C1**：一个**没有任何凭据来源**的临时 agentDir —— `models.json` 里**有 provider 但没有 `apiKey`**、**没有 `auth.json`**、**子进程里清掉 `*_API_KEY`/`*_TOKEN` 之类环境变量** —— 只要 SecretStorage 里有 key，就能完成一轮真实对话，**且这条凭据的来源被判定为 `runtime`**（`getProviderAuthStatus(id).source === "runtime"`）。
   *（评审 B2/B4 的修正：只说「能对话」证明不了 key 来自 SecretStorage —— `getProviderAuthStatus` 还有 `environment` 一档，`getAvailable()` 把环境变量凭据也算「已配置」；所以必须断言来源。夹具放一份「有 provider 无 key」的 `models.json` 是为了挡住 `models_json_key` 那一档。）*
2. **C2**：`Pi: Clear Stored API Keys` 之后：① 我们存的 provider 列表（SecretStorage + globalState 名单）为空；② 该 provider 的 `getProviderAuthStatus().source !== "runtime"`；③ **夹具里预置的那份 `auth.json`（内容里就包含同一个 provider 的凭据）的 sha256 与 mtime 一个字节没变**。
   *（评审 B2/B3 的修正：「`getAvailable()` 为空」会被环境变量凭据弄成**永远红**；在「本来就没有 auth.json」的夹具上断言「auth.json 没变」是**恒真空断言**。评审第 2 轮 B1 又指出一处更细的：② 不能写成 `configured === false` —— 夹具的 auth.json 里既然放了同一个 provider，清除内存覆盖层之后 `getProviderAuthStatus` 会**回落到 `stored` 档**（`removeRuntimeApiKey` → `synchronizeCredentialState` → `read()` 回落 auth.json → `storedProviders.add`，见 `model-runtime.js:221/:240/:414`），那时 `configured` 又变回 `true`。**精确的表达是「不再有 `runtime` 来源」**。顺带记清口径：清完之后用户**仍然能靠 auth.json 里的凭据对话** —— 那是正确行为，不是回归。）*
3. **C3**：`jerrypi.agentDir` 指向别的目录时，**会话、模型、设置三条链路都在新目录上**（不是只有一条跟着走），且 Output 里那行 `agentDir=` **注明来源**（环境变量 / 设置 / 默认）。
   *（评审第 2 轮 S1：这条声称三条链路，§6 原本只断言了一条 —— A2 只看环境变量写没写、A9 只看 settings.json 的路径。现在补 A13（会话文件落在新目录下）与 A14（**runtime 读的是新目录那份 auth.json**）。<br>**第 3 轮 B1 修正**：A14 原写成"写一把 key → `<temp>/auth.json` 出现" —— 那在本设计下**永远不可能绿**（`setRuntimeApiKey` 是纯内存，F5；auth.json 只在写路径被创建，`auth-storage.js:59/:119`；而 §3.2 第一条 + Q4 明说"不写 auth.json"）。评审第 2 轮 S1 的原话是"凭据落点是 `<temp>/auth.json`"，我忠实转写了 —— **错在评审给的改法本身**。现在改成"证明它读的是新目录那份"，这才是"凭据链路跟着 agentDir 走"的可观察形式。）*

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
       记一行日志：agentDir=<生效值>（来源：环境变量 / 设置 / 默认）      // ← 评审 S3
  └─ 之后所有 loadPi() / getModelRuntime() / workspace 逻辑不变（它们都问 pi.getAgentDir()）
```

三个刻意的选择：

1. **`??=` 语义（环境变量优先）**：用户若在 shell 里设过 `PI_CODING_AGENT_DIR`，我们**不覆盖**它。理由：那是用户对"整台机器上的 pi"的显式选择，VS Code 设置是更窄的一层；而且 pi 自己的 `applyHttpProxySettings` 用的就是同一个 `??=` 惯用法（F9）。
2. **重载窗口而不是热切换**：agentDir 变了要重建的东西太多（我们的 runtime 缓存、pi 模块内的 settings-manager/models-store/extensions loader），热切换一定会出现"半新半旧"的劈叉。做法：`onDidChangeConfiguration` 命中 `jerrypi.agentDir` 时弹一条**信息**消息，附「重载窗口」按钮（`workbench.action.reloadWindow`）—— 不强制、不静默。
3. **`activate()` 里第一位**：`loadPi()` 是动态 `import()`，pi 模块级状态在**第一次 import** 时建立；我们必须在它之前设好环境变量。

4. **三项设置的 `scope` 全部定死为 `machine`**（评审 S1 + 第 2 轮 B3）—— 默认 scope 允许 **`.vscode/settings.json` 覆盖**：
   - `agentDir` / `proxy`：任意仓库都能把扩展的配置目录指到它选的地方（会话、auth.json、models.json 全跟着走）；
   - **`approvalMode` 更危险**：S8 落地后，克隆下来的仓库只要带一份 `.vscode/settings.json` 就能把工具审批设成 `off` —— 那是"不问就执行"，比换个读写位置重一个量级。**而且 scope 发布后再改是破坏性变更**（用户已写的设置会失效），所以必须现在定。
   - 顺带：`package.json` 的 `capabilities.untrustedWorkspaces` **至今没有声明**（`node -p "require('./package.json').capabilities"` → `undefined`），同一类姿态问题，一起进 Q9。

**为什么这条不能省人工验收**：环境变量的进程级效果 + 重载窗口是真实 VS Code 生命周期，无头环境里两者都没有。见 §7 的 M1。
**为什么日志要带来源**（评审 S3）：用户看到"改了设置但目录没变"时，无法自己判断是"没重载"还是"被环境变量压住了"；M1 的判据也依赖这一行。

### 3.2 密钥：存、注入、清

- 存：**只** SecretStorage（`jerrypi.apiKey.<providerId>`）+ globalState 里一份 provider 名单（SecretStorage 不能枚举）。**不写 auth.json**（S1 的决定，S6 保持）。
- 注入：`createModelRuntime()` 创建时注入 + `injectApiKey()` 立刻注入已缓存实例（现状，F14）。
- 清：新增 `ApiKeyStore.removeApiKey(providerId)`（`secrets.delete` + 从 globalState 名单移除）+ 命令 `Pi: Clear Stored API Keys`：
  1. 列出 `keys.listProviders()`（我们存过的那份名单），**来源判定问 `runtime.getProviderAuthStatus(id).source`**：`runtime` = 面板存的（可勾）；`stored` = auth.json 里的（灰掉）；`models_json_key`/`models_json_command`/`fallback`/`environment` = pi 的配置或环境（灰掉，各写一句说明）。⚠️ **不能用 `listCredentials()` 判来源** —— 它把两种来源合并成同一条 `{providerId, type}`（F16，评审 S2）。
  2. 灰掉的项在描述里写清"这是 pi 自己的凭据（auth.json / models.json / 环境变量），本扩展不动"。
  3. 二次确认（模态）："将从 VS Code SecretStorage 删除 N 个 provider 的 key；**当前会话将无法继续发送，直到重新设置 key**（pi 的 auth.json / models.json 不受影响）"。 ← 评审 S4：清 key 是**立即生效**的内存操作，正在开着的会话下一条消息就会失败，文案必须说。
  4. 逐个清（**不用 `logout`**，F6），每个 provider **单独 try/catch**：先 `runtime.removeRuntimeApiKey(providerId)`（成功才继续），再 `keys.removeApiKey(providerId)`（删 SecretStorage + 名单）。反过来的话，一旦 `removeRuntimeApiKey` 抛出（它内部会走 `synchronizeCredentialState`，失败时包成 `CredentialSynchronizationError`，`model-runtime.js:401-406` / `:374-392`），就会出现"SecretStorage 已删、内存里那把 key 还在"的夹生状态。末尾汇总"成功 N 个、失败 M 个（各自原因）"（评审第 2 轮 S3）。
  5. 结束提示里给一句"要让 pi CLI 也忘掉，请用它自己的方式（`auth.json`）"。
- 保留一个断言：**清理后 `auth.json` 的字节与 mtime 都不变**（C2）。

### 3.3 `Pi: Set API Key` 补完：provider 选择与校验

- **候选来源**改掉硬编码（F15）：`runtime.getProviders()` → `{ id, name }`（`createProvider` 里 `name: input.name ?? input.id`）。`DEFAULT_PROVIDER = "deepseek"` 仍置顶；找不到时退回首项。
- **标注已配置**：`runtime.getProviderAuthStatus(id).source` —— 完整 6 档都要有文案（F18）：`runtime`（面板存的）/ `stored`（auth.json）/ `models_json_key`（models.json 里写的）/ `models_json_command`（models.json 里配的命令）/ `fallback` / `environment`（环境变量，带变量名 label）。后四档统一归成"pi 侧配的凭据，本扩展不动"但**保留各自的说法**（用户排查时这四个词能救命）。
- **校验（全部本地、不发请求）**：
  1. provider 必须在 pi 认识的列表里 → 不在就警告"pi 不认识这个 provider，模型列表可能是空的"，但**允许**继续（用户可能在 models.json 里自定义了 provider）；
  2. 保存并注入后 `await runtime.checkAuth(providerId)` → 有结果才算"配好了"；
  3. `await runtime.getAvailable(providerId)` → 空则提示"pi 的目录里这个 provider 没有可用模型"（可能 provider id 拼错、或 models.json 里没有它）。
- **不做**"真发一条请求验证 key"（Q3）：会花用户的钱、发用户的数据。

### 3.4 代理：第一层验证掉，第二层待定（Q2）

- **第一层（默认路径，零代码）**：VS Code 自身的 `http.proxy` / `http.proxySupport` / `http.fetchAdditionalSupport` / `http.systemCertificates`。PLAN §5.3 断言"它们已注入扩展宿主的 `http`/`https` 与全局 `fetch`" —— **这条至今没有被验证过**（S1 的 T4 在受限机上直连成功，代理路径根本没被走到）。
  S6 的便宜做法：加一个**自测项 T13（advisory）**，在真实宿主里报告三件事（判据按评审 N4 改成可判定的三元组）：① `globalThis.fetch.toString().includes("[native code]")`（VS Code 的 `http.proxySupport: override` 会把它换成普通函数）；② `vscode.workspace.getConfiguration("http").get("proxySupport")` 与 `get("proxy")` 的值；③ `process.env.HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy` 是否存在（**只报存在性，不打印值**）。**只报告不判定**（不 PASS/FAIL），避免把"我读不懂的身份"变成假失败。
- **第二层（要做就见 PLAN §5.3，工作量与验收都在那儿）**：扩展自带 undici（与 pi 同版本 8.9.0 —— pi 的 dependencies 里就是它）包装 `globalThis.fetch`。
  **我的建议：S6 不做，延期**（Q2）。四条理由（**评审 B1 之后重写** —— 原来第一条是拿一条错事实撑着的）：
  0. **有一条零成本的替代方案先写进 README**：在**启动 VS Code 之前**设 `NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY`，"整进程"的 fetch 就会走环境变量代理（实测有效，F12）。这条治不了"用户想只给 jerrypi 设代理"，但能治"企业网必须走代理"这一类，代价是零。
  1. 现在**没有已知需求**：我这台与受限机都不需要代理也能通（S1 T4 通过；本轮实测清空代理变量后直连 `https://example.com` 仍是 200）—— 注意这与"本机配了代理"不矛盾（`env｜grep -i proxy` 有 `http_proxy=127.0.0.1:7897`，但直连也通）；
  2. 它的验收要求（宿主网络回归：Marketplace 搜索、另一个联网扩展、全局 `Request` 输入、`http.proxyStrictSSL`…）与"Mac ≤2 人工项"预算直接冲突；
  3. 它引入一份依赖 + 一个全局副作用 + 一层永远可能被别的扩展打乱的 fetch 包装，而收益只在"VS Code 的 http.proxy 不够用"这一种场景。
  **不做的同时必须做对**：`jerrypi.proxy` 在 `contributes.configuration` 里的描述里写明"**尚未实现**"，README 配置表与已知限制同步（今天审计刚把它们改成"尚未生效（S6）"，Q2 若选"不做"就再改成"尚未实现（未排期）"）。

### 3.5 `Pi: Refresh Model Catalog`

`runtime.refresh({ allowNetwork: true })` → 结果映射成一句人话："已刷新 N 个 provider（M 个模型）"；`refresh` 返回 `{ aborted, errors: Map }`，把 errors 里每个 provider 的 message 记进 Output。

不变式：**只有用户点这个命令才发请求**。但按 F8 的修正，这条不变式**不是**被 `create({ allowModelNetwork: false })` 保证的 —— 它靠的是 pi 内部每个调用点都显式传 `allowNetwork: false`（`:381/:556/:592/:599`），一个会漂移的内部细节。⇒ 按 AGENTS.md §3「依赖上游就配一条漂移守卫」，守在哪很关键。**评审第 2 轮 B2 推翻了我的第一版**（包一层 `runtime.refresh` 计数）：那样包出来的断言几乎**恒真** —— pi 内部那三处 `this.refresh()`（`:556/:592/:599`）分别在 `registerNativeProvider` / `registerProvider` / `unregisterProvider` 里（已核行号），我们那条流程一步都走不到；`:381` 那处调的是 `this.models.refresh`（另一个对象）；而 `create()` 期那次刷新发生在实例交到我们手上之前。**一条恒真的守卫比没有守卫更糟**（它会让下一个人不再想这件事）。

正确的守卫在 **fetch 层**（目录刷新的真实出口是 `https://pi.dev`：`core/remote-catalog-provider.js:4` 的 `DEFAULT_CATALOG_BASE_URL`、`:67` 的 URL 构造、`:56` 的 `if (!context.allowNetwork || …) return`）：

- **正向**：在 `controller-check` 里包一层 `globalThis.fetch` 记录 host，跑一遍完整流程（建会话、发消息、切会话、换模型、清 key），断言**没有任何一次请求打到 `pi.dev`**（顺带把所有 host 记进输出，便于将来对照）；这条能同时覆盖 `create()` 期、`models.refresh` 与未来新增的路径。
- **反向**（证明探针是活的）：点 `Pi: Refresh Model Catalog` 之后**必须**有一次打到 `pi.dev`；可红验证 = 把该命令的 `allowNetwork` 改成 `false` → 这条变红。

另：`modelNetworkEnabled` 是 `private readonly`（`model-runtime.d.ts:44`），**读不到**，所以"记它的实际取值"这句删掉；要留痕就记 `process.env.PI_OFFLINE` 是否存在，并注明这是**推导值**（F8 的因果链：`modelNetworkEnabled = PI_OFFLINE === undefined`，`model-runtime.js:88`）。（评审第 2 轮 S4）

**文案的数据来源**（评审第 2 轮 N5）：`refresh()` 的返回只有 `{ aborted, errors }`（`model-runtime.d.ts` 的 `ModelsRefreshResult`），**不含任何计数** —— "已刷新 N 个 provider（M 个模型）"里的 N/M 要自己用 `getProviders()` / `getAvailableSnapshot()` 的前后差算出来。

### 3.6 `Pi: Open Settings File`

目标文件 = `<生效 agentDir>/settings.json`（现状已经走 `module.getAgentDir()`，F15）。S6 只补两条：
- 断言它**跟着 `jerrypi.agentDir` 走**（C3 的一部分）；
- 文件不存在时：**只在目标目录已存在**的情况下创建空的 `{}`；目录不存在就**报错并提示**，**不要替用户把目录建出来**（评审 N6：用户把设置拼错时，现状的 `createDirectory` 会替他创建一个拼错的目录；AGENTS.md §4 说"不替用户动 `~/.pi/agent` 下的数据"）。
- **「谁会在什么时候创建这个目录」要写进文案**（评审第 2 轮 S5：Q8 原来的理由「它会被自动创建」与上面这条打架）：创建它的是 **pi**，时机是**写第一个会话时**（`SessionManager` 构造函数里的 `mkdirSync(this.sessionDir, {recursive: true})`，`session-manager.js:603`。同文件的 `:251` 是 `getDefaultSessionDir()` 里的那处 —— 只有**省略** `sessionDir` 时才走，我们永远显式传，不走那条）。所以错误文案写成：「这个目录还不存在 —— 发一条消息后 pi 会建出来；如果这不是你要的路径，检查 `jerrypi.agentDir`」。

### 3.7 R10（`filterCwd` 的严格比较）：接受，不绕

自定义 agentDir 后 pi 的 `list()` 会带 `filterCwd = true` → 严格比较会话头里的 cwd。**我们自己的会话不会不匹配**：header 的 cwd 就是我们传进去的那个字符串，两边同源。
风险窗口只剩"**CLI 用另一种盘符大小写写的会话**"（Windows + 装了 pi 的机器）—— 那台受限机**没有 pi**，所以现实里没有受害者。**结论：接受**；已记进 README 已知限制与 `docs/pi-traps.md` 第 18 条，S6 不再加代码。

## 4. 决策与默认值（Q1–Q9，等用户拍板）

| # | 问题 | 默认（我的建议） | 备选 |
| --- | --- | --- | --- |
| Q1 | `jerrypi.agentDir` 怎么生效 | **设进程环境变量 + 提示重载窗口**；环境变量已设时不覆盖 | 不提供这个设置（只承认 `PI_CODING_AGENT_DIR`） |
| Q2 | `jerrypi.proxy` 第 2 层（自带 undici）做不做 | **不做**，只标"尚未实现"；第 1 层加一条 advisory 自测项；README 里补"启动 VS Code 前设 `NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY`"这条零成本方案 | 做（照 PLAN §5.3 全套要求，含宿主网络回归） |
| Q3 | `Pi: Set API Key` 的校验强度 | **只本地判定**（checkAuth + getAvailable），不发请求 | 真发一条最小请求 |
| Q4 | `Pi: Clear Stored API Keys` 是否帮忙清 auth.json | **不碰**，灰掉并说明 | 提供"连 auth.json 一起清"（会动用户数据） |
| Q5 | `Pi: Refresh Model Catalog` 做不做 | **做**（点了才联网） | 不做，维持"复制 models-store.json"的土办法 |
| Q6 | `jerrypi.approvalMode` 登记方式 | **登记 + 描述写明"尚未生效（S8）"** | 不登记，等 S8 一起 |
| Q7 | agentDir 变更后的提示 | **信息消息 + 「重载窗口」按钮**（不强制） | 模态强制 / 不提示 |
| Q8 | agentDir 的路径校验 | **存在性 + 是目录**（不存在时警告但允许 —— 创建它的是 **pi**，时机是**写第一个会话时**；在那之前我们不替用户建，见 §3.6） | 不校验 |
| Q9 | 三项设置的 `scope`（+ 要不要声明 `untrustedWorkspaces`） | **三项全用 `machine`**：`agentDir`/`proxy` 防止任意仓库把配置目录指走；**`approvalMode` 更要紧**（S8 之后克隆下来的仓库带一份 `.vscode/settings.json` 就能把工具审批关掉 = 不问就执行），而且 scope 发布后再改是破坏性变更。`capabilities.untrustedWorkspaces` 至今未声明，建议**一并声明**（受限工作区里不启用需要写盘的能力） | 全部用默认 scope / 暂不声明 untrustedWorkspaces |

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
| A1 | `package.json` 声明了三项设置，默认值/描述/**`scope` 与 Q9 的裁决一致**（避免"断言写死 machine、用户却选了默认 scope"的自相矛盾 —— 评审第 2 轮 N2） | 新 `scripts/settings-check.mjs`（静态读 package.json + 与 `src/host/config.ts` 的常量对照） | — |
| A2 | `applyAgentDirSetting()`：没设过环境变量 → 写入；已设过 → **不覆盖**；设置为空 → 不写。**断言前后必须存/删/恢复 `process.env.PI_CODING_AGENT_DIR`**（评审 N5：`host-check` 是单进程跑多条断言，泄露会污染 A9 等） | `host-check`（vscode 桩提供 `getConfiguration`） | C3 |
| A3 | 变更 `jerrypi.agentDir` → 恰好弹一次"需要重载"的信息消息，且带「重载窗口」按钮 | `host-check`（桩记录 `showInformationMessage` 的 items） | — |
| A4 | **空凭据目录也能对话且来源正确**（C1）：临时 agentDir（`models.json` 有 provider 无 `apiKey`、无 `auth.json`）+ SecretStorage 里有 key → 一轮真实对话成功，**且 `getProviderAuthStatus(id).source === "runtime"`** | `controller-check`（真模型） | **C1** |
| A5 | **C2**：`clearStoredApiKeys` 之后 ① `listProviders()` 为空 ② 该 provider `getProviderAuthStatus().source !== "runtime"`（**不是** `configured === false` —— 见 §1 C2 的说明）③ **夹具里预置的 auth.json（含同一个 provider）的 sha256 与 mtime 未变**。**可红验证**：把实现里的 `removeRuntimeApiKey` 故意换成 `logout()` → 这条必须变红（证明它真的能抓 F6 那个陷阱） | `controller-check` + `host-check` | **C2** |
| A6 | `Pi: Set API Key` 的候选来自 `getProviders()`（不是硬编码），已配置项的来源标注用 `getProviderAuthStatus().source`（**不是 `listCredentials()`**，F16/评审 S2），且 6 档都有对应文案 | `host-check`（桩记录 QuickPick 的 items） | — |
| A7 | 校验三态：`checkAuth` 有结果 / 无结果 / `getAvailable` 为空 → 三种提示文案 | `host-check` | — |
| A8 | `Pi: Refresh Model Catalog` 调 `refresh({ allowNetwork: true })`，一次调用；结果文案里的 provider/模型数由 `getProviders()` / `getAvailableSnapshot()` 的**前后差**算出（`refresh()` 的返回不含计数 —— 评审第 2 轮 N5） | `host-check` | — |
| A9 | `Pi: Open Settings File` 打开的是 `<生效 agentDir>/settings.json` | `host-check` | C3 |
| A10 | 文档同步：README 中英双语里三项设置的**生效状态标签集合**与 `package.json` 一致 —— 比**可枚举的集合**（三项设置 id + 各自的状态词），**不比自由文本**（比关键词的话，换了措辞但关键词还在就会绿 —— 评审第 2 轮 N3） | 新 `scripts/settings-check.mjs` 的第二段 | — |
| A11 | T13（advisory）：报告 `fetch.toString()` 是否含 `[native code]`、`http.proxySupport` / `http.proxy` 的值、四个代理环境变量的**存在性** —— **只报告不判定** | `src/pi/selftest.ts` | §3.4 |
| A12 | **漂移守卫（在 fetch 层）**：正向 —— 完整流程里没有任何请求打到 `pi.dev`（并记录全部 host）；反向 —— 点 `Pi: Refresh Model Catalog` 必须有一次打到 `pi.dev`。两条都不可少（只留正向会是恒真断言，见 §3.5 的第 2 轮 B2） | `controller-check` | §3.5 |
| A13 | **C3 的会话链路**：临时 agentDir 下 `dirname(sessionFile)` 落在 `<temp>/sessions/` 之下（复用 S5 的 `resolveSessionDir(cwd, sessionsRoot)`） | `controller-check` | **C3** |
| A14 | **C3 的凭据链路**：夹具在 `<temp>/auth.json` **预置** provider X 的凭据 → 断言 `getProviderAuthStatus(X).source === "stored"`（证明 runtime **读的是新目录那份**）**且** 真实 `~/.pi/agent/auth.json` 的 sha256 未变（没串到真目录） | `controller-check` + `host-check` | **C3** |

**A4/A5 共用的前置条件**（评审第 2 轮 S2：原来只挂在 A4 上，A5 少了一半保护）：临时 agentDir + **子进程里 `env -u` 清掉 `*_API_KEY` / `*_TOKEN` / `ANTHROPIC_*` 之类的凭据环境变量**。不干净的环境会让这两条一个假绿（别人的 key 顶着）、一个假红（环境凭据让 `configured` 永远为真）。
**auth.json 的有无不共用**（评审第 3 轮 N3）：A4 要"**没有** auth.json"，A5/A14 要"**预置**一份含同一个 provider 的"，所以它们各自用一份夹具（或按顺序重建临时目录），别复用同一个跑。

**留给实施期的一处**（评审第 3 轮 N4）：§1 的 C3 还有半句"Output 那行 `agentDir=` 注明来源"目前只有人工项 M1 盯着 —— 那是一行纯字符串，落在 `host-check` 里顺手就能断言（建议挂到 A2 上）。

**"先红"怎么写**：A1–A3、A6–A9 全部在 `host-check` 的 vscode 桩上加能力（`getConfiguration`、`onDidChangeConfiguration`、记录消息）——**先让它们红**，红的原因是"断言失败"而不是"编译错"。

## 7. 人工验收（Mac，**2 个动作**，一次 F5 会话里做完）

| # | 动作 | 属于哪一类 | 为什么自动化不了 |
| --- | --- | --- | --- |
| M1 | F5 起调试宿主 → 改 `jerrypi.agentDir`（指到一个临时空目录）→ 按提示**重载窗口** → 确认那行 `agentDir=<path>（来源：设置）` 变了、面板能发一条消息 → 再改回默认 → 重载 → 会话还在。**收尾**：改回时要把那条设置**删掉**（不是留成空串）—— `machine` scope 写的是**本人用户设置**，会影响到主窗口里已安装的那份 jerrypi（评审第 2 轮 N4） | **③真进程** | ①"重载窗口"是 VS Code 的生命周期，无头环境没有；②进程环境变量只在真实宿主里才有意义；③"设置改了之后 pi 到底用哪个目录"这件事，只有在真宿主里才成立。**判据是那行日志（评审 S3 加的"来源"字段）** |
| M2 | **只验真实渲染**：`Pi: Set API Key` 的 provider 列表与 `Pi: Clear Stored API Keys` 的多选/模态框在窄侧边栏下的**换行与按钮文字**（中英混排是否别扭） | **①排版/外观** | 原生 QuickPick / 模态框的渲染是 VS Code 的画，我们的桩只能验参数（items 内容、modal=true），渲染与换行验不了。**评审 S5 的收缩**：items 内容归 A6、设置描述文字归 A10，M2 不再"顺便都看一眼" |

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

| # | 步骤 | 这一步要落地的断言 |
| --- | --- | --- |
| 1 | **设置声明 + 读取层**：`package.json` 的 `contributes.configuration`（三项、scope 按 Q9）；新建 `src/host/config.ts`；`activate()` 最开头应用 agentDir；变更时提示重载 + 记一行带来源的日志 | **A1**（含新脚本 `scripts/settings-check.mjs` 的第一段）、**A2**、**A3** |
| 2 | **agentDir 贯通**：runtime / commands / sessions 全部走生效值；`Pi: Open Settings File` 按 §3.6 的新口径（不替用户建目录） | **A9**、**A13**（会话落在新目录）、**A14**（凭据落在新目录） |
| 3 | **密钥清理**：`ApiKeyStore.removeApiKey` + `clearStoredApiKeys`（逐个 try/catch、顺序定死）+ `Pi: Clear Stored API Keys`（来源判定用 `getProviderAuthStatus`，灰掉 pi 侧的） | **A5**（含"换成 `logout()` 必须变红"的可红验证） |
| 4 | **`Pi: Set API Key` 补完**：候选来自 `getProviders()`、6 档来源标注、三态本地校验 | **A6**、**A7** |
| 5 | **空凭据目录也能对话**：夹具（`models.json` 有 provider 无 key、无 auth.json、子进程清环境变量）+ 一轮真对话 + 来源断言 | **A4** |
| 6 | **`Pi: Refresh Model Catalog`**（按 Q5）+ 漂移守卫 | **A8**、**A12**（正反两条都在这里落） |
| 7 | **代理**（按 Q2）：要么只加 T13 + 诚实标注，要么照 PLAN §5.3 做第 2 层 | **A11** |
| 8 | **文档**：README 中英双语（配置表定稿 + 已知限制）、`docs/PLAN.md` §6 的 S6 状态、`docs/pi-traps.md`（`RuntimeCredentials.delete()` 那个陷阱）、`docs/STATUS.md` | **A10**（设置 id + 生效状态的集合比对） |
| 9 | **打包 + 自测 + Mac 验收**（M1/M2，2 个动作） | — |
| 10 | **发 0.1.8 → Windows W0/W1 → 回填 §12 → 关阶段** | — |

## 10. 评审记录

### 第 1 轮（2026-09-13，Claude Opus 5，评审者在本仓 `w60:pC` 面板）

**VERDICT: BLOCKING**（5 条 B、5 条 S、6 条 N）。**处置：14 条 ACCEPT、1 条 REJECT（N1）、1 条部分 REJECT（B1 的推论）。**
**教训 L1 记在本轮末尾 —— 这是本次评审最值钱的东西，比任何一条意见都值钱。**

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | **F12 的结论是反的**：`NODE_USE_ENV_PROXY` 对 fetch 生效；我那次对照被自己 shell 里的小写 `http_proxy=http://127.0.0.1:7897` 污染了。另：Q2 理由①「我这台是直连」是假的 | **ACCEPT（核心）／部分 REJECT（推论）** | 用 `env -u` 清干净环境 + **不存在的域名**做判别，复核为：启动前设 → `ECONNREFUSED`（走代理）；进程内设 → `ENOTFOUND`（太晚）。**它是对的，F12 整条推翻重写**。但它的推论「这台机器不是直连」**不成立**：清空代理变量后 `https://example.com` 仍是 200（本机既有代理又可直连）。Q2 的结论不变、理由按新事实重写，并采纳它提的零成本方案（启动 VS Code 前设那两个环境变量） |
| **B2** | A4/C1、A5/C2 会被**环境变量凭据**污染：`getProviderAuthStatus` 有 `environment` 一档，`getAvailable()` 也算它已配置 → 一个假绿、一个假红 | **ACCEPT** | C1 加断言 `source === "runtime"`；C2 改成 `configured === false`（**→ 第 2 轮 B1 又改成 `source !== "runtime"`，见 §1 C2**）；`controller-check` 跑这两条时**子进程清掉相关环境变量**。另：它举的 `ANTHROPIC_AUTH_TOKEN` 在我这个 shell 里不存在（它有），但结论与设计无关 —— 断言不能依赖运行环境 |
| **B3** | A5 的「auth.json 字节不变」在「本来就没有 auth.json」的夹具上是**恒真空断言** | **ACCEPT** | 夹具改成**先写一份已知内容的 auth.json** 再比 sha256/mtime；并加「可红验证」：把 `removeRuntimeApiKey` 故意换成 `logout()` → 这条必须变红 |
| **B4** | `AuthStatus.source` 有 **6 档**不是 3 档，漏掉的那档 `models_json_key` 正是验收判据说的那档 | **ACCEPT** | 新增 F18 记全 6 档；§3.3 的文案与 A6 的断言按 6 档改；C1 的夹具放一份「有 provider 无 apiKey」的 models.json 挡这一档。**它附带说「本机 models.json 根本不存在」是它自己核错了**（存在、1816 字节、JSONC、无 key 字段 —— 见新增的 F19） |
| **B5** | F8 的证据句是错的：`refresh()` 的默认值是 `options.allowNetwork ?? **this.modelNetworkEnabled**`，而它来自 `PI_OFFLINE`，与 `create({allowModelNetwork:false})` 无关 →「默认不联网」靠的是 pi 内部调用点的纪律，会漂移 | **ACCEPT** | F8 重写并带行号（`:517` / `:88` / `:91` / 内部调用点 `:381/:556/:592/:599`）；§3.5 加**漂移守卫**（新增断言 A12） |
| **S1** | 三项设置的 `scope` 从头到尾没决定，而 A1 却要断言它；默认 scope 会让**任意仓库的 `.vscode/settings.json` 把 agentDir 指走** | **ACCEPT** | §3.1 定死 `machine`（agentDir / proxy）；新增 **Q9**；A1 补 `scope: machine`（**→ 第 2 轮 B3 又把三项全定成 `machine`、第 2 轮 N2 把 A1 改成"与 Q9 的裁决一致"，见 §3.1 第 4 条 / §6 A1**） |
| **S2** | 「灰掉 auth.json 项」建在一个**区分不出来源**的 API 上（`listCredentials()` 把两种来源合并） | **ACCEPT** | F16 改写；§3.2/§3.3/A6 全部改用 `getProviderAuthStatus().source` / `hasRuntimeApiKey()` |
| **S3** | agentDir 的**生效来源**没被记录 → 用户无法区分「没重载」与「被环境变量压住」 | **ACCEPT** | §3.1 加「记一行 `agentDir=…（来源：环境变量 / 设置 / 默认）`」；M1 的判据改成这一行 |
| **S4** | 清 key 之后「当前会话怎么办」没写（是立即生效的内存操作） | **ACCEPT** | 确认文案加「当前会话将无法继续发送，直到重新设置 key」 |
| **S5** | M2 是兜底筐，里面至少两件事已被静态断言覆盖，违反「能搬就搬」 | **ACCEPT** | M2 收缩成「只验真实渲染（换行/按钮文字）」；items 内容归 A6、描述文字归 A10 |
| **N1** | F10 的出处不对，「没有 `dist/cli/setup.js`」 | **REJECT** | 我自己 `grep -rn "configureHttpDispatcher()" dist/` → **`cli/setup.js:10` 确实在**（评审漏了）。F10 顺手写得更精确（列出全部 6 处） |
| **N2** | `SUGGESTED_PROVIDERS` 在 `src/pi/runtime.ts` 不在 `src/commands.ts` | **ACCEPT** | F15 改正位置 |
| **N3** | F3 偏松：`getSessionsDir()` 根本不读 `ENV_SESSION_DIR` | **ACCEPT** | F3 重写（全 dist 只有 `main.js:531` 与帮助文本引用它） |
| **N4** | T13 用 `fetch.toString()` 比较太脆 | **ACCEPT** | 改成可判定三元组（`[native code]` + `proxySupport`/`proxy` + 环境变量存在性），仍「只报告不判定」 |
| **N5** | A2 改 `process.env` 会污染同进程后续断言 | **ACCEPT** | A2 明写「存/删/恢复」，并点出会被污染的正是 A9 |
| **N6** | `Pi: Open Settings File` 会**替用户创建拼错的目录** | **ACCEPT** | §3.6 改成「只在目标目录已存在时创建文件；不存在就报错并提示」 |

**STRONGEST_OBJECTION（它写的是 B1）** —— 它自己指出了最值钱的东西：「§0 这张『已核实事实』表是后面所有决策的地基，而 F12 这条地基是反的」。采纳。

#### 教训（L1）：先红纪律也要用在**实验**上

F12 那条错不是"写错了"，是**实验被环境污染**：

- 我的做法：`HTTP_PROXY=http://127.0.0.1:9 node -e "fetch(...)"` → 返回 200 → 我判定"没走代理"。
- 真相：本机 shell 里有**小写 `http_proxy=http://127.0.0.1:7897`**（一个真代理），undici 的环境变量代理**小写优先**，那 200 是**经过真代理**回来的。
- 正确做法（评审给的，已复核）：① `env -u` **清干净**全部代理变量；② 用**不可能成功的输入**判别（不存在的域名）：走代理 → `ECONNREFUSED`，不走 → `ENOTFOUND` —— 两种错误码**必然不同**，不依赖"成功/失败"这种会被环境翻转的信号。

⇒ **写进 AGENTS.md §2**：实验必须①在干净环境里做（`env -u`）②用「只有一种解释」的判别输入，不能拿"返回 200"当"没生效"。

### 第 2 轮（2026-09-13，同一评审者）

**VERDICT: BLOCKING**（3 条 B、5 条 S、5 条 N，全部 NEW）。**处置：13 条全部 ACCEPT**（行号都自己复核过）。
它开头主动认账了 §10.2 里那 3 处它自己的错（`cli/setup.js` 是它上轮命令被 `head` 截断；models.json 是它用 `require()` 读 JSONC 抛错被 `|| echo` 吞了；"不是直连"是它从"环境变量存在"越推）—— 并说 L1 那条纪律对它同样适用。

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | C2 的 ② 与 ③ **互相排斥**：夹具的 auth.json 里放了同一个 provider 之后，清掉内存覆盖层会让 `getProviderAuthStatus` **回落到 `stored`**（`model-runtime.js:221/:240/:414`）→ `configured === false` 必然失败 | **ACCEPT** | ② 改成 **`source !== "runtime"`**（精确表达"我们存的那把没了"，也躲开 `environment` 档）；口径写明"清完之后用户仍能靠 auth.json 对话，那是正确行为" |
| **B2** | A12 那条漂移守卫**几乎恒真**：`:556/:592/:599` 三处 `this.refresh()` 分别在 `registerNativeProvider`/`registerProvider`/`unregisterProvider` 里，我们的流程一步都走不到；`:381` 调的是 `this.models.refresh`（另一个对象）；`create()` 期那次刷新发生在实例交到我们手上之前 | **ACCEPT** | 已核行号（`python3` 往上找方法定义，三处确实在注册路径里）⇒ **守卫下沉到 fetch 层**：正向"整段流程没有任何请求打到 `pi.dev`"+ 反向"点刷新命令必须有且有一次打到 `pi.dev`"（出口证据：`remote-catalog-provider.js:4/:56/:67`）。**它那句"一条恒真的守卫比没有守卫更糟"写进计划** |
| **B3** | `approvalMode` 的 scope **定反了**：默认 scope 允许 `.vscode/settings.json` 覆盖 → S8 之后任意仓库能把工具审批设成 `off`（不问就执行），比 agentDir 被指走重一个量级；且 scope 发布后再改是破坏性变更 | **ACCEPT** | §3.1 第 4 条改成三项全 `machine` 并写明理由；Q9 扩成"三项 scope + 要不要声明 `untrustedWorkspaces`"（已核 `capabilities` 为 `undefined`） |
| **S1** | C3 声称三条链路，§6 只断言了一条（A2 只看环境变量、A9 只看 settings.json 路径） | **ACCEPT** | 新增 **A13**（会话文件落在 `<temp>/sessions/` 下）与 **A14**（凭据落点是 `<temp>/auth.json`，真实目录 sha256 不变） |
| **S2** | A5 没有像 A4 那样要求"干净子进程"，环境凭据会让它永远红 | **ACCEPT** | 把"干净环境夹具"提成 **A4/A5 共用前置**，写在表后（不塞进表格，免得把表切断） |
| **S3** | §3.2 步骤 4 是循环，而 `removeRuntimeApiKey` 会抛（`CredentialSynchronizationError`）→ 会留下夹生状态 | **ACCEPT** | 每个 provider 单独 try/catch；**定死顺序**（先 `removeRuntimeApiKey` 成功、再删 SecretStorage）；末尾汇总"成功 N / 失败 M（原因）" |
| **S4** | 让"记 `modelNetworkEnabled` 的实际取值"，但它是 `private readonly`，读不到 | **ACCEPT** | 删掉那句；改记 `process.env.PI_OFFLINE` 是否存在并注明是**推导值**（已核 `.d.ts:44` 是 `private readonly`） |
| **S5** | Q8（"不存在时警告但允许，因为它会被自动创建"）与 §3.6 新规则（**不替用户建目录**）互相打脸 | **ACCEPT** | 统一口径并写明"谁会创建、什么时候"：**pi** 在**写第一个会话时**建（`session-manager.js:251/:603` 的 `mkdirSync`），§3.6 的错误文案据此重写 |
| **N1** | F10 自己数不自洽（"另有两处"却列了三处） | **ACCEPT** | 改成"3 处无参 + 3 处带参 = 6" |
| **N2** | A1 把 `scope: machine` 写死，可 Q9 还在等用户拍板 | **ACCEPT** | A1 改成"与 **Q9 的裁决**一致" |
| **N3** | A10 比"关键词"太弱（换措辞但关键词还在就会绿） | **ACCEPT** | 改成比**可枚举的集合**（设置 id + 状态词） |
| **N4** | M1 在 dev host 里改 `machine` scope 会写进**本人用户设置**，影响主窗口那份已安装的 jerrypi | **ACCEPT** | M1 加收尾要求："改回时把那条设置**删掉**，别留成空串" |
| **N5** | "已刷新 N 个 provider（M 个模型）"没有数据来源（`refresh()` 只返回 `{ aborted, errors }`） | **ACCEPT** | §3.5 与 A8 都写明：N/M 由 `getProviders()` / `getAvailableSnapshot()` 的前后差算 |

**STRONGEST_OBJECTION（它写的是 B2）** —— 采纳：一条恒真的守卫比没有守卫更糟。已据此重写 A12。

### 第 3 轮（2026-09-13）—— 第一次尝试撞上评审者的 API 日限额，配额恢复后补跑成功

第 3 轮按纪律只做"转写与事实核对"。提示发出去之后评审者返回：

```
API Error: Request rejected (429) · api key 日限额已用完
```

**第一次尝试**（当天早些时候）：提示发出后评审者返回 `API Error: Request rejected (429) · api key 日限额已用完`。
⇒ 我先**自己**把这三件事做了一遍（结论见下表），并标了"未经复核"。**随后探到配额恢复，把第 3 轮真跑掉了** —— 它复核了我自查的结论：**发现一处 BLOCKING（A14 永远不可能绿，源头是它第 2 轮自己给的措辞）**，并确认 §10.1 的三处改动"全部通过"。

**我自己那一轮的结论**（保留，供对照）：

| 核对项 | 结果 |
| --- | --- |
| **① 事实复核**（F1–F19 有没有被我改坏的） | 逐条重读了改过的 F8/F12/F16/F18/F19，行号与本轮实测命令一致；本轮**没有发现新的错** |
| **② 转写一致性**（§10 说的改法 vs 正文实际） | 用 16 个"标志串"机械化比对：§10 第 1/2 轮里承诺的每一处改动，在正文里都能找到（✓ 16/16）。编号连续性：F1–F19 / C1–C3 / A1–A14 / Q1–Q9 **无缺号** |
| **③ 可实施性**（只看这份计划能不能干） | **发现一处真缺口**：§9 的步骤只引用到 A9，新增的 **A10–A14 没有任何步骤认领**。已把 §9 改成"步骤 ↔ 断言"对照表，现在 A1–A14 **全部被引用**（机械化复核：未引用 = 0） |

**第 3 轮（补跑后）的正式结论：VERDICT: BLOCKING，1 条**

| # | 意见（摘要） | 处置 | 我怎么处置的 |
| --- | --- | --- | --- |
| **B1** | **A14 永远不可能绿**：`setRuntimeApiKey` 是纯内存（F5）、auth.json 只在写路径被创建（`auth-storage.js:59/:119`），而 §3.2 + Q4 明说"不写 auth.json" → "写一把 key → `<temp>/auth.json` 出现"在本设计下不会发生；**这条的源头是它第 2 轮 S1 的措辞，我忠实转写了** | **ACCEPT** | A14 改成"夹具**预置** `<temp>/auth.json` → 断言 `source === "stored"`（读到了新目录那份）+ 真实 auth.json 的 sha256 未变"；§1 C3 的括注写明这次修正的来龙去脉（**错在评审给的改法本身**） |
| **S1** | §4 标题改了，§13 还写"见 §4 的 Q1–Q8" —— Q9 恰好是那条安全决策，靠 §13 导航的人会漏 | **ACCEPT** | §13 改成 Q1–Q9 |
| **S2** | §10.1 漏登了三处未经复核改动里的一处（§4 的 Q9/编号） | **ACCEPT** | 补登第 3 条，并按它本轮的复核结论标注"已复核通过" |
| **N1** | F19 的证据命令**没有鉴别力**（无论有没有 key 都是空）—— L1 纪律的 grep 版 | **ACCEPT** | 换成 `grep -ciE "apikey\|token\|secret"`（实测 =1，那一处是注释里的"每百万 token"）并注明旧命令为什么不算数 |
| **N2** | §10 第 1 轮表里 B2/S1 两行已被第 2 轮推翻，行内没有指针 | **ACCEPT** | 两行各加"→ 第 2 轮 B1/N2 又改了，见 …" |
| **N3** | A4 与 A5 对 auth.json 的前提相反，共用前置那段没提 | **ACCEPT** | 共用前置补一句"auth.json 的有无不共用" |
| **N4** | C3 的第二句（日志带来源）没有自动断言 | **DEFER（留给实施期）** | 按它的建议记在 §6 表后："落在 `host-check` 里顺手就能断言，建议挂到 A2 上" |
| **N5** | §3.6 的行号引多了一处（`:251` 是 `getDefaultSessionDir()` 的，我们不走那条） | **ACCEPT** | 只留 `:603`（构造函数），并把 `:251` 的归属写明 |

它同时明确回答：**§10.1 的三处未经复核改动"全部通过"**（§9 对照表：A1–A14 逐个对到步骤、无遗漏无重复；§4 的 Q9/编号：与 §3.1 第 4 条一致；AGENTS.md 的 L1：清单与判别法与它实跑的命令对得上）；F1–F19 除 N1 那条命令外**没有仍然错的**（F2/F8/F12/F16/F18 的行号与结论全部重跑命中）。

**STRONGEST_OBJECTION（B1）** —— 它的结论比这条断言本身更重要，已采纳并写进纪律：

> 三轮下来的防线（先红、能红验证、独立于实现）都是针对"**实现**会不会错"设计的，没有一条针对"**评审给的改法本身**在本计划的设计下成不成立"。

⇒ 已进 `AGENTS.md §2`：**采纳评审意见时，先把它当成一条新断言过一遍"这条在我们自己的设计下能不能绿"**。

**未解决分歧**：无（三轮共 37 条意见：35 ACCEPT / 1 REJECT / 1 部分 REJECT / 1 DEFER，全部有理由）。
**⚠️ 残留风险**：第 3 轮的 B1 是**采纳在评审结束之后**的 —— 那处修改（A14 的新写法）**没有任何人复核过**，见 §10.1。这也是为什么"评审能收敛"和"计划能动手"是两件事。

### 10.1 评审后的改动（**未经复核**）

| # | 改动 | 复核状态 |
| --- | --- | --- |
| 1 | **§9 的"步骤 ↔ 断言"表**（A10–A14 原来没人认领） | **第 3 轮已复核通过**（它逐个对过：A1–A14 → 10 个步骤，无遗漏无重复） |
| 2 | `AGENTS.md §2` 的 **L1 纪律**（干净环境 + 判别输入只有一种解释） | **第 3 轮已复核通过**（清单与判别法与它实跑的命令对得上） |
| 3 | **§4 的 Q9 / 编号修正**（标题 Q1–Q9、Q9 移到表末、改成"三项全 machine"） | **第 3 轮已复核通过**（与 §3.1 第 4 条一致、不再与第 2 轮 B3 相反） |
| 4 | **A14 的新写法**（B1 采纳之后改的：预置 auth.json → 断言 `source === "stored"`） | ⚠️ **未经任何复核** —— 第 3 轮已经用完，这是"三轮上限"下必然会留的盲区 |
| 5 | `AGENTS.md §2` 新增的"**采纳评审意见时先问它能不能绿**" | ⚠️ **未经任何复核**（来自第 3 轮 STRONGEST_OBJECTION） |

### 10.2 评审者的事实错误（本轮 3 处，按"评审的意见也要自己核"）

| 它说的 | 实际 |
| --- | --- |
| 「`configureHttpDispatcher` 的调用点没有 `dist/cli/setup.js`」（N1） | 有：`cli/setup.js:10` |
| 「本机 `~/.pi/agent/models.json` 根本不存在」 | 存在（1816 字节、JSONC、无 key 字段）—— 见 F19 |
| 「这台机器不是直连」（B1 的一段推论） | 清空代理变量后直连 `https://example.com` → 200；本机是"既能直连也有代理" |

## 11. 实施期发现

_（实施时遇到的、计划里没预料到的东西写在这里。）_

## 12. 实施与验收结果

_（自动检查 / 提交切分 / 人工验收 / 已知未覆盖。）_

## 13. 待用户拍板

见 §4 的 **Q1–Q9**。**默认值都是我的建议**；用户说"可以"之后才动代码（S5 的规矩）。
