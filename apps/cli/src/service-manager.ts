import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, platform as currentPlatform, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { formatLoopbackHost, formatLoopbackOrigin } from "./loopback-origin.js";
import {
  acquireProjectServiceOperationLease,
  readLiveProjectDaemonLeaseOwner,
  type LiveProjectDaemonLeaseOwner,
} from "./project-daemon-lease.js";
import {
  ConnectionProjectDaemonProbe,
  type ProjectDaemonIdentity,
  type ProjectDaemonProbe,
} from "./project-daemon-probe.js";
import { forceRecoverStaleProjectWorkerLease } from "./worker-lease.js";
import {
  launchAgentPaths,
  readLaunchAgentBinding,
  writeLaunchAgentPlist,
  type LaunchAgentPaths,
} from "./launch-agent.js";
import {
  assertServiceLabel,
  SERVICE_LABEL_PREFIX,
  readServiceConfig,
  serviceConfigPath,
  writeServiceConfig,
  type VisualIntentServiceConfig,
} from "./service-config.js";

const LAUNCHCTL_PATH = "/bin/launchctl";
const ACTIVE_BATCH_STATUSES = new Set([
  "waiting_for_executor",
  "queued",
  "in_progress",
]);

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(
    executable: string,
    argumentsList: readonly string[],
  ): Promise<ProcessResult>;
}

export interface PortInspector {
  isAvailable(host: string, port: number): Promise<boolean>;
}

export interface ServiceManagerOptions {
  processRunner?: ProcessRunner;
  portInspector?: PortInspector;
  homeDirectory?: string;
  userId?: number;
  platform?: NodeJS.Platform;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
  projectDaemonProbe?: ProjectDaemonProbe;
  projectDaemonLeaseOwner?: (
    repositoryRoot: string,
  ) => Promise<LiveProjectDaemonLeaseOwner | undefined>;
}

export interface ServiceMutationOptions {
  force?: boolean;
  forceRecoverStaleWorker?: boolean;
}

export interface ServiceStatus {
  label: string;
  repositoryRoot: string;
  target: string;
  proxyUrl: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid?: number;
  busyApply: boolean;
  busyBatchIds: string[];
  applyStateWarning?: string;
  plistPath: string;
  standardOutputPath: string;
  standardErrorPath: string;
}

export interface ServiceUninstallResult {
  label: string;
  stopped: boolean;
  removedPlist: boolean;
  removedDerivedState: string[];
  preservedServiceConfig: string;
  preservedLogs: string[];
}

interface ApplyActivity {
  busy: boolean;
  batchIds: string[];
  warning?: string;
}

export class ServiceManager {
  private readonly processRunner: ProcessRunner;
  private readonly portInspector: PortInspector;
  private readonly homeDirectory: string;
  private readonly userId: number;
  private readonly platform: NodeJS.Platform;
  private readonly readinessAttempts: number;
  private readonly readinessIntervalMs: number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly projectDaemonProbe: ProjectDaemonProbe;
  private readonly projectDaemonLeaseOwner: (
    repositoryRoot: string,
  ) => Promise<LiveProjectDaemonLeaseOwner | undefined>;

  constructor(options: ServiceManagerOptions = {}) {
    this.processRunner = options.processRunner ?? new ExecFileProcessRunner();
    this.portInspector = options.portInspector ?? new TcpPortInspector();
    this.homeDirectory = resolve(options.homeDirectory ?? homedir());
    this.userId = options.userId ?? userInfo().uid;
    this.platform = options.platform ?? currentPlatform();
    this.readinessAttempts = positiveInteger(
      options.readinessAttempts ?? 20,
      "readinessAttempts",
    );
    this.readinessIntervalMs = nonNegativeInteger(
      options.readinessIntervalMs ?? 250,
      "readinessIntervalMs",
    );
    this.delay = options.delay ?? sleep;
    this.projectDaemonProbe =
      options.projectDaemonProbe ?? new ConnectionProjectDaemonProbe();
    this.projectDaemonLeaseOwner =
      options.projectDaemonLeaseOwner ?? readLiveProjectDaemonLeaseOwner;
  }

