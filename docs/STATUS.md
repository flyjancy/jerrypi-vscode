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

**进行中**：**S5 第 1 步已完成**（会话目录语义修正；红→绿证据见 S5-plan §11），下一步是第 2 步（启动即恢复 + 会话替换后重放）（2026-09-13）

| | |
| --- | --- |
| 阶段 | **S4 已关闭**；**S5（会话管理）实施中** —— 计划已定稿并全部拍板（`docs/S5-plan.md`），按它的 §9 逐步做 |
| 最新发布 | **0.1.6**（2026-09-13，预发布） |
| 发布核验 | `node scripts/compare-vsix.mjs 0.1.6` → **338 个文件逐个字节相同**（发布当时）；tag `v0.1.6`；留档 `~/jerrypi-releases/jerrypi-0.1.6.vsix`。⚠️ 仓库根那份 `jerrypi-0.1.6.vsix` 已被 S5 第 1 步的 `npm run package` 重建，**不再是发布时的字节**（权威副本在 `~/jerrypi-releases/`） |
| 真机验收 | Mac（2 个动作）✅ ／ Windows（W0–W3）✅ —— 明细 S4-plan §12.3 |
| 工作区 | `main` 上有 **7 个提交未 push**；两个未跟踪文件 `media/jerrypi-mark-j.svg` 与 `output/`（你的 logo 素材，我没纳进任何提交）。**总计划只有一份**：`docs/PLAN.md`（2026-09-13 已把根目录那份的 233 行评审记录并进去并删除，见 S5-plan §10.1 的 U6） |

**会自动跑的东西（每个动作改完必须全绿）**：

| 命令 | 现在 |
| --- | --- |
| `npm run typecheck`（2 套 tsconfig） | ✅ |
| `npm run self-test` | **9/9** |
| `npm run check:protocol` | 112 |
| `npm run check:render` | 110 |
| `node scripts/tool-text-check.mjs` | 69 |
| `node scripts/webview-dom-check.mjs` | 66 |
| `node scripts/host-check.mjs` | 39 |
| `npm run check:controller`（真模型，**不进 CI**） | **62/62**（总数随模型是否调工具浮动，见 S5-plan §11 的 1-5） |
| `Pi: Run Self-Test`（在 VS Code 里跑，**不进 CI**） | **14 项（12 gating + T5c/T12 advisory）GATE PASS** |
| `npm run package` + `node scripts/check-vsix.mjs <vsix>` | **339 文件 / 5.74 MB**（门禁 30 MB）。338 那个基线已过时：多出的 1 个是 `media/jerrypi-mark-j.svg`（20:44 出现的未跟踪文件，见 S5-plan §11 的 1-3） |

## 2. 欠着的事（已知、刻意未做或暂时做不到）

| 事 | 现状 | 记在哪 |
| --- | --- | --- |
| 滚动行为无法在无头 DOM 里断言 | 只断言"有没有写 `scrollTop`"，真机行为靠人工 | S4 §12.4 |
| `>70%` / `>90%` 的**颜色** | 只在纯函数层断言，没在真机构造过 70% 上下文 | S4 §12.4 |
| M14（"运行中的卡片带可点路径"） | 实际不可达（带路径的工具都是亚秒级），由 2 层自动断言兜着 | S3 §12.9 |
| CHANGELOG | 按约定从 **0.2.0** 开始写；旧文案可从 `8c944db` 取回 | S3 §12.11 |
| 会话列表 / 新建 / 恢复的**入口** | 只有命令面板的 `Pi: New Session` | **S5** |
| 项目级设置（`.pi/settings.json` 等） | 固定 `projectTrusted: false`，信任流程没做 | **S6** |
| `jerrypi.approvalMode` | 写了**也不生效**（S8 才实现） | README 已知限制 |
| `ctx.ui.custom()` 类扩展命令 | 设计上不支持（终端 TUI 专有），会给明确错误 | README 已知限制 |
| 模型目录**不联网**刷新 | 我们显式写死 `allowModelNetwork: false`（刻意：不替用户往外发请求），所以新模型名（如 `deepseek-flash`）不会自己出现。要跟上得复制 `models-store.json` | README 已知限制 · S4 §12.5 |
| `Pi: Refresh Model Catalog`（显式联网刷新，点了才发请求） | **没做**。候选：与 S6 的 `jerrypi.agentDir` 一起做（store 路径跟着 agentDir 走） | README 已知限制 |

## 3. 下一步（S5：会话管理）

**计划已定稿：`docs/S5-plan.md`**（三轮评审已完成，31 条意见全部处置，未解决分歧：无）。
里面有一条硬发现：**会话原本写在 `~/.pi/agent/sessions/` 的根上（平铺），
而 pi 的规范位置是 `<agentDir>/sessions/--<编码 cwd>--/`** —— 所以扩展写的会话
`pi --resume` 看不到，G3 的"互通"当时**不成立**。**第 1 步已修好（下方 4.**）。

1. ✅ 写 `docs/S5-plan.md`
2. ✅ 三轮评审（第 1 轮 5B/5S/6N、第 2 轮 4B/5S/6N、第 3 轮转写核对）
3. ✅ **Q1–Q6 已全部拍板**（2026-09-13，均按默认；明细见 S5-plan §13）
4. ⏳ **实施中**，按 S5-plan §9 的 7 步；每步先写断言、看红、再实现。
   **第 1 步 ✅**（会话目录语义修正）：`src/pi/sessions.ts` 新建；`sessionsDir`→`sessionsRoot`；
   自测新增 T10/T11/T12；`controller-check` 62/62、闸门 14/14 GATE PASS、全套门禁绿。
   下一步：第 2 步（启动即 `continueRecent` + 会话替换后重放，含修掉 §3.7 缺口 A）

## 4. 发布流程（每次都一样）

1. `package.json` 版号 +1（**预发布**）
2. `npm run package` → `node scripts/check-vsix.mjs jerrypi-X.Y.Z.vsix`
3. 用户在 Marketplace **手动上传**（勾"预发布"；没有 PAT、不用 CLI）
4. `node scripts/compare-vsix.mjs X.Y.Z`（会顺手归档到 `~/jerrypi-releases/`）
5. `git tag -a vX.Y.Z` + 推送
