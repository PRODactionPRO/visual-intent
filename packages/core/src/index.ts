import { randomUUID } from "node:crypto";

import {
  CreateTaskSchema,
  ProjectSettingsSchema,
  TaskSchema,
  UpdateProjectSettingsSchema,
  UpdateTaskSchema,
  type CreateTask,
  type ApplyBatch,
  type ApproveDirtyBatch,
  type AttachExecutor,
  type BatchResult,
  type BatchStatus,
  type ConfigureProjectSession,
  type ProjectSession,
  type ProjectSettings,
  type Repository,
  type Task,
  type TaskStatus,
  type UpdateTask,
  type UpdateProjectSettings,
} from "@visual-intent/protocol";

export interface ListTasksFilter {
  status?: TaskStatus;
}

export interface TaskStore {
  list(filter?: ListTasksFilter): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
  create(input: CreateTask): Promise<Task>;
  update(id: string, patch: UpdateTask): Promise<Task>;
  delete(id: string): Promise<void>;
  getSettings(): Promise<ProjectSettings>;
  updateSettings(input: UpdateProjectSettings): Promise<ProjectSettings>;
  getSession(): Promise<ProjectSession | undefined>;
  configureSession(input: ConfigureProjectSession): Promise<ProjectSession>;
  attachExecutor(input: AttachExecutor): Promise<ProjectSession>;
  setExecutorState(
    status: ProjectSession["executor"]["status"],
    details?: { threadId?: string; lastError?: string },
  ): Promise<ProjectSession>;
  listBatches(): Promise<ApplyBatch[]>;
  getBatch(id: string): Promise<ApplyBatch | undefined>;
  dispatchReady(): Promise<ApplyBatch | undefined>;
  retryBatch(id: string): Promise<{ batch: ApplyBatch; tasks: Task[] }>;
  approveDirtyBatch(
    id: string,
    input: ApproveDirtyBatch,
  ): Promise<{ approved: boolean; batch: ApplyBatch; tasks: Task[] }>;
  claimBatch(id: string): Promise<{ batch: ApplyBatch; tasks: Task[] }>;
  finishBatch(
    id: string,
    status: Extract<BatchStatus, "completed" | "needs_input" | "failed">,
    result: BatchResult,
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }>;
  claimQueued(): Promise<Task[]>;
}

export class SessionNotConfiguredError extends Error {
  constructor() {
    super("Visual Intent project session is not configured");
    this.name = "SessionNotConfiguredError";
  }
}

export class RepositoryMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Executor repository mismatch: expected ${expected}, received ${actual}`,
    );
    this.name = "RepositoryMismatchError";
  }
}

export class BatchNotFoundError extends Error {
  constructor(id: string) {
    super(`Batch ${id} was not found`);
    this.name = "BatchNotFoundError";
  }
}

export class BatchStateConflictError extends Error {
  constructor(id: string, status: BatchStatus, operation: string) {
    super(`Batch ${id} cannot be ${operation} while its status is ${status}`);
    this.name = "BatchStateConflictError";
  }
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

export class ProjectSettingsRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(
      `Project settings revision conflict: expected ${expected}, actual ${actual}`,
    );
    this.name = "ProjectSettingsRevisionConflictError";
  }
}

export function updateProjectSettings(
  settings: ProjectSettings,
  input: UpdateProjectSettings,
  now = new Date(),
): ProjectSettings {
  const parsedSettings = ProjectSettingsSchema.parse(settings);
  const parsedInput = UpdateProjectSettingsSchema.parse(input);
  if (parsedInput.expectedRevision !== parsedSettings.revision) {
    throw new ProjectSettingsRevisionConflictError(
      parsedInput.expectedRevision,
      parsedSettings.revision,
    );
  }
  return ProjectSettingsSchema.parse({
    ...parsedSettings,
    dirtyWorktreePolicy: parsedInput.dirtyWorktreePolicy,
    revision: parsedSettings.revision + 1,
    updatedAt: now.toISOString(),
  });
}

export class TaskStateConflictError extends Error {
  constructor(id: string, status: TaskStatus, operation: string) {
    super(`Task ${id} cannot be ${operation} while its status is ${status}`);
    this.name = "TaskStateConflictError";
  }
}

export function createTask(
  input: CreateTask,
  now = new Date(),
  repository?: Repository,
): Task {
  const parsed = CreateTaskSchema.parse(input);
  const timestamp = now.toISOString();

  return TaskSchema.parse({
    ...parsed,
    id: randomUUID(),
    status: "ready",
    ...(repository ? { repository } : {}),
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

  if (parsedPatch.instruction !== undefined) {
    CreateTaskSchema.parse({
      ...task,
      intent: { ...task.intent, instruction: parsedPatch.instruction },
    });
  }

  const changes = {
    ...(parsedPatch.instruction !== undefined
      ? {
          intent: {
            ...task.intent,
            instruction: parsedPatch.instruction,
          },
          annotations: task.annotations.map((annotation) =>
            annotation.kind === "comment"
              ? { ...annotation, body: parsedPatch.instruction }
              : annotation,
          ),
        }
      : {}),
    ...(parsedPatch.attachments !== undefined
      ? { attachments: parsedPatch.attachments }
      : {}),
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
