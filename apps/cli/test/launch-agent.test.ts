import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLaunchAgentPlist,
  launchAgentPaths,
  readLaunchAgentBinding,
  serviceExecutablePath,
  serviceProgramArguments,
  writeLaunchAgentPlist,
} from "../src/launch-agent.js";
import {
  serviceLabel,
  type VisualIntentServiceConfig,
} from "../src/service-config.js";

describe("macOS LaunchAgent definition", () => {
  it("runs the absolute Node.js and CLI paths without a shell", () => {
    const config = createConfig();
    const argumentsList = serviceProgramArguments(config);

    expect(argumentsList.slice(0, 3)).toEqual([
      "/opt/node/bin/node",
      "/opt/visual-intent/dist/index.js",
      "start",
    ]);
    expect(argumentsList).toContain(config.repositoryRoot);
    expect(argumentsList).toContain(config.target);
    expect(argumentsList).toContain("--allow-dirty");
    expect(argumentsList).not.toContain("/bin/sh");
    expect(argumentsList).not.toContain("-c");
    expect(argumentsList).not.toContain("npm");
    expect(argumentsList).not.toContain("pnpm");
  });

  it("includes working directory, lifecycle settings, and persistent logs", () => {
    const config = createConfig();
    const paths = launchAgentPaths("/Users/test", config.label);
    const plist = buildLaunchAgentPlist(config, paths);

    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain(
      "<key>HOME</key>\n      <string>/Users/test</string>",
    );
    expect(plist).toContain(
      `<key>PATH</key>\n      <string>${serviceExecutablePath(config)}</string>`,
    );
    expect(plist).toContain(
      "<key>CODEX_HOME</key>\n      <string>/Users/test/.codex-custom</string>",
    );
    expect(plist).toContain(
      "<key>ExitTimeOut</key>\n    <integer>60</integer>",
    );
    expect(plist).toContain(paths.standardOutputPath);
    expect(plist).toContain(paths.standardErrorPath);
    expect(paths.plistPath).toBe(
      `/Users/test/Library/LaunchAgents/${config.label}.plist`,
    );
  });

  it("escapes user-visible values in plist XML", () => {
    const config = createConfig({ displayName: "R&D <Admin>" });
    const paths = launchAgentPaths("/Users/test", config.label);
    const plist = buildLaunchAgentPlist(config, paths);

    expect(plist).toContain("R&amp;D &lt;Admin&gt;");
    expect(plist).not.toContain("R&D <Admin>");
  });

  it("reads the reserved proxy binding from its own plist format", async () => {
    const config = createConfig();
    const paths = launchAgentPaths("/Users/test", config.label);
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-plist-"));
    try {
      const plistPath = join(directory, `${config.label}.plist`);
      await writeFile(plistPath, buildLaunchAgentPlist(config, paths), "utf8");

      await expect(readLaunchAgentBinding(plistPath)).resolves.toEqual({
        host: config.host,
        port: config.port,
        repositoryRoot: config.repositoryRoot,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent writer to claim a LaunchAgent plist", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-intent-plist-writer-"));
    const homeDirectory = join(root, "home");
    const first = createConfig();
    const second = createConfig({ displayName: "Competing install" });
    try {
      const outcomes = await Promise.allSettled([
        writeLaunchAgentPlist(first, homeDirectory),
        writeLaunchAgentPlist(second, homeDirectory),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(1);
      const paths = launchAgentPaths(homeDirectory, first.label);
      const plist = await readFile(paths.plistPath, "utf8");
      expect([
        buildLaunchAgentPlist(first, paths),
        buildLaunchAgentPlist(second, paths),
      ]).toContain(plist);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createConfig(
  overrides: Partial<VisualIntentServiceConfig> = {},
): VisualIntentServiceConfig {
  const repositoryRoot = "/Users/test/Projects/Example";
  const projectKey = "example";
  return {
    version: 1,
    label: serviceLabel(repositoryRoot, projectKey),
    repositoryRoot,
    projectKey,
    displayName: "Example",
    target: "http://127.0.0.1:3000",
    host: "127.0.0.1",
    port: 7310,
    executor: "isolated-worker",
    allowDirty: true,
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/visual-intent/dist/index.js",
    environmentPath: "/custom/bin:/usr/bin",
    codexHome: "/Users/test/.codex-custom",
    workerThread: "worker-123",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}
