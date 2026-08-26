import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { ProjectSession } from "@visual-intent/protocol";

import {
  probeRuntimeTarget,
  type RuntimeDiagnosticsSnapshot,
} from "./runtime-diagnostics.js";

const execFileAsync = promisify(execFile);
const CONNECTION_FILE = join(".visual-intent", "connection.json");
const VISUAL_INTENT_EXCLUDE = "/.visual-intent/";

export type DoctorCheckStatus = "pass" | "warning" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  recommendation?: string;
}

export interface DoctorIgnoreRecipe {
  tool: "biome" | "eslint" | "prettier";
  detected: boolean;
  ignored: boolean | undefined;
  configPaths: string[];
  recipe: string;
}

export interface DoctorConnectionSummary {
  path: string;
  daemonUrl?: string;
  projectKey?: string;
  repositoryRoot?: string;
  sessionId?: string;
  daemonInstanceId?: string;
  protocolVersion?: string;
}

export interface DoctorRuntimeSummary {
  health?: {
    protocolVersion?: string;
    daemonInstanceId?: string;
    sessionId?: string;
    projectKey?: string;
    repositoryRoot?: string;
    targetUrl?: string;
    proxyUrl?: string;
    executor?: ProjectSession["executor"];
  };
  diagnostics?: RuntimeDiagnosticsSnapshot;
}

export interface DoctorReport {
  generatedAt: string;
  repositoryRoot: string;
  checks: DoctorCheck[];
  summary: Record<DoctorCheckStatus, number>;
  connection: DoctorConnectionSummary;
  ignoreRecipes: DoctorIgnoreRecipe[];
  runtime: DoctorRuntimeSummary;
}

export interface DoctorDependencies {
  canonicalize(path: string): Promise<string>;
  readText(path: string): Promise<string | undefined>;
  listRelevantFiles(repositoryRoot: string): Promise<string[]>;
  runGit(repositoryRoot: string, args: string[]): Promise<string>;
  fetch: typeof fetch;
  now(): Date;
}

export interface RunDoctorOptions {
  repo: string;
  requestTimeoutMs?: number;
}

interface StoredConnection {
  protocolVersion?: unknown;
  daemonUrl?: unknown;
  apiToken?: unknown;
  projectKey?: unknown;
  repositoryRoot?: unknown;
  sessionId?: unknown;
  daemonInstanceId?: unknown;
}

interface HealthDocument {
  protocolVersion?: string;
  daemonInstanceId?: string;
  session?: ProjectSession;
}

export const defaultDoctorDependencies: DoctorDependencies = {
  canonicalize: realpath,
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  listRelevantFiles,
  async runGit(repositoryRoot, args) {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, ...args],
      {
        encoding: "utf8",
      },
    );
    return stdout;
  },
  fetch: globalThis.fetch,
  now: () => new Date(),
};

