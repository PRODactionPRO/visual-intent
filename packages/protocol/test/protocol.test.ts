import { describe, expect, it } from "vitest";

import {
  ApplyBatchSchema,
  CreateTaskSchema,
  PROTOCOL_VERSION,
  ProjectSessionSchema,
  ProjectSettingsSchema,
  TaskSchema,
  UpdateTaskSchema,
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

  it("rejects an empty instruction for a code-change task", () => {
    const result = CreateTaskSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://localhost",
        adapter: { name: "test", version: "0.1.0" },
      },
      intent: { id: "intent-1", action: "change", instruction: "   " },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a Figma task without an optional user comment", () => {
    const result = CreateTaskSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "figma-component",
      surface: {
        id: "surface-figma",
        platform: "web",
        uri: "http://localhost",
        adapter: { name: "test", version: "0.1.0" },
      },
      intent: { id: "intent-figma", action: "change", instruction: "" },
    });

    expect(result.success).toBe(true);
  });

  it("accepts a Figma task with at most three project-local attachments", () => {
    const timestamp = "2026-08-18T12:00:00.000Z";
    const result = CreateTaskSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "figma-component",
      surface: {
        id: "surface-figma",
        platform: "web",
        uri: "http://localhost:7310",
        adapter: { name: "web-overlay", version: "0.1.0" },
      },
      attachments: [
        {
          id: "attachment-1",
          kind: "screenshot",
          mimeType: "image/png",
          fileName: "capture.png",
          byteSize: 128,
          sha256: "a".repeat(64),
          path: ".visual-intent/attachments/attachment-1.png",
          width: 320,
          height: 180,
          createdAt: timestamp,
        },
      ],
      intent: {
        id: "intent-figma",
        action: "change",
        instruction: "Собери компонент как на странице",
      },
    });

    expect(result.kind).toBe("figma-component");
    expect(result.attachments).toHaveLength(1);
  });

  it("rejects more than three attachments", () => {
    const timestamp = "2026-08-18T12:00:00.000Z";
    const attachment = (index: number) => ({
      id: `attachment-${index}`,
      kind: "file",
      mimeType: "text/plain",
      fileName: `${index}.txt`,
      byteSize: 10,
      sha256: String(index).repeat(64).slice(0, 64),
      path: `.visual-intent/attachments/${index}.txt`,
      createdAt: timestamp,
    });
    const result = CreateTaskSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://localhost",
        adapter: { name: "test", version: "0.1.0" },
      },
      attachments: [1, 2, 3, 4].map(attachment),
      intent: {
        id: "intent-1",
        action: "change",
        instruction: "Change the heading",
      },
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
      workingTreeBaseline: {
        capturedAt: timestamp,
        fingerprint: "baseline-1",
        files: [
          {
            path: "src/existing.ts",
            status: " M",
            fingerprint: "file-1",
          },
        ],
      },
      dirtyWorktreeApproval: {
        approvedAt: timestamp,
        baselineFingerprint: "baseline-1",
        source: "overlay",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(session.repository.root).toBe("/workspace/example");
    expect(session.executor.ownership).toBe("host-attached");
    expect(batch.executorOwnership).toBe("host-attached");
    expect(batch.executorThreadId).toBe("thread-1");
    expect(batch.workingTreeBaseline?.files[0]?.path).toBe("src/existing.ts");
    expect(batch.dirtyWorktreeApproval?.source).toBe("overlay");
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

  it("validates the project-level dirty-worktree policy", () => {
    const settings = ProjectSettingsSchema.parse({
      dirtyWorktreePolicy: "allow-host-attached",
      revision: 1,
      updatedAt: "2026-08-19T00:00:00.000Z",
    });

    expect(settings.dirtyWorktreePolicy).toBe("allow-host-attached");
  });
});

describe("UpdateTaskSchema", () => {
  it("accepts server-owned attachments when editing a task", () => {
    expect(
      UpdateTaskSchema.parse({
        expectedRevision: 1,
        instruction: "Уточнённый комментарий",
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
      }).attachments,
    ).toHaveLength(1);
  });
});
