// S9 ①②：面板内对话框的宿主侧。
//
// 它替掉的是 `uiContext.ts` 里"直接弹原生控件"的那一段：竞争骨架（信号 / 超时 /
// Cancel 的 Promise.race）**原样保留**，只把 `open()` 从"原生控件"换成
// "post `dialog/open` + 等 `dialog/answer`"。
//
// 三条从评审来的硬要求（S9-plan §3.8 / R14 / R15）：
//
//   1. **就绪 / 重放 / 回答路由必须独立于 `controller.ensure()`**（Astra B1）。否则
//      "初始化期间某个 session_start 处理器挂起在对话框上 → 销毁视图 → 重开"会死锁：
//      ensure 等回答、回答的重放等 ensure。所以 DialogHost 自持 post 通道，不碰 controller。
//   2. **销毁不结算**（对齐 S8 Q10）：视图销毁只断开 post 通道（由调用方把 post 变成空操作），
//      pending 留在表里，重开时 `replay()` 再发一遍 —— 与会话终止（`cancelAll`）是两回事。
//   3. **晚到的回答按 dialogId 丢弃**：已结算的挂起重演就是 R1/R2 那类"结算改写"事故的镜像。
//      `answer()` / `fail()` / `update()` 都先查 pending 表，查不到就只记一行，绝不 resolve。
import type { DialogCloseReason, DialogItem, DialogKind, ServerMessage } from "../shared/protocol";

export interface DialogOpenOptions {
  kind: DialogKind;
  title: string;
  message?: string;
  items?: DialogItem[];
  /** 当前项（`✓` 前缀由渲染层加；这里只带原始 label）。 */
  current?: string;
  placeholder?: string;
  loading?: boolean;
  /** 取消信号（pi 的 `ctx.ui.*` 会传）：abort ⇒ 结算成 `cancelled` 并取 fallback。 */
  signal?: AbortSignal;
  /** 超时（pi 的 `DialogOptions.timeout`）：到点 ⇒ 结算成 `timeout` 并取 fallback。 */
  timeout?: number;
}

/**
 * 面板内对话框的**窄接口**（`DialogHost` 天然满足它）。
 *
 * 取窄接口是为了让选择器能单测（host-check 给一个真 `DialogHost` + 桩 webview），
 * 也为了让 `modelPicker` / `sessionPicker` 不认识 vscode / webview。
 */
export interface DialogPanel {
  start(options: DialogOpenOptions): { dialogId: string; result: Promise<string | undefined> };
  update(dialogId: string, patch: Partial<DialogOpenOptions>): boolean;
  fail(dialogId: string): boolean;
  isPending(dialogId: string): boolean;
  open(options: DialogOpenOptions): Promise<string | undefined>;
}

export interface DialogHostOptions {
  /** 把消息发给**当前**可见的 webview（没有视图时应为空操作 —— 不抛）。 */
  post: (message: ServerMessage) => void;
  /** 有新对话框挂起时喊一声（面板不可见时用；可见时调用方只记 Output）。 */
  announce?: (pending: { dialogId: string; title: string }) => void;
  log?: { appendLine(line: string): void };
}

interface PendingDialog {
  dialogId: string;
  options: DialogOpenOptions;
  resolve: (value: string | undefined) => void;
  settled: boolean;
  cleanup: () => void;
}

export class DialogHost {
  private readonly pending = new Map<string, PendingDialog>();
  private seq = 0;

  constructor(private readonly options: DialogHostOptions) {}

