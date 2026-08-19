import { describe, expect, it } from "vitest";

import { cleanSourceUrl } from "../src/reference.js";

describe("external reference source", () => {
  it("removes credentials, query, and fragment from the captured URL", () => {
    expect(
      cleanSourceUrl("https://user:secret@example.com/card?q=private#section"),
    ).toBe("https://example.com/card");
  });
});
