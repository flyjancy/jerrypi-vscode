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

**进行中**：**S9 计划期**（pi 包管理：`Pi: Install Package` / `Pi: List Packages` / `Pi: Remove Package`）。
计划已写完：`docs/S9-plan.md`（§0 有 **46 条**带证据的事实（F1–F46，含 2026-09-17 追加范围的 F38–F46）+ 两个**可重跑探针** —— `scripts/probes/s9-package-probe.mjs`、`scripts/probes/s9-reload-probe.mjs`；§4 是 Q1–Q17 待你拍板）。
**第 1 轮评审已吸收完**（`VERDICT: BLOCKING`，3 B / 6 S / 5 N，14 条全部 ACCEPT —— §10.1）。
其中 **B1 我先自己复现再改**：探针第 1 版 7 个场景共用一个进程与 agentDir ⇒ S2（F15 的唯一证据）是假绿；
已重写成"每场景独立进程 + 独立 agentDir + 装包前前置断言"，重跑得到 `loader-only: []`、
`settings+loader: []`（两步都不够）、`session-reload: ["pkg-two"]`（一步够，**F16 比原计划更强**）。
**第 2 轮评审已吸收完**（codex，`w60:pD`；`VERDICT: BLOCKING`，**5 B / 6 S / 2 N**，13 条全部 ACCEPT —— §10.2）。
这轮把计划**改小也改硬**了：采纳 B2 ⇒ **不做热重载**（`session.reload()` 不重裁决项目信任，实测"空目录后来
长出 `.pi/extensions/` 会被未经询问加载"），于是第 1 轮那套"忙判断 + 重载接缝"整块取消；同时新增四条边界断言
（写路径必须 `projectTrusted:false`、写后回读校验、并发串行化、跨进程持久化）。§0 新增 **F31–F37**。
**按用户要求暂不启动第 3 轮**；下一步：把 §4 的 Q1–Q10 摆给用户拍板（或等用户说"再送一轮"）。

> **2026-09-17 用户拍板追加（并入 S9）**：四项体验修复 —— ③面板默认移右侧（`viewsContainers.secondarySidebar`，
> VS Code 1.104+）、④`Pi: Set Shell Path` + T16（Windows **按用户安装** Git、bash 不在 PATH 的盲区，用户真机踩中）、
> ①②面板内对话框与 API key 卡片（原生 QuickPick 位置硬编码在窗口顶部，无 API 可移）。已写入计划的
> §0.8（F38–F46）/§1 C8–C11/§3.6–§3.8/Q11–Q17/R10–R14/A23–A31/步骤 6–11，**全部标"未经复核"**；
> 用户特批追加范围的新评审预算：**Astra ≤2 轮设计 + 末轮只核转写**。下一步：送 Astra → 通过后 Q1–Q17 一起拍板。

> **另：S8 的回顾补修（2026-09-15）** —— codex（`w60:pD`）对**已关闭的 S8** 做了一次回顾审，报 4 条，
> 我逐条复现后全部为真并已修（`docs/S8-plan.md` §11.2 的 R1–R4）：①**"没有资源"被缓存成长期授权**
> （之后目录里长出 `.pi/` 就静默信任，项目配置未经询问生效 —— 安全问题）；②拒绝被后续中止改写
> （回放的"已拒绝"标记丢失）；③父目录有记录时"清除记录、下次重新问"是**假话**；④200 条上限没覆盖
> **取消**路径（连续中止就无界增长）。修完 host-check **322 → 329**，四条都有能红断言；
> **随 S9 的发布一起发**（版本号见 S9-plan 的 Q15，现为 0.2.0；不需要新的人工动作）。

> S8 收尾（已关闭）：Mac（M1/M2）与 Windows（W0 `GATE PASS` 15 PASS / 0 FAIL / 1 SKIP = T12，含 T14；W1 正常）都验过；发布 **0.1.12**（逐字节核验、tag `v0.1.12`）。

| | |
| --- | --- |
| 阶段 | **S5、S6、S7、S8 均已关闭**；**S9 计划期**（pi 包管理 + 2026-09-17 追加的四项体验修复；计划已写、待 Astra 补审追加范围） |
| 最新发布 | **0.1.12**（2026-09-15，预发布；S8 的全部内容；上一个 0.1.11 —— 两者只差 T14 夹具的路径写法） |
| 发布核验 | **0.1.12**：`NODE_USE_ENV_PROXY=1 node scripts/compare-vsix.mjs 0.1.12` → **338 个文件逐个字节相同，连整体 `.vsix` 也一样**（6,050,314 字节 / `3ffd7adc…`）；tag `v0.1.12`；留档 `~/jerrypi-releases/jerrypi-0.1.12.vsix`（0.1.11：338 文件 / `bd3cdcde…`；0.1.9：338 文件 / `85db1434…`）。⚠️ 本机跑这个脚本必须带 `NODE_USE_ENV_PROXY=1`（代理只在环境变量里，Node 的 fetch 默认不看，见 S8-plan §11 的 P-1） |
| 真机验收 | S4 ✅／✅ · S5 ✅／✅ · S6 ✅／✅ · S7 ✅／✅（各自的 §12.3）｜ **S8：Mac ✅ ／ Windows ✅**（M1 六项 + M2 三项；**W0 `GATE PASS` 15 PASS / 0 FAIL / 1 SKIP = T12，含 T14**；W1 正常 —— S8-plan §12.3） |
| 工作区 | `main` 与 origin 同步（S7 的提交与 `v0.1.9` tag 都已推）；工作区干净（logo 素材已由用户提交为 `77196c1`，并从 VSIX 里排除）。**总计划只有一份**：`docs/PLAN.md`（2026-09-13 已把根目录那份的 233 行评审记录并进去并删除，见 S5-plan §10.1 的 U6） |

