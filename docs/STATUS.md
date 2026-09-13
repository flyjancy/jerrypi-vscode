# 状态（唯一入口）

> **这份文件只回答三个问题**：现在在哪、欠着什么、下一步做什么。
> 细节一律留在各自的 `S<n>-plan.md`（§11 实施期发现 / §12 实施与验收结果）与 README 的已知限制里，
> 这里不复制细节 —— 复制出来的副本一定会烂掉。
>
> **更新时机（硬规矩）**：
> - **每次提交前**更新下面的「进行中」那一行（阶段内也会变，但它只有一行）；
> - 阶段**边界**更新其余部分 —— ①计划写完待评审 ②评审完待用户确认默认值
>   ③用户说"可以"开始动代码 ④发布（含核验结果）⑤一端验收完 ⑥阶段关闭。

## 1. 现在

**进行中**：无 —— **S5 已关闭**（0.1.7 已发布并双端验收通过）；**S6（设置与密钥）尚未开始**（计划还没写）（2026-09-13）

| | |
| --- | --- |
| 阶段 | **S5 已关闭**（S5 的细节：`docs/S5-plan.md` 的 §11/§12）；**S6（设置与密钥）未开始** —— 下一步是写它的计划（见 §3） |
| 最新发布 | **0.1.7**（2026-09-13，预发布；S5 的全部内容） |
| 发布核验 | `node scripts/compare-vsix.mjs 0.1.7` → **338 个文件逐个字节相同，连整体 `.vsix` 也一样**（6,025,710 字节 / `04c60b7b…`）；tag `v0.1.7`；留档 `~/jerrypi-releases/jerrypi-0.1.7.vsix` |
| 真机验收 | S4：Mac ✅ ／ Windows ✅（S4-plan §12.3）｜ **S5：Mac ✅ ／ Windows ✅**（`GATE PASS` 13 PASS / 1 SKIP = T12；W0/W1 明细见 S5-plan §12.3） |
| 工作区 | `main` 与 origin 同步（S5 的提交与 `v0.1.7` tag 都已推）；工作区干净（logo 素材已由用户提交为 `77196c1`，并从 VSIX 里排除）。**总计划只有一份**：`docs/PLAN.md`（2026-09-13 已把根目录那份的 233 行评审记录并进去并删除，见 S5-plan §10.1 的 U6） |

**会自动跑的东西（每个动作改完必须全绿）**：

| 命令 | 现在 |
| --- | --- |
| `npm run typecheck`（2 套 tsconfig） | ✅ |
| `npm run self-test` | **9/9** |
| `npm run check:protocol` | 112 |
| `npm run check:render` | **114** |
| `node scripts/tool-text-check.mjs` | **87** |
| `node scripts/webview-dom-check.mjs` | **75** |
| `node scripts/host-check.mjs` | **57** |
| `npm run check:controller`（真模型，**不进 CI**） | **82/82**（含一条真 spawn `pi -c` 的 CLI 互通检查；总数随模型是否调工具浮动，见 S5-plan §11 的 1-5） |
| `Pi: Run Self-Test`（在 VS Code 里跑，**不进 CI**） | **14 项（12 gating + T5c/T12 advisory）GATE PASS** |
| `npm run package` + `node scripts/check-vsix.mjs <vsix>` | **338 文件 / 5.75 MB**（门禁 30 MB）。两个 logo 候选已排除出包（它们暂时没人引用，见 S5-plan §11 的 6-2） |

## 2. 欠着的事（已知、刻意未做或暂时做不到）

