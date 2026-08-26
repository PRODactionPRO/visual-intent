import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LEASE_FILE_NAME = "daemon-lease.json";
const RECOVERY_LOCK_FILE_NAME = "daemon-lease.recovery.json";
const SERVICE_OPERATION_LEASE_FILE_NAME = "service-operation-lease.json";
const SERVICE_OPERATION_RECOVERY_FILE_NAME =
  "service-operation-lease.recovery.json";
const STALE_SETTLE_MS = 20;
const RECOVERY_LOCK_RETRIES = 200;
const RECOVERY_LOCK_RETRY_MS = 10;

interface DaemonLeaseDocument {
  pid: number;
  token: string;
  createdAt: string;
  daemonInstanceId?: string;
}

interface DaemonLeaseSnapshot {
  raw: string;
  lease?: DaemonLeaseDocument;
}

export interface LiveProjectDaemonLeaseOwner {
  pid: number;
  createdAt: string;
  leasePath: string;
  daemonInstanceId?: string;
}

export interface ProjectDaemonLease {
  pid: number;
  leasePath: string;
  recoveredStaleLease: boolean;
  identify(daemonInstanceId: string): Promise<void>;
  release(): Promise<void>;
}

export class ProjectDaemonLeaseConflictError extends Error {
  constructor(
    readonly pid: number,
    readonly leasePath: string,
  ) {
    super(
      `A Visual Intent daemon is already running for this project (PID ${pid}). Lease: ${leasePath}`,
    );
    this.name = "ProjectDaemonLeaseConflictError";
  }
}

export interface ProjectServiceOperationLease {
  leasePath: string;
  recoveredStaleLease: boolean;
  release(): Promise<void>;
}

export class ProjectServiceOperationLeaseConflictError extends Error {
  constructor(
    readonly pid: number,
    readonly leasePath: string,
  ) {
    super(
      `Another Visual Intent service operation is already running for this project (PID ${pid}). Lease: ${leasePath}`,
    );
    this.name = "ProjectServiceOperationLeaseConflictError";
  }
}

/**
 * Read-only ServiceManager preflight. Stale or malformed leases are reported
 * as having no live owner and are never changed by this helper.
 */
export async function readLiveProjectDaemonLeaseOwner(
  repositoryRoot: string,
): Promise<LiveProjectDaemonLeaseOwner | undefined> {
  const leasePath = projectDaemonLeasePath(repositoryRoot);
  const snapshot = await readSnapshot(leasePath);
  if (!snapshot?.lease || !isProcessAlive(snapshot.lease.pid)) return undefined;
  return {
    pid: snapshot.lease.pid,
    createdAt: snapshot.lease.createdAt,
    leasePath,
    ...(snapshot.lease.daemonInstanceId
      ? { daemonInstanceId: snapshot.lease.daemonInstanceId }
      : {}),
  };
}

export async function acquireProjectDaemonLease(
  repositoryRoot: string,
): Promise<ProjectDaemonLease> {
  const directory = join(repositoryRoot, ".visual-intent");
  const leasePath = projectDaemonLeasePath(repositoryRoot);
  const recoveryLockPath = join(directory, RECOVERY_LOCK_FILE_NAME);
  const lease: DaemonLeaseDocument = {
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
      throw new ProjectDaemonLeaseConflictError(observed.lease.pid, leasePath);
    }

    await delay(STALE_SETTLE_MS);
    const settled = await readSnapshot(leasePath);
    if (!settled || settled.raw !== observed.raw) continue;
    if (settled.lease && isProcessAlive(settled.lease.pid)) {
      throw new ProjectDaemonLeaseConflictError(settled.lease.pid, leasePath);
    }

    const removed = await withRecoveryLock(recoveryLockPath, async () => {
      const current = await readSnapshot(leasePath);
      if (!current || current.raw !== settled.raw) return false;
      if (current.lease && isProcessAlive(current.lease.pid)) {
        throw new ProjectDaemonLeaseConflictError(current.lease.pid, leasePath);
      }
      await unlinkIgnoringMissing(leasePath);
      return true;
    });
    recoveredStaleLease ||= removed;
  }

  let released = false;
  return {
    pid: lease.pid,
    leasePath,
    recoveredStaleLease,
    async identify(daemonInstanceId: string): Promise<void> {
      if (!isDaemonInstanceId(daemonInstanceId)) {
        throw new Error("Visual Intent daemon instance ID is invalid");
      }
      await withRecoveryLock(recoveryLockPath, async () => {
        const current = await readSnapshot(leasePath);
        if (current?.lease?.token !== lease.token) {
          throw new Error(
            `Visual Intent daemon lease ownership changed before identity was recorded: ${leasePath}`,
          );
        }
        lease.daemonInstanceId = daemonInstanceId;
        await writeAtomic(leasePath, lease);
      });
    },
    async release(): Promise<void> {
      if (released) return;
      await withRecoveryLock(recoveryLockPath, async () => {
        const current = await readSnapshot(leasePath);
        if (current?.lease?.token === lease.token) {
          await unlinkIgnoringMissing(leasePath);
        }
      });
      released = true;
    },
  };
}

