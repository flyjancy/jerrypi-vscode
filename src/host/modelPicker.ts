// 模型 / 思考等级选择器（**宿主侧**，用 VS Code 原生 QuickPick）。
//
// 为什么在宿主而不是 webview 里自绘：QuickPick 是原生控件（键盘、输入法、无障碍全免费），
// 模型列表本来就在宿主侧的 session 上；在 webview 里自绘还要自己处理 CSP、焦点与键盘，
// 收益为零。
//
// 四条从 S4 评审来的硬要求（每条都对应一个"看起来能跑、真机不对"的坑）：
//
//   1. `showQuickPick` 只接受 `string[]` 或**带 `label` 的** `QuickPickItem[]`（以及它们的
//      Thenable）—— `Model[]` 两者都不是，必须先映射。空列表也必须换成一条有意义的说明项，
//      否则 VS Code 显示"无匹配项"，用户不知道下一步该干什么。
//   2. 当前项用 **`$(check)` 前缀**（或 `description`）标记。**不能用 `picked`**：
//      它只在 `canPickMany` 的多选模式下生效，单选时什么都不做 ——
//      断言它"被设置了"会全绿，真机上却没有勾。
//   3. 传 **Thenable** 给 `showQuickPick`：VS Code 原生支持，等待期间自带加载态。
//      不要改成"先弹空列表再塞 items" —— `showQuickPick` 弹出后改不了 items。
//   4. 焦点：**只有从面板发起**的流程才把焦点还给输入框，而且**两条退出路径**
//      （选中 / Esc 取消）都要还。从命令面板发起时不还 —— 那时用户焦点可能在编辑器里。
//      另：**不要**用 `webviewView.show()` / `focusChat` 来"确保焦点"，那会抢用户焦点。
import * as vscode from "vscode";
import { formatCost, formatTokens } from "../shared/format";
import type { DialogPanel } from "./dialogHost";

export type { DialogPanel };

/** 选择器需要宿主提供的能力（由 controller 实现；选择器本身不认识 session）。 */
export interface PickerBridge {
  /** 当前模型 `"provider/id"`，未选择时为空串。 */
  currentModelId(): string;
  /** `!!model?.reasoning`。**false 时不要读等级列表**（会拿到 7 档假数据）。 */
  supportsThinking(): boolean;
  currentLevel(): string;
  /** 当前模型支持的等级（可能带空洞，例如 `off/low/high/max`）。 */
  levels(): readonly string[];
  listModels(): Promise<readonly unknown[]>;
  applyModel(model: unknown): Promise<void>;
  applyLevel(level: string): void;
  /** 失败/状态提示（由调用方决定写到面板还是 Output）。 */
  notify(text: string, level: "info" | "warn" | "error"): void;
  /** 把焦点还给输入框（`fromPanel` 时由调用方真的发消息）。 */
  focusInput(): void;
  /** 面板内“配置 API Key”入口（可选：没给就只提示去跑命令）。 */
  configureApiKey?: () => Promise<void>;
}

/** 模型目录里的字段（只取我们要显示的那几个，避免依赖 pi 的完整类型）。 */
interface ModelLike {
  provider?: string;
  id?: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  input?: readonly string[];
  cost?: { input?: number; output?: number };
}

const NO_MODELS_ITEM: vscode.QuickPickItem = {
  label: "$(warning) 没有可用模型",
  description: "先用 Pi: Set API Key 配置一个 provider",
  detail: "回车即可前往配置",
};

/** 把模型对象映射成 QuickPickItem（`label` 必须有，否则 VS Code 直接抛错）。 */
export function modelToItem(raw: unknown, currentId: string): vscode.QuickPickItem {
  const model = raw as ModelLike;
  const id = model.id ?? "(未知模型)";
  const isCurrent = `${model.provider ?? ""}/${id}` === currentId;
  const details: string[] = [];
  const cost = formatCost(model.cost?.input, model.cost?.output);
  if (cost !== "") details.push(cost);
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    details.push(`上下文 ${formatTokens(model.contextWindow)}`);
  }
  if (model.input?.includes("image") === true) details.push("支持图片");
  if (model.reasoning === true) details.push("支持思考");
  return {
    // `$(check)` 前缀是"当前项"的标记；不要用 `picked`（只在多选时生效）。
    label: isCurrent ? `$(check) ${id}` : id,
    description: model.provider ?? "",
    detail: details.join(" · "),
  };
}

