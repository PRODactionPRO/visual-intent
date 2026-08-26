import { describe, expect, it } from "vitest";

import { parseExecutorMode } from "../src/executor-mode.js";

const context = {
  target: "http://127.0.0.1:3000",
  repositoryRoot: "/workspace/example",
  host: "127.0.0.1",
  port: 7310,
};

describe("executor mode", () => {
  it.each(["preserve", "disconnected", "isolated-worker"] as const)(
    "accepts %s",
    (mode) => {
      expect(parseExecutorMode(mode, context)).toBe(mode);
    },
  );

  it("gives exact migration commands for the removed codex alias", () => {
    expect(() => parseExecutorMode("codex", context)).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /Host-attached controller:[\s\S]*--executor disconnected[\s\S]*visual-intent attach[\s\S]*Autonomous SDK worker:[\s\S]*--executor isolated-worker/u,
        ),
      }),
    );
  });

  it("quotes repository paths in migration commands", () => {
    expect(() =>
      parseExecutorMode("codex", {
        ...context,
        repositoryRoot: "/workspace/Product With Spaces",
      }),
    ).toThrow("--repo '/workspace/Product With Spaces'");
  });

  it("rejects an unknown executor", () => {
    expect(() => parseExecutorMode("other", context)).toThrow(
      "Executor must be preserve, disconnected or isolated-worker",
    );
  });
});
