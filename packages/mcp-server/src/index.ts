import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AttachmentSchema,
  BatchUsageSchema,
  ObservedOperationsSchema,
  TaskClassificationSchema,
  TaskStatusSchema,
} from "@visual-intent/protocol";
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

async function assertHostControlledBatch(
  store: TaskStore,
  id: string,
): Promise<void> {
  const batch = await store.getBatch(id);
  if (!batch) throw new Error(`Batch ${id} was not found`);
  if (batch.executorOwnership === "visual-intent-owned") {
    throw new Error(
      `Batch ${id} belongs to the local Visual Intent SDK worker and cannot be claimed or finished by a host-attached agent`,
    );
  }
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
    "visual_intent_list_executions",
    {
      description:
        "List append-only Apply execution receipts, including exact batch usage when an executor reported it.",
      inputSchema: {
        since: z.iso.datetime().optional(),
        batchId: z.string().min(1).optional(),
      },
    },
    async ({ since, batchId }) => {
      try {
        return text(await store.listExecutions({ since, batchId }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_list_events",
    {
      description:
        "List local privacy-safe Visual Intent lifecycle events for product analytics.",
      inputSchema: { since: z.iso.datetime().optional() },
    },
    async ({ since }) => {
      try {
        return text(await store.listEvents({ since }));
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
      inputSchema: {
        id: z.string().min(1),
        answer: z.string().trim().min(1).max(12_000).optional(),
      },
    },
    async ({ id, answer }) => {
      try {
        return text(await store.retryBatch(id, { answer }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_approve_dirty_batch",
    {
      description:
        "Approve one needs-input Apply batch to continue over the exact dirty-worktree baseline shown to the user. Use only after explicit user approval.",
      inputSchema: {
        id: z.string().min(1),
        expectedBaselineFingerprint: z.string().min(1),
      },
    },
    async ({ id, expectedBaselineFingerprint }) => {
      try {
        return text(
          await store.approveDirtyBatch(id, {
            expectedBaselineFingerprint,
            source: "mcp",
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_claim_batch",
    {
      description:
        "Atomically claim one host-attached waiting Visual Intent Apply batch before editing its server-owned repository. Autonomous SDK-worker batches cannot be claimed through MCP.",
      inputSchema: {
        id: z.string().min(1),
        controllerThreadId: z.string().min(1),
      },
    },
    async ({ id, controllerThreadId }) => {
      try {
        await assertHostControlledBatch(store, id);
        return text(await store.claimBatch(id, { controllerThreadId }));
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
        "Finish a host-attached claimed Visual Intent batch and persist its implementation result. Autonomous SDK-worker batches finish inside the daemon.",
      inputSchema: {
        id: z.string().min(1),
        status: z.enum(["completed", "needs_input", "failed"]),
        summary: z.string().min(1),
        changedFiles: z.array(z.string()).default([]),
        notes: z.array(z.string()).default([]),
        claimId: z.string().min(1),
        expectedAttempt: z.number().int().positive(),
        controllerThreadId: z.string().min(1),
        executionId: z.string().min(1).optional(),
        taskResults: z
          .array(
            z.object({
              taskId: z.string().min(1),
              status: z.enum(["completed", "needs_input", "failed"]),
              summary: z.string().min(1),
              changedFiles: z.array(z.string()).default([]),
              notes: z.array(z.string()).default([]),
              classification: TaskClassificationSchema,
            }),
          )
          .min(1),
        usage: BatchUsageSchema.optional(),
        observedOperations: ObservedOperationsSchema.optional(),
      },
    },
    async ({
      id,
      status,
      summary,
      changedFiles,
      notes,
      claimId,
      expectedAttempt,
      controllerThreadId,
      executionId,
      taskResults,
      usage,
      observedOperations,
    }) => {
      try {
        await assertHostControlledBatch(store, id);
        return text(
          await store.finishBatch(
            id,
            status,
            {
              summary,
              changedFiles,
              notes,
              executionId,
              taskResults,
              usage,
              observedOperations,
            },
            {
              claimId,
              expectedAttempt,
              controllerThreadId,
            },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "visual_intent_review_task",
    {
      description:
        "Record a user's verdict for an applied task. A needs_revision verdict atomically creates the next ready round; not_accepted never rolls files back.",
      inputSchema: {
        id: z.string().min(1),
        expectedRevision: z.number().int().positive(),
        outcome: z.enum(["accepted", "needs_revision", "not_accepted"]),
        note: z.string().trim().min(1).optional(),
        revision: z
          .object({
            instruction: z.string().trim().min(1),
            attachments: z.array(AttachmentSchema).max(3).optional(),
          })
          .optional(),
      },
    },
    async ({ id, expectedRevision, outcome, note, revision }) => {
      try {
        return text(
          await store.review(id, {
            expectedRevision,
            outcome,
            note,
            revision,
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
