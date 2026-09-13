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

**进行中**：**S5 第 6 步：Mac 验收已通过**；下一步把 0.1.7 上传到 Marketplace（用户手动），再做 Windows W0/W1（2026-09-13）

| | |
| --- | --- |
| 阶段 | **S4 已关闭**；**S5（会话管理）第 6 步** —— 代码与文档已做完、Mac 验收已过，**等发布 0.1.7 + Windows 验收**（`docs/S5-plan.md` 的 §9 第 7–8 步） |
| 最新发布 | **0.1.6**（2026-09-13，预发布）；**0.1.7 已打包待上传**（Mac 验收已过，见下） |
| 发布核验 | `node scripts/compare-vsix.mjs 0.1.6` → **338 个文件逐个字节相同**（发布当时）；tag `v0.1.6`；留档 `~/jerrypi-releases/jerrypi-0.1.6.vsix`。⚠️ 仓库根那份 `jerrypi-0.1.6.vsix` 已被 S5 第 1 步的 `npm run package` 重建，**不再是发布时的字节**（权威副本在 `~/jerrypi-releases/`） |
| 真机验收 | S4：Mac ✅ ／ Windows ✅（明细 S4-plan §12.3）｜ **S5：Mac ✅（2026-09-13，含用户报回的两个问题：确认框文案、输入法拼音回车——都已修）／ Windows W0/W1 待做** |
| 工作区 | `main` 上有 **18 个提交未 push**（用户要求先不推）；工作区干净（logo 素材已由用户提交为 `77196c1`，并从 VSIX 里排除）。**总计划只有一份**：`docs/PLAN.md`（2026-09-13 已把根目录那份的 233 行评审记录并进去并删除，见 S5-plan §10.1 的 U6） |

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
| 项目级设置（`.pi/settings.json` 等） | 固定 `projectTrusted: false`，信任流程没做 | **S6** |
| `jerrypi.approvalMode` | 写了**也不生效**（S8 才实现） | README 已知限制 |
| `ctx.ui.custom()` 类扩展命令 | 设计上不支持（终端 TUI 专有），会给明确错误 | README 已知限制 |
| 模型目录**不联网**刷新 | 我们显式写死 `allowModelNetwork: false`（刻意：不替用户往外发请求），所以新模型名（如 `deepseek-flash`）不会自己出现。要跟上得复制 `models-store.json` | README 已知限制 · S4 §12.5 |
| `Pi: Refresh Model Catalog`（显式联网刷新，点了才发请求） | **没做**。候选：与 S6 的 `jerrypi.agentDir` 一起做（store 路径跟着 agentDir 走） | README 已知限制 |

## 3. 下一步（S5：会话管理）

**计划已定稿：`docs/S5-plan.md`**（三轮评审已完成，31 条意见全部处置，未解决分歧：无；
实施期的每一个发现都记在它的 §11 —— 包括用户报回的两个问题、我自己漏掉的承诺、以及 R2 的真身）。
S5 的硬发现是：**会话原本写在 `~/.pi/agent/sessions/` 的根上（平铺），而 pi 的规范位置是
`<agentDir>/sessions/--<编码 cwd>--/`** —— 所以扩展写的会话 `pi --resume` 看不到，
G3 的"互通"当时**不成立**。第 1 步已修好，第 6 步的 `controller-check` 里有一条**真 spawn `pi -c`**
的检查钉住它。

| 步骤 | 状态 |
| --- | --- |
| 1–5（会话目录语义 / 启动恢复 + 重放 / 守卫与报错 / 列表 + 会话名 + 协议 v4 / 文档） | ✅ 全部完成（明细见 S5-plan §11） |
| 6 打包 + 自测 + Mac 验收 | ✅ 版本 0.1.7、338 文件 / 5.75 MB、门禁全绿、**Mac 验收通过** |
| 7 发布 0.1.7 预发布 | ⬜ **等用户手动上传** → 然后 `compare-vsix.mjs 0.1.7` + `git tag -a v0.1.7` |
| 8 Windows 验收 → 回填 §12 → 关阶段 | ⬜ W0（`Pi: Run Self-Test` 贴结果）／ W1（重启 VS Code 看自动恢复 + 点一次会话列表） |

## 4. 发布流程（每次都一样）

1. `package.json` 版号 +1（**预发布**）
2. `npm run package` → `node scripts/check-vsix.mjs jerrypi-X.Y.Z.vsix`
3. 用户在 Marketplace **手动上传**（勾"预发布"；没有 PAT、不用 CLI）
4. `node scripts/compare-vsix.mjs X.Y.Z`（会顺手归档到 `~/jerrypi-releases/`）
5. `git tag -a vX.Y.Z` + 推送
