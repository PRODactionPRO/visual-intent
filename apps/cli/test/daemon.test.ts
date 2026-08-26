import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskStore } from "@visual-intent/core";

import {
  injectOverlayTag,
  startDaemon,
  validateTarget,
} from "../src/daemon.js";

const closers: Array<() => Promise<void>> = [];

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
});
