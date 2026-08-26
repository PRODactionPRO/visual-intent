import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { CreateTaskSchema, type ProjectSession } from "@visual-intent/protocol";

import {
  assertLoopbackUrl,
  loadOrCreateBridgeConfig,
  readBridgeRegistrations,
  type BridgeConfig,
  type BridgeSessionRegistration,
} from "./bridge-registry.js";

const JSON_LIMIT_BYTES = 1024 * 1024;
const ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

export interface BridgeOptions {
  host: string;
  port: number;
  dataDirectory?: string;
}

export interface RunningBridge {
  host: string;
  port: number;
  pairingCode: string;
  close(): Promise<void>;
}

interface ActiveBridgeSession {
  registration: BridgeSessionRegistration;
  session: ProjectSession;
  readyTaskCount: number;
}

export async function startBridge(
  options: BridgeOptions,
): Promise<RunningBridge> {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(options.host)) {
    throw new Error("Visual Intent Bridge only binds to a loopback host");
  }
  const config = await loadOrCreateBridgeConfig(options.dataDirectory);
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void handleBridgeRequest(request, response, config, options.dataDirectory);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    host: options.host,
    port: address.port,
    pairingCode: config.pairingCode,
    async close() {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function handleBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: BridgeConfig,
  dataDirectory?: string,
): Promise<void> {
  const origin = request.headers.origin;
  applyCors(response, origin);
  if (request.method === "OPTIONS") {
    response.writeHead(isAllowedOrigin(origin) ? 204 : 403);
    response.end();
    return;
  }
  if (!isAllowedOrigin(origin)) {
    json(response, 403, { error: "Origin is not allowed" });
    return;
  }

  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, {
        ok: true,
        service: "visual-intent-bridge",
        mode: "local",
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/pair") {
      const body = (await readJson(request, 4096)) as { code?: unknown };
      if (
        typeof body.code !== "string" ||
        !equalSecret(body.code, config.pairingCode)
      ) {
        json(response, 403, { error: "Неверный код подключения" });
        return;
      }
      json(response, 200, { apiToken: config.apiToken });
      return;
    }
    if (!isAuthorized(request, config.apiToken)) {
      json(response, 401, { error: "Visual Intent Bridge is not paired" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = await activeSessions(dataDirectory);
      json(
        response,
        200,
        sessions.map(({ session, readyTaskCount }) => ({
          id: session.id,
          projectKey: session.projectKey,
          displayName: session.displayName,
          targetUrl: session.targetUrl,
          proxyUrl: session.proxyUrl,
          executor: session.executor,
          readyTaskCount,
        })),
      );
      return;
    }

    const route = url.pathname.match(
      /^\/api\/sessions\/([^/]+)\/(tasks|attachments|apply)$/u,
    );
    if (!route?.[1] || !route[2]) {
      json(response, 404, { error: "Visual Intent Bridge route not found" });
      return;
    }
    const registration = await requireActiveRegistration(
      decodeURIComponent(route[1]),
      dataDirectory,
    );
    if (route[2] === "tasks" && request.method === "GET") {
      await forward(
        response,
        registration,
        `/_visual-intent/api/tasks${url.search}`,
        { method: "GET" },
      );
      return;
    }
    if (route[2] === "tasks" && request.method === "POST") {
      const input = CreateTaskSchema.parse(
        await readJson(request, JSON_LIMIT_BYTES),
      );
      await forward(response, registration, "/_visual-intent/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return;
    }
    if (route[2] === "attachments" && request.method === "POST") {
      const mimeType = String(request.headers["content-type"] ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (!mimeType || !IMAGE_TYPES.has(mimeType)) {
        json(response, 400, {
          error: "MVP accepts PNG, JPEG, WebP, GIF, HEIC, or HEIF images",
        });
        return;
      }
      const body = await readBody(request, ATTACHMENT_LIMIT_BYTES);
      if (!matchesImageSignature(body, mimeType)) {
        json(response, 400, { error: "Image content does not match its type" });
        return;
      }
      const forwardedSearch = new URLSearchParams({
        kind: "screenshot",
        fileName: url.searchParams.get("fileName") ?? "reference-image",
      });
      await forward(
        response,
        registration,
        `/_visual-intent/api/attachments?${forwardedSearch.toString()}`,
        {
          method: "POST",
          headers: { "content-type": mimeType },
          body: new Uint8Array(body),
        },
      );
      return;
    }
    if (route[2] === "apply" && request.method === "POST") {
      await forward(response, registration, "/_visual-intent/api/tasks/apply", {
        method: "POST",
      });
      return;
    }
    json(response, 405, { error: "Method is not allowed" });
  } catch (error) {
    json(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function activeSessions(
  dataDirectory?: string,
): Promise<ActiveBridgeSession[]> {
  const registrations = await readBridgeRegistrations(dataDirectory);
  const sessions = await Promise.all(
    registrations.map(async (registration) => {
      try {
        const healthResponse = await fetch(
          `${registration.daemonUrl}/_visual-intent/api/health`,
          { signal: AbortSignal.timeout(1200) },
        );
        if (!healthResponse.ok) return undefined;
        const health = (await healthResponse.json()) as {
          daemonInstanceId?: string;
          session?: ProjectSession;
        };
        if (
          health.daemonInstanceId !== registration.daemonInstanceId ||
          !health.session ||
          health.session.id !== registration.sessionId ||
          health.session.repository.root !== registration.repositoryRoot ||
          health.session.projectKey !== registration.projectKey
        ) {
          return undefined;
        }
        const tasksResponse = await fetch(
          `${registration.daemonUrl}/_visual-intent/api/tasks?status=ready`,
          { signal: AbortSignal.timeout(1200) },
        );
        const tasks = tasksResponse.ok
          ? ((await tasksResponse.json()) as unknown[])
          : [];
        return {
          registration,
          session: health.session,
          readyTaskCount: tasks.length,
        };
      } catch {
        return undefined;
      }
    }),
  );
  return sessions
    .filter((session): session is ActiveBridgeSession => session !== undefined)
    .sort((left, right) =>
      left.session.displayName.localeCompare(right.session.displayName, "ru"),
    );
}

async function requireActiveRegistration(
  sessionId: string,
  dataDirectory?: string,
): Promise<BridgeSessionRegistration> {
  const session = (await activeSessions(dataDirectory)).find(
    (candidate) => candidate.session.id === sessionId,
  );
  if (!session) throw new Error("Выбранный проект сейчас не запущен");
  return session.registration;
}

async function forward(
  response: ServerResponse,
  registration: BridgeSessionRegistration,
  path: string,
  init: RequestInit,
): Promise<void> {
  assertLoopbackUrl(registration.daemonUrl);
  const headers = new Headers(init.headers);
  headers.set("x-visual-intent-token", registration.apiToken);
  const upstream = await fetch(`${registration.daemonUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "cache-control": "no-store",
    "content-length": body.byteLength,
    "content-type":
      upstream.headers.get("content-type") ?? "application/octet-stream",
  });
  response.end(body);
}

function applyCors(response: ServerResponse, origin?: string): void {
  if (isAllowedOrigin(origin) && origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type",
  );
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-max-age", "600");
}

function isAllowedOrigin(origin?: string): boolean {
  return origin === undefined || origin.startsWith("chrome-extension://");
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  return (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ") &&
    equalSecret(authorization.slice("Bearer ".length), token)
  );
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function readJson(
  request: IncomingMessage,
  limitBytes: number,
): Promise<unknown> {
  return JSON.parse(
    (await readBody(request, limitBytes)).toString("utf8") || "{}",
  );
}

async function readBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limitBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function matchesImageSignature(body: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png")
    return body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg")
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8;
  if (mimeType === "image/gif") {
    const signature = body.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp")
    return (
      body.subarray(0, 4).toString("ascii") === "RIFF" &&
      body.subarray(8, 12).toString("ascii") === "WEBP"
    );
  if (mimeType === "image/heic" || mimeType === "image/heif") {
    const brand = body.subarray(8, 12).toString("ascii");
    return (
      body.subarray(4, 8).toString("ascii") === "ftyp" &&
      new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]).has(brand)
    );
  }
  return false;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(serialized),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(serialized);
}
