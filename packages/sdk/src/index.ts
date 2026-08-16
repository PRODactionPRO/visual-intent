import {
  CreateTaskSchema,
  ApplyBatchSchema,
  AttachExecutorSchema,
  FinishBatchSchema,
  ProjectSessionSchema,
  TaskSchema,
  UpdateTaskSchema,
  type CreateTask,
  type ApplyBatch,
  type AttachExecutor,
  type FinishBatch,
  type ProjectSession,
  type Task,
  type TaskStatus,
  type UpdateTask,
} from "@visual-intent/protocol";

export interface VisualIntentClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  apiToken?: string;
}

export class VisualIntentClient {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;
  private readonly apiToken?: string;

  constructor(options: VisualIntentClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:7310").replace(
      /\/$/,
      "",
    );
    this.request = options.fetch ?? globalThis.fetch;
    this.apiToken = options.apiToken;
  }

  async listTasks(status?: TaskStatus): Promise<Task[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks${query}`,
    );
    const body = await this.parse(response);
    return TaskSchema.array().parse(body);
  }

  async getTask(id: string): Promise<Task> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks/${encodeURIComponent(id)}`,
    );
    return TaskSchema.parse(await this.parse(response));
  }

  async createTask(input: CreateTask): Promise<Task> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(CreateTaskSchema.parse(input)),
      },
    );
    return TaskSchema.parse(await this.parse(response));
  }

  async updateTask(id: string, patch: UpdateTask): Promise<Task> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: this.headers(true),
        body: JSON.stringify(UpdateTaskSchema.parse(patch)),
      },
    );
    return TaskSchema.parse(await this.parse(response));
  }

  async deleteTask(id: string): Promise<void> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!response.ok) await this.parse(response);
  }

  async applyTasks(): Promise<ApplyBatch[]> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks/apply`,
      { method: "POST", headers: this.headers() },
    );
    const body = await this.parse(response);
    const batch =
      typeof body === "object" && body !== null && "batch" in body
        ? body.batch
        : undefined;
    return batch ? [ApplyBatchSchema.parse(batch)] : [];
  }

  async getSession(): Promise<ProjectSession> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/session`,
      { headers: this.headers() },
    );
    return ProjectSessionSchema.parse(await this.parse(response));
  }

  async attachExecutor(input: AttachExecutor): Promise<ProjectSession> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/session/attach`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(AttachExecutorSchema.parse(input)),
      },
    );
    const body = await this.parse(response);
    if (typeof body !== "object" || body === null || !("session" in body)) {
      throw new Error("Visual Intent attach response is missing session");
    }
    return ProjectSessionSchema.parse(body.session);
  }

  async listBatches(): Promise<ApplyBatch[]> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/batches`,
      { headers: this.headers() },
    );
    return ApplyBatchSchema.array().parse(await this.parse(response));
  }

  async claimBatch(id: string): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/batches/${encodeURIComponent(id)}/claim`,
      { method: "POST", headers: this.headers() },
    );
    return this.parseBatchTasks(await this.parse(response));
  }

  async retryBatch(id: string): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/batches/${encodeURIComponent(id)}/retry`,
      { method: "POST", headers: this.headers() },
    );
    return this.parseBatchTasks(await this.parse(response));
  }

  async finishBatch(
    id: string,
    input: FinishBatch,
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/batches/${encodeURIComponent(id)}/finish`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(FinishBatchSchema.parse(input)),
      },
    );
    return this.parseBatchTasks(await this.parse(response));
  }

  private headers(json = false): Headers {
    const headers = new Headers();
    if (json) headers.set("content-type", "application/json");
    if (this.apiToken) headers.set("x-visual-intent-token", this.apiToken);
    return headers;
  }

  private parseBatchTasks(value: unknown): {
    batch: ApplyBatch;
    tasks: Task[];
  } {
    if (
      typeof value !== "object" ||
      value === null ||
      !("batch" in value) ||
      !("tasks" in value)
    ) {
      throw new Error("Visual Intent batch response is incomplete");
    }
    return {
      batch: ApplyBatchSchema.parse(value.batch),
      tasks: TaskSchema.array().parse(value.tasks),
    };
  }

  private async parse(response: Response): Promise<unknown> {
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String(body.error)
          : `Visual Intent API failed with ${response.status}`;
      throw new Error(message);
    }
    return body;
  }
}
