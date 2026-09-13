// 会话选择器（**宿主侧**，与 `modelPicker.ts` 同一个理由：QuickPick 是原生控件，
// 键盘/输入法/无障碍全免费；会话列表本来就在宿主侧的 session 上）。
//
// 四条从 S5 计划里来的硬要求：
//   1. **列表里永远有"新建会话"**（D10）：pi 的落盘契约是"首条 assistant 消息之后才建文件"，
//      所以刚建的会话**一定**不在列表里 —— 与其骗用户"列表就是全部"，不如让"新建"成为列表的一项。
//      （pi 自己的 TUI selector 没这么做，它的空态是让你按 Tab 换 scope；我们没有那个键位。）
//   2. **当前项用 `$(check)` 前缀**，不能用 `picked`（那只在多选时生效，单选时什么都不做 —— 断言它"被设置了"会全绿，真机上却没有勾）。
//   3. 组装那一行（`sessionToItem`）要**单独导出成纯函数**：否则"把 SessionInfo 变成 QuickPickItem"
//      这一步没有任何断言管（S4 的 `modelToItem` 就是这么做的）。
//   4. 焦点：**只有从面板发起**的流程才把焦点还给输入框，而且**两条退出路径**（选中 / Esc）都要还。
import * as vscode from "vscode";
import { homedir } from "node:os";
import { formatSessionTime, sessionDisplayName } from "../shared/format";

/** 选择器需要宿主提供的能力（选择器本身不认识 controller/session）。 */
export interface SessionPickerBridge {
  /** 当前会话文件路径；未落盘时为空串。 */
  currentSessionPath(): string;
  listSessions(): Promise<readonly unknown[]>;
  /** 新建（忙时由宿主先弹确认）。 */
  startNewSession(): Promise<void>;
  switchToSession(path: string): Promise<void>;
  notify(level: "info" | "warn" | "error", text: string): void;
  focusInput(): void;
}

/** `SessionInfo` 里我们真正读的字段（避免依赖 pi 的完整类型）。 */
interface SessionInfoLike {
  path?: string;
  name?: string;
  firstMessage?: string;
  modified?: Date;
  messageCount?: number;
}

const NEW_SESSION_ITEM: vscode.QuickPickItem = {
  label: "$(add) 新建会话",
  description: "开一个空白会话",
};

const EMPTY_HINT: vscode.QuickPickItem = {
  label: "$(info) 当前项目还没有已保存的会话",
  description: "聊满一轮之后它才会出现在这里",
  detail: "pi 在第一条回复之后才会写会话文件",
};

/** 家目录缩成 `~`（面板/列表里显示全路径太长）。 */
export function shortenPath(path: string, home: string = homedir()): string {
  return home !== "" && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * `SessionInfo` → `QuickPickItem`（**纯函数，单独导出就是为了能断言**）。
 *
 * `label` 必须有（VS Code 对没有 `label` 的项直接抛错）。
 */
export function sessionToItem(raw: unknown, currentPath: string, now: Date): vscode.QuickPickItem {
  const info = raw as SessionInfoLike;
  const path = info.path ?? "";
  const name = sessionDisplayName(info.name, info.firstMessage ?? "");
  const parts: string[] = [];
  if (info.modified instanceof Date) parts.push(formatSessionTime(info.modified, now));
  if (typeof info.messageCount === "number") parts.push(`${info.messageCount} 条消息`);
  return {
    // `$(check)` 是"当前项"的标记；不要用 `picked`（单选时它什么都不做）。
    label: path !== "" && path === currentPath ? `$(check) ${name}` : name,
    description: parts.join(" · "),
    detail: shortenPath(path),
  };
}

/** 打开会话选择器。 */
export async function pickSession(
  bridge: SessionPickerBridge,
  options: { fromPanel: boolean },
): Promise<void> {
  let sessions: readonly unknown[];
  try {
    sessions = await bridge.listSessions();
  } catch (error) {
    bridge.notify(
      "error",
      `读取会话列表失败：${error instanceof Error ? error.message : String(error)}`,
    );
    if (options.fromPanel) bridge.focusInput();
    return;
  }

  const currentPath = bridge.currentSessionPath();
  const now = new Date();
  // 第一项**永远**是"新建"（见文件头 1），其余是会话。
  const items: vscode.QuickPickItem[] = [
    NEW_SESSION_ITEM,
    ...sessions.map((session) => sessionToItem(session, currentPath, now)),
  ];
  // 空列表不必只留一句"无匹配项"：给一条能看懂的说明（对齐 pi 的空态文案）。
  if (sessions.length === 0) items.push(EMPTY_HINT);

  const picked = await vscode.window.showQuickPick(items, {
    title: "jerrypi: 会话",
    placeHolder: sessions.length === 0 ? "还没有已保存的会话" : `共 ${sessions.length} 个已保存会话`,
  });

  if (picked !== undefined && picked !== EMPTY_HINT) {
    if (picked === NEW_SESSION_ITEM) {
      await bridge.startNewSession();
    } else {
      const target = sessions[items.indexOf(picked) - 1] as SessionInfoLike | undefined;
      if (typeof target?.path === "string" && target.path !== "") {
        await bridge.switchToSession(target.path);
      }
    }
  }
  // **Esc 取消也要还焦点**（只写在"选中了"分支里会导致"取消之后光标没了"）。
  if (options.fromPanel) bridge.focusInput();
}
