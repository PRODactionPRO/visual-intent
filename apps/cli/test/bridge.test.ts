import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileTaskStore } from "@visual-intent/file-store";

import { ProjectAttachmentStore } from "../src/attachment-store.js";
import { registerBridgeSession } from "../src/bridge-registry.js";
import { startBridge } from "../src/bridge.js";
import { startDaemon } from "../src/daemon.js";

const closeAfterTest: Array<() => Promise<void>> = [];
const removeAfterTest: string[] = [];

afterEach(async () => {
  await Promise.all(closeAfterTest.splice(0).map((close) => close()));
  await Promise.all(
    removeAfterTest
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Chrome extension Bridge", () => {
  it("pairs locally and routes a reference task to one active project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-intent-bridge-"));
    removeAfterTest.push(directory);
    const repositoryRoot = join(directory, "project");
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>Target</body></html>");
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Target server did not start");
    }
    closeAfterTest.push(
      () =>
        new Promise<void>((resolve, reject) =>
          target.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const store = new FileTaskStore(join(directory, "tasks.json"), {
      root: repositoryRoot,
      name: "project",
    });
    await store.configureSession({
      projectKey: "project",
      displayName: "Project",
      repository: { root: repositoryRoot, name: "project" },
      targetUrl: `http://127.0.0.1:${targetAddress.port}`,
      proxyUrl: "http://127.0.0.1:0",
    });
    const daemonToken = "a".repeat(48);
    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      target: `http://127.0.0.1:${targetAddress.port}`,
      store,
      apiToken: daemonToken,
      attachmentStore: new ProjectAttachmentStore(repositoryRoot),
    });
    closeAfterTest.push(() => daemon.close());
    const session = await store.configureSession({
      projectKey: "project",
      displayName: "Project",
      repository: { root: repositoryRoot, name: "project" },
      targetUrl: daemon.target,
      proxyUrl: `http://${daemon.host}:${daemon.port}`,
    });
    await registerBridgeSession(
      session,
      `http://${daemon.host}:${daemon.port}`,
      daemonToken,
      directory,
    );

    const bridge = await startBridge({
      host: "127.0.0.1",
      port: 0,
      dataDirectory: directory,
    });
    closeAfterTest.push(() => bridge.close());
    const bridgeUrl = `http://${bridge.host}:${bridge.port}`;
    const unauthorized = await fetch(`${bridgeUrl}/api/sessions`);
    expect(unauthorized.status).toBe(401);

    const pairing = await fetch(`${bridgeUrl}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: bridge.pairingCode }),
    });
    const { apiToken } = (await pairing.json()) as { apiToken: string };
    const headers = { authorization: `Bearer ${apiToken}` };
    const sessions = (await (
      await fetch(`${bridgeUrl}/api/sessions`, { headers })
    ).json()) as Array<{ id: string; displayName: string }>;
    expect(sessions).toEqual([
      expect.objectContaining({ id: session.id, displayName: "Project" }),
    ]);

    const upload = await fetch(
      `${bridgeUrl}/api/sessions/${encodeURIComponent(session.id)}/attachments?fileName=reference.png`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "image/png" },
        body: new Uint8Array(Buffer.from("89504e470d0a1a0a00000000", "hex")),
      },
    );
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()) as Record<string, unknown>;

    const created = await fetch(
      `${bridgeUrl}/api/sessions/${encodeURIComponent(session.id)}/tasks`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0.1",
          surface: {
            id: "surface-1",
            platform: "web",
            uri: "https://example.com/card",
            adapter: { name: "visual-intent-chrome", version: "0.1.0" },
          },
          nodes: [
            {
              id: "node-1",
              surfaceId: "surface-1",
              kind: "element",
              name: "article",
              attributes: { "css:display": "grid" },
            },
          ],
          attachments: [attachment],
          intent: {
            id: "intent-1",
            action: "change",
            instruction: "Use this card as a visual reference",
          },
        }),
      },
    );
    expect(created.status).toBe(201);
    expect(await store.list({ status: "ready" })).toHaveLength(1);
  });
});
