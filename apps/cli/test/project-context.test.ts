import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureProjectContext,
  ensureProjectContext,
  projectContextPath,
  readProjectContext,
} from "../src/project-context.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("project context", () => {
  it("creates one local Russian template without overwriting user context", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "visual-intent-context-"),
    );
    temporaryDirectories.push(repositoryRoot);

    const path = await ensureProjectContext(repositoryRoot, "Example");
    expect(path).toBe(projectContextPath(repositoryRoot));
    expect(await readProjectContext(repositoryRoot)).toContain(
      "# Контекст проекта Example",
    );

    await writeFile(path, "# Мой контекст\n\nНе перезаписывать.\n", "utf8");
    await ensureProjectContext(repositoryRoot, "Changed name");

    expect(await readFile(path, "utf8")).toBe(
      "# Мой контекст\n\nНе перезаписывать.\n",
    );
  });

  it("returns undefined before the context file exists", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "visual-intent-context-"),
    );
    temporaryDirectories.push(repositoryRoot);

    await expect(readProjectContext(repositoryRoot)).resolves.toBeUndefined();
    await expect(
      captureProjectContext(repositoryRoot),
    ).resolves.toBeUndefined();
  });

  it("uses a stable content-derived revision for Apply snapshots", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "visual-intent-context-"),
    );
    temporaryDirectories.push(repositoryRoot);
    const path = await ensureProjectContext(repositoryRoot, "Example");

    const first = await captureProjectContext(repositoryRoot);
    const repeated = await captureProjectContext(repositoryRoot);
    expect(repeated).toEqual(first);

    await writeFile(path, "# Обновлённый контекст\n", "utf8");
    const changed = await captureProjectContext(repositoryRoot);
    expect(changed?.content).toBe("# Обновлённый контекст");
    expect(changed?.revision).not.toBe(first?.revision);
  });
});
