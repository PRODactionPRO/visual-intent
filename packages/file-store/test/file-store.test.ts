import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { CreateTask } from "@visual-intent/protocol";

import { FileTaskStore } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function makeStore(): Promise<FileTaskStore> {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
  temporaryDirectories.push(directory);
  return new FileTaskStore(join(directory, "tasks.json"));
}

const input: CreateTask = {
  protocolVersion: "0.1",
  surface: {
    id: "surface-1",
    platform: "web",
    uri: "http://localhost",
    adapter: { name: "test", version: "0.1.0" },
  },
  nodes: [],
  regions: [],
  frames: [],
  relations: [],
  annotations: [],
  intent: {
    id: "intent-1",
    action: "change",
    instruction: "Move the button",
    acceptanceCriteria: [],
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("FileTaskStore", () => {
  it("persists and updates tasks atomically", async () => {
    const store = await makeStore();
    const created = await store.create(input);
    const updated = await store.update(created.id, {
      expectedRevision: created.revision,
      status: "in_progress",
    });

    expect(updated.revision).toBe(2);
    expect((await store.list())[0]?.status).toBe("in_progress");

    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      tasks: Array<{ id: string }>;
    };
    expect(persisted.tasks[0]?.id).toBe(created.id);
  });

  it("dispatches and claims a repository-bound task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(join(directory, "tasks.json"), {
      root: "/workspace/example",
      name: "example",
    });
    await store.configureSession({
      projectKey: "example",
      displayName: "Example",
      repository: { root: "/workspace/example", name: "example" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const created = await store.create(input);

    expect(created.repository).toEqual({
      root: "/workspace/example",
      name: "example",
    });
    const batch = await store.dispatchReady();
    expect(batch?.status).toBe("waiting_for_executor");
    expect(batch?.taskIds).toEqual([created.id]);
    expect((await store.list({ status: "ready" })).length).toBe(0);
    await store.attachExecutor({
      repositoryRoot: "/workspace/example",
      threadId: "thread-example",
      source: "plugin",
    });
    const queued = (await store.listBatches())[0];
    expect(queued?.status).toBe("queued");
    const claimed = await store.claimBatch(queued?.id ?? "missing");
    expect(claimed.tasks[0]?.status).toBe("in_progress");
    const finished = await store.finishBatch(claimed.batch.id, "completed", {
      summary: "Implemented",
      changedFiles: ["src/example.ts"],
      notes: [],
    });
    expect(finished.tasks[0]?.status).toBe("applied");

    await expect(store.delete(created.id)).rejects.toThrow("cannot be deleted");

    const removable = await store.create({
      ...input,
      surface: { ...input.surface, id: "surface-2" },
      intent: { ...input.intent, id: "intent-2" },
    });
    await store.delete(removable.id);
    expect((await store.list()).map((task) => task.id)).toEqual([created.id]);
  });

  it("recovers pre-batch queued tasks without losing feedback", async () => {
    const store = await makeStore();
    const created = await store.create(input);
    await store.update(created.id, { status: "queued" });

    const repository = { root: "/workspace/legacy", name: "legacy" };
    const restarted = new FileTaskStore(store.filePath, repository);
    await restarted.configureSession({
      projectKey: "legacy",
      displayName: "Legacy",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });

    const [task] = await restarted.list();
    const [batch] = await restarted.listBatches();
    expect(batch?.status).toBe("waiting_for_executor");
    expect(batch?.taskIds).toEqual([created.id]);
    expect(task?.batchId).toBe(batch?.id);
    expect(task?.status).toBe("queued");
  });
});
