import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  launchAgentPaths,
  writeLaunchAgentPlist,
} from "../src/launch-agent.js";
import {
  createServiceConfig,
  readServiceConfig,
  serviceConfigPath,
  type VisualIntentServiceConfig,
} from "../src/service-config.js";
import type {
  ProjectDaemonIdentity,
  ProjectDaemonProbe,
} from "../src/project-daemon-probe.js";
import type { LiveProjectDaemonLeaseOwner } from "../src/project-daemon-lease.js";
import {
  ServiceManager,
  type PortInspector,
  type ProcessResult,
  type ProcessRunner,
} from "../src/service-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("macOS Visual Intent service manager", () => {
  it("installs one stable LaunchAgent through an injected launchctl runner", async () => {
    const fixture = await createFixture();

    const status = await fixture.manager.install(fixture.config);

    expect(status).toMatchObject({
      installed: true,
      loaded: true,
      running: true,
      pid: 4242,
    });
    expect(fixture.portInspector.calls).toEqual([
      { host: "127.0.0.1", port: 7310 },
    ]);
    expect(fixture.runner.calls).toContainEqual([
      "/bin/launchctl",
      [
        "bootstrap",
        "gui/501",
        launchAgentPaths(fixture.homeDirectory, fixture.config.label).plistPath,
      ],
    ]);
    expect(
      (await stat(serviceConfigPath(fixture.repositoryRoot))).mode & 0o777,
    ).toBe(0o600);
    const plist = await readFile(status.plistPath, "utf8");
    expect(plist).toContain(fixture.config.nodePath);
    expect(plist).toContain(fixture.config.cliPath);
    expect(plist).not.toContain("/bin/sh");
  });

  it("persists the service config before publishing or bootstrapping the LaunchAgent", async () => {
    const fixture = await createFixture();
    fixture.runner.beforeBootstrap = async () => {
      await expect(readServiceConfig(fixture.repositoryRoot)).resolves.toEqual(
        fixture.config,
      );
      await expect(
        access(
          launchAgentPaths(fixture.homeDirectory, fixture.config.label)
            .plistPath,
        ),
      ).resolves.toBeUndefined();
    };

    await expect(fixture.manager.install(fixture.config)).resolves.toEqual(
      expect.objectContaining({ running: true }),
    );
  });

  it("serializes concurrent installs without orphaning the winning service", async () => {
    const fixture = await createFixture();
    const outcomes = await Promise.allSettled([
      fixture.manager.install(fixture.config),
      fixture.manager.install(fixture.config),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    await expect(readServiceConfig(fixture.repositoryRoot)).resolves.toEqual(
      fixture.config,
    );
    await expect(
      fixture.manager.status(fixture.repositoryRoot),
    ).resolves.toEqual(
      expect.objectContaining({ installed: true, loaded: true, running: true }),
    );
  });

  it("blocks restart and uninstall while an install owns the service operation", async () => {
    const fixture = await createFixture();
    let releaseBootstrap: (() => void) | undefined;
    let markBootstrapEntered: (() => void) | undefined;
    const bootstrapEntered = new Promise<void>((resolve) => {
      markBootstrapEntered = resolve;
    });
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    let bootstrapCalls = 0;
    fixture.runner.beforeBootstrap = async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls !== 1) return;
      markBootstrapEntered?.();
      await bootstrapGate;
    };

    const installing = fixture.manager.install(fixture.config);
    await bootstrapEntered;
    try {
      await expect(
        fixture.manager.restart(fixture.repositoryRoot),
      ).rejects.toThrow("service operation is already running");
      await expect(
        fixture.manager.uninstall(fixture.repositoryRoot),
      ).rejects.toThrow("service operation is already running");
    } finally {
      releaseBootstrap?.();
    }
    await expect(installing).resolves.toEqual(
      expect.objectContaining({ installed: true, loaded: true, running: true }),
    );
    await expect(
      fixture.manager.status(fixture.repositoryRoot),
    ).resolves.toEqual(
      expect.objectContaining({ installed: true, loaded: true, running: true }),
    );
  });

  it("checks the proxy port before writing service files", async () => {
    const fixture = await createFixture({ portAvailable: false });

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      "is already in use",
    );

    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).rejects.toThrow();
    await expect(
      access(
        launchAgentPaths(fixture.homeDirectory, fixture.config.label).plistPath,
      ),
    ).rejects.toThrow();
    expect(fixture.runner.calls).toEqual([]);
  });

  it("rejects a live project daemon lease before any other runtime preflight", async () => {
    const fixture = await createFixture();
    fixture.daemonLeaseOwner.foregroundPid = process.pid;

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      `already running for ${fixture.repositoryRoot} (PID ${process.pid})`,
    );

    expect(fixture.daemonProbe.calls).toEqual([]);
    expect(fixture.portInspector.calls).toEqual([]);
    expect(fixture.runner.calls).toEqual([]);
  });

  it("does not accept health from a daemon whose lease belongs to another PID", async () => {
    const fixture = await createFixture();
    fixture.daemonLeaseOwner.servicePid = 31337;
    const paths = launchAgentPaths(fixture.homeDirectory, fixture.config.label);

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "Daemon lease belongs to PID 31337 and instance daemon-fixture; expected LaunchAgent PID 4242",
        ),
      }),
    );

    expect(fixture.daemonProbe.calls.length).toBeGreaterThan(0);
    expect(fixture.delay.calls).toEqual([25, 25]);
    await expect(access(paths.plistPath)).rejects.toThrow();
  });

  it("does not accept health from a daemon with another instance identity", async () => {
    const fixture = await createFixture();
    fixture.daemonLeaseOwner.daemonInstanceId = "another-daemon";

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "instance another-daemon; expected LaunchAgent PID 4242 and health instance daemon-fixture",
        ),
      }),
    );
  });

  it("rejects a live foreground daemon for the same repository on another port", async () => {
    const fixture = await createFixture();
    fixture.daemonProbe.liveDaemon = daemonIdentity(
      fixture.repositoryRoot,
      "http://127.0.0.1:7999",
    );

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /already running at http:\/\/127\.0\.0\.1:7999[\s\S]*Ctrl\+C/u,
        ),
      }),
    );

    expect(fixture.portInspector.calls).toEqual([]);
    expect(fixture.runner.calls).toEqual([]);
    await expect(
      access(
        launchAgentPaths(fixture.homeDirectory, fixture.config.label).plistPath,
      ),
    ).rejects.toThrow();
  });

  it("refuses installation while Apply is active unless force is explicit", async () => {
    const fixture = await createFixture();
    await writeTaskDocument(fixture.repositoryRoot, [
      { id: "batch-active-install", status: "in_progress" },
    ]);
    const paths = launchAgentPaths(fixture.homeDirectory, fixture.config.label);

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      "active Apply batch(es): batch-active-install",
    );
    expect(fixture.runner.calls).toEqual([]);
    await expect(access(paths.plistPath)).rejects.toThrow();

    await expect(
      fixture.manager.install(fixture.config, { force: true }),
    ).resolves.toEqual(expect.objectContaining({ running: true }));
  });

  it("refuses a port reserved by another stopped Visual Intent service", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    await fixture.manager.stop(fixture.repositoryRoot);

    const secondRepositoryRoot = join(fixture.homeDirectory, "second-repo");
    await mkdir(secondRepositoryRoot, { recursive: true });
    const secondConfig = await createServiceConfig({
      repositoryRoot: secondRepositoryRoot,
      target: "http://127.0.0.1:4000",
      host: "127.0.0.1",
      port: fixture.config.port,
      projectKey: "second-project",
      displayName: "Second Project",
      executor: "isolated-worker",
      nodePath: process.execPath,
      cliPath: import.meta.filename,
      now: new Date("2026-08-26T01:00:00.000Z"),
    });

    await expect(fixture.manager.install(secondConfig)).rejects.toThrow(
      `Proxy port ${fixture.config.port} is reserved`,
    );
    await expect(
      access(
        launchAgentPaths(fixture.homeDirectory, secondConfig.label).plistPath,
      ),
    ).rejects.toThrow();
    await expect(
      access(serviceConfigPath(secondRepositoryRoot)),
    ).rejects.toThrow();
  });

  it("refuses another plist for the same repository even with a different port and no service config", async () => {
    const fixture = await createFixture();
    const legacyConfig = await createServiceConfig({
      repositoryRoot: fixture.repositoryRoot,
      target: "http://127.0.0.1:4000",
      host: "127.0.0.1",
      port: 7998,
      projectKey: "legacy-content-hub",
      displayName: "Legacy Content Hub",
      executor: "isolated-worker",
      nodePath: process.execPath,
      cliPath: import.meta.filename,
      now: new Date("2026-08-26T01:00:00.000Z"),
    });
    await writeLaunchAgentPlist(legacyConfig, fixture.homeDirectory);

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          `Repository ${fixture.repositoryRoot} is already reserved by Visual Intent service ${legacyConfig.label}`,
        ),
      }),
    );

    expect(fixture.portInspector.calls).toEqual([]);
    expect(fixture.runner.calls).toEqual([]);
    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).rejects.toThrow();
  });

  it("formats the status URL for IPv6 loopback", async () => {
    const fixture = await createFixture();
    fixture.config = { ...fixture.config, host: "::1", port: 7311 };
    fixture.daemonProbe.expect(
      fixture.repositoryRoot,
      fixture.config.label,
      "http://[::1]:7311",
    );

    const status = await fixture.manager.install(fixture.config);

    expect(status.proxyUrl).toBe("http://[::1]:7311");
  });

  it("refuses to restart when a legacy LaunchAgent reserves the same port", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    const secondRepositoryRoot = join(fixture.homeDirectory, "legacy-repo");
    await mkdir(secondRepositoryRoot, { recursive: true });
    const secondConfig = await createServiceConfig({
      repositoryRoot: secondRepositoryRoot,
      target: "http://127.0.0.1:4000",
      host: "127.0.0.1",
      port: fixture.config.port,
      projectKey: "legacy-project",
      displayName: "Legacy Project",
      executor: "isolated-worker",
      nodePath: process.execPath,
      cliPath: import.meta.filename,
      now: new Date("2026-08-26T01:00:00.000Z"),
    });
    await writeLaunchAgentPlist(secondConfig, fixture.homeDirectory);
    const mutationCount = fixture.runner.mutationCalls;

    await expect(
      fixture.manager.restart(fixture.repositoryRoot),
    ).rejects.toThrow(`Proxy port ${fixture.config.port} is reserved`);
    expect(fixture.runner.mutationCalls).toBe(mutationCount);
    await expect(
      fixture.manager.status(fixture.repositoryRoot),
    ).resolves.toEqual(expect.objectContaining({ running: true }));
  });

  it("rolls back the plist when launchctl bootstrap fails", async () => {
    const fixture = await createFixture();
    fixture.runner.failNextBootstrap = true;
    const paths = launchAgentPaths(fixture.homeDirectory, fixture.config.label);

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      "launchctl bootstrap failed",
    );

    await expect(access(paths.plistPath)).rejects.toThrow();
    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).rejects.toThrow();
  });

  it("rolls back an install when bootstrap succeeds but no running PID appears", async () => {
    const fixture = await createFixture();
    fixture.runner.bootstrapState = "waiting";
    const paths = launchAgentPaths(fixture.homeDirectory, fixture.config.label);

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(
            `did not become ready[\\s\\S]*${escapeRegExp(paths.standardOutputPath)}[\\s\\S]*${escapeRegExp(paths.standardErrorPath)}`,
            "u",
          ),
        ),
      }),
    );

    expect(fixture.delay.calls).toEqual([25, 25]);
    expect(fixture.runner.calls).toContainEqual([
      "/bin/launchctl",
      ["bootout", `gui/501/${fixture.config.label}`],
    ]);
    await expect(access(paths.plistPath)).rejects.toThrow();
    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).rejects.toThrow();
  });

  it("rolls back a PID-running install when daemon health identity is unavailable", async () => {
    const fixture = await createFixture();
    fixture.daemonProbe.available = false;
    const paths = launchAgentPaths(fixture.homeDirectory, fixture.config.label);

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "Visual Intent health identity is unavailable",
        ),
      }),
    );

    expect(fixture.delay.calls).toEqual([25, 25]);
    await expect(access(paths.plistPath)).rejects.toThrow();
    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).rejects.toThrow();
  });

  it("preserves the plist when readiness fails and launchctl bootout also fails", async () => {
    const fixture = await createFixture();
    fixture.runner.bootstrapState = "waiting";
    fixture.runner.failNextBootout = true;
    const paths = launchAgentPaths(fixture.homeDirectory, fixture.config.label);

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(
            `${escapeRegExp(`/bin/launchctl bootout gui/501/${fixture.config.label}`)}[\\s\\S]*${escapeRegExp(paths.plistPath)}[\\s\\S]*${escapeRegExp(paths.standardErrorPath)}`,
            "u",
          ),
        ),
      }),
    );

    await expect(access(paths.plistPath)).resolves.toBeUndefined();
    await expect(readServiceConfig(fixture.repositoryRoot)).resolves.toEqual(
      fixture.config,
    );
    await expect(
      fixture.manager.status(fixture.repositoryRoot),
    ).resolves.toEqual(
      expect.objectContaining({
        label: fixture.config.label,
        installed: true,
        loaded: true,
      }),
    );
  });

  it("refuses to orphan an older label for the same repository", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    await fixture.manager.stop(fixture.repositoryRoot);
    const replacement = await createServiceConfig({
      repositoryRoot: fixture.repositoryRoot,
      target: fixture.config.target,
      host: fixture.config.host,
      port: 7311,
      projectKey: "renamed-content-hub",
      displayName: "Renamed Content Hub",
      executor: "isolated-worker",
      nodePath: process.execPath,
      cliPath: import.meta.filename,
      now: new Date("2026-08-26T01:00:00.000Z"),
    });

    await expect(fixture.manager.install(replacement)).rejects.toThrow(
      `service ${fixture.config.label}`,
    );
    await expect(readServiceConfig(fixture.repositoryRoot)).resolves.toEqual(
      fixture.config,
    );
    await expect(
      access(
        launchAgentPaths(fixture.homeDirectory, replacement.label).plistPath,
      ),
    ).rejects.toThrow();
  });

  it("kickstarts a loaded service that is not actually running", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    fixture.runner.nonRunningLabels.add(fixture.config.label);

    const status = await fixture.manager.start(fixture.repositoryRoot);

    expect(status.running).toBe(true);
    expect(fixture.runner.calls).toContainEqual([
      "/bin/launchctl",
      ["kickstart", "-k", `gui/501/${fixture.config.label}`],
    ]);
  });

  it("reports log paths when kickstart succeeds but the job stays waiting", async () => {
    const fixture = await createFixture();
    const installed = await fixture.manager.install(fixture.config);
    fixture.runner.nonRunningLabels.add(fixture.config.label);
    fixture.runner.kickstartState = "waiting";

    await expect(fixture.manager.start(fixture.repositoryRoot)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(installed.standardErrorPath),
      }),
    );

    expect(fixture.runner.calls).toContainEqual([
      "/bin/launchctl",
      ["bootout", `gui/501/${fixture.config.label}`],
    ]);

    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).resolves.toBeUndefined();
    await expect(access(installed.plistPath)).resolves.toBeUndefined();
  });

  it("refuses to start a stopped service while another foreground daemon is live", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    await fixture.manager.stop(fixture.repositoryRoot);
    fixture.daemonProbe.liveDaemon = daemonIdentity(
      fixture.repositoryRoot,
      "http://127.0.0.1:7999",
    );
    const mutationCalls = fixture.runner.mutationCalls;

    await expect(fixture.manager.start(fixture.repositoryRoot)).rejects.toThrow(
      "already running at http://127.0.0.1:7999",
    );

    expect(fixture.runner.mutationCalls).toBe(mutationCalls);
  });

  it("keeps config and plist when start bootstrap loads a waiting job", async () => {
    const fixture = await createFixture();
    const installed = await fixture.manager.install(fixture.config);
    await fixture.manager.stop(fixture.repositoryRoot);
    fixture.runner.bootstrapState = "waiting";

    await expect(fixture.manager.start(fixture.repositoryRoot)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(installed.standardOutputPath),
      }),
    );

    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).resolves.toBeUndefined();
    await expect(access(installed.plistPath)).resolves.toBeUndefined();
  });

  it("keeps config and plist when restart bootstrap leaves an exited job", async () => {
    const fixture = await createFixture();
    const installed = await fixture.manager.install(fixture.config);
    fixture.runner.bootstrapState = "exited";

    await expect(
      fixture.manager.restart(fixture.repositoryRoot),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining("did not become ready"),
      }),
    );

    await expect(
      access(serviceConfigPath(fixture.repositoryRoot)),
    ).resolves.toBeUndefined();
    await expect(access(installed.plistPath)).resolves.toBeUndefined();
  });

  it("requires an explicit force before kickstarting ambiguous active Apply state", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    fixture.runner.nonRunningLabels.add(fixture.config.label);
    await writeTaskDocument(fixture.repositoryRoot, [
      { id: "batch-stale", status: "in_progress" },
    ]);

    await expect(fixture.manager.start(fixture.repositoryRoot)).rejects.toThrow(
      "active Apply batch(es): batch-stale",
    );
    await expect(
      fixture.manager.start(fixture.repositoryRoot, { force: true }),
    ).resolves.toEqual(expect.objectContaining({ running: true }));
  });

  it("does not treat force-recover-stale-worker as approval to interrupt Apply", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    fixture.runner.nonRunningLabels.add(fixture.config.label);
    await writeTaskDocument(fixture.repositoryRoot, [
      { id: "batch-active", status: "in_progress" },
    ]);

    await expect(
      fixture.manager.start(fixture.repositoryRoot, {
        forceRecoverStaleWorker: true,
      }),
    ).rejects.toThrow("active Apply batch(es): batch-active");
  });

  it("refuses to stop an active Apply batch unless force is explicit", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    await writeTaskDocument(fixture.repositoryRoot, [
      { id: "batch-active", status: "in_progress" },
    ]);
    const callsBeforeStop = fixture.runner.calls.length;

    await expect(fixture.manager.stop(fixture.repositoryRoot)).rejects.toThrow(
      "active Apply batch(es): batch-active",
    );
    expect(fixture.runner.calls).toHaveLength(callsBeforeStop);

    const stopped = await fixture.manager.stop(fixture.repositoryRoot, {
      force: true,
    });
    expect(stopped.loaded).toBe(false);
    expect(fixture.runner.calls).toContainEqual([
      "/bin/launchctl",
      ["bootout", `gui/501/${fixture.config.label}`],
    ]);
  });

  it("preserves all project history, settings, context, service config, and logs on uninstall", async () => {
    const fixture = await createFixture();
    const status = await fixture.manager.install(fixture.config);
    const dataDirectory = join(fixture.repositoryRoot, ".visual-intent");
    const preservedPaths = [
      join(dataDirectory, "tasks.json"),
      join(dataDirectory, "settings.json"),
      join(dataDirectory, "context.md"),
      join(dataDirectory, "attachments", "reference.png"),
      serviceConfigPath(fixture.repositoryRoot),
    ];
    await mkdir(join(dataDirectory, "attachments"), { recursive: true });
    await writeTaskDocument(fixture.repositoryRoot, []);
    await writeFile(join(dataDirectory, "settings.json"), "{}\n", "utf8");
    await writeFile(join(dataDirectory, "context.md"), "# Context\n", "utf8");
    await writeFile(
      join(dataDirectory, "attachments", "reference.png"),
      "image",
      "utf8",
    );
    await writeFile(join(dataDirectory, "connection.json"), "{}\n", "utf8");
    await writeFile(join(dataDirectory, "service-state.json"), "{}\n", "utf8");
    await mkdir(
      join(fixture.homeDirectory, "Library", "Logs", "VisualIntent"),
      {
        recursive: true,
      },
    );
    await writeFile(status.standardOutputPath, "kept log\n", "utf8");

    const result = await fixture.manager.uninstall(fixture.repositoryRoot);

    expect(result.removedPlist).toBe(true);
    expect(result.removedDerivedState).toEqual([]);
    await expect(access(status.plistPath)).rejects.toThrow();
    await expect(
      access(join(dataDirectory, "connection.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(dataDirectory, "service-state.json")),
    ).resolves.toBeUndefined();
    for (const path of preservedPaths)
      await expect(access(path)).resolves.toBeUndefined();
    await expect(readFile(status.standardOutputPath, "utf8")).resolves.toBe(
      "kept log\n",
    );
  });

  it("reports installed and Apply state without mutating launchd", async () => {
    const fixture = await createFixture();
    await fixture.manager.install(fixture.config);
    await writeTaskDocument(fixture.repositoryRoot, [
      { id: "batch-queued", status: "queued" },
    ]);
    const mutationCount = fixture.runner.mutationCalls;

    const status = await fixture.manager.status(fixture.repositoryRoot);

    expect(status.busyApply).toBe(true);
    expect(status.busyBatchIds).toEqual(["batch-queued"]);
    expect(fixture.runner.mutationCalls).toBe(mutationCount);
  });

  it("does not invoke launchctl outside macOS", async () => {
    const fixture = await createFixture({ platform: "linux" });

    await expect(fixture.manager.install(fixture.config)).rejects.toThrow(
      "macOS LaunchAgents only",
    );
    expect(fixture.runner.calls).toEqual([]);
  });
});

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<[string, string[]]> = [];
  readonly loadedLabels = new Set<string>();
  readonly nonRunningLabels = new Set<string>();
  readonly exitedLabels = new Set<string>();
  failNextBootstrap = false;
  failNextBootout = false;
  bootstrapState: "running" | "waiting" | "exited" = "running";
  kickstartState: "running" | "waiting" | "exited" = "running";
  mutationCalls = 0;
  beforeBootstrap?: () => Promise<void>;

  async run(
    executable: string,
    argumentsList: readonly string[],
  ): Promise<ProcessResult> {
    const args = [...argumentsList];
    this.calls.push([executable, args]);
    const command = args[0];
    if (command === "bootstrap") {
      this.mutationCalls += 1;
      await this.beforeBootstrap?.();
      if (this.failNextBootstrap) {
        this.failNextBootstrap = false;
        return result(5, "", "bootstrap fixture failure");
      }
      const plistPath = args[2] ?? "";
      const label = basename(plistPath, ".plist");
      this.loadedLabels.add(label);
      this.setState(label, this.bootstrapState);
      return result(0);
    }
    if (command === "bootout") {
      this.mutationCalls += 1;
      if (this.failNextBootout) {
        this.failNextBootout = false;
        return result(5, "", "bootout fixture failure");
      }
      this.loadedLabels.delete((args[1] ?? "").split("/").at(-1) ?? "");
      this.nonRunningLabels.delete((args[1] ?? "").split("/").at(-1) ?? "");
      this.exitedLabels.delete((args[1] ?? "").split("/").at(-1) ?? "");
      return result(0);
    }
    if (command === "kickstart") {
      this.mutationCalls += 1;
      const label = (args.at(-1) ?? "").split("/").at(-1) ?? "";
      this.setState(label, this.kickstartState);
      return result(0);
    }
    if (command === "print") {
      const label = (args[1] ?? "").split("/").at(-1) ?? "";
      return this.loadedLabels.has(label)
        ? this.exitedLabels.has(label)
          ? result(0, "state = exited\nlast exit code = 1\n")
          : this.nonRunningLabels.has(label)
            ? result(0, "state = waiting\n")
            : result(0, "state = running\npid = 4242\n")
        : result(113, "", "Could not find service");
    }
    return result(64, "", "Unexpected fake command");
  }

  private setState(
    label: string,
    state: "running" | "waiting" | "exited",
  ): void {
    this.nonRunningLabels.delete(label);
    this.exitedLabels.delete(label);
    if (state === "waiting") this.nonRunningLabels.add(label);
    if (state === "exited") this.exitedLabels.add(label);
  }
}

