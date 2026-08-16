function bootOverlay(): void {
  if (document.getElementById("visual-intent-overlay-root")) return;

  type Mode = "idle" | "select" | "draw";
  type Rect = { x: number; y: number; width: number; height: number };

  const apiBase = "/_visual-intent/api";
  const overlayHost = document.createElement("div");
  overlayHost.id = "visual-intent-overlay-root";
  document.documentElement.append(overlayHost);
  const shadow = overlayHost.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .vip-shell { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font: 13px/1.4 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f8fafc; }
      .vip-toolbar { pointer-events: auto; position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; padding: 7px; border: 1px solid rgba(148,163,184,.3); border-radius: 14px; background: rgba(15,23,42,.94); box-shadow: 0 18px 48px rgba(15,23,42,.3); backdrop-filter: blur(12px); }
      button { appearance: none; border: 0; border-radius: 9px; padding: 8px 11px; background: transparent; color: #cbd5e1; font: inherit; font-weight: 650; cursor: pointer; }
      button:hover { color: white; background: rgba(255,255,255,.1); }
      button[data-active="true"] { color: white; background: #2563eb; }
      button.vip-apply { color: #052e16; background: #86efac; }
      button.vip-apply:hover { background: #bbf7d0; }
      .vip-brand { padding: 0 7px; font-weight: 800; letter-spacing: -.02em; color: white; }
      .vip-separator { width: 1px; height: 22px; background: rgba(148,163,184,.3); }
      .vip-composer { pointer-events: auto; position: absolute; right: 18px; bottom: 18px; width: min(380px, calc(100vw - 36px)); padding: 12px; border-radius: 14px; background: rgba(15,23,42,.96); box-shadow: 0 18px 48px rgba(15,23,42,.3); }
      .vip-target { margin-bottom: 8px; color: #93c5fd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      textarea { display: block; width: 100%; min-height: 76px; resize: vertical; border: 1px solid #334155; border-radius: 9px; padding: 9px 10px; background: #0f172a; color: white; font: inherit; outline: none; }
      textarea:focus { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
      .vip-hint { margin-top: 7px; color: #94a3b8; font-size: 12px; }
      .vip-highlight, .vip-draw-box { position: fixed; display: none; border: 2px solid #3b82f6; background: rgba(59,130,246,.13); pointer-events: none; }
      .vip-draw-box { border-style: dashed; border-color: #f59e0b; background: rgba(245,158,11,.12); }
      .vip-panel { pointer-events: auto; position: absolute; top: 70px; right: 18px; display: none; width: min(390px, calc(100vw - 36px)); max-height: calc(100vh - 190px); overflow: auto; border: 1px solid rgba(148,163,184,.25); border-radius: 14px; padding: 12px; background: rgba(15,23,42,.97); box-shadow: 0 18px 48px rgba(15,23,42,.3); }
      .vip-panel[data-open="true"] { display: block; }
      .vip-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 14px; font-weight: 800; }
      .vip-task { padding: 10px; border: 1px solid #334155; border-radius: 10px; margin-top: 8px; background: rgba(30,41,59,.8); }
      .vip-task-status { color: #86efac; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
      .vip-task-copy { margin-top: 4px; color: #e2e8f0; white-space: pre-wrap; }
      .vip-empty { color: #94a3b8; padding: 12px 2px; }
      .vip-toast { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%) translateY(20px); opacity: 0; padding: 9px 13px; border-radius: 999px; background: #0f172a; color: white; transition: .18s ease; }
      .vip-toast[data-visible="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }
    </style>
    <div class="vip-shell">
      <div class="vip-highlight"></div>
      <div class="vip-draw-box"></div>
      <div class="vip-toolbar" role="toolbar" aria-label="Visual Intent">
        <span class="vip-brand">Visual Intent</span>
        <span class="vip-separator"></span>
        <button data-action="select">Select</button>
        <button data-action="draw">Draw</button>
        <button data-action="comment">Comment</button>
        <button data-action="tasks">Tasks</button>
        <span class="vip-separator"></span>
        <button class="vip-apply" data-action="apply">Apply</button>
      </div>
      <section class="vip-panel" aria-label="Visual tasks">
        <div class="vip-panel-header"><span>Local tasks</span><span class="vip-count">0</span></div>
        <div class="vip-task-list"></div>
      </section>
      <section class="vip-composer">
        <div class="vip-target">Choose an element or draw a region</div>
        <textarea aria-label="Change request" placeholder="Describe what should change…"></textarea>
        <div class="vip-hint">Apply saves a local task. A coding agent decides and reports what it changed.</div>
      </section>
      <div class="vip-toast"></div>
    </div>`;

  function required<T extends Element>(selector: string): T {
    const element = shadow.querySelector<T>(selector);
    if (!element)
      throw new Error(`Visual Intent overlay is missing ${selector}`);
    return element;
  }

  const highlight = required<HTMLElement>(".vip-highlight");
  const drawBox = required<HTMLElement>(".vip-draw-box");
  const targetLabel = required<HTMLElement>(".vip-target");
  const textarea = required<HTMLTextAreaElement>("textarea");
  const panel = required<HTMLElement>(".vip-panel");
  const taskList = required<HTMLElement>(".vip-task-list");
  const taskCount = required<HTMLElement>(".vip-count");
  const toastElement = required<HTMLElement>(".vip-toast");

  let mode: Mode = "idle";
  let selectedElement: Element | null = null;
  let drawnRegion: Rect | null = null;
  let drawStart: { x: number; y: number } | null = null;
  let toastTimer: number | undefined;

  const id = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `vip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const isOverlayEvent = (event: Event): boolean =>
    event.composedPath().includes(overlayHost);

  function selectorFor(element: Element): string {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

    const parts: string[] = [];
    let current: Element | null = element;
    while (
      current &&
      parts.length < 5 &&
      current !== document.documentElement
    ) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (sibling) => sibling.tagName === current?.tagName,
          )
        : [];
      const suffix =
        siblings.length > 1
          ? `:nth-of-type(${siblings.indexOf(current) + 1})`
          : "";
      parts.unshift(`${tag}${suffix}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function displayRect(element: HTMLElement, rect: Rect | null): void {
    if (!rect) {
      element.style.display = "none";
      return;
    }
    element.style.display = "block";
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  }

  function setMode(next: Mode): void {
    mode = mode === next ? "idle" : next;
    shadow
      .querySelectorAll<HTMLButtonElement>("[data-action]")
      .forEach((button) => {
        button.dataset.active = String(button.dataset.action === mode);
      });
    document.documentElement.style.cursor = mode === "idle" ? "" : "crosshair";
    if (mode !== "select" && !selectedElement) displayRect(highlight, null);
  }

  function showToast(message: string): void {
    toastElement.textContent = message;
    toastElement.dataset.visible = "true";
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastElement.dataset.visible = "false";
    }, 2400);
  }

  function selectElement(element: Element): void {
    selectedElement = element;
    drawnRegion = null;
    displayRect(drawBox, null);
    displayRect(highlight, element.getBoundingClientRect());
    targetLabel.textContent = `Selected: ${selectorFor(element)}`;
    setMode("idle");
    textarea.focus();
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      if (mode !== "select" || isOverlayEvent(event)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element) displayRect(highlight, element.getBoundingClientRect());
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (mode !== "select" || isOverlayEvent(event)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selectElement(element);
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (mode !== "draw" || isOverlayEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drawStart = { x: event.clientX, y: event.clientY };
      drawnRegion = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
      displayRect(drawBox, drawnRegion);
    },
    true,
  );

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!drawStart || mode !== "draw") return;
      event.preventDefault();
      const x = Math.min(drawStart.x, event.clientX);
      const y = Math.min(drawStart.y, event.clientY);
      drawnRegion = {
        x,
        y,
        width: Math.abs(event.clientX - drawStart.x),
        height: Math.abs(event.clientY - drawStart.y),
      };
      displayRect(drawBox, drawnRegion);
    },
    true,
  );

  document.addEventListener(
    "pointerup",
    (event) => {
      if (!drawStart || mode !== "draw") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drawStart = null;
      selectedElement = null;
      displayRect(highlight, null);
      if (!drawnRegion || drawnRegion.width < 4 || drawnRegion.height < 4) {
        drawnRegion = null;
        displayRect(drawBox, null);
        targetLabel.textContent = "Draw a larger region";
      } else {
        targetLabel.textContent = `Region: ${Math.round(drawnRegion.width)} × ${Math.round(drawnRegion.height)} px`;
        setMode("idle");
        textarea.focus();
      }
    },
    true,
  );

  async function loadTasks(): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/tasks`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tasks = (await response.json()) as Array<{
        id: string;
        status: string;
        intent: { instruction: string };
      }>;
      taskCount.textContent = String(tasks.length);
      taskList.replaceChildren();

      if (tasks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "vip-empty";
        empty.textContent = "No tasks yet.";
        taskList.append(empty);
        return;
      }

      tasks.forEach((task) => {
        const item = document.createElement("article");
        item.className = "vip-task";
        const status = document.createElement("div");
        status.className = "vip-task-status";
        status.textContent = task.status.replaceAll("_", " ");
        const copy = document.createElement("div");
        copy.className = "vip-task-copy";
        copy.textContent = task.intent.instruction;
        item.title = task.id;
        item.append(status, copy);
        taskList.append(item);
      });
    } catch (error) {
      showToast(`Could not load tasks: ${String(error)}`);
    }
  }

  async function applyTask(): Promise<void> {
    const instruction = textarea.value.trim();
    if (!selectedElement && !drawnRegion) {
      showToast("Select an element or draw a region first");
      return;
    }
    if (!instruction) {
      showToast("Add a comment before applying");
      textarea.focus();
      return;
    }

    const surfaceId = id();
    const frameId = id();
    const nodeId = selectedElement ? id() : undefined;
    const regionId = id();
    const annotationId = id();
    const elementRect = selectedElement?.getBoundingClientRect();
    const targetRect =
      drawnRegion ??
      (elementRect
        ? {
            x: elementRect.x,
            y: elementRect.y,
            width: elementRect.width,
            height: elementRect.height,
          }
        : null);

    if (!targetRect) return;

    const attributes: Record<string, string> = {};
    if (selectedElement) {
      ["role", "aria-label", "data-testid"].forEach((name) => {
        const value = selectedElement?.getAttribute(name);
        if (value) attributes[name] = value;
      });
    }

    const payload = {
      protocolVersion: "0.1",
      surface: {
        id: surfaceId,
        platform: "web",
        uri: window.location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
        adapter: { name: "web-overlay", version: "0.1.0" },
      },
      nodes: selectedElement
        ? [
            {
              id: nodeId,
              surfaceId,
              kind: "element",
              name: selectedElement.tagName.toLowerCase(),
              stableSelector: selectorFor(selectedElement),
              text: (selectedElement.textContent ?? "").trim().slice(0, 240),
              attributes,
            },
          ]
        : [],
      frames: [
        {
          id: frameId,
          surfaceId,
          x: 0,
          y: 0,
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          scale: window.devicePixelRatio || 1,
        },
      ],
      regions: [
        {
          id: regionId,
          surfaceId,
          frameId,
          ...targetRect,
          unit: "px",
          coordinateSpace: "viewport",
        },
      ],
      relations: nodeId
        ? [
            {
              id: id(),
              type: "anchors",
              from: { entity: "region", id: regionId },
              to: { entity: "node", id: nodeId },
            },
          ]
        : [],
      annotations: [
        {
          id: annotationId,
          kind: "comment",
          body: instruction,
          ...(nodeId ? { nodeId } : {}),
          regionId,
          createdAt: new Date().toISOString(),
        },
      ],
      intent: {
        id: id(),
        action: "change",
        instruction,
        acceptanceCriteria: [],
      },
    };

    try {
      const response = await fetch(`${apiBase}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      textarea.value = "";
      selectedElement = null;
      drawnRegion = null;
      displayRect(highlight, null);
      displayRect(drawBox, null);
      targetLabel.textContent = "Choose an element or draw a region";
      showToast("Task saved locally");
      await loadTasks();
    } catch (error) {
      showToast(`Could not save task: ${String(error)}`);
    }
  }

  required<HTMLButtonElement>("[data-action='select']").addEventListener(
    "click",
    () => setMode("select"),
  );
  required<HTMLButtonElement>("[data-action='draw']").addEventListener(
    "click",
    () => setMode("draw"),
  );
  required<HTMLButtonElement>("[data-action='comment']").addEventListener(
    "click",
    () => textarea.focus(),
  );
  required<HTMLButtonElement>("[data-action='tasks']").addEventListener(
    "click",
    () => {
      panel.dataset.open = panel.dataset.open === "true" ? "false" : "true";
      if (panel.dataset.open === "true") void loadTasks();
    },
  );
  required<HTMLButtonElement>("[data-action='apply']").addEventListener(
    "click",
    () => {
      void applyTask();
    },
  );

  function connectSocket(): void {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/_visual-intent/ws`,
    );
    socket.addEventListener("message", () => {
      if (panel.dataset.open === "true") void loadTasks();
    });
    socket.addEventListener("close", () =>
      window.setTimeout(connectSocket, 1500),
    );
  }

  connectSocket();
}

export function createOverlayScript(): string {
  return `;(${bootOverlay.toString()})();`;
}
