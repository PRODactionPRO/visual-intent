import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskStore } from "@visual-intent/core";
import { FileTaskStore } from "@visual-intent/file-store";
import type { CreateTask } from "@visual-intent/protocol";

import {
  injectOverlayTag,
  startDaemon,
  validateTarget,
} from "../src/daemon.js";
import { CodexDispatcher, type CodexRunner } from "../src/dispatcher.js";

const closers: Array<() => Promise<void>> = [];
const temporaryDirectories: string[] = [];

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
  async getBatch() {
    return undefined;
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
    throw new Error("not used");
  },
  async finishBatch() {
    throw new Error("not used");
  },
  async claimQueued() {
    return [];
  },
};

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local daemon", () => {
  it("injects the overlay before the closing body", () => {
    const html = injectOverlayTag("<html><body>Demo</body></html>");
    expect(html).toContain(
      '<script src="/_visual-intent/overlay.js" data-visual-intent></script></body>',
    );
    expect(html).toContain("/_visual-intent/vendor/html2canvas.js");
  });

  it("rejects a remote target", () => {
    expect(() => validateTarget("https://example.com")).toThrow("localhost");
  });

  it.each([
    "http://127.0.0.1:3000/admin",
    "http://127.0.0.1:3000/?workspace=demo",
    "http://127.0.0.1:3000/#feedback",
  ])("rejects a target that is not an origin: %s", (target) => {
    expect(() => validateTarget(target)).toThrow("origin only");
  });

  it("accepts and normalizes a localhost origin", () => {
    expect(validateTarget("http://localhost:3000").origin).toBe(
      "http://localhost:3000",
    );
  });

  it("proxies HTML and exposes a health endpoint", async () => {
    const targetServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body>Example target</body></html>");
    });
    await new Promise<void>((resolve) =>
      targetServer.listen(0, "127.0.0.1", resolve),
    );
    const address = targetServer.address();
    if (!address || typeof address === "string")
      throw new Error("Target server did not start");
    closers.push(
      () =>
        new Promise<void>((resolve, reject) =>
          targetServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      target: `http://127.0.0.1:${address.port}`,
      store,
    });
    closers.push(() => daemon.close());

    const page = await fetch(`http://127.0.0.1:${daemon.port}`);
    expect(await page.text()).toContain("/_visual-intent/overlay.js");

    const health = await fetch(
      `http://127.0.0.1:${daemon.port}/_visual-intent/api/health`,
    );
    expect(await health.json()).toEqual({
      ok: true,
      service: "visual-intent",
      mode: "local",
      protocolVersion: "0.1",
      daemonInstanceId: daemon.instanceId,
    });
  });

  it("protects diagnostics with the session token and survives a dead target", async () => {
    const targetServer = createServer();
    await new Promise<void>((resolve) =>
      targetServer.listen(0, "127.0.0.1", resolve),
    );
    const address = targetServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Target server did not start");
    }
    await new Promise<void>((resolve, reject) =>
      targetServer.close((error) => (error ? reject(error) : resolve())),
    );

    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      target: `http://127.0.0.1:${address.port}`,
      store,
      apiToken: "diagnostics-token",
    });
    closers.push(() => daemon.close());
    const diagnosticsUrl = `http://127.0.0.1:${daemon.port}/_visual-intent/api/diagnostics`;

    expect((await fetch(diagnosticsUrl)).status).toBe(403);
    const diagnostics = await fetch(diagnosticsUrl, {
      headers: { "x-visual-intent-token": "diagnostics-token" },
    });
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toEqual(
      expect.objectContaining({
        daemon: expect.objectContaining({
          instanceId: daemon.instanceId,
          startedAt: daemon.startedAt,
          protocolVersion: "0.1",
        }),
        proxy: expect.objectContaining({ reachable: true }),
        target: expect.objectContaining({
          reachable: false,
          errorCode: "ECONNREFUSED",
        }),
      }),
    );

    const health = await fetch(
      `http://127.0.0.1:${daemon.port}/_visual-intent/api/health`,
    );
    expect(health.status).toBe(200);
    const overlay = await fetch(
      `http://127.0.0.1:${daemon.port}/_visual-intent/overlay.js`,
    );
    expect(await overlay.text()).toContain(
      `const daemonInstanceId = "${daemon.instanceId}"`,
    );
  });

  it("re-enqueues a persisted autonomous Apply batch after daemon restart", async () => {
    const queuedBatch = {
      id: "batch-restart",
      sessionId: "session-restart",
      taskIds: ["task-restart"],
      attempt: 1,
      status: "queued" as const,
      executorOwnership: "visual-intent-owned" as const,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const enqueue = vi.fn();
    const recoveryStore: TaskStore = {
      ...store,
      async listBatches() {
        return [queuedBatch];
      },
    };

    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      target: "http://127.0.0.1:5173",
      store: recoveryStore,
      createDispatcher: () => ({ enqueue }),
    });
    closers.push(() => daemon.close());

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(queuedBatch);
  });

  it("reconciles an isolated batch after direct stdio-store completion of a host batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-daemon-"));
    temporaryDirectories.push(directory);
    const repository = { root: directory, name: "target" };
    const store = new FileTaskStore(join(directory, "tasks.json"), repository, {
      captureWorkingTreeBaseline: async () => ({
        capturedAt: new Date().toISOString(),
        fingerprint: "clean",
        files: [],
      }),
    });
    const sessionInput = {
      projectKey: "target",
      displayName: "Target",
      repository,
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
    };
    await store.configureSession(sessionInput);
    await store.attachExecutor({
      repositoryRoot: repository.root,
      threadId: "thread-host",
      ownership: "host-attached",
      source: "plugin",
    });
    const taskInput = (instruction: string, id: string): CreateTask => ({
      protocolVersion: "0.1",
      kind: "code-change",
      surface: {
        id: `surface-${id}`,
        platform: "web",
        uri: "http://127.0.0.1:7310",
        adapter: { name: "test", version: "0.1.0" },
      },
      nodes: [],
      regions: [],
      frames: [],
      relations: [],
      annotations: [],
      attachments: [],
      intent: {
        id: `intent-${id}`,
        action: "change",
        instruction,
        acceptanceCriteria: [],
      },
    });

    const hostTask = await store.create(
      taskInput("Finish the host task", "host"),
    );
    const hostBatch = await store.dispatchReady();
    if (!hostBatch) throw new Error("Expected the host batch");
    const claimedHost = await store.claimBatch(hostBatch.id, {
      controllerThreadId: "thread-host",
    });
    if (!claimedHost.batch.claim) throw new Error("Expected a host claim");

    await store.configureSession({
      ...sessionInput,
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "visual-intent-owned",
        source: "generated",
      },
    });
    const isolatedTask = await store.create(
      taskInput("Run after the host task", "isolated"),
    );
    const isolatedBatch = await store.dispatchReady();
    if (!isolatedBatch) throw new Error("Expected the isolated batch");

    const run = vi.fn<CodexRunner["run"]>().mockResolvedValue({
      threadId: "thread-isolated",
      response: JSON.stringify({
        status: "needs_input",
        summary: "Need a product choice",
        changedFiles: [],
        notes: [],
        taskResults: [
          {
            taskId: isolatedTask.id,
            status: "needs_input",
            summary: "Need a product choice",
            changedFiles: [],
            notes: [],
            classification: { categories: ["behavior"], scale: "element" },
          },
        ],
      }),
      usage: { availability: "unavailable", reason: "test runner" },
      operations: {
        completeness: "complete",
        sdkTurns: 1,
        commandExecutions: 0,
        mcpToolCalls: 0,
        webSearches: 0,
        fileChangeOperations: 0,
        failedOperations: 0,
        uniqueChangedPaths: 0,
      },
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: "2026-08-26T00:00:01.000Z",
    });
    const runner: CodexRunner = { run };
    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      target: "http://127.0.0.1:5173",
      store,
      apiToken: "test-token",
      reconciliationIntervalMs: 10,
      createDispatcher: (onChanged) =>
        new CodexDispatcher({ store, runner, onChanged }),
    });
    closers.push(() => daemon.close());

    await daemon.idle();
    expect(run).not.toHaveBeenCalled();
    expect((await store.getBatch(isolatedBatch.id))?.status).toBe("queued");

    const externalStore = new FileTaskStore(
      join(directory, "tasks.json"),
      repository,
      {
        captureWorkingTreeBaseline: async () => ({
          capturedAt: new Date().toISOString(),
          fingerprint: "clean",
          files: [],
        }),
      },
    );
    await externalStore.finishBatch(
      hostBatch.id,
      "needs_input",
      {
        summary: "Host task needs input",
        changedFiles: [],
        notes: [],
        taskResults: [
          {
            taskId: hostTask.id,
            status: "needs_input",
            summary: "Host task needs input",
            changedFiles: [],
            notes: [],
            classification: {
              categories: ["behavior"],
              scale: "element",
            },
          },
        ],
      },
      {
        claimId: claimedHost.batch.claim.id,
        expectedAttempt: claimedHost.batch.attempt,
        controllerThreadId: "thread-host",
      },
    );

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await daemon.idle();
    expect((await store.getBatch(isolatedBatch.id))?.status).toBe(
      "needs_input",
    );
    expect(run).toHaveBeenCalledOnce();
  });
});
