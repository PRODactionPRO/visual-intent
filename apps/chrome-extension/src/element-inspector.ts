export interface ElementInspection {
  tag: string;
  size: string;
  color: string;
  font: string;
}

export interface InspectorPosition {
  left: number;
  top: number;
  anchorX: number;
  placement: "above" | "below" | "over";
}

interface TargetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function inspectElement(
  element: Element,
  rect: TargetRect,
): ElementInspection {
  const computed = getComputedStyle(element);
  return {
    tag: element.tagName.toLowerCase(),
    size: `${formatDimension(rect.width)}×${formatDimension(rect.height)}`,
    color: formatCssColor(computed.color),
    font: `${computed.fontSize} ${computed.fontFamily.replace(/["']/g, "")}`,
  };
}

export function positionElementInspector(
  rect: TargetRect,
  inspectorWidth: number,
  inspectorHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): InspectorPosition {
  const margin = 8;
  const gap = 8;
  const left = Math.max(
    margin,
    Math.min(rect.left, viewportWidth - inspectorWidth - margin),
  );
  let top: number;
  let placement: InspectorPosition["placement"];
  if (rect.top >= inspectorHeight + gap) {
    top = rect.top - inspectorHeight - gap;
    placement = "above";
  } else if (viewportHeight - rect.bottom >= inspectorHeight + gap) {
    top = rect.bottom + gap;
    placement = "below";
  } else {
    top = Math.max(
      margin,
      Math.min(rect.top + margin, viewportHeight - inspectorHeight - margin),
    );
    placement = "over";
  }
  return {
    left,
    top,
    placement,
    anchorX: Math.max(
      14,
      Math.min(
        rect.left + Math.min(50, rect.width / 2) - left,
        inspectorWidth - 14,
      ),
    ),
  };
}

export function formatCssColor(value: string): string {
  if (value === "transparent") return "#00000000";
  const functionMatch = value.match(/^([a-z]+)\((.*)\)$/i);
  if (!functionMatch) return value;
  const name = functionMatch[1]?.toLowerCase();
  const [channelsRaw = "", alphaRaw] = functionMatch[2]!.split("/");
  const channels = channelsRaw
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const legacyAlpha =
    (name === "rgb" || name === "rgba") && channels.length >= 4
      ? channels[3]
      : undefined;
  const alpha = alphaRaw
    ? parseCssNumber(alphaRaw.trim())
    : legacyAlpha
      ? parseCssNumber(legacyAlpha)
      : 1;

  if ((name === "rgb" || name === "rgba") && channels.length >= 3) {
    const rgb = channels
      .slice(0, 3)
      .map((channel) =>
        channel.endsWith("%")
          ? parseCssNumber(channel)
          : Number.parseFloat(channel) / 255,
      );
    return serializeHexColor(rgb[0]!, rgb[1]!, rgb[2]!, alpha);
  }

  if ((name === "oklab" || name === "oklch") && channels.length >= 3) {
    const lightness = parseCssNumber(channels[0]!);
    let a: number;
    let b: number;
    if (name === "oklch") {
      const chroma = parseCssNumber(channels[1]!, 0.4);
      const hue = (Number.parseFloat(channels[2]!) * Math.PI) / 180;
      a = chroma * Math.cos(hue);
      b = chroma * Math.sin(hue);
    } else {
      a = parseCssNumber(channels[1]!, 0.4);
      b = parseCssNumber(channels[2]!, 0.4);
    }
    const rgb = oklabToSrgb(lightness, a, b);
    return serializeHexColor(rgb[0], rgb[1], rgb[2], alpha);
  }

  if (name === "color" && channels[0]?.toLowerCase() === "srgb") {
    const rgb = channels.slice(1, 4).map(Number);
    if (rgb.length === 3)
      return serializeHexColor(rgb[0]!, rgb[1]!, rgb[2]!, alpha);
  }

  return value;
}

function formatDimension(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function colorChannelToHex(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function serializeHexColor(
  red: number,
  green: number,
  blue: number,
  alpha = 1,
): string {
  const rgb = [red, green, blue].map(colorChannelToHex).join("");
  if (alpha >= 1) return `#${rgb}`;
  return `#${rgb}${colorChannelToHex(alpha)}`;
}

function parseCssNumber(value: string, percentScale = 1): number {
  if (value.endsWith("%"))
    return (Number.parseFloat(value) / 100) * percentScale;
  return Number.parseFloat(value);
}

function linearSrgbToSrgb(value: number): number {
  return value <= 0.0031308
    ? 12.92 * value
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function oklabToSrgb(
  lightness: number,
  a: number,
  b: number,
): [number, number, number] {
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return [
    linearSrgbToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearSrgbToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearSrgbToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
