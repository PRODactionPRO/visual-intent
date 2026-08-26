import { captureReference, createReferenceTask } from "./reference.js";
import {
  inspectElement,
  positionElementInspector,
} from "./element-inspector.js";
import type {
  BridgeSession,
  CapturedReference,
  ExtensionResponse,
  PendingAttachment,
  ReferenceAnchorRect,
} from "./types.js";

const FRAME_PROBE_MESSAGE = "visual-intent:frame-probe";
const FRAME_READY_MESSAGE = "visual-intent:frame-ready";
const FRAME_FALLBACK_DELAY_MS = 160;

interface FrameHandshakeMessage {
  type?: string;
  extensionId?: string;
  nonce?: string;
}

interface FrameFallback {
  overlay: HTMLDivElement;
  nonce: string;
  activationTimer: number;
}

declare global {
  interface Window {
    __visualIntentReferenceInstalled?: boolean;
  }
}

if (!window.__visualIntentReferenceInstalled) {
  window.__visualIntentReferenceInstalled = true;
  installContentAdapter();
}

function installContentAdapter(): void {
  const isTopFrame = window.top === window;
  let session: BridgeSession | undefined;
  let active = false;
  let announcedFrameActivity = false;
  let hovered: Element | undefined;
  let reference: CapturedReference | undefined;
  let attachments: PendingAttachment[] = [];
  const frameFallbacks = new Map<HTMLIFrameElement, FrameFallback>();

  const host = document.createElement("div");
  host.dataset.visualIntentChrome = "true";
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    *{box-sizing:border-box}.frame-fallbacks{position:fixed;inset:0;pointer-events:none}.frame-fallback{position:fixed;display:none;border:0;background:transparent;pointer-events:none;cursor:crosshair}.frame-fallback[data-active=true]{display:block;pointer-events:auto}.highlight{position:fixed;display:none;border:2px solid #1689ec;background:rgb(22 137 236/.12);pointer-events:none}
    .inspector{--inspector-bg:#fff;--inspector-text:#0c0e10;--inspector-muted:#76808b;--inspector-border:#d9dee5;position:fixed;display:none;width:240px;padding:9px 10px;border:1px solid var(--inspector-border);border-radius:12px;background:var(--inspector-bg);color:var(--inspector-text);pointer-events:none;box-shadow:0 10px 28px rgb(15 23 42/.16);font:500 12px/16px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}.inspector[data-theme=dark]{--inspector-bg:#171a1d;--inspector-text:#f8fafc;--inspector-muted:#929ba5;--inspector-border:#343a42;box-shadow:0 12px 32px rgb(0 0 0/.42)}.inspector[data-visible=true]{display:grid;gap:2px}.inspector-row{display:grid;grid-template-columns:50px minmax(0,1fr);align-items:center;gap:8px;min-width:0}.inspector-row:first-child{grid-template-columns:minmax(0,1fr) auto}.inspector-label{color:var(--inspector-muted)}.inspector-value{min-width:0;overflow:hidden;text-align:right;text-overflow:ellipsis;white-space:nowrap}.inspector-font{font-family:ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace}.inspector::after{content:"";position:absolute;left:var(--inspector-anchor-x,24px);width:9px;height:9px;border-right:1px solid var(--inspector-border);border-bottom:1px solid var(--inspector-border);background:var(--inspector-bg)}.inspector[data-placement=above]::after{bottom:-5px;transform:rotate(45deg)}.inspector[data-placement=below]::after{top:-5px;transform:rotate(225deg)}.inspector[data-placement=over]::after{display:none}
    .hint{position:fixed;top:18px;left:50%;display:none;transform:translateX(-50%);padding:9px 13px;border-radius:10px;background:#111827;color:#fff;font:600 12px/1.2 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 28px rgb(0 0 0/.25)}
    .composer{position:fixed;display:none;width:min(380px,calc(100vw - 24px));padding:12px;border:1px solid rgb(255 255 255/.12);border-radius:18px;background:#15191e;color:#fff;pointer-events:auto;box-shadow:0 18px 50px rgb(0 0 0/.34);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .project{margin:0 0 7px;color:#87bff3;font-size:11px;font-weight:700}.input{display:block;width:100%;min-height:62px;max-height:180px;resize:none;overflow:auto;padding:6px 4px;border:0;outline:0;background:transparent;color:#fff;font:500 14px/1.45 inherit}.input::placeholder{color:#9ca5af}
    .attachments{display:flex;gap:7px;margin:4px 0 9px}.preview{position:relative;width:54px;height:54px;border-radius:9px;overflow:hidden;background:#2a3038}.preview img{width:100%;height:100%;object-fit:cover}.remove{position:absolute;top:2px;right:2px;display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:rgb(0 0 0/.72);color:#fff;cursor:pointer}
    .footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.attach{padding:7px 9px;border:0;border-radius:9px;background:#2a3038;color:#fff;cursor:pointer;font:600 12px/1 inherit}.save{padding:8px 12px;border:0;border-radius:10px;background:#1689ec;color:#fff;cursor:pointer;font:700 12px/1 inherit}.save:disabled{opacity:.38;cursor:default}.drop{outline:2px dashed #1689ec;outline-offset:3px}.toast{position:fixed;bottom:18px;left:50%;display:none;transform:translateX(-50%);padding:10px 14px;border-radius:11px;background:#15191e;color:#fff;font:600 12px/1.25 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 12px 32px rgb(0 0 0/.3)}
  `;
  const frameFallbackLayer = div("frame-fallbacks");
  const highlight = div("highlight");
  const inspector = div("inspector");
  inspector.dataset.theme = "light";
  const inspectorTag = span("");
  const inspectorSize = span("inspector-value");
  const inspectorColor = span("inspector-value");
  const inspectorFont = span("inspector-value inspector-font");
  inspector.append(
    inspectorRow(undefined, inspectorTag, inspectorSize),
    inspectorRow("цвет", inspectorColor),
    inspectorRow("шрифт", inspectorFont),
  );
  const hint = div("hint", "Выберите элемент · Esc — отмена");
  const composer = div("composer");
  const project = div("project");
  const input = document.createElement("textarea");
  input.className = "input";
  input.placeholder = "Добавьте комментарий к визуальному референсу…";
  const attachmentList = div("attachments");
  const footer = div("footer");
  const attach = button("attach", "＋ Изображение");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept =
    "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.heic,.heif";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const save = button("save", "Добавить в задачи");
  save.disabled = true;
  const toast = div("toast");
  footer.append(attach, save);
  composer.append(project, input, attachmentList, footer, fileInput);
  shadow.append(
    style,
    frameFallbackLayer,
    highlight,
    inspector,
    hint,
    composer,
    toast,
  );

  chrome.runtime.onMessage.addListener((message: unknown) => {
    const candidate = message as {
      type?: string;
      session?: BridgeSession;
      preserveHighlight?: boolean;
      reference?: CapturedReference;
      anchor?: ReferenceAnchorRect;
      sourceFrameId?: number;
    };
    if (
      candidate.type === "visual-intent:start-selection" &&
      candidate.session
    ) {
      session = candidate.session;
      startSelection();
      return;
    }
    if (candidate.type === "visual-intent:clear-hover") {
      clearHover();
      return;
    }
    if (candidate.type === "visual-intent:stop-selection") {
      stopLocalSelection(candidate.preserveHighlight === true);
      return;
    }
    if (
      candidate.type === "visual-intent:open-reference" &&
      isTopFrame &&
      candidate.reference &&
      candidate.anchor
    ) {
      reference = candidate.reference;
      openComposer(
        candidate.sourceFrameId === 0
          ? candidate.anchor
          : centeredComposerAnchor(),
      );
    }
  });

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("paste", onPasteCapture, true);
  window.addEventListener("message", onFrameHandshake, true);
  window.addEventListener("scroll", refreshSelectionGeometry, true);
  window.addEventListener("resize", refreshSelectionGeometry, true);

  input.addEventListener("input", () => {
    save.disabled = input.value.trim().length === 0;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  });
  attach.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    void addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });
  composer.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    composer.classList.add("drop");
  });
  composer.addEventListener("dragleave", () =>
    composer.classList.remove("drop"),
  );
  composer.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    composer.classList.remove("drop");
    void addFiles(Array.from(event.dataTransfer?.files ?? []));
  });
  save.addEventListener("click", () => void saveTask());

  function startSelection(): void {
    closeComposer();
    announcedFrameActivity = false;
    hovered = undefined;
    highlight.style.display = "none";
    hideInspector();
    inspector.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    active = true;
    hint.style.display = isTopFrame ? "block" : "none";
    document.documentElement.style.cursor = "crosshair";
    syncFrameFallbacks();
  }

  function onMove(event: MouseEvent): void {
    if (!active) return;
    announceFrameActivity();
    const path = event.composedPath();
    if (path.includes(host)) return;
    const target = path.find(
      (candidate): candidate is Element => candidate instanceof Element,
    );
    if (
      !(target instanceof Element) ||
      target === host ||
      host.contains(target)
    ) {
      highlight.style.display = "none";
      hideInspector();
      return;
    }
    hovered = target;
    renderHoveredElement();
  }

  function refreshHoveredElement(): void {
    if (!active || !hovered) return;
    if (!hovered.isConnected) {
      hovered = undefined;
      highlight.style.display = "none";
      hideInspector();
      return;
    }
    renderHoveredElement();
  }

  function refreshSelectionGeometry(): void {
    refreshHoveredElement();
    refreshFrameFallbackGeometry();
  }

  function renderHoveredElement(): void {
    if (!hovered) return;
    const rect = hovered.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const details = inspectElement(hovered, rect);
    inspectorTag.textContent = details.tag;
    inspectorSize.textContent = details.size;
    inspectorColor.textContent = details.color;
    inspectorFont.textContent = details.font;
    inspectorFont.title = details.font;
    inspector.dataset.visible = "true";
    const position = positionElementInspector(
      rect,
      inspector.offsetWidth || 240,
      inspector.offsetHeight || 76,
      innerWidth,
      innerHeight,
    );
    inspector.dataset.placement = position.placement;
    inspector.style.left = `${position.left}px`;
    inspector.style.top = `${position.top}px`;
    inspector.style.setProperty(
      "--inspector-anchor-x",
      `${position.anchorX}px`,
    );
  }

  function hideInspector(): void {
    inspector.dataset.visible = "false";
  }

  function announceFrameActivity(): void {
    if (announcedFrameActivity) return;
    announcedFrameActivity = true;
    void chrome.runtime.sendMessage({ type: "bridge:frame-active" });
  }

  function onFrameHandshake(event: MessageEvent<unknown>): void {
    const message = asFrameHandshakeMessage(event.data);
    if (!message || message.extensionId !== chrome.runtime.id) return;
    if (
      message.type === FRAME_PROBE_MESSAGE &&
      typeof message.nonce === "string" &&
      event.source === window.parent
    ) {
      window.parent.postMessage(
        {
          type: FRAME_READY_MESSAGE,
          extensionId: chrome.runtime.id,
          nonce: message.nonce,
        } satisfies FrameHandshakeMessage,
        "*",
      );
      return;
    }
    if (
      message.type !== FRAME_READY_MESSAGE ||
      typeof message.nonce !== "string"
    )
      return;
    for (const [frame, fallback] of frameFallbacks) {
      if (event.source !== frame.contentWindow) continue;
      if (message.nonce !== fallback.nonce) continue;
      removeFrameFallback(frame);
      return;
    }
  }

  function syncFrameFallbacks(): void {
    if (!active) return;
    const frames = new Set(
      Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe")),
    );
    for (const frame of frameFallbacks.keys()) {
      if (!frames.has(frame) || !frame.isConnected) removeFrameFallback(frame);
    }
    for (const frame of frames) {
      if (frameFallbacks.has(frame)) continue;
      const overlay = div("frame-fallback");
      overlay.setAttribute("aria-label", "Выбрать границу iframe");
      overlay.addEventListener("pointerenter", () => {
        if (!active) return;
        hovered = frame;
        announceFrameActivity();
        renderHoveredElement();
      });
      overlay.addEventListener("pointermove", () => {
        if (!active) return;
        hovered = frame;
        renderHoveredElement();
      });
      overlay.addEventListener("pointerleave", () => {
        if (hovered !== frame) return;
        hovered = undefined;
        highlight.style.display = "none";
        hideInspector();
      });
      overlay.addEventListener("click", (event) =>
        selectUnavailableFrame(event, frame),
      );
      frameFallbackLayer.append(overlay);
      const nonce = crypto.randomUUID();
      const activationTimer = window.setTimeout(() => {
        const fallback = frameFallbacks.get(frame);
        if (!active || fallback?.overlay !== overlay) return;
        overlay.dataset.active = "true";
      }, FRAME_FALLBACK_DELAY_MS);
      frameFallbacks.set(frame, { overlay, nonce, activationTimer });
      positionFrameFallback(frame, overlay);
      frame.contentWindow?.postMessage(
        {
          type: FRAME_PROBE_MESSAGE,
          extensionId: chrome.runtime.id,
          nonce,
        } satisfies FrameHandshakeMessage,
        "*",
      );
    }
  }

  function refreshFrameFallbackGeometry(): void {
    if (!active) return;
    for (const [frame, fallback] of frameFallbacks)
      positionFrameFallback(frame, fallback.overlay);
  }

  function positionFrameFallback(
    frame: HTMLIFrameElement,
    overlay: HTMLDivElement,
  ): void {
    const rect = frame.getBoundingClientRect();
    Object.assign(overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    overlay.hidden =
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth;
  }

  function selectUnavailableFrame(
    event: MouseEvent,
    frame: HTMLIFrameElement,
  ): void {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const selected = captureReference(frame, {
      unavailableFrameBoundary: true,
    });
    const anchor = plainRect(frame.getBoundingClientRect());
    active = false;
    document.documentElement.style.cursor = "";
    hint.style.display = "none";
    hideInspector();
    clearFrameFallbacks();
    void transferReference(selected, anchor);
  }

  function removeFrameFallback(frame: HTMLIFrameElement): void {
    const fallback = frameFallbacks.get(frame);
    if (!fallback) return;
    window.clearTimeout(fallback.activationTimer);
    fallback.overlay.remove();
    frameFallbacks.delete(frame);
  }

  function clearFrameFallbacks(): void {
    for (const frame of [...frameFallbacks.keys()]) removeFrameFallback(frame);
  }

  function clearHover(): void {
    announcedFrameActivity = false;
    hovered = undefined;
    highlight.style.display = "none";
    hideInspector();
  }

  function onClick(event: MouseEvent): void {
    if (event.composedPath().includes(host)) return;
    if (!active || !hovered) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const selected = captureReference(hovered);
    const anchor = plainRect(hovered.getBoundingClientRect());
    active = false;
    document.documentElement.style.cursor = "";
    hint.style.display = "none";
    hideInspector();
    clearFrameFallbacks();
    void transferReference(selected, anchor);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (!active && composer.style.display !== "block") return;
    event.preventDefault();
    event.stopPropagation();
    void finishSelection();
  }

  function onPasteCapture(event: ClipboardEvent): void {
    if (composer.style.display !== "block") return;
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      isImage(file),
    );
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void addFiles(files);
  }

  function openComposer(rect: ReferenceAnchorRect): void {
    project.textContent = `В проект: ${session?.displayName ?? "Visual Intent"}`;
    composer.style.display = "block";
    const width = Math.min(380, innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), innerWidth - width - 12);
    const top =
      rect.bottom + 12 + 220 < innerHeight
        ? rect.bottom + 12
        : Math.max(12, rect.top - 190);
    composer.style.left = `${left}px`;
    composer.style.top = `${top}px`;
    input.focus();
  }

  async function transferReference(
    selected: CapturedReference,
    anchor: ReferenceAnchorRect,
  ): Promise<void> {
    if (!session) return;
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "bridge:frame-capture",
        sessionId: session.id,
        reference: selected,
        anchor,
      })) as ExtensionResponse;
      if (!response.ok)
        throw new Error(response.error ?? "Не удалось передать компонент");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      startSelection();
    }
  }

  async function finishSelection(): Promise<void> {
    stopLocalSelection(false);
    try {
      await chrome.runtime.sendMessage({ type: "bridge:finish-selection" });
    } catch {
      // Локальная очистка уже выполнена; другие фреймы сбросятся при новом запуске.
    }
  }

  function stopLocalSelection(preserveHighlight: boolean): void {
    active = false;
    announcedFrameActivity = false;
    hovered = undefined;
    reference = undefined;
    document.documentElement.style.cursor = "";
    if (!preserveHighlight) highlight.style.display = "none";
    hideInspector();
    hint.style.display = "none";
    clearFrameFallbacks();
    closeComposer();
  }

  function closeComposer(): void {
    composer.style.display = "none";
    composer.classList.remove("drop");
    input.value = "";
    input.style.height = "";
    attachments = [];
    renderAttachments();
    save.disabled = true;
  }

  async function addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (attachments.length >= 3) {
        showToast("Можно приложить не больше трёх изображений");
        break;
      }
      if (!isImage(file)) {
        showToast("Поддерживаются только изображения");
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        showToast("Изображение должно быть не больше 10 МБ");
        continue;
      }
      attachments.push({
        fileName: file.name || "reference-image",
        mimeType: mimeTypeFor(file),
        dataUrl: await readDataUrl(file),
      });
    }
    renderAttachments();
  }

  function renderAttachments(): void {
    attachmentList.replaceChildren();
    attachments.forEach((attachment, index) => {
      const preview = div("preview");
      const image = document.createElement("img");
      image.src = attachment.dataUrl;
      image.alt = attachment.fileName;
      const remove = button("remove", "×");
      remove.setAttribute("aria-label", `Удалить ${attachment.fileName}`);
      remove.addEventListener("click", () => {
        attachments.splice(index, 1);
        renderAttachments();
      });
      preview.append(image, remove);
      attachmentList.append(preview);
    });
  }

  async function saveTask(): Promise<void> {
    const comment = input.value.trim();
    if (!session || !reference || !comment) return;
    save.disabled = true;
    save.textContent = "Сохраняю…";
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "bridge:create-task",
        sessionId: session.id,
        task: createReferenceTask(reference, comment),
        attachments,
      })) as ExtensionResponse;
      if (!response.ok)
        throw new Error(response.error ?? "Не удалось сохранить задачу");
      highlight.style.display = "none";
      hideInspector();
      hovered = undefined;
      reference = undefined;
      closeComposer();
      showToast(`Задача добавлена в ${session.displayName}`);
      await finishSelection();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      save.disabled = false;
    } finally {
      save.textContent = "Добавить в задачи";
    }
  }

  function showToast(message: string): void {
    toast.textContent = message;
    toast.style.display = "block";
    window.setTimeout(() => {
      toast.style.display = "none";
    }, 3200);
  }
}

function plainRect(rect: DOMRect): ReferenceAnchorRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function centeredComposerAnchor(): ReferenceAnchorRect {
  const left = Math.max(12, innerWidth / 2 - 190);
  const top = Math.max(12, innerHeight / 2 - 90);
  return {
    left,
    top,
    right: left + 1,
    bottom: top + 1,
    width: 1,
    height: 1,
  };
}

function div(className: string, text?: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

function span(className: string, text?: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

function inspectorRow(
  label: string | undefined,
  ...values: HTMLElement[]
): HTMLDivElement {
  const row = div("inspector-row");
  if (label) row.append(span("inspector-label", label));
  row.append(...values);
  return row;
}

function button(className: string, text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  return element;
}

function isImage(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|heic|heif)$/iu.test(file.name)
  );
}

function mimeTypeFor(file: File): string {
  if (file.type) return file.type.toLowerCase();
  if (/\.png$/iu.test(file.name)) return "image/png";
  if (/\.jpe?g$/iu.test(file.name)) return "image/jpeg";
  if (/\.webp$/iu.test(file.name)) return "image/webp";
  if (/\.gif$/iu.test(file.name)) return "image/gif";
  if (/\.heic$/iu.test(file.name)) return "image/heic";
  if (/\.heif$/iu.test(file.name)) return "image/heif";
  return "application/octet-stream";
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Не удалось прочитать изображение"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function asFrameHandshakeMessage(
  value: unknown,
): FrameHandshakeMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  return {
    type: typeof candidate.type === "string" ? candidate.type : undefined,
    extensionId:
      typeof candidate.extensionId === "string"
        ? candidate.extensionId
        : undefined,
    nonce: typeof candidate.nonce === "string" ? candidate.nonce : undefined,
  };
}
