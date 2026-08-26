import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireProjectDaemonLease,
  acquireProjectServiceOperationLease,
  ProjectDaemonLeaseConflictError,
  ProjectServiceOperationLeaseConflictError,
  readLiveProjectDaemonLeaseOwner,
} from "../src/project-daemon-lease.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("project daemon lease", () => {
  it("atomically allows only one concurrent daemon per repository", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const attempts = await Promise.allSettled([
      acquireProjectDaemonLease(repositoryRoot),
      acquireProjectDaemonLease(repositoryRoot),
    ]);
    const acquired = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireProjectDaemonLease>>
      > => result.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ProjectDaemonLeaseConflictError);
    expect((rejected[0]?.reason as ProjectDaemonLeaseConflictError).pid).toBe(
      process.pid,
    );
    expect((await stat(leasePath(repositoryRoot))).mode & 0o777).toBe(0o600);
    await acquired[0]?.value.release();
  });

  it("blocks a second daemon while the lease PID is alive", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const first = await acquireProjectDaemonLease(repositoryRoot);

    await expect(
      acquireProjectDaemonLease(repositoryRoot),
    ).rejects.toMatchObject({ pid: process.pid });
    expect(await readLiveProjectDaemonLeaseOwner(repositoryRoot)).toEqual({
      pid: process.pid,
      createdAt: expect.any(String),
      leasePath: leasePath(repositoryRoot),
    });

    await first.release();
    expect(
      await readLiveProjectDaemonLeaseOwner(repositoryRoot),
    ).toBeUndefined();
  });

  it("atomically binds the live lease to the started daemon instance", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const lease = await acquireProjectDaemonLease(repositoryRoot);

    await lease.identify("daemon-instance-1");

    expect(await readLiveProjectDaemonLeaseOwner(repositoryRoot)).toEqual({
      pid: process.pid,
      createdAt: expect.any(String),
      leasePath: leasePath(repositoryRoot),
      daemonInstanceId: "daemon-instance-1",
    });
    expect((await stat(leasePath(repositoryRoot))).mode & 0o777).toBe(0o600);
    await lease.release();
  });

  it("automatically recovers a stable lease owned by a dead PID", async () => {
    const repositoryRoot = await createRepositoryRoot();
    await writeLease(repositoryRoot, {
      pid: 2_147_483_647,
      token: "dead-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const lease = await acquireProjectDaemonLease(repositoryRoot);

    expect(lease.recoveredStaleLease).toBe(true);
    expect(
      JSON.parse(await readFile(leasePath(repositoryRoot), "utf8")),
    ).toEqual(expect.objectContaining({ pid: process.pid }));
    await lease.release();
  });

  it("automatically recovers a stable malformed lease", async () => {
    const repositoryRoot = await createRepositoryRoot();
    await mkdir(join(repositoryRoot, ".visual-intent"), { recursive: true });
    await writeFile(leasePath(repositoryRoot), "not-json\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const before = await readFile(leasePath(repositoryRoot), "utf8");

    expect(
      await readLiveProjectDaemonLeaseOwner(repositoryRoot),
    ).toBeUndefined();
    expect(await readFile(leasePath(repositoryRoot), "utf8")).toBe(before);
    const lease = await acquireProjectDaemonLease(repositoryRoot);

    expect(lease.recoveredStaleLease).toBe(true);
    expect(
      JSON.parse(await readFile(leasePath(repositoryRoot), "utf8")),
    ).toEqual(expect.objectContaining({ pid: process.pid }));
    await lease.release();
  });

  it("does not remove a foreign lease when the former owner releases", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const owned = await acquireProjectDaemonLease(repositoryRoot);
    const foreign = {
      pid: process.pid,
      token: "foreign-token",
      createdAt: new Date().toISOString(),
    };

    await unlink(leasePath(repositoryRoot));
    await writeFile(
      leasePath(repositoryRoot),
      `${JSON.stringify(foreign)}\n`,
      "utf8",
    );
    await owned.release();

    expect(
      JSON.parse(await readFile(leasePath(repositoryRoot), "utf8")),
    ).toEqual(foreign);
  });

  it("serializes service mutations and releases only the owned operation lease", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const first = await acquireProjectServiceOperationLease(repositoryRoot);

    await expect(
      acquireProjectServiceOperationLease(repositoryRoot),
    ).rejects.toBeInstanceOf(ProjectServiceOperationLeaseConflictError);
    expect((await stat(first.leasePath)).mode & 0o777).toBe(0o600);

    await first.release();
    const next = await acquireProjectServiceOperationLease(repositoryRoot);
    expect(next.recoveredStaleLease).toBe(false);
    await next.release();
  });

  it("recovers a service operation lease left by a dead process", async () => {
    const repositoryRoot = await createRepositoryRoot();
    const path = serviceOperationLeasePath(repositoryRoot);
    await mkdir(join(repositoryRoot, ".visual-intent"), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "dead-service-operation",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const lease = await acquireProjectServiceOperationLease(repositoryRoot);

    expect(lease.recoveredStaleLease).toBe(true);
    expect(lease.leasePath).toBe(path);
    await lease.release();
  });
});

async function createRepositoryRoot(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "visual-intent-daemon-lease-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writeLease(
  repositoryRoot: string,
  value: { pid: number; token: string; createdAt: string },
): Promise<void> {
  await mkdir(join(repositoryRoot, ".visual-intent"), { recursive: true });
  await writeFile(leasePath(repositoryRoot), `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(leasePath(repositoryRoot), 0o600);
}

function leasePath(repositoryRoot: string): string {
  return join(repositoryRoot, ".visual-intent", "daemon-lease.json");
}

function serviceOperationLeasePath(repositoryRoot: string): string {
  return join(repositoryRoot, ".visual-intent", "service-operation-lease.json");
}
