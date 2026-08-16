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
  TaskNotFoundError,
  createTask,
  updateTask,
  type ListTasksFilter,
  type TaskStore,
} from "@visual-intent/core";
import {
  PROTOCOL_VERSION,
  TaskSchema,
  type CreateTask,
  type Task,
  type UpdateTask,
} from "@visual-intent/protocol";

interface StoreDocument {
  protocolVersion: typeof PROTOCOL_VERSION;
  tasks: Task[];
}

const EMPTY_STORE: StoreDocument = {
  protocolVersion: PROTOCOL_VERSION,
  tasks: [],
};
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FileTaskStore implements TaskStore {
  private readonly lockPath: string;

  constructor(readonly filePath: string) {
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
      const task = createTask(input);
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
