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

**进行中**：**S8 已开工（2026-09-15，用户拍板「开工」= Q1–Q10 全按默认值）** —— 第 1–6 步完成、**0.1.10 的 Mac M1 验收抓到一个真 bug（宿主侧"待确认"副本只增不减）**，已修并加了回归断言；**Mac 验收（M1/M2）PASS**（结果见 `docs/S8-plan.md` §12.3）；0.1.11 已发布并逐字节核验、tag `v0.1.11`。**Windows W0 第一次跑：`GATE BLOCKED T14`** —— 是 T14 **夹具的路径写法**（`touch C:\…` 的反斜杠被 Git Bash 吃掉，§11 的 W0-1），产品本身没问题；已修并重新打包 **0.1.12**（338 文件 / 5.77 MB），**待上传 + Windows 复跑**（夹具 `/tmp/s8-trust-demo` 由我建好；“不信任 / 仅本次 / 重载不再问”改为自动断言，并补了 A10⑩ 钉住 controller 的信任接线）→ 上传预发布 → `compare-vsix` 核验 → Windows W0/W1 → §12 回填（`docs/S8-plan.md`：工具审批三档 + 项目信任流程；§0 的 25 条事实全部带证据，其中两条探针**已落盘可重跑** —— `scripts/probes/s8-approval-probe.mjs`、`scripts/probes/s8-trust-probe.mjs`）。三轮评审（`w60:pC` 的 Claude）**全部 ACCEPT 并已落进计划**：第 1 轮 `BLOCKING` 3 B / 8 S / 5 N（§10.1）、第 2 轮 `BLOCKING` 1 B / 6 S / 5 N（§10.2）。第 2 轮抓到的是**我第 1 轮自己补的那条断言**（在 happy-dom 里恒绿 —— 修「恒绿断言」这件事本身复发了一次），改法已落。第 3 轮 `TRANSCRIPTION: 12/12 落实 + 3 处转写错误`（§10.3，已修且不再复核）。**用户 2026-09-15 说「开工」⇒ Q1–Q10 按默认值执行**（§4 的表就是裁决记录）。下一步照 §9 的七步走。

| | |
| --- | --- |
| 阶段 | **S5、S6、S7 均已关闭**；**S8 计划期**（工具审批 + 项目信任；计划已写，待评审） |
| 最新发布 | **0.1.11**（2026-09-15，预发布；S8 的全部内容；已逐字节核验 + tag `v0.1.11`）→ 0.1.12 待上传（只改了测试夹具） |
| 发布核验 | `node scripts/compare-vsix.mjs 0.1.9` → **338 个文件逐个字节相同，连整体 `.vsix` 也一样**（6,037,572 字节 / `85db1434…` 的 SHA-256，Marketplace 显示 **Verified**）；tag `v0.1.9`；留档 `~/jerrypi-releases/jerrypi-0.1.9.vsix`（0.1.8：338 文件 / `30505f6e…`；0.1.7：338 文件 / `04c60b7b…`） |
| 真机验收 | S4：Mac ✅ ／ Windows ✅（S4-plan §12.3）｜ S5：Mac ✅ ／ Windows ✅（S5-plan §12.3）｜ S6：Mac ✅ ／ Windows ✅（S6-plan §12.3）｜ **S7：Mac ✅ ／ Windows ✅**（**W0 `GATE PASS` 14 PASS / 0 FAIL / 1 SKIP = T12；W1 正常**；T6 带上了 `before=null/newFile` 的核对 —— S7-plan §12.3） |
| 工作区 | `main` 与 origin 同步（S7 的提交与 `v0.1.9` tag 都已推）；工作区干净（logo 素材已由用户提交为 `77196c1`，并从 VSIX 里排除）。**总计划只有一份**：`docs/PLAN.md`（2026-09-13 已把根目录那份的 233 行评审记录并进去并删除，见 S5-plan §10.1 的 U6） |

**会自动跑的东西（每个动作改完必须全绿）**：