  async install(
    config: VisualIntentServiceConfig,
    options: ServiceMutationOptions = {},
  ): Promise<ServiceStatus> {
    this.assertMacOs();
    assertServiceLabel(config.label);
    const operationLease = await acquireProjectServiceOperationLease(
      config.repositoryRoot,
    );
    try {
      return await this.installLocked(config, options);
    } finally {
      await operationLease.release();
    }
  }

  private async installLocked(
    config: VisualIntentServiceConfig,
    options: ServiceMutationOptions,
  ): Promise<ServiceStatus> {
    await this.assertNoLiveProjectDaemon(
      config,
      "installing the background service",
    );
    await this.assertNoBusyApply(config, options.force ?? false);
    await assertServiceProgramAvailable(config);
    let previousConfig: VisualIntentServiceConfig | undefined;
    if (await pathExists(serviceConfigPath(config.repositoryRoot))) {
      previousConfig = await readServiceConfig(config.repositoryRoot);
      if (previousConfig.label !== config.label) {
        const previousPaths = launchAgentPaths(
          this.homeDirectory,
          previousConfig.label,
        );
        const previousStatus = await this.statusByConfig(
          previousConfig,
          previousPaths,
        );
        if (previousStatus.installed || previousStatus.loaded) {
          throw new Error(
            `Repository already has Visual Intent service ${previousConfig.label}. Uninstall it before changing --project or installing ${config.label}.`,
          );
        }
      }
    }
    await this.recoverStaleWorkerIfRequested(config, options);
    await this.assertNoReservedProxyPort(config);
    await this.assertPortAvailable(config);
    const paths = launchAgentPaths(this.homeDirectory, config.label);
    const existing = await this.statusByConfig(config, paths);
    if (existing.loaded || existing.installed) {
      throw new Error(
        `Visual Intent service ${config.label} is already installed. Use service restart or uninstall first.`,
      );
    }

    await writeServiceConfig(config);
    try {
      await writeLaunchAgentPlist(config, this.homeDirectory);
    } catch (error) {
      await this.restoreServiceConfig(config, previousConfig);
      throw error;
    }
    let bootstrapSucceeded = false;
    try {
      await this.runLaunchctl([
        "bootstrap",
        this.launchDomain(),
        paths.plistPath,
      ]);
      bootstrapSucceeded = true;
      const status = await this.waitUntilRunning(config, paths);
      return status;
    } catch (error) {
      if (!bootstrapSucceeded) {
        await rm(paths.plistPath, { force: true });
        await this.restoreServiceConfig(config, previousConfig);
        throw error;
      }
      const cleanupArguments = [
        "bootout",
        this.launchService(config.label),
      ] as const;
      let cleanup: ProcessResult;
      try {
        cleanup = await this.processRunner.run(
          LAUNCHCTL_PATH,
          cleanupArguments,
        );
      } catch (cleanupError) {
        return this.throwInstallCleanupError(
          config,
          paths,
          cleanupArguments,
          error,
          cleanupError,
        );
      }
      if (cleanup.exitCode !== 0) {
        return this.throwInstallCleanupError(
          config,
          paths,
          cleanupArguments,
          error,
          cleanup.stderr.trim() || cleanup.stdout.trim() || "unknown error",
        );
      }
      await rm(paths.plistPath, { force: true });
      await this.restoreServiceConfig(config, previousConfig);
      throw error;
    }
  }

  async start(
    repositoryRoot: string,
    options: ServiceMutationOptions = {},
  ): Promise<ServiceStatus> {
    return this.withServiceMutation(repositoryRoot, (config) =>
      this.startLocked(config, options),
    );
  }

