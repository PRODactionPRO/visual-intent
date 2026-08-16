import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileTaskStore } from "@visual-intent/file-store";
import type { CreateTask } from "@visual-intent/protocol";

import { CodexDispatcher, type CodexRunner } from "../src/dispatcher.js";

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

async function createQueuedBatch() {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-dispatcher-"));
  temporaryDirectories.push(directory);
  const repositoryRoot = join(directory, "repository");
  await mkdir(repositoryRoot);
  await execFileAsync("git", ["init", "--quiet", repositoryRoot]);
  const repository = { root: repositoryRoot, name: "repository" };
  const store = new FileTaskStore(join(directory, "tasks.json"), repository);
  await store.configureSession({
    projectKey: "example",
    displayName: "Example",
    repository,
    targetUrl: "http://127.0.0.1:5173",
    proxyUrl: "http://127.0.0.1:7310",
  });
  await store.create(input);
  await store.dispatchReady();
  await store.attachExecutor({
    repositoryRoot,
    threadId: "thread-existing",
    source: "plugin",
  });
  const batch = (await store.listBatches())[0];
  if (!batch) throw new Error("Expected queued batch");
  return { repositoryRoot, store, batch };
}

describe("CodexDispatcher", () => {
  it("runs a queued Apply batch in the attached thread", async () => {
    const { repositoryRoot, store, batch } = await createQueuedBatch();
    const run = vi.fn<CodexRunner["run"]>().mockResolvedValue({
      threadId: "thread-existing",
      response: JSON.stringify({
        status: "completed",
        summary: "Updated the heading",
        changedFiles: ["src/page.tsx"],
        notes: [],
      }),
    });
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot,
        threadId: "thread-existing",
        prompt: expect.stringContaining("Make the heading bolder"),
      }),
    );
    expect((await store.getBatch(batch.id))?.status).toBe("completed");
    expect((await store.list())[0]?.status).toBe("applied");
    expect((await store.getSession())?.executor.status).toBe("connected");
  });

  it("stops before Codex edits a repository with existing changes", async () => {
    const { repositoryRoot, store, batch } = await createQueuedBatch();
    await writeFile(join(repositoryRoot, "existing-change.txt"), "keep me\n");
    const run = vi.fn<CodexRunner["run"]>();
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).not.toHaveBeenCalled();
    expect((await store.getBatch(batch.id))?.status).toBe("needs_input");
    expect((await store.list())[0]?.status).toBe("needs_input");

    await rm(join(repositoryRoot, "existing-change.txt"));
    run.mockResolvedValue({
      threadId: "thread-existing",
      response: JSON.stringify({
        status: "completed",
        summary: "Implemented after the repository was cleaned",
        changedFiles: [],
        notes: [],
      }),
    });
    const retried = await store.retryBatch(batch.id);
    dispatcher.enqueue(retried.batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledOnce();
    expect((await store.getBatch(batch.id))?.status).toBe("completed");
    expect((await store.list())[0]?.status).toBe("applied");
  });
});
