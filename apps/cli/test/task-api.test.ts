import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileTaskStore } from "@visual-intent/file-store";

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
    const store = new FileTaskStore(join(directory, "tasks.json"), {
      root: "/workspace/target",
      name: "target",
    });
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

    const readyResponse = await fetch(`${api}/tasks?status=ready`);
    expect(await readyResponse.json()).toEqual([]);

    const allTasks = (await (await fetch(`${api}/tasks`)).json()) as Array<{
      id: string;
      status: string;
    }>;
    expect(allTasks).toEqual([
      expect.objectContaining({ id: queuedTask.id, status: "queued" }),
    ]);
  });
});