  private async startLocked(
    config: VisualIntentServiceConfig,
    options: ServiceMutationOptions,
  ): Promise<ServiceStatus> {
    await assertServiceProgramAvailable(config);
    const paths = launchAgentPaths(this.homeDirectory, config.label);
    const current = await this.statusByConfig(config, paths);
    if (current.running) return this.waitUntilRunning(config, paths);
    await this.assertNoBusyApply(config, options.force ?? false);
    await this.assertNoLiveProjectDaemon(
      config,
      "starting the background service",
    );
    await this.recoverStaleWorkerIfRequested(config, options);
    if (current.loaded) {
      await this.assertNoReservedProxyPort(config);
      return this.runStartTransition(config, paths, [
        "kickstart",
        "-k",
        this.launchService(config.label),
      ]);
    }
    if (!current.installed) {
      throw new Error(
        `LaunchAgent ${paths.plistPath} is missing. Run service install again.`,
      );
    }
    await this.assertNoReservedProxyPort(config);
    await this.assertPortAvailable(config);
    return this.runStartTransition(config, paths, [
      "bootstrap",
      this.launchDomain(),
      paths.plistPath,
    ]);
  }

  async stop(
    repositoryRoot: string,
    options: ServiceMutationOptions = {},
  ): Promise<ServiceStatus> {
    return this.withServiceMutation(repositoryRoot, (config) =>
      this.stopLocked(config, options),
    );
  }

  private async stopLocked(
    config: VisualIntentServiceConfig,
    options: ServiceMutationOptions,
  ): Promise<ServiceStatus> {
    await this.assertNoBusyApply(config, options.force ?? false);
    const paths = launchAgentPaths(this.homeDirectory, config.label);
    const current = await this.statusByConfig(config, paths);
    if (current.loaded) {
      await this.runLaunchctl(["bootout", this.launchService(config.label)]);
    }
    return this.statusByConfig(config, paths);
  }

  async restart(
    repositoryRoot: string,
    options: ServiceMutationOptions = {},
  ): Promise<ServiceStatus> {
    return this.withServiceMutation(repositoryRoot, (config) =>
      this.restartLocked(config, options),
    );
  }

  private async restartLocked(
    config: VisualIntentServiceConfig,
    options: ServiceMutationOptions,
  ): Promise<ServiceStatus> {
    await assertServiceProgramAvailable(config);
    await this.assertNoBusyApply(config, options.force ?? false);
    const paths = launchAgentPaths(this.homeDirectory, config.label);
    const current = await this.statusByConfig(config, paths);
    if (!current.installed) {
      throw new Error(
        `LaunchAgent ${paths.plistPath} is missing. Run service install again.`,
      );
    }
    await this.assertNoReservedProxyPort(config);
    if (current.loaded) {
      await this.runLaunchctl(["bootout", this.launchService(config.label)]);
    }
    await this.waitUntilNoLiveProjectDaemon(config);
    await this.recoverStaleWorkerIfRequested(config, options);
    await this.assertPortAvailable(config);
    return this.runStartTransition(config, paths, [
      "bootstrap",
      this.launchDomain(),
      paths.plistPath,
    ]);
  }

  async status(repositoryRoot: string): Promise<ServiceStatus> {
    this.assertMacOs();
    const config = await readServiceConfig(repositoryRoot);
    return this.statusByConfig(
      config,
      launchAgentPaths(this.homeDirectory, config.label),
    );
  }

  async uninstall(
    repositoryRoot: string,
    options: ServiceMutationOptions = {},
  ): Promise<ServiceUninstallResult> {
    return this.withServiceMutation(repositoryRoot, (config) =>
      this.uninstallLocked(config, options),
    );
  }

  private async uninstallLocked(
    config: VisualIntentServiceConfig,
    options: ServiceMutationOptions,
  ): Promise<ServiceUninstallResult> {
    await this.assertNoBusyApply(config, options.force ?? false);
    const paths = launchAgentPaths(this.homeDirectory, config.label);
    const current = await this.statusByConfig(config, paths);
    if (current.loaded) {
      await this.runLaunchctl(["bootout", this.launchService(config.label)]);
    }

    const removedDerivedState: string[] = [];
    const removedPlist = await pathExists(paths.plistPath);
    await rm(paths.plistPath, { force: true });

    return {
      label: config.label,
      stopped: current.loaded,
      removedPlist,
      removedDerivedState,
      preservedServiceConfig: join(
        config.repositoryRoot,
        ".visual-intent",
        "service.json",
      ),
      preservedLogs: [paths.standardOutputPath, paths.standardErrorPath],
    };
  }

