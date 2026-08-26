import { describe, expect, it } from "vitest";

import { cleanSourceUrl, createReferenceTask } from "../src/reference.js";
import type { CapturedReference } from "../src/types.js";

describe("external reference source", () => {
  it("removes credentials, query, and fragment from the captured URL", () => {
    expect(
      cleanSourceUrl("https://user:secret@example.com/card?q=private#section"),
    ).toBe("https://example.com/card");
  });

  it("tells the agent that an unavailable iframe contains no captured DOM", () => {
    const reference: CapturedReference = {
      surface: { id: "surface-1", uri: "https://product.example/page" },
      nodes: [
        {
          id: "node-1",
          name: "iframe",
          attributes: {
            "visual-intent:frame-boundary": "true",
            "visual-intent:frame-content-captured": "false",
            "visual-intent:frame-uri": "https://widgets.example/card",
          },
        },
      ],
      regions: [],
      frames: [],
      relations: [],
      rootNodeId: "node-1",
      regionId: "region-1",
    };

    const task = createReferenceTask(
      reference,
      "Повтори внешние размеры блока.",
    );

    expect(task.intent.instruction).toContain(
      "Внутренний DOM встроенного документа не был доступен",
    );
    expect(task.intent.instruction).toContain("widgets.example");
    expect(task.intent.instruction).toContain("не додумывай его структуру");
    expect(task.intent.instruction).toContain("Повтори внешние размеры блока.");
  });
});
