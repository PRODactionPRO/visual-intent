import {
  CreateTaskSchema,
  TaskSchema,
  UpdateTaskSchema,
  type CreateTask,
  type Task,
  type TaskStatus,
  type UpdateTask,
} from "@visual-intent/protocol";

export interface VisualIntentClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class VisualIntentClient {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: VisualIntentClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:7310").replace(
      /\/$/,
      "",
    );
    this.request = options.fetch ?? globalThis.fetch;
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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify(UpdateTaskSchema.parse(patch)),
      },
    );
    return TaskSchema.parse(await this.parse(response));
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
