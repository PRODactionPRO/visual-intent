import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Codex, ThreadItem } from "@openai/codex-sdk";

import {
  FileTaskStore,
  captureGitWorkingTreeBaseline,
} from "@visual-intent/file-store";
import type {
  BatchUsage,
  CreateTask,
  ObservedOperations,
} from "@visual-intent/protocol";

import {
  CodexDispatcher,
  SdkCodexRunner,
  findVisualIntentProjectSessionSkills,
  isolatedWorkerCodexConfig,
  type CodexRunOutput,
  type CodexRunner,
  type HostBatchDelivery,
} from "../src/dispatcher.js";
import {
  calculateOpenAiApiEquivalentCost,
  ISOLATED_WORKER_MODEL,
  ISOLATED_WORKER_REASONING_POLICY,
} from "../src/openai-api-equivalent-cost.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const input: CreateTask = {
  protocolVersion: "0.1",
  kind: "code-change",
  surface: {
    id: "surface-1",
    platform: "web",
    uri: "http://127.0.0.1:7310",
    adapter: { name: "test", version: "0.1.0" },
  },
  nodes: [],
  regions: [],
  frames: [],
  relations: [],
  annotations: [],
  attachments: [],
  intent: {
    id: "intent-1",
    action: "change",
    instruction: "Make the heading bolder",
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

async function createBatch(
  ownership: "host-attached" | "visual-intent-owned",
  workerThreadId?: string,
  taskInput: CreateTask = input,
  projectContext?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "visual-intent-dispatcher-"));
  temporaryDirectories.push(directory);
  const repositoryRoot = join(directory, "repository");
  await mkdir(repositoryRoot);
  await execFileAsync("git", ["init", "--quiet", repositoryRoot]);
  const repository = { root: repositoryRoot, name: "repository" };
  const store = new FileTaskStore(join(directory, "tasks.json"), repository, {
    captureWorkingTreeBaseline: () =>
      captureGitWorkingTreeBaseline(repositoryRoot),
    ...(projectContext
      ? {
          captureProjectContext: async () => ({
            revision: 1,
            content: projectContext,
          }),
        }
      : {}),
  });
  await store.configureSession({
    projectKey: "example",
    displayName: "Example",
    repository,
    targetUrl: "http://127.0.0.1:5173",
    proxyUrl: "http://127.0.0.1:7310",
    ...(ownership === "visual-intent-owned"
      ? {
          executor: {
            kind: "codex" as const,
            status: "connected" as const,
            ownership,
            source: "generated" as const,
            ...(workerThreadId ? { threadId: workerThreadId } : {}),
          },
        }
      : {}),
  });
  if (ownership === "host-attached") {
    await store.attachExecutor({
      repositoryRoot,
      threadId: "thread-host-owned",
      ownership,
      source: "plugin",
    });
  }
  const task = await store.create(taskInput);
  const batch = await store.dispatchReady();
  if (!batch) throw new Error("Expected Apply batch");
  return { repositoryRoot, store, batch, task };
}

const reportedUsage: BatchUsage = {
  availability: "reported",
  capture: "direct",
  provider: "openai",
  source: "openai-codex-sdk",
  scope: "apply-batch-turn",
  exact: true,
  tokens: {
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 10,
    outputTokens: 30,
    reasoningOutputTokens: 20,
  },
};

const completeOperations: ObservedOperations = {
  completeness: "complete",
  sdkTurns: 1,
  commandExecutions: 2,
  mcpToolCalls: 1,
  webSearches: 0,
  fileChangeOperations: 1,
  failedOperations: 0,
  uniqueChangedPaths: 1,
};

function completed(
  taskIds: string[],
  threadId = "thread-worker",
): CodexRunOutput {
  return {
    threadId,
    response: JSON.stringify({
      status: "completed",
      summary: "Updated the heading",
      changedFiles: ["src/page.tsx"],
      notes: [],
      taskResults: taskIds.map((taskId) => ({
        taskId,
        status: "completed",
        summary: "Updated the heading",
        changedFiles: ["src/page.tsx"],
        notes: [],
        classification: {
          categories: ["style", "layout"],
          scale: "element",
        },
      })),
    }),
    usage: reportedUsage,
    operations: completeOperations,
    startedAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:00:02.000Z",
  };
}

