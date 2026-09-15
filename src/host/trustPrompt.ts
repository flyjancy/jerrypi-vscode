// 项目信任的**询问界面**（S8）：一个 VS Code 模态对话框。
//
// 为什么必须是原生对话框、不能用面板问（`docs/S8-plan.md` §0.2 F16）：
// 信任钩子是在 `controller.ensure()` 里被 pi **await** 的，而面板的 `state` 重放要等
// `ensure()` 返回 —— 用面板问就是自锁（面板永远空着等这个答案）。
//
// 三个按钮的语义（Q5）：
//   · 「信任并记住」= 写 `<agentDir>/trust.json` 里的一条 `true`；
//   · 「仅本次信任」= 只作用于本次进程，**不写文件**；
//   · 「不信任」    = 不写文件（**刻意不写 false** —— 那会变成"永不再问"）；
//   · ESC / 关掉    = **不信任且不写文件**（安全方向）。
import * as vscode from "vscode";
import type { TrustAnswer } from "../pi/trust";

/** 三个按钮的文案（`applyTrustAction` 的对话框版本；两处文案不同是刻意的，见下）。 */
export const TRUST_REMEMBER_ITEM = "信任并记住";
export const TRUST_SESSION_ITEM = "仅本次信任";
export const TRUST_DENY_ITEM = "不信任";

export interface TrustPrompter {
  ask(cwd: string): Promise<TrustAnswer>;
}

export interface TrustPromptOptions {
  log?: { appendLine(line: string): void };
}

/**
 * 造询问器。
 *
 * 文案要说清三件事（第 2 轮评审 S6 的两条 + README 的"两层信任"）：
 *   1. 问的是哪个文件夹；
 *   2. 触发它的**两种**来源：`<cwd>/.pi/` 或 `<cwd 或祖先>/.agents/skills`（F14）——
 *      只写 `.pi/` 会让用户在仓库里找一个不存在的目录；
 *   3. 它与 **VS Code 的工作区信任是两回事**（我们已经声明 `untrustedWorkspaces.supported=false`，
 *      所以面板只在已信任的工作区里跑；这一问管的是"要不要加载这个仓库自带的 pi 配置"）。
 */
export function createTrustPrompter(options: TrustPromptOptions = {}): TrustPrompter {
  return {
    async ask(cwd: string): Promise<TrustAnswer> {
      const picked = await vscode.window.showWarningMessage(
        `jerrypi：要信任这个文件夹里的 pi 项目配置吗？\n\n${cwd}\n\n` +
          "这个文件夹（或它的上级）里有 pi 的项目级资源（`.pi/` 或 `.agents/skills`）。" +
          "信任之后它们才会被加载：`.pi/settings.json`（能改 shell 与默认工具）、`.pi/extensions`、" +
          "`.pi/skills`、`SYSTEM.md` 等。\n\n" +
          "注意：这与 VS Code 的「工作区信任」是两回事 —— 那是决定要不要在这个窗口里启用扩展，这是决定" +
          "「要不要加载这个仓库自带的 pi 配置」。",
        { modal: true },
        TRUST_REMEMBER_ITEM,
        TRUST_SESSION_ITEM,
        TRUST_DENY_ITEM,
      );
      const answer: TrustAnswer =
        picked === TRUST_REMEMBER_ITEM
          ? { trusted: true, remember: true }
          : picked === TRUST_SESSION_ITEM
            ? { trusted: true, remember: false }
            : // 含 ESC / 关掉（undefined）：不信任、且不写文件
              { trusted: false, remember: false };
      options.log?.appendLine(
        `[trust] 询问结果：${cwd} → trusted=${answer.trusted} remember=${answer.remember}（按钮=${picked ?? "ESC/关闭"}）`,
      );
      return answer;
    },
  };
}
