import {
  CreateTaskSchema,
  ApplyBatchSchema,
  AttachExecutorSchema,
  FinishBatchSchema,
  ProjectSessionSchema,
  RateTaskSchema,
  ReviewTaskSchema,
  RetryBatchSchema,
  TaskSchema,
  UpdateTaskSchema,
  ExecutionRecordSchema,
  VisualIntentEventSchema,
  type CreateTask,
  type ApplyBatch,
  type AttachExecutor,
  type FinishBatch,
  type ProjectSession,
  type RateTask,
  type ReviewTask,
  type RetryBatch,
  type Task,
  type TaskStatus,
  type UpdateTask,
  type ExecutionRecord,
  type VisualIntentEvent,
} from "@visual-intent/protocol";

export interface VisualIntentClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  apiToken?: string;
  controllerThreadId?: string;
}

export class VisualIntentClient {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;
  private readonly apiToken?: string;
  private controllerThreadId?: string;

  constructor(options: VisualIntentClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:7310").replace(
      /\/$/,
      "",
    );
    this.request = options.fetch ?? globalThis.fetch;
    this.apiToken = options.apiToken;
    this.controllerThreadId = options.controllerThreadId;
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

  async reviewTask(
    id: string,
    input: ReviewTask,
  ): Promise<{ task: Task; revisionTask?: Task }> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks/${encodeURIComponent(id)}/review`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(ReviewTaskSchema.parse(input)),
      },
    );
    const body = await this.parse(response);
    if (typeof body !== "object" || body === null || !("task" in body)) {
      throw new Error("Visual Intent review response is incomplete");
    }
    const revisionTask =
      "revisionTask" in body && body.revisionTask !== undefined
        ? TaskSchema.parse(body.revisionTask)
        : undefined;
    return {
      task: TaskSchema.parse(body.task),
      ...(revisionTask ? { revisionTask } : {}),
    };
  }

  async listEvents(
    options: {
      since?: string;
      type?: VisualIntentEvent["type"];
    } = {},
  ): Promise<VisualIntentEvent[]> {
    const query = new URLSearchParams();
    if (options.since) query.set("since", options.since);
    if (options.type) query.set("type", options.type);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/events${suffix}`,
      { headers: this.headers() },
    );
    return VisualIntentEventSchema.array().parse(await this.parse(response));
  }

  async listExecutions(
    options: {
      since?: string;
      batchId?: string;
    } = {},
  ): Promise<ExecutionRecord[]> {
    const query = new URLSearchParams();
    if (options.since) query.set("since", options.since);
    if (options.batchId) query.set("batchId", options.batchId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/executions${suffix}`,
      { headers: this.headers() },
    );
    return ExecutionRecordSchema.array().parse(await this.parse(response));
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
    const session = ProjectSessionSchema.parse(body.session);
    this.controllerThreadId = input.threadId;
    return session;
  }

  async rateTask(id: string, input: RateTask): Promise<Task> {
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/tasks/${encodeURIComponent(id)}/rating`,
      {
        method: "PUT",
        headers: this.headers(true),
        body: JSON.stringify(RateTaskSchema.parse(input)),
      },
    );
    return TaskSchema.parse(await this.parse(response));
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

  async retryBatch(
    id: string,
    input: RetryBatch = {},
  ): Promise<{ batch: ApplyBatch; tasks: Task[] }> {
    const parsed = RetryBatchSchema.parse(input);
    const response = await this.request(
      `${this.baseUrl}/_visual-intent/api/batches/${encodeURIComponent(id)}/retry`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(parsed),
      },
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
    if (this.controllerThreadId) {
      headers.set("x-visual-intent-controller-thread", this.controllerThreadId);
    }
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
