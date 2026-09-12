// 自定义工具：同名覆盖内置 `write`。
//
// 为什么 S1 就要做这个：PLAN.md 第 6 节 S1 第 3 条点名要求——"同名覆盖内置 write"
// 这个机制有风险，要在闸门里验。
//
// 关键在于**风险到底是哪一半**：
//   内置 write 的 execute 签名是 `execute(_toolCallId, { path, content }, signal, _onUpdate, ctx)`
//   —— toolCallId 被直接丢弃；而 `createWriteToolDefinition(cwd, { operations })` 的
//   operations 在**构造时**就固定了。
//   所以 S7 真正需要的机制「外层 execute 拿到 toolCallId → 为该次调用构造捕获此 ID 的
//   operations」没法靠"构造时传 operations"验证。这里自己包一层 execute 来实现并验证它。
//
// 另外两点已核实：
//   - 覆盖 operations **不会**丢掉文件互斥队列：`withFileMutationQueue(absolutePath, …)`
//     在 createWriteToolDefinition 的 execute 内部包住 ops.mkdir 与 ops.writeFile；
//   - 路径解析是 `resolveToCwd(path, ctx?.cwd || cwd)`，ctx.cwd 优先，
//     构造时传的 cwd 只是没有 ctx 时的兜底。
import { mkdir, writeFile } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiModule } from "./loader";

/** 行为证据：证明调用真的走了我们的实现，并且按调用捕获到了 toolCallId。 */
export interface WriteProbe {
  record(toolCallId: string, absolutePath: string): void;
}

export function createCustomTools(
  pi: PiModule,
  cwd: string,
  probe?: WriteProbe,
): ToolDefinition[] {
  const base = pi.createWriteToolDefinition(cwd);

  const wrapped = {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // 关键：operations 在**本次调用内**构造，才能捕获 toolCallId。
      const perCall = pi.createWriteToolDefinition(cwd, {
        operations: {
          mkdir: (dir: string) => mkdir(dir, { recursive: true }).then(() => undefined),
          writeFile: async (absolutePath: string, content: string) => {
            probe?.record(toolCallId, absolutePath);
            await writeFile(absolutePath, content, "utf8");
          },
        },
      });
      return perCall.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } satisfies typeof base;

  // 这里必须 cast：`ToolDefinition` 的默认泛型参数是 `TSchema`（宽），而 write 定义是
  // `ToolDefinition<typeof writeSchema, undefined>`（窄），`renderCall` 在参数位置逆变，
  // 直接赋值会被 TS 拒绝。运行时形状完全一致。
  return [wrapped as unknown as ToolDefinition];
}
