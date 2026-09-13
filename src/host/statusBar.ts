// VS Code 状态栏项：显示当前模型与上下文用量（S4 的 G4 要求）。
//
// 两条从 S4 评审来的要求：
//   1. **只在 controller 已经 ensure 之后创建** —— 不要为了显示它而提前建会话，
//      否则 VS Code 一启动就会去加载 pi 运行时。
//   2. tooltip 里的价格要**带单位**（`$2/$8 / 1M tokens`），否则一个裸 `$2` 没人知道是什么。
import * as vscode from "vscode";
import type { SessionMeta } from "../shared/protocol";
import { formatContextUsage } from "../shared/format";

export class MetaStatusBar {
  private item: vscode.StatusBarItem | undefined;

  /** 更新显示（第一次调用时才 `createStatusBarItem`）。 */
  update(meta: SessionMeta): void {
    if (this.item === undefined) {
      this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      this.item.command = "jerrypi.selectModel";
    }
    const usage = formatContextUsage(meta.contextUsage?.percent ?? null, meta.contextWindow);
    const label = meta.model === "" ? "未选择模型" : meta.model.split("/").slice(1).join("/");
    this.item.text = usage === "" ? `$(hubot) ${label}` : `$(hubot) ${label} · ${usage}`;

    const lines = [
      meta.model === "" ? "未选择模型（点击选择）" : `模型：${meta.model}`,
      `思考等级：${meta.supportsThinking ? meta.thinkingLevel : "该模型不支持"}`,
      usage === "" ? "上下文：未知" : `上下文：${usage}`,
    ];
    lines.push("点击切换模型");
    this.item.tooltip = lines.join("\n");
    this.item.show();
  }

  dispose(): void {
    this.item?.hide();
    this.item?.dispose();
    this.item = undefined;
  }
}
