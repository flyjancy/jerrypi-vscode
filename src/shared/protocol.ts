// webview 与扩展宿主之间的**唯一**契约。
//
// 两端都只 import 这一个文件里的类型，任何一侧改字段都必须同时改另一侧
// （TypeScript 的联合类型会替我们抓住漏改）。
//
// 三个容易搞错的地方，都在这里定死：
//
//   1. `item` 是 **upsert**（按 id 找，找到就替换、找不到就新建）。因为 pi 对
//      toolResult 之类的消息**只发 `message_end`、不发 `message_start`**，而
//      进行中的 assistant 又只有 `message_start`。upsert 让两种情况都能落地。
//   2. **id 只有一个权威来源**（扩展侧的 controller）。同一实体在它的整个生命周期里
//      id 不得改变：进行中的 assistant 用 `activeAssistantId`（结束时也必须沿用），
//      工具行用 `tool-<toolCallId>`，历史消息用 `msg-<下标>`，
//      运行时提示用 `notice-<递增序号>`（**不能用 `msg-` 前缀**：提示不是消息、
//      没有下标，与刚结束的消息撞下标会把真实回复整条替换掉）。
//   3. `busy` 的判定：**空闲以 `agent_settled` 为准**，不能以第一个 `agent_end`
//      （`agent_end` 之后可能还有 followUp 队列或自动重试）。

export const PROTOCOL_VERSION = 1;

/** 转写里的一条可渲染项。 */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      thinking: string;
      stopReason: string;
      errorMessage?: string;
      /** true 表示这条还在流式接收中。 */
      streaming?: boolean;
    }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      /** 参数摘要；执行中时前端会显示成固定的"运行中…"。 */
      summary: string;
      isError: boolean;
      /** true 表示这次调用还在执行中（重放时为 pendingToolCalls 里的项）。 */
      pending?: boolean;
    }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

/** webview → 扩展 */
export type ClientMessage =
  | { type: "ready"; protocol: number }
  | { type: "requestState" }
  | { type: "prompt"; text: string; behavior: "auto" | "steer" | "followUp" }
  | { type: "abort" }
  | { type: "clearQueue" }
  | { type: "openExternal"; href: string };

/** 扩展 → webview */
export type ServerMessage =
  | {
      type: "state";
      protocol: number;
      items: ChatItem[];
      /** true 表示更早的消息因超出上限被省略。 */
      truncated: boolean;
      queue: { steering: string[]; followUp: string[] };
      busy: boolean;
      cwd: string;
      model: string;
      errorMessage?: string;
    }
  /** upsert：id 已存在则替换，不存在则按顺序追加。 */
  | { type: "item"; item: ChatItem }
  | { type: "delta"; id: string; kind: "text" | "thinking"; delta: string }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "busy"; busy: boolean; errorMessage?: string }
  /**
   * 这条消息**已被 pi 接受**（入队或开始处理）。
   *
   * 为什么需要它：pi 的 `prompt()` 要到**整轮结束**才 resolve，而 steer/followUp
   * 可能在队列里躺很久 —— 光靠"回显"或"promise settle"判断"发出去了没有"都会把
   * 用户的下一条消息卡住（实测：队列里有一条时，第二条点「排队」毫无反应）。
   * 这个信号来自 pi 的 `preflightResult` 回调，是所有接受路径（扩展命令 / 入队 /
   * 正常发起）都会走的同一个点。
   */
  | { type: "promptAccepted" }
  /** 失败提示：输入框下方的红字。 */
  | { type: "composerError"; text: string }
  /** 把文本**退回**输入框（中止时清队列的产物；不是错误）。 */
  | { type: "restoreComposer"; text: string };

/** 重放时的总量上限（防止一个长会话把 webview 灌爆）。 */
export const MAX_REPLAY_ITEMS = 500;
export const MAX_REPLAY_CHARS = 1_000_000;

/** 工具行参数摘要的长度上限。 */
export const SUMMARY_MAX = 200;
