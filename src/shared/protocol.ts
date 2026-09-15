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

export const PROTOCOL_VERSION = 6;

/**
 * 当前会话的**元信息**（模型 / 思考等级 / 上下文用量），显示在输入框下方那一行。
 *
 * 为什么把 `contextWindow` 放在**顶层**而不是塞进 `contextUsage` 里：
 * `contextUsage` 可以是 `null`（见下），那时前端仍需要知道窗口大小才能显示 `?/1.0M`。
 * pi 自己在 usage 未知时也是拿 `model.contextWindow` 兜底的。
 *
 * **两种“没有用量”是不同状态，协议层面分开**：
 *   - `contextUsage === null`：根本没有可用量信息 —— 没有模型，或模型的 `contextWindow <= 0`
 *     （此时 `contextWindow` 必为 `0`，前端走“未选择模型”文案，**不渲染 `?/0`**）；
 *   - `contextUsage.percent === null`：用量未知但窗口知道 —— pi 的“刚压缩、还没等到下一次回复”
 *     状态，前端显示 `?/1.0M`（**注意没有百分号**，这与 `NN.N%/1.0M` 是两个分支）。
 */
export interface SessionMeta {
  /** `"provider/id"`；未选择模型时为空串。 */
  model: string;
  /** 供 tooltip 用；行内只渲染 `id`。 */
  provider: string;
  /** 模型目录里的 `Model.name`（可能比 id 可读）。 */
  modelName: string;
  /** 思考等级：`off|minimal|low|medium|high|xhigh|max`（pi 会 clamp，**只信回读值**）。 */
  thinkingLevel: string;
  /** `!!model?.reasoning`。**false 时不要去看等级列表**，否则会拿到 7 个假档位。 */
  supportsThinking: boolean;
  /** 模型上下文窗口；无模型时为 `0`。 */
  contextWindow: number;
  /** 见上面两种 null 状态的区别。 */
  contextUsage: { tokens: number | null; percent: number | null } | null;
  /**
   * 当前会话本身的信息（S5 的 D8）。
   *
   * `path` 在**尚未落盘**时是空串（pi 在首条 assistant 消息之后才建文件），那时的 `name`
   * 是占位（"新会话"）、`persisted` 为 false；面板会在名字后面标一句"未保存"，
   * 否则用户会以为"名单里找不到刚建的会话"是 bug。
   */
  session: { path: string; name: string; persisted: boolean };
}

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
      /**
       * 结果正文（已净化、可能已按 `TOOL_TEXT_MAX_BYTES` 裁剪）。
       *
       * **语义是"整体替换"**，不是增量：bash 每次 `tool_execution_update` 给的是
       * **累积快照**（实测 update#2 = 2 行、#3 = 6 行…），把它当增量拼接会得到
       * `line-1line-1line-2…`。而且超过 50KB 后快照会**换头**（保留最后 50KB），
       * 所以也不能假定"内容只增不减"（见 docs/S3-plan.md §0.2）。
       */
      text?: string;
      /** true 表示正文被**我们自己的上限**裁过（区别于 pi 自己的截断）。 */
      textTruncated?: boolean;
      /**
       * pi 自己的截断摘要。**只取标量**：pi 的 `details.truncation` 里还有一个
       * `content` 字段（又装了一份 50KB 文本），整体透传会让协议体积翻倍。
       */
      truncation?: {
        truncatedBy: "lines" | "bytes";
        totalLines: number;
        outputLines: number;
        maxBytes?: number;
      };
      /** bash 截断时完整输出的临时文件路径（也是可点路径之一）。 */
      fullOutputPath?: string;
      /**
       * 能不能打开这次调用的 diff（S7）。
       *
       * `patch` = `edit`（会话文件里持久化的 `details.patch`）；`snapshot` = `write`（前后
       * 内容只在**本次进程**的内存里）。**没有这个字段**也可能是"不可用"，见下一项。
       */
      diff?: "patch" | "snapshot";
      /**
       * 打不开的原因（**只在工具已结束、且没有可打开的 diff 时**才有）。
       *
       * 四值各有各的文案 —— 一个布尔装不下"为什么"（S7 第 2 轮评审 S1）。
       * `none` = store 里没有这次调用的记录（重启后的 `write` 走这档）。
       */
      diffUnavailable?: "evicted" | "too-large" | "read-failed" | "none";
      /**
       * 工具审批（S8）。
       *
       * `pending` = 这次调用正等着用户答（卡片上给「允许 / 拒绝」）；`denied` = 被拒绝过
       * （工具已结束时**仍保留**，留一条可回溯的标记）。**放行与取消都不派生** ——
       * 取消时 pi 给模型看的是 `Operation aborted`，我们再标一句只会让人以为是我们干的。
       */
      approval?: "pending" | "denied";
      /**
       * 卡片标题（照 pi 的 call 行）：`~/a.ts:10-20`、`命令 (timeout 30s)`…
       *
       * `link` 是标题里**可点击的那一段**：`text` 是显示形态（家目录缩成 `~`），
       * `path` 是解析后的绝对路径（白名单的键）—— 两者必须分开，
       * 因为白名单比对的是绝对路径。
       */
      title?: { text: string; link?: { text: string; path: string } };
      /**
       * 本条卡片里**可点击打开**的绝对路径。
       *
       * 由序列化器铸造、控制器登记成白名单；host 收到 `openFile` 时**只做精确字符串比对**。
       * 传路径而不是 `file://` URL：`Uri.parse("/tmp/a#b.log")` 会把 `#` 当 fragment。
       */
      openablePaths?: string[];
      /** 开始/结束时间（ms epoch）。**只在实时路径有**：重放时不编造。 */
      startedAt?: number;
      endedAt?: number;
    }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

