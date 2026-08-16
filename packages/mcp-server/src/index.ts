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
    "visual_intent_list_batches",
    {
      description: "List Visual Intent Apply batches and execution statuses.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await store.listBatches());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_retry_batch",
    {
      description:
        "Retry a Visual Intent batch after its needs-input condition or execution failure has been resolved.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        return text(await store.retryBatch(id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_claim_batch",
    {
      description:
        "Atomically claim one queued Visual Intent Apply batch before editing its server-owned repository.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        return text(await store.claimBatch(id));
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
    "visual_intent_finish_batch",
    {
      description:
        "Finish a claimed Visual Intent batch and persist its implementation result.",
      inputSchema: {
        id: z.string().min(1),
        status: z.enum(["completed", "needs_input", "failed"]),
        summary: z.string().min(1),
        changedFiles: z.array(z.string()).default([]),
        notes: z.array(z.string()).default([]),
      },
    },
    async ({ id, status, summary, changedFiles, notes }) => {
      try {
        return text(
          await store.finishBatch(id, status, {
            summary,
            changedFiles,
            notes,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_update_task",
    {
      description:
        "Update task instruction, status, or implementation result. Pass expectedRevision to prevent overwriting newer work.",
      inputSchema: {
        id: z.string().min(1),
        expectedRevision: z.number().int().positive().optional(),
        instruction: z.string().trim().min(1).optional(),
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
    async ({ id, expectedRevision, instruction, status, result }) => {
      try {
        if (
          instruction === undefined &&
          status === undefined &&
          result === undefined
        ) {
          return failure(new Error("Provide instruction, status, or result"));
        }
        return text(
          await store.update(id, {
            expectedRevision,
            instruction,
            status,
            result,
          }),
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
