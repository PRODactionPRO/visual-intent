import { describe, expect, it } from "vitest";

import { createOverlayScript } from "../src/index.js";

describe("createOverlayScript", () => {
  it("returns an injectable self-contained script", () => {
    const script = createOverlayScript();

    expect(script).toContain("visual-intent-overlay-root");
    expect(script).toContain("Add task");
    expect(script).toContain("tasks?status=ready");
    expect(script).toContain("tasks/apply");
    expect(script).toContain('method: "DELETE"');
    expect(script).toContain("Waiting for Codex");
    expect(script).toContain("isolated worker");
    expect(script).toContain(
      "Не удалось передать задачи в Codex. Пакет сохранён, изменения не применялись.",
    );
    expect(script).toContain("Technical details");
    expect(script).toContain("batch.result?.retryable === true");
    expect(script).toContain("readyTasks.length === 0");
    expect(script).not.toContain("import ");
  });
});