/** webview → 扩展 */
export type ClientMessage =
  | { type: "ready"; protocol: number }
  | { type: "requestState" }
  | { type: "prompt"; text: string; behavior: "auto" | "steer" | "followUp" }
  | { type: "abort" }
  | { type: "clearQueue" }
  | { type: "openExternal"; href: string }
  /** 打开工具卡片里的文件路径。host 会用控制器的白名单做精确比对。 */
  | { type: "openFile"; path: string }
  /** 打开这次工具调用的 diff（host 侧查 filechanges 的白名单）。 */
  | { type: "openDiff"; toolCallId: string }
  /** 打开模型选择器（QuickPick 在**宿主**侧，不在 webview 里自绘）。 */
  | { type: "openModelPicker" }
  /** 打开思考等级选择器。 */
  | { type: "openThinkingPicker" }
  /** 打开会话选择器（QuickPick 在**宿主**侧，与模型选择器同一个理由）。 */
  | { type: "openSessionPicker" }
  /**
   * 回答了某次待审批的工具调用（S8）。
   *
   * 只带 toolCallId 与决定 —— 白名单在 controller 的审批表里（"这条 id 现在真的在等吗"），
   * 面板说什么不算数。未知/过期的 id 会被拒并记一行 Output。
   */
  | { type: "approvalDecision"; toolCallId: string; decision: "allow" | "deny" };

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
      /** 模型 / 思考等级 / 上下文用量，加上当前会话的信息（S5 起）。 */
      meta: SessionMeta;
      errorMessage?: string;
    }
  /** upsert：id 已存在则替换，不存在则按顺序追加。 */
  | { type: "item"; item: ChatItem }
  /**
   * 元信息整块替换（不做增量）。
   *
   * 前端处理它时**不得滚动转写**：滚动跟随的正确条件是“转写内容变了”，
   * 而 meta 的变化不改内容（见 S4 的 R10）。
   */
  | { type: "meta"; meta: SessionMeta }
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
  | { type: "restoreComposer"; text: string }
  /**
   * 把焦点还给输入框。
   *
   * 只在**从面板发起**的流程（点模型/等级段 → QuickPick 关闭）里发；
   * 从命令面板发起时不发 —— 那时用户的焦点可能在编辑器里，抢焦点是 bug。
   * 两条退出路径（选中 / Esc 取消）都要发。
   */
  | { type: "focusInput" };

/** 重放时的总量上限（防止一个长会话把 webview 灌爆）。 */
export const MAX_REPLAY_ITEMS = 500;
/**
 * 重放正文的总量上限，**按 UTF-8 字节**。
 *
 * 名字从 `MAX_REPLAY_CHARS` 改成 `MAX_REPLAY_BYTES` 是 S3 的事：旧名字说"字符"、
 * 旧实现按 `String.length` 算，而 bash 单条结果可达 51KB —— 在中文会话里
 * 按字符算会把预算低估三倍（50K 个汉字是 150KB）。
 */
export const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

/** 工具行参数摘要的长度上限。 */
export const SUMMARY_MAX = 200;

/**
 * 单条工具结果正文的上限（UTF-8 字节）。
 *
 * 必须**大于** pi 自己的上限：pi 把正文裁到 50KB 之后**还会追加一行脚注**
 * （实测最长 51,343 字符），取 50KB 会把那行脚注裁掉。64KB 留足余量，
 * 内置工具的结果永远不会被我们二次裁剪；只有"返回超大文本的扩展工具"会触发。
 */
export const TOOL_TEXT_MAX_BYTES = 64 * 1024;

/** bash 卡片折叠时显示的行数（照 pi 的 `BASH_PREVIEW_LINES`）。 */
export const TOOL_PREVIEW_LINES = 5;

/** 工具行流式 upsert 的合并窗口（ms）。 */
export const TOOL_FRAME_MS = 200;