async function completedWithCanonicalDiff(
  repositoryRoot: string,
  taskIds: string[],
  threadId = "thread-worker",
): Promise<CodexRunOutput> {
  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "src/page.tsx"),
    "export const headingWeight = 700;\n",
  );
  return completed(taskIds, threadId);
}

function sdkWithTurn(turn: unknown) {
  const value = turn as {
    finalResponse?: string;
    usage?: Record<string, number> | null;
    items?: ThreadItem[];
    failure?: string;
  };
  const runStreamed = vi.fn().mockImplementation(async () => ({
    events: (async function* () {
      yield { type: "thread.started" as const, thread_id: "thread-sdk" };
      for (const item of value.items ?? []) {
        yield { type: "item.completed" as const, item };
      }
      if (value.finalResponse !== undefined) {
        yield {
          type: "item.completed" as const,
          item: {
            id: "agent-message",
            type: "agent_message" as const,
            text: value.finalResponse,
          },
        };
      }
      if (value.failure) {
        yield {
          type: "turn.failed" as const,
          error: { message: value.failure },
        };
      } else if (value.usage) {
        yield { type: "turn.completed" as const, usage: value.usage };
      }
    })(),
  }));
  const thread = { id: "thread-sdk", runStreamed };
  const startThread = vi.fn(() => thread);
  const resumeThread = vi.fn(() => thread);
  const codex = {
    startThread,
    resumeThread,
  } as unknown as Codex;
  return { codex, runStreamed, startThread, resumeThread };
}

