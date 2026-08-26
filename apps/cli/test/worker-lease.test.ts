import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireProjectWorkerLease } from "../src/worker-lease.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("project SDK worker lease", () => {
  it("allows only one live worker for a project", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const first = await acquireProjectWorkerLease(repositoryRoot);

    await expect(acquireProjectWorkerLease(repositoryRoot)).rejects.toThrow(
      `already running for this project (PID ${process.pid})`,
    );

    await first.release();
    const next = await acquireProjectWorkerLease(repositoryRoot);
    expect(next.recoveredStaleLease).toBe(false);
    await next.release();
  });

  it("recovers a lease owned by a dead process", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const path = leasePath(repositoryRoot);
    await mkdir(join(repositoryRoot, ".visual-intent"), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "stale-token",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const lease = await acquireProjectWorkerLease(repositoryRoot);

    expect(lease.recoveredStaleLease).toBe(true);
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      pid: number;
      token: string;
      createdAt: string;
    };
    expect(stored.pid).toBe(process.pid);
    expect(stored.token).not.toBe("stale-token");
    expect(Number.isFinite(Date.parse(stored.createdAt))).toBe(true);
    await lease.release();
  });

  it("does not remove a foreign lease when releasing", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const path = leasePath(repositoryRoot);
    const lease = await acquireProjectWorkerLease(repositoryRoot);
    const foreign = {
      pid: process.pid,
      token: "foreign-token",
      createdAt: new Date().toISOString(),
    };

    await unlink(path);
    await writeFile(path, `${JSON.stringify(foreign)}\n`, "utf8");
    await lease.release();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(foreign);
  });

  it("recovers a stable malformed lease", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const path = leasePath(repositoryRoot);
    await mkdir(join(repositoryRoot, ".visual-intent"), { recursive: true });
    await writeFile(path, "not-json\n", "utf8");

    const lease = await acquireProjectWorkerLease(repositoryRoot);

    expect(lease.recoveredStaleLease).toBe(true);
    await lease.release();
  });
});

async function createRepositoryRoot(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "visual-intent-worker-lease-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function leasePath(repositoryRoot: string): string {
  return join(repositoryRoot, ".visual-intent", "worker-lease.json");
}