export async function runDoctor(
  options: RunDoctorOptions,
  dependencies: DoctorDependencies = defaultDoctorDependencies,
): Promise<DoctorReport> {
  const generatedAt = dependencies.now().toISOString();
  const requestedRoot = resolve(options.repo);
  let repositoryRoot = requestedRoot;
  const checks: DoctorCheck[] = [];

  try {
    repositoryRoot = await dependencies.canonicalize(requestedRoot);
    checks.push({
      id: "repository.canonical",
      status: "pass",
      message: `Repository resolved to ${repositoryRoot}`,
    });
  } catch {
    checks.push({
      id: "repository.canonical",
      status: "fail",
      message: `Repository does not exist or cannot be resolved: ${requestedRoot}`,
    });
    return createReport({
      generatedAt,
      repositoryRoot,
      checks,
      connection: { path: join(repositoryRoot, CONNECTION_FILE) },
      ignoreRecipes: defaultIgnoreRecipes(),
      runtime: {},
    });
  }

  try {
    const gitRoot = (
      await dependencies.runGit(repositoryRoot, [
        "rev-parse",
        "--show-toplevel",
      ])
    ).trim();
    if (!gitRoot) throw new Error("Git returned an empty repository root");
    const canonicalGitRoot = await dependencies.canonicalize(gitRoot);
    repositoryRoot = canonicalGitRoot;
    checks.push({
      id: "repository.git-root",
      status: "pass",
      message: `Git root resolved to ${repositoryRoot}`,
    });
  } catch {
    checks.push({
      id: "repository.git-root",
      status: "warning",
      message: "Git root could not be resolved; using the requested directory",
      recommendation:
        "Pass --repo with the root of the project if this directory is nested or is not a Git worktree.",
    });
  }

  await checkGitExclude(repositoryRoot, dependencies, checks);
  const relevantFiles = await dependencies
    .listRelevantFiles(repositoryRoot)
    .catch(() => []);
  const ignoreRecipes = await checkToolIgnores(
    repositoryRoot,
    relevantFiles,
    dependencies,
    checks,
  );

  const connectionPath = join(repositoryRoot, CONNECTION_FILE);
  const connectionSummary: DoctorConnectionSummary = { path: connectionPath };
  const runtime: DoctorRuntimeSummary = {};
  const serializedConnection = await dependencies.readText(connectionPath);
  if (!serializedConnection) {
    checks.push({
      id: "connection.file",
      status: "fail",
      message: "Visual Intent connection file is missing",
      recommendation: "Start Visual Intent for this exact repository first.",
    });
    await checkNextAllowedDevOrigins(
      repositoryRoot,
      relevantFiles,
      undefined,
      dependencies,
      checks,
    );
    return createReport({
      generatedAt,
      repositoryRoot,
      checks,
      connection: connectionSummary,
      ignoreRecipes,
      runtime,
    });
  }

  const connection = parseConnection(serializedConnection);
  Object.assign(connectionSummary, safeConnectionSummary(connection));
  if (!isValidConnection(connection)) {
    checks.push({
      id: "connection.file",
      status: "fail",
      message: "Visual Intent connection file is malformed or incomplete",
      recommendation:
        "Restart Visual Intent to replace the stale connection file.",
    });
    return createReport({
      generatedAt,
      repositoryRoot,
      checks,
      connection: connectionSummary,
      ignoreRecipes,
      runtime,
    });
  }

  checks.push({
    id: "connection.file",
    status: "pass",
    message: "Visual Intent connection file is readable",
  });
  checks.push(
    connection.repositoryRoot === repositoryRoot
      ? {
          id: "connection.repository",
          status: "pass",
          message: "Connection belongs to the canonical repository",
        }
      : {
          id: "connection.repository",
          status: "fail",
          message: `Connection belongs to ${connection.repositoryRoot}, not ${repositoryRoot}`,
          recommendation:
            "Restart Visual Intent with --repo pointing at this repository.",
        },
  );

  const daemonOrigin = loopbackOrigin(connection.daemonUrl);
  if (!daemonOrigin) {
    checks.push({
      id: "connection.loopback",
      status: "fail",
      message: "Connection daemon URL is not a plain HTTP loopback origin",
    });
    return createReport({
      generatedAt,
      repositoryRoot,
      checks,
      connection: connectionSummary,
      ignoreRecipes,
      runtime,
    });
  }
  checks.push({
    id: "connection.loopback",
    status: "pass",
    message: `Daemon is restricted to ${daemonOrigin}`,
  });

  const timeoutMs = options.requestTimeoutMs ?? 2_000;
  const health = await fetchJson(
    dependencies.fetch,
    `${daemonOrigin}/_visual-intent/api/health`,
    connection.apiToken,
    timeoutMs,
  );
  if (!health.ok) {
    checks.push({
      id: "proxy.health",
      status: "fail",
      message: `Visual Intent proxy is unreachable (${health.errorCode})`,
      recommendation:
        "Start or restart the Visual Intent proxy for this project.",
    });
  } else {
    const document = parseHealth(health.body);
    runtime.health = safeHealthSummary(document);
    checks.push({
      id: "proxy.health",
      status: "pass",
      message: "Visual Intent proxy health endpoint is reachable",
    });
    addRuntimeIdentityChecks(checks, repositoryRoot, connection, document);
    addExecutorCheck(checks, document.session?.executor);
  }

  const diagnostics = await fetchJson(
    dependencies.fetch,
    `${daemonOrigin}/_visual-intent/api/diagnostics`,
    connection.apiToken,
    timeoutMs,
  );
  if (diagnostics.ok && isRuntimeDiagnosticsSnapshot(diagnostics.body)) {
    runtime.diagnostics = diagnostics.body;
    checks.push({
      id: "runtime.diagnostics",
      status: "pass",
      message: "Authenticated runtime diagnostics are available",
    });
    checks.push(
      diagnostics.body.target.reachable
        ? {
            id: "target.reachability",
            status: "pass",
            message: `Target is reachable (${diagnostics.body.target.status ?? "no status"})`,
          }
        : {
            id: "target.reachability",
            status: "fail",
            message: `Target is unreachable (${diagnostics.body.target.errorCode ?? "RUNTIME_ERROR"})`,
            recommendation:
              "Start the project dev server; the proxy itself can remain running.",
          },
    );
  } else {
    const diagnosticsErrorCode = diagnostics.ok
      ? "INVALID_RESPONSE"
      : diagnostics.errorCode;
    checks.push({
      id: "runtime.diagnostics",
      status: "warning",
      message: `Runtime diagnostics are unavailable (${diagnosticsErrorCode})`,
      recommendation: "Restart the proxy with the current Visual Intent build.",
    });
    const targetUrl = runtime.health?.targetUrl;
    if (targetUrl && loopbackHttpUrl(targetUrl)) {
      const probe = await probeRuntimeTarget(new URL(targetUrl), {
        fetch: dependencies.fetch,
        now: dependencies.now,
        timeoutMs,
      });
      checks.push(
        probe.reachable
          ? {
              id: "target.reachability",
              status: "pass",
              message: `Target is reachable (${probe.status ?? "no status"})`,
            }
          : {
              id: "target.reachability",
              status: "fail",
              message: `Target is unreachable (${probe.errorCode ?? "RUNTIME_ERROR"})`,
            },
      );
    } else {
      checks.push({
        id: "target.reachability",
        status: "skip",
        message: "Target URL is unavailable for a safe loopback probe",
      });
    }
  }

  await checkNextAllowedDevOrigins(
    repositoryRoot,
    relevantFiles,
    daemonOrigin,
    dependencies,
    checks,
  );

  return createReport({
    generatedAt,
    repositoryRoot,
    checks,
    connection: connectionSummary,
    ignoreRecipes,
    runtime,
  });
}

