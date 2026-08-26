import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type {
  BatchResult,
  BatchStatus,
  CreateTask,
} from "@visual-intent/protocol";

import { FileTaskStore, captureGitWorkingTreeBaseline } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function makeStore(): Promise<FileTaskStore> {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
  temporaryDirectories.push(directory);
  return new FileTaskStore(join(directory, "tasks.json"));
}

async function claimStoredBatch(store: FileTaskStore, id: string) {
  let batch = await store.getBatch(id);
  if (!batch) throw new Error(`Missing test batch ${id}`);
  if (
    batch.executorOwnership !== "visual-intent-owned" &&
    !batch.executorThreadId
  ) {
    const session = await store.getSession();
    if (!session) throw new Error(`Missing test session for batch ${id}`);
    await store.attachExecutor({
      repositoryRoot: session.repository.root,
      threadId: `test-controller-${id}`,
      ownership: "host-attached",
      source: "plugin",
    });
    batch = await store.getBatch(id);
    if (!batch) throw new Error(`Missing retargeted test batch ${id}`);
  }
  return store.claimBatch(
    id,
    batch.executorOwnership === "host-attached"
      ? { controllerThreadId: batch.executorThreadId }
      : {},
  );
}

async function finishStoredBatch(
  store: FileTaskStore,
  id: string,
  status: Extract<BatchStatus, "completed" | "needs_input" | "failed">,
  result: BatchResult,
) {
  const batch = await store.getBatch(id);
  if (!batch?.claim) throw new Error(`Missing test claim for batch ${id}`);
  const defaultChangedFiles =
    result.changedFiles.length > 0
      ? result.changedFiles
      : status === "completed"
        ? batch.taskIds.map((taskId) => `test-evidence/${taskId}.ts`)
        : [];
  const taskResults =
    result.taskResults ??
    batch.taskIds.map((taskId, index) => ({
      taskId,
      status,
      summary: result.summary,
      changedFiles:
        status === "completed"
          ? [defaultChangedFiles[index] ?? defaultChangedFiles[0]].filter(
              (path): path is string => Boolean(path),
            )
          : [],
      notes: result.notes,
      classification: {
        categories: ["unknown" as const],
        scale: "unknown" as const,
      },
    }));
  const canonicalFallback =
    result.changedFiles.length > 0
      ? result.changedFiles
      : taskResults.flatMap((taskResult) => taskResult.changedFiles);
  return store.finishBatch(
    id,
    status,
    {
      ...result,
      changedFiles: canonicalFallback,
      taskResults,
    },
    {
      claimId: batch.claim.id,
      expectedAttempt: batch.attempt,
      ...(batch.claim.controllerThreadId
        ? { controllerThreadId: batch.claim.controllerThreadId }
        : {}),
    },
  );
}

