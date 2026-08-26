import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";

import { resolveCodexThreadId } from "./session-context.mjs";
import { loadAndPreflightConnection } from "./connection-preflight.mjs";

let connection;
const batchClaims = new Map();

const tools = [
  {
    name: "visual_intent_attach_project",
    description:
      "Attach this Codex thread to the running Visual Intent session for an exact repository root.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryRoot: { type: "string" },
        threadId: { type: "string" },
      },
      required: ["repositoryRoot"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_get_session",
    description:
      "Get the connected Visual Intent project, controller and active executor state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_list_tasks",
    description: "List visual tasks for the connected project session.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_get_task",
    description:
      "Get one visual task with selector, region, and instruction context.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_list_batches",
    description:
      "List Apply batches and their execution status for the connected project.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_list_executions",
    description:
      "List append-only Apply execution receipts and exact usage when available.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        batchId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_list_events",
    description: "List privacy-safe local Visual Intent lifecycle events.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_retry_batch",
    description:
      "Retry a needs-input or failed Apply batch after its blocking condition is resolved.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        answer: { type: "string", maxLength: 12000 },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_approve_dirty_batch",
    description:
      "Continue one needs-input Apply batch over the exact dirty-worktree baseline shown to the user. Use only after explicit user approval.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        expectedBaselineFingerprint: { type: "string" },
      },
      required: ["id", "expectedBaselineFingerprint"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_claim_batch",
    description:
      "Atomically claim one host-attached waiting Apply batch before editing the project. Autonomous SDK-worker batches cannot be claimed here.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_finish_batch",
    description:
      "Finish a host-attached claimed batch and save its implementation result. Autonomous SDK-worker batches finish inside the daemon.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: {
          type: "string",
          enum: ["completed", "needs_input", "failed"],
        },
        summary: { type: "string" },
        changedFiles: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
        executionId: { type: "string" },
        claimId: { type: "string" },
        expectedAttempt: { type: "number" },
        taskResults: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              taskId: { type: "string" },
              status: {
                type: "string",
                enum: ["completed", "needs_input", "failed"],
              },
              summary: { type: "string" },
              changedFiles: { type: "array", items: { type: "string" } },
              notes: { type: "array", items: { type: "string" } },
              classification: {
                type: "object",
                properties: {
                  categories: {
                    type: "array",
                    minItems: 1,
                    uniqueItems: true,
                    items: {
                      type: "string",
                      enum: [
                        "style",
                        "layout",
                        "text",
                        "behavior",
                        "bug",
                        "image",
                        "figma",
                        "unknown",
                      ],
                    },
                  },
                  scale: {
                    type: "string",
                    enum: [
                      "element",
                      "region",
                      "screen",
                      "multi-screen",
                      "system",
                      "unknown",
                    ],
                  },
                },
                required: ["categories", "scale"],
                additionalProperties: false,
              },
            },
            required: [
              "taskId",
              "status",
              "summary",
              "changedFiles",
              "notes",
              "classification",
            ],
            additionalProperties: false,
          },
        },
      },
      required: [
        "id",
        "status",
        "summary",
        "changedFiles",
        "notes",
        "taskResults",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "visual_intent_review_task",
    description:
      "Record a verdict for an applied task. needs_revision atomically creates the next ready round; not_accepted does not roll files back.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        expectedRevision: { type: "number" },
        outcome: {
          type: "string",
          enum: ["accepted", "needs_revision", "not_accepted"],
        },
        note: { type: "string" },
        revision: {
          type: "object",
          properties: {
            instruction: { type: "string" },
            attachments: { type: "array", items: { type: "object" } },
          },
          required: ["instruction"],
          additionalProperties: false,
        },
      },
      required: ["id", "expectedRevision", "outcome"],
      additionalProperties: false,
    },
  },
];

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.id === undefined) continue;
  try {
    const result = await handleRequest(request);
    respond({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    respond({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "visual-intent", version: "0.1.0" },
      instructions:
        "Attach an exact repository before using project tools. Never work on tasks whose server-owned repository differs from the current Codex project.",
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") {
    return callTool(
      request.params?.name,
      request.params?.arguments ?? {},
      request.params?._meta,
    );
  }
  throw new Error(`Unsupported MCP method ${request.method}`);
}

async function callTool(name, input, requestMeta) {
  try {
    let value;
    switch (name) {
      case "visual_intent_attach_project":
        value = await attachProject(input, requestMeta);
        break;
      case "visual_intent_get_session":
        value = await api("/session");
        break;
      case "visual_intent_list_tasks":
        value = await api(
          `/tasks${input.status ? `?status=${encodeURIComponent(input.status)}` : ""}`,
        );
        break;
      case "visual_intent_get_task":
        value = await api(`/tasks/${encodeURIComponent(input.id)}`);
        break;
      case "visual_intent_list_batches":
        value = await api("/batches");
        break;
      case "visual_intent_list_executions": {
        const query = new URLSearchParams();
        if (input.since) query.set("since", input.since);
        if (input.batchId) query.set("batchId", input.batchId);
        value = await api(
          `/executions${query.size > 0 ? `?${query.toString()}` : ""}`,
        );
        break;
      }
      case "visual_intent_list_events":
        value = await api(
          `/events${input.since ? `?since=${encodeURIComponent(input.since)}` : ""}`,
        );
        break;
      case "visual_intent_retry_batch":
        value = await api(`/batches/${encodeURIComponent(input.id)}/retry`, {
          method: "POST",
          ...(input.answer
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ answer: input.answer }),
              }
            : {}),
        });
        break;
      case "visual_intent_approve_dirty_batch":
        value = await api(
          `/batches/${encodeURIComponent(input.id)}/approve-dirty`,
          {
            method: "POST",
            body: JSON.stringify({
              expectedBaselineFingerprint: input.expectedBaselineFingerprint,
              source: "mcp",
            }),
          },
        );
        break;
      case "visual_intent_claim_batch":
        value = await api(`/batches/${encodeURIComponent(input.id)}/claim`, {
          method: "POST",
        });
        if (value?.batch?.claim?.id) {
          batchClaims.set(input.id, {
            claimId: value.batch.claim.id,
            expectedAttempt: value.batch.attempt,
          });
        }
        break;
      case "visual_intent_finish_batch": {
        const claim =
          batchClaims.get(input.id) ??
          (input.claimId && input.expectedAttempt
            ? {
                claimId: input.claimId,
                expectedAttempt: input.expectedAttempt,
              }
            : undefined);
        if (!claim) {
          throw new Error(
            "Claim this batch in the current Codex task before finishing it",
          );
        }
        value = await api(`/batches/${encodeURIComponent(input.id)}/finish`, {
          method: "POST",
          body: JSON.stringify({
            status: input.status,
            claim,
            result: {
              summary: input.summary,
              changedFiles: input.changedFiles,
              notes: input.notes,
              ...(input.executionId ? { executionId: input.executionId } : {}),
              ...(input.taskResults ? { taskResults: input.taskResults } : {}),
            },
          }),
        });
        batchClaims.delete(input.id);
        break;
      }
      case "visual_intent_review_task":
        value = await api(`/tasks/${encodeURIComponent(input.id)}/review`, {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: input.expectedRevision,
            outcome: input.outcome,
            ...(input.note ? { note: input.note } : {}),
            ...(input.revision ? { revision: input.revision } : {}),
          }),
        });
        break;
      default:
        throw new Error(`Unknown Visual Intent tool ${name}`);
    }
    return content(value);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

