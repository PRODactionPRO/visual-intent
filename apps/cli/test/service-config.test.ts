import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createServiceConfig,
  readServiceConfig,
  serviceConfigPath,
  serviceLabel,
  writeServiceConfig,
} from "../src/service-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Visual Intent service config", () => {
  it("creates a stable repository-scoped LaunchAgent label", async () => {
    const firstRoot = await createRepository("Service Project");
    const secondRoot = await createRepository("Another Project");

    const first = serviceLabel(firstRoot, "Люди могут");
    const repeated = serviceLabel(firstRoot, "Люди могут");
    const second = serviceLabel(secondRoot, "Люди могут");

    expect(first).toMatch(
      /^com\.prodaction\.visual-intent\.project\.project\.[a-f0-9]{12}$/u,
    );
    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
  });

  it("writes service.json atomically with owner-only permissions", async () => {
    const repositoryRoot = await createRepository("visual-intent-config");
    const config = await createConfig(repositoryRoot);

    const path = await writeServiceConfig(config);
    const stored = await readServiceConfig(repositoryRoot);

    expect(path).toBe(serviceConfigPath(repositoryRoot));
    expect(stored).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("rejects a service config copied from another repository", async () => {
    const repositoryRoot = await createRepository("source");
    const otherRoot = await createRepository("destination");
    const config = await createConfig(repositoryRoot);
    await writeServiceConfig(config);
    const copiedPath = serviceConfigPath(otherRoot);
    await mkdir(join(otherRoot, ".visual-intent"), { recursive: true });
    await writeFile(
      copiedPath,
      await readFile(serviceConfigPath(repositoryRoot), "utf8"),
      "utf8",
    );

    await expect(readServiceConfig(otherRoot)).rejects.toThrow(
      `belongs to ${repositoryRoot}`,
    );
  });

  it("accepts only a localhost target origin and a fixed service port", async () => {
    const repositoryRoot = await createRepository("validation");
    await expect(
      createConfig(repositoryRoot, { target: "http://127.0.0.1:3000/admin" }),
    ).rejects.toThrow("origin only");
    await expect(
      createConfig(repositoryRoot, { target: "https://example.com" }),
    ).rejects.toThrow("localhost");
    await expect(createConfig(repositoryRoot, { port: 0 })).rejects.toThrow(
      "between 1 and 65535",
    );
    await expect(
      createConfig(repositoryRoot, { target: "http://[::1]:3000" }),
    ).resolves.toEqual(
      expect.objectContaining({ target: "http://[::1]:3000" }),
    );
  });
});

async function createRepository(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

async function createConfig(
  repositoryRoot: string,
  overrides: Partial<{
    target: string;
    port: number;
  }> = {},
) {
  return createServiceConfig({
    repositoryRoot,
    target: overrides.target ?? "http://127.0.0.1:3000",
    host: "127.0.0.1",
    port: overrides.port ?? 7310,
    projectKey: "example",
    displayName: "Example",
    executor: "isolated-worker",
    allowDirty: true,
    nodePath: process.execPath,
    cliPath: import.meta.filename,
    now: new Date("2026-08-26T00:00:00.000Z"),
  });
}
