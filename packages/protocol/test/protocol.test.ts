import { describe, expect, it } from "vitest";

import { CreateTaskSchema, PROTOCOL_VERSION } from "../src/index.js";

describe("CreateTaskSchema", () => {
  it("accepts a platform-neutral web task", () => {
    const now = new Date().toISOString();
    const result = CreateTaskSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://127.0.0.1:7310",
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        adapter: { name: "web-overlay", version: "0.1.0" },
      },
      nodes: [
        {
          id: "node-1",
          surfaceId: "surface-1",
          kind: "element",
          stableSelector: "main > button:nth-of-type(1)",
        },
      ],
      frames: [
        {
          id: "frame-1",
          surfaceId: "surface-1",
          x: 0,
          y: 0,
          width: 1280,
          height: 720,
          scrollX: 0,
          scrollY: 0,
          scale: 2,
        },
      ],
      annotations: [
        {
          id: "annotation-1",
          kind: "comment",
          body: "Increase spacing",
          createdAt: now,
        },
      ],
      intent: {
        id: "intent-1",
        action: "change",
        instruction: "Increase spacing",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an empty instruction", () => {
    const result = CreateTaskSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      surface: {
        id: "surface-1",
        platform: "web",
        uri: "http://localhost",
        adapter: { name: "test", version: "0.1.0" },
      },
      intent: { id: "intent-1", action: "change", instruction: "" },
    });

    expect(result.success).toBe(false);
  });
});
