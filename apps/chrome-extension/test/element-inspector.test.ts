import { describe, expect, it } from "vitest";

import {
  formatCssColor,
  positionElementInspector,
} from "../src/element-inspector.js";

describe("Chrome element inspector", () => {
  it("normalizes legacy and modern computed colors to hex", () => {
    expect(formatCssColor("rgb(17, 24, 39)")).toBe("#111827");
    expect(formatCssColor("rgba(17, 24, 39, 0.5)")).toBe("#11182780");
    expect(formatCssColor("oklab(0.554577 0.00701806 -0.0251765)")).toBe(
      "#717182",
    );
  });

  it("places the card above when there is room", () => {
    expect(
      positionElementInspector(
        {
          left: 100,
          top: 200,
          right: 300,
          bottom: 240,
          width: 200,
          height: 40,
        },
        240,
        76,
        800,
        600,
      ),
    ).toEqual({ left: 100, top: 116, anchorX: 50, placement: "above" });
  });

  it("moves below and stays inside the viewport near an edge", () => {
    expect(
      positionElementInspector(
        { left: 760, top: 10, right: 790, bottom: 30, width: 30, height: 20 },
        240,
        76,
        800,
        600,
      ),
    ).toEqual({ left: 552, top: 38, anchorX: 223, placement: "below" });
  });
});