const input: CreateTask = {
  protocolVersion: "0.1",
  kind: "code-change",
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
  attachments: [],
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
  it("does not create project storage during a read-only metrics lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-readonly-"));
    temporaryDirectories.push(directory);
    const storageDirectory = join(directory, "project", ".visual-intent");
    const store = new FileTaskStore(join(storageDirectory, "tasks.json"));

    expect(await store.list()).toEqual([]);
    expect(await store.listEvents()).toEqual([]);
    expect(await store.listExecutions()).toEqual([]);
    await expect(access(storageDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resets history while preserving project configuration and repository files", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "visual-intent-reset-"),
    );
    temporaryDirectories.push(repositoryRoot);
    const storageDirectory = join(repositoryRoot, ".visual-intent");
    const store = new FileTaskStore(join(storageDirectory, "tasks.json"), {
      root: repositoryRoot,
      name: "reset-test",
    });
    const session = await store.configureSession({
      projectKey: "reset-test",
      displayName: "Reset test",
      repository: { root: repositoryRoot, name: "reset-test" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.attachExecutor({
      repositoryRoot,
      threadId: "reset-controller",
      ownership: "host-attached",
      source: "plugin",
    });
    const settings = await store.getSettings();
    const updatedSettings = await store.updateSettings({
      expectedRevision: settings.revision,
      dirtyWorktreePolicy: "require-confirmation",
    });
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected reset test batch");
    await claimStoredBatch(store, batch.id);
    await finishStoredBatch(store, batch.id, "completed", {
      summary: "Implemented",
      changedFiles: ["src/index.ts"],
      notes: [],
    });

    const attachmentsDirectory = join(storageDirectory, "attachments");
    await mkdir(attachmentsDirectory, { recursive: true });
    await writeFile(join(attachmentsDirectory, "attachment.png"), "image");
    await writeFile(join(attachmentsDirectory, "attachment.meta.json"), "{}\n");
    await writeFile(join(storageDirectory, "connection.json"), "connection\n");
    await writeFile(join(storageDirectory, "context.md"), "context\n");
    await writeFile(join(storageDirectory, "launch.plist"), "launch\n");
    await mkdir(join(repositoryRoot, "src"));
    await writeFile(join(repositoryRoot, "src", "index.ts"), "source\n");

    const result = await store.resetHistory();

    expect(result).toMatchObject({
      tasks: 1,
      batches: 1,
      executions: 1,
      attachmentFiles: 2,
    });
    expect(result.events).toBeGreaterThan(0);
    expect(await store.list()).toEqual([]);
    expect(await store.listBatches()).toEqual([]);
    expect(await store.listEvents()).toEqual([]);
    expect(await store.listExecutions()).toEqual([]);
    expect(await store.getSession()).toMatchObject({
      id: session.id,
      projectKey: session.projectKey,
      repository: session.repository,
    });
    expect(await store.getSettings()).toEqual(updatedSettings);
    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      protocolVersion: string;
      executionOutbox: unknown[];
    };
    expect(persisted.protocolVersion).toBe("0.1");
    expect(persisted.executionOutbox).toEqual([]);
    await expect(access(attachmentsDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(storageDirectory, "usage", "events.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(storageDirectory, "usage", "executions.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(storageDirectory, "connection.json"), "utf8"),
    ).toBe("connection\n");
    expect(await readFile(join(storageDirectory, "context.md"), "utf8")).toBe(
      "context\n",
    );
    expect(await readFile(join(storageDirectory, "launch.plist"), "utf8")).toBe(
      "launch\n",
    );
    expect(
      await readFile(join(repositoryRoot, "src", "index.ts"), "utf8"),
    ).toBe("source\n");
  });

  it.each(["waiting_for_executor", "queued", "in_progress"] as const)(
    "refuses to reset while a batch is %s",
    async (status) => {
      const store = await makeStore();
      await store.configureSession({
        projectKey: "blocked-reset",
        displayName: "Blocked reset",
        repository: { root: "/workspace/reset", name: "reset" },
        targetUrl: "http://127.0.0.1:5173",
        proxyUrl: "http://127.0.0.1:7310",
      });
      await store.create(input);
      const batch = await store.dispatchReady();
      if (!batch) throw new Error("Expected blocked reset batch");
      const document = JSON.parse(await readFile(store.filePath, "utf8")) as {
        batches: Array<{ status: string }>;
      };
      if (!document.batches[0]) throw new Error("Missing persisted batch");
      document.batches[0].status = status;
      await writeFile(
        store.filePath,
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      );

      await expect(store.resetHistory()).rejects.toThrow(
        "history reset is blocked",
      );
      expect(await store.list()).toHaveLength(1);
      expect(await store.listBatches()).toHaveLength(1);
    },
  );

  it("refuses to reset while the project executor reports active work", async () => {
    const store = await makeStore();
    await store.configureSession({
      projectKey: "busy-reset",
      displayName: "Busy reset",
      repository: { root: "/workspace/reset", name: "reset" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
      executor: {
        kind: "codex",
        status: "busy",
        ownership: "visual-intent-owned",
        threadId: "busy-worker",
      },
    });
    await store.create(input);

    await expect(store.resetHistory()).rejects.toThrow(
      "project executor is busy",
    );
    expect(await store.list()).toHaveLength(1);
  });

  it("allows an explicitly confirmed reset of needs-input history", async () => {
    const store = await makeStore();
    await store.configureSession({
      projectKey: "needs-input-reset",
      displayName: "Needs-input reset",
      repository: { root: "/workspace/reset", name: "reset" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected needs-input reset batch");
    const document = JSON.parse(await readFile(store.filePath, "utf8")) as {
      batches: Array<{ status: string }>;
    };
    if (!document.batches[0]) throw new Error("Missing persisted batch");
    document.batches[0].status = "needs_input";
    await writeFile(
      store.filePath,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );

    await expect(store.resetHistory()).resolves.toMatchObject({
      tasks: 1,
      batches: 1,
    });
    expect(await store.list()).toEqual([]);
    expect(await store.listBatches()).toEqual([]);
  });

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

  it("assigns stable display numbers and migrates legacy tasks in memory", async () => {
    const store = await makeStore();
    const first = await store.create(input);
    const second = await store.create({
      ...input,
      intent: { ...input.intent, id: "intent-2", instruction: "Move text" },
    });

    expect(first.displayNumber).toBe(1);
    expect(second.displayNumber).toBe(2);

    const legacy = JSON.parse(await readFile(store.filePath, "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
    const legacyTimestamp = "2026-08-26T00:00:00.000Z";
    const legacyIds = ["legacy-z-first", "legacy-a-second"];
    legacy.tasks.forEach((task, index) => {
      delete task.displayNumber;
      task.id = legacyIds[index];
      task.rootTaskId = legacyIds[index];
      task.iterationId = legacyIds[index];
      task.createdAt = legacyTimestamp;
    });
    await writeFile(
      store.filePath,
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf8",
    );

    const reopened = new FileTaskStore(store.filePath);
    const migrated = await reopened.list();
    expect(
      migrated.find((task) => task.id === legacyIds[0])?.displayNumber,
    ).toBe(1);
    expect(
      migrated.find((task) => task.id === legacyIds[1])?.displayNumber,
    ).toBe(2);
    const third = await reopened.create({
      ...input,
      intent: { ...input.intent, id: "intent-3", instruction: "Move image" },
    });
    expect(third.displayNumber).toBe(3);
  });

  it("dispatches a batch in the same stable order used for local task numbers", async () => {
    const store = await makeStore();
    await store.configureSession({
      projectKey: "local-numbering",
      displayName: "Local numbering",
      repository: { root: "/workspace/local-numbering", name: "numbering" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const first = await store.create(input);
    const second = await store.create({
      ...input,
      intent: { ...input.intent, id: "intent-local-2", instruction: "Second" },
    });
    const third = await store.create({
      ...input,
      intent: { ...input.intent, id: "intent-local-3", instruction: "Third" },
    });
    await store.delete(second.id);
    const restoredSecond = await store.create({
      ...input,
      displayNumber: second.displayNumber,
      intent: {
        ...input.intent,
        id: "intent-local-2-restored",
        instruction: "Second restored",
      },
    });

    const batch = await store.dispatchReady();

    expect(batch?.taskIds).toEqual([first.id, restoredSecond.id, third.id]);
  });

  it("persists a replaceable star rating without changing review workflow", async () => {
    const store = await makeStore();
    const created = await store.create(input);
    const applied = await store.update(created.id, {
      expectedRevision: created.revision,
      status: "applied",
    });
    const rated = await store.rate(created.id, {
      expectedRevision: applied.revision,
      value: 4,
    });
    const rerated = await store.rate(created.id, {
      expectedRevision: rated.revision,
      value: 5,
    });

    expect(rerated.rating?.value).toBe(5);
    expect(rerated.review).toBeUndefined();
    const reopened = new FileTaskStore(store.filePath);
    expect((await reopened.get(created.id))?.rating?.value).toBe(5);
    expect(
      (await store.listEvents()).filter((event) => event.type === "task.rated"),
    ).toEqual([
      expect.objectContaining({ taskId: created.id, data: { value: 4 } }),
      expect.objectContaining({ taskId: created.id, data: { value: 5 } }),
    ]);
    await expect(
      store.rate(created.id, {
        expectedRevision: rated.revision,
        value: 3,
      }),
    ).rejects.toThrow("revision conflict");

    const reviewed = await store.review(created.id, {
      expectedRevision: rerated.revision,
      outcome: "accepted",
    });
    expect(reviewed.task.rating?.value).toBe(5);
    expect(reviewed.task.review?.outcome).toBe("accepted");
  });

  it("keeps an execution receipt durable until the JSONL projection recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-outbox-"));
    temporaryDirectories.push(directory);
    const storageDirectory = join(directory, ".visual-intent");
    const storePath = join(storageDirectory, "tasks.json");
    const repository = { root: directory, name: "outbox" };
    const store = new FileTaskStore(storePath, repository);
    await store.configureSession({
      projectKey: "outbox",
      displayName: "Outbox",
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
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);

    const projectionPath = join(storageDirectory, "usage", "executions.jsonl");
    await mkdir(projectionPath);
    await finishStoredBatch(store, batch.id, "completed", {
      summary: "Implemented",
      changedFiles: [],
      notes: [],
      usage: {
        availability: "reported",
        capture: "direct",
        provider: "openai",
        source: "openai-codex-sdk",
        scope: "apply-batch-turn",
        exact: true,
        model: "gpt-5.6-sol",
        reasoningPolicy: "ultra",
        adapterVersion: "0.147.0",
        tokens: {
          inputTokens: 100,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 5,
          outputTokens: 30,
          reasoningOutputTokens: 10,
        },
        apiEquivalentCost: {
          availability: "calculated",
          kind: "openai-api-equivalent",
          scope: "apply-batch-turn",
          model: "gpt-5.6-sol",
          reasoningPolicy: "ultra",
          amountUsd: "0.000933000",
          billableTokens: {
            uncachedInputTokens: 75,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 5,
            outputTokens: 30,
          },
          pricingSnapshot: {
            id: "openai-gpt-5.6-sol-standard-promo-2026-08-25",
            capturedAt: "2026-08-25T00:00:00.000Z",
            sourceUrl:
              "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
            currency: "USD",
            serviceTier: "standard",
            contextTierAssumption: "up-to-272k-input-per-request",
            inputUsdPerMillion: "4.00",
            cachedInputUsdPerMillion: "0.40",
            cacheWriteInputUsdPerMillion: "5.00",
            outputUsdPerMillion: "20.00",
            promotionalThrough: "2026-11-21",
          },
          reasoningIncludedInOutput: true,
          estimateBasis: "aggregate-turn-short-context",
        },
      },
    });

    const blockedProjection = JSON.parse(await readFile(storePath, "utf8")) as {
      executionOutbox?: unknown[];
    };
    expect(blockedProjection.executionOutbox).toHaveLength(1);

    await rm(projectionPath, { recursive: true });
    await writeFile(projectionPath, '{"incomplete":', "utf8");
    const [execution] = await store.listExecutions();
    expect(execution).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningPolicy: "ultra",
      adapterVersion: "0.147.0",
      usage: {
        availability: "reported",
        apiEquivalentCost: {
          availability: "calculated",
          amountUsd: "0.000933000",
        },
      },
    });
    const settings = await store.getSettings();
    await store.updateSettings({
      expectedRevision: settings.revision,
      dirtyWorktreePolicy: settings.dirtyWorktreePolicy,
    });

    const recoveredProjection = JSON.parse(
      await readFile(storePath, "utf8"),
    ) as { executionOutbox?: unknown[] };
    expect(recoveredProjection.executionOutbox).toEqual([]);
    expect((await store.listExecutions())[0]?.usage).toMatchObject({
      availability: "reported",
      tokens: { inputTokens: 100, outputTokens: 30 },
    });
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
    const claimed = await claimStoredBatch(store, queued?.id ?? "missing");
    expect(claimed.tasks[0]?.status).toBe("in_progress");
    const finished = await finishStoredBatch(
      store,
      claimed.batch.id,
      "completed",
      {
        summary: "Implemented",
        changedFiles: ["src/example.ts"],
        notes: [],
      },
    );
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

  it("keeps the active SDK worker when a host controller attaches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-worker-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/worker", name: "worker" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    const configuration = {
      projectKey: "worker",
      displayName: "Worker",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    };
    await store.configureSession({
      ...configuration,
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        threadId: "thread-worker",
        source: "generated",
      },
    });
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");

    const attached = await store.attachExecutor({
      repositoryRoot: repository.root,
      threadId: "thread-controller",
      source: "plugin",
    });

    expect(attached.executor).toMatchObject({
      ownership: "visual-intent-owned",
      threadId: "thread-worker",
    });
    expect(attached.controller).toMatchObject({
      kind: "codex",
      threadId: "thread-controller",
      source: "plugin",
    });
    expect(await store.getBatch(batch.id)).toMatchObject({
      status: "queued",
      executorOwnership: "visual-intent-owned",
      executorThreadId: "thread-worker",
    });

    const reconfigured = await store.configureSession(configuration);
    expect(reconfigured.controller?.threadId).toBe("thread-controller");
    expect(reconfigured.executor.threadId).toBe("thread-worker");
  });

  it("captures one bounded project-context snapshot with an Apply batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-context-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/context", name: "context" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository, {
      captureProjectContext: async () => ({
        revision: 4,
        content: "Use the shared product and architecture constraints.",
      }),
    });
    await store.configureSession({
      projectKey: "context",
      displayName: "Context",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.create(input);

    const batch = await store.dispatchReady();

    expect(batch?.projectContext).toMatchObject({
      revision: 4,
      content: "Use the shared product and architecture constraints.",
    });
    expect(batch?.projectContext?.capturedAt).toMatch(/Z$/u);
    const reopened = new FileTaskStore(store.filePath, repository);
    expect(
      (await reopened.getBatch(batch?.id ?? "missing"))?.projectContext,
    ).toEqual(batch?.projectContext);
  });

  it("allows only one Apply batch to be in progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-worker-"));
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
        threadId: "thread-worker",
        source: "generated",
      },
    });
    await store.create(input);
    const firstBatch = await store.dispatchReady();
    if (!firstBatch) throw new Error("Expected first batch");
    await claimStoredBatch(store, firstBatch.id);
    await store.create({
      ...input,
      surface: { ...input.surface, id: "surface-second-worker-batch" },
      intent: { ...input.intent, id: "intent-second-worker-batch" },
    });
    const secondBatch = await store.dispatchReady();
    if (!secondBatch) throw new Error("Expected second batch");

    await expect(claimStoredBatch(store, secondBatch.id)).rejects.toThrow(
      "another Apply batch is in progress",
    );
    expect((await store.getBatch(firstBatch.id))?.status).toBe("in_progress");
    expect((await store.getBatch(secondBatch.id))?.status).toBe("queued");
  });

  it("records a newly created SDK thread on the batch and execution receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-thread-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/thread", name: "thread" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "thread",
      displayName: "Thread",
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
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    expect(batch.executorThreadId).toBeUndefined();
    await claimStoredBatch(store, batch.id);
    await store.setExecutorState("busy", { threadId: "thread-created" });

    const finished = await finishStoredBatch(store, batch.id, "completed", {
      summary: "Implemented",
      changedFiles: [],
      notes: [],
    });

    expect(finished.batch.executorThreadId).toBe("thread-created");
    expect((await store.listExecutions())[0]?.executorThreadId).toBe(
      "thread-created",
    );
  });

  it("retargets only pending batches when the active executor changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-route-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/route", name: "route" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    const configuration = {
      projectKey: "route",
      displayName: "Route",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    };
    await store.configureSession({
      ...configuration,
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "host-attached",
        threadId: "thread-host-a",
        source: "plugin",
      },
    });
    await store.create(input);
    const firstBatch = await store.dispatchReady();
    if (!firstBatch) throw new Error("Expected first batch");

    await store.configureSession({
      ...configuration,
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        threadId: "thread-worker",
        source: "generated",
      },
    });
    expect(await store.getBatch(firstBatch.id)).toMatchObject({
      status: "queued",
      executorOwnership: "visual-intent-owned",
      executorThreadId: "thread-worker",
    });
    await claimStoredBatch(store, firstBatch.id);

    await store.create({
      ...input,
      surface: { ...input.surface, id: "surface-pending-route" },
      intent: { ...input.intent, id: "intent-pending-route" },
    });
    const pendingBatch = await store.dispatchReady();
    if (!pendingBatch) throw new Error("Expected pending batch");
    await store.configureSession({
      ...configuration,
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "host-attached",
        threadId: "thread-host-b",
        source: "plugin",
      },
    });

    expect(await store.getBatch(firstBatch.id)).toMatchObject({
      status: "in_progress",
      executorOwnership: "visual-intent-owned",
      executorThreadId: "thread-worker",
    });
    expect(await store.getBatch(pendingBatch.id)).toMatchObject({
      status: "waiting_for_executor",
      executorOwnership: "host-attached",
      executorThreadId: "thread-host-b",
    });
    await expect(claimStoredBatch(store, pendingBatch.id)).rejects.toThrow(
      "another Apply batch is in progress",
    );
  });

  it.each([
    {
      transition: "host-attached to Visual Intent-owned",
      initialExecutor: {
        kind: "codex",
        status: "connected",
        ownership: "host-attached",
        threadId: "thread-host-a",
        source: "plugin",
      },
      nextExecutor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        threadId: "thread-worker",
        source: "generated",
      },
      expectedStatus: "queued",
      expectedOwnership: "visual-intent-owned",
      expectedThreadId: "thread-worker",
    },
    {
      transition: "Visual Intent-owned to host-attached",
      initialExecutor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        threadId: "thread-worker",
        source: "generated",
      },
      nextExecutor: {
        kind: "codex",
        status: "connected",
        ownership: "host-attached",
        threadId: "thread-host-b",
        source: "plugin",
      },
      expectedStatus: "waiting_for_executor",
      expectedOwnership: "host-attached",
      expectedThreadId: "thread-host-b",
    },
    {
      transition: "Visual Intent-owned to disconnected",
      initialExecutor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        threadId: "thread-worker",
        source: "generated",
      },
      nextExecutor: {
        kind: "disconnected",
        status: "disconnected",
        ownership: "host-attached",
      },
      expectedStatus: "waiting_for_executor",
      expectedOwnership: undefined,
      expectedThreadId: undefined,
    },
  ] as const)(
    "retargets a dirty approval from $transition",
    async ({
      transition,
      initialExecutor,
      nextExecutor,
      expectedStatus,
      expectedOwnership,
      expectedThreadId,
    }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "visual-intent-dirty-route-"),
      );
      temporaryDirectories.push(directory);
      const repository = { root: directory, name: transition };
      const dirtyBaseline = {
        capturedAt: "2026-08-25T00:00:00.000Z",
        fingerprint: `dirty-${transition}`,
        files: [
          {
            path: "src/existing.ts",
            status: " M",
            fingerprint: "existing-file",
          },
        ],
      };
      const store = new FileTaskStore(
        join(directory, "tasks.json"),
        repository,
        {
          captureWorkingTreeBaseline: async () => dirtyBaseline,
        },
      );
      const configuration = {
        projectKey: "dirty-route",
        displayName: "Dirty route",
        repository,
        targetUrl: "http://127.0.0.1:5173",
        proxyUrl: "http://127.0.0.1:7310",
      };
      await store.configureSession({
        ...configuration,
        executor: initialExecutor,
      });
      const settings = await store.getSettings();
      await store.updateSettings({
        expectedRevision: settings.revision,
        dirtyWorktreePolicy: "require-confirmation",
      });
      await store.create(input);
      const blocked = await store.dispatchReady();
      if (!blocked) throw new Error("Expected dirty batch");
      expect(blocked.status).toBe("needs_input");

      await store.configureSession({
        ...configuration,
        executor: nextExecutor,
      });
      const approved = await store.approveDirtyBatch(blocked.id, {
        expectedBaselineFingerprint: dirtyBaseline.fingerprint,
        source: "overlay",
      });

      expect(approved.approved).toBe(true);
      expect(approved.batch.status).toBe(expectedStatus);
      expect(approved.batch.executorOwnership).toBe(expectedOwnership);
      expect(approved.batch.executorThreadId).toBe(expectedThreadId);
    },
  );

  it("turns an interrupted SDK batch into an explicit retryable failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-recovery-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/recovery", name: "recovery" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "recovery",
      displayName: "Recovery",
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
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);

    const recovered = await store.recoverInterruptedBatches();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: batch.id,
      status: "failed",
      result: {
        failureCode: "worker_interrupted",
        retryable: true,
        usage: { availability: "unavailable" },
      },
    });
    expect((await store.list())[0]?.status).toBe("rejected");
    expect((await store.listExecutions())[0]).toMatchObject({
      batchId: batch.id,
      status: "failed",
      usage: { availability: "unavailable" },
    });

    const retried = await store.retryBatch(batch.id);
    expect(retried.batch).toMatchObject({ status: "queued", attempt: 2 });
    expect(retried.tasks[0]?.status).toBe("queued");
  });

  it("continues only unresolved tasks after a needs-input answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-answer-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/answer", name: "answer" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "answer",
      displayName: "Answer",
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
    const completedTask = await store.create(input);
    const unresolvedTask = await store.create({
      ...input,
      surface: { ...input.surface, id: "surface-answer-2" },
      intent: { ...input.intent, id: "intent-answer-2" },
    });
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);
    await finishStoredBatch(store, batch.id, "needs_input", {
      summary: "One task needs a product decision",
      changedFiles: ["src/completed-task.ts"],
      notes: [],
      taskResults: [
        {
          taskId: completedTask.id,
          status: "completed",
          summary: "Done",
          changedFiles: ["src/completed-task.ts"],
          notes: [],
          classification: { categories: ["style"], scale: "element" },
        },
        {
          taskId: unresolvedTask.id,
          status: "needs_input",
          summary: "Choose the compact variant",
          changedFiles: [],
          notes: [],
          classification: { categories: ["layout"], scale: "region" },
        },
      ],
    });

    await expect(store.retryBatch(batch.id)).rejects.toThrow(
      "continuation answer",
    );
    const continued = await store.retryBatch(batch.id, {
      answer: "Используй компактный вариант.",
    });

    expect(continued.batch).toMatchObject({
      status: "queued",
      attempt: 2,
      taskIds: [unresolvedTask.id],
      continuation: { answer: "Используй компактный вариант." },
    });
    expect(await store.get(completedTask.id)).toMatchObject({
      status: "applied",
    });
    expect(await store.get(unresolvedTask.id)).toMatchObject({
      status: "queued",
    });
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
      claimStoredBatch(store, batch.id),
      claimStoredBatch(store, batch.id),
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

  it("binds a host claim and finish receipt to one Codex controller and attempt", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "visual-intent-claim-owner-"),
    );
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/claim-owner", name: "claim-owner" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "claim-owner",
      displayName: "Claim owner",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.attachExecutor({
      repositoryRoot: repository.root,
      threadId: "thread-owner",
      ownership: "host-attached",
      source: "plugin",
    });
    const task = await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");

    await expect(
      store.claimBatch(batch.id, { controllerThreadId: "thread-foreign" }),
    ).rejects.toThrow("does not own target thread-owner");

    const claimed = await store.claimBatch(batch.id, {
      controllerThreadId: "thread-owner",
    });
    if (!claimed.batch.claim) throw new Error("Expected claim receipt");
    const result = {
      summary: "Implemented",
      changedFiles: ["src/claim-owner.ts"],
      notes: [],
      taskResults: [
        {
          taskId: task.id,
          status: "completed" as const,
          summary: "Implemented",
          changedFiles: ["src/claim-owner.ts"],
          notes: [],
          classification: {
            categories: ["unknown" as const],
            scale: "unknown" as const,
          },
        },
      ],
    };
    await expect(
      store.finishBatch(batch.id, "completed", result, {
        claimId: "foreign-claim",
        expectedAttempt: claimed.batch.attempt,
        controllerThreadId: "thread-owner",
      }),
    ).rejects.toThrow("claimId does not match");
    await expect(
      store.finishBatch(batch.id, "completed", result, {
        claimId: claimed.batch.claim.id,
        expectedAttempt: claimed.batch.attempt,
        controllerThreadId: "thread-foreign",
      }),
    ).rejects.toThrow("does not match the controller that claimed");

    const finished = await store.finishBatch(batch.id, "completed", result, {
      claimId: claimed.batch.claim.id,
      expectedAttempt: claimed.batch.attempt,
      controllerThreadId: "thread-owner",
    });
    expect(finished.batch.status).toBe("completed");
  });

  it("keeps the SDK worker identity when the active delivery mode changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-worker-id-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/worker-id", name: "worker-id" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "worker-id",
      displayName: "Worker ID",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
      sdkWorker: {
        kind: "codex",
        ownership: "visual-intent-owned",
        threadId: "thread-sdk-worker",
        source: "generated",
        attachedAt: "2026-08-24T00:00:00.000Z",
      },
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        threadId: "thread-sdk-worker",
        source: "generated",
        attachedAt: "2026-08-24T00:00:00.000Z",
      },
    });

    const disconnected = await store.configureSession({
      projectKey: "worker-id",
      displayName: "Worker ID",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
      executor: {
        kind: "disconnected",
        status: "disconnected",
        ownership: "host-attached",
      },
    });

    expect(disconnected.executor.kind).toBe("disconnected");
    expect(disconnected.sdkWorker?.threadId).toBe("thread-sdk-worker");
    await expect(
      store.attachExecutor({
        repositoryRoot: repository.root,
        threadId: "thread-sdk-worker",
        ownership: "host-attached",
        source: "plugin",
      }),
    ).rejects.toThrow("cannot be both the Visual Intent controller");
  });

  it("records a late SDK thread without overwriting a changed executor route", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "visual-intent-worker-callback-"),
    );
    temporaryDirectories.push(directory);
    const repository = {
      root: "/workspace/worker-callback",
      name: "worker-callback",
    };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "worker-callback",
      displayName: "Worker callback",
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

    await store.configureSession({
      projectKey: "worker-callback",
      displayName: "Worker callback",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
      executor: {
        kind: "disconnected",
        status: "disconnected",
        ownership: "host-attached",
      },
    });
    const session = await store.setExecutorState("busy", {
      threadId: "thread-late-sdk",
      expectedExecutor: {
        ownership: "visual-intent-owned",
      },
    });

    expect(session.executor).toMatchObject({
      kind: "disconnected",
      status: "disconnected",
      ownership: "host-attached",
    });
    expect(session.sdkWorker).toMatchObject({
      threadId: "thread-late-sdk",
      ownership: "visual-intent-owned",
    });
  });

  it("does not let an older host claim overwrite a newly attached executor", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "visual-intent-route-finish-"),
    );
    temporaryDirectories.push(directory);
    const repository = {
      root: "/workspace/route-finish",
      name: "route-finish",
    };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "route-finish",
      displayName: "Route finish",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.attachExecutor({
      repositoryRoot: repository.root,
      threadId: "thread-old",
      ownership: "host-attached",
      source: "plugin",
    });
    const task = await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    const claimed = await store.claimBatch(batch.id, {
      controllerThreadId: "thread-old",
    });
    if (!claimed.batch.claim) throw new Error("Expected claim receipt");

    await store.attachExecutor({
      repositoryRoot: repository.root,
      threadId: "thread-new",
      ownership: "host-attached",
      source: "plugin",
    });
    await store.finishBatch(
      batch.id,
      "failed",
      {
        summary: "Old worker failed",
        changedFiles: [],
        notes: [],
        taskResults: [
          {
            taskId: task.id,
            status: "failed",
            summary: "Old worker failed",
            changedFiles: [],
            notes: [],
            classification: { categories: ["unknown"], scale: "unknown" },
          },
        ],
      },
      {
        claimId: claimed.batch.claim.id,
        expectedAttempt: claimed.batch.attempt,
        controllerThreadId: "thread-old",
      },
    );

    expect((await store.getSession())?.executor).toMatchObject({
      threadId: "thread-new",
      status: "connected",
    });
  });

  it("derives needs_input from task results even when the agent reports completed", async () => {
    const store = await makeStore();
    const repository = {
      root: "/workspace/status-needs-input",
      name: "status",
    };
    await store.configureSession({
      projectKey: "status-needs-input",
      displayName: "Status needs input",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const task = await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);

    const finished = await finishStoredBatch(store, batch.id, "completed", {
      summary: "Need a product decision",
      changedFiles: [],
      notes: [],
      taskResults: [
        {
          taskId: task.id,
          status: "needs_input",
          summary: "Need a product decision",
          changedFiles: [],
          notes: [],
          classification: { categories: ["behavior"], scale: "element" },
        },
      ],
    });

    expect(finished.batch.status).toBe("needs_input");
    expect(finished.tasks[0]?.status).toBe("needs_input");
    expect(
      (await store.retryBatch(batch.id, { answer: "Use the first option" }))
        .batch.status,
    ).toBe("waiting_for_executor");
  });

  it("derives completed from task results and does not rerun completed work", async () => {
    const store = await makeStore();
    const repository = { root: "/workspace/status-completed", name: "status" };
    await store.configureSession({
      projectKey: "status-completed",
      displayName: "Status completed",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const task = await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);

    const finished = await finishStoredBatch(store, batch.id, "needs_input", {
      summary: "Implemented",
      changedFiles: ["src/implemented.ts"],
      notes: [],
      taskResults: [
        {
          taskId: task.id,
          status: "completed",
          summary: "Implemented",
          changedFiles: ["src/implemented.ts"],
          notes: [],
          classification: { categories: ["behavior"], scale: "element" },
        },
      ],
    });

    expect(finished.batch.status).toBe("completed");
    expect(finished.tasks[0]?.status).toBe("applied");
    await expect(
      store.retryBatch(batch.id, { answer: "This must not run" }),
    ).rejects.toThrow("completed");
  });

  it("rejects a finish receipt without task-level results", async () => {
    const store = await makeStore();
    await store.configureSession({
      projectKey: "required-task-results",
      displayName: "Required task results",
      repository: {
        root: "/workspace/required-task-results",
        name: "required-task-results",
      },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    const claimed = await claimStoredBatch(store, batch.id);
    if (!claimed.batch.claim) throw new Error("Expected claim receipt");

    await expect(
      store.finishBatch(
        batch.id,
        "completed",
        { summary: "Implemented", changedFiles: ["src/change.ts"], notes: [] },
        {
          claimId: claimed.batch.claim.id,
          expectedAttempt: claimed.batch.attempt,
          ...(claimed.batch.claim.controllerThreadId
            ? {
                controllerThreadId: claimed.batch.claim.controllerThreadId,
              }
            : {}),
        },
      ),
    ).rejects.toThrow("must include exactly one taskResults entry");
    expect((await store.getBatch(batch.id))?.status).toBe("in_progress");
  });

  it("fails retryably when a completed code-change lacks canonical file evidence", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "visual-intent-completion-evidence-"),
    );
    temporaryDirectories.push(directory);
    let baseline = {
      capturedAt: "2026-08-25T12:00:00.000Z",
      fingerprint: "clean",
      files: [] as Array<{
        path: string;
        status: string;
        fingerprint: string;
      }>,
    };
    const repository = {
      root: "/workspace/completion-evidence",
      name: "completion-evidence",
    };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository, {
      captureWorkingTreeBaseline: async () => baseline,
    });
    await store.configureSession({
      projectKey: "completion-evidence",
      displayName: "Completion evidence",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const task = await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);
    baseline = {
      capturedAt: "2026-08-25T12:01:00.000Z",
      fingerprint: "changed",
      files: [
        {
          path: "src/actual-change.ts",
          status: " M",
          fingerprint: "actual-change",
        },
      ],
    };

    const finished = await finishStoredBatch(store, batch.id, "completed", {
      summary: "Implemented",
      changedFiles: ["src/reported-but-unchanged.ts"],
      notes: [],
      taskResults: [
        {
          taskId: task.id,
          status: "completed",
          summary: "Implemented",
          changedFiles: ["src/reported-but-unchanged.ts"],
          notes: [],
          classification: { categories: ["behavior"], scale: "element" },
        },
      ],
    });

    expect(finished.batch).toMatchObject({
      status: "failed",
      result: {
        retryable: true,
        failureCode: "completion_evidence_missing",
        batchChangedFiles: ["src/actual-change.ts"],
        taskResults: [
          expect.objectContaining({ taskId: task.id, status: "failed" }),
        ],
      },
    });
    expect(finished.tasks[0]?.status).toBe("rejected");
    expect((await store.retryBatch(batch.id)).batch.status).toBe(
      "waiting_for_executor",
    );
  });

  it("allows a completed Figma component without a Git diff", async () => {
    const store = await makeStore();
    await store.configureSession({
      projectKey: "figma-no-diff",
      displayName: "Figma no diff",
      repository: { root: "/workspace/figma-no-diff", name: "figma-no-diff" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const task = await store.create({
      ...input,
      kind: "figma-component",
      intent: { ...input.intent, instruction: "" },
    });
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);

    const finished = await finishStoredBatch(store, batch.id, "completed", {
      summary: "Created in Figma",
      changedFiles: [],
      notes: [],
      taskResults: [
        {
          taskId: task.id,
          status: "completed",
          summary: "Created in Figma",
          changedFiles: [],
          notes: [],
          classification: { categories: ["figma"], scale: "element" },
        },
      ],
    });

    expect(finished.batch.status).toBe("completed");
    expect(finished.batch.result?.failureCode).toBeUndefined();
    expect(finished.tasks[0]?.status).toBe("applied");
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
    await claimStoredBatch(store, batch.id);
    await finishStoredBatch(store, batch.id, "failed", {
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
    expect((await store.getBatch(batch.id))?.attempt).toBe(2);
    expect(await store.listExecutions()).toHaveLength(1);
    expect((await store.list())[0]?.status).toBe("queued");
  });

  it("retries a stored SDK invalid-json-schema failure from an older runtime", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "visual-intent-schema-retry-"),
    );
    temporaryDirectories.push(directory);
    const repository = {
      root: "/workspace/schema-retry",
      name: "schema-retry",
    };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "schema-retry",
      displayName: "Schema retry",
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
    await store.create(input);
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);
    await finishStoredBatch(store, batch.id, "failed", {
      summary: "Codex execution failed. The batch was preserved.",
      changedFiles: [],
      notes: [],
      technicalDetails:
        "400 invalid_json_schema: uniqueItems is not permitted at taskResults[].classification.categories",
      retryable: false,
      failureCode: "codex_execution_failed",
    });

    const retried = await store.retryBatch(batch.id);

    expect(retried.batch).toMatchObject({
      id: batch.id,
      status: "queued",
      attempt: 2,
    });
    expect(retried.tasks[0]?.status).toBe("queued");
  });

  it("stores exact batch usage, per-task classification, and review rounds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-usage-"));
    temporaryDirectories.push(directory);
    const repository = { root: "/workspace/usage", name: "usage" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository);
    await store.configureSession({
      projectKey: "usage",
      displayName: "Usage",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const first = await store.create(input);
    const second = await store.create({
      ...input,
      surface: { ...input.surface, id: "surface-usage-2" },
      intent: {
        ...input.intent,
        id: "intent-usage-2",
        instruction: "Fix the card layout",
      },
    });
    const batch = await store.dispatchReady();
    if (!batch) throw new Error("Expected batch");
    await claimStoredBatch(store, batch.id);
    const finished = await finishStoredBatch(store, batch.id, "completed", {
      summary: "Implemented two visual changes",
      changedFiles: ["src/button.tsx", "src/card.tsx"],
      notes: [],
      usage: {
        availability: "reported",
        capture: "host-reported",
        source: "codex-sdk",
        scope: "apply-batch-turn",
        exact: true,
        tokens: {
          inputTokens: 100,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 5,
          outputTokens: 40,
          reasoningOutputTokens: 10,
        },
      },
      taskResults: [
        {
          taskId: first.id,
          status: "completed",
          summary: "Moved the button",
          changedFiles: ["src/button.tsx"],
          notes: [],
          classification: { categories: ["layout"], scale: "element" },
        },
        {
          taskId: second.id,
          status: "completed",
          summary: "Fixed the card",
          changedFiles: ["src/card.tsx"],
          notes: [],
          classification: {
            categories: ["style", "layout"],
            scale: "region",
          },
        },
      ],
    });

    expect(finished.tasks.find((task) => task.id === first.id)?.result).toEqual(
      expect.objectContaining({
        summary: "Moved the button",
        changedFiles: ["src/button.tsx"],
        classification: { categories: ["layout"], scale: "element" },
      }),
    );
    const [execution] = await store.listExecutions();
    expect(execution).toMatchObject({
      batchId: batch.id,
      attempt: 1,
      taskIds: [first.id, second.id],
      usage: { availability: "reported" },
    });

    const currentFirst = await store.get(first.id);
    if (!currentFirst) throw new Error("Expected first task");
    await store.review(first.id, {
      expectedRevision: currentFirst.revision,
      outcome: "accepted",
    });
    const currentSecond = await store.get(second.id);
    if (!currentSecond) throw new Error("Expected second task");
    const revision = await store.review(second.id, {
      expectedRevision: currentSecond.revision,
      outcome: "needs_revision",
      revision: { instruction: "Increase the spacing once more" },
    });
    expect(revision.revisionTask).toMatchObject({
      iterationId: second.iterationId,
      previousTaskId: second.id,
      round: 2,
      status: "ready",
    });
    expect((await store.listEvents()).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "batch.dispatched",
        "batch.claimed",
        "batch.finished",
        "task.reviewed",
        "task.revision_created",
      ]),
    );
    const analytics = await readFile(
      join(directory, "usage", "events.jsonl"),
      "utf8",
    );
    expect(analytics).not.toContain("Move the button");
    expect(analytics).not.toContain("Fix the card layout");
    await appendFile(
      join(directory, "usage", "events.jsonl"),
      '{"incomplete":',
      "utf8",
    );
    await expect(store.listEvents()).resolves.toHaveLength(8);
  });

  it.each([
    ["host-attached", "direct"],
    ["visual-intent-owned", "host-reported"],
  ] as const)(
    "rejects %s usage reported through the %s capture channel",
    async (ownership, capture) => {
      const directory = await mkdtemp(join(tmpdir(), "visual-intent-usage-"));
      temporaryDirectories.push(directory);
      const repository = { root: `/workspace/${ownership}`, name: ownership };
      const store = new FileTaskStore(
        join(directory, "tasks.json"),
        repository,
      );
      await store.configureSession({
        projectKey: ownership,
        displayName: ownership,
        repository,
        targetUrl: "http://127.0.0.1:5173",
        proxyUrl: "http://127.0.0.1:7310",
        ...(ownership === "visual-intent-owned"
          ? {
              executor: {
                kind: "codex" as const,
                status: "connected" as const,
                ownership,
                source: "cli" as const,
              },
            }
          : {}),
      });
      await store.create(input);
      const batch = await store.dispatchReady();
      if (!batch) throw new Error("Expected batch");
      await claimStoredBatch(store, batch.id);

      await expect(
        finishStoredBatch(store, batch.id, "completed", {
          summary: "Done",
          changedFiles: [],
          notes: [],
          usage: {
            availability: "reported",
            capture,
            source: "test-adapter",
            scope: "apply-batch-turn",
            exact: true,
            tokens: {
              inputTokens: 1,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 1,
              reasoningOutputTokens: 0,
            },
          },
        }),
      ).rejects.toThrow("Usage capture");
      expect((await store.getBatch(batch.id))?.status).toBe("in_progress");
    },
  );

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
      await claimStoredBatch(store, batch.id);

      await finishStoredBatch(store, batch.id, batchStatus, {
        summary: `Finished as ${batchStatus}`,
        changedFiles: [],
        notes: [],
      });

      expect((await store.getBatch(batch.id))?.status).toBe(batchStatus);
      expect((await store.list())[0]?.status).toBe(taskStatus);
      expect((await store.getSession())?.executor.status).toBe(executorStatus);
      await expect(
        finishStoredBatch(store, batch.id, batchStatus, {
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

  it("requires exact dirty-worktree approval and separates Apply changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-baseline-"));
    temporaryDirectories.push(directory);
    const repositoryRoot = join(directory, "repository");
    await mkdir(repositoryRoot);
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
      execFile("git", ["init", "--quiet", repositoryRoot], (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await writeFile(join(repositoryRoot, "existing-change.txt"), "before\n");
    const repository = { root: repositoryRoot, name: "repository" };
    const store = new FileTaskStore(
      join(repositoryRoot, ".visual-intent", "tasks.json"),
      repository,
      {
        captureWorkingTreeBaseline: () =>
          captureGitWorkingTreeBaseline(repositoryRoot),
      },
    );
    await store.configureSession({
      projectKey: "baseline",
      displayName: "Baseline",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    const task = await store.create(input);

    const blocked = await store.dispatchReady();
    if (!blocked?.workingTreeBaseline) throw new Error("Expected baseline");
    expect(blocked.status).toBe("needs_input");
    expect(blocked.result).toEqual(
      expect.objectContaining({
        failureCode: "dirty_worktree_approval_required",
        preExistingDirtyFiles: ["existing-change.txt"],
      }),
    );
    await expect(store.retryBatch(blocked.id)).rejects.toThrow(
      "without resolving or approving",
    );

    const staleFingerprint = blocked.workingTreeBaseline.fingerprint;
    await writeFile(join(repositoryRoot, "existing-change.txt"), "changed\n");
    const staleApproval = await store.approveDirtyBatch(blocked.id, {
      expectedBaselineFingerprint: staleFingerprint,
      source: "overlay",
    });
    expect(staleApproval.approved).toBe(false);
    expect(staleApproval.batch.workingTreeBaseline?.fingerprint).not.toBe(
      staleFingerprint,
    );

    const approved = await store.approveDirtyBatch(blocked.id, {
      expectedBaselineFingerprint:
        staleApproval.batch.workingTreeBaseline?.fingerprint ?? "missing",
      source: "overlay",
    });
    expect(approved.approved).toBe(true);
    expect(approved.batch.status).toBe("waiting_for_executor");

    const claimed = await claimStoredBatch(store, blocked.id);
    expect(claimed.batch.status).toBe("in_progress");
    await writeFile(join(repositoryRoot, "existing-change.txt"), "after\n");
    await writeFile(join(repositoryRoot, "apply-change.txt"), "created\n");
    const finished = await finishStoredBatch(store, blocked.id, "completed", {
      summary: "Implemented",
      changedFiles: ["incorrect-old-file.txt"],
      notes: [],
      taskResults: [
        {
          taskId: task.id,
          status: "completed",
          summary: "Implemented",
          changedFiles: ["apply-change.txt"],
          notes: [],
          classification: { categories: ["unknown"], scale: "unknown" },
        },
      ],
    });

    expect(finished.batch.result?.preExistingDirtyFiles).toEqual([
      "existing-change.txt",
    ]);
    expect(finished.batch.result?.batchChangedFiles).toEqual([
      "apply-change.txt",
      "existing-change.txt",
    ]);
    expect(finished.batch.result?.changedFiles).toEqual([
      "apply-change.txt",
      "existing-change.txt",
    ]);
  });

  it("uses the project policy only for a connected host-attached executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-settings-"));
    temporaryDirectories.push(directory);
    const repository = { root: directory, name: "settings" };
    const dirtyBaseline = {
      capturedAt: "2026-08-19T00:00:00.000Z",
      fingerprint: "dirty-settings-baseline",
      files: [
        {
          path: "src/existing.ts",
          status: " M",
          fingerprint: "existing-file",
        },
      ],
    };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository, {
      captureWorkingTreeBaseline: async () => dirtyBaseline,
    });
    await store.configureSession({
      projectKey: "settings",
      displayName: "Settings",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    });
    await store.attachExecutor({
      repositoryRoot: directory,
      threadId: "thread-settings",
      ownership: "host-attached",
      source: "plugin",
    });
    await store.create(input);

    const allowed = await store.dispatchReady();
    expect(allowed?.status).toBe("waiting_for_executor");
    expect(allowed?.dirtyWorktreeApproval?.source).toBe("project-settings");

    const currentSettings = await store.getSettings();
    const updatedSettings = await store.updateSettings({
      expectedRevision: currentSettings.revision,
      dirtyWorktreePolicy: "require-confirmation",
    });
    expect(updatedSettings.dirtyWorktreePolicy).toBe("require-confirmation");

    await store.create({
      ...input,
      surface: { ...input.surface, id: "surface-settings-2" },
      intent: { ...input.intent, id: "intent-settings-2" },
    });
    const blocked = await store.dispatchReady();
    expect(blocked?.status).toBe("needs_input");

    const reopened = new FileTaskStore(join(directory, "tasks.json"));
    expect((await reopened.getSettings()).dirtyWorktreePolicy).toBe(
      "require-confirmation",
    );
  });
});
