import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
      batch: { status: string; taskIds: string[] };
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
  });
});
