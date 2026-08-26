import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  BatchClaimConflictError,
  BatchNotFoundError,
  BatchStateConflictError,
  ExecutorThreadConflictError,
  InvalidUsageProvenanceError,
  RepositoryMismatchError,
  updateProjectSettings,
  SessionNotConfiguredError,
  TaskStateConflictError,
  TaskNotFoundError,
  createTask,
  rateTask,
  reviewTask,
  updateTask,
  type ListEventsFilter,
  type ListExecutionsFilter,
  type ListTasksFilter,
  type TaskStore,
} from "@visual-intent/core";
import {
  ApproveDirtyBatchSchema,
  ApplyBatchSchema,
  AgentTaskResultSchema,
  ClaimBatchSchema,
  ExecutionRecordSchema,
  FinishBatchClaimSchema,
  ProjectContextSnapshotSchema,
  ProjectSessionSchema,
  ProjectSettingsSchema,
  PROTOCOL_VERSION,
  RetryBatchSchema,
  TaskSchema,
  VisualIntentEventSchema,
  type ApplyBatch,
  type ApproveDirtyBatch,
  type BatchUsage,
  type AttachExecutor,
  type BatchResult,
  type BatchStatus,
  type ClaimBatch,
  type ConfigureProjectSession,
  type CreateTask,
  type ExecutionRecord,
  type FinishBatchClaim,
  type ProjectContextSnapshot,
  type ProjectSession,
  type ProjectSettings,
  type RateTask,
  type Repository,
  type RetryBatch,
  type ReviewTask,
  type Task,
  type UpdateTask,
  type UpdateProjectSettings,
  type WorkingTreeBaseline,
  type WorkingTreeFile,
  type VisualIntentEvent,
  type AgentTaskResult,
} from "@visual-intent/protocol";

const execFileAsync = promisify(execFile);

interface StoreDocument {
  protocolVersion: typeof PROTOCOL_VERSION;
  tasks: Task[];
  settings: ProjectSettings;
  session?: ProjectSession;
  batches: ApplyBatch[];
  executionOutbox: ExecutionRecord[];
}

const DEFAULT_SETTINGS = ProjectSettingsSchema.parse({
  dirtyWorktreePolicy: "allow-host-attached",
  revision: 1,
  updatedAt: "1970-01-01T00:00:00.000Z",
});

const EMPTY_STORE: StoreDocument = {
  protocolVersion: PROTOCOL_VERSION,
  tasks: [],
  settings: DEFAULT_SETTINGS,
  batches: [],
  executionOutbox: [],
};

