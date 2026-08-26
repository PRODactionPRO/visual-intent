import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const SERVICE_CONFIG_VERSION = 1;
export const SERVICE_LABEL_PREFIX = "com.prodaction.visual-intent.project.";

export const SERVICE_EXECUTOR_MODES = [
  "preserve",
  "disconnected",
  "isolated-worker",
] as const;

export type ServiceExecutorMode = (typeof SERVICE_EXECUTOR_MODES)[number];

export interface VisualIntentServiceConfig {
  version: typeof SERVICE_CONFIG_VERSION;
  label: string;
  repositoryRoot: string;
  projectKey: string;
  displayName: string;
  target: string;
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
  executor: ServiceExecutorMode;
  allowDirty: boolean;
  nodePath: string;
  cliPath: string;
  environmentPath: string;
  codexHome?: string;
  workerThread?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServiceConfigOptions {
  repositoryRoot: string;
  target: string;
  nodePath: string;
  cliPath: string;
  projectKey?: string;
  displayName?: string;
  host?: string;
  port?: number;
  executor?: string;
  allowDirty?: boolean;
  environmentPath?: string;
  codexHome?: string;
  workerThread?: string;
  now?: Date;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_URL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const SERVICE_LABEL_PATTERN =
  /^com\.prodaction\.visual-intent\.project\.[a-z0-9][a-z0-9-]{0,39}\.[a-f0-9]{12}$/u;

export function serviceConfigPath(repositoryRoot: string): string {
  return join(repositoryRoot, ".visual-intent", "service.json");
}

export function serviceLabel(
  repositoryRoot: string,
  projectKey = basename(repositoryRoot),
): string {
  if (!isAbsolute(repositoryRoot)) {
    throw new Error("Service repository root must be an absolute path");
  }
  const slug = projectSlug(projectKey);
  const hash = createHash("sha256")
    .update(resolve(repositoryRoot))
    .digest("hex")
    .slice(0, 12);
  return `${SERVICE_LABEL_PREFIX}${slug}.${hash}`;
}

export function assertServiceLabel(label: string): void {
  if (!SERVICE_LABEL_PATTERN.test(label)) {
    throw new Error(
      `Refusing to manage foreign or malformed LaunchAgent label: ${label}`,
    );
  }
}

export async function createServiceConfig(
  options: CreateServiceConfigOptions,
): Promise<VisualIntentServiceConfig> {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot));
  const projectKey = nonEmpty(
    options.projectKey ?? basename(repositoryRoot),
    "project key",
  );
  const displayName = nonEmpty(
    options.displayName ?? projectKey,
    "display name",
  );
  const target = validateTargetOrigin(options.target);
  const host = validateLoopbackHost(options.host ?? "127.0.0.1");
  const port = validateServicePort(options.port ?? 7310);
  const executor = validateExecutorMode(options.executor ?? "preserve");
  const nodePath = validateExecutablePath(
    options.nodePath,
    "Node.js executable",
  );
  const cliPath = validateExecutablePath(options.cliPath, "CLI entrypoint");
  await assertReadableExecutable(nodePath, "Node.js executable", true);
  await assertReadableExecutable(cliPath, "CLI entrypoint", false);
  const environmentPath = validateEnvironmentPath(
    options.environmentPath,
    nodePath,
  );
  const codexHome = optionalAbsoluteString(options.codexHome, "CODEX_HOME");
  const workerThread = options.workerThread?.trim();
  if (workerThread && executor !== "isolated-worker") {
    throw new Error(
      "A service worker thread requires executor mode isolated-worker",
    );
  }
  const timestamp = (options.now ?? new Date()).toISOString();