class FakePortInspector implements PortInspector {
  readonly calls: Array<{ host: string; port: number }> = [];

  constructor(public available: boolean) {}

  async isAvailable(host: string, port: number): Promise<boolean> {
    this.calls.push({ host, port });
    return this.available;
  }
}

class FakeDelay {
  readonly calls: number[] = [];

  wait = async (milliseconds: number): Promise<void> => {
    this.calls.push(milliseconds);
  };
}

class FakeProjectDaemonProbe implements ProjectDaemonProbe {
  readonly calls: string[] = [];
  readonly expected = new Map<string, { label: string; daemonUrl: string }>();
  available = true;
  liveDaemon?: ProjectDaemonIdentity;

  constructor(private readonly runner: FakeProcessRunner) {}

  expect(repositoryRoot: string, label: string, daemonUrl: string): void {
    this.expected.set(repositoryRoot, { label, daemonUrl });
  }

  async inspect(
    repositoryRoot: string,
  ): Promise<ProjectDaemonIdentity | undefined> {
    this.calls.push(repositoryRoot);
    if (this.liveDaemon) return this.liveDaemon;
    if (!this.available) return undefined;
    const expected = this.expected.get(repositoryRoot);
    if (
      !expected ||
      !this.runner.loadedLabels.has(expected.label) ||
      this.runner.nonRunningLabels.has(expected.label) ||
      this.runner.exitedLabels.has(expected.label)
    ) {
      return undefined;
    }
    return daemonIdentity(repositoryRoot, expected.daemonUrl);
  }
}

