#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import {
  FileTaskStore,
  captureGitWorkingTreeBaseline,
} from "@visual-intent/file-store";
import { runMcpServer } from "@visual-intent/mcp-server";

import { startDaemon } from "./daemon.js";
import { CodexDispatcher } from "./dispatcher.js";
import { projectTaskStorePath } from "./project-storage.js";
import { ProjectAttachmentStore } from "./attachment-store.js";
import {
  registerBridgeSession,
  unregisterBridgeSession,
} from "./bridge-registry.js";
import { startBridge } from "./bridge.js";
import { loadOrCreateApiToken } from "./connection-token.js";
import {
  buildMetrics,
  formatMetricsCsv,
  formatMetricsTable,
  parseSince,
} from "./metrics.js";
import {
  captureProjectContext,
  ensureProjectContext,
  readProjectContext,
} from "./project-context.js";
import { resetProjectHistory } from "./reset-history.js";
import { acquireProjectWorkerLease } from "./worker-lease.js";

const execFileAsync = promisify(execFile);
const program = new Command();

program
  .name("visual-intent")
  .description("Capture visual change requests from a local development server")
  .version("0.1.0");

program
  .command("start")
  .description("Start the local reverse proxy, overlay, and task API")
  .requiredOption("--target <url>", "localhost development server to proxy")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <port>", "port to bind", "7310")
  .option(
    "--repo <path>",
    "repository to edit and store local Visual Intent data in",
    process.cwd(),
  )
  .option("--project <key>", "stable project key")
  .option("--name <name>", "project name shown in the overlay")
  .option(
    "--executor <mode>",
    "executor mode: preserve, disconnected or isolated-worker",
    "preserve",
  )
  .option(
    "--worker-thread <id>",
    "Visual Intent-owned Codex SDK thread to resume",
  )
  .option(
    "--allow-dirty",
    "allow Codex to work when the target repository is already dirty",
    false,
  )
  .action(
    async (options: {
      target: string;
      host: string;
      port: string;
      repo: string;
      project?: string;
      name?: string;
      executor: string;
      workerThread?: string;
      allowDirty: boolean;
    }) => {
      const port = Number.parseInt(options.port, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("Port must be an integer between 0 and 65535");
      }
      if (
        options.host !== "127.0.0.1" &&
        options.host !== "::1" &&
        options.host !== "localhost"
      ) {
        throw new Error("MVP only binds to a local loopback host");
      }

      const repositoryRoot = await realpath(resolve(options.repo));
      const storePath = projectTaskStorePath(repositoryRoot);
      if (
        options.executor !== "preserve" &&
        options.executor !== "disconnected" &&
        options.executor !== "isolated-worker"
      ) {
        throw new Error(
          "Executor must be preserve, disconnected or isolated-worker",
        );
      }
      if (options.workerThread && options.executor !== "isolated-worker") {
        throw new Error("--worker-thread requires --executor isolated-worker");
      }
      const repository = {
        root: repositoryRoot,
        name: basename(repositoryRoot),
      };
      const projectKey = options.project ?? repository.name;
      const displayName = options.name ?? projectKey;
      const connectionDirectory = join(repositoryRoot, ".visual-intent");
      const connectionPath = join(connectionDirectory, "connection.json");
      await ensureLocalGitExclude(repositoryRoot);
      await mkdir(connectionDirectory, { recursive: true });
      const apiToken = await loadOrCreateApiToken(connectionPath, {
        projectKey,
        repositoryRoot,
      });
      const store = new FileTaskStore(storePath, repository, {
        allowDirty: options.allowDirty,
        captureWorkingTreeBaseline: () =>
          captureGitWorkingTreeBaseline(repositoryRoot),
        captureProjectContext: () => captureProjectContext(repositoryRoot),
      });
      const existingSession = await store.getSession();
      const activeExistingWorker =
        existingSession?.executor.ownership === "visual-intent-owned"
          ? existingSession.executor
          : undefined;
      const persistedWorker =
        existingSession?.sdkWorker ??
        (activeExistingWorker
          ? {
              kind: "codex" as const,
              ownership: "visual-intent-owned" as const,
              source: activeExistingWorker.source ?? ("generated" as const),
              ...(activeExistingWorker.threadId
                ? { threadId: activeExistingWorker.threadId }
                : {}),
              ...(activeExistingWorker.attachedAt
                ? { attachedAt: activeExistingWorker.attachedAt }
                : {}),
            }
          : undefined);
      const candidateWorkerThreadId =
        options.workerThread ?? persistedWorker?.threadId;
      if (
        candidateWorkerThreadId &&
        candidateWorkerThreadId === existingSession?.controller?.threadId
      ) {
        if (!options.workerThread) {
          console.log(
            "The stored SDK worker matches the controller; Visual Intent will create a separate autonomous thread.",
          );
        } else {
          throw new Error(
            "The autonomous SDK worker must use a different Codex thread than the attached controller",
          );
        }
      }
      const workerThreadId =
        candidateWorkerThreadId === existingSession?.controller?.threadId
          ? undefined
          : candidateWorkerThreadId;
      const contextPath = await ensureProjectContext(
        repositoryRoot,
        displayName,
      );
      const usesAutonomousWorker =
        options.executor === "isolated-worker" ||
        activeExistingWorker !== undefined;
      const workerLease = usesAutonomousWorker
        ? await acquireProjectWorkerLease(repositoryRoot)
        : undefined;
      let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
      let bridgeRegistration:
        | Awaited<ReturnType<typeof registerBridgeSession>>
        | undefined;
      try {
        if (workerLease) {
          const recovered = await store.recoverInterruptedBatches();
          if (recovered.length > 0) {
            console.log(
              `Recovered ${recovered.length} interrupted SDK Apply batch(es); review partial changes before Retry.`,
            );
          }
        }
        await store.configureSession({
          projectKey,
          displayName,
          repository,
          targetUrl: options.target,
          proxyUrl: `http://${options.host}:${port}`,
          ...(options.executor === "isolated-worker"
            ? {
                sdkWorker: {
                  kind: "codex" as const,
                  ownership: "visual-intent-owned" as const,
                  source: options.workerThread
                    ? ("cli" as const)
                    : (persistedWorker?.source ?? ("generated" as const)),
                  ...(workerThreadId ? { threadId: workerThreadId } : {}),
                  ...(workerThreadId
                    ? {
                        attachedAt:
                          options.workerThread || !persistedWorker?.attachedAt
                            ? new Date().toISOString()
                            : persistedWorker.attachedAt,
                      }
                    : {}),
                },
                executor: {
                  kind: "codex" as const,
                  status:
                    !options.workerThread &&
                    activeExistingWorker?.status !== "busy"
                      ? (activeExistingWorker?.status ?? ("connected" as const))
                      : ("connected" as const),
                  ownership: "visual-intent-owned" as const,
                  source: options.workerThread
                    ? ("cli" as const)
                    : (persistedWorker?.source ?? ("generated" as const)),
                  ...(workerThreadId
                    ? {
                        threadId: workerThreadId,
                        attachedAt:
                          options.workerThread || !persistedWorker?.attachedAt
                            ? new Date().toISOString()
                            : persistedWorker.attachedAt,
                      }
                    : {}),
                },
              }
            : options.executor === "disconnected"
              ? {
                  executor: {
                    kind: "disconnected" as const,
                    status: "disconnected" as const,
                    ownership: "host-attached" as const,
                  },
                }
              : {}),
        });
        daemon = await startDaemon({
          host: options.host,
          port,
          target: options.target,
          store,
          attachmentStore: new ProjectAttachmentStore(repositoryRoot),
          apiToken,
          createDispatcher: (onChanged) =>
            new CodexDispatcher({
              store,
              loadProjectContext: () => readProjectContext(repositoryRoot),
              onChanged,
            }),
        });
        const daemonUrl = `http://${daemon.host}:${daemon.port}`;
        const session = await store.configureSession({
          projectKey,
          displayName,
          repository,
          targetUrl: daemon.target,
          proxyUrl: daemonUrl,
        });
        await writeFile(
          connectionPath,
          `${JSON.stringify(
            {
              protocolVersion: "0.1",
              daemonUrl,
              apiToken,
              projectKey,
              repositoryRoot,
              taskStorePath: storePath,
              projectContextPath: contextPath,
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        await chmod(connectionPath, 0o600);
        bridgeRegistration = await registerBridgeSession(
          session,
          daemonUrl,
          apiToken,
        );

        console.log(`Visual Intent: ${daemonUrl}`);
        console.log(`Proxy target:  ${daemon.target}`);
        console.log(`Task store:    ${storePath}`);
        console.log(`Agent repo:    ${repositoryRoot}`);
        console.log(`Project:       ${session.displayName}`);
        console.log(`Context:       ${contextPath}`);
        console.log(
          `Executor:      ${session.executor.kind} (${session.executor.ownership}, ${session.executor.status})`,
        );
        if (session.controller) {
          console.log(`Controller:    Codex ${session.controller.threadId}`);
        }
        console.log(`Connection:    ${connectionPath}`);
        console.log("Press Ctrl+C to stop.");

        await new Promise<void>((done) => {
          const stop = (): void => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            done();
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        });
      } finally {
        try {
          await daemon?.close();
        } finally {
          try {
            if (bridgeRegistration) {
              await unregisterBridgeSession(bridgeRegistration);
            }
          } finally {
            await workerLease?.release();
          }
        }
      }
    },
  );

program
  .command("attach")
  .description("Attach a Codex thread to a running Visual Intent project")
  .option("--daemon <url>", "Visual Intent daemon URL", "http://127.0.0.1:7310")
  .option("--repo <path>", "project repository", process.cwd())
  .option(
    "--thread <id>",
    "Codex thread id",
    process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID,
  )
  .action(
    async (options: { daemon: string; repo: string; thread?: string }) => {
      if (!options.thread) {
        throw new Error(
          "Codex thread id is required. Run inside Codex or pass --thread.",
        );
      }
      const repositoryRoot = await realpath(resolve(options.repo));
      const connection = JSON.parse(
        await readFile(
          join(repositoryRoot, ".visual-intent", "connection.json"),
          "utf8",
        ),
      ) as { apiToken: string };
      const response = await fetch(
        `${options.daemon.replace(/\/$/, "")}/_visual-intent/api/session/attach`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-visual-intent-token": connection.apiToken,
          },
          body: JSON.stringify({
            repositoryRoot,
            threadId: options.thread,
            ownership: "host-attached",
            source: "cli",
          }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? `HTTP ${response.status}`);
      console.log(
        `Attached Codex thread ${options.thread} to ${repositoryRoot}`,
      );
    },
  );

program
  .command("bridge")
  .description("Run the local bridge for the unpacked Chrome extension")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <port>", "port to bind", "7309")
  .action(async (options: { host: string; port: string }) => {
    const port = Number.parseInt(options.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("Port must be an integer between 0 and 65535");
    }
    const bridge = await startBridge({
      host: options.host,
      port,
    });
    console.log(`Visual Intent Bridge: http://${bridge.host}:${bridge.port}`);
    console.log(`Chrome pairing code:  ${bridge.pairingCode}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise<void>((done) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        done();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    await bridge.close();
  });

program
  .command("reset")
  .description("Permanently reset local Visual Intent history for one project")
  .requiredOption("--repo <path>", "exact project repository to reset")
  .requiredOption(
    "--yes",
    "confirm deletion of tasks, batches, analytics, and attachments",
  )
  .action(async (options: { repo: string; yes: boolean }) => {
    const result = await resetProjectHistory({
      repo: options.repo,
      confirmed: options.yes,
    });
    console.log(`Visual Intent history reset: ${result.repositoryRoot}`);
    console.log(
      `Deleted: ${result.tasks} task(s), ${result.batches} batch(es), ${result.executionOutbox} pending execution receipt(s), ${result.events} event(s), ${result.executions} execution(s), ${result.attachmentFiles} attachment file(s).`,
    );
    console.log(
      "Preserved: project session, settings, connection, context, launch configuration, and repository files.",
    );
  });

program
  .command("metrics")
  .description("Show privacy-safe local Visual Intent product analytics")
  .option("--repo <path>", "project repository", process.cwd())
  .option("--since <period>", "ISO date, Nd, or Nh")
  .option("--format <format>", "table, json, or csv", "table")
  .option("--output <path>", "write the report to a file")
  .action(
    async (options: {
      repo: string;
      since?: string;
      format: string;
      output?: string;
    }) => {
      if (!new Set(["table", "json", "csv"]).has(options.format)) {
        throw new Error("--format must be table, json, or csv");
      }
      const repositoryRoot = await realpath(resolve(options.repo));
      const store = new FileTaskStore(projectTaskStorePath(repositoryRoot), {
        root: repositoryRoot,
        name: basename(repositoryRoot),
      });
      const since = parseSince(options.since);
      const [tasks, batches, executions, events] = await Promise.all([
        store.list(),
        store.listBatches(),
        store.listExecutions(since ? { since } : undefined),
        store.listEvents(since ? { since } : undefined),
      ]);
      const report = buildMetrics({
        tasks,
        batches,
        executions,
        events,
        ...(since ? { since } : {}),
      });
      const body =
        options.format === "json"
          ? `${JSON.stringify(report, null, 2)}\n`
          : options.format === "csv"
            ? `${formatMetricsCsv(report.executions)}\n`
            : `${formatMetricsTable(report.summary)}\n`;
      if (options.output) {
        const outputPath = resolve(options.output);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, body, "utf8");
        console.log(`Visual Intent metrics: ${outputPath}`);
      } else {
        process.stdout.write(body);
      }
    },
  );

program
  .command("mcp")
  .description("Run the coding-agent bridge over MCP stdio")
  .option("--store <path>", "local task file", ".visual-intent/tasks.json")
  .option("--repo <path>", "project repository for Git baseline checks")
  .action(async (options: { store: string; repo?: string }) => {
    const repositoryRoot = options.repo
      ? await realpath(resolve(options.repo))
      : undefined;
    const store = new FileTaskStore(
      resolve(options.store),
      repositoryRoot
        ? { root: repositoryRoot, name: basename(repositoryRoot) }
        : undefined,
      repositoryRoot
        ? {
            captureWorkingTreeBaseline: () =>
              captureGitWorkingTreeBaseline(repositoryRoot),
          }
        : {},
    );
    const session = await store.getSession();
    if (
      repositoryRoot &&
      session &&
      session.repository.root !== repositoryRoot
    ) {
      throw new Error(
        `MCP store belongs to ${session.repository.root}, not ${repositoryRoot}`,
      );
    }
    await runMcpServer(store);
  });

await program.parseAsync();

async function ensureLocalGitExclude(repositoryRoot: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "rev-parse", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    );
    const rawPath = stdout.trim();
    if (!rawPath) return;
    const excludePath = resolve(repositoryRoot, rawPath);
    const pattern = "/.visual-intent/";
    const existing = await readFile(excludePath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    if (
      existing
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .includes(pattern)
    ) {
      return;
    }
    await mkdir(dirname(excludePath), { recursive: true });
    const separator =
      existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${separator}${pattern}\n`, "utf8");
  } catch {
    // Non-Git projects can still use capture; their connection file remains local.
  }
}