describe("SdkCodexRunner", () => {
  it("disables every cached Visual Intent project-session skill without disabling other skills", async () => {
    const codexHome = await mkdtemp(
      join(tmpdir(), "visual-intent-codex-home-"),
    );
    temporaryDirectories.push(codexHome);
    const first = join(
      codexHome,
      "plugins/cache/personal/visual-intent/0.1.0/skills/project-session/SKILL.md",
    );
    const second = join(
      codexHome,
      "plugins/cache/team/visual-intent/0.2.0/skills/project-session/SKILL.md",
    );
    const unrelated = join(
      codexHome,
      "plugins/cache/personal/figma/1.0.0/skills/project-session/SKILL.md",
    );
    await Promise.all(
      [first, second, unrelated].map(async (path) => {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "# Test skill\n", "utf8");
      }),
    );

    expect(findVisualIntentProjectSessionSkills(codexHome)).toEqual([
      first,
      second,
    ]);
    expect(isolatedWorkerCodexConfig(codexHome)).toEqual({
      model: ISOLATED_WORKER_MODEL,
      model_reasoning_effort: ISOLATED_WORKER_REASONING_POLICY,
      skills: {
        config: [
          { path: first, enabled: false },
          { path: second, enabled: false },
        ],
      },
    });
    expect(JSON.stringify(isolatedWorkerCodexConfig(codexHome))).not.toContain(
      unrelated,
    );
  });

  it("uses an output schema without unsupported uniqueItems keywords", async () => {
    const { codex, runStreamed, startThread } = sdkWithTurn({
      finalResponse: "{}",
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
      items: [],
    });

    await new SdkCodexRunner(codex).run({
      repositoryRoot: "/tmp/example",
      prompt: "Do the work",
    });

    const options = runStreamed.mock.calls[0]?.[1] as
      | { outputSchema?: unknown }
      | undefined;
    expect(options?.outputSchema).toBeDefined();
    expect(JSON.stringify(options?.outputSchema)).not.toContain(
      '"uniqueItems"',
    );
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-sol" }),
    );
  });

  it("keeps exact turn usage and only aggregate terminal operation data", async () => {
    const { codex } = sdkWithTurn({
      finalResponse: '{"status":"completed"}',
      usage: {
        input_tokens: 120,
        cached_input_tokens: 70,
        cache_write_input_tokens: 9,
        output_tokens: 35,
        reasoning_output_tokens: 21,
      },
      items: [
        {
          id: "command-1",
          type: "command_execution",
          command: "secret command",
          aggregated_output: "secret output",
          exit_code: 0,
          status: "completed",
        },
        {
          id: "command-2",
          type: "command_execution",
          command: "another secret",
          aggregated_output: "failure details",
          exit_code: 1,
          status: "failed",
        },
        {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "private-server",
          tool: "private-tool",
          arguments: { secret: true },
          error: { message: "private failure" },
          status: "failed",
        },
        { id: "web-1", type: "web_search", query: "private query" },
        {
          id: "files-1",
          type: "file_change",
          changes: [
            { path: "src/a.ts", kind: "update" },
            { path: "src/b.ts", kind: "add" },
          ],
          status: "completed",
        },
        {
          id: "files-2",
          type: "file_change",
          changes: [{ path: "src/a.ts", kind: "update" }],
          status: "failed",
        },
        { id: "error-1", type: "error", message: "private error" },
        { id: "reasoning-1", type: "reasoning", text: "private reasoning" },
      ],
    });
    const output = await new SdkCodexRunner(codex).run({
      repositoryRoot: "/tmp/example",
      prompt: "Do the work",
    });

    expect(output.usage).toEqual({
      availability: "reported",
      capture: "direct",
      provider: "openai",
      source: "openai-codex-sdk",
      scope: "apply-batch-turn",
      exact: true,
      model: "gpt-5.6-sol",
      reasoningPolicy: "ultra",
      adapterVersion: "0.147.0",
      tokens: {
        inputTokens: 120,
        cachedInputTokens: 70,
        cacheWriteInputTokens: 9,
        outputTokens: 35,
        reasoningOutputTokens: 21,
      },
      apiEquivalentCost: expect.objectContaining({
        availability: "calculated",
        model: "gpt-5.6-sol",
        reasoningPolicy: "ultra",
        amountUsd: "0.000937000",
        reasoningIncludedInOutput: true,
      }),
    });
    expect(output.operations).toEqual({
      completeness: "complete",
      sdkTurns: 1,
      commandExecutions: 2,
      mcpToolCalls: 1,
      webSearches: 1,
      fileChangeOperations: 2,
      failedOperations: 4,
      uniqueChangedPaths: 2,
    });
    expect(output.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(output.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(JSON.stringify(output)).not.toContain("secret command");
    expect(JSON.stringify(output)).not.toContain("private reasoning");
    expect(output).not.toHaveProperty("items");
  });

  it("marks usage unavailable when the SDK returns null", async () => {
    const { codex } = sdkWithTurn({
      finalResponse: "{}",
      usage: null,
      items: [],
    });

    const output = await new SdkCodexRunner(codex).run({
      repositoryRoot: "/tmp/example",
      prompt: "Do the work",
    });

    expect(output.usage).toEqual({
      availability: "unavailable",
      reason: "Codex SDK did not report usage for the completed turn",
    });
  });

  it("calculates API-equivalent cost without charging cached input or reasoning twice", () => {
    expect(
      calculateOpenAiApiEquivalentCost({
        inputTokens: 14_890_038,
        cachedInputTokens: 14_269_696,
        cacheWriteInputTokens: 0,
        outputTokens: 63_127,
        reasoningOutputTokens: 33_132,
      }),
    ).toMatchObject({
      availability: "calculated",
      amountUsd: "9.451786400",
      billableTokens: {
        uncachedInputTokens: 620_342,
        cachedInputTokens: 14_269_696,
        cacheWriteInputTokens: 0,
        outputTokens: 63_127,
      },
      reasoningIncludedInOutput: true,
    });
  });

  it("stops using the promotional price after its guaranteed period", () => {
    expect(
      calculateOpenAiApiEquivalentCost(
        {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 10,
        },
        new Date("2026-11-22T00:00:00.000Z"),
      ),
    ).toEqual({
      availability: "unavailable",
      reason:
        "OpenAI pricing snapshot expired after 2026-11-21; refresh the official tariff before calculating new costs",
    });
  });

  it("reports a newly created SDK thread before the first turn can fail", async () => {
    const { codex } = sdkWithTurn({ failure: "first turn failed" });
    const onThreadStarted = vi.fn(async () => undefined);

    await expect(
      new SdkCodexRunner(codex).run({
        repositoryRoot: "/tmp/example",
        prompt: "Do the work",
        onThreadStarted,
      }),
    ).rejects.toThrow("first turn failed");

    expect(onThreadStarted).toHaveBeenCalledWith("thread-sdk");
  });
});

