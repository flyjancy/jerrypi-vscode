// 打开"这次调用改了什么"的 diff（`jerrypi-diff:` 虚拟文档 + `vscode.diff`）。
//
// 为什么用虚拟文档：`edit` 的两侧只有 patch（会话文件里持久化的 `details.patch`，S7-plan F1），
// `write` 的两侧只在内存里（F5）—— 两边都不是"磁盘上的两个文件"，所以既不能直接 diff 文件，
// 也不能复用 SCM 的机制。
//
// 两条纪律：
//   1. **白名单**：只认 filechanges store 里登记过的 toolCallId（渲染层也是按同一份记录决定
//      给不给链接的 —— 与 `openFile` 的两层同判一致）。
//   2. URI 用 `Uri.from({scheme, path, query})` 按**组件**构造，绝不拿整串去 `parse`：
//      文件名里的 `#` 会被 `Uri.parse` 当 fragment、`?` 当 query（`chatView.ts:230` 踩过）。
import { basename } from "node:path";
import * as vscode from "vscode";
import type { FileChangeStore } from "../pi/filechanges";
import { pathLabelOf, sidesOfPatch } from "../shared/patch";

export const DIFF_SCHEME = "jerrypi-diff";
const DIFF_COMMAND = "vscode.diff";

export interface DiffLog {
  appendLine(line: string): void;
}

export interface DiffPresenter {
  /** 打开这次调用的 diff。返回是否真的打开了（false 时 Output 里有一行原因）。 */
  open(toolCallId: string): boolean;
}

export interface DiffPresenterOptions {
  store: FileChangeStore;
  log: DiffLog;
}

/**
 * 造一个 presenter：注册 `jerrypi-diff:` 的虚拟文档 provider，并提供 `open(toolCallId)`。
 *
 * URI 里带的是**我们自己发的序号**（不是 toolCallId）：序号 → (toolCallId, side) 的映射在
 * 这里，所以文件名里有什么字符都不会影响"找得到这条记录"。序号还顺手解决了缓存问题 ——
 * 同一条记录被淘汰后又登记回来时会拿到新 URI，不会命中旧的虚拟文档。
 */
export function createDiffPresenter(context: vscode.ExtensionContext, options: DiffPresenterOptions): DiffPresenter {
  let seq = 0;
  const issued = new Map<string, { toolCallId: string; side: "left" | "right" }>();

  const provider = {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const key = String(uri.path).split("/")[1] ?? "";
      const entry = issued.get(key);
      if (entry === undefined) return "";
      const record = options.store.get(entry.toolCallId);
      // 找不到/不可用就返回空串：VS Code 关闭文档时还会问一次，那是正常路径，不记 Output。
      if (record === undefined || record.kind === "unavailable") return "";
      if (record.kind === "snapshot") return entry.side === "left" ? record.before ?? "" : record.after;
      const sides = sidesOfPatch(record.patch);
      return entry.side === "left" ? sides.left : sides.right;
    },
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider));

  return {
    open(toolCallId: string): boolean {
      const record = options.store.get(toolCallId);
      if (record === undefined) {
        options.log.appendLine(`[diff] 没有这次调用的记录，不打开：${toolCallId}`);
        return false;
      }
      if (record.kind === "unavailable") {
        options.log.appendLine(`[diff] 这次调用的 diff 不可用（${record.why}），不打开：${toolCallId}`);
        return false;
      }

      const name = record.kind === "patch" ? pathLabelOf(record.patch) || "文件" : basename(record.path);
      const uriFor = (side: "left" | "right"): vscode.Uri => {
        const key = String(++seq);
        issued.set(key, { toolCallId, side });
        // **按组件**构造（不是拿整串 parse）：名字里的 `#`/`?`/空格由 `toString` 负责编码。
        return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/${side}/${name}` });
      };
      const title =
        record.kind === "patch"
          ? `${name}（edit 前后 · 仅改动附近）`
          : record.newFile
            ? `${name}（新建）`
            : `${name}（write 前 → 后）`;

      void Promise.resolve(
        vscode.commands.executeCommand(DIFF_COMMAND, uriFor("left"), uriFor("right"), title, { preview: true }),
      ).catch((error: unknown) => {
        options.log.appendLine(`[diff] 打开失败：${error instanceof Error ? error.message : String(error)}`);
      });
      return true;
    },
  };
}
