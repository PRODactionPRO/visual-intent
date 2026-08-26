import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LEASE_FILE_NAME = "worker-lease.json";
const RECOVERY_LOCK_FILE_NAME = "worker-lease.recovery.json";
const RECOVERY_LOCK_RETRIES = 200;
const RECOVERY_LOCK_RETRY_MS = 10;
const INVALID_LOCK_SETTLE_MS = 20;

interface LeaseDocument {
  pid: number;
  token: string;
  createdAt: string;
}

interface LeaseSnapshot {
  raw: string;
  lease?: LeaseDocument;
}

export interface ProjectWorkerLease {
  recoveredStaleLease: boolean;
  release(): Promise<void>;
}

export async function acquireProjectWorkerLease(
  repositoryRoot: string,
): Promise<ProjectWorkerLease> {
  const directory = join(repositoryRoot, ".visual-intent");
  const leasePath = join(directory, LEASE_FILE_NAME);
  const recoveryLockPath = join(directory, RECOVERY_LOCK_FILE_NAME);
  const lease: LeaseDocument = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let recoveredStaleLease = false;

  await mkdir(directory, { recursive: true });

  for (;;) {
    try {
      await writeExclusive(leasePath, lease);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const observed = await readSnapshot(leasePath);
    if (!observed) continue;
    if (observed.lease && isProcessAlive(observed.lease.pid)) {
      throw activeWorkerError(leasePath, observed.lease.pid);
    }

    if (!observed.lease) {
      await delay(INVALID_LOCK_SETTLE_MS);
      const settled = await readSnapshot(leasePath);
      if (!settled || settled.raw !== observed.raw) continue;
    }

    const removed = await withRecoveryLock(recoveryLockPath, async () => {
      const current = await readSnapshot(leasePath);
      if (!current || current.raw !== observed.raw) return false;
      if (current.lease && isProcessAlive(current.lease.pid)) {
        throw activeWorkerError(leasePath, current.lease.pid);
      }

      await unlink(leasePath);
      return true;
    });
    recoveredStaleLease ||= removed;
  }

  let released = false;
  return {
    recoveredStaleLease,
    async release(): Promise<void> {
      if (released) return;

      const current = await readSnapshot(leasePath);
      if (current?.lease?.token === lease.token) {
        await withRecoveryLock(recoveryLockPath, async () => {
          const latest = await readSnapshot(leasePath);
          if (latest?.lease?.token === lease.token) {
            await unlink(leasePath);
          }
        });
      }

      released = true;
    },
  };
}

async function writeExclusive(
  path: string,
  lease: LeaseDocument,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(lease)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function readSnapshot(path: string): Promise<LeaseSnapshot | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return { raw, lease: parseLease(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseLease(raw: string): LeaseDocument | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;

    const candidate = value as Partial<LeaseDocument>;
    if (
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid ?? 0) <= 0 ||
      typeof candidate.token !== "string" ||
      candidate.token.length === 0 ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt))
    ) {
      return undefined;
    }

    return {
      pid: candidate.pid as number,
      token: candidate.token,
      createdAt: candidate.createdAt,
    };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

function activeWorkerError(path: string, pid: number): Error {
  return new Error(
    `Visual Intent SDK worker is already running for this project (PID ${pid}). Lease: ${path}`,
  );
}

async function withRecoveryLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const recoveryLease: LeaseDocument = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < RECOVERY_LOCK_RETRIES; attempt += 1) {
    try {
      await writeExclusive(path, recoveryLease);
      try {
        return await operation();
      } finally {
        await releaseOwnedLock(path, recoveryLease.token);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readSnapshot(path);
    if (!existing) continue;
    if (existing.lease && !isProcessAlive(existing.lease.pid)) {
      await unlinkIfUnchanged(path, existing.raw);
    } else if (!existing.lease && (await isOldEnough(path))) {
      await unlinkIfUnchanged(path, existing.raw);
    }
    await delay(RECOVERY_LOCK_RETRY_MS);
  }

  throw new Error(
    `Timed out waiting for Visual Intent worker lease recovery lock: ${path}`,
  );
}

async function releaseOwnedLock(path: string, token: string): Promise<void> {
  const existing = await readSnapshot(path);
  if (existing?.lease?.token === token) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function unlinkIfUnchanged(path: string, raw: string): Promise<void> {
  const latest = await readSnapshot(path);
  if (latest?.raw !== raw) return;
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function isOldEnough(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    return Date.now() - details.mtimeMs >= INVALID_LOCK_SETTLE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
