import { describe, expect, it } from "vitest";

import {
  createTask,
  rateTask,
  reviewTask,
  updateTask,
} from "@visual-intent/core";
import {
  ApplyBatchSchema,
  ExecutionRecordSchema,
  TaskSchema,
  type CreateTask,
} from "@visual-intent/protocol";

import {
  buildMetrics,
  formatMetricsCsv,
  formatMetricsTable,
  parseSince,
} from "../src/metrics.js";

const input: CreateTask = {
  protocolVersion: "0.1",
  kind: "code-change",
  surface: {
    id: "surface-metrics",
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
    id: "intent-metrics",
    action: "change",
    instruction: "Move the button",
    acceptanceCriteria: [],
  },
};

describe("local metrics", () => {
  it("counts exact batch usage without double-counting token details", () => {
    const created = createTask(input, new Date("2026-08-24T10:00:00.000Z"));
    const applied = updateTask(created, {
      status: "applied",
      result: {
        summary: "Moved",
        changedFiles: ["src/button.tsx"],
        notes: [],
        classification: { categories: ["layout"], scale: "element" },
      },
    });
    const reviewed = TaskSchema.parse({
      ...reviewTask(
        applied,
        { expectedRevision: applied.revision, outcome: "accepted" },
        new Date("2026-08-24T10:10:00.000Z"),
      ).task,
      batchId: "batch-metrics",
    });
    const ratedReviewed = rateTask(
      reviewed,
      { expectedRevision: reviewed.revision, value: 4 },
      new Date("2026-08-24T10:12:00.000Z"),
    );
    const batch = ApplyBatchSchema.parse({
      id: "batch-metrics",
      sessionId: "session-metrics",
      taskIds: [reviewed.id],
      status: "completed",
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:05:00.000Z",
      completedAt: "2026-08-24T10:05:00.000Z",
    });
    const execution = ExecutionRecordSchema.parse({
      schemaVersion: 1,
      id: "execution-metrics",
      sessionId: "session-metrics",
      batchId: batch.id,
      attempt: 1,
      taskIds: [reviewed.id],
      provider: "openai",
      adapter: "codex-sdk",
      status: "completed",
      startedAt: "2026-08-24T10:00:00.000Z",
      completedAt: "2026-08-24T10:05:00.000Z",
      durationMs: 300_000,
      usage: {
        availability: "reported",
        capture: "direct",
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
          taskId: reviewed.id,
          status: "completed",
          summary: "Moved",
          changedFiles: ["src/button.tsx"],
          notes: [],
          classification: { categories: ["layout"], scale: "element" },
        },
      ],
    });
    const notAcceptedCreated = createTask(
      {
        ...input,
        surface: { ...input.surface, id: "surface-not-accepted" },
        intent: { ...input.intent, id: "intent-not-accepted" },
      },
      new Date("2026-08-24T10:01:00.000Z"),
    );
    const notAcceptedApplied = updateTask(notAcceptedCreated, {
      status: "applied",
      result: {
        summary: "Changed, but the result was not useful",
        changedFiles: [],
        notes: [],
        classification: { categories: ["layout"], scale: "element" },
      },
    });
    const notAccepted = reviewTask(
      notAcceptedApplied,
      {
        expectedRevision: notAcceptedApplied.revision,
        outcome: "not_accepted",
      },
      new Date("2026-08-24T10:11:00.000Z"),
    ).task;
    const ratedNotAccepted = rateTask(
      notAccepted,
      { expectedRevision: notAccepted.revision, value: 1 },
      new Date("2026-08-24T10:13:00.000Z"),
    );

    const report = buildMetrics({
      tasks: [ratedReviewed, ratedNotAccepted],
      batches: [batch],
      executions: [execution],
      events: [],
    });

    expect(report.summary.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      reportedExecutions: 1,
      coverage: 1,
      acceptedTasksInReportedExecutions: 1,
      batchTokensPerAcceptedTask: 140,
      medianTokensAcceptedSingleTask: 140,
    });
    expect(report.summary.iterations).toMatchObject({
      accepted: 1,
      firstPassAccepted: 1,
      firstPassSuccessRate: 0.5,
      medianTimeToAcceptedMs: 600_000,
    });
    expect(report.summary.ratings).toEqual({
      rated: 2,
      unratedApplied: 0,
      average: 2.5,
      distribution: { "1": 1, "2": 0, "3": 0, "4": 1, "5": 0 },
    });
    expect(formatMetricsTable(report.summary)).toContain(
      "Успех с первого раунда: 50.0%",
    );
    expect(formatMetricsTable(report.summary)).toContain(
      "Пятизвёздочная оценка: 2; средняя 2,5/5",
    );
    const csv = formatMetricsCsv(report.executions);
    expect(csv).toContain("single-task");
    expect(csv).toContain(",140,");
    expect(csv).not.toContain("Move the button");
  });

  it.each(["failed", "needs_input"] as const)(
    "attributes an accepted task only to the successful attempt after a %s attempt",
    (earlyStatus) => {
      const created = createTask(input, new Date("2026-08-24T10:00:00.000Z"));
      const applied = updateTask(created, {
        status: "applied",
        result: {
          summary: "Moved after retry",
          changedFiles: ["src/button.tsx"],
          notes: [],
          classification: { categories: ["layout"], scale: "element" },
        },
      });
      const reviewed = TaskSchema.parse({
        ...reviewTask(
          applied,
          { expectedRevision: applied.revision, outcome: "accepted" },
          new Date("2026-08-24T10:10:00.000Z"),
        ).task,
        batchId: "batch-retried-metrics",
      });
      const batch = ApplyBatchSchema.parse({
        id: "batch-retried-metrics",
        sessionId: "session-metrics",
        taskIds: [reviewed.id],
        attempt: 2,
        status: "completed",
        createdAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:05:00.000Z",
        completedAt: "2026-08-24T10:05:00.000Z",
      });
      const earlyExecution = ExecutionRecordSchema.parse({
        schemaVersion: 1,
        id: `execution-${earlyStatus}`,
        sessionId: "session-metrics",
        batchId: batch.id,
        attempt: 1,
        taskIds: [reviewed.id],
        provider: "openai",
        adapter: "codex-sdk",
        status: earlyStatus,
        startedAt: "2026-08-24T10:00:00.000Z",
        completedAt: "2026-08-24T10:02:00.000Z",
        durationMs: 120_000,
        usage: {
          availability: "reported",
          capture: "direct",
          source: "codex-sdk",
          scope: "apply-batch-turn",
          exact: true,
          tokens: {
            inputTokens: 40,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 20,
            reasoningOutputTokens: 0,
          },
        },
        taskResults: [
          {
            taskId: reviewed.id,
            status: earlyStatus,
            summary: `Stopped as ${earlyStatus}`,
            changedFiles: [],
            notes: [],
            classification: { categories: ["layout"], scale: "element" },
          },
        ],
      });
      const successfulExecution = ExecutionRecordSchema.parse({
        schemaVersion: 1,
        id: "execution-successful-retry",
        sessionId: "session-metrics",
        batchId: batch.id,
        attempt: 2,
        taskIds: [reviewed.id],
        provider: "openai",
        adapter: "codex-sdk",
        status: "completed",
        startedAt: "2026-08-24T10:03:00.000Z",
        completedAt: "2026-08-24T10:05:00.000Z",
        durationMs: 120_000,
        usage: {
          availability: "reported",
          capture: "direct",
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
            taskId: reviewed.id,
            status: "completed",
            summary: "Moved after retry",
            changedFiles: ["src/button.tsx"],
            notes: [],
            classification: { categories: ["layout"], scale: "element" },
          },
        ],
      });

      const report = buildMetrics({
        tasks: [reviewed],
        batches: [batch],
        executions: [earlyExecution, successfulExecution],
        events: [],
      });

      expect(report.summary.usage).toMatchObject({
        totalTokens: 200,
        acceptedTasksInReportedExecutions: 1,
        batchTokensPerAcceptedTask: 200,
        acceptedSingleTaskExecutions: 1,
        medianTokensAcceptedSingleTask: 140,
      });
      expect(
        report.executions.map((execution) => execution.acceptedTasks),
      ).toEqual([0, 1]);
    },
  );

  it("uses every uniquely evaluated iteration in first-pass success rate", () => {
    const acceptedCreated = createTask(
      {
        ...input,
        surface: { ...input.surface, id: "surface-accepted-denominator" },
        intent: { ...input.intent, id: "intent-accepted-denominator" },
      },
      new Date("2026-08-24T10:00:00.000Z"),
    );
    const acceptedApplied = updateTask(acceptedCreated, { status: "applied" });
    const accepted = TaskSchema.parse({
      ...reviewTask(
        acceptedApplied,
        {
          expectedRevision: acceptedApplied.revision,
          outcome: "accepted",
        },
        new Date("2026-08-24T10:05:00.000Z"),
      ).task,
      batchId: "batch-first-pass-denominator",
    });
    const acceptedBatch = ApplyBatchSchema.parse({
      id: "batch-first-pass-denominator",
      sessionId: "session-first-pass-denominator",
      taskIds: [accepted.id],
      status: "completed",
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:04:00.000Z",
      completedAt: "2026-08-24T10:04:00.000Z",
    });

    const notAcceptedApplied = updateTask(
      createTask({
        ...input,
        surface: { ...input.surface, id: "surface-not-accepted-denominator" },
        intent: { ...input.intent, id: "intent-not-accepted-denominator" },
      }),
      { status: "applied" },
    );
    const notAccepted = reviewTask(notAcceptedApplied, {
      expectedRevision: notAcceptedApplied.revision,
      outcome: "not_accepted",
    }).task;

    const needsRevisionApplied = updateTask(
      createTask({
        ...input,
        surface: { ...input.surface, id: "surface-needs-revision-denominator" },
        intent: { ...input.intent, id: "intent-needs-revision-denominator" },
      }),
      { status: "applied" },
    );
    const needsRevision = reviewTask(needsRevisionApplied, {
      expectedRevision: needsRevisionApplied.revision,
      outcome: "needs_revision",
      revision: { instruction: "Move the button again" },
    }).task;

    const ratingOnlyApplied = updateTask(
      createTask({
        ...input,
        surface: { ...input.surface, id: "surface-rating-only-denominator" },
        intent: { ...input.intent, id: "intent-rating-only-denominator" },
      }),
      { status: "applied" },
    );
    const ratingOnly = rateTask(ratingOnlyApplied, {
      expectedRevision: ratingOnlyApplied.revision,
      value: 5,
    });
    const withoutFeedback = updateTask(
      createTask({
        ...input,
        surface: { ...input.surface, id: "surface-without-feedback" },
        intent: { ...input.intent, id: "intent-without-feedback" },
      }),
      { status: "applied" },
    );

    const report = buildMetrics({
      tasks: [
        accepted,
        notAccepted,
        needsRevision,
        ratingOnly,
        withoutFeedback,
      ],
      batches: [acceptedBatch],
      executions: [],
      events: [],
    });

    expect(report.summary.iterations).toMatchObject({
      total: 5,
      accepted: 1,
      firstPassAccepted: 1,
      firstPassSuccessRate: 0.25,
    });
  });

  it("treats a needs-revision round as a first-pass failure", () => {
    const firstRoundApplied = updateTask(
      createTask(
        {
          ...input,
          surface: { ...input.surface, id: "surface-revision-chain" },
          intent: { ...input.intent, id: "intent-revision-chain" },
        },
        new Date("2026-08-24T10:00:00.000Z"),
      ),
      { status: "applied" },
    );
    const reviewedFirstRound = reviewTask(
      firstRoundApplied,
      {
        expectedRevision: firstRoundApplied.revision,
        outcome: "needs_revision",
        revision: { instruction: "Move the button again" },
      },
      new Date("2026-08-24T10:05:00.000Z"),
    );
    const secondRoundApplied = updateTask(reviewedFirstRound.revisionTask!, {
      status: "applied",
    });
    const acceptedSecondRound = TaskSchema.parse({
      ...reviewTask(
        secondRoundApplied,
        {
          expectedRevision: secondRoundApplied.revision,
          outcome: "accepted",
        },
        new Date("2026-08-24T10:10:00.000Z"),
      ).task,
      batchId: "batch-second-round",
    });
    const secondRoundBatch = ApplyBatchSchema.parse({
      id: "batch-second-round",
      sessionId: "session-second-round",
      taskIds: [acceptedSecondRound.id],
      status: "completed",
      createdAt: "2026-08-24T10:06:00.000Z",
      updatedAt: "2026-08-24T10:09:00.000Z",
      completedAt: "2026-08-24T10:09:00.000Z",
    });

    const report = buildMetrics({
      tasks: [reviewedFirstRound.task, acceptedSecondRound],
      batches: [secondRoundBatch],
      executions: [],
      events: [],
    });

    expect(report.summary.iterations).toMatchObject({
      total: 1,
      accepted: 1,
      firstPassAccepted: 0,
      firstPassSuccessRate: 0,
      additionalRounds: 1,
    });
  });

  it("parses absolute and relative report windows", () => {
    expect(parseSince("2026-08-01")).toBe("2026-08-01T00:00:00.000Z");
    expect(parseSince("14d")).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(() => parseSince("soon")).toThrow("--since");
  });

  it("reports missing ratings without deriving stars from review outcomes", () => {
    const applied = updateTask(createTask(input), { status: "applied" });
    const accepted = reviewTask(applied, {
      expectedRevision: applied.revision,
      outcome: "accepted",
    }).task;

    const report = buildMetrics({
      tasks: [accepted],
      batches: [],
      executions: [],
      events: [],
    });

    expect(report.summary.reviews.accepted).toBe(1);
    expect(report.summary.ratings).toEqual({
      rated: 0,
      unratedApplied: 1,
      average: null,
      distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    });
    expect(formatMetricsTable(report.summary)).toContain("средняя —");
  });
});