export function doctorExitCode(
  report: DoctorReport,
  strict = false,
): 0 | 1 | 2 {
  if (report.summary.fail > 0) return 2;
  if (report.summary.warning > 0) return strict ? 2 : 1;
  return 0;
}

export function formatDoctorReport(report: DoctorReport): string {
  const statusLabel: Record<DoctorCheckStatus, string> = {
    pass: "OK",
    warning: "WARN",
    fail: "FAIL",
    skip: "SKIP",
  };
  const lines = [
    `Visual Intent doctor: ${report.repositoryRoot}`,
    `Итог: ${report.summary.pass} OK · ${report.summary.warning} предупреждений · ${report.summary.fail} ошибок · ${report.summary.skip} пропущено`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`[${statusLabel[check.status]}] ${check.message}`);
    if (check.recommendation)
      lines.push(`  Что сделать: ${check.recommendation}`);
  }
  return lines.join("\n");
}

async function checkGitExclude(
  repositoryRoot: string,
  dependencies: DoctorDependencies,
  checks: DoctorCheck[],
): Promise<void> {
  try {
    const rawPath = (
      await dependencies.runGit(repositoryRoot, [
        "rev-parse",
        "--git-path",
        "info/exclude",
      ])
    ).trim();
    const excludePath = resolve(repositoryRoot, rawPath);
    const exclude = (await dependencies.readText(excludePath)) ?? "";
    const ignored = exclude
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .includes(VISUAL_INTENT_EXCLUDE);
    checks.push(
      ignored
        ? {
            id: "git.exclude",
            status: "pass",
            message: `${VISUAL_INTENT_EXCLUDE} is present in the repository-local Git exclude`,
          }
        : {
            id: "git.exclude",
            status: "warning",
            message: `${VISUAL_INTENT_EXCLUDE} is missing from the repository-local Git exclude`,
            recommendation: `Add ${VISUAL_INTENT_EXCLUDE} to ${excludePath}.`,
          },
    );
  } catch {
    checks.push({
      id: "git.exclude",
      status: "warning",
      message: "Git repository-local exclude could not be inspected",
    });
  }
}

