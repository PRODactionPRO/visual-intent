import { resolve } from "node:path";

import type { Command } from "commander";

import type { LaunchAgentPaths } from "./launch-agent.js";
import {
  createServiceConfig,
  type VisualIntentServiceConfig,
} from "./service-config.js";
import {
  ServiceManager,
  type ServiceMutationOptions,
  type ServiceStatus,
  type ServiceUninstallResult,
} from "./service-manager.js";

export interface ServiceController {
  install(
    config: VisualIntentServiceConfig,
    options?: ServiceMutationOptions,
  ): Promise<ServiceStatus>;
  start(
    repositoryRoot: string,
    options?: ServiceMutationOptions,
  ): Promise<ServiceStatus>;
  stop(
    repositoryRoot: string,
    options?: ServiceMutationOptions,
  ): Promise<ServiceStatus>;
  restart(
    repositoryRoot: string,
    options?: ServiceMutationOptions,
  ): Promise<ServiceStatus>;
  status(repositoryRoot: string): Promise<ServiceStatus>;
  uninstall(
    repositoryRoot: string,
    options?: ServiceMutationOptions,
  ): Promise<ServiceUninstallResult>;
  logs(repositoryRoot: string): Promise<LaunchAgentPaths>;
}

export interface RegisterServiceCommandsOptions {
  manager?: ServiceController;
  nodePath?: string;
  cliPath?: string;
  cwd?: () => string;
  log?: (message: string) => void;
}

