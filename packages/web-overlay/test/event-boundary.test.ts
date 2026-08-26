import { describe, expect, it } from "vitest";

import {
  createOverlayScript,
  isVisualIntentOverlayEvent,
  VISUAL_INTENT_COMPOSER_ATTRIBUTE,
  VISUAL_INTENT_ROOT_ATTRIBUTE,
  VISUAL_INTENT_ROOT_VERSION,
  VISUAL_INTENT_SURFACE_ATTRIBUTE,
  type VisualIntentComposedPathEvent,
} from "../src/index.js";

function pathEvent(...entries: unknown[]): VisualIntentComposedPathEvent {
  return { composedPath: () => entries };
}

function markedRoot(version = VISUAL_INTENT_ROOT_VERSION): {
  getAttribute(name: string): string | null;
} {
  return {
    getAttribute: (name) =>
      name === VISUAL_INTENT_ROOT_ATTRIBUTE ? version : null,
  };
}

describe("Visual Intent event boundary", () => {
  it("recognizes the stable root marker anywhere in a composed path", () => {
    expect(isVisualIntentOverlayEvent(pathEvent({}, markedRoot(), {}))).toBe(
      true,
    );
    expect(
      isVisualIntentOverlayEvent(pathEvent(markedRoot("future-version"))),
    ).toBe(false);
    expect(isVisualIntentOverlayEvent(pathEvent({}, {}))).toBe(false);
    expect(
      isVisualIntentOverlayEvent({
        composedPath: () => {
          throw new Error("closed event");
        },
      }),
    ).toBe(false);
  });

  it("lets a Radix-like capture listener ignore overlay interaction", () => {
    let outsideDismissals = 0;
    const radixOutsidePointerDown = (
      event: VisualIntentComposedPathEvent,
    ): void => {
      if (isVisualIntentOverlayEvent(event)) return;
      outsideDismissals += 1;
    };

    radixOutsidePointerDown(pathEvent({}, markedRoot(), {}));
    expect(outsideDismissals).toBe(0);

    radixOutsidePointerDown(pathEvent({}));
    expect(outsideDismissals).toBe(1);
  });

  it("lets a capture-phase global key listener ignore composer input", () => {
    const capturedKeys: string[] = [];
    const globalKeyListener = (
      event: VisualIntentComposedPathEvent & { key: string },
    ): void => {
      if (isVisualIntentOverlayEvent(event)) return;
      capturedKeys.push(event.key);
    };

    globalKeyListener({ ...pathEvent(markedRoot()), key: "s" });
    expect(capturedKeys).toEqual([]);

    globalKeyListener({ ...pathEvent({}), key: "s" });
    expect(capturedKeys).toEqual(["s"]);
  });

  it("installs bubble-only boundaries without cancelling native behavior", () => {
    const script = createOverlayScript();
    const start = script.indexOf("const stopSurfaceBubble");
    const end = script.indexOf("let mode", start);
    const boundary = script.slice(start, end);

    expect(script).toContain(
      'overlayHost.setAttribute("data-visual-intent-root", "v1")',
    );
    expect(script).toContain(`${VISUAL_INTENT_SURFACE_ATTRIBUTE}="toolbar"`);
    expect(script).toContain(`${VISUAL_INTENT_COMPOSER_ATTRIBUTE}="v1"`);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const eventName of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "contextmenu",
      "focusin",
      "focusout",
      "keydown",
      "keyup",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "paste",
      "copy",
      "cut",
    ])
      expect(boundary).toContain(`"${eventName}"`);
    expect(boundary).toContain("event.stopPropagation()");
    expect(boundary).not.toContain("event.preventDefault()");
    expect(boundary).not.toContain("event.stopImmediatePropagation()");
  });

  it("keeps Escape cancellation inside the composer before the boundary", () => {
    const script = createOverlayScript();
    const start = script.indexOf('textarea.addEventListener("keydown"');
    const end = script.indexOf("document.addEventListener", start);
    const handler = script.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('event.key === "Escape"');
    expect(handler).toContain("cancelComposerDraft()");
  });
});
