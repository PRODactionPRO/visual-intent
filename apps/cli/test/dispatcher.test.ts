import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FileTaskStore,
  captureGitWorkingTreeBaseline,
} from "@visual-intent/file-store";
import type { CreateTask } from "@visual-intent/protocol";

import {
  CodexDispatcher,
  type CodexRunner,
  type HostBatchDelivery,
} from "../src/dispatcher.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const input: CreateTask = {
  protocolVersion: "0.1",
  surface: {
    id: "surface-1",
    platform: "web",
    uri: "http://127.0.0.1:7310",
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
    instruction: "Make the heading bolder",
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

async function createBatch(
  ownership: "host-attached" | "visual-intent-owned",
  workerThreadId?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-dispatcher-"));
  temporaryDirectories.push(directory);
  const repositoryRoot = join(directory, "repository");
  await mkdir(repositoryRoot);
  await execFileAsync("git", ["init", "--quiet", repositoryRoot]);
  const repository = { root: repositoryRoot, name: "repository" };
  const store = new FileTaskStore(join(directory, "tasks.json"), repository, {
    captureWorkingTreeBaseline: () =>
      captureGitWorkingTreeBaseline(repositoryRoot),
  });
  await store.configureSession({
    projectKey: "example",
    displayName: "Example",
    repository,
    targetUrl: "http://127.0.0.1:5173",
    proxyUrl: "http://127.0.0.1:7310",
    ...(ownership === "visual-intent-owned"
      ? {
          executor: {
            kind: "codex" as const,
            status: "connected" as const,
            ownership,
            source: "generated" as const,
            ...(workerThreadId ? { threadId: workerThreadId } : {}),
          },
        }
      : {}),
  });
  if (ownership === "host-attached") {
    await store.attachExecutor({
      repositoryRoot,
      threadId: "thread-host-owned",
      ownership,
      source: "plugin",
    });
  }
  await store.create(input);
  const batch = await store.dispatchReady();
  if (!batch) throw new Error("Expected Apply batch");
  return { repositoryRoot, store, batch };
}

function completed(threadId = "thread-worker") {
  return {
    threadId,
    response: JSON.stringify({
      status: "completed",
      summary: "Updated the heading",
      changedFiles: ["src/page.tsx"],
      notes: [],
    }),
  };
}

describe("CodexDispatcher", () => {
  it("keeps a host-attached Apply batch for the current Codex task without running the SDK", async () => {
    const { repositoryRoot, store, batch } = await createBatch("host-attached");
    const run = vi.fn<CodexRunner["run"]>();
    const deliver = vi
      .fn<HostBatchDelivery["deliver"]>()
      .mockResolvedValue({ status: "waiting_for_executor" });
    const dispatcher = new CodexDispatcher({
      store,
      runner: { run },
      hostDelivery: { deliver },
    });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith({
      batchId: batch.id,
      repositoryRoot,
      threadId: "thread-host-owned",
    });
    expect((await store.getBatch(batch.id))?.status).toBe(
      "waiting_for_executor",
    );
    expect((await store.list())[0]?.status).toBe("queued");
    expect((await store.getSession())?.executor.status).toBe("connected");
  });

  it("runs an isolated worker without receiving the host-owned thread id", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
    );
    const run = vi.fn<CodexRunner["run"]>().mockResolvedValue(completed());
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledWith({
      repositoryRoot,
      threadId: undefined,
      prompt: expect.stringContaining("Make the heading bolder"),
    });
    expect((await store.getBatch(batch.id))?.status).toBe("completed");
    expect((await store.getSession())?.executor).toEqual(
      expect.objectContaining({
        ownership: "visual-intent-owned",
        threadId: "thread-worker",
      }),
    );
  });

  it("resumes only an explicitly Visual Intent-owned worker thread", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
      "thread-worker-owned",
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed("thread-worker-owned"));
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot,
        threadId: "thread-worker-owned",
      }),
    );
  });

  it("stops before Codex edits a repository with existing changes", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
    );
    await writeFile(join(repositoryRoot, "existing-change.txt"), "keep me\n");
    const run = vi.fn<CodexRunner["run"]>();
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).not.toHaveBeenCalled();
    expect((await store.getBatch(batch.id))?.status).toBe("needs_input");
    expect((await store.list())[0]?.status).toBe("needs_input");

    await rm(join(repositoryRoot, "existing-change.txt"));
    run.mockResolvedValue(completed());
    const retried = await store.retryBatch(batch.id);
    dispatcher.enqueue(retried.batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledOnce();
    expect((await store.getBatch(batch.id))?.status).toBe("completed");
    expect((await store.list())[0]?.status).toBe("applied");
  });

  it("preserves an active-writer failure and all original task ids", async () => {
    const { store, batch } = await createBatch(
      "visual-intent-owned",
      "thread-worker-owned",
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockRejectedValue(
        new Error("thread-store conflict: already has an active writer"),
      );
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    const failed = await store.getBatch(batch.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.taskIds).toEqual(batch.taskIds);
    expect(failed?.result).toEqual(
      expect.objectContaining({
        retryable: true,
        failureCode: "isolated_worker_active_writer",
      }),
    );
  });

  it("deduplicates repeated delivery events", async () => {
    const { store, batch } = await createBatch("visual-intent-owned");
    const run = vi.fn<CodexRunner["run"]>().mockResolvedValue(completed());
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledOnce();
    expect(await store.listBatches()).toHaveLength(1);
  });

  it("leaves the host batch waiting when delivery is unavailable", async () => {
    const { store, batch } = await createBatch("host-attached");
    const run = vi.fn<CodexRunner["run"]>();
    const deliver = vi
      .fn<HostBatchDelivery["deliver"]>()
      .mockRejectedValue(new Error("transport unavailable"));
    const dispatcher = new CodexDispatcher({
      store,
      runner: { run },
      hostDelivery: { deliver },
    });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).not.toHaveBeenCalled();
    expect((await store.getBatch(batch.id))?.status).toBe(
      "waiting_for_executor",
    );
    expect((await store.getBatch(batch.id))?.result).toBeUndefined();
  });
});