function compareTaskDisplayOrder(left: Task, right: Task): number {
  return (
    (left.displayNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.displayNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function assignDisplayNumbers(tasks: Task[]): Task[] {
  const roots = [...tasks]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .reduce<string[]>((orderedRoots, task) => {
      const rootId = task.rootTaskId ?? task.id;
      if (!orderedRoots.includes(rootId)) orderedRoots.push(rootId);
      return orderedRoots;
    }, []);
  const numberByRoot = new Map<string, number>();
  const used = new Set<number>();
  for (const rootId of roots) {
    const requested = tasks.find(
      (task) =>
        (task.rootTaskId ?? task.id) === rootId &&
        typeof task.displayNumber === "number" &&
        !used.has(task.displayNumber),
    )?.displayNumber;
    let displayNumber = requested;
    if (!displayNumber) {
      displayNumber = 1;
      while (used.has(displayNumber)) displayNumber += 1;
    }
    numberByRoot.set(rootId, displayNumber);
    used.add(displayNumber);
  }
  return tasks.map((task) =>
    TaskSchema.parse({
      ...task,
      displayNumber: numberByRoot.get(task.rootTaskId ?? task.id),
    }),
  );
}
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

function ignoreMissingPath(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}

function ignoreMissingOrNonEmptyDirectory(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
}

export interface FileTaskStoreOptions {
  allowDirty?: boolean;
  captureWorkingTreeBaseline?: () => Promise<WorkingTreeBaseline>;
  captureProjectContext?: () => Promise<
    Pick<ProjectContextSnapshot, "revision" | "content"> | undefined
  >;
}

export interface ResetHistoryResult {
  tasks: number;
  batches: number;
  executionOutbox: number;
  events: number;
  executions: number;
  attachmentFiles: number;
}

export class HistoryResetBlockedError extends Error {
  constructor(
    readonly activeBatchIds: string[],
    readonly executorBusy: boolean,
  ) {
    const reasons = [
      activeBatchIds.length > 0
        ? `active Apply batches: ${activeBatchIds.join(", ")}`
        : undefined,
      executorBusy ? "the project executor is busy" : undefined,
    ].filter((reason): reason is string => reason !== undefined);
    super(`Visual Intent history reset is blocked by ${reasons.join(" and ")}`);
    this.name = "HistoryResetBlockedError";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FileTaskStore implements TaskStore {
  private readonly lockPath: string;
  private readonly usageDirectory: string;
  private readonly eventsPath: string;
  private readonly executionsPath: string;
  private readonly attachmentsDirectory: string;

  constructor(
    readonly filePath: string,
    private readonly repository?: Repository,
    private readonly options: FileTaskStoreOptions = {},
  ) {
    this.lockPath = `${filePath}.lock`;
    this.usageDirectory = join(dirname(filePath), "usage");
    this.eventsPath = join(this.usageDirectory, "events.jsonl");
    this.executionsPath = join(this.usageDirectory, "executions.jsonl");
    this.attachmentsDirectory = join(dirname(filePath), "attachments");
  }

  async resetHistory(): Promise<ResetHistoryResult> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const activeBatchIds = document.batches
        .filter((batch) =>
          ["waiting_for_executor", "queued", "in_progress"].includes(
            batch.status,
          ),
        )
        .map((batch) => batch.id);
      const executorBusy = document.session?.executor.status === "busy";
      if (activeBatchIds.length > 0 || executorBusy) {
        throw new HistoryResetBlockedError(activeBatchIds, executorBusy);
      }

      await Promise.all([
        this.assertResetPathIsNotSymlink(this.usageDirectory),
        this.assertResetPathIsNotSymlink(this.attachmentsDirectory),
      ]);
      const [events, executions, attachmentFiles] = await Promise.all([
        this.countNonEmptyLines(this.eventsPath),
        this.countNonEmptyLines(this.executionsPath),
        this.countAttachmentFiles(),
      ]);
      const result: ResetHistoryResult = {
        tasks: document.tasks.length,
        batches: document.batches.length,
        executionOutbox: document.executionOutbox.length,
        events,
        executions,
        attachmentFiles,
      };

      await this.writeDocument({
        ...document,
        tasks: [],
        batches: [],
        executionOutbox: [],
      });

      await Promise.all([
        unlink(this.eventsPath).catch(ignoreMissingPath),
        unlink(this.executionsPath).catch(ignoreMissingPath),
        rm(this.attachmentsDirectory, { recursive: true }).catch(
          ignoreMissingPath,
        ),
      ]);
      await rmdir(this.usageDirectory).catch(ignoreMissingOrNonEmptyDirectory);
      return result;
    });
  }

  async list(filter?: ListTasksFilter): Promise<Task[]> {
    const document = await this.readDocument();
    const tasks = filter?.status
      ? document.tasks.filter((task) => task.status === filter.status)
      : document.tasks;

    return [...tasks].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async get(id: string): Promise<Task | undefined> {
    const document = await this.readDocument();
    return document.tasks.find((task) => task.id === id);
  }

  async create(input: CreateTask): Promise<Task> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const usedDisplayNumbers = new Set(
        document.tasks
          .map((candidate) => candidate.displayNumber)
          .filter((value): value is number => typeof value === "number"),
      );
      const requestedDisplayNumber = input.displayNumber;
      const nextDisplayNumber = Math.max(0, ...usedDisplayNumbers) + 1;
      const displayNumber =
        requestedDisplayNumber &&
        !usedDisplayNumbers.has(requestedDisplayNumber)
          ? requestedDisplayNumber
          : nextDisplayNumber;
      const task = createTask(
        { ...input, displayNumber },
        new Date(),
        this.repository,
      );
      document.tasks.push(task);
      await this.writeDocument(document);
      await this.appendEvent({
        type: "task.created",
        actor: "user",
        task,
        sessionId: document.session?.id,
        data: {
          kind: task.kind,
          attachmentCount: task.attachments.length,
        },
      });
      return task;
    });
  }

  async update(id: string, patch: UpdateTask): Promise<Task> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const index = document.tasks.findIndex((task) => task.id === id);
      const existing = document.tasks[index];

      if (index === -1 || existing === undefined) {
        throw new TaskNotFoundError(id);
      }

      const task = updateTask(existing, patch);
      document.tasks[index] = task;
      await this.writeDocument(document);
      await this.appendEvent({
        type: "task.updated",
        actor: "user",
        task,
        sessionId: document.session?.id,
        data: {
          fields: Object.keys(patch).filter(
            (field) => field !== "instruction" && field !== "attachments",
          ),
          attachmentsChanged: patch.attachments !== undefined,
          instructionChanged: patch.instruction !== undefined,
        },
      });
      return task;
    });
  }

  async delete(id: string): Promise<void> {
    await this.withLock(async () => {
      const document = await this.readDocument();
      const index = document.tasks.findIndex((task) => task.id === id);
      if (index === -1) throw new TaskNotFoundError(id);
      const task = document.tasks[index];
      if (task && task.status !== "ready") {
        throw new TaskStateConflictError(id, task.status, "deleted");
      }
      document.tasks.splice(index, 1);
      await this.writeDocument(document);
      if (task) {
        await this.appendEvent({
          type: "task.deleted",
          actor: "user",
          task,
          sessionId: document.session?.id,
        });
      }
    });
  }

  async review(
    id: string,
    input: ReviewTask,
  ): Promise<{ task: Task; revisionTask?: Task }> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const index = document.tasks.findIndex((task) => task.id === id);
      const existing = document.tasks[index];
      if (index === -1 || !existing) throw new TaskNotFoundError(id);

      const reviewed = reviewTask(existing, input);
      document.tasks[index] = reviewed.task;
      if (reviewed.revisionTask) document.tasks.push(reviewed.revisionTask);
      await this.writeDocument(document);
      await this.appendEvent({
        type: "task.reviewed",
        actor: "user",
        task: reviewed.task,
        sessionId: document.session?.id,
        data: { outcome: reviewed.task.review?.outcome },
      });
      if (reviewed.revisionTask) {
        await this.appendEvent({
          type: "task.revision_created",
          actor: "user",
          task: reviewed.revisionTask,
          sessionId: document.session?.id,
          data: {
            previousTaskId: reviewed.task.id,
            attachmentCount: reviewed.revisionTask.attachments.length,
          },
        });
      }
      return reviewed;
    });
  }

  async rate(id: string, input: RateTask): Promise<Task> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const index = document.tasks.findIndex((task) => task.id === id);
      const existing = document.tasks[index];
      if (index === -1 || !existing) throw new TaskNotFoundError(id);

      const rated = rateTask(existing, input);
      document.tasks[index] = rated;
      await this.writeDocument(document);
      await this.appendEvent({
        type: "task.rated",
        actor: "user",
        task: rated,
        sessionId: document.session?.id,
        data: { value: rated.rating?.value },
      });
      return rated;
    });
  }

  async listEvents(
    filter: ListEventsFilter = {},
  ): Promise<VisualIntentEvent[]> {
    const events = await this.readJsonLines(
      this.eventsPath,
      VisualIntentEventSchema.parse,
    );
    return events.filter(
      (event) =>
        (!filter.since || event.occurredAt >= filter.since) &&
        (!filter.type || event.type === filter.type),
    );
  }

  async listExecutions(
    filter: ListExecutionsFilter = {},
  ): Promise<ExecutionRecord[]> {
    const projected = await this.readJsonLines(
      this.executionsPath,
      ExecutionRecordSchema.parse,
    );
    const pending = (await this.readDocument()).executionOutbox;
    const records = new Map<string, ExecutionRecord>();
    for (const record of [...projected, ...pending]) {
      records.set(executionRecordKey(record), record);
    }
    return [...records.values()].filter(
      (record) =>
        (!filter.since || record.completedAt >= filter.since) &&
        (!filter.batchId || record.batchId === filter.batchId),
    );
  }

  async getSettings(): Promise<ProjectSettings> {
    return (await this.readDocument()).settings;
  }

  async updateSettings(input: UpdateProjectSettings): Promise<ProjectSettings> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const settings = updateProjectSettings(document.settings, input);
      document.settings = settings;
      await this.writeDocument(document);
      return settings;
    });
  }

  async getSession(): Promise<ProjectSession | undefined> {
    return (await this.readDocument()).session;
  }

  async configureSession(
    input: ConfigureProjectSession,
  ): Promise<ProjectSession> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const existing = document.session;
      if (existing && existing.repository.root !== input.repository.root) {
        throw new RepositoryMismatchError(
          existing.repository.root,
          input.repository.root,
        );
      }

      const now = new Date().toISOString();
      const executor = input.executor ??
        existing?.executor ?? {
          kind: "disconnected" as const,
          status: "disconnected" as const,
          ownership: "host-attached" as const,
        };
      const sdkWorker =
        input.sdkWorker ??
        existing?.sdkWorker ??
        (existing?.executor.ownership === "visual-intent-owned"
          ? {
              kind: "codex" as const,
              ownership: "visual-intent-owned" as const,
              source: existing.executor.source ?? ("generated" as const),
              ...(existing.executor.threadId
                ? { threadId: existing.executor.threadId }
                : {}),
              ...(existing.executor.attachedAt
                ? { attachedAt: existing.executor.attachedAt }
                : {}),
            }
          : undefined);
      const session = ProjectSessionSchema.parse({
        id: existing?.id ?? randomUUID(),
        ...input,
        executor,
        ...(existing?.controller ? { controller: existing.controller } : {}),
        ...(sdkWorker ? { sdkWorker } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      document.session = session;
      if (
        existing &&
        hasExecutorRouteChanged(existing.executor, session.executor)
      ) {
        document.batches = retargetPendingBatches(
          document.batches,
          session.executor,
          now,
        );
      }
      this.recoverOrphanedTasks(document, session);
      await this.writeDocument(document);
      return session;
    });
  }

  async attachExecutor(input: AttachExecutor): Promise<ProjectSession> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const session = document.session;
      if (!session) throw new SessionNotConfiguredError();
      if (session.repository.root !== input.repositoryRoot) {
        throw new RepositoryMismatchError(
          session.repository.root,
          input.repositoryRoot,
        );
      }

      const now = new Date().toISOString();
      const sdkWorkerThreadId =
        session.sdkWorker?.threadId ??
        (session.executor.ownership === "visual-intent-owned"
          ? session.executor.threadId
          : undefined);
      if (sdkWorkerThreadId && sdkWorkerThreadId === input.threadId) {
        throw new ExecutorThreadConflictError(input.threadId);
      }
      const ownership = input.ownership ?? "host-attached";
      const controller = {
        kind: "codex" as const,
        threadId: input.threadId,
        source: input.source ?? ("plugin" as const),
        attachedAt: now,
      };
      const preservesVisualWorker =
        session.executor.ownership === "visual-intent-owned";
      document.session = ProjectSessionSchema.parse({
        ...session,
        controller,
        ...(preservesVisualWorker
          ? {}
          : {
              executor: {
                kind: "codex" as const,
                status: "connected" as const,
                ownership,
                threadId: input.threadId,
                source: input.source ?? ("plugin" as const),
                attachedAt: now,
              },
            }),
        updatedAt: now,
      });
      if (!preservesVisualWorker) {
        document.batches = retargetPendingBatches(
          document.batches,
          document.session.executor,
          now,
        );
      }
      await this.writeDocument(document);
      return document.session;
    });
  }

  async setExecutorState(
    status: ProjectSession["executor"]["status"],
    details: {
      threadId?: string;
      lastError?: string;
      expectedExecutor?: {
        ownership: ProjectSession["executor"]["ownership"];
        threadId?: string;
      };
    } = {},
  ): Promise<ProjectSession> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const session = document.session;
      if (!session) throw new SessionNotConfiguredError();
      const now = new Date().toISOString();
      const routeStillMatches =
        !details.expectedExecutor ||
        (session.executor.ownership === details.expectedExecutor.ownership &&
          session.executor.threadId === details.expectedExecutor.threadId);

      if (!routeStillMatches) {
        if (
          details.expectedExecutor?.ownership === "visual-intent-owned" &&
          details.threadId
        ) {
          const existingWorker = session.sdkWorker;
          document.session = ProjectSessionSchema.parse({
            ...session,
            sdkWorker: {
              kind: "codex" as const,
              ownership: "visual-intent-owned" as const,
              source: existingWorker?.source ?? ("generated" as const),
              threadId: details.threadId,
              attachedAt:
                existingWorker?.threadId === details.threadId &&
                existingWorker.attachedAt
                  ? existingWorker.attachedAt
                  : now,
            },
            updatedAt: now,
          });
          await this.writeDocument(document);
        }
        return document.session ?? session;
      }

      const threadId = details.threadId ?? session.executor.threadId;
      const attachedAt =
        details.threadId && details.threadId !== session.executor.threadId
          ? now
          : session.executor.attachedAt;
      const executor = {
        ...session.executor,
        kind: threadId ? ("codex" as const) : session.executor.kind,
        status,
        ...(threadId ? { threadId } : {}),
        ...(attachedAt ? { attachedAt } : {}),
        ...(details.lastError ? { lastError: details.lastError } : {}),
      };
      document.session = ProjectSessionSchema.parse({
        ...session,
        executor,
        ...(executor.ownership === "visual-intent-owned"
          ? {
              sdkWorker: {
                kind: "codex" as const,
                ownership: "visual-intent-owned" as const,
                source: executor.source ?? ("generated" as const),
                ...(executor.threadId ? { threadId: executor.threadId } : {}),
                ...(executor.attachedAt
                  ? { attachedAt: executor.attachedAt }
                  : {}),
              },
            }
          : {}),
        updatedAt: now,
      });
      await this.writeDocument(document);
      return document.session;
    });
  }

  async listBatches(): Promise<ApplyBatch[]> {
    return [...(await this.readDocument()).batches].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async getBatch(id: string): Promise<ApplyBatch | undefined> {
    return (await this.readDocument()).batches.find((batch) => batch.id === id);
  }

  async recoverInterruptedBatches(): Promise<ApplyBatch[]> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const interrupted = document.batches.filter(
        (batch) =>
          batch.status === "in_progress" &&
          batch.executorOwnership === "visual-intent-owned",
      );
      if (interrupted.length === 0) return [];

      const now = new Date().toISOString();
      const currentBaseline = await this.captureWorkingTreeBaseline();
      const recovered: ApplyBatch[] = [];
      const executions: ExecutionRecord[] = [];
      const summary =
        "The previous local SDK worker stopped before it returned a result. Review any partial working-tree changes before retrying.";

      for (const existing of interrupted) {
        const executionId = randomUUID();
        const executorThreadId =
          existing.executorThreadId ??
          (document.session?.executor.ownership === "visual-intent-owned"
            ? document.session.executor.threadId
            : undefined);
        const preExistingDirtyFiles =
          existing.workingTreeBaseline?.files.map((file) => file.path).sort() ??
          [];
        const batchChangedFiles =
          existing.workingTreeBaseline && currentBaseline
            ? changedSince(existing.workingTreeBaseline, currentBaseline)
            : [];
        const taskResults = existing.taskIds.map((taskId) =>
          AgentTaskResultSchema.parse({
            taskId,
            status: "failed",
            summary,
            changedFiles: batchChangedFiles,
            notes: [
              "Visual Intent preserved the working tree and did not commit, push, deploy, or roll back files.",
            ],
            classification: { categories: ["unknown"], scale: "unknown" },
          }),
        );
        const usage = {
          availability: "unavailable" as const,
          reason: "worker_interrupted_before_receipt",
        };
        const result: BatchResult = {
          summary,
          changedFiles: batchChangedFiles,
          batchChangedFiles,
          preExistingDirtyFiles,
          notes: [
            "Inspect the partial diff before using Retry; no files were rolled back automatically.",
          ],
          technicalDetails: "worker_interrupted",
          retryable: true,
          failureCode: "worker_interrupted",
          executionId,
          taskResults,
          usage,
        };
        const batch = ApplyBatchSchema.parse({
          ...existing,
          ...(executorThreadId ? { executorThreadId } : {}),
          status: "failed",
          result,
          completedAt: now,
          updatedAt: now,
        });
        const index = document.batches.findIndex(
          (candidate) => candidate.id === existing.id,
        );
        document.batches[index] = batch;
        recovered.push(batch);

        document.tasks = document.tasks.map((task) => {
          if (!existing.taskIds.includes(task.id)) return task;
          const taskResult = taskResults.find(
            (candidate) => candidate.taskId === task.id,
          );
          if (!taskResult) return task;
          return updateTask(task, {
            status: "rejected",
            result: {
              summary: taskResult.summary,
              changedFiles: taskResult.changedFiles,
              preExistingDirtyFiles,
              notes: taskResult.notes,
              classification: taskResult.classification,
            },
          });
        });

        const startedAt = existing.startedAt ?? existing.updatedAt;
        executions.push(
          ExecutionRecordSchema.parse({
            schemaVersion: 1,
            id: executionId,
            sessionId: existing.sessionId,
            batchId: existing.id,
            attempt: existing.attempt,
            taskIds: existing.taskIds,
            executorOwnership: "visual-intent-owned",
            ...(executorThreadId ? { executorThreadId } : {}),
            provider: "unknown",
            adapter: "visual-intent",
            status: "failed",
            startedAt,
            completedAt: now,
            durationMs: Math.max(
              0,
              new Date(now).getTime() - new Date(startedAt).getTime(),
            ),
            usage,
            taskResults,
          }),
        );
      }

      if (document.session) {
        document.session = ProjectSessionSchema.parse({
          ...document.session,
          executor: {
            ...document.session.executor,
            status: "error",
            lastError: summary,
          },
          updatedAt: now,
        });
      }
      document.executionOutbox.push(...executions);
      await this.writeDocument(document);
      await this.flushExecutionOutbox(document);
      for (const batch of recovered) {
        await this.appendEvent({
          type: "batch.finished",
          actor: "visual-intent",
          sessionId: batch.sessionId,
          batch,
          data: {
            status: "failed",
            taskCount: batch.taskIds.length,
            usageAvailability: "unavailable",
            executionId: batch.result?.executionId,
            failureCode: "worker_interrupted",
          },
        });
      }
      return recovered;
    });
  }

  async dispatchReady(): Promise<ApplyBatch | undefined> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const session = document.session;
      if (!session) throw new SessionNotConfiguredError();
      const readyTasks = document.tasks
        .filter((task) => task.status === "ready")
        .sort(compareTaskDisplayOrder);
      if (readyTasks.length === 0) return undefined;

      const now = new Date().toISOString();
      const batchId = randomUUID();
      const baseline = await this.captureWorkingTreeBaseline();
      const projectContext = await this.captureProjectContext(now);
      const settingsAllowHostAttached =
        document.settings.dirtyWorktreePolicy === "allow-host-attached" &&
        session.executor.kind === "codex" &&
        session.executor.ownership === "host-attached" &&
        session.executor.threadId !== undefined;
      const dirtyAllowed =
        Boolean(this.options.allowDirty) || settingsAllowHostAttached;
      const dirtyBlocked =
        baseline !== undefined && baseline.files.length > 0 && !dirtyAllowed;
      const status = dirtyBlocked ? "needs_input" : dispatchStatus(session);
      const batch = ApplyBatchSchema.parse({
        id: batchId,
        sessionId: session.id,
        taskIds: readyTasks.map((task) => task.id),
        status,
        ...(session.executor.kind === "codex"
          ? { executorOwnership: session.executor.ownership }
          : {}),
        ...(session.executor.threadId
          ? { executorThreadId: session.executor.threadId }
          : {}),
        ...(projectContext ? { projectContext } : {}),
        ...(baseline ? { workingTreeBaseline: baseline } : {}),
        ...(baseline && baseline.files.length > 0 && dirtyAllowed
          ? {
              dirtyWorktreeApproval: {
                approvedAt: now,
                baselineFingerprint: baseline.fingerprint,
                source: this.options.allowDirty
                  ? ("cli" as const)
                  : ("project-settings" as const),
              },
            }
          : {}),
        ...(dirtyBlocked ? { result: dirtyWorktreeResult(baseline) } : {}),
        createdAt: now,
        updatedAt: now,
      });

      document.tasks = document.tasks.map((task) =>
        task.status === "ready"
          ? this.transitionTask(
              task,
              dirtyBlocked ? "needs_input" : "queued",
              now,
              batchId,
            )
          : task,
      );
      if (dirtyBlocked) {
        document.session = ProjectSessionSchema.parse({
          ...session,
          executor: { ...session.executor, status: "needs_input" },
          updatedAt: now,
        });
      }
      document.batches.push(batch);
      await this.writeDocument(document);
      await this.appendEvent({
        type: "batch.dispatched",
        actor: "user",
        sessionId: session.id,
        batch,
        data: {
          taskCount: batch.taskIds.length,
          mode: batch.taskIds.length === 1 ? "single-task" : "multi-task",
          status: batch.status,
          dirtyFileCount: baseline?.files.length ?? 0,
        },
      });
      return batch;
    });
  }

  async retryBatch(
    id: string,
    input: RetryBatch = {},
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    const retry = RetryBatchSchema.parse(input);
    return this.withLock(async () => {
      const document = await this.readDocument();
      const session = document.session;
      if (!session) throw new SessionNotConfiguredError();
      const index = document.batches.findIndex((batch) => batch.id === id);
      const existing = document.batches[index];
      if (index === -1 || !existing) throw new BatchNotFoundError(id);
      if (existing.status !== "needs_input" && existing.status !== "failed") {
        throw new BatchStateConflictError(id, existing.status, "retried");
      }
      if (existing.result?.failureCode === "dirty_worktree_approval_required") {
        const currentBaseline = await this.captureWorkingTreeBaseline();
        if (!currentBaseline || currentBaseline.files.length > 0) {
          throw new BatchStateConflictError(
            id,
            existing.status,
            "retried without resolving or approving the dirty worktree",
          );
        }
      }
      if (existing.status === "failed" && !isRetryableFailure(existing)) {
        throw new BatchStateConflictError(id, existing.status, "retried");
      }
      if (
        existing.status === "needs_input" &&
        existing.result?.failureCode !== "dirty_worktree_approval_required" &&
        !retry.answer
      ) {
        throw new BatchStateConflictError(
          id,
          existing.status,
          "retried without a continuation answer",
        );
      }

      const now = new Date().toISOString();
      const status = dispatchStatus(session);
      const unresolvedTaskIds = existing.result?.taskResults
        ?.filter((result) => result.status !== "completed")
        .map((result) => result.taskId);
      const taskIds =
        unresolvedTaskIds && unresolvedTaskIds.length > 0
          ? unresolvedTaskIds
          : existing.taskIds;
      const batchBase: ApplyBatch = { ...existing };
      delete batchBase.claim;
      delete batchBase.completedAt;
      delete batchBase.continuation;
      delete batchBase.executorOwnership;
      delete batchBase.executorThreadId;
      delete batchBase.result;
      delete batchBase.startedAt;
      const batch = ApplyBatchSchema.parse({
        ...batchBase,
        taskIds,
        attempt: existing.attempt + 1,
        status,
        ...(session.executor.kind === "codex"
          ? { executorOwnership: session.executor.ownership }
          : {}),
        ...(session.executor.threadId
          ? { executorThreadId: session.executor.threadId }
          : {}),
        ...(retry.answer
          ? { continuation: { answer: retry.answer, answeredAt: now } }
          : {}),
        updatedAt: now,
      });
      document.batches[index] = batch;
      document.tasks = document.tasks.map((task) => {
        if (!batch.taskIds.includes(task.id)) return task;
        const taskBase: Task = { ...task };
        delete taskBase.result;
        return TaskSchema.parse({
          ...taskBase,
          status: "queued",
          batchId: batch.id,
          revision: task.revision + 1,
          updatedAt: now,
        });
      });
      const executorBase = { ...session.executor };
      delete executorBase.lastError;
      document.session = ProjectSessionSchema.parse({
        ...session,
        executor: {
          ...executorBase,
          status:
            session.executor.kind === "codex" ? "connected" : "disconnected",
        },
        updatedAt: now,
      });
      await this.writeDocument(document);
      await this.appendEvent({
        type: "batch.retried",
        actor: "user",
        sessionId: session.id,
        batch,
        data: { status: batch.status },
      });
      return {
        batch,
        tasks: document.tasks.filter((task) => batch.taskIds.includes(task.id)),
      };
    });
  }

  async approveDirtyBatch(
    id: string,
    input: ApproveDirtyBatch,
  ): Promise<{ approved: boolean; batch: ApplyBatch; tasks: Task[] }> {
    const approval = ApproveDirtyBatchSchema.parse(input);
    return this.withLock(async () => {
      const document = await this.readDocument();
      const session = document.session;
      if (!session) throw new SessionNotConfiguredError();
      const index = document.batches.findIndex((batch) => batch.id === id);
      const existing = document.batches[index];
      if (index === -1 || !existing) throw new BatchNotFoundError(id);
      if (
        existing.status !== "needs_input" ||
        existing.result?.failureCode !== "dirty_worktree_approval_required"
      ) {
        throw new BatchStateConflictError(
          id,
          existing.status,
          "approved for a dirty worktree",
        );
      }

      const baseline = await this.captureWorkingTreeBaseline();
      if (!baseline) {
        throw new Error(
          "Working-tree inspection is unavailable for this Visual Intent session",
        );
      }
      const now = new Date().toISOString();
      if (baseline.fingerprint !== approval.expectedBaselineFingerprint) {
        const batch = ApplyBatchSchema.parse({
          ...existing,
          workingTreeBaseline: baseline,
          result: dirtyWorktreeResult(baseline),
          updatedAt: now,
        });
        document.batches[index] = batch;
        await this.writeDocument(document);
        return {
          approved: false,
          batch,
          tasks: document.tasks.filter((task) =>
            batch.taskIds.includes(task.id),
          ),
        };
      }

      const batchBase: ApplyBatch = { ...existing };
      delete batchBase.claim;
      delete batchBase.completedAt;
      delete batchBase.executorOwnership;
      delete batchBase.executorThreadId;
      delete batchBase.result;
      delete batchBase.startedAt;
      const status = dispatchStatus(session);
      const batch = ApplyBatchSchema.parse({
        ...batchBase,
        status,
        ...(session.executor.kind === "codex"
          ? { executorOwnership: session.executor.ownership }
          : {}),
        ...(session.executor.threadId
          ? { executorThreadId: session.executor.threadId }
          : {}),
        workingTreeBaseline: baseline,
        dirtyWorktreeApproval: {
          approvedAt: now,
          baselineFingerprint: baseline.fingerprint,
          source: approval.source,
        },
        updatedAt: now,
      });
      document.batches[index] = batch;
      document.tasks = document.tasks.map((task) => {
        if (!batch.taskIds.includes(task.id)) return task;
        const taskBase: Task = { ...task };
        delete taskBase.result;
        return TaskSchema.parse({
          ...taskBase,
          status: "queued",
          revision: task.revision + 1,
          updatedAt: now,
        });
      });
      const executorBase = { ...session.executor };
      delete executorBase.lastError;
      document.session = ProjectSessionSchema.parse({
        ...session,
        executor: {
          ...executorBase,
          status:
            session.executor.kind === "codex" ? "connected" : "disconnected",
        },
        updatedAt: now,
      });
      await this.writeDocument(document);
      return {
        approved: true,
        batch,
        tasks: document.tasks.filter((task) => batch.taskIds.includes(task.id)),
      };
    });
  }

  async claimBatch(
    id: string,
    input: ClaimBatch = {},
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    const claimInput = ClaimBatchSchema.parse(input);
    return this.withLock(async () => {
      const document = await this.readDocument();
      const index = document.batches.findIndex((batch) => batch.id === id);
      const existing = document.batches[index];
      if (index === -1 || !existing) throw new BatchNotFoundError(id);
      if (
        existing.status !== "queued" &&
        existing.status !== "waiting_for_executor"
      ) {
        throw new BatchStateConflictError(id, existing.status, "claimed");
      }
      if (
        existing.executorOwnership === "visual-intent-owned" &&
        document.batches.some(
          (batch) =>
            batch.id !== existing.id &&
            batch.status === "in_progress" &&
            batch.executorOwnership === "visual-intent-owned",
        )
      ) {
        throw new BatchStateConflictError(
          id,
          existing.status,
          "claimed while another Visual Intent-owned batch is in progress",
        );
      }
      const executorOwnership =
        existing.executorOwnership ?? ("host-attached" as const);
      if (executorOwnership === "host-attached") {
        if (!existing.executorThreadId) {
          throw new BatchClaimConflictError(
            id,
            "the host-attached batch has no target Codex thread",
          );
        }
        if (!claimInput.controllerThreadId) {
          throw new BatchClaimConflictError(
            id,
            "controllerThreadId is required for a host-attached claim",
          );
        }
        if (claimInput.controllerThreadId !== existing.executorThreadId) {
          throw new BatchClaimConflictError(
            id,
            `controller ${claimInput.controllerThreadId} does not own target ${existing.executorThreadId}`,
          );
        }
      }

      const now = new Date().toISOString();
      const baseline = await this.captureWorkingTreeBaseline();
      const hasDirtyFiles = baseline !== undefined && baseline.files.length > 0;
      const approvedCurrentBaseline =
        hasDirtyFiles &&
        (this.options.allowDirty ||
          existing.dirtyWorktreeApproval?.baselineFingerprint ===
            baseline.fingerprint);
      if (hasDirtyFiles && !approvedCurrentBaseline) {
        const batch = ApplyBatchSchema.parse({
          ...existing,
          status: "needs_input",
          workingTreeBaseline: baseline,
          dirtyWorktreeApproval: undefined,
          result: dirtyWorktreeResult(baseline),
          updatedAt: now,
        });
        document.batches[index] = batch;
        document.tasks = document.tasks.map((task) =>
          batch.taskIds.includes(task.id)
            ? this.transitionTask(task, "needs_input", now, batch.id)
            : task,
        );
        if (document.session) {
          document.session = ProjectSessionSchema.parse({
            ...document.session,
            executor: { ...document.session.executor, status: "needs_input" },
            updatedAt: now,
          });
        }
        await this.writeDocument(document);
        return {
          batch,
          tasks: document.tasks.filter((task) =>
            batch.taskIds.includes(task.id),
          ),
        };
      }
      const batchBase: ApplyBatch = { ...existing };
      if (!hasDirtyFiles) delete batchBase.dirtyWorktreeApproval;
      const batch = ApplyBatchSchema.parse({
        ...batchBase,
        status: "in_progress",
        claim: {
          id: randomUUID(),
          attempt: existing.attempt,
          executorOwnership,
          ...(existing.executorThreadId
            ? { executorThreadId: existing.executorThreadId }
            : {}),
          ...(claimInput.controllerThreadId
            ? { controllerThreadId: claimInput.controllerThreadId }
            : {}),
          claimedAt: now,
        },
        ...(baseline ? { workingTreeBaseline: baseline } : {}),
        ...(hasDirtyFiles && this.options.allowDirty
          ? {
              dirtyWorktreeApproval: {
                approvedAt: now,
                baselineFingerprint: baseline.fingerprint,
                source: "cli" as const,
              },
            }
          : {}),
        startedAt: now,
        updatedAt: now,
      });
      document.batches[index] = batch;
      document.tasks = document.tasks.map((task) =>
        batch.taskIds.includes(task.id)
          ? this.transitionTask(task, "in_progress", now, batch.id)
          : task,
      );
      if (document.session) {
        document.session = ProjectSessionSchema.parse({
          ...document.session,
          executor: { ...document.session.executor, status: "busy" },
          updatedAt: now,
        });
      }
      await this.writeDocument(document);
      await this.appendEvent({
        type: "batch.claimed",
        actor: "agent",
        sessionId: document.session?.id,
        batch,
        data: { taskCount: batch.taskIds.length },
      });
      return {
        batch,
        tasks: document.tasks.filter((task) => batch.taskIds.includes(task.id)),
      };
    });
  }

  async finishBatch(
    id: string,
    _status: Extract<BatchStatus, "completed" | "needs_input" | "failed">,
    result: BatchResult,
    claim: FinishBatchClaim,
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    const finishClaim = FinishBatchClaimSchema.parse(claim);
    return this.withLock(async () => {
      const document = await this.readDocument();
      const index = document.batches.findIndex((batch) => batch.id === id);
      const existing = document.batches[index];
      if (index === -1 || !existing) throw new BatchNotFoundError(id);
      if (existing.status !== "in_progress") {
        throw new BatchStateConflictError(id, existing.status, "finished");
      }
      if (!existing.claim) {
        throw new BatchClaimConflictError(id, "the batch has no active claim");
      }
      if (existing.claim.id !== finishClaim.claimId) {
        throw new BatchClaimConflictError(id, "claimId does not match");
      }
      if (
        existing.claim.attempt !== finishClaim.expectedAttempt ||
        existing.attempt !== finishClaim.expectedAttempt
      ) {
        throw new BatchClaimConflictError(id, "attempt does not match");
      }
      if (existing.claim.executorOwnership === "host-attached") {
        if (!finishClaim.controllerThreadId) {
          throw new BatchClaimConflictError(
            id,
            "controllerThreadId is required to finish a host-attached claim",
          );
        }
        if (
          finishClaim.controllerThreadId !== existing.claim.controllerThreadId
        ) {
          throw new BatchClaimConflictError(
            id,
            "controllerThreadId does not match the controller that claimed the batch",
          );
        }
      }

      const now = new Date().toISOString();
      const executionId = result.executionId ?? randomUUID();
      const executorThreadId =
        existing.executorThreadId ??
        (existing.executorOwnership === "visual-intent-owned" &&
        document.session?.executor.ownership === "visual-intent-owned"
          ? document.session.executor.threadId
          : undefined);
      const reportedTaskResults = normalizeTaskResults(existing, result);
      const currentBaseline = await this.captureWorkingTreeBaseline();
      const preExistingDirtyFiles = existing.workingTreeBaseline
        ? existing.workingTreeBaseline.files.map((file) => file.path).sort()
        : (result.preExistingDirtyFiles ?? []);
      const batchChangedFiles =
        existing.workingTreeBaseline && currentBaseline
          ? changedSince(existing.workingTreeBaseline, currentBaseline)
          : (result.batchChangedFiles ?? result.changedFiles);
      const completionEvidence = applyCompletionEvidenceGuard(
        document.tasks.filter((task) => existing.taskIds.includes(task.id)),
        reportedTaskResults,
        batchChangedFiles,
      );
      const taskResults = completionEvidence.taskResults;
      const canonicalStatus = batchStatusFromTaskResults(taskResults);
      const normalizedUsage =
        result.usage ??
        ({
          availability: "unavailable",
          reason:
            existing.executorOwnership === "host-attached"
              ? "host_usage_not_exposed"
              : "execution_usage_not_reported",
        } as const);
      assertUsageProvenance(existing.executorOwnership, normalizedUsage);
      const normalizedResult: BatchResult = {
        ...result,
        ...(completionEvidence.missingTaskIds.length > 0
          ? {
              summary:
                "Visual Intent could not verify completion evidence for one or more code-change tasks.",
              technicalDetails: [
                result.technicalDetails,
                `Completed code-change tasks without a changed-file match: ${completionEvidence.missingTaskIds.join(", ")}`,
              ]
                .filter((detail): detail is string => Boolean(detail))
                .join("\n"),
              retryable: true,
              failureCode: "completion_evidence_missing",
            }
          : {}),
        executionId,
        taskResults,
        usage: normalizedUsage,
        changedFiles: batchChangedFiles,
        batchChangedFiles,
        preExistingDirtyFiles,
      };
      const batch = ApplyBatchSchema.parse({
        ...existing,
        ...(executorThreadId ? { executorThreadId } : {}),
        status: canonicalStatus,
        result: normalizedResult,
        completedAt: now,
        updatedAt: now,
      });
      document.batches[index] = batch;
      document.tasks = document.tasks.map((task) =>
        batch.taskIds.includes(task.id)
          ? (() => {
              const taskResult = taskResults.find(
                (candidate) => candidate.taskId === task.id,
              );
              if (!taskResult) {
                throw new Error(
                  `Missing result for Visual Intent task ${task.id}`,
                );
              }
              const taskStatus: Task["status"] =
                taskResult.status === "completed"
                  ? "applied"
                  : taskResult.status === "needs_input"
                    ? "needs_input"
                    : "rejected";
              return updateTask(task, {
                status: taskStatus,
                result: {
                  summary: taskResult.summary,
                  changedFiles: taskResult.changedFiles,
                  preExistingDirtyFiles: normalizedResult.preExistingDirtyFiles,
                  notes: taskResult.notes,
                  classification: taskResult.classification,
                },
              });
            })()
          : task,
      );
      if (document.session) {
        const executorStatus =
          canonicalStatus === "completed"
            ? "connected"
            : canonicalStatus === "needs_input"
              ? "needs_input"
              : "error";
        const routeStillOwnsBatch =
          (existing.executorOwnership ?? "host-attached") ===
            document.session.executor.ownership &&
          (existing.executorThreadId === undefined ||
            existing.executorThreadId === document.session.executor.threadId);
        if (routeStillOwnsBatch) {
          document.session = ProjectSessionSchema.parse({
            ...document.session,
            executor: {
              ...document.session.executor,
              status: executorStatus,
              ...(canonicalStatus === "failed"
                ? { lastError: result.summary }
                : {}),
            },
            updatedAt: now,
          });
        }
      }
      const startedAt = existing.startedAt ?? existing.updatedAt;
      const execution = ExecutionRecordSchema.parse({
        schemaVersion: 1,
        id: executionId,
        sessionId: existing.sessionId,
        batchId: existing.id,
        attempt: existing.attempt,
        taskIds: existing.taskIds,
        ...(existing.executorOwnership
          ? { executorOwnership: existing.executorOwnership }
          : {}),
        ...(executorThreadId ? { executorThreadId } : {}),
        provider:
          normalizedUsage.availability === "reported"
            ? (normalizedUsage.provider ?? "unknown")
            : "unknown",
        adapter:
          normalizedUsage.availability === "reported"
            ? normalizedUsage.source
            : existing.executorOwnership === "host-attached"
              ? "host-attached"
              : "visual-intent",
        ...(normalizedUsage.availability === "reported" &&
        normalizedUsage.adapterVersion
          ? { adapterVersion: normalizedUsage.adapterVersion }
          : {}),
        ...(normalizedUsage.availability === "reported" && normalizedUsage.model
          ? { model: normalizedUsage.model }
          : {}),
        ...(normalizedUsage.availability === "reported" &&
        normalizedUsage.reasoningPolicy
          ? { reasoningPolicy: normalizedUsage.reasoningPolicy }
          : {}),
        status: canonicalStatus,
        startedAt,
        completedAt: now,
        durationMs: Math.max(
          0,
          new Date(now).getTime() - new Date(startedAt).getTime(),
        ),
        usage: normalizedUsage,
        ...(normalizedResult.observedOperations
          ? { observedOperations: normalizedResult.observedOperations }
          : {}),
        taskResults,
      });
      document.executionOutbox.push(execution);
      await this.writeDocument(document);
      await this.flushExecutionOutbox(document);
      await this.appendEvent({
        type: "batch.finished",
        actor: "agent",
        sessionId: existing.sessionId,
        batch,
        data: {
          status: canonicalStatus,
          taskCount: batch.taskIds.length,
          usageAvailability: normalizedUsage.availability,
          executionId,
        },
      });
      return {
        batch,
        tasks: document.tasks.filter((task) => batch.taskIds.includes(task.id)),
      };
    });
  }

  async claimQueued(): Promise<Task[]> {
    return this.transitionAll("queued", "in_progress");
  }

  private async captureWorkingTreeBaseline(): Promise<
    WorkingTreeBaseline | undefined
  > {
    return this.options.captureWorkingTreeBaseline?.();
  }

  private async captureProjectContext(
    capturedAt: string,
  ): Promise<ProjectContextSnapshot | undefined> {
    const context = await this.options.captureProjectContext?.();
    return context
      ? ProjectContextSnapshotSchema.parse({ ...context, capturedAt })
      : undefined;
  }

  private transitionTask(
    task: Task,
    status: Task["status"],
    updatedAt: string,
    batchId?: string,
  ): Task {
    const repositoryBoundTask =
      this.repository && !task.repository
        ? TaskSchema.parse({ ...task, repository: this.repository })
        : task;
    return TaskSchema.parse({
      ...repositoryBoundTask,
      status,
      ...(batchId ? { batchId } : {}),
      revision: repositoryBoundTask.revision + 1,
      updatedAt,
    });
  }

  private recoverOrphanedTasks(
    document: StoreDocument,
    session: ProjectSession,
  ): void {
    const orphaned = document.tasks.filter(
      (task) =>
        (task.status === "queued" || task.status === "in_progress") &&
        !task.batchId,
    );
    if (orphaned.length === 0) return;

    const now = new Date().toISOString();
    const batchId = randomUUID();
    const status = dispatchStatus(session);
    document.tasks = document.tasks.map((task) =>
      orphaned.some((item) => item.id === task.id)
        ? this.transitionTask(task, "queued", now, batchId)
        : task,
    );
    document.batches.push(
      ApplyBatchSchema.parse({
        id: batchId,
        sessionId: session.id,
        taskIds: orphaned.map((task) => task.id),
        status,
        ...(session.executor.kind === "codex"
          ? { executorOwnership: session.executor.ownership }
          : {}),
        ...(session.executor.threadId
          ? { executorThreadId: session.executor.threadId }
          : {}),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  private async transitionAll(
    from: Task["status"],
    to: Task["status"],
  ): Promise<Task[]> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const changed: Task[] = [];

      document.tasks = document.tasks.map((task) => {
        if (task.status !== from) return task;
        const repositoryBoundTask =
          from === "ready" && this.repository && !task.repository
            ? TaskSchema.parse({ ...task, repository: this.repository })
            : task;
        const updated = this.transitionTask(
          repositoryBoundTask,
          to,
          new Date().toISOString(),
        );
        changed.push(updated);
        return updated;
      });

      if (changed.length > 0) await this.writeDocument(document);
      return changed;
    });
  }

  private async appendEvent(input: {
    type: VisualIntentEvent["type"];
    actor: VisualIntentEvent["actor"];
    sessionId?: string;
    task?: Task;
    batch?: ApplyBatch;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const event = VisualIntentEventSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      type: input.type,
      occurredAt: new Date().toISOString(),
      actor: input.actor,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.task
        ? {
            taskId: input.task.id,
            iterationId: input.task.iterationId,
            round: input.task.round,
          }
        : {}),
      ...(input.batch
        ? {
            batchId: input.batch.id,
            attempt: input.batch.attempt,
          }
        : {}),
      ...(input.data ? { data: input.data } : {}),
    });
    await this.appendJsonLine(this.eventsPath, event);
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    try {
      await mkdir(this.usageDirectory, { recursive: true });
      await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
    } catch (error) {
      process.emitWarning(
        `Visual Intent preserved operational state but could not append local analytics at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async flushExecutionOutbox(document: StoreDocument): Promise<void> {
    if (document.executionOutbox.length === 0) return;

    try {
      await this.repairExecutionProjectionTail();
      const projected = await this.readJsonLines(
        this.executionsPath,
        ExecutionRecordSchema.parse,
      );
      const projectedKeys = new Set(projected.map(executionRecordKey));
      for (const execution of document.executionOutbox) {
        const key = executionRecordKey(execution);
        if (projectedKeys.has(key)) continue;
        await this.appendJsonLineStrict(this.executionsPath, execution);
        projectedKeys.add(key);
      }
      document.executionOutbox = [];
      await this.writeDocument(document);
    } catch (error) {
      process.emitWarning(
        `Visual Intent kept ${document.executionOutbox.length} execution receipt(s) in the durable outbox because the JSONL projection could not be updated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async repairExecutionProjectionTail(): Promise<void> {
    const raw = await readFile(this.executionsPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    if (!raw || raw.endsWith("\n")) return;

    const lastNewline = raw.lastIndexOf("\n");
    const tail = raw.slice(lastNewline + 1);
    try {
      ExecutionRecordSchema.parse(JSON.parse(tail) as unknown);
      await appendFile(this.executionsPath, "\n", "utf8");
    } catch {
      await writeFile(
        this.executionsPath,
        lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "",
        "utf8",
      );
    }
  }

  private async appendJsonLineStrict(
    path: string,
    value: unknown,
  ): Promise<void> {
    await mkdir(this.usageDirectory, { recursive: true });
    await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
  }

  private async readJsonLines<T>(
    path: string,
    parse: (value: unknown) => T,
  ): Promise<T[]> {
    const raw = await readFile(path, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    return raw
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .flatMap((line, index, lines) => {
        try {
          return [parse(JSON.parse(line) as unknown)];
        } catch (error) {
          const incompleteLastLine =
            index === lines.length - 1 && !raw.endsWith("\n");
          if (incompleteLastLine) return [];
          throw new Error(
            `Invalid Visual Intent analytics record at ${path}:${index + 1}`,
            { cause: error },
          );
        }
      });
  }

  private async countNonEmptyLines(path: string): Promise<number> {
    const raw = await readFile(path, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    return raw.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
  }

  private async countAttachmentFiles(): Promise<number> {
    return readdir(this.attachmentsDirectory).then(
      (entries) => entries.length,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    );
  }

  private async assertResetPathIsNotSymlink(path: string): Promise<void> {
    const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (details?.isSymbolicLink()) {
      throw new Error(
        `Refusing to reset Visual Intent history via symlink: ${path}`,
      );
    }
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  private async readDocument(): Promise<StoreDocument> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const value = JSON.parse(raw) as unknown;

      if (
        typeof value !== "object" ||
        value === null ||
        !("protocolVersion" in value) ||
        value.protocolVersion !== PROTOCOL_VERSION ||
        !("tasks" in value) ||
        !Array.isArray(value.tasks)
      ) {
        throw new Error(`Invalid Visual Intent store at ${this.filePath}`);
      }

      return {
        protocolVersion: PROTOCOL_VERSION,
        tasks: assignDisplayNumbers(
          value.tasks.map((task) => TaskSchema.parse(task)),
        ),
        settings:
          "settings" in value && value.settings !== undefined
            ? ProjectSettingsSchema.parse(value.settings)
            : structuredClone(DEFAULT_SETTINGS),
        session:
          "session" in value && value.session !== undefined
            ? ProjectSessionSchema.parse(value.session)
            : undefined,
        batches:
          "batches" in value && Array.isArray(value.batches)
            ? value.batches.map(parseStoredBatch)
            : [],
        executionOutbox:
          "executionOutbox" in value && Array.isArray(value.executionOutbox)
            ? value.executionOutbox.map((record) =>
                ExecutionRecordSchema.parse(record),
              )
            : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_STORE);
      }

      throw error;
    }
  }

  private async writeDocument(document: StoreDocument): Promise<void> {
    await this.ensureDirectory();
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();

    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const handle = await open(this.lockPath, "wx");

        try {
          const document = await this.readDocument();
          await this.flushExecutionOutbox(document);
          return await operation();
        } finally {
          await handle.close();
          await unlink(this.lockPath).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        await this.removeStaleLock();
        await delay(LOCK_RETRY_MS);
      }
    }

    throw new Error(`Timed out waiting for task store lock ${this.lockPath}`);
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const details = await stat(this.lockPath);
      if (Date.now() - details.mtimeMs > STALE_LOCK_MS) {
        await unlink(this.lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function dispatchStatus(session: ProjectSession): ApplyBatch["status"] {
  return dispatchStatusForExecutor(session.executor);
}

function assertUsageProvenance(
  ownership: ApplyBatch["executorOwnership"],
  usage: BatchUsage,
): void {
  if (usage.availability !== "reported") return;
  const expectedCapture =
    ownership === "visual-intent-owned" ? "direct" : "host-reported";
  if (usage.capture !== expectedCapture) {
    throw new InvalidUsageProvenanceError(ownership, usage.capture);
  }
}

function dispatchStatusForExecutor(
  executor: ProjectSession["executor"],
): ApplyBatch["status"] {
  return executor.kind === "codex" &&
    executor.ownership === "visual-intent-owned" &&
    executor.status !== "disconnected"
    ? "queued"
    : "waiting_for_executor";
}

function hasExecutorRouteChanged(
  previous: ProjectSession["executor"],
  next: ProjectSession["executor"],
): boolean {
  return (
    previous.kind !== next.kind ||
    previous.ownership !== next.ownership ||
    previous.threadId !== next.threadId ||
    dispatchStatusForExecutor(previous) !== dispatchStatusForExecutor(next)
  );
}

function retargetPendingBatches(
  batches: ApplyBatch[],
  executor: ProjectSession["executor"],
  updatedAt: string,
): ApplyBatch[] {
  return batches.map((batch) => {
    if (batch.status !== "waiting_for_executor" && batch.status !== "queued") {
      return batch;
    }
    const batchBase: ApplyBatch = { ...batch };
    delete batchBase.claim;
    delete batchBase.executorOwnership;
    delete batchBase.executorThreadId;
    return ApplyBatchSchema.parse({
      ...batchBase,
      status: dispatchStatusForExecutor(executor),
      ...(executor.kind === "codex"
        ? { executorOwnership: executor.ownership }
        : {}),
      ...(executor.threadId ? { executorThreadId: executor.threadId } : {}),
      updatedAt,
    });
  });
}

function isRetryableFailure(batch: ApplyBatch): boolean {
  const failureMessage =
    batch.result?.technicalDetails ?? batch.result?.summary ?? "";
  return (
    batch.result?.retryable === true ||
    isActiveWriterConflict(failureMessage) ||
    isInvalidJsonSchemaFailure(failureMessage)
  );
}

function parseStoredBatch(value: unknown): ApplyBatch {
  const batch = ApplyBatchSchema.parse(value);
  if (
    batch.status !== "failed" ||
    !batch.result ||
    batch.result.retryable !== undefined ||
    !isActiveWriterConflict(batch.result.summary)
  ) {
    return batch;
  }

  return ApplyBatchSchema.parse({
    ...batch,
    executorOwnership: batch.executorOwnership ?? "host-attached",
    result: {
      ...batch.result,
      summary: "Codex delivery conflicted with an active host-owned thread.",
      technicalDetails: batch.result.summary,
      retryable: true,
      failureCode: "host_thread_active_writer",
    },
  });
}

function isActiveWriterConflict(message: string): boolean {
  return /already has an active writer|thread-store conflict/iu.test(message);
}

function isInvalidJsonSchemaFailure(message: string): boolean {
  return /invalid_json_schema/iu.test(message);
}

function normalizeTaskResults(
  batch: ApplyBatch,
  result: BatchResult,
): AgentTaskResult[] {
  if (!result.taskResults) {
    throw new Error(
      "Visual Intent finish results must include exactly one taskResults entry for every task in the Apply batch",
    );
  }

  const parsed = result.taskResults.map((item) =>
    AgentTaskResultSchema.parse(item),
  );
  const resultIds = parsed.map((item) => item.taskId);
  if (new Set(resultIds).size !== resultIds.length) {
    throw new Error("Visual Intent task results contain duplicate task IDs");
  }
  const expected = [...batch.taskIds].sort();
  const actual = [...resultIds].sort();
  if (
    expected.length !== actual.length ||
    expected.some((taskId, index) => taskId !== actual[index])
  ) {
    throw new Error(
      "Visual Intent task results must cover every task in the Apply batch exactly once",
    );
  }
  return parsed;
}

function applyCompletionEvidenceGuard(
  tasks: Task[],
  taskResults: AgentTaskResult[],
  batchChangedFiles: string[],
): { taskResults: AgentTaskResult[]; missingTaskIds: string[] } {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const canonicalChangedFiles = new Set(
    batchChangedFiles.map(normalizeEvidencePath),
  );
  const missingTaskIds: string[] = [];
  const guardedResults = taskResults.map((taskResult) => {
    const task = taskById.get(taskResult.taskId);
    if (
      task?.kind !== "code-change" ||
      taskResult.status !== "completed" ||
      taskResult.changedFiles.some((path) =>
        canonicalChangedFiles.has(normalizeEvidencePath(path)),
      )
    ) {
      return taskResult;
    }

    missingTaskIds.push(taskResult.taskId);
    return AgentTaskResultSchema.parse({
      ...taskResult,
      status: "failed",
      summary:
        "Visual Intent could not match this completed code-change task to a file changed by the current Apply batch.",
      notes: [
        ...taskResult.notes,
        "Retry the task and report at least one changed file that is present in the canonical batchChangedFiles list.",
      ],
    });
  });

  return { taskResults: guardedResults, missingTaskIds };
}

function normalizeEvidencePath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
}

function batchStatusFromTaskResults(
  taskResults: AgentTaskResult[],
): Extract<BatchStatus, "completed" | "needs_input" | "failed"> {
  if (taskResults.some((result) => result.status === "failed")) {
    return "failed";
  }
  if (taskResults.some((result) => result.status === "needs_input")) {
    return "needs_input";
  }
  return "completed";
}

function executionRecordKey(record: ExecutionRecord): string {
  return `${record.batchId}:${record.attempt}`;
}

function dirtyWorktreeResult(baseline: WorkingTreeBaseline): BatchResult {
  const files = baseline.files.map((file) => file.path).sort();
  return {
    summary:
      "В репозитории уже есть незакоммиченные изменения. Visual Intent остановил пакет до явного подтверждения.",
    changedFiles: [],
    batchChangedFiles: [],
    preExistingDirtyFiles: files,
    notes: [
      "Проверьте список файлов и подтвердите продолжение поверх текущих изменений только для этого Apply-пакета.",
    ],
    retryable: false,
    failureCode: "dirty_worktree_approval_required",
  };
}

function changedSince(
  baseline: WorkingTreeBaseline,
  current: WorkingTreeBaseline,
): string[] {
  const before = new Map(
    baseline.files.map((file) => [
      file.path,
      `${file.status}\0${file.fingerprint}`,
    ]),
  );
  const after = new Map(
    current.files.map((file) => [
      file.path,
      `${file.status}\0${file.fingerprint}`,
    ]),
  );
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

export async function captureGitWorkingTreeBaseline(
  repositoryRoot: string,
): Promise<WorkingTreeBaseline> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      repositoryRoot,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const entries = stdout.split("\0");
  const files: WorkingTreeFile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (status.includes("R") || status.includes("C")) index += 1;
    if (path === ".visual-intent" || path.startsWith(".visual-intent/")) {
      continue;
    }
    files.push({
      path,
      status,
      fingerprint: await fingerprintPath(join(repositoryRoot, path)),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    capturedAt: new Date().toISOString(),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
    files,
  };
}

async function fingerprintPath(path: string): Promise<string> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      return `symlink:${await readlink(path)}`;
    }
    if (!details.isFile()) {
      return `other:${details.mode}:${details.size}:${details.mtimeMs}`;
    }
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return `file:${details.mode}:${hash.digest("hex")}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return `unavailable:${code}`;
  }
}
