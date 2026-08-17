import type { IncomingMessage, ServerResponse } from "node:http";

import {
  BatchNotFoundError,
  BatchStateConflictError,
  RepositoryMismatchError,
  RevisionConflictError,
  SessionNotConfiguredError,
  TaskNotFoundError,
  TaskStateConflictError,
  type TaskStore,
} from "@visual-intent/core";
import {
  AttachExecutorSchema,
  CreateTaskSchema,
  FinishBatchSchema,
  TaskStatusSchema,
  UpdateTaskSchema,
} from "@visual-intent/protocol";
import { ZodError } from "zod";

const BODY_LIMIT_BYTES = 1024 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(serialized),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(serialized);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

export async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: TaskStore,
  onTaskChanged: (task: unknown) => void,
  options: {
    apiToken?: string;
    onBatchReady?: (batchId: string) => void;
  } = {},
): Promise<boolean> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );
  if (!url.pathname.startsWith("/_visual-intent/api/")) return false;

  if (
    request.method !== "GET" &&
    options.apiToken &&
    request.headers["x-visual-intent-token"] !== options.apiToken
  ) {
    json(response, 403, { error: "Invalid Visual Intent session token" });
    return true;
  }

  try {
    if (
      request.method === "GET" &&
      url.pathname === "/_visual-intent/api/health"
    ) {
      json(response, 200, {
        ok: true,
        service: "visual-intent",
        mode: "local",
        session: await store.getSession(),
      });
      return true;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/_visual-intent/api/session"
    ) {
      const session = await store.getSession();
      if (!session) throw new SessionNotConfiguredError();
      json(response, 200, session);
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/_visual-intent/api/session/attach"
    ) {
      const session = await store.attachExecutor(
        AttachExecutorSchema.parse(await readJson(request)),
      );
      const batches = (await store.listBatches()).filter(
        (batch) =>
          batch.status === "queued" || batch.status === "waiting_for_executor",
      );
      onTaskChanged({ type: "session.attached", session, batches });
      batches.forEach((batch) => options.onBatchReady?.(batch.id));
      json(response, 200, { session, queuedBatches: batches.length });
      return true;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/_visual-intent/api/batches"
    ) {
      json(response, 200, await store.listBatches());
      return true;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/_visual-intent/api/tasks"
    ) {
      const rawStatus = url.searchParams.get("status");
      const status =
        rawStatus === null ? undefined : TaskStatusSchema.parse(rawStatus);
      json(response, 200, await store.list(status ? { status } : undefined));
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/_visual-intent/api/tasks/apply"
    ) {
      const batch = await store.dispatchReady();
      const session = await store.getSession();
      if (batch) {
        onTaskChanged({ type: `batch.${batch.status}`, batch, session });
        options.onBatchReady?.(batch.id);
      }
      json(response, 202, {
        accepted: batch?.taskIds.length ?? 0,
        batch,
        session,
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/_visual-intent/api/tasks"
    ) {
      const task = await store.create(
        CreateTaskSchema.parse(await readJson(request)),
      );
      onTaskChanged(task);
      json(response, 201, task);
      return true;
    }

    const batchActionMatch = url.pathname.match(
      /^\/_visual-intent\/api\/batches\/([^/]+)\/(claim|finish|retry)$/,
    );
    if (
      batchActionMatch?.[1] &&
      batchActionMatch[2] === "retry" &&
      request.method === "POST"
    ) {
      const retried = await store.retryBatch(
        decodeURIComponent(batchActionMatch[1]),
      );
      onTaskChanged({ type: "batch.retried", ...retried });
      options.onBatchReady?.(retried.batch.id);
      json(response, 200, retried);
      return true;
    }
    if (
      batchActionMatch?.[1] &&
      batchActionMatch[2] === "claim" &&
      request.method === "POST"
    ) {
      const claimed = await store.claimBatch(
        decodeURIComponent(batchActionMatch[1]),
      );
      onTaskChanged({ type: "batch.in_progress", ...claimed });
      json(response, 200, claimed);
      return true;
    }

    if (
      batchActionMatch?.[1] &&
      batchActionMatch[2] === "finish" &&
      request.method === "POST"
    ) {
      const input = FinishBatchSchema.parse(await readJson(request));
      const finished = await store.finishBatch(
        decodeURIComponent(batchActionMatch[1]),
        input.status,
        input.result,
      );
      onTaskChanged({ type: `batch.${input.status}`, ...finished });
      json(response, 200, finished);
      return true;
    }

    const batchMatch = url.pathname.match(
      /^\/_visual-intent\/api\/batches\/([^/]+)$/,
    );
    if (batchMatch?.[1] && request.method === "GET") {
      const batch = await store.getBatch(decodeURIComponent(batchMatch[1]));
      if (!batch) throw new BatchNotFoundError(batchMatch[1]);
      json(response, 200, batch);
      return true;
    }

    const match = url.pathname.match(/^\/_visual-intent\/api\/tasks\/([^/]+)$/);
    if (match?.[1] && request.method === "GET") {
      const task = await store.get(decodeURIComponent(match[1]));
      if (!task) throw new TaskNotFoundError(match[1]);
      json(response, 200, task);
      return true;
    }

    if (match?.[1] && request.method === "PATCH") {
      const task = await store.update(
        decodeURIComponent(match[1]),
        UpdateTaskSchema.parse(await readJson(request)),
      );
      onTaskChanged(task);
      json(response, 200, task);
      return true;
    }

    if (match?.[1] && request.method === "DELETE") {
      const id = decodeURIComponent(match[1]);
      await store.delete(id);
      onTaskChanged({ type: "task.deleted", id });
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return true;
    }

    json(response, 404, { error: "Visual Intent API route not found" });
    return true;
  } catch (error) {
    if (
      error instanceof TaskNotFoundError ||
      error instanceof BatchNotFoundError
    ) {
      json(response, 404, { error: error.message });
    } else if (
      error instanceof SessionNotConfiguredError ||
      error instanceof RepositoryMismatchError
    ) {
      json(response, 409, { error: error.message });
    } else if (
      error instanceof BatchStateConflictError ||
      error instanceof RevisionConflictError ||
      error instanceof TaskStateConflictError
    ) {
      json(response, 409, { error: error.message });
    } else if (error instanceof ZodError || error instanceof SyntaxError) {
      json(response, 400, { error: error.message });
    } else if (
      error instanceof Error &&
      error.message === "Request body exceeds 1 MB"
    ) {
      json(response, 413, { error: error.message });
    } else {
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
}
