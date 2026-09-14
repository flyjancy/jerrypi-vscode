// 按 toolCallId 收集"这次调用改了什么"：`edit` 的 patch、`write` 的前后内容。
//
// 分工（为什么是这个形状，见 `docs/S7-plan.md` §3.1/§3.2/§3.6）：
//   - `edit` 的 patch 由 pi 在**工具自己的执行边界内**生成并持久化进会话文件（F1/F2），
//     所以它有两个入口：实时（toolResult 帧）与重放（`session.messages`）。
//   - `write` 没有 details（F5），前后内容只能靠我们在 `ops.writeFile` 里抓（在 pi 的
//     `withFileMutationQueue` 之内，所以两次写同一文件时第二次读到的正是第一次写的内容，F8/F9）。
//     它**只有实时那一条入口** —— 重放永远不写 snapshot。
//
// 三条纪律（都踩过或评审过）：
//   1. **失败的 edit 带 `details = {}`**（F5b，本机实测 3 条）：只有非空 `details.patch`
//      才登记；失败的那次**既不登记也不给 unavailable** —— 那不是"不可用"，是"这次没改成文件"。
//   2. **patch 可覆盖（含覆盖墓碑）**，snapshot 不需要"不覆盖"规则（它只有一个写者）。
//      第 2 轮评审 B2：patch 能从 `details.patch` 免费再生，用"已有就别动"会把被淘汰的
//      条目永久锁死 —— 而 C3 承诺的是"重启后 edit 的 diff 仍可打开"。
//   3. **条数上限只数活记录**，墓碑另算（第 2 轮评审 B1：墓碑也占条目的话，淘汰出来的
//      墓碑会让条数永远降不回去，那是写不出来的实现）。

import { patchPathOf } from "../shared/patch";

/** 打不开的原因（协议与文案共用这一套值）。 */
export type DiffUnavailableReason = "too-large" | "read-failed" | "evicted";

export type FileChange =
  | { kind: "patch"; toolCallId: string; path: string; patch: string; bytes: number; at: number }
  | {
      kind: "snapshot";
      toolCallId: string;
      path: string;
      before: string | null;
      after: string;
      newFile: boolean;
      bytes: number;
      at: number;
    }
  | { kind: "unavailable"; toolCallId: string; path: string; why: DiffUnavailableReason; at: number };

export interface FileChangeStore {
  /** `edit`：登记 patch（可覆盖，含从墓碑恢复）。 */
  recordEdit(input: { toolCallId: string; path: string; patch: string }): void;
  /** `write`：登记前后内容；读不到/太大时记 unavailable。 */
  recordWrite(input: {
    toolCallId: string;
    path: string;
    before: string | null;
    after: string;
    newFile: boolean;
    failure?: DiffUnavailableReason;
  }): void;
  get(toolCallId: string): FileChange | undefined;
  /** 断言用（条数上限只数 live —— 见文件头第 3 条）。 */
  size(): { live: number; tombstones: number };
}

export interface FileChangeOptions {
  maxPatches?: number;
  maxSnapshots?: number;
  maxPatchBytes?: number;
  maxSnapshotBytes?: number;
  /** 单条超过它就不存（记 `unavailable{too-large}`）。 */
  maxSingleBytes?: number;
  maxTombstones?: number;
}

/** 读旧内容的硬上限（`custom-tools.ts` 在 `stat` 之后按它决定读不读）。 */
export const MAX_SNAPSHOT_READ_BYTES = 2 * 1024 * 1024;

const DEFAULTS = {
  maxPatches: 100,
  maxSnapshots: 20,
  maxPatchBytes: 8 * 1024 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxSingleBytes: MAX_SNAPSHOT_READ_BYTES,
  maxTombstones: 500,
};

