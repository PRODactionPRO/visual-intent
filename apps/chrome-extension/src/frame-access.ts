import type { CapturedReference } from "./types.js";

export interface BrowserFrameSummary {
  frameId: number;
  parentFrameId: number;
  url: string;
}

export interface EmbeddedFrameContext {
  frameId: number;
  parentFrameId?: number;
  frameUrl?: string;
  topLevelUrl?: string;
}

export function collectCrossOriginFramePermissions(
  frames: BrowserFrameSummary[],
): string[] {
  const topOrigin = cleanOrigin(
    frames.find((frame) => frame.frameId === 0)?.url,
  );
  const patterns = new Set<string>();
  for (const frame of frames) {
    if (frame.frameId === 0) continue;
    const origin = cleanOrigin(frame.url);
    if (!origin || origin === topOrigin) continue;
    patterns.add(`${origin}/*`);
  }
  return [...patterns].sort();
}

export function addEmbeddedFrameContext(
  reference: CapturedReference,
  context: EmbeddedFrameContext,
): CapturedReference {
  const frameUrl = cleanUrl(context.frameUrl);
  const topLevelUrl = cleanUrl(context.topLevelUrl);
  const nodes = reference.nodes.map((node) => {
    if (node.id !== reference.rootNodeId) return node;
    const attributes: Record<string, string> = {
      ...asStringRecord(node.attributes),
      "visual-intent:browser-frame-id": String(context.frameId),
    };
    if (context.parentFrameId !== undefined)
      attributes["visual-intent:parent-browser-frame-id"] = String(
        context.parentFrameId,
      );
    if (frameUrl) attributes["visual-intent:frame-uri"] = frameUrl;
    if (topLevelUrl) attributes["visual-intent:container-uri"] = topLevelUrl;
    return { ...node, attributes };
  });
  return { ...reference, nodes };
}

function cleanOrigin(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function cleanUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
