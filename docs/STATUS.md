# 状态（唯一入口）

> **这份文件只回答三个问题**：现在在哪、欠着什么、下一步做什么。
> 细节一律留在各自的 `S<n>-plan.md`（§11 实施期发现 / §12 实施与验收结果）与 README 的已知限制里，
> 这里不复制细节 —— 复制出来的副本一定会烂掉。
>
> **更新时机（硬规矩）**：每个阶段的**边界**都要动这份文件 ——
> ①计划写完待评审 ②评审完待用户确认默认值 ③用户说"可以"开始动代码
> ④发布（含核验结果）⑤一端验收完 ⑥阶段关闭。中途的小改动不必更新。

## 1. 现在

| | |
| --- | --- |
| 阶段 | **S4 已关闭**；**S5（会话管理）未开始**（计划还没写） |
| 最新发布 | **0.1.6**（2026-09-13，预发布） |
| 发布核验 | `node scripts/compare-vsix.mjs 0.1.6` → **338 个文件逐个字节相同**；tag `v0.1.6`；留档 `~/jerrypi-releases/jerrypi-0.1.6.vsix` |
| 真机验收 | Mac（2 个动作）✅ ／ Windows（W0–W3）✅ —— 明细 S4-plan §12.3 |
| 工作区 | `main` 干净且与 origin 同步；`PLAN.md`（根）仍是 gitignore，提交版是 `docs/PLAN.md` |

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
| `npm run check:controller`（真模型，**不进 CI**） | 59/59 |
| `npm run package` + `node scripts/check-vsix.mjs <vsix>` | 338 文件 / 5.74 MB（门禁 30 MB） |

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
| 模型列表随机器不同 | 是 pi 自己的 `models-store.json` 缓存差异，不是扩展行为 | README 已知限制 · S4 §12.5 |

## 3. 下一步（S5：会话管理）

1. 写 `docs/S5-plan.md`（会话列表 / 新建 / 恢复；写入 `~/.pi/agent/sessions/`，与 pi CLI `--resume` 互通）
2. 送 Claude 评审（**≤3 轮**，第 3 轮只做转录核对）
3. 把 D1–Dn 的默认值摆给用户确认
4. **用户说"可以"之后**才动代码；实现顺序按该计划的 §9（先写断言、看红，再实现）

## 4. 发布流程（每次都一样）

1. `package.json` 版号 +1（**预发布**）
2. `npm run package` → `node scripts/check-vsix.mjs jerrypi-X.Y.Z.vsix`
3. 用户在 Marketplace **手动上传**（勾"预发布"；没有 PAT、不用 CLI）
4. `node scripts/compare-vsix.mjs X.Y.Z`（会顺手归档到 `~/jerrypi-releases/`）
5. `git tag -a vX.Y.Z` + 推送
