import { describe, expect, it } from "vitest";

import type { CreateTask } from "@visual-intent/protocol";

import {
  ProjectSettingsRevisionConflictError,
  RevisionConflictError,
  TaskStateConflictError,
  createTask,
  rateTask,
  reviewTask,
  updateProjectSettings,
  updateTask,
} from "../src/index.js";

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
    instruction: "Make it clearer",
    acceptanceCriteria: [],
  },
};

describe("task lifecycle", () => {
  it("creates a ready task with a server-owned revision", () => {
    const task = createTask(input, new Date("2026-01-01T00:00:00.000Z"));

    expect(task.status).toBe("ready");
    expect(task.revision).toBe(1);
    expect(task.iterationId).toBe(task.id);
    expect(task.rootTaskId).toBe(task.id);
    expect(task.round).toBe(1);
    expect(task.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("updates a task using optimistic revision checks", () => {
    const task = createTask(input);
    const updated = updateTask(task, {
      expectedRevision: 1,
      status: "in_progress",
    });

    expect(updated.status).toBe("in_progress");
    expect(updated.revision).toBe(2);
  });

  it("rejects a stale update", () => {
    const task = createTask(input);

    expect(() =>
      updateTask(task, { expectedRevision: 2, status: "applied" }),
    ).toThrow(RevisionConflictError);
  });

  it("updates the intent and its comment together", () => {
    const task = createTask({
      ...input,
      annotations: [
        {
          id: "annotation-1",
          kind: "comment",
          body: "Make it clearer",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const updated = updateTask(task, {
      expectedRevision: 1,
      instruction: "Make the primary action clearer",
    });

    expect(updated.intent.instruction).toBe("Make the primary action clearer");
    expect(updated.annotations[0]?.body).toBe(
      "Make the primary action clearer",
    );
  });

  it("updates task attachments together with the comment", () => {
    const task = createTask(input);
    const attachment = {
      id: "attachment-1",
      kind: "screenshot" as const,
      mimeType: "image/png",
      fileName: "capture.png",
      byteSize: 128,
      sha256: "a".repeat(64),
      path: ".visual-intent/attachments/attachment-1.png",
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    const updated = updateTask(task, {
      expectedRevision: 1,
      instruction: "Make the primary action clearer",
      attachments: [attachment],
    });

    expect(updated.intent.instruction).toBe("Make the primary action clearer");
    expect(updated.attachments).toEqual([attachment]);
  });

  it("does not allow clearing a code-change instruction", () => {
    const task = createTask(input);

    expect(() =>
      updateTask(task, { expectedRevision: 1, instruction: "" }),
    ).toThrow("A code-change task requires an instruction");
  });

  it("keeps the technical result while accepting a task", () => {
    const applied = updateTask(createTask(input), { status: "applied" });
    const reviewed = reviewTask(
      applied,
      { expectedRevision: applied.revision, outcome: "accepted" },
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(reviewed.task.status).toBe("applied");
    expect(reviewed.task.review).toEqual({
      outcome: "accepted",
      reviewedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(reviewed.revisionTask).toBeUndefined();
  });

  it("atomically creates the next round for a requested revision", () => {
    const applied = updateTask(createTask(input), { status: "applied" });
    const reviewed = reviewTask(
      applied,
      {
        expectedRevision: applied.revision,
        outcome: "needs_revision",
        revision: { instruction: "Move it eight pixels lower" },
      },
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(reviewed.task.review?.outcome).toBe("needs_revision");
    expect(reviewed.task.review?.followUpTaskId).toBe(
      reviewed.revisionTask?.id,
    );
    expect(reviewed.revisionTask).toMatchObject({
      status: "ready",
      iterationId: applied.iterationId,
      rootTaskId: applied.rootTaskId,
      previousTaskId: applied.id,
      round: 2,
      revision: 1,
    });
    expect(reviewed.revisionTask?.intent.instruction).toBe(
      "Move it eight pixels lower",
    );
  });

  it("rates an applied task independently from its review", () => {
    const applied = updateTask(createTask(input), { status: "applied" });
    const reviewed = reviewTask(applied, {
      expectedRevision: applied.revision,
      outcome: "accepted",
    }).task;
    const rated = rateTask(
      reviewed,
      { expectedRevision: reviewed.revision, value: 4 },
      new Date("2026-01-03T00:00:00.000Z"),
    );
    const rerated = rateTask(
      rated,
      { expectedRevision: rated.revision, value: 2 },
      new Date("2026-01-04T00:00:00.000Z"),
    );

    expect(rated.rating).toEqual({
      value: 4,
      ratedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(rerated.rating?.value).toBe(2);
    expect(rerated.review).toEqual(reviewed.review);
    expect(rerated.revision).toBe(reviewed.revision + 2);
    expect(() =>
      rateTask(rerated, { expectedRevision: rated.revision, value: 5 }),
    ).toThrow(RevisionConflictError);
    expect(() =>
      rateTask(createTask(input), { expectedRevision: 1, value: 5 }),
    ).toThrow(TaskStateConflictError);
  });
});

describe("project settings", () => {
  const settings = {
    dirtyWorktreePolicy: "allow-host-attached" as const,
    revision: 1,
    updatedAt: "2026-08-19T00:00:00.000Z",
  };

  it("updates the policy with an optimistic revision", () => {
    const updated = updateProjectSettings(
      settings,
      {
        expectedRevision: 1,
        dirtyWorktreePolicy: "require-confirmation",
      },
      new Date("2026-08-19T01:00:00.000Z"),
    );

    expect(updated).toEqual({
      dirtyWorktreePolicy: "require-confirmation",
      revision: 2,
      updatedAt: "2026-08-19T01:00:00.000Z",
    });
  });

  it("rejects a stale settings revision", () => {
    expect(() =>
      updateProjectSettings(settings, {
        expectedRevision: 2,
        dirtyWorktreePolicy: "require-confirmation",
      }),
    ).toThrow(ProjectSettingsRevisionConflictError);
  });
});
