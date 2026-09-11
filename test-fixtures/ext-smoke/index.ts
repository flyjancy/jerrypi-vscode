// jerrypi 打包验收夹具（不是给用户使用的功能）。
//
// 用途：`scripts/verify-isolated-runtime.mjs` 的校验 ⑦ 会在**隔离目录**里
// 通过 pi 的真实扩展加载链路（jiti + bundle 的 virtualModules）加载本文件，
// 断言扩展无错误、`smoke` 命令已注册。它随 .vsix 一起发布，因此
// 「从解包产物复跑校验」才有意义（详见 docs/S0-plan.md §5.4）。
//
// 依赖说明：`@earendil-works/pi-coding-agent` 与 `typebox` 都由 bundle 的
// virtualModules 提供，不需要出现在 pi-runtime/node_modules 里。
import { writeFileSync } from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function extSmoke(pi: ExtensionAPI): void {
  pi.registerCommand("smoke", {
    description: "jerrypi packaging smoke test",
    handler: async (_args, ctx) => {
      ctx.ui.notify("jerrypi: smoke ok", "info");
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
          content: [{ type: "text" as const, text: `jerrypi: smoke tool ok${params.message ? ` (${params.message})` : ""}` }],
          details: {},
        };
      },
    }),
  );

  // 仅当显式设置 JERRYPI_SMOKE_MARKER 时写标记文件，避免污染用户环境。
  pi.on("session_start", async () => {
    const marker = process.env.JERRYPI_SMOKE_MARKER;
    if (marker) {
      writeFileSync(marker, "smoke\n");
    }
  });
}
