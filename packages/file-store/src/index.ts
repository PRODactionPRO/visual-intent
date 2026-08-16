import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  BatchNotFoundError,
  BatchStateConflictError,
  RepositoryMismatchError,
  SessionNotConfiguredError,
  TaskStateConflictError,
  TaskNotFoundError,
  createTask,
  updateTask,
  type ListTasksFilter,
  type TaskStore,
} from "@visual-intent/core";
import {
  ApplyBatchSchema,
  ProjectSessionSchema,
  PROTOCOL_VERSION,
  TaskSchema,
  type ApplyBatch,
  type AttachExecutor,
  type BatchResult,
  type BatchStatus,
  type ConfigureProjectSession,
  type CreateTask,
  type ProjectSession,
  type Repository,
  type Task,
  type UpdateTask,
} from "@visual-intent/protocol";

interface StoreDocument {
  protocolVersion: typeof PROTOCOL_VERSION;
  tasks: Task[];
  session?: ProjectSession;
  batches: ApplyBatch[];
}

const EMPTY_STORE: StoreDocument = {
  protocolVersion: PROTOCOL_VERSION,
  tasks: [],
  batches: [],
};
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FileTaskStore implements TaskStore {
  private readonly lockPath: string;

  constructor(
    readonly filePath: string,
    private readonly repository?: Repository,
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
      document.session = ProjectSessionSchema.parse({
        ...session,
        executor: {
          kind: "codex",
          status: "connected",
          threadId: input.threadId,
          source: input.source,
          attachedAt: now,
        },
        updatedAt: now,
      });
      document.batches = document.batches.map((batch) =>
        batch.status === "waiting_for_executor"
          ? ApplyBatchSchema.parse({
              ...batch,
              status: "queued",
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
      const connected =
        session.executor.kind === "codex" &&
        session.executor.status !== "disconnected";
      const batch = ApplyBatchSchema.parse({
        id: batchId,
        sessionId: session.id,
        taskIds: readyTasks.map((task) => task.id),
        status: connected ? "queued" : "waiting_for_executor",
        ...(session.executor.threadId
          ? { executorThreadId: session.executor.threadId }
          : {}),
        createdAt: now,
        updatedAt: now,
      });

      document.tasks = document.tasks.map((task) =>
        task.status === "ready"
          ? this.transitionTask(task, "queued", now, batchId)
          : task,
      );
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

      const now = new Date().toISOString();
      const connected = session.executor.kind === "codex";
      const batchBase: ApplyBatch = { ...existing };
      delete batchBase.completedAt;
      delete batchBase.executorThreadId;
      delete batchBase.result;
      delete batchBase.startedAt;
      const batch = ApplyBatchSchema.parse({
        ...batchBase,
        status: connected ? "queued" : "waiting_for_executor",
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
          status: connected ? "connected" : "disconnected",
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
        throw new Error(
          `Batch ${id} cannot be claimed from ${existing.status}`,
        );
      }

      const now = new Date().toISOString();
      const batch = ApplyBatchSchema.parse({
        ...existing,
        status: "in_progress",
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

      const now = new Date().toISOString();
      const batch = ApplyBatchSchema.parse({
        ...existing,
        status,
        result,
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
                summary: result.summary,
                changedFiles: result.changedFiles,
                notes: result.notes,
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
    const connected =
      session.executor.kind === "codex" &&
      session.executor.status !== "disconnected";
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
        status: connected ? "queued" : "waiting_for_executor",
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
        session:
          "session" in value && value.session !== undefined
            ? ProjectSessionSchema.parse(value.session)
            : undefined,
        batches:
          "batches" in value && Array.isArray(value.batches)
            ? value.batches.map((batch) => ApplyBatchSchema.parse(batch))
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