export function createFileChanges(options: FileChangeOptions = {}): FileChangeStore {
  const max = { ...DEFAULTS, ...options };
  // `Map` 的迭代序 = 插入序；`put` 先 delete 再 set，所以"重新登记"等于把它挪到队尾
  // （FIFO 的语义要求这个 —— 否则被救回来的 patch 还占着最旧的位置，下一次就被淘汰）。
  const records = new Map<string, FileChange>();

  const put = (record: FileChange): void => {
    records.delete(record.toolCallId);
    records.set(record.toolCallId, record);
  };

  /** 墓碑单独封顶：超了就丢最旧的墓碑（丢墓碑是安全的，见文件头第 3 条与 §3.2）。 */
  const pruneTombstones = (): void => {
    const tombs: string[] = [];
    for (const [id, record] of records) if (record.kind === "unavailable") tombs.push(id);
    for (const id of tombs.slice(0, Math.max(0, tombs.length - max.maxTombstones))) records.delete(id);
  };

  const liveOf = (kind: "patch" | "snapshot"): { count: number; bytes: number } => {
    let count = 0;
    let bytes = 0;
    for (const record of records.values()) {
      if (record.kind !== kind) continue;
      count += 1;
      bytes += record.bytes;
    }
    return { count, bytes };
  };

  /** 淘汰**同类**里最旧的活记录（变成墓碑）。没有可淘汰的返回 false。 */
  const evictOldestLive = (kind: "patch" | "snapshot"): boolean => {
    for (const [id, record] of records) {
      if (record.kind !== kind) continue;
      put({ kind: "unavailable", toolCallId: id, path: record.path, why: "evicted", at: Date.now() });
      return true;
    }
    return false;
  };

  const enforce = (kind: "patch" | "snapshot"): void => {
    const limit =
      kind === "patch"
        ? { count: max.maxPatches, bytes: max.maxPatchBytes }
        : { count: max.maxSnapshots, bytes: max.maxSnapshotBytes };
    // **只数活记录**（第 2 轮评审 B1：把墓碑也数进去，条数永远降不回来）。
    let live = liveOf(kind);
    while ((live.count > limit.count || live.bytes > limit.bytes) && evictOldestLive(kind)) {
      live = liveOf(kind);
    }
    pruneTombstones();
  };

  const recordEdit = ({ toolCallId, path, patch }: { toolCallId: string; path: string; patch: string }): void => {
    const bytes = byteLength(patch);
    if (bytes > max.maxSingleBytes) {
      put({ kind: "unavailable", toolCallId, path, why: "too-large", at: Date.now() });
      pruneTombstones();
      return;
    }
    // patch **可覆盖**（含覆盖墓碑）：它由 details.patch 唯一确定，覆盖即幂等，
    // 而且这是"被淘汰的 edit 在重放时回来"的唯一通路（第 2 轮评审 B2）。
    put({ kind: "patch", toolCallId, path, patch, bytes, at: Date.now() });
    enforce("patch");
  };

  const recordWrite = ({
    toolCallId,
    path,
    before,
    after,
    newFile,
    failure,
  }: {
    toolCallId: string;
    path: string;
    before: string | null;
    after: string;
    newFile: boolean;
    failure?: DiffUnavailableReason;
  }): void => {
    if (failure !== undefined) {
      put({ kind: "unavailable", toolCallId, path, why: failure, at: Date.now() });
      pruneTombstones();
      return;
    }
    const bytes = byteLength(before ?? "") + byteLength(after);
    if (bytes > max.maxSingleBytes) {
      // 超大：**不把内容存进来**（内存是这条上限的全部意义）。
      put({ kind: "unavailable", toolCallId, path, why: "too-large", at: Date.now() });
      pruneTombstones();
      return;
    }
    put({ kind: "snapshot", toolCallId, path, before, after, newFile, bytes, at: Date.now() });
    enforce("snapshot");
  };

  return {
    recordEdit,
    recordWrite,
    get: (toolCallId) => records.get(toolCallId),
    size: () => {
      let live = 0;
      let tombstones = 0;
      for (const record of records.values()) {
        if (record.kind === "unavailable") tombstones += 1;
        else live += 1;
      }
      return { live, tombstones };
    },
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 会话消息里我们关心的那几个字段（pi 的 `toolResult` 形状；F6 说 details 会被保留）。 */
interface MessageLike {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  details?: unknown;
}

/**
 * 重放：从 `session.messages` 里把 `edit` 的 patch 重新登记回来。
 *
 * **实时与重放共用这一个函数**（实时传最后一条 message，重放传整个列表），所以两条路径
 * 不可能各写一套。`write` 不在这里 —— 它没有持久化的 details（F5），它的"可用/不可用"
 * 由 `diffFieldsOf` 从 store 派生。
 */
export function recordEditsFromMessages(messages: readonly MessageLike[], store: FileChangeStore): void {
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    if (message.role !== "toolResult" || message.toolName !== "edit") continue;
    const details = message.details as { patch?: unknown } | undefined;
    const patch = details?.patch;
    // 失败的 edit 是 `details = {}`（F5b）—— 那不是"不可用"，是"这次没改成文件"：不登记。
    if (typeof patch !== "string" || patch === "") continue;
    const toolCallId = message.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId === "") continue;
    store.recordEdit({ toolCallId, path: patchPathOf(patch), patch });
  }
}

/**
 * 工具卡片上的 diff 字段（协议用）。
 *
 * `pending` 的卡片什么都不给 —— 那时候 store 里当然还没有记录，不看 pending 就会在卡片
 * 刚出现时闪一句「本次会话不可用」。
 */
export function diffFieldsOf(
  store: FileChangeStore,
  tool: { toolCallId: string; toolName: string; isError: boolean; pending: boolean },
): { diff?: "patch" | "snapshot"; diffUnavailable?: DiffUnavailableReason | "none" } {
  if (tool.pending) return {};
  if (tool.toolName !== "edit" && tool.toolName !== "write") return {};
  const record = store.get(tool.toolCallId);
  if (record !== undefined) {
    return record.kind === "unavailable" ? { diffUnavailable: record.why } : { diff: record.kind };
  }
  // 失败的那次调用没改成文件（F5b）：两个字段都缺席，界面上什么都不显示。
  if (tool.isError) return {};
  // 成功的 write 在重启后走这里（重放拿不到它的前后内容）；成功的 edit 理论上必有 patch。
  return { diffUnavailable: "none" };
}