  /** 有没有这条还在等（宿主侧的"发送前查 pending"，A35④）。 */
  isPending(dialogId: string): boolean {
    return this.pending.has(dialogId);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * 打开一个对话框，拿到 `{dialogId, result}`。
   *
   * 需要 `dialogId` 的调用方（模型列表要 `update`、加载失败要 `fail`）用这个；
   * 只等答案的用 `open()`。
   */
  start(options: DialogOpenOptions): { dialogId: string; result: Promise<string | undefined> } {
    // 进来时已经 abort：直接取消，**连 post 都不发**（S8 审批同款口径）。
    if (options.signal?.aborted === true) {
      return { dialogId: "", result: Promise.resolve(undefined) };
    }
    const dialogId = `dialog-${++this.seq}`;
    const result = new Promise<string | undefined>((resolve) => {
      const pending: PendingDialog = { dialogId, options, resolve, settled: false, cleanup: () => {} };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      pending.cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (): void => {
        this.settle(dialogId, undefined, "cancelled");
      };
      if (options.signal !== undefined) {
        onAbort = cancel;
        options.signal.addEventListener("abort", cancel, { once: true });
      }
      if (options.timeout !== undefined) {
        timer = setTimeout(() => this.settle(dialogId, undefined, "timeout"), options.timeout);
      }
      this.pending.set(dialogId, pending);
      this.post(dialogId, options);
      this.options.announce?.({ dialogId, title: options.title });
    });
    return { dialogId, result };
  }

  /**
   * 打开一个对话框并等回答。
   *
   * 返回 `undefined` 表示"被取消 / 超时 / 会话切换"—— 调用方各自取自己的 fallback
   * （`uiContext` 的 select/input 取 undefined、confirm 取 false）。
   */
  open(options: DialogOpenOptions): Promise<string | undefined> {
    return this.start(options).result;
  }

  /** 同 `dialogId` 二次 open = 内容更新（加载态 → 有 items）；已结算就丢弃（A35④）。 */
  update(dialogId: string, patch: Partial<DialogOpenOptions>): boolean {
    const pending = this.pending.get(dialogId);
    if (pending === undefined || pending.settled) {
      this.options.log?.appendLine(`[dialog] 丢弃晚到的内容更新（${dialogId} 已结算）`);
      return false;
    }
    pending.options = { ...pending.options, ...patch };
    this.post(dialogId, pending.options);
    return true;
  }

  /** 列表加载失败之类的宿主侧收尾：撤卡 + 取 fallback（A35 的第三态）。 */
  fail(dialogId: string, reason: Extract<DialogCloseReason, "load-failed"> = "load-failed"): boolean {
    return this.settle(dialogId, undefined, reason);
  }

  /** 面板发来的回答。未知 / 已结算的 dialogId 一律丢弃（只记一行）。 */
  answer(dialogId: string, answer: { value?: string; cancelled?: true }): boolean {
    const pending = this.pending.get(dialogId);
    if (pending === undefined || pending.settled) {
      this.options.log?.appendLine(`[dialog] 丢弃晚到的回答（${dialogId} 已结算）`);
      return false;
    }
    const cancelled = answer.cancelled === true;
    return this.settle(dialogId, cancelled ? undefined : answer.value, cancelled ? "cancelled" : "answered");
  }

  /**
   * 重开面板时把**还在等**的对话框再发一遍。
   *
   * 载荷就是当初那份 `options` —— 它**从来不含**用户输入过的东西（A29 的泄漏面）。
   */
  replay(): void {
    for (const pending of this.pending.values()) {
      this.post(pending.dialogId, pending.options);
    }
  }

  /** 会话切换 / 控制器销毁：把所有挂起项结算成取消。**视图销毁不走这里**（Q10）。 */
  cancelAll(reason: Extract<DialogCloseReason, "replaced" | "cancelled"> = "replaced"): number {
    const ids = [...this.pending.keys()];
    for (const dialogId of ids) this.settle(dialogId, undefined, reason);
    return ids.length;
  }

  private settle(dialogId: string, value: string | undefined, reason: DialogCloseReason): boolean {
    const pending = this.pending.get(dialogId);
    if (pending === undefined || pending.settled) return false;
    pending.settled = true;
    pending.cleanup();
    this.pending.delete(dialogId);
    // 先撤卡再 resolve：resolve 可能连锁触发下一件事（例如 setModel），
    // 先让前端把这张卡处理掉，避免"动作发生了、卡还在"。
    this.options.post({ type: "dialog/close", dialogId, reason });
    pending.resolve(value);
    return true;
  }

  private post(dialogId: string, options: DialogOpenOptions): void {
    this.options.post({
      type: "dialog/open",
      dialogId,
      kind: options.kind,
      title: options.title,
      ...(options.message === undefined ? {} : { message: options.message }),
      ...(options.items === undefined ? {} : { items: options.items }),
      ...(options.current === undefined ? {} : { current: options.current }),
      ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
      ...(options.loading === undefined ? {} : { loading: options.loading }),
    });
  }
}
