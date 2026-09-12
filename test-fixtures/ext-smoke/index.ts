// jerrypi 打包验收夹具（不是给用户使用的功能）。
//
// 用途：S0 的校验 ⑦（`scripts/verify-isolated-runtime.mjs`）在隔离目录里通过 pi 的真实
// 扩展加载链路（jiti + bundle 的 virtualModules）加载本文件；S1 的自测 T3 进一步用它覆盖
// "扩展命令通路"与"扩展 onError 通路"。
//
// 标记文件（都通过环境变量指定，未设置时静默跳过，避免污染用户环境）：
//   JERRYPI_SMOKE_MARKER          session_start 时追加 "session_start"
//   JERRYPI_SMOKE_COMMAND_MARKER  每个命令执行时追加命令名
//
// 为什么命令要**先写标记再调 UI**：notify 在 no-op UI 下什么都不会发生，
// 没有标记就无法证明命令真的执行过。
//
// 依赖说明：`@earendil-works/pi-coding-agent` 与 `typebox` 都由 bundle 的
// virtualModules 提供，不需要出现在 pi-runtime/node_modules 里。
import { appendFileSync } from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function appendMarker(path: string | undefined, value: string): void {
  if (path === undefined || path.length === 0) {
    return;
  }
  appendFileSync(path, `${value}\n`);
}

export default function extSmoke(pi: ExtensionAPI): void {
  pi.registerCommand("smoke", {
    description: "jerrypi packaging smoke test",
    handler: async (_args, ctx) => {
      appendMarker(process.env.JERRYPI_SMOKE_COMMAND_MARKER, "smoke");
      ctx.ui.notify("jerrypi: smoke ok", "info");
    },
  });

  pi.registerCommand("smoke-custom", {
    description: "jerrypi packaging smoke test (ui.custom path)",
    handler: async (_args, ctx) => {
      appendMarker(process.env.JERRYPI_SMOKE_COMMAND_MARKER, "smoke-custom");
      // 自测宿主没有真实 UI：这里会抛出可控错误，用来覆盖扩展的 onError 通路。
      await ctx.ui.custom(() => ({ render: () => [] }));
    },
  });

  pi.registerTool(
    defineTool({
      name: "smoke_tool",
      label: "Smoke Tool",
      description: "jerrypi packaging smoke test tool",
      parameters: Type.Object({
        message: Type.Optional(Type.String({ description: "Optional message to echo back" })),
      }),
      async execute(_toolCallId, params) {
        return {
          content: [
            {
              type: "text" as const,
              text: `jerrypi: smoke tool ok${params.message ? ` (${params.message})` : ""}`,
            },
          ],
          details: {},
        };
      },
    }),
  );

  // 仅当显式设置标记路径时才写文件。
  pi.on("session_start", async () => {
    appendMarker(process.env.JERRYPI_SMOKE_MARKER, "session_start");
  });
}
