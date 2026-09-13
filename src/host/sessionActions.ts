// 会话替换的"忙时问一句"（S5 的 D7，宿主侧）。
//
// 分层（评审 S4）：**分类在 controller**（它返回带 code 的结果，因为拿不到 `vscode.window`），
// **文案与弹窗在这里**。controller-check 断言 code 与"会话没换"，host-check 断言"弹了几次、
// 点了之后有没有带 force 再跑"。
import * as vscode from "vscode";
import type { SessionReplaceOutcome } from "../pi/controller";

const CONFIRM_LABEL = "继续";

/**
 * 跑一次会话替换；**忙的时候先问一句**。
 *
 * 三条路的取舍（plan §4 D7，由用户 2026-09-13 拍板）：
 *   - 静默切（对齐 pi CLI）= 不告诉你就把正在跑的那一轮中止掉。pi 会把它落盘（不丢数据），
 *     但你可能正好把侧边栏切走了、完全看不到 —— 回头只看到会话已经换了，像面板抽风；
 *   - 拦死 = 替你做决定：你**主动**想切的时候它不让；
 *   - 问一句 = 把决定还给你，而且你确实想切的时候只多一次点击。
 */
export async function replaceSessionWithConfirm(
  run: (force: boolean) => Promise<SessionReplaceOutcome>,
): Promise<SessionReplaceOutcome> {
  const first = await run(false);
  if (first.ok || first.code !== "busy") return first;
  const picked = await vscode.window.showWarningMessage(
    "正在生成：切换会话会中止这一轮（它会被保存到原会话里）。继续吗？",
    { modal: true },
    CONFIRM_LABEL,
  );
  if (picked !== CONFIRM_LABEL) return first;
  return run(true);
}

/**
 * 把替换结果翻译成给用户看的话。**只处理"该说话"的那几种**：
 *   - `busy`：用户自己点的取消 → 不再吭声（弹窗已经把话说完）；
 *   - `cancelled`：扩展把这次替换取消了（`session_before_switch`）→ 要说一声，
 *     否则用户只会看到"点了没反应"；
 *   - `missing-cwd`：会话的工作目录已不存在 → 给可读提示与下一步，
 *     **不自动 `cwdOverride`**（那会让那个会话里的相对路径静默换意思，见 D9）。
 */
export function reportReplaceOutcome(
  outcome: SessionReplaceOutcome,
  notify: (level: "info" | "warn" | "error", text: string) => void,
): void {
  if (outcome.ok || outcome.code === "busy") return;
  if (outcome.code === "cancelled") {
    notify("warn", "这次会话切换被一个 pi 扩展取消了（session_before_switch）。");
    return;
  }
  notify(
    "error",
    `这个会话的工作目录已不存在：${outcome.detail ?? "(未知)"}。` +
      "请先恢复那个目录，或在终端里用 pi 打开它。",
  );
}
