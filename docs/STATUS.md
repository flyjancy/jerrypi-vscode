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

**进行中**：**S6 已关闭**（2026-09-14）—— 0.1.8 已发布预发布版，Mac（M1/M2）与 Windows（W0 `GATE PASS` / W1）都验过，发布核验逐字节一致（tag `v0.1.8`）。细节：`docs/S6-plan.md` §11/§12。**下一步：S7（diff 审阅）—— 先写 `docs/S7-plan.md` 送评审**（2026-09-14）

| | |
| --- | --- |
| 阶段 | **S5、S6 均已关闭**；**下一步 S7**（diff 审阅，待写计划） |
| 最新发布 | **0.1.8**（2026-09-14，预发布；S6 的全部内容；上一个 0.1.7） |
| 发布核验 | `node scripts/compare-vsix.mjs 0.1.8` → **338 个文件逐个字节相同，连整体 `.vsix` 也一样**（6,032,721 字节 / `30505f6e…` 的 SHA-256）；tag `v0.1.8`；留档 `~/jerrypi-releases/jerrypi-0.1.8.vsix`（0.1.7 的核验记录：338 文件 / `04c60b7b…`） |
| 真机验收 | S4：Mac ✅ ／ Windows ✅（S4-plan §12.3）｜ S5：Mac ✅ ／ Windows ✅（S5-plan §12.3）｜ **S6：Mac ✅ ／ Windows ✅**（**W0 `GATE PASS` 14 PASS / 0 FAIL / 1 SKIP = T12；W1 重启后会话正常**；T13 在真宿主首测：`http.proxySupport=override` —— S6-plan §12.3） |
| 工作区 | `main` 与 origin 同步（S6 的提交与 `v0.1.8` tag 都已推）；工作区干净（logo 素材已由用户提交为 `77196c1`，并从 VSIX 里排除）。**总计划只有一份**：`docs/PLAN.md`（2026-09-13 已把根目录那份的 233 行评审记录并进去并删除，见 S5-plan §10.1 的 U6） |

**会自动跑的东西（每个动作改完必须全绿）**：

| 命令 | 现在 |
| --- | --- |
| `npm run typecheck`（2 套 tsconfig） | ✅ |
| `npm run self-test` | **9/9**（其中 `SETTINGS-CHECK OK (16/16)`） |
| `npm run check:protocol` | 112 |
| `npm run check:render` | **114** |
| `node scripts/tool-text-check.mjs` | **91** |
| `node scripts/webview-dom-check.mjs` | **75** |
| `node scripts/host-check.mjs` | **95** |
| `npm run check:controller`（真模型，**不进 CI**） | **98/98**（含一条真 spawn `pi -c` 的 CLI 互通检查；总数随模型是否调工具浮动，见 S5-plan §11 的 1-5） |
| `npm run check:gate`（无头跑 `Pi: Run Self-Test`，真模型，**不进 CI**） | **15 项（12 gating + T5c/T12/T13 advisory）GATE PASS**（T13：`fetch=wrapped；http.proxySupport=(无头)；http.proxy=(未设)；代理环境变量存在=[HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy]；PI_OFFLINE=未设`） |
| `Pi: Run Self-Test`（在 VS Code 里跑，**不进 CI**；无头等价物：`npm run check:gate`） | **15 项（12 gating + T5c/T12/T13 advisory）GATE PASS**（0.1.8；无头跑过一次，Windows W0 真宿主又跑过一次 —— 14 PASS / 0 FAIL / 1 SKIP = T12） |
| `npm run package` + `node scripts/check-vsix.mjs <vsix>` | **0.1.8：338 文件 / 5.75 MB**（门禁 30 MB；文件清单与 0.1.7 逐个相同；9-5 修复后已重新打包）。两个 logo 候选已排除出包（它们暂时没人引用，见 S5-plan §11 的 6-2） |

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
| 项目级设置（`.pi/settings.json` 等） | 固定 `projectTrusted: false`，信任流程没做。⚠️ **这不是 S6 的欠账**：早期计划（S1/S2/S5）的指针写着“信任 UI 在 S6”，而 `PLAN.md` §6 的 S6 范围里从来没有它（S6 的 4 轮评审也没审过）。**用户 2026-09-14 拍板：排到 S8**（与工具审批同阶段，见 `PLAN.md` §6 的 S8 注；具体设计待 S8 计划期，尚未评审） | S1-plan §4.3 · S2-plan §7 · S5-plan §4；**PLAN.md §6 的 S8 注** |
| **三项 `jerrypi.*` 设置** | `agentDir` **已生效**（进程环境变量 + 重载窗口）；`proxy` 未实现（T13 只报告，Q2 不做第二层）；`approvalMode` 只登记、未生效（**S8**）。README 配置表中英双语逐条标明（`settings-check` 钉住） | README 配置表 + 已知限制 |
| `ctx.ui.custom()` 类扩展命令 | 设计上不支持（终端 TUI 专有），会给明确错误 | README 已知限制 |
| 模型目录**不会自动联网**刷新 | 我们显式写死 `allowModelNetwork: false`（刻意：不替用户往外发请求），所以新模型名（如 `deepseek-flash`）不会自己出现。现在有显式入口 `Pi: Refresh Model Catalog`（点才联网，A12 守住“自动路径不碰 pi.dev”） | README 已知限制 · S6-plan §3.5 / §6

## 3. 下一步（S7：diff 审阅）

**S5、S6 已关闭**（S6 的完整过程：`docs/S6-plan.md` §11 实施期发现 / §12 实施与验收结果；发布 0.1.8）。

S7 的范围（`docs/PLAN.md` §6）：`filechanges.ts` + `diff.ts` —— 按 `toolCallId` 收集 `edit` 的 patch 与 `write` 的前后内容，`edit` 卡片能打开真实 diff。
验收（PLAN 原文）：让 agent 在**同一条消息里**对同一文件发出两次 edit，两张卡片各自只显示该次 patch；同一条消息里两次 write 同一文件，两张卡片前后内容各自正确；重启 VS Code 恢复会话后，edit 卡片的 diff 仍可打开，write 卡片显示“本次会话不可用”。

**S6 关闭时排给 S8 的一件事**：项目级设置的信任流程（见 §2 与 `PLAN.md` §6 的 S8 注）。

下一步：写 `docs/S7-plan.md` → 送评审（≤3 轮）→ 把默认值摆给用户 → 用户说“可以”才动代码。
（S6 的流程可照抄：`docs/S6-plan.md` 是这一整套纪律的最新样例。）

## 4. 发布流程（每次都一样）

1. `package.json` 版号 +1（**预发布**）
2. `npm run package` → `node scripts/check-vsix.mjs jerrypi-X.Y.Z.vsix`
3. 用户在 Marketplace **手动上传**（勾"预发布"；没有 PAT、不用 CLI）
4. `node scripts/compare-vsix.mjs X.Y.Z`（会顺手归档到 `~/jerrypi-releases/`）
5. `git tag -a vX.Y.Z` + 推送
