import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";

import { resolveCodexThreadId } from "./session-context.mjs";
import { loadAndPreflightConnection } from "./connection-preflight.mjs";

const payload = await readStdin();
const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
const repositoryRoot = await resolveRepositoryRoot(cwd);
let connection;
try {
  connection = await loadAndPreflightConnection(repositoryRoot, {
    timeoutMs: 2000,
    allowMissing: true,
  });
  if (!connection) process.exit(0);
} catch (error) {
  await writeHookContext(
    error instanceof Error
      ? error.message
      : `stale_connection: ${String(error)}`,
  );
  process.exit(0);
}

const threadId = resolveCodexThreadId({
  explicit: process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID,
  requestMeta: payload,
});
if (!threadId) process.exit(0);

try {
  const response = await fetch(
    `${connection.daemonUrl.replace(/\/$/, "")}/_visual-intent/api/session/attach`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visual-intent-token": connection.apiToken,
      },
      body: JSON.stringify({
        repositoryRoot,
        threadId,
        ownership: "host-attached",
        source: "plugin",
      }),
      signal: AbortSignal.timeout(3500),
    },
  );
  if (!response.ok) {
    await writeHookContext(
      `stale_connection: daemon rejected the SessionStart attachment with HTTP ${response.status}`,
    );
    process.exit(0);
  }

  const body = await response.json();
  const project = body?.session?.displayName ?? connection.projectKey;
  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Visual Intent is connected to this Codex thread for project ${project}. Only handle batches whose repository root is ${repositoryRoot}.`,
      },
    }),
  );
} catch (error) {
  await writeHookContext(
    `stale_connection: SessionStart could not attach to the validated daemon (${error instanceof Error ? error.message : String(error)})`,
  );
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function resolveRepositoryRoot(cwd) {
  try {
    return await realpath(
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    return realpath(cwd);
  }
}

async function writeHookContext(message) {
  await new Promise((resolve, reject) =>
    process.stdout.write(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `Visual Intent is not connected. ${message}`,
        },
      }),
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