  async logs(repositoryRoot: string): Promise<LaunchAgentPaths> {
    this.assertMacOs();
    const config = await readServiceConfig(repositoryRoot);
    return launchAgentPaths(this.homeDirectory, config.label);
  }

  private async statusByConfig(
    config: VisualIntentServiceConfig,
    paths: LaunchAgentPaths,
  ): Promise<ServiceStatus> {
    assertServiceLabel(config.label);
    const [installed, launchctl, activity] = await Promise.all([
      pathExists(paths.plistPath),
      this.processRunner.run(LAUNCHCTL_PATH, [
        "print",
        this.launchService(config.label),
      ]),
      inspectApplyActivity(config.repositoryRoot),
    ]);
    const loaded = launchctl.exitCode === 0;
    const pidMatch = /\bpid\s*=\s*(\d+)\b/u.exec(launchctl.stdout);
    const pid = pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : undefined;
    const running =
      loaded &&
      pid !== undefined &&
      /\bstate\s*=\s*running\b/u.test(launchctl.stdout);
    return {
      label: config.label,
      repositoryRoot: config.repositoryRoot,
      target: config.target,
      proxyUrl: formatLoopbackOrigin(config.host, config.port),
      installed,
      loaded,
      running,
      ...(pid === undefined ? {} : { pid }),
      busyApply: activity.busy,
      busyBatchIds: activity.batchIds,
      ...(activity.warning ? { applyStateWarning: activity.warning } : {}),
      plistPath: paths.plistPath,
      standardOutputPath: paths.standardOutputPath,
      standardErrorPath: paths.standardErrorPath,
    };
  }

  private async assertNoBusyApply(
    config: VisualIntentServiceConfig,
    force: boolean,
  ): Promise<void> {
    if (force) return;
    const activity = await inspectApplyActivity(config.repositoryRoot);
    if (activity.warning) {
      throw new Error(
        `Cannot safely determine whether Apply is running: ${activity.warning}. Retry with --force only after checking the project.`,
      );
    }
    if (activity.busy) {
      throw new Error(
        `Visual Intent has active Apply batch(es): ${activity.batchIds.join(", ")}. Wait for completion or retry with --force.`,
      );
    }
  }

  private async waitUntilRunning(
    config: VisualIntentServiceConfig,
    paths: LaunchAgentPaths,
  ): Promise<ServiceStatus> {
    let lastStatus: ServiceStatus | undefined;
    let lastDaemon: ProjectDaemonIdentity | undefined;
    let lastLeaseOwner: LiveProjectDaemonLeaseOwner | undefined;
    const expectedDaemonUrl = formatLoopbackOrigin(config.host, config.port);
    for (let attempt = 1; attempt <= this.readinessAttempts; attempt += 1) {
      lastStatus = await this.statusByConfig(config, paths);
      if (lastStatus.running && lastStatus.pid !== undefined) {
        [lastDaemon, lastLeaseOwner] = await Promise.all([
          this.projectDaemonProbe.inspect(config.repositoryRoot),
          this.projectDaemonLeaseOwner(config.repositoryRoot),
        ]);
        if (
          lastDaemon?.daemonUrl === expectedDaemonUrl &&
          lastLeaseOwner?.pid === lastStatus.pid &&
          lastLeaseOwner.daemonInstanceId === lastDaemon.daemonInstanceId
        ) {
          return lastStatus;
        }
      }
      if (attempt < this.readinessAttempts) {
        await this.delay(this.readinessIntervalMs);
      }
    }
    const state = lastStatus?.running
      ? `LaunchAgent reports running PID ${lastStatus.pid ?? "unknown"}`
      : lastStatus?.loaded
        ? "LaunchAgent loaded, but its process is not running"
        : "LaunchAgent is not loaded";
    const healthState = lastDaemon
      ? `Health identity belongs to ${lastDaemon.daemonUrl}, expected ${expectedDaemonUrl}`
      : "Visual Intent health identity is unavailable";
    const leaseState = lastLeaseOwner
      ? `Daemon lease belongs to PID ${lastLeaseOwner.pid} and instance ${lastLeaseOwner.daemonInstanceId ?? "unknown"}; expected LaunchAgent PID ${lastStatus?.pid ?? "unknown"} and health instance ${lastDaemon?.daemonInstanceId ?? "unknown"}`
      : "A live daemon lease for the LaunchAgent PID is unavailable";
    throw new Error(
      `Visual Intent service ${config.label} did not become ready after ${this.readinessAttempts} checks. ${state}. ${healthState}. ${leaseState}. Review logs: stdout ${paths.standardOutputPath}; stderr ${paths.standardErrorPath}`,
    );
  }

