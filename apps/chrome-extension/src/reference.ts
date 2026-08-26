import type { CapturedReference, ReferenceTask } from "./types.js";

const MAX_NODES = 40;
const MAX_TEXT_LENGTH = 500;
const STYLE_PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "box-sizing",
  "margin",
  "padding",
  "gap",
  "row-gap",
  "column-gap",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "align-content",
  "align-items",
  "align-self",
  "justify-content",
  "justify-items",
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "overflow",
  "overflow-x",
  "overflow-y",
  "aspect-ratio",
  "object-fit",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration",
  "white-space",
  "color",
  "background",
  "background-color",
  "background-image",
  "opacity",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "box-shadow",
  "transform",
  "transform-origin",
  "transition",
  "animation",
  "cursor",
] as const;

export function captureReference(element: Element): CapturedReference {
  const surfaceId = crypto.randomUUID();
  const frameId = crypto.randomUUID();
  const regionId = crypto.randomUUID();
  const pageUrl = cleanSourceUrl(location.href);
  const elements = [element, ...Array.from(element.querySelectorAll("*"))]
    .filter(isSafeElement)
    .slice(0, MAX_NODES);
  const nodeIds = new Map<Element, string>();
  elements.forEach((candidate) => nodeIds.set(candidate, crypto.randomUUID()));
  const nodes = elements.map((candidate) => ({
    id: nodeIds.get(candidate),
    surfaceId,
    kind: "element",
    name: candidate.tagName.toLowerCase(),
    stableSelector: selectorFor(candidate),
    text: directText(candidate),
    attributes: captureAttributes(candidate),
  }));
  const relations: Array<Record<string, unknown>> = [];
  const rootNodeId = nodeIds.get(element);
  if (!rootNodeId) throw new Error("Не удалось определить выбранный элемент");
  relations.push({
    id: crypto.randomUUID(),
    type: "contains",
    from: { entity: "surface", id: surfaceId },
    to: { entity: "node", id: rootNodeId },
  });
  for (const candidate of elements.slice(1)) {
    const childId = nodeIds.get(candidate);
    const parentId = candidate.parentElement
      ? nodeIds.get(candidate.parentElement)
      : undefined;
    if (childId && parentId) {
      relations.push({
        id: crypto.randomUUID(),
        type: "contains",
        from: { entity: "node", id: parentId },
        to: { entity: "node", id: childId },
      });
    }
  }
  const rect = element.getBoundingClientRect();
  return {
    surface: {
      id: surfaceId,
      platform: "web",
      uri: pageUrl,
      title: document.title,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      },
      adapter: { name: "visual-intent-chrome", version: "0.1.0" },
    },
    nodes,
    frames: [
      {
        id: frameId,
        surfaceId,
        x: 0,
        y: 0,
        width: innerWidth,
        height: innerHeight,
        scrollX,
        scrollY,
        scale: devicePixelRatio,
      },
    ],
    regions: [
      {
        id: regionId,
        surfaceId,
        frameId,
        x: rect.left + scrollX,
        y: rect.top + scrollY,
        width: rect.width,
        height: rect.height,
        unit: "px",
        coordinateSpace: "surface",
      },
    ],
    relations,
    rootNodeId,
    regionId,
  };
}

export function createReferenceTask(
  reference: CapturedReference,
  comment: string,
): ReferenceTask {
  const annotationId = crypto.randomUUID();
  const sourceHost = new URL(String(reference.surface.uri)).hostname;
  return {
    protocolVersion: "0.1",
    kind: "code-change",
    surface: reference.surface,
    nodes: reference.nodes,
    frames: reference.frames,
    regions: reference.regions,
    relations: [
      ...reference.relations,
      {
        id: crypto.randomUUID(),
        type: "anchors",
        from: { entity: "annotation", id: annotationId },
        to: { entity: "node", id: reference.rootNodeId },
      },
    ],
    annotations: [
      {
        id: annotationId,
        kind: "comment",
        body: comment,
        nodeId: reference.rootNodeId,
        regionId: reference.regionId,
        createdAt: new Date().toISOString(),
      },
    ],
    attachments: [],
    intent: {
      id: crypto.randomUUID(),
      action: "change",
      instruction: `Используй выбранный компонент с ${sourceHost} как визуальный референс. ${comment}`,
      acceptanceCriteria: [],
    },
  };
}

export function cleanSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isSafeElement(element: Element): boolean {
  return !new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "IFRAME",
    "OBJECT",
    "EMBED",
  ]).has(element.tagName);
}

function directText(element: Element): string | undefined {
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
  return text || undefined;
}

function captureAttributes(element: Element): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set([
    "id",
    "class",
    "role",
    "alt",
    "title",
    "type",
    "href",
    "src",
  ]);
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (!allowed.has(name) && !name.startsWith("aria-")) continue;
    const value =
      name === "href" || name === "src"
        ? cleanAssetUrl(attribute.value)
        : attribute.value.slice(0, 500);
    if (value) result[`html:${name}`] = value;
  }
  const computed = getComputedStyle(element);
  for (const property of STYLE_PROPERTIES) {
    const value = computed.getPropertyValue(property).trim();
    if (value) result[`css:${property}`] = cleanStyleValue(value);
  }
  return result;
}

function cleanStyleValue(value: string): string {
  return value
    .replace(/url\((['"]?)(.*?)\1\)/giu, (_match, _quote, rawUrl: string) => {
      const cleaned = cleanAssetUrl(rawUrl.trim());
      return cleaned ? `url("${cleaned}")` : "none";
    })
    .slice(0, 1000);
}

function cleanAssetUrl(value: string): string {
  try {
    const url = new URL(value, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 500);
  } catch {
    return "";
  }
}

function selectorFor(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 6) {
    let part = current.tagName.toLowerCase();
    const classes = Array.from(current.classList).slice(0, 2);
    if (classes.length > 0)
      part += classes.map((value) => `.${CSS.escape(value)}`).join("");
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (candidate) => candidate.tagName === current?.tagName,
        )
      : [];
    if (siblings.length > 1)
      part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}
