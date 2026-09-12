// 自测专用的最小 ExtensionUIContext。
//
// 为什么必须自己写（而不是复用 pi 的 noOpUIContext）：
//   `noOpUIContext` 是 pi `dist/core/extensions/runner.js` 里的**模块私有常量**，
//   既不在任何 `.d.ts` 里，也不在 bundle 的导出里 —— 根本拿不到。
//
// 为什么不用"直接不传 uiContext"：不传时 pi 会用那个 noOp 上下文，
// 而它的 `custom` 是 `async () => {}`，**静默 resolve 成 undefined**，
// 于是 `/smoke-custom` 永远不会失败，T3 就测不到 `onError` 通路。
// 这里让 `custom` 抛可控错误，正是为了把那条通路走一遍。
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EventSink } from "./bindings";

const UNAVAILABLE = "自测宿主没有真实 UI";
void UNAVAILABLE;

/**
 * 覆盖检查：pi 的 ExtensionUIContext 新增成员时，下面这行会编译失败，
 * 提醒把新成员补上（接口有 28 个成员，很容易漏）。
 */
const IMPLEMENTED_MEMBERS = [
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

type MissingMember = Exclude<keyof ExtensionUIContext, (typeof IMPLEMENTED_MEMBERS)[number]>;
// 若 pi 新增了接口成员，这里的类型就不再是 never，下面的赋值会编译失败。
const assertNoMissingMember: MissingMember extends never ? [] : ["缺少 ExtensionUIContext 成员"] = [];
void assertNoMissingMember;

export function createSelfTestUIContext(sink: EventSink): ExtensionUIContext {
  const ui = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string, type?: "info" | "warning" | "error") => {
      sink.appendLine(`[ui:${type ?? "info"}] ${message}`);
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    // 真正重要的一个：让"宿主无法显示自定义 UI"成为**可控错误**，
    // 从而覆盖 extension onError 通路（T3）。
    custom: async () => {
      throw new Error(`jerrypi: custom UI 不可用（${UNAVAILABLE}）`);
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    // 不能招错：pi 内部会在绑定/初始化阶段读 ctx.ui.theme。
    // 返回一个“任何属性都是空操作函数”的代理，比 undefined 更耐撞。
    get theme(): never {
      return new Proxy({}, { get: () => () => "" }) as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  // 形状与 pi 的接口一致（成员完整性已由上面的类型断言保证）。
  return ui as unknown as ExtensionUIContext;
}