  private async assertNoLiveProjectDaemon(
    config: VisualIntentServiceConfig,
    action: string,
  ): Promise<void> {
    const leaseOwner = await this.projectDaemonLeaseOwner(
      config.repositoryRoot,
    );
    if (leaseOwner) {
      throw new Error(
        `A Visual Intent daemon is already running for ${config.repositoryRoot} (PID ${leaseOwner.pid}). Stop that proxy before ${action}. Lease: ${leaseOwner.leasePath}`,
      );
    }
    const liveDaemon = await this.projectDaemonProbe.inspect(
      config.repositoryRoot,
    );
    if (liveDaemon) {
      throw new Error(
        `A live Visual Intent daemon for ${config.repositoryRoot} is already running at ${liveDaemon.daemonUrl}. Stop the existing foreground proxy (Ctrl+C in its terminal) before ${action} at ${formatLoopbackOrigin(config.host, config.port)}.`,
      );
    }
  }

  private async waitUntilNoLiveProjectDaemon(
    config: VisualIntentServiceConfig,
  ): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.readinessAttempts; attempt += 1) {
      try {
        await this.assertNoLiveProjectDaemon(
          config,
          "restarting the background service",
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < this.readinessAttempts) {
        await this.delay(this.readinessIntervalMs);
      }
    }
    throw lastError ?? new Error("Visual Intent daemon did not stop");
  }

  private async runStartTransition(
    config: VisualIntentServiceConfig,
    paths: LaunchAgentPaths,
    launchctlArguments: readonly string[],
  ): Promise<ServiceStatus> {
    let transitionSucceeded = false;
    try {
      await this.runLaunchctl(launchctlArguments);
      transitionSucceeded = true;
      return await this.waitUntilRunning(config, paths);
    } catch (error) {
      if (transitionSucceeded) {
        const cleanupArguments = [
          "bootout",
          this.launchService(config.label),
        ] as const;
        let cleanup: ProcessResult;
        try {
          cleanup = await this.processRunner.run(
            LAUNCHCTL_PATH,
            cleanupArguments,
          );
        } catch (cleanupError) {
          throw this.transitionCleanupError(
            config,
            paths,
            cleanupArguments,
            error,
            cleanupError,
          );
        }
        if (cleanup.exitCode !== 0) {
          throw this.transitionCleanupError(
            config,
            paths,
            cleanupArguments,
            error,
            cleanup.stderr.trim() || cleanup.stdout.trim() || "unknown error",
          );
        }
      }
      throw new Error(
        `Visual Intent service ${config.label} failed to start: ${errorMessage(error)}. Review logs: stdout ${paths.standardOutputPath}; stderr ${paths.standardErrorPath}`,
        { cause: error },
      );
    }
  }

  private async assertPortAvailable(
    config: VisualIntentServiceConfig,
  ): Promise<void> {
    if (!(await this.portInspector.isAvailable(config.host, config.port))) {
      throw new Error(
        `Cannot start Visual Intent: ${formatLoopbackHost(config.host)}:${config.port} is already in use. No service files were changed.`,
      );
    }
  }

  private async recoverStaleWorkerIfRequested(
    config: VisualIntentServiceConfig,
    options: ServiceMutationOptions,
  ): Promise<void> {
    if (!options.forceRecoverStaleWorker) return;
    await forceRecoverStaleProjectWorkerLease(config.repositoryRoot);
  }

  private async assertNoReservedProxyPort(
    config: VisualIntentServiceConfig,
  ): Promise<void> {
    const launchAgentsDirectory = join(
      this.homeDirectory,
      "Library",
      "LaunchAgents",
    );
    const entries = await readdir(launchAgentsDirectory, {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(SERVICE_LABEL_PREFIX) ||
        !entry.name.endsWith(".plist") ||
        entry.name === `${config.label}.plist`
      ) {
        continue;
      }
      const path = join(launchAgentsDirectory, entry.name);
      const binding = await readLaunchAgentBinding(path);
      if (!binding) {
        throw new Error(
          `Cannot safely inspect Visual Intent LaunchAgent ${path}. Review or remove it before installing another service.`,
        );
      }
      if (
        binding.repositoryRoot &&
        resolve(binding.repositoryRoot) === config.repositoryRoot
      ) {
        throw new Error(
          `Repository ${config.repositoryRoot} is already reserved by Visual Intent service ${entry.name.slice(0, -".plist".length)}. Uninstall that service before installing another project label or port.`,
        );
      }
      if (binding.port === config.port) {
        throw new Error(
          `Proxy port ${config.port} is reserved by stopped or running Visual Intent service ${entry.name.slice(0, -".plist".length)}${binding.repositoryRoot ? ` for ${binding.repositoryRoot}` : ""}. Uninstall that service or choose another port.`,
        );
      }
    }
  }

  private async restoreServiceConfig(
    attemptedConfig: VisualIntentServiceConfig,
    previousConfig: VisualIntentServiceConfig | undefined,
  ): Promise<void> {
    if (previousConfig) {
      await writeServiceConfig(previousConfig);
      return;
    }
    await rm(serviceConfigPath(attemptedConfig.repositoryRoot), {
      force: true,
    });
  }

  private async withServiceMutation<T>(
    repositoryRoot: string,
    operation: (config: VisualIntentServiceConfig) => Promise<T>,
  ): Promise<T> {
    this.assertMacOs();
    const initialConfig = await readServiceConfig(repositoryRoot);
    const operationLease = await acquireProjectServiceOperationLease(
      initialConfig.repositoryRoot,
    );
    try {
      const currentConfig = await readServiceConfig(
        initialConfig.repositoryRoot,
      );
      return await operation(currentConfig);
    } finally {
      await operationLease.release();
    }
  }

  private async runLaunchctl(argumentsList: readonly string[]): Promise<void> {
    const result = await this.processRunner.run(LAUNCHCTL_PATH, argumentsList);
    if (result.exitCode !== 0) {
      const details = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `launchctl ${argumentsList[0] ?? "command"} failed${details ? `: ${details}` : ""}`,
      );
    }
  }

  private async throwInstallCleanupError(
    config: VisualIntentServiceConfig,
    paths: LaunchAgentPaths,
    cleanupArguments: readonly string[],
    originalError: unknown,
    cleanupError: unknown,
  ): Promise<never> {
    const cleanupCommand = [LAUNCHCTL_PATH, ...cleanupArguments].join(" ");
    try {
      await writeServiceConfig(config);
    } catch (configError) {
      throw new Error(
        `Visual Intent service install failed: ${errorMessage(originalError)}. Cleanup command failed: ${cleanupCommand}: ${errorMessage(cleanupError)}. LaunchAgent plist was preserved at ${paths.plistPath}, but service config could not be preserved at ${serviceConfigPath(config.repositoryRoot)}: ${errorMessage(configError)}. Manage the exact label ${config.label} with launchctl and review logs: stdout ${paths.standardOutputPath}; stderr ${paths.standardErrorPath}`,
        { cause: configError },
      );
    }
    throw new Error(
      `Visual Intent service install failed: ${errorMessage(originalError)}. Cleanup command failed: ${cleanupCommand}: ${errorMessage(cleanupError)}. LaunchAgent plist was preserved at ${paths.plistPath}, and service config was preserved at ${serviceConfigPath(config.repositoryRoot)}, so the service remains manageable through service status, stop, logs, and uninstall. Review logs: stdout ${paths.standardOutputPath}; stderr ${paths.standardErrorPath}`,
      { cause: originalError },
    );
  }

  private transitionCleanupError(
    config: VisualIntentServiceConfig,
    paths: LaunchAgentPaths,
    cleanupArguments: readonly string[],
    originalError: unknown,
    cleanupError: unknown,
  ): Error {
    const cleanupCommand = [LAUNCHCTL_PATH, ...cleanupArguments].join(" ");
    return new Error(
      `Visual Intent service ${config.label} failed to become ready: ${errorMessage(originalError)}. Cleanup command failed: ${cleanupCommand}: ${errorMessage(cleanupError)}. LaunchAgent plist and service config were preserved so the service remains manageable. Review logs: stdout ${paths.standardOutputPath}; stderr ${paths.standardErrorPath}`,
      { cause: originalError },
    );
  }

  private launchDomain(): string {
    return `gui/${this.userId}`;
  }

  private launchService(label: string): string {
    assertServiceLabel(label);
    return `${this.launchDomain()}/${label}`;
  }

  private assertMacOs(): void {
    if (this.platform !== "darwin") {
      throw new Error(
        "Visual Intent service commands currently support macOS LaunchAgents only",
      );
    }
  }
}