export async function acquireProjectServiceOperationLease(
  repositoryRoot: string,
): Promise<ProjectServiceOperationLease> {
  const directory = join(repositoryRoot, ".visual-intent");
  const leasePath = join(directory, SERVICE_OPERATION_LEASE_FILE_NAME);
  const recoveryLockPath = join(
    directory,
    SERVICE_OPERATION_RECOVERY_FILE_NAME,
  );
  const lease: DaemonLeaseDocument = {
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
      throw new ProjectServiceOperationLeaseConflictError(
        observed.lease.pid,
        leasePath,
      );
    }

    await delay(STALE_SETTLE_MS);
    const settled = await readSnapshot(leasePath);
    if (!settled || settled.raw !== observed.raw) continue;
    if (settled.lease && isProcessAlive(settled.lease.pid)) {
      throw new ProjectServiceOperationLeaseConflictError(
        settled.lease.pid,
        leasePath,
      );
    }

    const removed = await withRecoveryLock(
      recoveryLockPath,
      async () => {
        const current = await readSnapshot(leasePath);
        if (!current || current.raw !== settled.raw) return false;
        if (current.lease && isProcessAlive(current.lease.pid)) {
          throw new ProjectServiceOperationLeaseConflictError(
            current.lease.pid,
            leasePath,
          );
        }
        await unlinkIgnoringMissing(leasePath);
        return true;
      },
      "service operation lease",
    );
    recoveredStaleLease ||= removed;
  }

  let released = false;
  return {
    leasePath,
    recoveredStaleLease,
    async release(): Promise<void> {
      if (released) return;
      await withRecoveryLock(
        recoveryLockPath,
        async () => {
          const current = await readSnapshot(leasePath);
          if (current?.lease?.token === lease.token) {
            await unlinkIgnoringMissing(leasePath);
          }
        },
        "service operation lease",
      );
      released = true;
    },
  };
}

function projectDaemonLeasePath(repositoryRoot: string): string {
  return join(repositoryRoot, ".visual-intent", LEASE_FILE_NAME);
}

async function writeExclusive(
  path: string,
  lease: DaemonLeaseDocument,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(lease)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function readSnapshot(
  path: string,
): Promise<DaemonLeaseSnapshot | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return { raw, lease: parseLease(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseLease(raw: string): DaemonLeaseDocument | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<DaemonLeaseDocument>;
    if (
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid ?? 0) <= 0 ||
      typeof candidate.token !== "string" ||
      candidate.token.length === 0 ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt)) ||
      (candidate.daemonInstanceId !== undefined &&
        !isDaemonInstanceId(candidate.daemonInstanceId))
    ) {
      return undefined;
    }
    return {
      pid: candidate.pid as number,
      token: candidate.token,
      createdAt: candidate.createdAt,
      ...(candidate.daemonInstanceId
        ? { daemonInstanceId: candidate.daemonInstanceId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function isDaemonInstanceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

async function writeAtomic(
  path: string,
  lease: DaemonLeaseDocument,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(lease)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
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

async function withRecoveryLock<T>(
  recoveryLockPath: string,
  operation: () => Promise<T>,
  description = "daemon lease",
): Promise<T> {
  const recoveryLease: DaemonLeaseDocument = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < RECOVERY_LOCK_RETRIES; attempt += 1) {
    try {
      await writeExclusive(recoveryLockPath, recoveryLease);
      try {
        return await operation();
      } finally {
        await releaseOwnedFile(recoveryLockPath, recoveryLease.token);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const observed = await readSnapshot(recoveryLockPath);
    if (!observed) continue;
    if (observed.lease && !isProcessAlive(observed.lease.pid)) {
      await unlinkIfUnchanged(recoveryLockPath, observed.raw);
    } else if (!observed.lease && (await isOldEnough(recoveryLockPath))) {
      await unlinkIfUnchanged(recoveryLockPath, observed.raw);
    }
    await delay(RECOVERY_LOCK_RETRY_MS);
  }

  throw new Error(
    `Timed out waiting for Visual Intent ${description} recovery lock: ${recoveryLockPath}`,
  );
}

async function releaseOwnedFile(path: string, token: string): Promise<void> {
  const current = await readSnapshot(path);
  if (current?.lease?.token === token) await unlinkIgnoringMissing(path);
}

async function unlinkIfUnchanged(path: string, raw: string): Promise<void> {
  const current = await readSnapshot(path);
  if (current?.raw === raw) await unlinkIgnoringMissing(path);
}

async function unlinkIgnoringMissing(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function isOldEnough(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    return Date.now() - details.mtimeMs >= STALE_SETTLE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
