// 数字格式化：**照抄 pi 的语义**，不自己发明。
//
// 为什么照抄：这些串要和 pi 的 TUI 看起来一致（`1.0M`、`1000k`），
// 而"凭印象写一个差不多的"必然差一个 `toFixed` —— 实测就有两个反直觉的边界：
//
//   formatTokens(999999)  === "1000k"   （<1e6 走取整的 k 分支，不是 "1.0M"）
//   formatTokens(9999)    === "10.0k"   （<1e4 保留一位小数，不是 "10k"）
//
// 出处：`pi-coding-agent/dist/modes/interactive/components/footer.js` 的 `formatTokens()`。
// 它**没有**从 bundle 导出（我们运行期只加载 `pi-runtime/dist/bundle/index.js`，
// 而包的 `exports` map 又不允许深导入 `dist/modes/...`），所以只能照抄。
// 边界值由 `scripts/tool-text-check.mjs` 断言。

const KILO = 1000;
const MEGA = 1000 * 1000;

/** 与 pi 的 `formatTokens()` 逐分支一致。 */
export function formatTokens(count: number): string {
  if (count < KILO) return count.toString();
  if (count < 10 * KILO) return `${(count / KILO).toFixed(1)}k`;
  if (count < MEGA) return `${Math.round(count / KILO)}k`;
  if (count < 10 * MEGA) return `${(count / MEGA).toFixed(1)}M`;
  return `${Math.round(count / MEGA)}M`;
}

/**
 * 上下文用量的显示串。
 *
 * 两种"没有数字"是**不同状态**，显示也不同（照 pi 的分支）：
 *   - `percent === null`（压缩后、还没有新的回复）→ `?/1.0M` —— **注意没有百分号**；
 *   - `contextWindow <= 0`（没有模型）→ 空串，调用方应改显示"未选择模型"（**不要** `?/0`）。
 */
export function formatContextUsage(percent: number | null, contextWindow: number): string {
  if (contextWindow <= 0) return "";
  if (percent === null) return `?/${formatTokens(contextWindow)}`;
  return `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
}

/** 价格（USD / 1M tokens，见 `pi-ai/dist/models.js` 的 `rates / 1000000 * tokens`）。 */
export function formatCost(input: number | undefined, output: number | undefined): string {
  if (input === undefined || output === undefined) return "";
  return `$${input}/$${output} / 1M tokens`;
}

/** 会话名的长度上限（超过就截断 + 省略号）。 */
export const SESSION_NAME_MAX = 60;

/**
 * 会话显示名（S5 的 D8/D11）。
 *
 * 优先用 `session_info` 里的名字（pi 的 `--name` 与 TUI 的重命名都写它），
 * 其次用首条 **user** 消息（`SessionInfo.firstMessage` 就是这个，pi 自己算的），
 * 都没有则给一个能看懂的占位。
 *
 * **必须单行化**：它要进 QuickPick 的 `label` 与元信息行，里面有换行会把版式弄乱；
 * 而这个名字是**别人写的**（模型能往会话文件里写 user 消息），所以外面还要 escapeHtml。
 */
export function sessionDisplayName(name: string | undefined, firstMessage: string): string {
  const single = (text: string): string => text.replace(/\s+/g, " ").trim();
  const explicit = name === undefined ? "" : single(name);
  if (explicit.length > 0) return truncateName(explicit);
  const first = single(firstMessage);
  // pi 在一条消息都没有时给的是这个占位串（`session-manager.js:508`）。
  if (first.length === 0 || first === "(no messages)") return "新会话";
  return truncateName(first);
}

function truncateName(text: string): string {
  return text.length <= SESSION_NAME_MAX ? text : `${text.slice(0, SESSION_NAME_MAX)}…`;
}

/**
 * 会话时间（S5 的 D11）。`now` 显式传入 —— 不读系统时钟，否则测不了。
 *
 * 分档：刚刚 / N 分钟前 / N 小时前 / 今天 HH:MM / 昨天 HH:MM / M月D日 / YYYY年M月D日。
 * 判"今天/昨天"按**本地日历日**，不是按 24 小时差。
 */
export function formatSessionTime(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return formatClock(then, now);       // 钟表飘了：当今天处理，不写"刚刚"
  if (diffMs < 60_000) return "刚刚";
  if (diffMs < 60 * 60_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  const days = calendarDaysBetween(then, now);
  if (days === 0) return formatClock(then, now);
  if (days === 1) return `昨天 ${formatClock(then, now)}`;
  if (then.getFullYear() === now.getFullYear()) return `${then.getMonth() + 1}月${then.getDate()}日`;
  return `${then.getFullYear()}年${then.getMonth() + 1}月${then.getDate()}日`;
}

function formatClock(date: Date, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return calendarDaysBetween(date, now) === 0 ? `今天 ${hhmm}` : hhmm;
}

/** 两个时间相差几个**本地日历日**（用当天 00:00 比，避开时区与夏令时）。 */
function calendarDaysBetween(then: Date, now: Date): number {
  const midnight = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((midnight(now) - midnight(then)) / (24 * 60 * 60 * 1000));
}

/**
 * pi 的 `AuthStatus.source` → 一句人话（S6-plan §3.3 / §0.2 F18：**是 6 档不是 3 档**）。
 *
 * 为什么抽成纯函数：那四档（models_json_key / models_json_command / fallback / environment）
 * 在集成层造不出来（唯一的产地是 pi 的 `provider-composer.js`），而在纯函数层可以 6 个输入
 * 6 个输出地断言 —— 能红、零夹具（S6-plan §6 的 A6 / §10 第 4 轮 S4）。
 */
export function describeAuthSource(source: string | undefined): string {
  switch (source) {
    case "runtime":
      return "已配置（面板保存的 key）";
    case "stored":
      return "已配置（pi 的 auth.json）";
    case "models_json_key":
      return "已配置（models.json 里写的 key）";
    case "models_json_command":
      return "已配置（models.json 里配的命令）";
    case "fallback":
      return "已配置（provider 自带）";
    case "environment":
      return "已配置（环境变量）";
    default:
      return "未配置";
  }
}
