function bootOverlay(): void {
  if (document.getElementById("visual-intent-overlay-root")) return;

  type Mode = "idle" | "select" | "draw";
  type Rect = { x: number; y: number; width: number; height: number };
  type OverlayTask = {
    id: string;
    status: string;
    revision: number;
    intent: { instruction: string };
    nodes: Array<{ stableSelector?: string }>;
  };
  type OverlaySession = {
    displayName: string;
    repository: { name: string };
    executor: {
      kind: "disconnected" | "codex";
      status: string;
      threadId?: string;
    };
  };
  type OverlayBatch = {
    id: string;
    status: string;
    taskIds: string[];
    result?: { summary: string };
  };

  const apiBase = "/_visual-intent/api";
  const apiToken = "__VISUAL_INTENT_TOKEN__";
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
      button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
      button:disabled { cursor: default; opacity: .45; }
      button[data-active="true"] { color: white; background: #2563eb; }
      button.vip-primary { color: #052e16; background: #86efac; }
      button.vip-primary:hover:not(:disabled) { background: #bbf7d0; }
      button.vip-danger { color: #fecaca; }
      button.vip-danger:hover { color: white; background: rgba(239,68,68,.28); }
      .vip-brand { padding: 0 7px; font-weight: 800; letter-spacing: -.02em; color: white; }
      .vip-separator { width: 1px; height: 22px; background: rgba(148,163,184,.3); }
      .vip-composer { pointer-events: auto; position: absolute; display: none; width: min(370px, calc(100vw - 24px)); padding: 12px; border: 1px solid rgba(148,163,184,.3); border-radius: 14px; background: rgba(15,23,42,.97); box-shadow: 0 22px 58px rgba(15,23,42,.38); }
      .vip-composer[data-open="true"] { display: block; animation: vip-in .15s ease-out; }
      @keyframes vip-in { from { opacity: 0; transform: translateY(7px) scale(.985); } to { opacity: 1; transform: none; } }
      .vip-composer-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .vip-target { min-width: 0; flex: 1; color: #93c5fd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .vip-icon-button { width: 28px; height: 28px; padding: 0; font-size: 18px; line-height: 1; }
      textarea { display: block; width: 100%; min-height: 82px; resize: vertical; border: 1px solid #334155; border-radius: 9px; padding: 9px 10px; background: #0f172a; color: white; font: inherit; outline: none; }
      textarea:focus { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
      .vip-composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; }
      .vip-hint { color: #94a3b8; font-size: 11px; }
      .vip-actions { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
      .vip-highlight, .vip-draw-box { position: fixed; display: none; border: 2px solid #3b82f6; background: rgba(59,130,246,.13); pointer-events: none; }
      .vip-draw-box { border-style: dashed; border-color: #f59e0b; background: rgba(245,158,11,.12); }
      .vip-panel { pointer-events: auto; position: absolute; top: 70px; right: 18px; display: none; width: min(410px, calc(100vw - 36px)); max-height: calc(100vh - 90px); overflow: auto; border: 1px solid rgba(148,163,184,.25); border-radius: 14px; padding: 12px; background: rgba(15,23,42,.97); box-shadow: 0 18px 48px rgba(15,23,42,.3); }
      .vip-panel[data-open="true"] { display: block; }
      .vip-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 14px; font-weight: 800; }
      .vip-panel-subtitle { margin-bottom: 10px; color: #94a3b8; font-size: 12px; }
      .vip-runtime { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; margin-bottom: 10px; padding: 9px 10px; border: 1px solid #334155; border-radius: 10px; background: rgba(30,41,59,.72); }
      .vip-runtime-dot { width: 8px; height: 8px; border-radius: 999px; background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.15); }
      .vip-runtime[data-connected="true"] .vip-runtime-dot { background: #4ade80; box-shadow: 0 0 0 3px rgba(74,222,128,.15); }
      .vip-runtime-project { min-width: 0; overflow: hidden; color: white; font-size: 12px; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
      .vip-runtime-executor { color: #94a3b8; font-size: 11px; text-transform: capitalize; }
      .vip-last-batch { margin-bottom: 10px; padding: 8px 10px; border-radius: 9px; background: rgba(37,99,235,.16); color: #bfdbfe; font-size: 11px; }
      .vip-last-batch[data-status="failed"], .vip-last-batch[data-status="needs_input"] { background: rgba(239,68,68,.14); color: #fecaca; }
      .vip-retry { width: 100%; margin: -2px 0 10px; }
      .vip-retry[hidden] { display: none; }
      .vip-count { display: inline-grid; min-width: 22px; height: 22px; place-items: center; padding: 0 6px; border-radius: 999px; background: #334155; color: white; font-size: 11px; }
      .vip-task { padding: 10px; border: 1px solid #334155; border-radius: 10px; margin-top: 8px; background: rgba(30,41,59,.8); }
      .vip-task-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .vip-task-status { color: #86efac; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
      .vip-task-target { margin-top: 5px; color: #93c5fd; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .vip-task-copy { width: 100%; margin-top: 6px; padding: 0; color: #e2e8f0; font-weight: 500; text-align: left; white-space: pre-wrap; }
      .vip-task-copy:hover { background: transparent; text-decoration: underline; text-underline-offset: 3px; }
      .vip-task-actions { display: flex; justify-content: flex-end; gap: 4px; margin-top: 8px; }
      .vip-task-editor { margin-top: 8px; }
      .vip-task-editor textarea { min-height: 90px; }
      .vip-empty { color: #94a3b8; padding: 16px 2px 10px; text-align: center; }
      .vip-toast { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%) translateY(20px); opacity: 0; padding: 9px 13px; border-radius: 999px; background: #0f172a; color: white; box-shadow: 0 12px 36px rgba(15,23,42,.3); transition: .18s ease; }
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
        <button class="vip-primary" data-action="apply" disabled>Apply</button>
      </div>
      <section class="vip-panel" aria-label="Visual tasks">
        <div class="vip-panel-header"><span>Tasks to apply</span><span class="vip-count">0</span></div>
        <div class="vip-panel-subtitle">Edit the queue, then send it to your coding agent with Apply.</div>
        <div class="vip-runtime">
          <span class="vip-runtime-dot"></span>
          <span class="vip-runtime-project">Loading project…</span>
          <span class="vip-runtime-executor">disconnected</span>
        </div>
        <div class="vip-last-batch" hidden></div>
        <button class="vip-primary vip-retry" hidden>Retry batch</button>
        <div class="vip-task-list"></div>
      </section>
      <section class="vip-composer" aria-label="Add visual task">
        <div class="vip-composer-head">
          <div class="vip-target">Choose an element or draw a region</div>
          <button class="vip-icon-button" data-composer-action="close" aria-label="Close comment">×</button>
        </div>
        <textarea aria-label="Change request" placeholder="Describe what should change…"></textarea>
        <div class="vip-composer-foot">
          <div class="vip-hint">Ctrl/⌘ + Enter to save</div>
          <div class="vip-actions">
            <button data-composer-action="cancel">Cancel</button>
            <button class="vip-primary" data-composer-action="save">Add task</button>
          </div>
        </div>
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
  const composer = required<HTMLElement>(".vip-composer");
  const targetLabel = required<HTMLElement>(".vip-target");
  const textarea = required<HTMLTextAreaElement>(".vip-composer > textarea");
  const panel = required<HTMLElement>(".vip-panel");
  const taskList = required<HTMLElement>(".vip-task-list");
  const taskCount = required<HTMLElement>(".vip-count");
  const applyButton = required<HTMLButtonElement>("[data-action='apply']");
  const runtime = required<HTMLElement>(".vip-runtime");
  const runtimeProject = required<HTMLElement>(".vip-runtime-project");
  const runtimeExecutor = required<HTMLElement>(".vip-runtime-executor");
  const lastBatch = required<HTMLElement>(".vip-last-batch");
  const retryButton = required<HTMLButtonElement>(".vip-retry");
  const toastElement = required<HTMLElement>(".vip-toast");

  let mode: Mode = "idle";
  let selectedElement: Element | null = null;
  let drawnRegion: Rect | null = null;
  let drawStart: { x: number; y: number } | null = null;
  let toastTimer: number | undefined;
  let readyTasks: OverlayTask[] = [];

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
    mode = next;
    shadow
      .querySelectorAll<HTMLButtonElement>(
        "[data-action='select'], [data-action='draw']",
      )
      .forEach((button) => {
        button.dataset.active = String(button.dataset.action === mode);
      });
    document.documentElement.style.cursor = mode === "idle" ? "" : "crosshair";
  }

  function toggleMode(next: Exclude<Mode, "idle">): void {
    const active = mode === next;
    setMode(active ? "idle" : next);
    if (!active) {
      composer.dataset.open = "false";
      panel.dataset.open = "false";
    }
  }

  function showToast(message: string): void {
    toastElement.textContent = message;
    toastElement.dataset.visible = "true";
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastElement.dataset.visible = "false";
    }, 2600);
  }

  function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (apiToken) headers.set("x-visual-intent-token", apiToken);
    return fetch(input, { ...init, headers });
  }

  function activeRect(): Rect | null {
    if (selectedElement) return selectedElement.getBoundingClientRect();
    return drawnRegion;
  }

  function positionComposer(rect: Rect): void {
    const margin = 12;
    const gap = 10;
    const bounds = composer.getBoundingClientRect();
    const width = bounds.width || Math.min(370, window.innerWidth - 24);
    const height = bounds.height || 190;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    let left = rect.x + rect.width + gap;
    if (left + width > window.innerWidth - margin) {
      left = rect.x - width - gap;
    }
    if (left < margin) {
      left = Math.min(maxLeft, Math.max(margin, rect.x));
    }

    let top = Math.min(maxTop, Math.max(margin, rect.y));
    const hasHorizontalRoom =
      rect.x + rect.width + gap + width <= window.innerWidth - margin ||
      rect.x - gap - width >= margin;
    if (!hasHorizontalRoom) {
      const below = rect.y + rect.height + gap;
      const above = rect.y - height - gap;
      top =
        below + height <= window.innerHeight - margin
          ? below
          : Math.max(margin, above);
    }

    composer.style.left = `${Math.min(maxLeft, Math.max(margin, left))}px`;
    composer.style.top = `${top}px`;
  }

  function openComposer(): void {
    const rect = activeRect();
    if (!rect) {
      showToast("Select an element or draw a region first");
      return;
    }
    panel.dataset.open = "false";
    composer.dataset.open = "true";
    positionComposer(rect);
    textarea.focus();
  }

  function resetCapture(): void {
    composer.dataset.open = "false";
    textarea.value = "";
    selectedElement = null;
    drawnRegion = null;
    drawStart = null;
    displayRect(highlight, null);
    displayRect(drawBox, null);
    targetLabel.textContent = "Choose an element or draw a region";
    setMode("idle");
  }

  function refreshCapturePosition(): void {
    const rect = activeRect();
    if (!rect) return;
    if (selectedElement) displayRect(highlight, rect);
    if (composer.dataset.open === "true") positionComposer(rect);
  }

  function selectElement(element: Element): void {
    selectedElement = element;
    drawnRegion = null;
    displayRect(drawBox, null);
    displayRect(highlight, element.getBoundingClientRect());
    targetLabel.textContent = `Selected: ${selectorFor(element)}`;
    setMode("idle");
    openComposer();
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
        openComposer();
      }
    },
    true,
  );

  window.addEventListener("resize", refreshCapturePosition);
  document.addEventListener("scroll", refreshCapturePosition, true);

  async function responseError(response: Response): Promise<Error> {
    try {
      const body = (await response.json()) as { error?: string };
      return new Error(body.error ?? `HTTP ${response.status}`);
    } catch {
      return new Error(`HTTP ${response.status}`);
    }
  }

  function renderTask(task: OverlayTask): HTMLElement {
    const item = document.createElement("article");
    item.className = "vip-task";
    item.dataset.taskId = task.id;

    const head = document.createElement("div");
    head.className = "vip-task-head";
    const status = document.createElement("div");
    status.className = "vip-task-status";
    status.textContent = task.status.replaceAll("_", " ");
    const shortId = document.createElement("span");
    shortId.textContent = task.id.slice(0, 8);
    shortId.title = task.id;
    head.append(status, shortId);

    const target = document.createElement("div");
    target.className = "vip-task-target";
    target.textContent = task.nodes[0]?.stableSelector ?? "Drawn region";

    const copy = document.createElement("button");
    copy.className = "vip-task-copy";
    copy.textContent = task.intent.instruction;
    copy.title = "Open task for editing";

    const actions = document.createElement("div");
    actions.className = "vip-task-actions";
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    const remove = document.createElement("button");
    remove.className = "vip-danger";
    remove.textContent = "Delete";
    actions.append(edit, remove);

    const openEditor = (): void => {
      if (item.querySelector(".vip-task-editor")) return;
      copy.style.display = "none";
      actions.style.display = "none";
      const editor = document.createElement("div");
      editor.className = "vip-task-editor";
      const input = document.createElement("textarea");
      input.setAttribute("aria-label", "Edit task");
      input.value = task.intent.instruction;
      const editorActions = document.createElement("div");
      editorActions.className = "vip-task-actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      const save = document.createElement("button");
      save.className = "vip-primary";
      save.textContent = "Save";
      editorActions.append(cancel, save);
      editor.append(input, editorActions);
      item.append(editor);
      input.focus();

      cancel.addEventListener("click", () => {
        editor.remove();
        copy.style.display = "";
        actions.style.display = "";
      });
      save.addEventListener("click", () => {
        const instruction = input.value.trim();
        if (!instruction) {
          showToast("Task description cannot be empty");
          input.focus();
          return;
        }
        save.disabled = true;
        void (async () => {
          try {
            const response = await apiFetch(
              `${apiBase}/tasks/${encodeURIComponent(task.id)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  expectedRevision: task.revision,
                  instruction,
                }),
              },
            );
            if (!response.ok) throw await responseError(response);
            showToast("Task updated");
            await loadTasks();
          } catch (error) {
            showToast(`Could not update task: ${String(error)}`);
            save.disabled = false;
          }
        })();
      });
    };

    copy.addEventListener("click", openEditor);
    edit.addEventListener("click", openEditor);
    remove.addEventListener("click", () => {
      remove.disabled = true;
      void (async () => {
        try {
          const response = await apiFetch(
            `${apiBase}/tasks/${encodeURIComponent(task.id)}`,
            { method: "DELETE" },
          );
          if (!response.ok) throw await responseError(response);
          showToast("Task deleted");
          await loadTasks();
        } catch (error) {
          showToast(`Could not delete task: ${String(error)}`);
          remove.disabled = false;
        }
      })();
    });

    item.append(head, target, copy, actions);
    return item;
  }

  async function loadTasks(): Promise<void> {
    try {
      const response = await apiFetch(`${apiBase}/tasks?status=ready`);
      if (!response.ok) throw await responseError(response);
      readyTasks = (await response.json()) as OverlayTask[];
      taskCount.textContent = String(readyTasks.length);
      applyButton.disabled = readyTasks.length === 0;
      applyButton.title =
        readyTasks.length === 0
          ? "Add a task first"
          : `Send ${readyTasks.length} task${readyTasks.length === 1 ? "" : "s"} to the coding agent`;
      taskList.replaceChildren();

      if (readyTasks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "vip-empty";
        empty.textContent = "No tasks waiting to be applied.";
        taskList.append(empty);
        return;
      }

      readyTasks.forEach((task) => taskList.append(renderTask(task)));
    } catch (error) {
      showToast(`Could not load tasks: ${String(error)}`);
    }
  }

  async function loadRuntime(): Promise<void> {
    try {
      const [sessionResponse, batchesResponse] = await Promise.all([
        apiFetch(`${apiBase}/session`),
        apiFetch(`${apiBase}/batches`),
      ]);
      if (!sessionResponse.ok) throw await responseError(sessionResponse);
      if (!batchesResponse.ok) throw await responseError(batchesResponse);
      const session = (await sessionResponse.json()) as OverlaySession;
      const batches = (await batchesResponse.json()) as OverlayBatch[];
      const connected =
        session.executor.kind === "codex" &&
        session.executor.status !== "disconnected";
      runtime.dataset.connected = String(connected);
      runtimeProject.textContent = session.displayName;
      runtimeProject.title = `Repository: ${session.repository.name}`;
      runtimeExecutor.textContent = connected
        ? `Codex · ${session.executor.status.replaceAll("_", " ")}`
        : "Codex · disconnected";

      const batch = batches[0];
      if (!batch) {
        lastBatch.hidden = true;
        retryButton.hidden = true;
        delete retryButton.dataset.batchId;
        return;
      }
      lastBatch.hidden = false;
      lastBatch.dataset.status = batch.status;
      const summary = batch.result?.summary;
      lastBatch.textContent = summary
        ? `${batch.status.replaceAll("_", " ")}: ${summary}`
        : `${batch.taskIds.length} task${batch.taskIds.length === 1 ? "" : "s"} · ${batch.status.replaceAll("_", " ")}`;
      retryButton.hidden =
        batch.status !== "needs_input" && batch.status !== "failed";
      retryButton.dataset.batchId = batch.id;
    } catch {
      runtime.dataset.connected = "false";
      runtimeProject.textContent = "Visual Intent unavailable";
      runtimeExecutor.textContent = "disconnected";
    }
  }

  function buildTaskPayload(instruction: string): object | null {
    const surfaceId = id();
    const frameId = id();
    const nodeId = selectedElement ? id() : null;
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

    if (!targetRect) return null;

    const attributes: Record<string, string> = {};
    if (selectedElement) {
      ["role", "aria-label", "data-testid"].forEach((name) => {
        const value = selectedElement?.getAttribute(name);
        if (value) attributes[name] = value;
      });
    }

    return {
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
      nodes:
        selectedElement && nodeId
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
  }

  async function saveTask(): Promise<void> {
    const instruction = textarea.value.trim();
    if (!activeRect()) {
      showToast("Select an element or draw a region first");
      return;
    }
    if (!instruction) {
      showToast("Describe the requested change first");
      textarea.focus();
      return;
    }

    const payload = buildTaskPayload(instruction);
    if (!payload) return;
    const saveButton = required<HTMLButtonElement>(
      "[data-composer-action='save']",
    );
    saveButton.disabled = true;

    try {
      const response = await apiFetch(`${apiBase}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw await responseError(response);
      resetCapture();
      showToast("Task added to the list");
      await loadTasks();
    } catch (error) {
      showToast(`Could not save task: ${String(error)}`);
    } finally {
      saveButton.disabled = false;
    }
  }

  async function applyTasks(): Promise<void> {
    if (composer.dataset.open === "true" && textarea.value.trim()) {
      showToast("Add or cancel the open comment before applying");
      textarea.focus();
      return;
    }
    if (readyTasks.length === 0) {
      showToast("Add a task first");
      return;
    }

    applyButton.disabled = true;
    try {
      const response = await apiFetch(`${apiBase}/tasks/apply`, {
        method: "POST",
      });
      if (!response.ok) throw await responseError(response);
      const result = (await response.json()) as {
        accepted: number;
        batch?: { status: string };
        session?: OverlaySession;
      };
      panel.dataset.open = "true";
      await Promise.all([loadTasks(), loadRuntime()]);
      const waiting = result.batch?.status === "waiting_for_executor";
      showToast(
        waiting
          ? `${result.accepted} task${result.accepted === 1 ? "" : "s"} queued — connect the project Codex chat`
          : `${result.accepted} task${result.accepted === 1 ? "" : "s"} sent to ${result.session?.displayName ?? "Codex"}`,
      );
    } catch (error) {
      showToast(`Could not apply tasks: ${String(error)}`);
      applyButton.disabled = readyTasks.length === 0;
    }
  }

  async function retryBatch(): Promise<void> {
    const batchId = retryButton.dataset.batchId;
    if (!batchId) return;
    retryButton.disabled = true;
    try {
      const response = await apiFetch(
        `${apiBase}/batches/${encodeURIComponent(batchId)}/retry`,
        { method: "POST" },
      );
      if (!response.ok) throw await responseError(response);
      const result = (await response.json()) as { batch: OverlayBatch };
      await Promise.all([loadTasks(), loadRuntime()]);
      showToast(
        result.batch.status === "waiting_for_executor"
          ? "Batch is waiting for a project Codex chat"
          : "Batch queued again",
      );
    } catch (error) {
      showToast(`Could not retry batch: ${String(error)}`);
    } finally {
      retryButton.disabled = false;
    }
  }

  required<HTMLButtonElement>("[data-action='select']").addEventListener(
    "click",
    () => toggleMode("select"),
  );
  required<HTMLButtonElement>("[data-action='draw']").addEventListener(
    "click",
    () => toggleMode("draw"),
  );
  required<HTMLButtonElement>("[data-action='comment']").addEventListener(
    "click",
    openComposer,
  );
  required<HTMLButtonElement>("[data-action='tasks']").addEventListener(
    "click",
    () => {
      panel.dataset.open = panel.dataset.open === "true" ? "false" : "true";
      if (panel.dataset.open === "true") void loadTasks();
    },
  );
  applyButton.addEventListener("click", () => void applyTasks());
  retryButton.addEventListener("click", () => void retryBatch());
  required<HTMLButtonElement>(
    "[data-composer-action='close']",
  ).addEventListener("click", resetCapture);
  required<HTMLButtonElement>(
    "[data-composer-action='cancel']",
  ).addEventListener("click", resetCapture);
  required<HTMLButtonElement>("[data-composer-action='save']").addEventListener(
    "click",
    () => void saveTask(),
  );

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") resetCapture();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveTask();
    }
  });

  function connectSocket(): void {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/_visual-intent/ws?token=${encodeURIComponent(apiToken)}`,
    );
    socket.addEventListener("message", () => {
      void loadTasks();
      void loadRuntime();
    });
    socket.addEventListener("close", () =>
      window.setTimeout(connectSocket, 1500),
    );
  }

  void loadTasks();
  void loadRuntime();
  connectSocket();
}

export function createOverlayScript(
  options: { apiToken?: string } = {},
): string {
  const source = bootOverlay
    .toString()
    .replace(
      '"__VISUAL_INTENT_TOKEN__"',
      JSON.stringify(options.apiToken ?? ""),
    );
  return `;(${source})();`;
}
