import { randomUUID } from "node:crypto";

import {
  CreateTaskSchema,
  TaskSchema,
  UpdateTaskSchema,
  type CreateTask,
  type Task,
  type TaskStatus,
  type UpdateTask,
} from "@visual-intent/protocol";

export interface ListTasksFilter {
  status?: TaskStatus;
}

export interface TaskStore {
  list(filter?: ListTasksFilter): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
  create(input: CreateTask): Promise<Task>;
  update(id: string, patch: UpdateTask): Promise<Task>;
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task ${id} was not found`);
    this.name = "TaskNotFoundError";
  }
}

export class RevisionConflictError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(
      `Task ${id} revision conflict: expected ${expected}, actual ${actual}`,
    );
    this.name = "RevisionConflictError";
  }
}

export function createTask(input: CreateTask, now = new Date()): Task {
  const parsed = CreateTaskSchema.parse(input);
  const timestamp = now.toISOString();

  return TaskSchema.parse({
    ...parsed,
    id: randomUUID(),
    status: "ready",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function updateTask(
  task: Task,
  patch: UpdateTask,
  now = new Date(),
): Task {
  const parsedPatch = UpdateTaskSchema.parse(patch);

  if (
    parsedPatch.expectedRevision !== undefined &&
    parsedPatch.expectedRevision !== task.revision
  ) {
    throw new RevisionConflictError(
      task.id,
      parsedPatch.expectedRevision,
      task.revision,
    );
  }

  const changes = {
    ...(parsedPatch.status !== undefined ? { status: parsedPatch.status } : {}),
    ...(parsedPatch.result !== undefined ? { result: parsedPatch.result } : {}),
  };

  return TaskSchema.parse({
    ...task,
    ...changes,
    revision: task.revision + 1,
    updatedAt: now.toISOString(),
  });
}