class FakeProjectDaemonLeaseOwner {
  foregroundPid?: number;
  servicePid = 4242;
  daemonInstanceId = "daemon-fixture";

  constructor(private readonly runner: FakeProcessRunner) {}

  inspect = async (
    repositoryRoot: string,
  ): Promise<LiveProjectDaemonLeaseOwner | undefined> => {
    const pid =
      this.foregroundPid ??
      (this.runner.loadedLabels.size > 0 &&
      [...this.runner.loadedLabels].some(
        (label) =>
          !this.runner.nonRunningLabels.has(label) &&
          !this.runner.exitedLabels.has(label),
      )
        ? this.servicePid
        : undefined);
    return pid === undefined
      ? undefined
      : {
          pid,
          createdAt: "2026-08-26T00:00:00.000Z",
          daemonInstanceId: this.daemonInstanceId,
          leasePath: join(
            repositoryRoot,
            ".visual-intent",
            "daemon-lease.json",
          ),
        };
  };
}

async function createFixture(
  options: {
    portAvailable?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): Promise<{
  repositoryRoot: string;
  homeDirectory: string;
  config: VisualIntentServiceConfig;
  runner: FakeProcessRunner;
  portInspector: FakePortInspector;
  delay: FakeDelay;
  daemonProbe: FakeProjectDaemonProbe;
  daemonLeaseOwner: FakeProjectDaemonLeaseOwner;
  manager: ServiceManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "visual-intent-service-manager-"));
  temporaryDirectories.push(root);
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
  ]);
  const config = await createServiceConfig({
    repositoryRoot,
    target: "http://127.0.0.1:3000",
    host: "127.0.0.1",
    port: 7310,
    projectKey: "content-hub",
    displayName: "Content Hub",
    executor: "isolated-worker",
    nodePath: process.execPath,
    cliPath: import.meta.filename,
    now: new Date("2026-08-26T00:00:00.000Z"),
  });
  const runner = new FakeProcessRunner();
  const portInspector = new FakePortInspector(options.portAvailable ?? true);
  const delay = new FakeDelay();
  const daemonProbe = new FakeProjectDaemonProbe(runner);
  const daemonLeaseOwner = new FakeProjectDaemonLeaseOwner(runner);
  daemonProbe.expect(
    config.repositoryRoot,
    config.label,
    `http://${config.host}:${config.port}`,
  );
  const manager = new ServiceManager({
    processRunner: runner,
    portInspector,
    homeDirectory,
    userId: 501,
    platform: options.platform ?? "darwin",
    readinessAttempts: 3,
    readinessIntervalMs: 25,
    delay: delay.wait,
    projectDaemonProbe: daemonProbe,
    projectDaemonLeaseOwner: daemonLeaseOwner.inspect,
  });
  return {
    repositoryRoot: config.repositoryRoot,
    homeDirectory,
    config,
    runner,
    portInspector,
    delay,
    daemonProbe,
    daemonLeaseOwner,
    manager,
  };
}

async function writeTaskDocument(
  repositoryRoot: string,
  batches: Array<{ id: string; status: string }>,
): Promise<void> {
  const directory = join(repositoryRoot, ".visual-intent");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "tasks.json"),
    `${JSON.stringify({ batches })}\n`,
    "utf8",
  );
}

function result(exitCode: number, stdout = "", stderr = ""): ProcessResult {
  return { exitCode, stdout, stderr };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function daemonIdentity(
  repositoryRoot: string,
  daemonUrl: string,
): ProjectDaemonIdentity {
  return {
    daemonUrl,
    daemonInstanceId: "daemon-fixture",
    repositoryRoot,
    sessionId: "session-fixture",
    projectKey: "project-fixture",
  };
}
