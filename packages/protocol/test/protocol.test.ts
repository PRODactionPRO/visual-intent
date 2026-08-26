import { describe, expect, it } from "vitest";

import {
  AgentTaskResultSchema,
  ApplyBatchSchema,
  BatchUsageSchema,
  CreateTaskSchema,
  ExecutionRecordSchema,
  FinishBatchSchema,
  PROJECT_CONTEXT_MAX_CHARACTERS,
  PROTOCOL_VERSION,
  ProjectContextSnapshotSchema,
  ProjectSessionSchema,
  ProjectSettingsSchema,
  RateTaskSchema,
  ReviewTaskSchema,
  TaskRatingSchema,
  TaskClassificationSchema,
  TaskSchema,
  UpdateTaskSchema,
  VisualIntentEventSchema,
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

  it("accepts only positive integer display numbers", () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-numbered",
        platform: "web",
        uri: "http://localhost",
        adapter: { name: "test", version: "0.1.0" },
      },
      intent: {
        id: "intent-numbered",
        action: "change",
        instruction: "Move the card",
      },
    } as const;

    expect(
      CreateTaskSchema.safeParse({ ...base, displayNumber: 7 }).success,
    ).toBe(true);
    expect(
      CreateTaskSchema.safeParse({ ...base, displayNumber: 0 }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({ ...base, displayNumber: 1.5 }).success,
    ).toBe(false);
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
    expect(task.iterationId).toBe("task-1");
    expect(task.rootTaskId).toBe("task-1");
    expect(task.round).toBe(1);
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
      controller: {
        kind: "codex",
        threadId: "thread-controller",
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
      projectContext: {
        revision: 2,
        content: "Use the shared design tokens.",
        capturedAt: timestamp,
      },
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
    expect(session.controller?.threadId).toBe("thread-controller");
    expect(batch.executorOwnership).toBe("host-attached");
    expect(batch.executorThreadId).toBe("thread-1");
    expect(batch.projectContext?.revision).toBe(2);
    expect(batch.workingTreeBaseline?.files[0]?.path).toBe("src/existing.ts");
    expect(batch.dirtyWorktreeApproval?.source).toBe("overlay");
    expect(batch.attempt).toBe(1);
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
    expect(session.controller).toBeUndefined();
  });

  it("bounds a project-context snapshot stored with an Apply batch", () => {
    const snapshot = ProjectContextSnapshotSchema.parse({
      revision: 3,
      content: "Compact shared project context",
      capturedAt: "2026-08-24T12:00:00.000Z",
    });

    expect(snapshot.revision).toBe(3);
    expect(
      ProjectContextSnapshotSchema.safeParse({
        ...snapshot,
        content: "x".repeat(PROJECT_CONTEXT_MAX_CHARACTERS + 1),
      }).success,
    ).toBe(false);
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

describe("analytics and review contracts", () => {
  it("accepts an agent-assigned multi-label classification", () => {
    expect(
      TaskClassificationSchema.parse({
        categories: ["style", "layout"],
        scale: "element",
      }),
    ).toEqual({ categories: ["style", "layout"], scale: "element" });
  });

  it("rejects duplicate categories and ambiguous unknown classifications", () => {
    expect(
      TaskClassificationSchema.safeParse({
        categories: ["style", "style"],
        scale: "element",
      }).success,
    ).toBe(false);
    expect(
      TaskClassificationSchema.safeParse({
        categories: ["unknown", "layout"],
        scale: "unknown",
      }).success,
    ).toBe(false);
  });

  it("requires a follow-up instruction only for needs-revision review", () => {
    expect(
      ReviewTaskSchema.parse({
        expectedRevision: 4,
        outcome: "accepted",
      }).outcome,
    ).toBe("accepted");
    expect(
      ReviewTaskSchema.parse({
        expectedRevision: 4,
        outcome: "not_accepted",
        note: "Результат не соответствует задаче",
      }).outcome,
    ).toBe("not_accepted");
    expect(
      ReviewTaskSchema.safeParse({
        expectedRevision: 4,
        outcome: "needs_revision",
      }).success,
    ).toBe(false);
    expect(
      ReviewTaskSchema.parse({
        expectedRevision: 4,
        outcome: "needs_revision",
        revision: { instruction: "Увеличь отступ ещё на 4 px" },
      }).revision?.instruction,
    ).toContain("4 px");
  });

  it("accepts only an independent whole-number rating from one to five", () => {
    expect(RateTaskSchema.parse({ expectedRevision: 4, value: 1 }).value).toBe(
      1,
    );
    expect(
      TaskRatingSchema.parse({
        value: 5,
        ratedAt: "2026-08-24T12:00:00.000Z",
      }),
    ).toEqual({ value: 5, ratedAt: "2026-08-24T12:00:00.000Z" });
    for (const value of [0, 1.5, 6]) {
      expect(
        RateTaskSchema.safeParse({ expectedRevision: 4, value }).success,
      ).toBe(false);
    }
  });

  it("validates exact batch usage without inventing per-task usage", () => {
    const usage = BatchUsageSchema.parse({
      availability: "reported",
      capture: "direct",
      source: "codex-sdk",
      scope: "apply-batch-turn",
      exact: true,
      tokens: {
        inputTokens: 10_000,
        cachedInputTokens: 8_000,
        cacheWriteInputTokens: 1_000,
        outputTokens: 700,
        reasoningOutputTokens: 200,
      },
      model: "gpt-5.6-sol",
      reasoningPolicy: "ultra",
      adapterVersion: "0.147.0",
      apiEquivalentCost: {
        availability: "calculated",
        kind: "openai-api-equivalent",
        scope: "apply-batch-turn",
        model: "gpt-5.6-sol",
        reasoningPolicy: "ultra",
        amountUsd: "0.026200000",
        billableTokens: {
          uncachedInputTokens: 1_000,
          cachedInputTokens: 8_000,
          cacheWriteInputTokens: 1_000,
          outputTokens: 700,
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
    });

    expect(usage.availability).toBe("reported");
    if (usage.availability !== "reported") {
      throw new Error("Expected reported batch usage");
    }
    expect(
      BatchUsageSchema.safeParse({
        ...usage,
        tokens: { ...usage.tokens, outputTokens: -1 },
      }).success,
    ).toBe(false);
    expect(usage.apiEquivalentCost).toMatchObject({
      availability: "calculated",
      amountUsd: "0.026200000",
    });
    expect(
      BatchUsageSchema.safeParse({
        ...usage,
        apiEquivalentCost: {
          ...usage.apiEquivalentCost,
          amountUsd: "99.000000000",
        },
      }).success,
    ).toBe(false);
  });

  it("validates per-task agent results and a final execution receipt", () => {
    const timestamp = "2026-08-24T12:00:00.000Z";
    const taskResult = AgentTaskResultSchema.parse({
      taskId: "task-1",
      status: "completed",
      summary: "Обновлены отступ и цвет кнопки",
      changedFiles: ["src/button.tsx"],
      notes: [],
      classification: {
        categories: ["style", "layout"],
        scale: "element",
      },
    });
    const receipt = ExecutionRecordSchema.parse({
      schemaVersion: 1,
      id: "execution-1",
      sessionId: "session-1",
      batchId: "batch-1",
      attempt: 1,
      taskIds: ["task-1"],
      executorOwnership: "visual-intent-owned",
      provider: "openai",
      adapter: "codex-sdk",
      adapterVersion: "0.147.0",
      status: "completed",
      startedAt: timestamp,
      completedAt: "2026-08-24T12:00:03.000Z",
      durationMs: 3_000,
      usage: {
        availability: "reported",
        capture: "direct",
        source: "codex-sdk",
        scope: "apply-batch-turn",
        exact: true,
        tokens: {
          inputTokens: 1_000,
          cachedInputTokens: 500,
          cacheWriteInputTokens: 0,
          outputTokens: 200,
          reasoningOutputTokens: 50,
        },
      },
      observedOperations: {
        completeness: "complete",
        sdkTurns: 1,
        commandExecutions: 2,
        mcpToolCalls: 0,
        webSearches: 0,
        fileChangeOperations: 1,
        failedOperations: 0,
        uniqueChangedPaths: 1,
      },
      taskResults: [taskResult],
    });

    expect(receipt.taskResults).toEqual([taskResult]);
    expect(receipt.usage.availability).toBe("reported");
  });

  it("requires task-level results on every batch finish receipt", () => {
    const claim = {
      claimId: "claim-1",
      expectedAttempt: 1,
    };
    expect(
      FinishBatchSchema.safeParse({
        status: "completed",
        claim,
        result: {
          summary: "Implemented",
          changedFiles: ["src/button.tsx"],
          notes: [],
        },
      }).success,
    ).toBe(false);
    expect(
      FinishBatchSchema.safeParse({
        status: "completed",
        claim,
        result: {
          summary: "Implemented",
          changedFiles: ["src/button.tsx"],
          notes: [],
          taskResults: [
            {
              taskId: "task-1",
              status: "completed",
              summary: "Implemented",
              changedFiles: ["src/button.tsx"],
              notes: [],
              classification: { categories: ["style"], scale: "element" },
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("validates an append-only event envelope without task content", () => {
    const event = VisualIntentEventSchema.parse({
      schemaVersion: 1,
      id: "event-1",
      type: "task.reviewed",
      occurredAt: "2026-08-24T12:00:00.000Z",
      actor: "user",
      sessionId: "session-1",
      taskId: "task-1",
      iterationId: "task-1",
      round: 1,
      batchId: "batch-1",
      attempt: 1,
      data: { outcome: "accepted" },
    });

    expect(event.type).toBe("task.reviewed");
    expect(event.data).toEqual({ outcome: "accepted" });
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
