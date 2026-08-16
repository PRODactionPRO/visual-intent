import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { TaskStore } from "@visual-intent/core";

import { createMcpServer } from "../src/index.js";

const closeAfterTest: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeAfterTest.splice(0).map((close) => close()));
});

describe("MCP bridge", () => {
  it("negotiates MCP and exposes the visual task tools", async () => {
    const store: TaskStore = {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async create() {
        throw new Error("not used");
      },
      async update() {
        throw new Error("not used");
      },
    };
    const server = createMcpServer(store);
    const client = new Client({ name: "visual-intent-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeAfterTest.push(
      () => client.close(),
      () => server.close(),
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "visual_intent_list_tasks",
      "visual_intent_get_task",
      "visual_intent_update_task",
    ]);

    const result = await client.callTool({
      name: "visual_intent_list_tasks",
      arguments: {},
    });
    expect(result.content).toEqual([{ type: "text", text: "[]" }]);
  });
});
