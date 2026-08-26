import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

import {
  loadAndPreflightConnection,
  validateConnection,
} from "../scripts/connection-preflight.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

test("preflight accepts the exact daemon process and project session", async () => {
  const repositoryRoot = await createRepository();
  const connection = validConnection(repositoryRoot);
  await writeConnection(repositoryRoot, connection);

  const result = await loadAndPreflightConnection(repositoryRoot, {
    fetchImpl: async () =>
      Response.json({
        ok: true,
        service: "visual-intent",
        protocolVersion: "0.1",
        daemonInstanceId: connection.daemonInstanceId,
        session: {
          id: connection.sessionId,
          projectKey: connection.projectKey,
          repository: { root: repositoryRoot },
        },
      }),
  });

  assert.deepEqual(result, connection);
});

test("preflight rejects a reused port owned by another daemon", async () => {
  const repositoryRoot = await createRepository();
  const connection = validConnection(repositoryRoot);
  await writeConnection(repositoryRoot, connection);

  await assert.rejects(
    loadAndPreflightConnection(repositoryRoot, {
      fetchImpl: async () =>
        Response.json({
          ok: true,
          service: "visual-intent",
          protocolVersion: "0.1",
          daemonInstanceId: "another-daemon",
          session: {
            id: connection.sessionId,
            projectKey: connection.projectKey,
            repository: { root: repositoryRoot },
          },
        }),
    }),
    /stale_connection: the daemon at this port is a different process/u,
  );
});

test("connection validation rejects non-loopback and mismatched roots", async () => {
  const repositoryRoot = await createRepository();
  assert.throws(
    () =>
      validateConnection(
        {
          ...validConnection(repositoryRoot),
          daemonUrl: "https://example.com",
        },
        repositoryRoot,
      ),
    /stale_connection/u,
  );
  assert.throws(
    () =>
      validateConnection(
        { ...validConnection(repositoryRoot), repositoryRoot: "/tmp/other" },
        repositoryRoot,
      ),
    /stale_connection/u,
  );
});

test("plugin finish_batch schema requires at least one task result", () => {
  const proxyPath = new URL("../scripts/mcp-proxy.mjs", import.meta.url);
  const child = spawnSync(process.execPath, [proxyPath.pathname], {
    encoding: "utf8",
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
  });
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(child.stdout.trim());
  const finish = response.result.tools.find(
    (tool) => tool.name === "visual_intent_finish_batch",
  );
  assert.ok(finish);
  assert.ok(finish.inputSchema.required.includes("taskResults"));
  assert.equal(finish.inputSchema.properties.taskResults.minItems, 1);
});

async function createRepository() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "vi-preflight-"));
  temporaryDirectories.push(repositoryRoot);
  await mkdir(join(repositoryRoot, ".visual-intent"));
  return realpath(repositoryRoot);
}

function validConnection(repositoryRoot) {
  return {
    protocolVersion: "0.1",
    daemonUrl: "http://127.0.0.1:7310",
    apiToken: "a".repeat(48),
    projectKey: "example",
    repositoryRoot,
    sessionId: "session-example",
    daemonInstanceId: "daemon-example",
  };
}

async function writeConnection(repositoryRoot, connection) {
  await writeFile(
    join(repositoryRoot, ".visual-intent", "connection.json"),
    `${JSON.stringify(connection)}\n`,
  );
}
