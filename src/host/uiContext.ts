// 生产用的 ExtensionUIContext：把 pi 扩展的对话框接到 VS Code。
//
// 为什么放在 `src/host/` 而不是 `src/pi/bindings.ts`：本文件需要 `vscode`，
// 而 `src/pi/session.ts` 值导入 `bindSession`，把 vscode 带进 src/pi 会让整个
// pi 封装层无法在纯 Node 里加载（S1 留下的快速迭代通道就此失效）。
//
// 两个必须记住的坑（S1 上踩过）：
//   1. **`theme` 不能抛错** —— pi 在绑定/初始化阶段会读 `ctx.ui.theme`，
//      抛错会让整个绑定失败（S1 实测表现是 T3 报 E_UNEXPECTED）。
//      返回一个"任何属性都是空操作函数"的 Proxy，比 undefined 更耐撞。
//   2. **`custom()` 不能静默 resolve** —— 它是 TUI 专有的自定义渲染入口，
//      扩展宿主里无法实现。静默返回 undefined 会让调用方以为"渲染成功但没内容"，
//      必须明确 reject，让错误经 onError 通道显示出来。
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import type { EventSink } from "../pi/bindings";

/**
 * 覆盖检查：pi 的 `ExtensionUIContext` 新增成员时下面这行会编译失败，
 * 提醒把新成员补上（接口有 28 个成员，很容易漏）。
 */
const UI_MEMBERS = [
  "select",
  "confirm",
  "input",
  "notify",
  "onTerminalInput",
  "setStatus",
  "setWorkingMessage",
  "setWorkingVisible",
  "setWorkingIndicator",
  "setHiddenThinkingLabel",
  "setWidget",
  "setFooter",
  "setHeader",
  "setTitle",
  "custom",
  "pasteToEditor",
  "setEditorText",
  "getEditorText",
  "editor",
  "addAutocompleteProvider",
  "setEditorComponent",
  "getEditorComponent",
  "theme",
  "getAllThemes",
  "getTheme",
  "setTheme",
  "getToolsExpanded",
  "setToolsExpanded",
] as const;

type MissingUIMember = Exclude<keyof ExtensionUIContext, (typeof UI_MEMBERS)[number]>;
// pi 新增接口成员时，MissingUIMember 不再是 never，这行赋值会编译失败。
const assertUIMembersComplete: MissingUIMember extends never
  ? []
  : ["ExtensionUIContext 有未实现的成员"] = [];
void assertUIMembersComplete;

/** `select` / `confirm` / `input` 这类对话框的公共选项。 */
interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** 内部取消标记：用来把"被取消/超时"与"用户选了空值"区分开。 */
class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * 建立一个"把 pi 的对话框接到 VS Code"的 UI 上下文。
 *
 * 为什么不用 pi 自带的 noOp 上下文：它是模块私有常量（既不在 `.d.ts` 里也不在
 * bundle 的导出里），拿不到；而且它把 `custom` 做成静默 resolve，
 * 会把"宿主做不到"伪装成"做到了"。
 */
export function createVSCodeUIContext(sink: EventSink): ExtensionUIContext {
  /**
   * 把 `signal` 与 `timeout` 接到 VS Code 的对话框上。
   *
   * VS Code 的 `showQuickPick` / `showInputBox` **不接受取消信号**，所以取消只能靠
   * `Promise.race` + `CancellationTokenSource`：让"被取消"与"用户给了值"竞争，
   * 取消时主动关掉已经弹出来的对话框（否则它会留在屏幕上，用户以为还等着他输入）。
   */
  const withDialog = async <T>(
    options: DialogOptions | undefined,
    fallback: T,
    open: () => Thenable<T | undefined>,
  ): Promise<T> => {
    const tokenSource = new vscode.CancellationTokenSource();
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      const cancel = () => {
        tokenSource.cancel();
        reject(new CancelledError());
      };
      if (options?.signal !== undefined) {
        if (options.signal.aborted) {
          cancel();
          return;
        }
        onAbort = cancel;
        options.signal.addEventListener("abort", cancel, { once: true });
      }
      if (options?.timeout !== undefined) {
        timer = setTimeout(cancel, options.timeout);
      }
    });
    // 竞争失败的那一支也要被消费掉，否则 Node 会报未处理的 rejection。
    void cancelled.catch(() => {});
    try {
      const value = await Promise.race([open(), cancelled]);
      return value === undefined ? fallback : value;
    } catch (error) {
      if (error instanceof CancelledError) return fallback;
      throw error;
    } finally {
      if (onAbort !== undefined) options?.signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      tokenSource.dispose();
    }
  };

  const ui: Record<string, unknown> = {
    select: async (
      title: string,
      options: readonly { label: string; description?: string }[],
      opts?: DialogOptions,
    ) =>
      withDialog<string | undefined>(opts, undefined, async () => {
        const picked = await vscode.window.showQuickPick(
          options.map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
          { title, ignoreFocusOut: true },
        );
        return picked?.label;
      }),
    confirm: async (title: string, message: string, opts?: DialogOptions) =>
      withDialog<boolean>(opts, false, async () => {
        const answer = await vscode.window.showWarningMessage(
          `${title}\n\n${message}`,
          { modal: true },
          "确认",
        );
        return answer === "确认";
      }),
    input: async (title: string, placeholder: string, opts?: DialogOptions) =>
      withDialog<string | undefined>(opts, undefined, () =>
        vscode.window.showInputBox({ title, placeHolder: placeholder, ignoreFocusOut: true }),
      ),
    notify: (message: string, type?: "info" | "warning" | "error") => {
      if (type === "error") {
        void vscode.window.showErrorMessage(`jerrypi: ${message}`);
      } else if (type === "warning") {
        void vscode.window.showWarningMessage(`jerrypi: ${message}`);
      } else {
        void vscode.window.showInformationMessage(`jerrypi: ${message}`);
      }
      sink.appendLine(`[ui:${type ?? "info"}] ${message}`);
    },
    onTerminalInput: () => () => {},
    setStatus: (key: string, text: string | undefined) => {
      // 终端状态栏在扩展宿主里没有对应物；写 Output 留痕，不静默吞掉。
      sink.appendLine(`[ui:status] ${key}=${text ?? "(cleared)"}`);
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    // 明确失败，而不是静默 resolve —— 见文件头注释 2。
    custom: async () => {
      throw new Error("jerrypi: 面板不支持扩展自定义 UI（这是终端 TUI 专有的渲染入口）");
    },
    pasteToEditor: () => {
      sink.appendLine("[ui] pasteToEditor 在面板模式下不可用（已忽略）");
    },
    setEditorText: () => {
      sink.appendLine("[ui] setEditorText 在面板模式下不可用（已忽略）");
    },
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    // 见文件头注释 1：绝不能抛错。
    get theme(): never {
      return new Proxy({}, { get: () => () => "" }) as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "面板模式不支持切换主题（请改 VS Code 主题）" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return ui as unknown as ExtensionUIContext;
}
