import type { ProjectSession } from "@visual-intent/protocol";

export const RUNTIME_DIAGNOSTICS_LIMIT = 50;
export const RUNTIME_PROTOCOL_VERSION = "0.1";

export type RuntimeDiagnosticEventKind =
  | "proxy_response"
  | "proxy_error"
  | "proxy_upgrade_error";

export interface RuntimeDiagnosticEvent {
  at: string;
  kind: RuntimeDiagnosticEventKind;
  pathname: string;
  status?: number;
  errorCode?: string;
}

export interface RuntimeTargetProbe {
  origin: string;
  reachable: boolean;
  checkedAt: string;
  latencyMs: number;
  status?: number;
  errorCode?: string;
}

export interface RuntimeDiagnosticsSnapshot {
  version: 1;
  generatedAt: string;
  daemon: {
    instanceId: string;
    startedAt: string;
    protocolVersion: string;
  };
  proxy: {
    origin: string;
    reachable: true;
  };
  target: RuntimeTargetProbe;
  session:
    | {
        id: string;
        projectKey: string;
        repositoryRoot: string;
        executor: ProjectSession["executor"];
      }
    | undefined;
  recentEvents: RuntimeDiagnosticEvent[];
}

export interface RuntimeDiagnosticsOptions {
  instanceId: string;
  startedAt: string;
  target: URL;
  now?: () => Date;
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
}

export class RuntimeDiagnostics {
  readonly #events: RuntimeDiagnosticEvent[] = [];
  readonly #instanceId: string;
  readonly #startedAt: string;
  readonly #target: URL;
  readonly #now: () => Date;
  readonly #fetch: typeof fetch;
  readonly #probeTimeoutMs: number;

  constructor(options: RuntimeDiagnosticsOptions) {
    this.#instanceId = options.instanceId;
    this.#startedAt = options.startedAt;
    this.#target = options.target;
    this.#now = options.now ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
  }

  record(input: {
    kind: RuntimeDiagnosticEventKind;
    requestUrl?: string;
    status?: number;
    error?: unknown;
  }): void {
    const event: RuntimeDiagnosticEvent = {
      at: this.#now().toISOString(),
      kind: input.kind,
      pathname: safePathname(input.requestUrl),
      ...(isHttpStatus(input.status) ? { status: input.status } : {}),
      ...(input.error ? { errorCode: safeErrorCode(input.error) } : {}),
    };
    this.#events.push(event);
    if (this.#events.length > RUNTIME_DIAGNOSTICS_LIMIT) {
      this.#events.splice(0, this.#events.length - RUNTIME_DIAGNOSTICS_LIMIT);
    }
  }

  async snapshot(input: {
    proxyOrigin: string;
    session: ProjectSession | undefined;
  }): Promise<RuntimeDiagnosticsSnapshot> {
    return {
      version: 1,
      generatedAt: this.#now().toISOString(),
      daemon: {
        instanceId: this.#instanceId,
        startedAt: this.#startedAt,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
      },
      proxy: {
        origin: new URL(input.proxyOrigin).origin,
        reachable: true,
      },
      target: await probeRuntimeTarget(this.#target, {
        fetch: this.#fetch,
        now: this.#now,
        timeoutMs: this.#probeTimeoutMs,
      }),
      session: input.session
        ? {
            id: input.session.id,
            projectKey: input.session.projectKey,
            repositoryRoot: input.session.repository.root,
            executor: input.session.executor,
          }
        : undefined,
      recentEvents: this.#events.map((event) => ({ ...event })),
    };
  }
}

export async function probeRuntimeTarget(
  target: URL,
  options: {
    fetch?: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
  } = {},
): Promise<RuntimeTargetProbe> {
  const fetchTarget = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 1_500,
  );
  timeout.unref?.();

  try {
    const response = await fetchTarget(target.origin, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      origin: target.origin,
      reachable: true,
      checkedAt: now().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      status: response.status,
    };
  } catch (error) {
    return {
      origin: target.origin,
      reachable: false,
      checkedAt: now().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      errorCode: safeErrorCode(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function safePathname(rawUrl: string | undefined): string {
  if (!rawUrl) return "/";
  try {
    const pathname = new URL(rawUrl, "http://127.0.0.1").pathname || "/";
    const technicalSegments = new Set([
      "_next",
      "webpack-hmr",
      "@vite",
      "client",
      "assets",
      "favicon.ico",
    ]);
    const segments = pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 12)
      .map((segment) => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          return ":segment";
        }
        if (technicalSegments.has(decoded)) return decoded;
        if (/^(?:[^/]+\.)?(?:js|mjs|css|map|woff2?)$/iu.test(decoded)) {
          return `:asset.${decoded.split(".").at(-1)?.toLowerCase()}`;
        }
        return ":segment";
      });
    return segments.length > 0 ? `/${segments.join("/")}` : "/";
  } catch {
    return "/";
  }
}

export function safeErrorCode(error: unknown): string {
  const candidates = [
    error,
    typeof error === "object" && error !== null && "cause" in error
      ? error.cause
      : undefined,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "code" in candidate &&
      typeof candidate.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate.code)
    ) {
      return candidate.code;
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "TIMEOUT";
  }
  return "RUNTIME_ERROR";
}

function isHttpStatus(value: number | undefined): value is number {
  return (
    Number.isInteger(value) &&
    value !== undefined &&
    value >= 100 &&
    value <= 599
  );
}