**会自动跑的东西（每个动作改完必须全绿）**：

| 命令 | 现在 |
| --- | --- |
| `npm run typecheck`（2 套 tsconfig） | ✅ |
| `npm run self-test` | **9/9**（其中 host-check **329**、webview-dom 91、render 128、protocol 112、settings 16/16） |
| `npm run check:protocol` | 112 |
| `npm run check:render` | **128** |
| `node scripts/tool-text-check.mjs` | **91** |
| `node scripts/webview-dom-check.mjs` | **91** |
| `node scripts/host-check.mjs` | **329** |
| `npm run check:controller`（真模型，**不进 CI**） | **110/110**（S8 加了 A15：`approvalMode:all` 下拒绝→副作用没发生→允许→真的执行；另含 S7 的 A7 与一条真 spawn `pi -c` 的 CLI 互通检查；总数随模型是否调工具浮动，见 S5-plan §11 的 1-5） |
| `npm run check:gate`（无头跑 `Pi: Run Self-Test`，真模型，**不进 CI**） | **16 项（13 gating + T5c/T12/T13 advisory）GATE PASS**（本机 T12 也 PASS ⇒ 16 PASS / 0 FAIL / 0 SKIP；**T14 是 S8 新增的工具审批项，不用模型**；T13：`fetch=wrapped；http.proxySupport=(无头)；http.proxy=(未设)；代理环境变量存在=[…]；PI_OFFLINE=未设`） |
| `Pi: Run Self-Test`（在 VS Code 里跑，**不进 CI**；无头等价物：`npm run check:gate`） | **16 项（13 gating + T5c/T12/T13 advisory）GATE PASS**（0.1.8 时是 15 项；**S8 加了 T14 之后是 16 项**。上次 Windows W0 真宿主跑的是 15 项版：14 PASS / 0 FAIL / 1 SKIP = T12 —— 那台机器没有 `pi`） |
| `npm run package` + `node scripts/check-vsix.mjs <vsix>` | **0.1.9：338 文件 / 5.76 MB**（门禁 30 MB；文件数自 0.1.7 起一直是 338）。两个 logo 候选已排除出包（它们暂时没人引用，见 S5-plan §11 的 6-2） |

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
| ~~项目级设置（`.pi/settings.json` 等）~~ | **S8 已做（0.1.12）**：首次开面板时原生模态问一次（信任并记住 / 仅本次 / 不信任），`trust.json` 与 pi CLI 共用，`Pi: Project Trust…` 改判。**遗留**：pi 扩展的 `project_trust` 事件不触发（全局扩展的"自动信任"在这里会变成多问一次，Q6），扩展的 `project_trust` 表态与"销毁即取消"两处按 Q6/Q10 显式不做 | S8-plan §12.4 · README 已知限制 |
| **三项 `jerrypi.*` 设置** | `agentDir` **已生效**（进程环境变量 + 重载窗口）；`approvalMode` **已生效**（S8，改动立即生效不用重载）；`proxy` 仍未实现（T13 只报告，Q2 不做第二层）。README 配置表中英双语逐条标明（`settings-check` 钉住） | README 配置表 + 已知限制 · S8-plan |
| `ctx.ui.custom()` 类扩展命令 | 设计上不支持（终端 TUI 专有），会给明确错误 | README 已知限制 |
| 模型目录**不会自动联网**刷新 | 我们显式写死 `allowModelNetwork: false`（刻意：不替用户往外发请求），所以新模型名（如 `deepseek-flash`）不会自己出现。现在有显式入口 `Pi: Refresh Model Catalog`（点才联网，A12 守住“自动路径不碰 pi.dev”） | README 已知限制 · S6-plan §3.5 / §6

## 3. 下一步（S9：pi 包管理）

**S5、S6、S7、S8 均已关闭**（S8 的完整过程：`docs/S8-plan.md` §11 实施期发现 / §12 实施与验收结果；发布 0.1.12）。

S9 的范围（`docs/PLAN.md` §6）：`packages.ts` —— `Pi: Install Package` / `Pi: List Packages` / `Pi: Remove Package`，走 pi 自己的 `DefaultPackageManager`（`installAndPersist` / `listConfiguredPackages` / `removeAndPersist`），输入接受 pi 原生格式（裸路径 / git URL / `npm:name`）。
下一步：写 `docs/S9-plan.md` → 送评审（≤3 轮）→ 把默认值摆给用户 → 用户说“可以”才动代码。
（S8 的流程可照抄：`docs/S8-plan.md` 是这一整套纪律的最新样例。）

## 4. 发布流程（每次都一样）

1. `package.json` 版号 +1（**预发布**）
2. `npm run package` → `node scripts/check-vsix.mjs jerrypi-X.Y.Z.vsix`
3. 用户在 Marketplace **手动上传**（勾"预发布"；没有 PAT、不用 CLI）
4. `node scripts/compare-vsix.mjs X.Y.Z`（会顺手归档到 `~/jerrypi-releases/`）
5. `git tag -a vX.Y.Z` + 推送