  return {
    version: SERVICE_CONFIG_VERSION,
    label: serviceLabel(repositoryRoot, projectKey),
    repositoryRoot,
    projectKey,
    displayName,
    target,
    host,
    port,
    executor,
    allowDirty: options.allowDirty ?? false,
    nodePath,
    cliPath,
    environmentPath,
    ...(codexHome ? { codexHome } : {}),
    ...(workerThread ? { workerThread } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function readServiceConfig(
  repositoryRoot: string,
): Promise<VisualIntentServiceConfig> {
  const root = await realpath(resolve(repositoryRoot));
  const path = serviceConfigPath(root);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Visual Intent service is not configured for ${root}. Run service install first.`,
        { cause: error },
      );
    }
    throw new Error(
      `Cannot read Visual Intent service config at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return parseServiceConfig(value, root);
}

export async function writeServiceConfig(
  config: VisualIntentServiceConfig,
): Promise<string> {
  const validated = parseServiceConfig(config, config.repositoryRoot);
  const path = serviceConfigPath(validated.repositoryRoot);
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.service.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(validated, null, 2)}\n`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return path;
}

export function parseServiceConfig(
  value: unknown,
  expectedRepositoryRoot?: string,
): VisualIntentServiceConfig {
  if (!isRecord(value)) {
    throw new Error("Visual Intent service config must be a JSON object");
  }
  if (value.version !== SERVICE_CONFIG_VERSION) {
    throw new Error(
      `Unsupported Visual Intent service config version: ${String(value.version)}`,
    );
  }
  const repositoryRoot = requireAbsoluteString(
    value.repositoryRoot,
    "repositoryRoot",
  );
  if (
    expectedRepositoryRoot &&
    resolve(repositoryRoot) !== resolve(expectedRepositoryRoot)
  ) {
    throw new Error(
      `Service config belongs to ${repositoryRoot}, not ${expectedRepositoryRoot}`,
    );
  }
  const projectKey = requireString(value.projectKey, "projectKey");
  const label = requireString(value.label, "label");
  assertServiceLabel(label);
  const expectedLabel = serviceLabel(repositoryRoot, projectKey);
  if (label !== expectedLabel) {
    throw new Error(
      `Service label does not match its repository: expected ${expectedLabel}`,
    );
  }
  const host = validateLoopbackHost(value.host);
  const executor = validateExecutorMode(value.executor);
  const workerThread = optionalString(value.workerThread, "workerThread");
  if (workerThread && executor !== "isolated-worker") {
    throw new Error(
      "A service worker thread requires executor mode isolated-worker",
    );
  }
  if (typeof value.allowDirty !== "boolean") {
    throw new Error("Service config allowDirty must be a boolean");
  }

  const nodePath = validateExecutablePath(value.nodePath, "Node.js executable");
  const codexHome = optionalAbsoluteString(value.codexHome, "CODEX_HOME");
  return {
    version: SERVICE_CONFIG_VERSION,
    label,
    repositoryRoot,
    projectKey,
    displayName: requireString(value.displayName, "displayName"),
    target: validateTargetOrigin(value.target),
    host,
    port: validateServicePort(value.port),
    executor,
    allowDirty: value.allowDirty,
    nodePath,
    cliPath: validateExecutablePath(value.cliPath, "CLI entrypoint"),
    environmentPath: validateEnvironmentPath(value.environmentPath, nodePath),
    ...(codexHome ? { codexHome } : {}),
    ...(workerThread ? { workerThread } : {}),
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
    updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
  };
}

export function validateServicePort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new Error("Service port must be an integer between 1 and 65535");
  }
  return value;
}

function projectSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return slug || "project";
}

function validateTargetOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Service target must be a URL string");
  }
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("Service target must be a valid URL");
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)) {
    throw new Error("Service target must use http:// or https://");
  }
  if (!LOOPBACK_URL_HOSTS.has(target.hostname)) {
    throw new Error("Service target must use a localhost host");
  }
  if (
    (target.pathname !== "" && target.pathname !== "/") ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      `Service target must be an origin only (for example ${target.origin})`,
    );
  }
  return target.origin;
}

function validateLoopbackHost(
  value: unknown,
): VisualIntentServiceConfig["host"] {
  if (typeof value !== "string" || !LOOPBACK_HOSTS.has(value)) {
    throw new Error("Service host must be 127.0.0.1, ::1, or localhost");
  }
  return value as VisualIntentServiceConfig["host"];
}

function validateExecutorMode(value: unknown): ServiceExecutorMode {
  if (
    typeof value !== "string" ||
    !(SERVICE_EXECUTOR_MODES as readonly string[]).includes(value)
  ) {
    throw new Error(
      "Service executor must be preserve, disconnected, or isolated-worker",
    );
  }
  return value as ServiceExecutorMode;
}

function validateExecutablePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(path);
}

function validateEnvironmentPath(value: unknown, nodePath: string): string {
  if (value !== undefined && typeof value !== "string") {
    throw new Error("Service PATH must be a string");
  }
  return [
    ...(typeof value === "string" ? value.split(":") : []),
    dirname(nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(":");
}

function optionalAbsoluteString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requireAbsoluteString(value, field);
}

async function assertReadableExecutable(
  path: string,
  label: string,
  executable: boolean,
): Promise<void> {
  try {
    await access(path, executable ? constants.X_OK : constants.R_OK);
  } catch (error) {
    throw new Error(`${label} is not accessible at ${path}`, { cause: error });
  }
}

function validateTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Service config ${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireAbsoluteString(value: unknown, field: string): string {
  const path = requireString(value, field);
  if (!isAbsolute(path)) {
    throw new Error(`Service config ${field} must be an absolute path`);
  }
  return resolve(path);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Service config ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0)
    throw new Error(`Service ${label} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
