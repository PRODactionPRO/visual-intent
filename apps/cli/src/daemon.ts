import { readFile } from "node:fs/promises";
import { ServerResponse, createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";

import httpProxy from "http-proxy";
import { WebSocket, WebSocketServer } from "ws";

import type { TaskStore } from "@visual-intent/core";
import type { ApplyBatch } from "@visual-intent/protocol";
import { createOverlayScript } from "@visual-intent/web-overlay";

import { handleApiRequest } from "./api.js";
import type { ProjectAttachmentStore } from "./attachment-store.js";

export interface DaemonOptions {
  host: string;
  port: number;
  target: string;
  store: TaskStore;
  apiToken?: string;
  attachmentStore?: ProjectAttachmentStore;
  createDispatcher?: (onChanged: (event: unknown) => void) => {
    enqueue(batch: ApplyBatch): void;
    idle?(): Promise<void>;
  };
}

export interface RunningDaemon {
  host: string;
  port: number;
  target: string;
  idle(): Promise<void>;
  close(): Promise<void>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const require = createRequire(import.meta.url);

export function validateTarget(rawTarget: string): URL {
  const target = new URL(rawTarget);
  if (!new Set(["http:", "https:"]).has(target.protocol)) {
    throw new Error("Target must use http:// or https://");
  }
  if (!LOCAL_HOSTS.has(target.hostname)) {
    throw new Error("MVP only proxies localhost targets");
  }
  return target;
}

export function injectOverlayTag(html: string): string {
  const tag =
    '<script src="/_visual-intent/vendor/html2canvas.js" data-visual-intent-vendor></script><script src="/_visual-intent/overlay.js" data-visual-intent></script>';
  return /<\/body\s*>/i.test(html)
    ? html.replace(/<\/body\s*>/i, `${tag}</body>`)
    : `${html}${tag}`;
}

function copyHeaders(
  proxyResponse: IncomingMessage,
  response: ServerResponse,
  omitted: Set<string>,
): void {
  for (const [name, value] of Object.entries(proxyResponse.headers)) {
    if (value !== undefined && !omitted.has(name.toLowerCase()))
      response.setHeader(name, value);
  }
}

export async function startDaemon(
  options: DaemonOptions,
): Promise<RunningDaemon> {
  const target = validateTarget(options.target);
  const overlayScript = createOverlayScript({ apiToken: options.apiToken });
  const html2canvasScript = await readFile(
    require.resolve("html2canvas/dist/html2canvas.min.js"),
    "utf8",
  );
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    target: target.href,
    ws: true,
  });
  const proxiedSockets = new Set<Socket>();
  proxy.on("open", (socket) => {
    proxiedSockets.add(socket);
    socket.once("close", () => proxiedSockets.delete(socket));
  });
  const sockets = new WebSocketServer({ noServer: true });

  const broadcast = (task: unknown): void => {
    const message = JSON.stringify({ type: "tasks.changed", task });
    sockets.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  };
  const dispatcher = options.createDispatcher?.(broadcast);
  const enqueueBatch = (batchId: string): void => {
    void options.store.getBatch(batchId).then((batch) => {
      if (batch) dispatcher?.enqueue(batch);
    });
  };

  proxy.on("proxyReq", (proxyRequest) => {
    proxyRequest.setHeader("accept-encoding", "identity");
  });

  proxy.on("proxyRes", (proxyResponse, _request, response) => {
    if (!(response instanceof ServerResponse)) return;
    const contentType = String(proxyResponse.headers["content-type"] ?? "");
    const isHtml = contentType.includes("text/html");
    const isEncoded = Boolean(proxyResponse.headers["content-encoding"]);
    response.statusCode = proxyResponse.statusCode ?? 502;

    if (!isHtml || isEncoded) {
      copyHeaders(proxyResponse, response, new Set());
      proxyResponse.pipe(response);
      return;
    }

    copyHeaders(
      proxyResponse,
      response,
      new Set([
        "content-length",
        "content-security-policy",
        "content-security-policy-report-only",
        "transfer-encoding",
      ]),
    );
    const chunks: Buffer[] = [];
    proxyResponse.on("data", (chunk: Buffer | Uint8Array) =>
      chunks.push(Buffer.from(chunk)),
    );
    proxyResponse.on("end", () => {
      const html = injectOverlayTag(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-length", Buffer.byteLength(html));
      response.end(html);
    });
  });

  proxy.on("error", (error, _request, response) => {
    if (response instanceof ServerResponse && !response.headersSent) {
      response.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          error: `Local target is unavailable: ${error.message}`,
        }),
      );
    }
  });

  const server = createServer((request, response) => {
    void (async () => {
      if (
        await handleApiRequest(request, response, options.store, broadcast, {
          apiToken: options.apiToken,
          attachmentStore: options.attachmentStore,
          onBatchReady: enqueueBatch,
        })
      )
        return;

      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? options.host}`,
      );
      if (
        request.method === "GET" &&
        url.pathname === "/_visual-intent/vendor/html2canvas.js"
      ) {
        response.writeHead(200, {
          "cache-control": "public, max-age=31536000, immutable",
          "content-type": "text/javascript; charset=utf-8",
          "content-length": Buffer.byteLength(html2canvasScript),
        });
        response.end(html2canvasScript);
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/_visual-intent/overlay.js"
      ) {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
          "content-length": Buffer.byteLength(overlayScript),
        });
        response.end(overlayScript);
        return;
      }

      proxy.web(request, response, { selfHandleResponse: true });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
  });
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? options.host}`,
    );
    if (
      url.pathname === "/_visual-intent/ws" &&
      (!options.apiToken || url.searchParams.get("token") === options.apiToken)
    ) {
      sockets.handleUpgrade(request, socket, head, (client) =>
        sockets.emit("connection", client, request),
      );
      return;
    }
    if (url.pathname === "/_visual-intent/ws") {
      socket.destroy();
      return;
    }
    proxy.ws(request, socket, head);
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
    target: target.href,
    async idle() {
      await dispatcher?.idle?.();
    },
    async close() {
      await dispatcher?.idle?.();
      sockets.clients.forEach((client) => client.terminate());
      connections.forEach((socket) => socket.destroy());
      proxiedSockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        sockets.close(() => {
          proxy.close();
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      });
    },
  };
}
