import { randomUUID } from "node:crypto";

import {
  CreateTaskSchema,
  ProjectSettingsSchema,
  RateTaskSchema,
  ReviewTaskSchema,
  TaskSchema,
  UpdateProjectSettingsSchema,
  UpdateTaskSchema,
  type CreateTask,
  type ApplyBatch,
  type ApproveDirtyBatch,
  type AttachExecutor,
  type BatchResult,
  type BatchStatus,
  type ClaimBatch,
  type ConfigureProjectSession,
  type FinishBatchClaim,
  type ProjectSession,
  type ProjectSettings,
  type RateTask,
  type Repository,
  type RetryBatch,
  type ReviewTask,
  type Task,
  type TaskStatus,
  type UpdateTask,
  type UpdateProjectSettings,
  type ExecutionRecord,
  type VisualIntentEvent,
} from "@visual-intent/protocol";

export interface ListTasksFilter {
  status?: TaskStatus;
}

export interface ListEventsFilter {
  since?: string;
  type?: VisualIntentEvent["type"];
}

export interface ListExecutionsFilter {
  since?: string;
  batchId?: string;
}

export interface TaskStore {
  list(filter?: ListTasksFilter): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
  create(input: CreateTask): Promise<Task>;
  update(id: string, patch: UpdateTask): Promise<Task>;
  delete(id: string): Promise<void>;
  review(
    id: string,
    input: ReviewTask,
  ): Promise<{ task: Task; revisionTask?: Task }>;
  rate(id: string, input: RateTask): Promise<Task>;
  listEvents(filter?: ListEventsFilter): Promise<VisualIntentEvent[]>;
  listExecutions(filter?: ListExecutionsFilter): Promise<ExecutionRecord[]>;
  getSettings(): Promise<ProjectSettings>;
  updateSettings(input: UpdateProjectSettings): Promise<ProjectSettings>;
  getSession(): Promise<ProjectSession | undefined>;
  configureSession(input: ConfigureProjectSession): Promise<ProjectSession>;
  attachExecutor(input: AttachExecutor): Promise<ProjectSession>;
  setExecutorState(
    status: ProjectSession["executor"]["status"],
    details?: {
      threadId?: string;
      lastError?: string;
      expectedExecutor?: {
        ownership: ProjectSession["executor"]["ownership"];
        threadId?: string;
      };
    },
  ): Promise<ProjectSession>;
  listBatches(): Promise<ApplyBatch[]>;
  getBatch(id: string): Promise<ApplyBatch | undefined>;
  recoverInterruptedBatches?(): Promise<ApplyBatch[]>;
  dispatchReady(): Promise<ApplyBatch | undefined>;
  retryBatch(
    id: string,
    input?: RetryBatch,
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }>;
  approveDirtyBatch(
    id: string,
    input: ApproveDirtyBatch,
  ): Promise<{ approved: boolean; batch: ApplyBatch; tasks: Task[] }>;
  claimBatch(
    id: string,
    input?: ClaimBatch,
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }>;
  finishBatch(
    id: string,
    status: Extract<BatchStatus, "completed" | "needs_input" | "failed">,
    result: BatchResult,
    claim: FinishBatchClaim,
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

export class ExecutorThreadConflictError extends Error {
  constructor(threadId: string) {
    super(
      `Codex thread ${threadId} cannot be both the Visual Intent controller and the autonomous SDK worker`,
    );
    this.name = "ExecutorThreadConflictError";
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

export class BatchClaimConflictError extends Error {
  constructor(id: string, reason: string) {
    super(`Batch ${id} claim is invalid: ${reason}`);
    this.name = "BatchClaimConflictError";
  }
}

export class InvalidUsageProvenanceError extends Error {
  constructor(
    ownership: "host-attached" | "visual-intent-owned" | undefined,
    capture: "direct" | "host-reported",
  ) {
    const expected =
      ownership === "visual-intent-owned" ? "direct" : "host-reported";
    super(
      `Usage capture ${capture} is invalid for ${ownership ?? "legacy host-attached"} execution; expected ${expected}`,
    );
    this.name = "InvalidUsageProvenanceError";
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

export class TaskAlreadyReviewedError extends Error {
  constructor(id: string) {
    super(`Task ${id} has already been reviewed`);
    this.name = "TaskAlreadyReviewedError";
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
  const taskId = randomUUID();

  return TaskSchema.parse({
    ...parsed,
    id: taskId,
    status: "ready",
    ...(repository ? { repository } : {}),
    iterationId: taskId,
    rootTaskId: taskId,
    round: 1,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function reviewTask(
  task: Task,
  input: ReviewTask,
  now = new Date(),
): { task: Task; revisionTask?: Task } {
  const parsedInput = ReviewTaskSchema.parse(input);
  if (parsedInput.expectedRevision !== task.revision) {
    throw new RevisionConflictError(
      task.id,
      parsedInput.expectedRevision,
      task.revision,
    );
  }
  if (task.status !== "applied") {
    throw new TaskStateConflictError(task.id, task.status, "reviewed");
  }
  if (task.review) throw new TaskAlreadyReviewedError(task.id);

  const timestamp = now.toISOString();
  if (parsedInput.outcome !== "needs_revision") {
    return {
      task: TaskSchema.parse({
        ...task,
        review: {
          outcome: parsedInput.outcome,
          reviewedAt: timestamp,
          ...(parsedInput.note ? { note: parsedInput.note } : {}),
        },
        revision: task.revision + 1,
        updatedAt: timestamp,
      }),
    };
  }

  const revision = parsedInput.revision;
  if (!revision) {
    throw new Error("A needs-revision review requires a revision task");
  }
  const revisionTaskId = randomUUID();
  const revisionTaskBase: Record<string, unknown> = {
    ...task,
    id: revisionTaskId,
    status: "ready",
    iterationId: task.iterationId,
    rootTaskId: task.rootTaskId,
    previousTaskId: task.id,
    round: task.round + 1,
    intent: { ...task.intent, instruction: revision.instruction },
    annotations: task.annotations.map((annotation) =>
      annotation.kind === "comment"
        ? { ...annotation, body: revision.instruction, createdAt: timestamp }
        : annotation,
    ),
    attachments: revision.attachments ?? task.attachments,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  delete revisionTaskBase.batchId;
  delete revisionTaskBase.result;
  delete revisionTaskBase.review;
  const revisionTask = TaskSchema.parse(revisionTaskBase);

  return {
    task: TaskSchema.parse({
      ...task,
      review: {
        outcome: "needs_revision",
        reviewedAt: timestamp,
        ...(parsedInput.note ? { note: parsedInput.note } : {}),
        followUpTaskId: revisionTask.id,
      },
      revision: task.revision + 1,
      updatedAt: timestamp,
    }),
    revisionTask,
  };
}

export function rateTask(task: Task, input: RateTask, now = new Date()): Task {
  const parsedInput = RateTaskSchema.parse(input);
  if (parsedInput.expectedRevision !== task.revision) {
    throw new RevisionConflictError(
      task.id,
      parsedInput.expectedRevision,
      task.revision,
    );
  }
  if (task.status !== "applied") {
    throw new TaskStateConflictError(task.id, task.status, "rated");
  }

  const timestamp = now.toISOString();
  return TaskSchema.parse({
    ...task,
    rating: { value: parsedInput.value, ratedAt: timestamp },
    revision: task.revision + 1,
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