| 事 | 现状 | 记在哪 |
| --- | --- | --- |
| 滚动行为无法在无头 DOM 里断言 | 只断言"有没有写 `scrollTop`"，真机行为靠人工 | S4 §12.4 |
| `>70%` / `>90%` 的**颜色** | 只在纯函数层断言，没在真机构造过 70% 上下文 | S4 §12.4 |
| M14（"运行中的卡片带可点路径"） | 实际不可达（带路径的工具都是亚秒级），由 2 层自动断言兜着 | S3 §12.9 |
| CHANGELOG | 按约定从 **0.2.0** 开始写；旧文案可从 `8c944db` 取回 | S3 §12.11 |
| **旧位置**的会话不会被自动搬 | ≤0.1.6 写的会话平铺在 `~/.pi/agent/sessions/` 根上，面板与 `pi --resume` 都看不到（但没丢：`cd ~ && pi --session-dir ~/.pi/agent/sessions --resume`）；符号链接写法下写过的会话同理。**刻意不替用户搬数据** | README 已知限制 · S5-plan §3.8 / §11 的 6-9 |
| 多写者检测（同一个会话被两边同时写） | 只写进了已知限制，没做检测。候选：记下 `.jsonl` 的 `size+mtime`，下一条消息前比一次 | S5-plan 的 R8 |
| 「真·后台并行」（切走让旧会话继续跑，像 Codex/Claude 插件那样） | 划出 S5：需要"多会话宿主"（多份 runtime + 事件分流 + 多份 UI 状态），且并行会撞 R8 的两个写者 | S5-plan §2 / §4 D7 / §12.4 |
| 项目级设置（`.pi/settings.json` 等） | 固定 `projectTrusted: false`，信任流程没做 | **S6** |
| **三项 `jerrypi.*` 设置都还没实现** | `package.json` 里**从来没声明过** `contributes.configuration`，`src/` 里也没有读它们的地方：`agentDir` / `proxy` 写了不生效（**S6**）、`approvalMode` 写了不生效（**S8**）。README 的配置表逐条标明 | README 配置表 + 已知限制 |
| `ctx.ui.custom()` 类扩展命令 | 设计上不支持（终端 TUI 专有），会给明确错误 | README 已知限制 |
| 模型目录**不联网**刷新 | 我们显式写死 `allowModelNetwork: false`（刻意：不替用户往外发请求），所以新模型名（如 `deepseek-flash`）不会自己出现。要跟上得复制 `models-store.json` | README 已知限制 · S4 §12.5 |
| `Pi: Refresh Model Catalog`（显式联网刷新，点了才发请求） | **没做**。候选：与 S6 的 `jerrypi.agentDir` 一起做（store 路径跟着 agentDir 走） | README 已知限制 |

## 3. 下一步（S6：设置与密钥）

**S5 已关闭**（细节：`docs/S5-plan.md` §11 实施期发现 / §12 实施与验收结果）。

S6 的范围（`docs/PLAN.md` §6）：三项 VS Code 设置（含 `jerrypi.agentDir`、
`jerrypi.approvalMode` 只登记不实现）、`Pi: Clear Stored API Keys`，
把 S1 的最小版 `Pi: Set API Key` / `Pi: Open Settings File` 补完整（provider 选择、校验）。
验收：清空 `models.json` 里的 key、只靠 SecretStorage 也能完成对话。

**S6 动工前要注意的三件已经攒下的债**（都是 S5 期间记下的，别丢掉）：

| 事 | 为什么归 S6 |
| --- | --- |
| `jerrypi.agentDir` 一改，**会话目录要跟着走** | S5 已经把目录推导收进 `src/pi/sessions.ts` 的 `resolveSessionDir(cwd, sessionsRoot)` 一处；S6 只要保证 `sessionsRoot = <生效的 agentDir>/sessions` |
| `list()` 的 `filterCwd` 在自定义 agentDir 下会变成 `true` → **严格字符串比较**会咬人 | R10（Windows 盘符大小写，W0 已在真机上确认两种写法都存在）；S6 要么归一化比较、要么别依赖它 |
| `Pi: Refresh Model Catalog`（显式联网刷新） | STATUS §2 记的候选：store 路径跟着 agentDir 走，适合与 S6 一起做 |

下一步：**写 `docs/S6-plan.md`** → 送评审（≤3 轮）→ 把默认值摆给用户 → 用户说"可以"才动代码。
（S5 的流程可照抄：`docs/S5-plan.md` 是这一整套纪律的样例。）

## 4. 发布流程（每次都一样）

1. `package.json` 版号 +1（**预发布**）
2. `npm run package` → `node scripts/check-vsix.mjs jerrypi-X.Y.Z.vsix`
3. 用户在 Marketplace **手动上传**（勾"预发布"；没有 PAT、不用 CLI）
4. `node scripts/compare-vsix.mjs X.Y.Z`（会顺手归档到 `~/jerrypi-releases/`）
5. `git tag -a vX.Y.Z` + 推送
