import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { AttachmentSchema, type Attachment } from "@visual-intent/protocol";

const SAFE_ID = /^[a-zA-Z0-9-]+$/u;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "text/plain": ".txt",
  "application/json": ".json",
  "application/pdf": ".pdf",
};

export interface SaveAttachmentInput {
  body: Buffer;
  kind: Attachment["kind"];
  mimeType: string;
  fileName: string;
  width?: number;
  height?: number;
}

export class ProjectAttachmentStore {
  private readonly directory: string;

  constructor(private readonly repositoryRoot: string) {
    this.directory = join(repositoryRoot, ".visual-intent", "attachments");
  }

  async save(input: SaveAttachmentInput): Promise<Attachment> {
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID();
    const extension = extensionFor(input.mimeType, input.fileName);
    const absolutePath = join(this.directory, `${id}${extension}`);
    const metadataPath = join(this.directory, `${id}.meta.json`);
    const createdAt = new Date().toISOString();
    const attachment = AttachmentSchema.parse({
      id,
      kind: input.kind,
      mimeType: input.mimeType,
      fileName: safeFileName(input.fileName, `attachment${extension}`),
      byteSize: input.body.byteLength,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      path: relative(this.repositoryRoot, absolutePath),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      createdAt,
    });

    await writeFile(absolutePath, input.body, { flag: "wx", mode: 0o600 });
    await writeFile(metadataPath, `${JSON.stringify(attachment, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return attachment;
  }

  async get(id: string): Promise<{ metadata: Attachment; body: Buffer }> {
    assertSafeId(id);
    const metadata = AttachmentSchema.parse(
      JSON.parse(
        await readFile(join(this.directory, `${id}.meta.json`), "utf8"),
      ),
    );
    if (metadata.id !== id) throw new Error("Attachment metadata mismatch");
    const body = await readFile(join(this.repositoryRoot, metadata.path));
    if (body.byteLength !== metadata.byteSize) {
      throw new Error("Attachment size mismatch");
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== metadata.sha256) {
      throw new Error("Attachment checksum mismatch");
    }
    return { metadata, body };
  }

  async assertOwned(attachment: Attachment): Promise<Attachment> {
    const stored = (await this.get(attachment.id)).metadata;
    if (JSON.stringify(stored) !== JSON.stringify(attachment)) {
      throw new Error(`Attachment ${attachment.id} is not server-owned`);
    }
    return stored;
  }

  async delete(id: string): Promise<void> {
    const { metadata } = await this.get(id);
    await rm(join(this.repositoryRoot, metadata.path));
    await rm(join(this.directory, `${id}.meta.json`));
  }
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error("Invalid attachment id");
}

function extensionFor(mimeType: string, fileName: string): string {
  const known = MIME_EXTENSIONS[mimeType.toLowerCase()];
  if (known) return known;
  const candidate = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(candidate) ? candidate : ".bin";
}

function safeFileName(value: string, fallback: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  return normalized ? normalized.slice(0, 180) : fallback;
}
