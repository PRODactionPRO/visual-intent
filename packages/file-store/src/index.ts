import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  BatchNotFoundError,
  BatchStateConflictError,
  RepositoryMismatchError,
  updateProjectSettings,
  SessionNotConfiguredError,
  TaskStateConflictError,
  TaskNotFoundError,
  createTask,
  updateTask,
  type ListTasksFilter,
  type TaskStore,
} from "@visual-intent/core";
import {
  ApproveDirtyBatchSchema,
  ApplyBatchSchema,
  ProjectSessionSchema,
  ProjectSettingsSchema,
  PROTOCOL_VERSION,
  TaskSchema,
  type ApplyBatch,
  type ApproveDirtyBatch,
  type AttachExecutor,
  type BatchResult,
  type BatchStatus,
  type ConfigureProjectSession,
  type CreateTask,
  type ProjectSession,
  type ProjectSettings,
  type Repository,
  type Task,
  type UpdateTask,
  type UpdateProjectSettings,
  type WorkingTreeBaseline,
  type WorkingTreeFile,
} from "@visual-intent/protocol";

const execFileAsync = promisify(execFile);

interface StoreDocument {
  protocolVersion: typeof PROTOCOL_VERSION;
  tasks: Task[];
  settings: ProjectSettings;
  session?: ProjectSession;
  batches: ApplyBatch[];
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
};
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

