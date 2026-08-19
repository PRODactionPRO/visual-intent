import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectAttachmentStore } from "../src/attachment-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ProjectAttachmentStore", () => {
  it("owns the path and verifies attachment metadata", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "visual-intent-attachments-"),
    );
    temporaryDirectories.push(repositoryRoot);
    const store = new ProjectAttachmentStore(repositoryRoot);
    const body = Buffer.from("example image");

    const attachment = await store.save({
      body,
      kind: "screenshot",
      mimeType: "image/png",
      fileName: "../unsafe.png",
      width: 320,
      height: 180,
    });

    expect(attachment.path).toMatch(
      /^\.visual-intent\/attachments\/[a-z0-9-]+\.png$/u,
    );
    expect(attachment.fileName).toBe("unsafe.png");
    expect(await readFile(join(repositoryRoot, attachment.path))).toEqual(body);
    await expect(store.assertOwned(attachment)).resolves.toEqual(attachment);
    await expect(
      store.assertOwned({ ...attachment, path: "../../outside.png" }),
    ).rejects.toThrow("server-owned");
  });

  it("deletes both the binary and its metadata", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "visual-intent-attachments-"),
    );
    temporaryDirectories.push(repositoryRoot);
    const store = new ProjectAttachmentStore(repositoryRoot);
    const attachment = await store.save({
      body: Buffer.from("notes"),
      kind: "file",
      mimeType: "text/plain",
      fileName: "notes.txt",
    });

    await store.delete(attachment.id);

    await expect(store.get(attachment.id)).rejects.toThrow();
  });
});
