import type { IncomingMessage, ServerResponse } from "node:http";

import {
  RevisionConflictError,
  TaskNotFoundError,
  type TaskStore,
} from "@visual-intent/core";
import {
  CreateTaskSchema,
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
): Promise<boolean> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );
  if (!url.pathname.startsWith("/_visual-intent/api/")) return false;

  try {
    if (
      request.method === "GET" &&
      url.pathname === "/_visual-intent/api/health"
    ) {
      json(response, 200, {
        ok: true,
        service: "visual-intent",
        mode: "local",
      });
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
      url.pathname === "/_visual-intent/api/tasks"
    ) {
      const task = await store.create(
        CreateTaskSchema.parse(await readJson(request)),
      );
      onTaskChanged(task);
      json(response, 201, task);
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

    json(response, 404, { error: "Visual Intent API route not found" });
    return true;
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      json(response, 404, { error: error.message });
    } else if (error instanceof RevisionConflictError) {
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
