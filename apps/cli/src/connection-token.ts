import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

type StoredConnection = {
  apiToken?: unknown;
  projectKey?: unknown;
  repositoryRoot?: unknown;
};

const LOCAL_TOKEN_PATTERN = /^[a-f0-9]{48}$/u;

export async function loadOrCreateApiToken(
  connectionPath: string,
  expected: { projectKey: string; repositoryRoot: string },
): Promise<string> {
  try {
    const stored = JSON.parse(
      await readFile(connectionPath, "utf8"),
    ) as StoredConnection;
    if (
      typeof stored.apiToken === "string" &&
      LOCAL_TOKEN_PATTERN.test(stored.apiToken) &&
      stored.projectKey === expected.projectKey &&
      stored.repositoryRoot === expected.repositoryRoot
    )
      return stored.apiToken;
  } catch {
    // A missing, stale, or malformed local connection is replaced below.
  }

  return randomBytes(24).toString("hex");
}
