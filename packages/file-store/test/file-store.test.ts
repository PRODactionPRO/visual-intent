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
      ownership: "host-attached",
      source: "plugin",
    });
    const queued = (await store.listBatches())[0];
    expect(queued?.status).toBe("waiting_for_executor");
    expect(queued?.executorOwnership).toBe("host-attached");
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

  it("queues SDK execution only for a Visual Intent-owned worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/worker", name: "worker" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "worker",
      displayName: "Worker",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        source: "generated",
      },
    });
    const created = await store.create(input);

    const batch = await store.dispatchReady();

    expect(batch?.status).toBe("queued");
    expect(batch?.executorOwnership).toBe("visual-intent-owned");
    expect(batch?.taskIds).toEqual([created.id]);
  });

  it("atomically claims a waiting batch only once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/claim", name: "claim" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "claim",
      displayName: "Claim",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");

    const claims = await Promise.allSettled([
      store.claimBatch(batch.id),
      store.claimBatch(batch.id),
    ]);

    expect(
      claims.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      claims.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await store.getBatch(batch.id))?.status).toBe("in_progress");
    expect((await store.list())[0]?.status).toBe("in_progress");
  });

  it("keeps failed task ids and permits only one explicit retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/retry", name: "retry" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "retry",
      displayName: "Retry",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const created = await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await store.claimBatch(batch.id);
    await store.finishBatch(batch.id, "failed", {
      summary: "thread-store conflict: thread already has an active writer",
      changedFiles: [],
      notes: [],
    });

    expect((await store.getBatch(batch.id))?.result).toEqual(
      expect.objectContaining({
        retryable: true,
        failureCode: "host_thread_active_writer",
      }),
    );

    const retries = await Promise.allSettled([
      store.retryBatch(batch.id),
      store.retryBatch(batch.id),
    ]);
    const retried = retries.find((result) => result.status === "fulfilled");

    expect(retried?.status).toBe("fulfilled");
    expect(
      retries.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await store.listBatches()).toHaveLength(1);
    expect((await store.getBatch(batch.id))?.taskIds).toEqual([created.id]);
    expect((await store.getBatch(batch.id))?.status).toBe(
      "waiting_for_executor",
    );
    expect((await store.list())[0]?.status).toBe("queued");
  });

  it.each([
    ["completed", "applied", "connected"],
    ["needs_input", "needs_input", "needs_input"],
    ["failed", "rejected", "error"],
  ] as const)(
    "finishes %s batches and tasks consistently",
    async (batchStatus, taskStatus, executorStatus) => {
      const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
      temporaryDirectories.push(directory);
      const repository = {
        root: `/workspace/${batchStatus}`,
        name: batchStatus,
      };
      const store = new FileTaskStore(
        join(directory, "tasks.json"),
        repository,
      );
      await store.configureSession({
        projectKey: batchStatus,
        displayName: batchStatus,
        repository,
        targetUrl: "http://127.0.0.1:5173",
        proxyUrl: "http://127.0.0.1:7310",
      });
      await store.create(input);
      const batch = await store.dispatchReady();
      if (!batch) throw new Error("Expected batch");
      await store.claimBatch(batch.id);

      await store.finishBatch(batch.id, batchStatus, {
        summary: `Finished as ${batchStatus}`,
        changedFiles: [],
        notes: [],
      });

      expect((await store.getBatch(batch.id))?.status).toBe(batchStatus);
      expect((await store.list())[0]?.status).toBe(taskStatus);
      expect((await store.getSession())?.executor.status).toBe(executorStatus);
      await expect(
        store.finishBatch(batch.id, batchStatus, {
          summary: "Duplicate finish",
          changedFiles: [],
          notes: [],
        }),
      ).rejects.toThrow("cannot be finished");
    },
  );

  it("rejects an executor attached to a different repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/exact", name: "exact" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "exact",
      displayName: "Exact",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });

    await expect(
      store.attachExecutor({
        repositoryRoot: "/workspace/other",
        threadId: "thread-other",
        ownership: "host-attached",
        source: "plugin",
      }),
    ).rejects.toThrow("repository mismatch");
  });
});
