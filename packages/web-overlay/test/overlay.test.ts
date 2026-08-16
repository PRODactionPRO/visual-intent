import { describe, expect, it } from "vitest";

import { createOverlayScript } from "../src/index.js";

describe("createOverlayScript", () => {
  it("returns an injectable self-contained script", () => {
    const script = createOverlayScript();

    expect(script).toContain("visual-intent-overlay-root");
    expect(script).toContain("Apply saves a local task");
    expect(script).not.toContain("import ");
  });
});
