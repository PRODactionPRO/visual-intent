import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const payload = await readStdin();
const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
const repositoryRoot = await resolveRepositoryRoot(cwd);
const connection = await readConnection(repositoryRoot);

if (!connection || connection.repositoryRoot !== repositoryRoot)
  process.exit(0);

const threadId =
  process.env.CODEX_THREAD_ID ||
  (typeof payload.session_id === "string" ? payload.session_id : "");
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
        source: "plugin",
      }),
      signal: AbortSignal.timeout(3500),
    },
  );
  if (!response.ok) process.exit(0);

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
} catch {
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

async function readConnection(repositoryRoot) {
  try {
    return JSON.parse(
      await readFile(
        join(repositoryRoot, ".visual-intent", "connection.json"),
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }
}