export function registerServiceCommands(
  program: Command,
  options: RegisterServiceCommandsOptions = {},
): Command {
  const manager = options.manager ?? new ServiceManager();
  const cwd = options.cwd ?? (() => process.cwd());
  const log = options.log ?? ((message: string) => console.log(message));
  const service = program
    .command("service")
    .description("Manage a persistent per-project macOS LaunchAgent proxy");

  service
    .command("install")
    .description("Install and start the Visual Intent proxy LaunchAgent")
    .requiredOption("--target <url>", "localhost development server to proxy")
    .option("--repo <path>", "project repository", cwd())
    .option("--host <host>", "loopback host", "127.0.0.1")
    .option("--port <port>", "proxy port", "7310")
    .option("--project <key>", "stable project key")
    .option("--name <name>", "project name shown in the overlay")
    .option(
      "--executor <mode>",
      "preserve, disconnected, or isolated-worker",
      "preserve",
    )
    .option("--worker-thread <id>", "isolated Codex SDK worker thread")
    .option("--allow-dirty", "allow work over existing changes", false)
    .option(
      "--force",
      "install even when saved Apply state is active, after checking the project",
      false,
    )
    .option(
      "--force-recover-stale-worker",
      "recover a dead SDK worker lease only after checking for orphaned Codex processes",
      false,
    )
    .action(
      async (commandOptions: {
        target: string;
        repo: string;
        host: string;
        port: string;
        project?: string;
        name?: string;
        executor: string;
        workerThread?: string;
        allowDirty: boolean;
        force: boolean;
        forceRecoverStaleWorker: boolean;
      }) => {
        const cliPath = resolveCliPath(options.cliPath);
        const config = await createServiceConfig({
          repositoryRoot: commandOptions.repo,
          target: commandOptions.target,
          host: commandOptions.host,
          port: parsePort(commandOptions.port),
          projectKey: commandOptions.project,
          displayName: commandOptions.name,
          executor: commandOptions.executor,
          workerThread: commandOptions.workerThread,
          allowDirty: commandOptions.allowDirty,
          nodePath: resolve(options.nodePath ?? process.execPath),
          cliPath,
          environmentPath: process.env.PATH,
          codexHome: process.env.CODEX_HOME,
        });
        const status = await manager.install(config, {
          force: commandOptions.force,
          forceRecoverStaleWorker: commandOptions.forceRecoverStaleWorker,
        });
        log(`Visual Intent service installed: ${status.label}`);
        log(`Proxy:  ${status.proxyUrl}`);
        log(`Target: ${status.target}`);
        log(
          "The target development server is not managed by Visual Intent; keep it running separately.",
        );
      },
    );

  service
    .command("start")
    .description("Start an installed Visual Intent LaunchAgent")
    .option("--repo <path>", "project repository", cwd())
    .option(
      "--force",
      "kickstart a loaded stopped service even when Apply state is active",
      false,
    )
    .option(
      "--force-recover-stale-worker",
      "recover a dead SDK worker lease only after checking for orphaned Codex processes",
      false,
    )
    .action(
      async (commandOptions: {
        repo: string;
        force: boolean;
        forceRecoverStaleWorker: boolean;
      }) => {
        printStatus(
          await manager.start(commandOptions.repo, {
            force: commandOptions.force,
            forceRecoverStaleWorker: commandOptions.forceRecoverStaleWorker,
          }),
          log,
        );
      },
    );

  service
    .command("stop")
    .description("Stop the proxy without deleting project data")
    .option("--repo <path>", "project repository", cwd())
    .option("--force", "stop even when an Apply batch is active", false)
    .action(async (commandOptions: { repo: string; force: boolean }) => {
      printStatus(
        await manager.stop(commandOptions.repo, {
          force: commandOptions.force,
        }),
        log,
      );
    });

  service
    .command("restart")
    .description("Restart the proxy without managing the target dev server")
    .option("--repo <path>", "project repository", cwd())
    .option("--force", "restart even when an Apply batch is active", false)
    .option(
      "--force-recover-stale-worker",
      "recover a dead SDK worker lease only after checking for orphaned Codex processes",
      false,
    )
    .action(
      async (commandOptions: {
        repo: string;
        force: boolean;
        forceRecoverStaleWorker: boolean;
      }) => {
        printStatus(
          await manager.restart(commandOptions.repo, {
            force: commandOptions.force,
            forceRecoverStaleWorker: commandOptions.forceRecoverStaleWorker,
          }),
          log,
        );
      },
    );

  service
    .command("status")
    .description("Show LaunchAgent and Apply activity status")
    .option("--repo <path>", "project repository", cwd())
    .action(async (commandOptions: { repo: string }) => {
      printStatus(await manager.status(commandOptions.repo), log);
    });

  service
    .command("uninstall")
    .description("Remove the LaunchAgent but preserve project history and logs")
    .option("--repo <path>", "project repository", cwd())
    .option("--force", "uninstall even when an Apply batch is active", false)
    .action(async (commandOptions: { repo: string; force: boolean }) => {
      const result = await manager.uninstall(commandOptions.repo, {
        force: commandOptions.force,
      });
      log(`Visual Intent service uninstalled: ${result.label}`);
      log(`Preserved service config: ${result.preservedServiceConfig}`);
      log(`Preserved logs: ${result.preservedLogs.join(", ")}`);
      log(
        "Tasks, attachments, usage, settings, context, and repository files were preserved.",
      );
    });

  service
    .command("logs")
    .description("Show the persistent LaunchAgent log paths")
    .option("--repo <path>", "project repository", cwd())
    .action(async (commandOptions: { repo: string }) => {
      const paths = await manager.logs(commandOptions.repo);
      log(`stdout: ${paths.standardOutputPath}`);
      log(`stderr: ${paths.standardErrorPath}`);
    });

  return service;
}

function resolveCliPath(explicitPath?: string): string {
  const candidate = explicitPath ?? process.argv[1];
  if (!candidate) {
    throw new Error(
      "Cannot determine the Visual Intent CLI entrypoint for LaunchAgent installation",
    );
  }
  return resolve(candidate);
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (
    !Number.isInteger(port) ||
    String(port) !== value ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Service port must be an integer between 1 and 65535");
  }
  return port;
}

function printStatus(
  status: ServiceStatus,
  log: (message: string) => void,
): void {
  const lifecycle = status.running
    ? `running (PID ${status.pid ?? "unknown"})`
    : status.loaded
      ? "loaded"
      : status.installed
        ? "installed, stopped"
        : "not installed";
  log(`Visual Intent service: ${lifecycle}`);
  log(`Label: ${status.label}`);
  log(`Proxy: ${status.proxyUrl}`);
  log(`Target: ${status.target}`);
  if (status.busyApply) {
    log(`Active Apply: ${status.busyBatchIds.join(", ")}`);
  }
  if (status.applyStateWarning) {
    log(`Apply state warning: ${status.applyStateWarning}`);
  }
}
