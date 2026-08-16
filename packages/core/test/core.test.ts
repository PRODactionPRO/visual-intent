import { describe, expect, it } from "vitest";

import type { CreateTask } from "@visual-intent/protocol";

import { RevisionConflictError, createTask, updateTask } from "../src/index.js";

const input: CreateTask = {
  protocolVersion: "0.1",
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
});