export interface FileTaskStoreOptions {
  allowDirty?: boolean;
  captureWorkingTreeBaseline?: () => Promise<WorkingTreeBaseline>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FileTaskStore implements TaskStore {
  private readonly lockPath: string;

  constructor(
    readonly filePath: string,
    private readonly repository?: Repository,
    private readonly options: FileTaskStoreOptions = {},
  ) {
    this.lockPath = `${filePath}.lock`;
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
      const task = createTask(input, new Date(), this.repository);
      document.tasks.push(task);
      await this.writeDocument(document);
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
    });
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
      const session = ProjectSessionSchema.parse({
        id: existing?.id ?? randomUUID(),
        ...input,
        executor,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      document.session = session;
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
      const ownership = input.ownership ?? "host-attached";
      document.session = ProjectSessionSchema.parse({
        ...session,
        executor: {
          kind: "codex",
          status: "connected",
          ownership,
          threadId: input.threadId,
          source: input.source,
          attachedAt: now,
        },
        updatedAt: now,
      });
      document.batches = document.batches.map((batch) =>
        batch.status === "waiting_for_executor" || batch.status === "queued"
          ? ApplyBatchSchema.parse({
              ...batch,
              status: "waiting_for_executor",
              executorOwnership: ownership,
              executorThreadId: input.threadId,
              updatedAt: now,
            })
          : batch,
      );
      await this.writeDocument(document);
      return document.session;
    });
  }

  async setExecutorState(
    status: ProjectSession["executor"]["status"],
    details: { threadId?: string; lastError?: string } = {},
  ): Promise<ProjectSession> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const session = document.session;
      if (!session) throw new SessionNotConfiguredError();
      const now = new Date().toISOString();
      const threadId = details.threadId ?? session.executor.threadId;
      document.session = ProjectSessionSchema.parse({
        ...session,
        executor: {
          ...session.executor,
          kind: threadId ? "codex" : session.executor.kind,
          status,
          ...(threadId ? { threadId } : {}),
          ...(details.lastError ? { lastError: details.lastError } : {}),
        },
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

  async dispatchReady(): Promise<ApplyBatch | undefined> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const session = document.session;
      if (!session) throw new SessionNotConfiguredError();
      const readyTasks = document.tasks.filter(
        (task) => task.status === "ready",
      );
      if (readyTasks.length === 0) return undefined;

      const now = new Date().toISOString();
      const batchId = randomUUID();
      const baseline = await this.captureWorkingTreeBaseline();
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
      return batch;
    });
  }

  async retryBatch(id: string): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
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

      const now = new Date().toISOString();
      const status = dispatchStatus(session);
      const batchBase: ApplyBatch = { ...existing };
      delete batchBase.completedAt;
      delete batchBase.executorOwnership;
      delete batchBase.executorThreadId;
      delete batchBase.result;
      delete batchBase.startedAt;
      const batch = ApplyBatchSchema.parse({
        ...batchBase,
        status,
        ...(session.executor.kind === "codex"
          ? { executorOwnership: session.executor.ownership }
          : {}),
        ...(session.executor.threadId
          ? { executorThreadId: session.executor.threadId }
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
      delete batchBase.completedAt;
      delete batchBase.result;
      delete batchBase.startedAt;
      const status = dispatchStatus(session);
      const batch = ApplyBatchSchema.parse({
        ...batchBase,
        status,
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

  async claimBatch(id: string): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
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
      return {
        batch,
        tasks: document.tasks.filter((task) => batch.taskIds.includes(task.id)),
      };
    });
  }

  async finishBatch(
    id: string,
    status: Extract<BatchStatus, "completed" | "needs_input" | "failed">,
    result: BatchResult,
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    return this.withLock(async () => {
      const document = await this.readDocument();
      const index = document.batches.findIndex((batch) => batch.id === id);
      const existing = document.batches[index];
      if (index === -1 || !existing) throw new BatchNotFoundError(id);
      if (existing.status !== "in_progress") {
        throw new BatchStateConflictError(id, existing.status, "finished");
      }

      const now = new Date().toISOString();
      const currentBaseline = await this.captureWorkingTreeBaseline();
      const preExistingDirtyFiles = existing.workingTreeBaseline
        ? existing.workingTreeBaseline.files.map((file) => file.path).sort()
        : (result.preExistingDirtyFiles ?? []);
      const batchChangedFiles =
        existing.workingTreeBaseline && currentBaseline
          ? changedSince(existing.workingTreeBaseline, currentBaseline)
          : (result.batchChangedFiles ?? result.changedFiles);
      const normalizedResult: BatchResult = {
        ...result,
        changedFiles: batchChangedFiles,
        batchChangedFiles,
        preExistingDirtyFiles,
      };
      const batch = ApplyBatchSchema.parse({
        ...existing,
        status,
        result: normalizedResult,
        completedAt: now,
        updatedAt: now,
      });
      document.batches[index] = batch;
      const taskStatus: Task["status"] =
        status === "completed"
          ? "applied"
          : status === "needs_input"
            ? "needs_input"
            : "rejected";
      document.tasks = document.tasks.map((task) =>
        batch.taskIds.includes(task.id)
          ? updateTask(task, {
              status: taskStatus,
              result: {
                summary: normalizedResult.summary,
                changedFiles: normalizedResult.changedFiles,
                batchChangedFiles: normalizedResult.batchChangedFiles,
                preExistingDirtyFiles: normalizedResult.preExistingDirtyFiles,
                notes: normalizedResult.notes,
              },
            })
          : task,
      );
      if (document.session) {
        const executorStatus =
          status === "completed"
            ? "connected"
            : status === "needs_input"
              ? "needs_input"
              : "error";
        document.session = ProjectSessionSchema.parse({
          ...document.session,
          executor: {
            ...document.session.executor,
            status: executorStatus,
            ...(status === "failed" ? { lastError: result.summary } : {}),
          },
          updatedAt: now,
        });
      }
      await this.writeDocument(document);
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

  private async ensureDirectory(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  private async readDocument(): Promise<StoreDocument> {
    await this.ensureDirectory();

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
        tasks: value.tasks.map((task) => TaskSchema.parse(task)),
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
  return session.executor.kind === "codex" &&
    session.executor.ownership === "visual-intent-owned" &&
    session.executor.status !== "disconnected"
    ? "queued"
    : "waiting_for_executor";
}

function isRetryableFailure(batch: ApplyBatch): boolean {
  return (
    batch.result?.retryable === true ||
    isActiveWriterConflict(
      batch.result?.technicalDetails ?? batch.result?.summary ?? "",
    )
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