export class ExecFileProcessRunner implements ProcessRunner {
  run(
    executable: string,
    argumentsList: readonly string[],
  ): Promise<ProcessResult> {
    return new Promise((resolveResult) => {
      execFile(
        executable,
        [...argumentsList],
        { encoding: "utf8" },
        (error, stdout, stderr) => {
          const rawExitCode = error?.code;
          const exitCode =
            typeof rawExitCode === "number" ? rawExitCode : error ? 1 : 0;
          resolveResult({ exitCode, stdout, stderr });
        },
      );
    });
  }
}

export class TcpPortInspector implements PortInspector {
  isAvailable(host: string, port: number): Promise<boolean> {
    return new Promise((resolveAvailability, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" || error.code === "EACCES") {
          resolveAvailability(false);
          return;
        }
        reject(error);
      });
      server.listen({ host, port, exclusive: true }, () => {
        server.close((error) => {
          if (error) reject(error);
          else resolveAvailability(true);
        });
      });
    });
  }
}

async function inspectApplyActivity(
  repositoryRoot: string,
): Promise<ApplyActivity> {
  const path = join(repositoryRoot, ".visual-intent", "tasks.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { busy: false, batchIds: [] };
    }
    return {
      busy: false,
      batchIds: [],
      warning: `${path}: ${errorMessage(error)}`,
    };
  }
  if (!isRecord(value) || !Array.isArray(value.batches)) {
    return {
      busy: false,
      batchIds: [],
      warning: `${path} has an unexpected format`,
    };
  }
  const batchIds = value.batches.flatMap((batch) => {
    if (
      !isRecord(batch) ||
      typeof batch.status !== "string" ||
      !ACTIVE_BATCH_STATUSES.has(batch.status)
    ) {
      return [];
    }
    return [typeof batch.id === "string" ? batch.id : "unknown-batch"];
  });
  const executorBusy =
    isRecord(value.session) &&
    isRecord(value.session.executor) &&
    value.session.executor.status === "busy";
  if (executorBusy && batchIds.length === 0) batchIds.push("executor-busy");
  return { busy: batchIds.length > 0, batchIds };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertServiceProgramAvailable(
  config: VisualIntentServiceConfig,
): Promise<void> {
  try {
    await access(config.nodePath, constants.X_OK);
  } catch (error) {
    throw new Error(
      `Configured Node.js executable is unavailable: ${config.nodePath}. Reinstall the Visual Intent service.`,
      { cause: error },
    );
  }
  try {
    await access(config.cliPath, constants.R_OK);
  } catch (error) {
    throw new Error(
      `Configured Visual Intent CLI is unavailable: ${config.cliPath}. Rebuild Visual Intent and reinstall the service.`,
      { cause: error },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