| 命令 | 现在 |
| --- | --- |
| `npm run typecheck`（2 套 tsconfig） | ✅ |
| `npm run self-test` | **9/9**（其中 host-check **321**、webview-dom 91、render 128、protocol 112、settings 16/16） |
| `npm run check:protocol` | 112 |
| `npm run check:render` | **128** |
| `node scripts/tool-text-check.mjs` | **91** |
| `node scripts/webview-dom-check.mjs` | **91** |
| `node scripts/host-check.mjs` | **321** |
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
| 项目级设置（`.pi/settings.json` 等） | 固定 `projectTrusted: false`，信任流程没做。⚠️ **这不是 S6 的欠账**：早期计划（S1/S2/S5）的指针写着“信任 UI 在 S6”，而 `PLAN.md` §6 的 S6 范围里从来没有它（S6 的 4 轮评审也没审过）。**用户 2026-09-14 拍板：排到 S8**（与工具审批同阶段）。设计已写进 **`docs/S8-plan.md` §3.4/§4 的 Q5–Q7（待评审）** | S1-plan §4.3 · S2-plan §7 · S5-plan §4；**PLAN.md §6 的 S8 注** · S8-plan |
| **三项 `jerrypi.*` 设置** | `agentDir` **已生效**（进程环境变量 + 重载窗口）；`proxy` 未实现（T13 只报告，Q2 不做第二层）；`approvalMode` 只登记、未生效 —— **S8 计划里就是让它生效**（`docs/S8-plan.md` §3.1/§3.3，待评审）。README 配置表中英双语逐条标明（`settings-check` 钉住） | README 配置表 + 已知限制 · S8-plan |
| `ctx.ui.custom()` 类扩展命令 | 设计上不支持（终端 TUI 专有），会给明确错误 | README 已知限制 |
| 模型目录**不会自动联网**刷新 | 我们显式写死 `allowModelNetwork: false`（刻意：不替用户往外发请求），所以新模型名（如 `deepseek-flash`）不会自己出现。现在有显式入口 `Pi: Refresh Model Catalog`（点才联网，A12 守住“自动路径不碰 pi.dev”） | README 已知限制 · S6-plan §3.5 / §6

## 3. 下一步（S8：工具审批 + 项目信任）

**S5、S6、S7 已关闭**（S7 的完整过程：`docs/S7-plan.md` §11 实施期发现 / §12 实施与验收结果；发布 0.1.9）。

S8 的范围（`docs/PLAN.md` §6）：`approval.ts` 三档工具审批（开 `all` 后每次工具调用停在面板等确认；拒绝后 agent 收到 block 原因；待审批时点中止，待审批项被清除且 agent 结束），加上**用户 2026-09-14 拍板追加**的项目级设置信任流程。

计划已经写完（`docs/S8-plan.md`），当前**卡在“送评审”**这一步：评审（≤3 轮）→ 把 §4 的 Q1–Q9 默认值摆给用户 → 用户说“可以”才动代码。
阶段内还欠的两件事已经在计划里落地了指向：① Windows 的自动覆盖靠新增的 **T14**（工具审批，**不用模型** —— 见 §0.1 的 F8）进 `Pi: Run Self-Test`；② 版本仍是 **0.1.10**（`0.1.x` = 预发布通道，第一个正式版 0.2.0 与 `CHANGELOG.md` 是 S10 的事，`PLAN.md` §5.4）。
（S7 的流程可照抄：`docs/S7-plan.md` 是这一整套纪律的最新样例。）

## 4. 发布流程（每次都一样）

1. `package.json` 版号 +1（**预发布**）
2. `npm run package` → `node scripts/check-vsix.mjs jerrypi-X.Y.Z.vsix`
3. 用户在 Marketplace **手动上传**（勾"预发布"；没有 PAT、不用 CLI）
4. `node scripts/compare-vsix.mjs X.Y.Z`（会顺手归档到 `~/jerrypi-releases/`）
5. `git tag -a vX.Y.Z` + 推送
