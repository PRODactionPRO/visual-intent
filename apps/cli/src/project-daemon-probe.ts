import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ProjectDaemonIdentity {
  daemonUrl: string;
  daemonInstanceId: string;
  repositoryRoot: string;
  sessionId: string;
  projectKey: string;
}

export interface ProjectDaemonProbe {
  inspect(repositoryRoot: string): Promise<ProjectDaemonIdentity | undefined>;
}

export interface ConnectionProjectDaemonProbeOptions {
  fetch?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  timeoutMs?: number;
}

interface StoredConnection {
  daemonUrl?: unknown;
  apiToken?: unknown;
  daemonInstanceId?: unknown;
  repositoryRoot?: unknown;
  sessionId?: unknown;
  projectKey?: unknown;
}

const API_TOKEN_PATTERN = /^[a-f0-9]{48}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Compatibility probe for daemons started before the project daemon lease was
 * introduced. A connection file is only considered live after the daemon
 * proves its instance and repository identity over the loopback health API.
 */
export class ConnectionProjectDaemonProbe implements ProjectDaemonProbe {
  private readonly fetcher: typeof fetch;
  private readonly readText: (path: string) => Promise<string>;
  private readonly timeoutMs: number;

  constructor(options: ConnectionProjectDaemonProbeOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.readText = options.readText ?? ((path) => readFile(path, "utf8"));
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 1_200, "timeoutMs");
  }

  async inspect(
    repositoryRoot: string,
  ): Promise<ProjectDaemonIdentity | undefined> {
    const expectedRoot = resolve(repositoryRoot);
    let connection: StoredConnection;
    try {
      connection = JSON.parse(
        await this.readText(
          join(expectedRoot, ".visual-intent", "connection.json"),
        ),
      ) as StoredConnection;
    } catch {
      return undefined;
    }
    const daemonUrl = loopbackHttpOrigin(connection.daemonUrl);
    if (
      !daemonUrl ||
      typeof connection.apiToken !== "string" ||
      !API_TOKEN_PATTERN.test(connection.apiToken) ||
      typeof connection.daemonInstanceId !== "string" ||
      connection.daemonInstanceId.length === 0 ||
      typeof connection.repositoryRoot !== "string" ||
      resolve(connection.repositoryRoot) !== expectedRoot ||
      typeof connection.sessionId !== "string" ||
      connection.sessionId.length === 0 ||
      typeof connection.projectKey !== "string" ||
      connection.projectKey.length === 0
    ) {
      return undefined;
    }

    try {
      const response = await this.fetcher(
        `${daemonUrl}/_visual-intent/api/health`,
        {
          headers: {
            "x-visual-intent-token": connection.apiToken,
          },
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok) return undefined;
      const health: unknown = await response.json();
      if (!isRecord(health) || health.ok !== true) return undefined;
      if (
        health.service !== "visual-intent" ||
        health.daemonInstanceId !== connection.daemonInstanceId ||
        !isRecord(health.session) ||
        health.session.id !== connection.sessionId ||
        health.session.projectKey !== connection.projectKey ||
        !isRecord(health.session.repository) ||
        typeof health.session.repository.root !== "string" ||
        resolve(health.session.repository.root) !== expectedRoot ||
        loopbackHttpOrigin(health.session.proxyUrl) !== daemonUrl
      ) {
        return undefined;
      }
      return {
        daemonUrl,
        daemonInstanceId: connection.daemonInstanceId,
        repositoryRoot: expectedRoot,
        sessionId: connection.sessionId,
        projectKey: connection.projectKey,
      };
    } catch {
      return undefined;
    }
  }
}

function loopbackHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(url.hostname) ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