/**
 * 把模型对象映射成**面板卡片**的一项。
 *
 * 与 `modelToItem` 的差别：`✓` 前缀不在这里加 —— 宿主只发 `current`，由渲染层加
 * （单一真相；否则“哪一项是当前”会同时活在协议载荷与字符串里，两边会分叉）。
 */
export function modelToDialogItem(raw: unknown, currentId: string): { label: string; description?: string; detail?: string } {
  const model = raw as ModelLike;
  const id = `${model.provider ?? ""}/${model.id ?? "(未知模型)"}`;
  const details: string[] = [];
  const cost = formatCost(model.cost?.input, model.cost?.output);
  if (cost !== "") details.push(cost);
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    details.push(`上下文 ${formatTokens(model.contextWindow)}`);
  }
  if (model.input?.includes("image") === true) details.push("支持图片");
  if (model.reasoning === true) details.push("支持思考");
  const item: { label: string; description?: string; detail?: string } = { label: id };
  if (id !== currentId && typeof model.provider === "string" && model.provider !== "") item.description = model.provider;
  if (details.length > 0) item.detail = details.join(" · ");
  return item;
}

const NO_MODELS_DIALOG_ITEM = { label: "没有可用模型", description: "先配置一个 provider 的 API key" };

/**
 * 在**面板内**选模型（S9 ①②）。
 *
 * 四条 S4 硬要求全部平移（modelPicker 文件头）：当前项标记（这里是 `current` + 渲染层的
 * `✓`）、加载态、焦点归还**三条**退出路径、fromPanel 分流。再加一条 R2-B1：
 * **发送加载结果（成功或失败）之前先查 pending** —— 已结算就丢弃结果，否则晚到的列表
 * 会把已撤的卡片“复活”成孤儿卡。
 */
