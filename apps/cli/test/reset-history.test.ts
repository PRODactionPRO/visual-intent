import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileTaskStore } from "@visual-intent/file-store";
import type { CreateTask } from "@visual-intent/protocol";

import { resetProjectHistory } from "../src/reset-history.js";

const temporaryDirectories: string[] = [];

const taskInput: CreateTask = {
  protocolVersion: "0.1",
  kind: "code-change",
  surface: {
    id: "surface-reset-cli",
    platform: "web",
    uri: "http://localhost",
    adapter: { name: "test", version: "0.1.0" },
  },
  nodes: [],
  regions: [],
  frames: [],
  relations: [],
  annotations: [],
  attachments: [],
  intent: {
    id: "intent-reset-cli",
    action: "change",
    instruction: "Reset me",
    acceptanceCriteria: [],
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("resetProjectHistory", () => {
  it("requires explicit --yes confirmation before touching local history", async () => {
    const repositoryRoot = await makeRepository("confirmation");
    const markerPath = join(repositoryRoot, ".visual-intent", "marker.txt");
    await writeFile(markerPath, "keep\n");

    await expect(
      resetProjectHistory({ repo: repositoryRoot, confirmed: false }),
    ).rejects.toThrow("requires --yes");
    expect(await readFile(markerPath, "utf8")).toBe("keep\n");
  });

  it("resets only the explicitly selected repository", async () => {
    const selectedRoot = await makeRepository("selected");
    const otherRoot = await makeRepository("other");
    const selectedStore = await makeTaskStore(selectedRoot);
    const otherStore = await makeTaskStore(otherRoot);
    await selectedStore.create(taskInput);
    await otherStore.create({
      ...taskInput,
      surface: { ...taskInput.surface, id: "surface-other" },
      intent: { ...taskInput.intent, id: "intent-other" },
    });
    await mkdir(join(selectedRoot, ".visual-intent", "attachments"));
    await writeFile(
      join(selectedRoot, ".visual-intent", "attachments", "image.png"),
      "image",
    );

    const result = await resetProjectHistory({
      repo: selectedRoot,
      confirmed: true,
    });

    expect(result).toMatchObject({
      repositoryRoot: await realpath(selectedRoot),
      tasks: 1,
    });
    expect(await selectedStore.list()).toEqual([]);
    expect(await otherStore.list()).toHaveLength(1);
    await expect(
      access(join(selectedRoot, ".visual-intent", "attachments")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(otherRoot, ".visual-intent", "tasks.json")),
    ).resolves.toBeUndefined();
  });
});

async function makeRepository(name: string): Promise<string> {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), `visual-intent-reset-${name}-`),
  );
  temporaryDirectories.push(repositoryRoot);
  await mkdir(join(repositoryRoot, ".visual-intent"));
  return repositoryRoot;
}

async function makeTaskStore(repositoryRoot: string): Promise<FileTaskStore> {
  return new FileTaskStore(
    join(repositoryRoot, ".visual-intent", "tasks.json"),
    { root: repositoryRoot, name: "reset-test" },
  );
}
