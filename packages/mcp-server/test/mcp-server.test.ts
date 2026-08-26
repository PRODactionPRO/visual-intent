import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { TaskStore } from "@visual-intent/core";

import { createMcpServer } from "../src/index.js";

const closeAfterTest: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeAfterTest.splice(0).map((close) => close()));
});

describe("MCP bridge", () => {
  it("negotiates MCP and exposes the visual task tools", async () => {
    let claimCalls = 0;
    let finishCalls = 0;
    const store: TaskStore = {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async create() {
        throw new Error("not used");
      },
      async update() {
        throw new Error("not used");
      },
      async delete() {
        throw new Error("not used");
      },
      async review() {
        throw new Error("not used");
      },
      async rate() {
        throw new Error("not used");
      },
      async listEvents() {
        return [];
      },
      async listExecutions() {
        return [];
      },
      async getSettings() {
        return {
          dirtyWorktreePolicy: "allow-host-attached",
          revision: 1,
          updatedAt: "2026-08-19T00:00:00.000Z",
        };
      },
      async updateSettings() {
        throw new Error("not used");
      },
      async getSession() {
        return undefined;
      },
      async configureSession() {
        throw new Error("not used");
      },
      async attachExecutor() {
        throw new Error("not used");
      },
      async setExecutorState() {
        throw new Error("not used");
      },
      async listBatches() {
        return [];
      },
      async getBatch(id) {
        return id === "worker-batch"
          ? {
              id,
              sessionId: "session-1",
              taskIds: ["task-1"],
              attempt: 1,
              status: "queued",
              executorOwnership: "visual-intent-owned",
              createdAt: "2026-08-24T00:00:00.000Z",
              updatedAt: "2026-08-24T00:00:00.000Z",
            }
          : undefined;
      },
      async dispatchReady() {
        return undefined;
      },
      async retryBatch() {
        throw new Error("not used");
      },
      async approveDirtyBatch() {
        throw new Error("not used");
      },
      async claimBatch() {
        claimCalls += 1;
        throw new Error("not used");
      },
      async finishBatch() {
        finishCalls += 1;
        throw new Error("not used");
      },
      async claimQueued() {
        return [];
      },
    };
    const server = createMcpServer(store);
    const client = new Client({ name: "visual-intent-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeAfterTest.push(
      () => client.close(),
      () => server.close(),
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "visual_intent_list_tasks",
      "visual_intent_list_batches",
      "visual_intent_list_executions",
      "visual_intent_list_events",
      "visual_intent_retry_batch",
      "visual_intent_approve_dirty_batch",
      "visual_intent_claim_batch",
      "visual_intent_get_task",
      "visual_intent_finish_batch",
      "visual_intent_review_task",
      "visual_intent_update_task",
    ]);

    const result = await client.callTool({
      name: "visual_intent_list_tasks",
      arguments: {},
    });
    expect(result.content).toEqual([{ type: "text", text: "[]" }]);

    const batches = await client.callTool({
      name: "visual_intent_list_batches",
      arguments: {},
    });
    expect(batches.content).toEqual([{ type: "text", text: "[]" }]);

    const forbiddenClaim = await client.callTool({
      name: "visual_intent_claim_batch",
      arguments: { id: "worker-batch", controllerThreadId: "thread-host" },
    });
    expect(forbiddenClaim.isError).toBe(true);
    expect(forbiddenClaim.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("local Visual Intent SDK worker"),
      }),
    ]);

    const missingTaskResults = await client.callTool({
      name: "visual_intent_finish_batch",
      arguments: {
        id: "worker-batch",
        status: "completed",
        summary: "Done",
        changedFiles: [],
        notes: [],
        claimId: "claim-worker",
        expectedAttempt: 1,
        controllerThreadId: "thread-host",
      },
    });
    expect(missingTaskResults.isError).toBe(true);
    expect(missingTaskResults.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("taskResults") }),
    ]);

    const forbiddenFinish = await client.callTool({
      name: "visual_intent_finish_batch",
      arguments: {
        id: "worker-batch",
        status: "completed",
        summary: "Done",
        changedFiles: [],
        notes: [],
        claimId: "claim-worker",
        expectedAttempt: 1,
        controllerThreadId: "thread-host",
        taskResults: [
          {
            taskId: "task-1",
            status: "completed",
            summary: "Done",
            changedFiles: [],
            notes: [],
            classification: { categories: ["figma"], scale: "element" },
          },
        ],
      },
    });
    expect(forbiddenFinish.isError).toBe(true);
    expect(claimCalls).toBe(0);
    expect(finishCalls).toBe(0);
  });
});
