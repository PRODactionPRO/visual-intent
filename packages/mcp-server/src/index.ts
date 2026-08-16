import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TaskStatusSchema } from "@visual-intent/protocol";
import { z } from "zod";

import type { TaskStore } from "@visual-intent/core";

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

export function createMcpServer(store: TaskStore): McpServer {
  const server = new McpServer({ name: "visual-intent", version: "0.1.0" });

  server.registerTool(
    "visual_intent_list_tasks",
    {
      description:
        "List visual feedback tasks captured from a running local interface.",
      inputSchema: {
        status: TaskStatusSchema.optional().describe(
          "Optional task status filter",
        ),
      },
    },
    async ({ status }) => {
      try {
        return text(await store.list(status ? { status } : undefined));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_get_task",
    {
      description:
        "Get one visual task with surface, selector, region, annotation, and revision context.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        const task = await store.get(id);
        return task
          ? text(task)
          : failure(new Error(`Task ${id} was not found`));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_update_task",
    {
      description:
        "Update task status and optionally attach a coding-agent result. Pass expectedRevision to prevent overwriting newer work.",
      inputSchema: {
        id: z.string().min(1),
        expectedRevision: z.number().int().positive().optional(),
        status: TaskStatusSchema.optional(),
        result: z
          .object({
            summary: z.string().min(1),
            changedFiles: z.array(z.string()).default([]),
            notes: z.array(z.string()).default([]),
          })
          .optional(),
      },
    },
    async ({ id, expectedRevision, status, result }) => {
      try {
        if (status === undefined && result === undefined) {
          return failure(new Error("Provide status or result"));
        }
        return text(
          await store.update(id, { expectedRevision, status, result }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export async function runMcpServer(store: TaskStore): Promise<void> {
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
