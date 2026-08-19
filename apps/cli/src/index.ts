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
    "executor mode: disconnected or isolated-worker",
    "disconnected",
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
        options.executor !== "disconnected" &&
        options.executor !== "isolated-worker"
      ) {
        throw new Error("Executor must be disconnected or isolated-worker");
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
      });
      await store.configureSession({
        projectKey,
        displayName,
        repository,
        targetUrl: options.target,
        proxyUrl: `http://${options.host}:${port}`,
        ...(options.executor === "isolated-worker"
          ? {
              executor: {
                kind: "codex" as const,
                status: "connected" as const,
                ownership: "visual-intent-owned" as const,
                source: options.workerThread
                  ? ("cli" as const)
                  : ("generated" as const),
                ...(options.workerThread
                  ? {
                      threadId: options.workerThread,
                      attachedAt: new Date().toISOString(),
                    }
                  : {}),
              },
            }
          : {}),
      });
      const daemon = await startDaemon({
        host: options.host,
        port,
        target: options.target,
        store,
        attachmentStore: new ProjectAttachmentStore(repositoryRoot),
        apiToken,
        createDispatcher: (onChanged) =>
          new CodexDispatcher({
            store,
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
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(connectionPath, 0o600);
      const bridgeRegistration = await registerBridgeSession(
        session,
        daemonUrl,
        apiToken,
      );

      console.log(`Visual Intent: ${daemonUrl}`);
      console.log(`Proxy target:  ${daemon.target}`);
      console.log(`Task store:    ${storePath}`);
      console.log(`Agent repo:    ${repositoryRoot}`);
      console.log(`Project:       ${session.displayName}`);
      console.log(
        `Executor:      ${session.executor.kind} (${session.executor.ownership}, ${session.executor.status})`,
      );
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
      try {
        await daemon.close();
      } finally {
        await unregisterBridgeSession(bridgeRegistration);
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
  .command("mcp")
  .description("Run the coding-agent bridge over MCP stdio")
  .option("--store <path>", "local task file", ".visual-intent/tasks.json")
  .option("--repo <path>", "project repository for Git baseline checks")
  .action(async (options: { store: string; repo?: string }) => {
    const repositoryRoot = options.repo
      ? await realpath(resolve(options.repo))
      : undefined;
    await runMcpServer(
      new FileTaskStore(
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
      ),
    );
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
