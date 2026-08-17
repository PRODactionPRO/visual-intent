import { describe, expect, it } from "vitest";

import {
  ApplyBatchSchema,
  CreateTaskSchema,
  PROTOCOL_VERSION,
  ProjectSessionSchema,
  TaskSchema,
} from "../src/index.js";

describe("CreateTaskSchema", () => {
  it("accepts a platform-neutral web task", () => {
    const now = new Date().toISOString();
    const result = CreateTaskSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://127.0.0.1:7310",
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        adapter: { name: "web-overlay", version: "0.1.0" },
      },
      nodes: [
        {
          id: "node-1",
          surfaceId: "surface-1",
          kind: "element",
          stableSelector: "main > button:nth-of-type(1)",
        },
      ],
      frames: [
        {
          id: "frame-1",
          surfaceId: "surface-1",
          x: 0,
          y: 0,
          width: 1280,
          height: 720,
          scrollX: 0,
          scrollY: 0,
          scale: 2,
        },
      ],
      annotations: [
        {
          id: "annotation-1",
          kind: "comment",
          body: "Increase spacing",
          createdAt: now,
        },
      ],
      intent: {
        id: "intent-1",
        action: "change",
        instruction: "Increase spacing",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an empty instruction", () => {
    const result = CreateTaskSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://localhost",
        adapter: { name: "test", version: "0.1.0" },
      },
      intent: { id: "intent-1", action: "change", instruction: "" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts queued tasks bound to a local repository", () => {
    const created = CreateTaskSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://localhost",
        adapter: { name: "test", version: "0.1.0" },
      },
      intent: {
        id: "intent-1",
        action: "change",
        instruction: "Change the heading",
      },
    });

    const timestamp = "2026-08-16T12:00:00.000Z";
    const task = TaskSchema.parse({
      ...created,
      id: "task-1",
      status: "queued",
      repository: { root: "/workspace/example", name: "example" },
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(task.status).toBe("queued");
    expect(task.repository?.root).toBe("/workspace/example");
  });

  it("validates a repository-bound project session and Apply batch", () => {
    const timestamp = "2026-08-16T12:00:00.000Z";
    const session = ProjectSessionSchema.parse({
      id: "session-1",
      projectKey: "example",
      displayName: "Example",
      repository: { root: "/workspace/example", name: "example" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
      executor: {
        kind: "codex",
        status: "connected",
        ownership: "host-attached",
        threadId: "thread-1",
        source: "plugin",
        attachedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const batch = ApplyBatchSchema.parse({
      id: "batch-1",
      sessionId: session.id,
      taskIds: ["task-1"],
      status: "queued",
      executorOwnership: session.executor.ownership,
      executorThreadId: session.executor.threadId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(session.repository.root).toBe("/workspace/example");
    expect(session.executor.ownership).toBe("host-attached");
    expect(batch.executorOwnership).toBe("host-attached");
    expect(batch.executorThreadId).toBe("thread-1");
  });

  it("defaults legacy Codex sessions to safe host ownership", () => {
    const timestamp = "2026-08-16T12:00:00.000Z";
    const session = ProjectSessionSchema.parse({
      id: "session-legacy",
      projectKey: "legacy",
      displayName: "Legacy",
      repository: { root: "/workspace/legacy", name: "legacy" },
      targetUrl: "http://127.0.0.1:5173",
      proxyUrl: "http://127.0.0.1:7310",
      executor: {
        kind: "codex",
        status: "connected",
        threadId: "thread-desktop",
        source: "plugin",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(session.executor.ownership).toBe("host-attached");
  });
});
