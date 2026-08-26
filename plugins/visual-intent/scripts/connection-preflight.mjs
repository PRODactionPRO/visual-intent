import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export async function loadAndPreflightConnection(
  repositoryRoot,
  { fetchImpl = fetch, timeoutMs = 2500, allowMissing = false } = {},
) {
  let candidate;
  try {
    candidate = JSON.parse(
      await readFile(
        join(repositoryRoot, ".visual-intent", "connection.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return undefined;
    throw staleConnection(
      "connection.json is missing or invalid; restart Visual Intent for this project",
    );
  }

  validateConnection(candidate, repositoryRoot);

  let response;
  try {
    response = await fetchImpl(
      `${candidate.daemonUrl.replace(/\/$/u, "")}/_visual-intent/api/health`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch {
    throw staleConnection(
      "the recorded daemon is not reachable; restart Visual Intent for this project",
    );
  }
  if (!response.ok) {
    throw staleConnection(
      `the recorded daemon health check returned HTTP ${response.status}; restart Visual Intent for this project`,
    );
  }

  let health;
  try {
    health = await response.json();
  } catch {
    throw staleConnection("the daemon returned an invalid health response");
  }
  if (
    health?.ok !== true ||
    health?.service !== "visual-intent" ||
    health?.protocolVersion !== candidate.protocolVersion
  ) {
    throw staleConnection("the daemon protocol does not match connection.json");
  }
  if (health.daemonInstanceId !== candidate.daemonInstanceId) {
    throw staleConnection(
      "the daemon at this port is a different process than connection.json records",
    );
  }
  if (
    health?.session?.id !== candidate.sessionId ||
    health?.session?.projectKey !== candidate.projectKey
  ) {
    throw staleConnection(
      "the daemon session or project does not match connection.json",
    );
  }

  let healthRepositoryRoot;
  try {
    healthRepositoryRoot = await realpath(health.session.repository.root);
  } catch {
    throw staleConnection("the daemon repository root is unavailable");
  }
  if (healthRepositoryRoot !== repositoryRoot) {
    throw staleConnection(
      `the daemon belongs to ${healthRepositoryRoot}, not ${repositoryRoot}`,
    );
  }

  return candidate;
}

export function validateConnection(candidate, repositoryRoot) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw staleConnection("connection.json must contain an object");
  }
  if (candidate.protocolVersion !== "0.1") {
    throw staleConnection("connection.json uses an unsupported protocol");
  }
  for (const field of [
    "daemonUrl",
    "apiToken",
    "projectKey",
    "repositoryRoot",
    "sessionId",
    "daemonInstanceId",
  ]) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
      throw staleConnection(`connection.json is missing ${field}`);
    }
  }
  if (candidate.repositoryRoot !== repositoryRoot) {
    throw staleConnection(
      `connection.json belongs to ${candidate.repositoryRoot}, not ${repositoryRoot}`,
    );
  }
  if (!/^[a-f0-9]{48}$/u.test(candidate.apiToken)) {
    throw staleConnection("connection.json contains an invalid session token");
  }

  let daemonUrl;
  try {
    daemonUrl = new URL(candidate.daemonUrl);
  } catch {
    throw staleConnection("connection.json contains an invalid daemon URL");
  }
  if (
    daemonUrl.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(daemonUrl.hostname) ||
    daemonUrl.username ||
    daemonUrl.password ||
    (daemonUrl.pathname !== "" && daemonUrl.pathname !== "/") ||
    daemonUrl.search ||
    daemonUrl.hash
  ) {
    throw staleConnection(
      "the daemon URL must be a plain HTTP loopback origin without credentials, path, query, or fragment",
    );
  }
}

export function staleConnection(message) {
  const error = new Error(`stale_connection: ${message}`);
  error.code = "stale_connection";
  return error;
}