export async function pickModelInPanel(bridge: PickerBridge, dialogs: DialogPanel): Promise<void> {
  const currentId = bridge.currentModelId();
  const handle = dialogs.start({
    kind: "select",
    title: "jerrypi: 选择模型",
    ...(currentId === "" ? {} : { current: currentId }),
    loading: true,
    items: [],
  });
  let models: readonly unknown[];
  try {
    models = await bridge.listModels();
  } catch (error) {
    if (dialogs.isPending(handle.dialogId)) dialogs.fail(handle.dialogId);
    // 第三条退出路径（加载失败）也要把焦点还给输入框（S4 的硬要求 4 扩到三条）。
    bridge.focusInput();
    bridge.notify(`读取模型列表失败：${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  // 晚到的加载结果：用户已经 Esc / 会话已替换 ⇒ **丢弃**（不发 open、不发 close、不抢焦点）。
  if (!dialogs.isPending(handle.dialogId)) return;
  dialogs.update(handle.dialogId, {
    loading: false,
    items: models.length === 0 ? [NO_MODELS_DIALOG_ITEM] : models.map((raw) => modelToDialogItem(raw, currentId)),
  });

  const picked = await handle.result;
  if (picked === undefined) {
    // 取消/超时/替换：三条退出路径都要把焦点还给输入框。
    bridge.focusInput();
    return;
  }
  if (models.length === 0) {
    // 空态那条“去配置”的下一步（与原生路径对齐）。
    if (bridge.configureApiKey !== undefined) await bridge.configureApiKey();
    else bridge.notify("没有可用模型：先用 Pi: Set API Key 配置一个 provider", "warn");
    bridge.focusInput();
    return;
  }
  const model = models.find((raw) => modelToDialogItem(raw, currentId).label === picked);
  if (model !== undefined) {
    try {
      await bridge.applyModel(model);
    } catch (error) {
      bridge.notify(`切换模型失败（${picked}）：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  bridge.focusInput();
}

/** 在**面板内**选思考等级（S9 ①②）。 */
export async function pickThinkingLevelInPanel(bridge: PickerBridge, dialogs: DialogPanel): Promise<void> {
  const current = bridge.currentLevel();
  const supports = bridge.supportsThinking();
  const items = supports
    ? bridge.levels().map((level) => ({
        label: level,
        ...(level === current ? { description: "当前" } : {}),
      }))
    : [{ label: "当前模型不支持思考等级", description: current, detail: "换一个支持思考的模型后再试" }];
  const picked = await dialogs.open({ kind: "select", title: "jerrypi: 思考等级", current, items });
  if (picked !== undefined && supports && bridge.levels().includes(picked)) {
    try {
      bridge.applyLevel(picked);
    } catch (error) {
      bridge.notify(`切换思考等级失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  bridge.focusInput();
}

/** 打开模型选择器。 */
export async function pickModel(bridge: PickerBridge, options: { fromPanel: boolean }): Promise<void> {
  const currentId = bridge.currentModelId();
  let models: readonly unknown[];
  try {
    models = await bridge.listModels();
  } catch (error) {
    bridge.notify(`读取模型列表失败：${error instanceof Error ? error.message : String(error)}`, "error");
    if (options.fromPanel) bridge.focusInput();
    return;
  }

  // 空列表：给一条能走的下一步，而不是让 VS Code 显示"无匹配项"。
  if (models.length === 0) {
    const picked = await vscode.window.showQuickPick([NO_MODELS_ITEM], { title: "jerrypi: 选择模型" });
    if (picked === NO_MODELS_ITEM) {
      await vscode.commands.executeCommand("jerrypi.setApiKey");
    }
    if (options.fromPanel) bridge.focusInput();
    return;
  }

  const items = models.map((raw) => modelToItem(raw, currentId));
  const picked = await vscode.window.showQuickPick(items, {
    title: "jerrypi: 选择模型",
    placeHolder: currentId === "" ? "当前未选择模型" : `当前：${currentId}`,
  });
  if (picked !== undefined) {
    const index = items.indexOf(picked);
    const model = models[index];
    try {
      await bridge.applyModel(model);
    } catch (error) {
      bridge.notify(
        `切换模型失败（${(model as ModelLike).provider ?? ""}/${(model as ModelLike).id ?? ""}）：${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
    }
  }
  // **Esc 取消也要还焦点**（只写在 `if (picked)` 里会导致"取消之后光标没了"）。
  if (options.fromPanel) bridge.focusInput();
}

/** 打开思考等级选择器。 */
export async function pickThinkingLevel(
  bridge: PickerBridge,
  options: { fromPanel: boolean },
): Promise<void> {
  const current = bridge.currentLevel();
  let items: vscode.QuickPickItem[];
  if (!bridge.supportsThinking()) {
    // 不支持思考：明确说明，别弹一个空列表让人以为坏了。
    items = [
      {
        label: "$(circle-slash) 当前模型不支持思考等级",
        description: current,
        detail: "换一个支持思考的模型后再试",
      },
    ];
  } else {
    // **原样**列出 pi 给的档位：它们**可能带空洞**（flash 有 low、v4-pro 没有）。
    items = bridge.levels().map((level) => ({
      label: level === current ? `$(check) ${level}` : level,
      description: level === current ? "当前" : "",
    }));
  }

  const picked = await vscode.window.showQuickPick(items, { title: "jerrypi: 思考等级" });
  if (picked !== undefined && bridge.supportsThinking()) {
    const level = bridge.levels()[items.indexOf(picked)];
    if (level !== undefined) {
      try {
        // pi 会把等级 clamp 到模型能力；生效值由 controller 回读后广播回来。
        bridge.applyLevel(level);
      } catch (error) {
        bridge.notify(
          `切换思考等级失败：${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
  }
  if (options.fromPanel) bridge.focusInput();
}