async function attachProject(input, requestMeta) {
  connection = undefined;
  batchClaims.clear();
  const repositoryRoot = await realpath(input.repositoryRoot);
  const candidate = await loadAndPreflightConnection(repositoryRoot);
  const threadId = resolveCodexThreadId({
    explicit: input.threadId,
    requestMeta,
  });
  if (!threadId) {
    throw new Error(
      "Codex task id is unavailable in the MCP context; pass threadId explicitly",
    );
  }
  const attached = await apiWithConnection(candidate, "/session/attach", {
    method: "POST",
    body: JSON.stringify({
      repositoryRoot,
      threadId,
      ownership: "host-attached",
      source: "plugin",
    }),
  });
  connection = { ...candidate, controllerThreadId: threadId };
  return attached;
}

async function api(path, init = {}) {
  if (!connection) {
    throw new Error("Call visual_intent_attach_project first");
  }
  return apiWithConnection(connection, path, init);
}

async function apiWithConnection(activeConnection, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-visual-intent-token", activeConnection.apiToken);
  if (activeConnection.controllerThreadId) {
    headers.set(
      "x-visual-intent-controller-thread",
      activeConnection.controllerThreadId,
    );
  }
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(
    `${activeConnection.daemonUrl.replace(/\/$/, "")}/_visual-intent/api${path}`,
    { ...init, headers, signal: AbortSignal.timeout(5000) },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

function content(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
