import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProjectSession } from "@visual-intent/protocol";

const TOKEN_PATTERN = /^[a-f0-9]{48}$/u;
const PAIRING_CODE_PATTERN = /^\d{6}$/u;

export interface BridgeConfig {
  apiToken: string;
  pairingCode: string;
}

export interface BridgeSessionRegistration {
  version: 1;
  daemonInstanceId: string;
  sessionId: string;
  daemonUrl: string;
  apiToken: string;
  repositoryRoot: string;
  projectKey: string;
  displayName: string;
  targetUrl: string;
  processId: number;
  updatedAt: string;
}

export function bridgeDataDirectory(): string {
  return join(homedir(), ".visual-intent", "bridge");
}

export async function loadOrCreateBridgeConfig(
  directory = bridgeDataDirectory(),
): Promise<BridgeConfig> {
  const configPath = join(directory, "connection.json");
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8")) as {
      apiToken?: unknown;
      pairingCode?: unknown;
    };
    if (
      typeof stored.apiToken === "string" &&
      TOKEN_PATTERN.test(stored.apiToken) &&
      typeof stored.pairingCode === "string" &&
      PAIRING_CODE_PATTERN.test(stored.pairingCode)
    ) {
      return { apiToken: stored.apiToken, pairingCode: stored.pairingCode };
    }
  } catch {
    // A missing or malformed local Bridge config is replaced below.
  }

  const config = {
    apiToken: randomBytes(24).toString("hex"),
    pairingCode: randomInt(0, 1_000_000).toString().padStart(6, "0"),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
  return config;
}

export async function registerBridgeSession(
  session: ProjectSession,
  daemonUrl: string,
  apiToken: string,
  daemonInstanceId: string,
  directory = bridgeDataDirectory(),
): Promise<BridgeSessionRegistration> {
  assertLoopbackUrl(daemonUrl);
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  const registration: BridgeSessionRegistration = {
    version: 1,
    daemonInstanceId,
    sessionId: session.id,
    daemonUrl: daemonUrl.replace(/\/$/u, ""),
    apiToken,
    repositoryRoot: session.repository.root,
    projectKey: session.projectKey,
    displayName: session.displayName,
    targetUrl: session.targetUrl,
    processId: process.pid,
    updatedAt: new Date().toISOString(),
  };
  const path = registrationPath(session.id, sessionsDirectory);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(registration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return registration;
}

export async function unregisterBridgeSession(
  registration: BridgeSessionRegistration,
  directory = bridgeDataDirectory(),
): Promise<void> {
  const path = registrationPath(
    registration.sessionId,
    join(directory, "sessions"),
  );
  try {
    const current = parseRegistration(await readFile(path, "utf8"));
    if (
      current.daemonInstanceId === registration.daemonInstanceId &&
      current.daemonUrl === registration.daemonUrl &&
      current.apiToken === registration.apiToken
    ) {
      await rm(path);
    }
  } catch {
    // The process can stop safely when its registration is already absent.
  }
}

export async function readBridgeRegistrations(
  directory = bridgeDataDirectory(),
): Promise<BridgeSessionRegistration[]> {
  const sessionsDirectory = join(directory, "sessions");
  const entries = await readdir(sessionsDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const registrations = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          return parseRegistration(
            await readFile(join(sessionsDirectory, entry), "utf8"),
          );
        } catch {
          return undefined;
        }
      }),
  );
  return registrations.filter(
    (registration): registration is BridgeSessionRegistration =>
      registration !== undefined,
  );
}

export function assertLoopbackUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "Visual Intent Bridge only accepts plain HTTP loopback origins",
    );
  }
  return url;
}

function registrationPath(sessionId: string, directory: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(directory, `${digest}.json`);
}

function parseRegistration(serialized: string): BridgeSessionRegistration {
  const value = JSON.parse(serialized) as Partial<BridgeSessionRegistration>;
  if (
    value.version !== 1 ||
    typeof value.daemonInstanceId !== "string" ||
    value.daemonInstanceId.length === 0 ||
    typeof value.sessionId !== "string" ||
    typeof value.daemonUrl !== "string" ||
    typeof value.apiToken !== "string" ||
    !TOKEN_PATTERN.test(value.apiToken) ||
    typeof value.repositoryRoot !== "string" ||
    typeof value.projectKey !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.targetUrl !== "string" ||
    typeof value.processId !== "number" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Invalid Visual Intent Bridge registration");
  }
  assertLoopbackUrl(value.daemonUrl);
  return value as BridgeSessionRegistration;
}
