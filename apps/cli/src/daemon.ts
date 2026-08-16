import { ServerResponse, createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import httpProxy from "http-proxy";
import { WebSocket, WebSocketServer } from "ws";

import type { TaskStore } from "@visual-intent/core";
import { createOverlayScript } from "@visual-intent/web-overlay";

import { handleApiRequest } from "./api.js";

export interface DaemonOptions {
  host: string;
  port: number;
  target: string;
  store: TaskStore;
}

export interface RunningDaemon {
  host: string;
  port: number;
  target: string;
  close(): Promise<void>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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
    '<script src="/_visual-intent/overlay.js" data-visual-intent></script>';
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
  const overlayScript = createOverlayScript();
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    target: target.href,
    ws: true,
  });
  const sockets = new WebSocketServer({ noServer: true });

  const broadcast = (task: unknown): void => {
    const message = JSON.stringify({ type: "tasks.changed", task });
    sockets.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
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
      if (await handleApiRequest(request, response, options.store, broadcast))
        return;

      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? options.host}`,
      );
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

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? options.host}`,
    );
    if (url.pathname === "/_visual-intent/ws") {
      sockets.handleUpgrade(request, socket, head, (client) =>
        sockets.emit("connection", client, request),
      );
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
    async close() {
      sockets.clients.forEach((client) => client.close());
      await new Promise<void>((resolve, reject) => {
        sockets.close(() => {
          proxy.close();
          server.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
  };
}
