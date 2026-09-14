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
import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiModule } from "./loader";
import { MAX_SNAPSHOT_READ_BYTES, type DiffUnavailableReason } from "./filechanges";

/**
 * 一次 write 的现场记录。
 *
 * `before === null` 表示**新文件**；`failure` 表示"读旧内容这一步没成功"（文件太大 / 读失败），
 * 这时 `before/after` 不参与展示 —— 但**绝不因此让工具调用失败**（见下面的 try/catch）。
 */
export interface WriteRecord {
  toolCallId: string;
  absolutePath: string;
  before: string | null;
  after: string;
  newFile: boolean;
  failure?: DiffUnavailableReason;
}

/**
 * 写包装的接收方（S7 的 `filechanges` store 实现它；selftest 用一个小对象证明机制）。
 *
 * `record` **不允许抛错**：它跑在工具调用中间，抛了就是"记录失败把写文件也弄挂了"。
 */
export interface WriteRecorder {
  record(record: WriteRecord): void;
}

export function createCustomTools(
  pi: PiModule,
  cwd: string,
  recorder?: WriteRecorder,
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
            // 读旧内容必须在**这里**（pi 已经把 ops.writeFile 包在 `withFileMutationQueue`
            // 之内）——同一条消息里两次写同一文件时，第二次读到的正是第一次写进去的内容。
            // 放到外层 execute 里读就会跑到队列外面，两次调用会读到同一个"旧"内容。
            const snapshot = await captureBefore(absolutePath);
            await writeFile(absolutePath, content, "utf8");
            if (recorder === undefined) return;
            try {
              recorder.record({
                toolCallId,
                absolutePath,
                before: snapshot.before,
                after: content,
                newFile: snapshot.newFile,
                ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
              });
            } catch {
              // 记录失败不许影响工具调用：这里静默吞掉（Output 由 recorder 自己负责记）。
            }
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

/** 读旧内容（读不到/太大都不抛错——那是"记不了快照"，不是"写不了文件"）。 */
async function captureBefore(
  absolutePath: string,
): Promise<{ before: string | null; newFile: boolean; failure?: DiffUnavailableReason }> {
  try {
    const info = await stat(absolutePath).catch(() => undefined);
    if (info === undefined) return { before: null, newFile: true };
    if (info.size > MAX_SNAPSHOT_READ_BYTES) return { before: null, newFile: false, failure: "too-large" };
    return { before: await readFile(absolutePath, "utf8"), newFile: false };
  } catch {
    return { before: null, newFile: false, failure: "read-failed" };
  }
}
