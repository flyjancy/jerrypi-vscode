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
