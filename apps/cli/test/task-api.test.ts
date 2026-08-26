import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { FileTaskStore } from "@visual-intent/file-store";
import type { WorkingTreeBaseline } from "@visual-intent/protocol";

import { startDaemon } from "../src/daemon.js";

const closeAfterTest: Array<() => Promise<void>> = [];
const removeAfterTest: string[] = [];

afterEach(async () => {
  await Promise.all(closeAfterTest.splice(0).map((close) => close()));
  await Promise.all(
    removeAfterTest
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("task API", () => {
  it("edits, deletes, and dispatches the ready queue", async () => {
    const targetServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body>Target</body></html>");
    });
    await new Promise<void>((resolve) =>
      targetServer.listen(0, "127.0.0.1", resolve),
    );
    const targetAddress = targetServer.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Target server did not start");
    }
    closeAfterTest.push(
      () =>
        new Promise<void>((resolve, reject) =>
          targetServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const directory = await mkdtemp(join(tmpdir(), "visual-intent-api-"));
    removeAfterTest.push(directory);
    let workingTreeBaseline: WorkingTreeBaseline = {
      capturedAt: new Date().toISOString(),
      fingerprint: "clean",
      files: [],
    };
    const store = new FileTaskStore(
      join(directory, "tasks.json"),
      {
        root: "/workspace/target",
        name: "target",
      },
      { captureWorkingTreeBaseline: async () => workingTreeBaseline },
    );
    await store.configureSession({
      projectKey: "target",
      displayName: "Target",
      repository: { root: "/workspace/target", name: "target" },
      targetUrl: `http://127.0.0.1:${targetAddress.port}`,
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.attachExecutor({
      repositoryRoot: "/workspace/target",
      threadId: "thread-target",
      ownership: "host-attached",
      source: "plugin",
    });
    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      target: `http://127.0.0.1:${targetAddress.port}`,
      store,
      apiToken: "test-token",
    });
    closeAfterTest.push(() => daemon.close());
    const api = `http://127.0.0.1:${daemon.port}/_visual-intent/api`;
    const payload = {
      protocolVersion: "0.1",
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://127.0.0.1",
        adapter: { name: "test", version: "0.1.0" },
      },
      intent: {
        id: "intent-1",
        action: "change",
        instruction: "Make the heading bolder",
      },
    };

    const initialSettingsResponse = await fetch(`${api}/settings`);
    const initialSettings = (await initialSettingsResponse.json()) as {
      dirtyWorktreePolicy: string;
      revision: number;
    };
    expect(initialSettings.dirtyWorktreePolicy).toBe("allow-host-attached");

    const settingsResponse = await fetch(`${api}/settings`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify({
        expectedRevision: initialSettings.revision,
        dirtyWorktreePolicy: "require-confirmation",
      }),
    });
    expect(settingsResponse.status).toBe(200);
    expect(await settingsResponse.json()).toEqual(
      expect.objectContaining({
        dirtyWorktreePolicy: "require-confirmation",
        revision: initialSettings.revision + 1,
      }),
    );

    const unauthorizedResponse = await fetch(`${api}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(unauthorizedResponse.status).toBe(403);

    const createdResponse = await fetch(`${api}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify(payload),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      revision: number;
      repository: { root: string };
    };
    expect(created.repository.root).toBe("/workspace/target");

    const unownedAttachmentResponse = await fetch(
      `${api}/tasks/${created.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-visual-intent-token": "test-token",
        },
        body: JSON.stringify({
          expectedRevision: created.revision,
          attachments: [
            {
              id: "attachment-1",
              kind: "screenshot",
              mimeType: "image/png",
              fileName: "capture.png",
              byteSize: 128,
              sha256: "a".repeat(64),
              path: ".visual-intent/attachments/attachment-1.png",
              createdAt: "2026-08-19T00:00:00.000Z",
            },
          ],
        }),
      },
    );
    expect(unownedAttachmentResponse.status).toBe(400);

    const updatedResponse = await fetch(`${api}/tasks/${created.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify({
        expectedRevision: created.revision,
        instruction: "Make the heading one step bolder",
      }),
    });
    expect(updatedResponse.status).toBe(200);

    const deletedResponse = await fetch(`${api}/tasks/${created.id}`, {
      method: "DELETE",
      headers: { "x-visual-intent-token": "test-token" },
    });
    expect(deletedResponse.status).toBe(204);

    const queuedResponse = await fetch(`${api}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify({
        ...payload,
        surface: { ...payload.surface, id: "surface-2" },
        intent: { ...payload.intent, id: "intent-2" },
      }),
    });
    const queuedTask = (await queuedResponse.json()) as { id: string };

    const appliedResponse = await fetch(`${api}/tasks/apply`, {
      method: "POST",
      headers: { "x-visual-intent-token": "test-token" },
    });
    const applied = (await appliedResponse.json()) as {
      accepted: number;
      batch: { id: string; status: string; taskIds: string[] };
    };
    expect(appliedResponse.status).toBe(202);
    expect(applied.accepted).toBe(1);
    expect(applied.batch.status).toBe("waiting_for_executor");
    expect(applied.batch.taskIds).toEqual([queuedTask.id]);

    const duplicateApplyResponse = await fetch(`${api}/tasks/apply`, {
      method: "POST",
      headers: { "x-visual-intent-token": "test-token" },
    });
    const duplicateApply = (await duplicateApplyResponse.json()) as {
      accepted: number;
      batch?: unknown;
    };
    expect(duplicateApply.accepted).toBe(0);
    expect(duplicateApply.batch).toBeUndefined();
    expect(await store.listBatches()).toHaveLength(1);

    const readyResponse = await fetch(`${api}/tasks?status=ready`);
    expect(await readyResponse.json()).toEqual([]);

    const allTasks = (await (await fetch(`${api}/tasks`)).json()) as Array<{
      id: string;
      status: string;
    }>;
    expect(allTasks).toEqual([
      expect.objectContaining({ id: queuedTask.id, status: "queued" }),
    ]);

    const claimedResponse = await fetch(
      `${api}/batches/${applied.batch.id}/claim`,
      {
        method: "POST",
        headers: {
          "x-visual-intent-token": "test-token",
          "x-visual-intent-controller-thread": "thread-target",
        },
      },
    );
    expect(claimedResponse.status).toBe(200);
    const claimed = (await claimedResponse.json()) as {
      batch: { attempt: number; claim: { id: string } };
    };
    const socket = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/_visual-intent/ws?token=test-token`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    closeAfterTest.push(
      () =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          socket.once("close", () => resolve());
          socket.close();
        }),
    );
    const finishedEvent = new Promise<{ task: { type: string } }>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          task?: { type?: string };
        };
        if (message.task?.type?.startsWith("batch.")) {
          resolve(message as { task: { type: string } });
        }
      });
    });
    workingTreeBaseline = {
      capturedAt: new Date().toISOString(),
      fingerprint: "heading-updated",
      files: [
        {
          path: "src/heading.tsx",
          status: " M",
          fingerprint: "heading-updated",
        },
      ],
    };
    const finishedResponse = await fetch(
      `${api}/batches/${applied.batch.id}/finish`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visual-intent-token": "test-token",
          "x-visual-intent-controller-thread": "thread-target",
        },
        body: JSON.stringify({
          status: "failed",
          claim: {
            claimId: claimed.batch.claim.id,
            expectedAttempt: claimed.batch.attempt,
          },
          result: {
            summary: "Heading updated",
            changedFiles: ["src/heading.tsx"],
            notes: [],
            usage: {
              availability: "reported",
              capture: "host-reported",
              source: "codex-sdk",
              scope: "apply-batch-turn",
              exact: true,
              tokens: {
                inputTokens: 20,
                cachedInputTokens: 4,
                cacheWriteInputTokens: 0,
                outputTokens: 8,
                reasoningOutputTokens: 2,
              },
            },
            taskResults: [
              {
                taskId: queuedTask.id,
                status: "completed",
                summary: "Heading updated",
                changedFiles: ["src/heading.tsx"],
                notes: [],
                classification: {
                  categories: ["style"],
                  scale: "element",
                },
              },
            ],
          },
        }),
      },
    );
    expect(finishedResponse.status).toBe(200);
    expect((await finishedEvent).task.type).toBe("batch.completed");
    const appliedTask = await store.get(queuedTask.id);
    if (!appliedTask) throw new Error("Expected applied task");
    expect(appliedTask.status).toBe("applied");

    const unauthorizedRating = await fetch(
      `${api}/tasks/${queuedTask.id}/rating`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: appliedTask.revision,
          value: 4,
        }),
      },
    );
    expect(unauthorizedRating.status).toBe(403);
    const ratingResponse = await fetch(`${api}/tasks/${queuedTask.id}/rating`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify({
        expectedRevision: appliedTask.revision,
        value: 4,
      }),
    });
    expect(ratingResponse.status).toBe(200);
    const ratedTask = (await ratingResponse.json()) as {
      revision: number;
      rating: { value: number };
    };
    expect(ratedTask.rating.value).toBe(4);

    const unauthorizedReview = await fetch(
      `${api}/tasks/${queuedTask.id}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: ratedTask.revision,
          outcome: "accepted",
        }),
      },
    );
    expect(unauthorizedReview.status).toBe(403);
    const reviewResponse = await fetch(`${api}/tasks/${queuedTask.id}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify({
        expectedRevision: ratedTask.revision,
        outcome: "accepted",
      }),
    });
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toEqual(
      expect.objectContaining({
        task: expect.objectContaining({
          review: expect.objectContaining({ outcome: "accepted" }),
        }),
      }),
    );
    const executionsResponse = await fetch(`${api}/executions`);
    expect(await executionsResponse.json()).toEqual([
      expect.objectContaining({
        batchId: applied.batch.id,
        usage: expect.objectContaining({ availability: "reported" }),
      }),
    ]);
    const eventsResponse = await fetch(`${api}/events`);
    expect(await eventsResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "batch.finished" }),
        expect.objectContaining({ type: "task.rated", data: { value: 4 } }),
        expect.objectContaining({ type: "task.reviewed" }),
      ]),
    );

    workingTreeBaseline = {
      capturedAt: new Date().toISOString(),
      fingerprint: "dirty-baseline",
      files: [
        {
          path: "src/existing.ts",
          status: " M",
          fingerprint: "existing-file",
        },
      ],
    };
    await fetch(`${api}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify({
        ...payload,
        surface: { ...payload.surface, id: "surface-3" },
        intent: { ...payload.intent, id: "intent-3" },
      }),
    });
    const blockedResponse = await fetch(`${api}/tasks/apply`, {
      method: "POST",
      headers: { "x-visual-intent-token": "test-token" },
    });
    const blocked = (await blockedResponse.json()) as {
      batch: { id: string; status: string };
    };
    expect(blocked.batch.status).toBe("needs_input");

    const approvedResponse = await fetch(
      `${api}/batches/${blocked.batch.id}/approve-dirty`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visual-intent-token": "test-token",
        },
        body: JSON.stringify({
          expectedBaselineFingerprint: "dirty-baseline",
          source: "overlay",
        }),
      },
    );
    const approved = (await approvedResponse.json()) as {
      approved: boolean;
      batch: { status: string };
    };
    expect(approvedResponse.status).toBe(200);
    expect(approved.approved).toBe(true);
    expect(approved.batch.status).toBe("waiting_for_executor");

    workingTreeBaseline = {
      capturedAt: new Date().toISOString(),
      fingerprint: "clean-again",
      files: [],
    };
    await store.configureSession({
      projectKey: "target",
      displayName: "Target",
      repository: { root: "/workspace/target", name: "target" },
      targetUrl: `http://127.0.0.1:${targetAddress.port}`,
      proxyUrl: "http://127.0.0.1:7310",
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        source: "cli",
      },
    });
    await fetch(`${api}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": "test-token",
      },
      body: JSON.stringify({
        ...payload,
        surface: { ...payload.surface, id: "surface-worker" },
        intent: { ...payload.intent, id: "intent-worker" },
      }),
    });
    const workerApply = (await (
      await fetch(`${api}/tasks/apply`, {
        method: "POST",
        headers: { "x-visual-intent-token": "test-token" },
      })
    ).json()) as { batch: { id: string; status: string } };
    expect(workerApply.batch.status).toBe("queued");

    const forbiddenClaim = await fetch(
      `${api}/batches/${workerApply.batch.id}/claim`,
      {
        method: "POST",
        headers: { "x-visual-intent-token": "test-token" },
      },
    );
    expect(forbiddenClaim.status).toBe(409);
    expect(await forbiddenClaim.json()).toEqual({
      error: expect.stringContaining("local Visual Intent SDK worker"),
    });

    const forbiddenFinish = await fetch(
      `${api}/batches/${workerApply.batch.id}/finish`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visual-intent-token": "test-token",
        },
        body: JSON.stringify({
          status: "completed",
          claim: { claimId: "claim-worker", expectedAttempt: 1 },
          result: {
            summary: "Failed before implementation",
            changedFiles: [],
            notes: [],
            taskResults: [
              {
                taskId: "task-worker",
                status: "failed",
                summary: "Failed before implementation",
                changedFiles: [],
                notes: [],
                classification: {
                  categories: ["unknown"],
                  scale: "unknown",
                },
              },
            ],
          },
        }),
      },
    );
    expect(forbiddenFinish.status).toBe(409);
  });
});