async function checkToolIgnores(
  repositoryRoot: string,
  relevantFiles: string[],
  dependencies: DoctorDependencies,
  checks: DoctorCheck[],
): Promise<DoctorIgnoreRecipe[]> {
  const packageJson =
    (await dependencies.readText(join(repositoryRoot, "package.json"))) ?? "";
  const definitions = [
    {
      tool: "biome" as const,
      names: new Set(["biome.json", "biome.jsonc"]),
      packagePattern: /(?:@biomejs\/biome|\bbiome\b)/u,
      recipe:
        'Biome: add "!.visual-intent" to files.includes (and to formatter/linter includes when those sections override it).',
    },
    {
      tool: "eslint" as const,
      names: new Set([
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.cjs",
        "eslint.config.ts",
        ".eslintrc",
        ".eslintrc.json",
        ".eslintrc.js",
        ".eslintrc.cjs",
        ".eslintignore",
      ]),
      packagePattern: /(?:\beslint\b|typescript-eslint)/u,
      recipe:
        'ESLint: add a global ignore for ".visual-intent/**" (or the same line to .eslintignore for legacy config).',
    },
    {
      tool: "prettier" as const,
      names: new Set([".prettierignore", ".prettierrc", ".prettierrc.json"]),
      packagePattern: /\bprettier\b/u,
      recipe: "Prettier: add .visual-intent/ to .prettierignore.",
    },
  ];

  const recipes: DoctorIgnoreRecipe[] = [];
  for (const definition of definitions) {
    const configPaths = relevantFiles.filter((path) =>
      definition.names.has(basename(path)),
    );
    const detected =
      configPaths.length > 0 || definition.packagePattern.test(packageJson);
    const contents = await Promise.all(
      configPaths.map((path) => dependencies.readText(path)),
    );
    const ignored = detected
      ? contents.some((content, index) =>
          hasExplicitVisualIntentIgnore(
            definition.tool,
            configPaths[index] ?? "",
            content,
          ),
        )
      : undefined;
    const recipe: DoctorIgnoreRecipe = {
      tool: definition.tool,
      detected,
      ignored,
      configPaths,
      recipe: definition.recipe,
    };
    recipes.push(recipe);
    checks.push(
      !detected
        ? {
            id: `tool-ignore.${definition.tool}`,
            status: "skip",
            message: `${definition.tool} was not detected`,
          }
        : ignored
          ? {
              id: `tool-ignore.${definition.tool}`,
              status: "pass",
              message: `${definition.tool} excludes Visual Intent project data`,
            }
          : {
              id: `tool-ignore.${definition.tool}`,
              status: "warning",
              message: `${definition.tool} may inspect or rewrite .visual-intent`,
              recommendation: definition.recipe,
            },
    );
  }
  return recipes;
}

function hasExplicitVisualIntentIgnore(
  tool: DoctorIgnoreRecipe["tool"],
  path: string,
  content: string | undefined,
): boolean {
  if (!content) return false;
  const fileName = basename(path);
  if (tool === "biome") {
    return /["']![^"'\r\n]*\.visual-intent(?:\/\*\*)?\/?["']/u.test(content);
  }
  if (tool === "eslint") {
    if (fileName === ".eslintignore") {
      return content
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .some((line) =>
          /^(?:\*\*\/)?\.visual-intent(?:\/\*\*)?\/?$/u.test(line),
        );
    }
    return /(?:globalIgnores\s*\(|ignores\s*:)[\s\S]{0,240}["'](?:\*\*\/)?\.visual-intent(?:\/\*\*)?\/?["']/u.test(
      content,
    );
  }
  if (fileName !== ".prettierignore") return false;
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => /^(?:\*\*\/)?\.visual-intent(?:\/\*\*)?\/?$/u.test(line));
}

