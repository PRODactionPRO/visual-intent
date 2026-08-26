import { describe, expect, it } from "vitest";

import { TaskSchema } from "@visual-intent/protocol";

import { VisualIntentClient } from "../src/index.js";

const task = TaskSchema.parse({
  protocolVersion: "0.1",
  kind: "code-change",
  id: "task-sdk",
  status: "applied",
  surface: {
    id: "surface-sdk",
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
    id: "intent-sdk",
    action: "change",
    instruction: "Move the button",
    acceptanceCriteria: [],
  },
  iterationId: "task-sdk",
  rootTaskId: "task-sdk",
  round: 1,
  revision: 2,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:05:00.000Z",
});

describe("VisualIntentClient analytics and review", () => {
  it("reads filtered events and executions", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const request = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input, init });
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new VisualIntentClient({
      baseUrl: "http://127.0.0.1:7310",
      fetch: request,
    });

    await client.listEvents({
      since: "2026-08-01T00:00:00.000Z",
      type: "task.reviewed",
    });
    await client.listExecutions({ batchId: "batch-sdk" });

    expect(String(requests[0]?.input)).toContain(
      "/events?since=2026-08-01T00%3A00%3A00.000Z&type=task.reviewed",
    );
    expect(String(requests[1]?.input)).toContain(
      "/executions?batchId=batch-sdk",
    );
  });

  it("sends an optimistic review and parses the reviewed task", async () => {
    const reviewed = TaskSchema.parse({
      ...task,
      review: {
        outcome: "accepted",
        reviewedAt: "2026-08-24T00:10:00.000Z",
      },
      revision: 3,
      updatedAt: "2026-08-24T00:10:00.000Z",
    });
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const request = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input, init });
      return new Response(JSON.stringify({ task: reviewed }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new VisualIntentClient({
      fetch: request,
      apiToken: "token-sdk",
    });

    const result = await client.reviewTask(task.id, {
      expectedRevision: task.revision,
      outcome: "accepted",
    });

    expect(result.task.review?.outcome).toBe("accepted");
    const init = requests[0]?.init;
    if (!init) throw new Error("Expected request options");
    expect(new Headers(init.headers).get("x-visual-intent-token")).toBe(
      "token-sdk",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 2,
      outcome: "accepted",
    });
  });

  it("sends an independent optimistic star rating", async () => {
    const rated = TaskSchema.parse({
      ...task,
      rating: {
        value: 4,
        ratedAt: "2026-08-24T00:10:00.000Z",
      },
      revision: 3,
      updatedAt: "2026-08-24T00:10:00.000Z",
    });
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const request = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input, init });
      return new Response(JSON.stringify(rated), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new VisualIntentClient({
      baseUrl: "http://127.0.0.1:7310",
      fetch: request,
      apiToken: "token-sdk",
    });

    const result = await client.rateTask(task.id, {
      expectedRevision: task.revision,
      value: 4,
    });

    expect(result.rating?.value).toBe(4);
    expect(String(requests[0]?.input)).toBe(
      "http://127.0.0.1:7310/_visual-intent/api/tasks/task-sdk/rating",
    );
    const init = requests[0]?.init;
    if (!init) throw new Error("Expected request options");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("x-visual-intent-token")).toBe(
      "token-sdk",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 2,
      value: 4,
    });
  });

  it("sends a continuation answer when retrying a needs-input batch", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const request = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input, init });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new VisualIntentClient({
      fetch: request,
      controllerThreadId: "thread-sdk-controller",
    });

    await expect(
      client.retryBatch("batch-sdk", { answer: "Use the compact variant" }),
    ).rejects.toThrow();

    const init = requests[0]?.init;
    if (!init) throw new Error("Expected request options");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(
      new Headers(init.headers).get("x-visual-intent-controller-thread"),
    ).toBe("thread-sdk-controller");
    expect(JSON.parse(String(init.body))).toEqual({
      answer: "Use the compact variant",
    });
  });
});
