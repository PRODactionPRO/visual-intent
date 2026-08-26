import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerServiceCommands,
  type ServiceController,
} from "../src/service-commands.js";
import type { VisualIntentServiceConfig } from "../src/service-config.js";
import type { ServiceStatus } from "../src/service-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("service CLI registration", () => {
  it("registers a safe install command with no target-server command", async () => {
    const repositoryRoot = await createRepository();
    const manager = fakeController();
    let installedConfig: VisualIntentServiceConfig | undefined;
    manager.install = vi.fn(async (config) => {
      installedConfig = config;
      return statusFor(config);
    });
    const output: string[] = [];
    const program = new Command().exitOverride();
    registerServiceCommands(program, {
      manager,
      nodePath: process.execPath,
      cliPath: import.meta.filename,
      cwd: () => repositoryRoot,
      log: (message) => output.push(message),
    });

    await program.parseAsync([
      "node",
      "visual-intent",
      "service",
      "install",
      "--target",
      "http://127.0.0.1:3000",
      "--port",
      "7312",
      "--project",
      "content-hub",
      "--executor",
      "isolated-worker",
      "--force",
      "--force-recover-stale-worker",
    ]);

    expect(installedConfig).toMatchObject({
      repositoryRoot,
      target: "http://127.0.0.1:3000",
      port: 7312,
      projectKey: "content-hub",
      nodePath: process.execPath,
      cliPath: import.meta.filename,
    });
    expect(output.join("\n")).toContain(
      "target development server is not managed",
    );
    expect(manager.install).toHaveBeenCalledWith(expect.any(Object), {
      force: true,
      forceRecoverStaleWorker: true,
    });
    expect(
      program.commands
        .find((command) => command.name() === "service")
        ?.commands.find((command) => command.name() === "install")
        ?.options.some((option) =>
          (option.long ?? "").includes("target-command"),
        ),
    ).toBe(false);
  });

  it("passes the explicit force flag to destructive lifecycle commands", async () => {
    const repositoryRoot = await createRepository();
    const manager = fakeController();
    const program = new Command().exitOverride();
    registerServiceCommands(program, {
      manager,
      cwd: () => repositoryRoot,
      log: () => undefined,
    });

    await program.parseAsync([
      "node",
      "visual-intent",
      "service",
      "stop",
      "--force",
    ]);

    expect(manager.stop).toHaveBeenCalledWith(repositoryRoot, { force: true });
  });

  it("keeps stale worker recovery separate and explicit", async () => {
    const repositoryRoot = await createRepository();
    const manager = fakeController();
    const program = new Command().exitOverride();
    registerServiceCommands(program, {
      manager,
      cwd: () => repositoryRoot,
      log: () => undefined,
    });

    await program.parseAsync([
      "node",
      "visual-intent",
      "service",
      "start",
      "--force-recover-stale-worker",
    ]);

    expect(manager.start).toHaveBeenCalledWith(repositoryRoot, {
      force: false,
      forceRecoverStaleWorker: true,
    });
  });
});

function fakeController(): ServiceController {
  const fallback = statusFor({
    label: "com.prodaction.visual-intent.project.example.000000000000",
    repositoryRoot: "/workspace/example",
    target: "http://127.0.0.1:3000",
    host: "127.0.0.1",
    port: 7310,
  });
  return {
    install: vi.fn(async () => fallback),
    start: vi.fn(async () => fallback),
    stop: vi.fn(async () => fallback),
    restart: vi.fn(async () => fallback),
    status: vi.fn(async () => fallback),
    uninstall: vi.fn(async () => ({
      label: fallback.label,
      stopped: false,
      removedPlist: false,
      removedDerivedState: [],
      preservedServiceConfig: "/workspace/example/.visual-intent/service.json",
      preservedLogs: ["out.log", "err.log"],
    })),
    logs: vi.fn(async () => ({
      homeDirectory: "/workspace",
      plistPath: "agent.plist",
      logsDirectory: "logs",
      standardOutputPath: "out.log",
      standardErrorPath: "err.log",
    })),
  };
}

function statusFor(
  config: Pick<
    VisualIntentServiceConfig,
    "label" | "repositoryRoot" | "target" | "host" | "port"
  >,
): ServiceStatus {
  return {
    label: config.label,
    repositoryRoot: config.repositoryRoot,
    target: config.target,
    proxyUrl: `http://${config.host}:${config.port}`,
    installed: true,
    loaded: true,
    running: true,
    pid: 4242,
    busyApply: false,
    busyBatchIds: [],
    plistPath: "agent.plist",
    standardOutputPath: "out.log",
    standardErrorPath: "err.log",
  };
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-service-cli-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}
