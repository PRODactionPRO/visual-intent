import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { CreateTask } from "@visual-intent/protocol";

import { FileTaskStore } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function makeStore(): Promise<FileTaskStore> {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-store-"));
  temporaryDirectories.push(directory);
  return new FileTaskStore(join(directory, "tasks.json"));
}

const input: CreateTask = {
  protocolVersion: "0.1",
  surface: {
    id: "surface-1",
    platform: "web",
    uri: "http://localhost",
    adapter: { name: "test", version: "0.1.0" },
  },
  nodes: [],
  regions: [],
  frames: [],
  relations: [],
  annotations: [],
  intent: {
    id: "intent-1",
    action: "change",
    instruction: "Move the button",
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

describe("FileTaskStore", () => {
  it("persists and updates tasks atomically", async () => {
    const store = await makeStore();
    const created = await store.create(input);
    const updated = await store.update(created.id, {
      expectedRevision: created.revision,
      status: "in_progress",
    });

    expect(updated.revision).toBe(2);
    expect((await store.list())[0]?.status).toBe("in_progress");

    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      tasks: Array<{ id: string }>;
    };
    expect(persisted.tasks[0]?.id).toBe(created.id);
  });
});
