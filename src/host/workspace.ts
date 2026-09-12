// 会话的 cwd：一个 VS Code 窗口 = 一个 cwd = 第一个 workspace folder。
//
// 没有打开工作区时退回用户主目录，并**明确告诉用户**（而不是悄悄用一个别处）——
// 会话历史、相对路径、agent 能看到的文件都跟这个值有关，猜错一次很难发现。
import { homedir } from "node:os";
import * as vscode from "vscode";

export interface WorkspaceCwd {
  cwd: string;
  isWorkspace: boolean;
}

export function workspaceCwd(): WorkspaceCwd {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder !== undefined) {
    return { cwd: folder.uri.fsPath, isWorkspace: true };
  }
  return { cwd: homedir(), isWorkspace: false };
}