async function checkNextAllowedDevOrigins(
  repositoryRoot: string,
  relevantFiles: string[],
  daemonOrigin: string | undefined,
  dependencies: DoctorDependencies,
  checks: DoctorCheck[],
): Promise<void> {
  const nextConfigs = relevantFiles.filter((path) =>
    /^next\.config\.(?:js|mjs|cjs|ts)$/u.test(basename(path)),
  );
  const packageJson =
    (await dependencies.readText(join(repositoryRoot, "package.json"))) ?? "";
  const detected = nextConfigs.length > 0 || /["']next["']/u.test(packageJson);
  if (!detected) {
    checks.push({
      id: "next.allowed-dev-origins",
      status: "skip",
      message: "Next.js was not detected",
    });
    return;
  }
  const configContents = await Promise.all(
    nextConfigs.map((path) => dependencies.readText(path)),
  );
  const daemonHost = daemonOrigin ? new URL(daemonOrigin).hostname : undefined;
  const configured = configContents.some(
    (content) =>
      content?.includes("allowedDevOrigins") &&
      (!daemonHost || content.includes(daemonHost)),
  );
  checks.push(
    configured
      ? {
          id: "next.allowed-dev-origins",
          status: "pass",
          message:
            "Next.js allowedDevOrigins includes the Visual Intent proxy host",
        }
      : {
          id: "next.allowed-dev-origins",
          status: "warning",
          message:
            "Next.js dev-origin allowance was not found for the proxy host",
          recommendation: `Add allowedDevOrigins: ["127.0.0.1", "localhost"] to the relevant next.config file${daemonHost ? ` (current proxy host: ${daemonHost})` : ""}.`,
        },
  );
}

function parseConnection(serialized: string): StoredConnection {
  try {
    return JSON.parse(serialized) as StoredConnection;
  } catch {
    return {};
  }
}

function isValidConnection(connection: StoredConnection): connection is {
  protocolVersion: string;
  daemonUrl: string;
  apiToken: string;
  projectKey: string;
  repositoryRoot: string;
  sessionId: string;
  daemonInstanceId: string;
} {
  return [
    connection.protocolVersion,
    connection.daemonUrl,
    connection.apiToken,
    connection.projectKey,
    connection.repositoryRoot,
    connection.sessionId,
    connection.daemonInstanceId,
  ].every((value) => typeof value === "string" && value.length > 0);
}

function safeConnectionSummary(
  connection: StoredConnection,
): Omit<DoctorConnectionSummary, "path"> {
  return {
    ...(typeof connection.daemonUrl === "string"
      ? { daemonUrl: connection.daemonUrl }
      : {}),
    ...(typeof connection.projectKey === "string"
      ? { projectKey: connection.projectKey }
      : {}),
    ...(typeof connection.repositoryRoot === "string"
      ? { repositoryRoot: connection.repositoryRoot }
      : {}),
    ...(typeof connection.sessionId === "string"
      ? { sessionId: connection.sessionId }
      : {}),
    ...(typeof connection.daemonInstanceId === "string"
      ? { daemonInstanceId: connection.daemonInstanceId }
      : {}),
    ...(typeof connection.protocolVersion === "string"
      ? { protocolVersion: connection.protocolVersion }
      : {}),
  };
}

function loopbackOrigin(rawUrl: string): string | undefined {
  const url = loopbackHttpUrl(rawUrl);
  if (
    !url ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  return url.origin;
}

function loopbackHttpUrl(rawUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "http:" ||
      !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname)
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
  apiToken: string,
  timeoutMs: number,
): Promise<
  | { ok: true; body: unknown; errorCode: "NONE" }
  | { ok: false; body?: undefined; errorCode: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetcher(url, {
      headers: { "x-visual-intent-token": apiToken },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, errorCode: `HTTP_${response.status}` };
    }
    return { ok: true, body: await response.json(), errorCode: "NONE" };
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof DOMException && error.name === "AbortError"
          ? "TIMEOUT"
          : "UNREACHABLE",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseHealth(value: unknown): HealthDocument {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.protocolVersion === "string"
      ? { protocolVersion: value.protocolVersion }
      : {}),
    ...(typeof value.daemonInstanceId === "string"
      ? { daemonInstanceId: value.daemonInstanceId }
      : {}),
    ...(isRecord(value.session)
      ? { session: value.session as unknown as ProjectSession }
      : {}),
  };
}

function safeHealthSummary(
  health: HealthDocument,
): DoctorRuntimeSummary["health"] {
  return {
    ...(health.protocolVersion
      ? { protocolVersion: health.protocolVersion }
      : {}),
    ...(health.daemonInstanceId
      ? { daemonInstanceId: health.daemonInstanceId }
      : {}),
    ...(health.session
      ? {
          sessionId: health.session.id,
          projectKey: health.session.projectKey,
          repositoryRoot: health.session.repository?.root,
          targetUrl: health.session.targetUrl,
          proxyUrl: health.session.proxyUrl,
          executor: health.session.executor,
        }
      : {}),
  };
}

