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

export interface UnavailableFrameBoundary {
  frameUrl?: string;
  title?: string;
  sandbox?: string;
  allow?: string;
}

/**
 * Describes only the outer iframe boundary. The embedded document itself is
 * deliberately not inspected when Chrome did not inject the selector there.
 */
export function describeUnavailableFrameBoundary(
  boundary: UnavailableFrameBoundary,
): Record<string, string> {
  const attributes: Record<string, string> = {
    "visual-intent:frame-boundary": "true",
    "visual-intent:frame-content-captured": "false",
    "visual-intent:frame-access": "denied-or-unavailable",
  };
  const frameUrl = cleanUrl(boundary.frameUrl);
  if (frameUrl) attributes["visual-intent:frame-uri"] = frameUrl;
  const title = cleanLabel(boundary.title);
  if (title) attributes["visual-intent:frame-title"] = title;
  const sandbox = cleanLabel(boundary.sandbox);
  if (sandbox) attributes["visual-intent:frame-sandbox"] = sandbox;
  const allow = cleanLabel(boundary.allow);
  if (allow) attributes["visual-intent:frame-allow"] = allow;
  return attributes;
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

function cleanLabel(value?: string): string | undefined {
  const cleaned = value?.replace(/\s+/gu, " ").trim().slice(0, 500);
  return cleaned || undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