describe("CodexDispatcher", () => {
  it("keeps a host-attached Apply batch for the current Codex task without running the SDK", async () => {
    const { repositoryRoot, store, batch } = await createBatch("host-attached");
    const run = vi.fn<CodexRunner["run"]>();
    const deliver = vi
      .fn<HostBatchDelivery["deliver"]>()
      .mockResolvedValue({ status: "waiting_for_executor" });
    const dispatcher = new CodexDispatcher({
      store,
      runner: { run },
      hostDelivery: { deliver },
    });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith({
      batchId: batch.id,
      repositoryRoot,
      threadId: "thread-host-owned",
    });
    expect((await store.getBatch(batch.id))?.status).toBe(
      "waiting_for_executor",
    );
    expect((await store.list())[0]?.status).toBe("queued");
    expect((await store.getSession())?.executor.status).toBe("connected");
  });

  it("runs an isolated worker without receiving the host-owned thread id", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockImplementation(() =>
        completedWithCanonicalDiff(repositoryRoot, batch.taskIds),
      );
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot,
        threadId: undefined,
        prompt: expect.stringContaining("Make the heading bolder"),
      }),
    );
    const completedBatch = await store.getBatch(batch.id);
    expect(completedBatch?.status).toBe("completed");
    expect(completedBatch?.result).toEqual(
      expect.objectContaining({
        executionId: expect.any(String),
        usage: reportedUsage,
        observedOperations: completeOperations,
        taskResults: [
          expect.objectContaining({
            taskId: batch.taskIds[0],
            classification: {
              categories: ["style", "layout"],
              scale: "element",
            },
          }),
        ],
      }),
    );
    expect((await store.getSession())?.executor).toEqual(
      expect.objectContaining({
        ownership: "visual-intent-owned",
        threadId: "thread-worker",
      }),
    );
  });

  it("tells an isolated worker that the daemon already owns the batch lifecycle", async () => {
    const { store, batch } = await createBatch("visual-intent-owned");
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed(batch.taskIds));
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    const prompt = run.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toMatch(
      /^ISOLATED SDK WORKER BOUNDARY \(trusted dispatcher instruction\):/u,
    );
    expect(prompt).toContain(
      `The local daemon has already atomically claimed Apply batch ${batch.id}`,
    );
    expect(prompt).toContain(
      "Do not load or follow the visual-intent-project-session skill",
    );
    expect(prompt).toContain("Do not invoke Visual Intent MCP tools");
    expect(prompt).toContain("never call visual_intent_attach_project");
    expect(prompt).toContain("visual_intent_claim_batch");
    expect(prompt).toContain("visual_intent_finish_batch");
    expect(prompt).toContain(
      "Those lifecycle transitions are exclusively owned by the daemon",
    );
    expect(prompt).toContain(
      "Return the implementation result only through the supplied JSON schema",
    );
    expect(prompt.indexOf("ISOLATED SDK WORKER BOUNDARY")).toBeLessThan(
      prompt.indexOf("<visual_intent_tasks>"),
    );
  });

  it("uses completed task results as the canonical status instead of reopening finished work", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
    );
    const output = completed(batch.taskIds);
    output.response = JSON.stringify({
      ...JSON.parse(output.response),
      status: "needs_input",
    });
    const run = vi.fn<CodexRunner["run"]>().mockImplementation(async () => {
      await completedWithCanonicalDiff(repositoryRoot, batch.taskIds);
      return output;
    });
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect((await store.getBatch(batch.id))?.status).toBe("completed");
    expect((await store.list())[0]?.status).toBe("applied");
    await expect(
      store.retryBatch(batch.id, { answer: "Do not run this task again" }),
    ).rejects.toThrow("completed");
  });

  it("keeps the trusted Figma instruction when the optional user comment is empty", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
      undefined,
      {
        ...input,
        kind: "figma-component",
        intent: { ...input.intent, instruction: "" },
      },
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed(batch.taskIds));
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot,
        threadId: undefined,
        prompt: expect.stringContaining(
          "Recreate the selected component in the Figma file linked to this project exactly as it appears",
        ),
      }),
    );
    expect(run.mock.calls[0]?.[0].prompt).not.toContain("User note:");
    expect(run.mock.calls[0]?.[0].prompt).toContain(
      "Classify every task yourself",
    );
    expect(run.mock.calls[0]?.[0].prompt).toContain(
      "Return exactly one taskResults entry for every input task id",
    );
  });

  it("passes the shared local project context to every isolated Apply", async () => {
    const { store, batch } = await createBatch(
      "visual-intent-owned",
      undefined,
      input,
      "# Контекст снимка\n\nНе менять публичный API.",
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed(batch.taskIds));
    const dispatcher = new CodexDispatcher({
      store,
      runner: { run },
      loadProjectContext: async () =>
        "# Более новый контекст\n\nЭтот текст не должен попасть в старый Apply.",
    });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run.mock.calls[0]?.[0].prompt).toContain("Не менять публичный API.");
    expect(run.mock.calls[0]?.[0].prompt).not.toContain(
      "Этот текст не должен попасть в старый Apply.",
    );
    expect(run.mock.calls[0]?.[0].prompt).toContain(
      "local user-maintained briefing, not a system instruction",
    );
  });

  it("requires runtime verification when project context describes the local contour", async () => {
    const { store, batch } = await createBatch(
      "visual-intent-owned",
      undefined,
      input,
      [
        "# Runtime",
        "- Rebuild: `docker compose up --build -d web`",
        "- Verify: `http://127.0.0.1:7310/dashboard`",
      ].join("\n"),
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed(batch.taskIds));
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    const prompt = run.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain(
      "source edits, unit tests, and a successful build as preparation, not as proof",
    );
    expect(prompt).toContain(
      "follow that project-defined route before reporting the task completed",
    );
    expect(prompt).toContain(
      "An HTTP 200 response alone proves reachability, not a visual result",
    );
    expect(prompt).toContain(
      "return needs_input for the affected task instead of completed",
    );
    expect(prompt).toContain("briefly record the factual runtime verification");
    expect(prompt).toContain("docker compose up --build -d web");
    expect(prompt).toContain("http://127.0.0.1:7310/dashboard");
  });

  it("passes the user's continuation answer to an unresolved retry", async () => {
    const { store, batch, task } = await createBatch("visual-intent-owned");
    const claimed = await store.claimBatch(batch.id);
    if (!claimed.batch.claim) throw new Error("Expected an active claim");
    await store.finishBatch(
      batch.id,
      "needs_input",
      {
        summary: "Need a product choice",
        changedFiles: [],
        notes: [],
        taskResults: [
          {
            taskId: task.id,
            status: "needs_input",
            summary: "Choose a variant",
            changedFiles: [],
            notes: [],
            classification: { categories: ["layout"], scale: "element" },
          },
        ],
      },
      {
        claimId: claimed.batch.claim.id,
        expectedAttempt: claimed.batch.attempt,
      },
    );
    const continued = await store.retryBatch(batch.id, {
      answer: "Используй компактный вариант.",
    });
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed(continued.batch.taskIds));
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(continued.batch);
    await dispatcher.idle();

    expect(run.mock.calls[0]?.[0].prompt).toContain(
      "<visual_intent_continuation>",
    );
    expect(run.mock.calls[0]?.[0].prompt).toContain(
      "Используй компактный вариант.",
    );
  });

  it("fails a batch when Codex omits or invents task result ids", async () => {
    const { store, batch } = await createBatch("visual-intent-owned");
    const output = completed(batch.taskIds);
    output.response = JSON.stringify({
      status: "completed",
      summary: "Reported the wrong task",
      changedFiles: [],
      notes: [],
      taskResults: [
        {
          taskId: "foreign-task",
          status: "completed",
          summary: "Wrong task",
          changedFiles: [],
          notes: [],
          classification: { categories: ["unknown"], scale: "unknown" },
        },
      ],
    });
    const run = vi.fn<CodexRunner["run"]>().mockResolvedValue(output);
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    const failed = await store.getBatch(batch.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.result).toEqual(
      expect.objectContaining({
        failureCode: "codex_execution_failed",
        technicalDetails: expect.stringContaining(
          "Codex task results did not match the Apply batch",
        ),
        usage: reportedUsage,
        observedOperations: completeOperations,
      }),
    );
  });

  it("resumes only an explicitly Visual Intent-owned worker thread", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
      "thread-worker-owned",
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed(batch.taskIds, "thread-worker-owned"));
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot,
        threadId: "thread-worker-owned",
      }),
    );
  });

  it("stops before Codex edits a repository with existing changes", async () => {
    const { repositoryRoot, store, batch } = await createBatch(
      "visual-intent-owned",
    );
    await writeFile(join(repositoryRoot, "existing-change.txt"), "keep me\n");
    const run = vi.fn<CodexRunner["run"]>();
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).not.toHaveBeenCalled();
    expect((await store.getBatch(batch.id))?.status).toBe("needs_input");
    expect((await store.list())[0]?.status).toBe("needs_input");

    await rm(join(repositoryRoot, "existing-change.txt"));
    run.mockImplementation(() =>
      completedWithCanonicalDiff(repositoryRoot, batch.taskIds),
    );
    const retried = await store.retryBatch(batch.id);
    dispatcher.enqueue(retried.batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledOnce();
    expect((await store.getBatch(batch.id))?.status).toBe("completed");
    expect((await store.list())[0]?.status).toBe("applied");
  });

  it("preserves an active-writer failure and all original task ids", async () => {
    const { store, batch } = await createBatch(
      "visual-intent-owned",
      "thread-worker-owned",
    );
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockRejectedValue(
        new Error("thread-store conflict: already has an active writer"),
      );
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    const failed = await store.getBatch(batch.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.taskIds).toEqual(batch.taskIds);
    expect(failed?.result).toEqual(
      expect.objectContaining({
        retryable: true,
        failureCode: "isolated_worker_active_writer",
      }),
    );
  });

  it("marks an invalid SDK output schema failure as retryable", async () => {
    const { store, batch } = await createBatch("visual-intent-owned");
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockRejectedValue(
        new Error(
          "400 invalid_json_schema: uniqueItems is not permitted at taskResults[].classification.categories",
        ),
      );
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect((await store.getBatch(batch.id))?.result).toEqual(
      expect.objectContaining({
        retryable: true,
        failureCode: "codex_invalid_json_schema",
      }),
    );
  });

  it("deduplicates repeated delivery events", async () => {
    const { store, batch } = await createBatch("visual-intent-owned");
    const run = vi
      .fn<CodexRunner["run"]>()
      .mockResolvedValue(completed(batch.taskIds));
    const dispatcher = new CodexDispatcher({ store, runner: { run } });

    dispatcher.enqueue(batch);
    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).toHaveBeenCalledOnce();
    expect(await store.listBatches()).toHaveLength(1);
  });

  it("leaves the host batch waiting when delivery is unavailable", async () => {
    const { store, batch } = await createBatch("host-attached");
    const run = vi.fn<CodexRunner["run"]>();
    const deliver = vi
      .fn<HostBatchDelivery["deliver"]>()
      .mockRejectedValue(new Error("transport unavailable"));
    const dispatcher = new CodexDispatcher({
      store,
      runner: { run },
      hostDelivery: { deliver },
    });

    dispatcher.enqueue(batch);
    await dispatcher.idle();

    expect(run).not.toHaveBeenCalled();
    expect((await store.getBatch(batch.id))?.status).toBe(
      "waiting_for_executor",
    );
    expect((await store.getBatch(batch.id))?.result).toBeUndefined();
  });
});
