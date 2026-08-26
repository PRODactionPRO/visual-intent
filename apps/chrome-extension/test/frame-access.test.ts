import { describe, expect, it } from "vitest";

import {
  addEmbeddedFrameContext,
  collectCrossOriginFramePermissions,
  describeUnavailableFrameBoundary,
} from "../src/frame-access.js";
import type { CapturedReference } from "../src/types.js";

describe("Chrome iframe access", () => {
  it("requests only distinct cross-origin frame permissions", () => {
    expect(
      collectCrossOriginFramePermissions([
        {
          frameId: 0,
          parentFrameId: -1,
          url: "https://product.example/page?token=secret",
        },
        {
          frameId: 1,
          parentFrameId: 0,
          url: "https://product.example/embedded",
        },
        {
          frameId: 2,
          parentFrameId: 0,
          url: "https://widgets.example/card?id=42",
        },
        {
          frameId: 3,
          parentFrameId: 2,
          url: "https://widgets.example/nested",
        },
        { frameId: 4, parentFrameId: 0, url: "about:blank" },
      ]),
    ).toEqual(["https://widgets.example/*"]);
  });

  it("adds sanitized embedding context to the selected root node", () => {
    const reference: CapturedReference = {
      surface: { id: "surface-1", uri: "https://widgets.example/card" },
      nodes: [
        {
          id: "node-1",
          attributes: { "html:class": "card" },
        },
      ],
      regions: [],
      frames: [],
      relations: [],
      rootNodeId: "node-1",
      regionId: "region-1",
    };

    expect(
      addEmbeddedFrameContext(reference, {
        frameId: 7,
        parentFrameId: 0,
        frameUrl: "https://widgets.example/card?token=secret#section",
        topLevelUrl: "https://product.example/page?access_token=secret#private",
      }).nodes[0]?.attributes,
    ).toEqual({
      "html:class": "card",
      "visual-intent:browser-frame-id": "7",
      "visual-intent:parent-browser-frame-id": "0",
      "visual-intent:frame-uri": "https://widgets.example/card",
      "visual-intent:container-uri": "https://product.example/page",
    });
  });

  it("describes an unavailable iframe without exposing URL secrets or content", () => {
    expect(
      describeUnavailableFrameBoundary({
        frameUrl:
          "https://user:secret@widgets.example/card?token=secret#private",
        title: "  Платёжный   виджет  ",
        sandbox: "allow-forms allow-same-origin",
        allow: "fullscreen; clipboard-write",
      }),
    ).toEqual({
      "visual-intent:frame-boundary": "true",
      "visual-intent:frame-content-captured": "false",
      "visual-intent:frame-access": "denied-or-unavailable",
      "visual-intent:frame-uri": "https://widgets.example/card",
      "visual-intent:frame-title": "Платёжный виджет",
      "visual-intent:frame-sandbox": "allow-forms allow-same-origin",
      "visual-intent:frame-allow": "fullscreen; clipboard-write",
    });
  });

  it("does not retain non-http frame sources in a fallback reference", () => {
    expect(
      describeUnavailableFrameBoundary({
        frameUrl: "data:text/html,<script>window.secret</script>",
      }),
    ).toEqual({
      "visual-intent:frame-boundary": "true",
      "visual-intent:frame-content-captured": "false",
      "visual-intent:frame-access": "denied-or-unavailable",
    });
  });
});