function addRuntimeIdentityChecks(
  checks: DoctorCheck[],
  repositoryRoot: string,
  connection: {
    protocolVersion: string;
    projectKey: string;
    sessionId: string;
    daemonInstanceId: string;
  },
  health: HealthDocument,
): void {
  const identities = [
    {
      id: "runtime.protocol",
      expected: connection.protocolVersion,
      actual: health.protocolVersion,
      label: "protocol version",
    },
    {
      id: "runtime.instance",
      expected: connection.daemonInstanceId,
      actual: health.daemonInstanceId,
      label: "daemon instance",
    },
    {
      id: "runtime.session",
      expected: connection.sessionId,
      actual: health.session?.id,
      label: "project session",
    },
    {
      id: "runtime.project",
      expected: connection.projectKey,
      actual: health.session?.projectKey,
      label: "project key",
    },
    {
      id: "runtime.repository",
      expected: repositoryRoot,
      actual: health.session?.repository?.root,
      label: "repository root",
    },
  ];
  for (const identity of identities) {
    checks.push(
      identity.actual === identity.expected
        ? {
            id: identity.id,
            status: "pass",
            message: `Runtime ${identity.label} matches the connection`,
          }
        : {
            id: identity.id,
            status: "fail",
            message: `Runtime ${identity.label} does not match the connection`,
            recommendation:
              "Restart Visual Intent and use the newly written connection file.",
          },
    );
  }
}

function addExecutorCheck(
  checks: DoctorCheck[],
  executor: ProjectSession["executor"] | undefined,
): void {
  if (!executor) {
    checks.push({
      id: "runtime.executor",
      status: "fail",
      message: "Runtime executor information is missing",
    });
    return;
  }
  checks.push({
    id: "runtime.executor",
    status:
      executor.status === "error" || executor.status === "disconnected"
        ? "warning"
        : "pass",
    message: `Executor is ${executor.kind} (${executor.ownership}, ${executor.status})`,
    ...(executor.lastError ? { recommendation: executor.lastError } : {}),
  });
}

function isRuntimeDiagnosticsSnapshot(
  value: unknown,
): value is RuntimeDiagnosticsSnapshot {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isRecord(value.daemon) || !isRecord(value.target)) return false;
  return (
    typeof value.daemon.instanceId === "string" &&
    typeof value.daemon.startedAt === "string" &&
    typeof value.target.origin === "string" &&
    typeof value.target.reachable === "boolean" &&
    Array.isArray(value.recentEvents)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createReport(input: Omit<DoctorReport, "summary">): DoctorReport {
  const summary: Record<DoctorCheckStatus, number> = {
    pass: 0,
    warning: 0,
    fail: 0,
    skip: 0,
  };
  for (const check of input.checks) summary[check.status] += 1;
  return { ...input, summary };
}

function defaultIgnoreRecipes(): DoctorIgnoreRecipe[] {
  return [
    {
      tool: "biome",
      detected: false,
      ignored: undefined,
      configPaths: [],
      recipe: 'Biome: add "!.visual-intent" to files.includes.',
    },
    {
      tool: "eslint",
      detected: false,
      ignored: undefined,
      configPaths: [],
      recipe: 'ESLint: add a global ignore for ".visual-intent/**".',
    },
    {
      tool: "prettier",
      detected: false,
      ignored: undefined,
      configPaths: [],
      recipe: "Prettier: add .visual-intent/ to .prettierignore.",
    },
  ];
}

async function listRelevantFiles(repositoryRoot: string): Promise<string[]> {
  const results: string[] = [];
  const ignoredDirectories = new Set([
    ".git",
    ".visual-intent",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
  ]);
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) await visit(path, depth + 1);
          return;
        }
        if (
          entry.isFile() &&
          /^(?:biome\.jsonc?|eslint\.config\.(?:js|mjs|cjs|ts)|\.eslintrc(?:\.(?:json|js|cjs))?|\.eslintignore|\.prettierignore|\.prettierrc(?:\.json)?|next\.config\.(?:js|mjs|cjs|ts))$/u.test(
            entry.name,
          )
        ) {
          results.push(path);
        }
      }),
    );
  };
  await visit(repositoryRoot, 0);
  return results.sort();
}
