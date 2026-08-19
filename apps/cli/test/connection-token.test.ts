import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreateApiToken } from "../src/connection-token.js";

const temporaryDirectories: string[] = [];

async function temporaryConnectionPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-token-"));
  temporaryDirectories.push(directory);
  return join(directory, "connection.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Visual Intent local connection token", () => {
  const expected = { projectKey: "demo", repositoryRoot: "/repo/demo" };

  it("reuses a valid token for the same repository and project", async () => {
    const connectionPath = await temporaryConnectionPath();
    const token = "a".repeat(48);
    await writeFile(
      connectionPath,
      JSON.stringify({ ...expected, apiToken: token }),
    );

    await expect(loadOrCreateApiToken(connectionPath, expected)).resolves.toBe(
      token,
    );
  });

  it("rotates a token copied from a different repository", async () => {
    const connectionPath = await temporaryConnectionPath();
    const copiedToken = "b".repeat(48);
    await writeFile(
      connectionPath,
      JSON.stringify({
        projectKey: "demo",
        repositoryRoot: "/repo/another",
        apiToken: copiedToken,
      }),
    );

    const token = await loadOrCreateApiToken(connectionPath, expected);
    expect(token).toMatch(/^[a-f0-9]{48}$/u);
    expect(token).not.toBe(copiedToken);
  });

  it("creates a valid token when no connection exists", async () => {
    const connectionPath = await temporaryConnectionPath();

    await expect(
      loadOrCreateApiToken(connectionPath, expected),
    ).resolves.toMatch(/^[a-f0-9]{48}$/u);
  });
});
