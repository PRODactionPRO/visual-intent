import { ICONS } from "./icon-data.js";

export type TaskUsageAllocationSignal = {
  id: string;
  categories?: string[];
  scale?: string;
  changedFiles?: string[];
};

export type TaskUsageAllocationTotals = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costMicros?: number;
};

export type EstimatedTaskUsageAllocation = TaskUsageAllocationTotals & {
  total: number;
  share: number;
  weight: number;
};

export function allocateEstimatedTaskUsage(
  totals: TaskUsageAllocationTotals,
  tasks: TaskUsageAllocationSignal[],
): Record<string, EstimatedTaskUsageAllocation> {
  if (!tasks.length) return {};

  const scalePoints: Record<string, number> = {
    element: 0,
    region: 1,
    screen: 2,
    "multi-screen": 3,
    system: 4,
    unknown: 1,
  };
  const categoryPoints: Record<string, number> = {
    style: 0,
    text: 0,
    image: 0,
    layout: 0.5,
    figma: 0.5,
    behavior: 1,
    bug: 1,
    unknown: 0.25,
  };
  const median = (values: Array<number | undefined>): number => {
    const known = values
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right);
    if (!known.length) return 0;
    const middle = Math.floor(known.length / 2);
    return known.length % 2
      ? known[middle]!
      : (known[middle - 1]! + known[middle]!) / 2;
  };
  const scaleSignals = tasks.map((task) =>
    task.scale && task.scale !== "unknown"
      ? scalePoints[task.scale]
      : undefined,
  );
  const categorySignals = tasks.map((task) => {
    const known = (task.categories ?? [])
      .filter((value) => value !== "unknown")
      .map((value) => categoryPoints[value])
      .filter((value): value is number => value !== undefined);
    return known.length ? Math.max(...known) : undefined;
  });
  const footprintSignals = tasks.map((task) =>
    task.changedFiles
      ? Math.log2(1 + new Set(task.changedFiles).size)
      : undefined,
  );
  const scaleFallback = median(scaleSignals);
  const categoryFallback = median(categorySignals);
  const footprintFallback = median(footprintSignals);
  const weights = tasks.map(
    (_, index) =>
      1 +
      (scaleSignals[index] ?? scaleFallback) +
      (categorySignals[index] ?? categoryFallback) +
      (footprintSignals[index] ?? footprintFallback),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  function distribute(total: number): number[] {
    const safeTotal = Math.max(0, Math.round(total));
    const raw = weights.map((weight) => (safeTotal * weight) / totalWeight);
    const values = raw.map(Math.floor);
    let remainder = safeTotal - values.reduce((sum, value) => sum + value, 0);
    const order = raw
      .map((value, index) => ({ index, fraction: value - values[index]! }))
      .sort(
        (left, right) =>
          right.fraction - left.fraction || left.index - right.index,
      );
    for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
      values[order[index % order.length]!.index]! += 1;
    }
    return values;
  }

  const safeInput = Math.max(0, Math.round(totals.input));
  const safeCached = Math.min(
    safeInput,
    Math.max(0, Math.round(totals.cached)),
  );
  const safeCacheWrite = Math.min(
    safeInput - safeCached,
    Math.max(0, Math.round(totals.cacheWrite)),
  );
  const uncached = distribute(safeInput - safeCached - safeCacheWrite);
  const cached = distribute(safeCached);
  const cacheWrite = distribute(safeCacheWrite);
  const safeOutput = Math.max(0, Math.round(totals.output));
  const safeReasoning = Math.min(
    safeOutput,
    Math.max(0, Math.round(totals.reasoning)),
  );
  const reasoning = distribute(safeReasoning);
  const nonReasoning = distribute(safeOutput - safeReasoning);
  const costMicros =
    totals.costMicros === undefined ? undefined : distribute(totals.costMicros);

  return Object.fromEntries(
    tasks.map((task, index) => {
      const taskCached = cached[index] ?? 0;
      const taskCacheWrite = cacheWrite[index] ?? 0;
      const taskInput = (uncached[index] ?? 0) + taskCached + taskCacheWrite;
      const taskReasoning = reasoning[index] ?? 0;
      const taskOutput = (nonReasoning[index] ?? 0) + taskReasoning;
      return [
        task.id,
        {
          input: taskInput,
          cached: taskCached,
          cacheWrite: taskCacheWrite,
          output: taskOutput,
          reasoning: taskReasoning,
          ...(costMicros ? { costMicros: costMicros[index] ?? 0 } : {}),
          total: taskInput + taskOutput,
          share: weights[index]! / totalWeight,
          weight: weights[index]!,
        },
      ];
    }),
  );
}

function bootOverlay(): void {
  if (document.getElementById("visual-intent-overlay-root")) return;

  type Mode =
    | "idle"
    | "select"
    | "pencil"
    | "square"
    | "frame"
    | "figma"
    | "screenshot";
  type Rect = { x: number; y: number; width: number; height: number };
  type Point = { x: number; y: number };
  type Drawing =
    | {
        id: string;
        type: "path";
        points: Point[];
        color: string;
        width: number;
      }
    | { id: string; type: "rect"; rect: Rect; color: string; width: number };
  type Attachment = {
    id: string;
    kind: "screenshot" | "file";
    mimeType: string;
    fileName: string;
    byteSize: number;
    sha256: string;
    path: string;
    width?: number;
    height?: number;
    createdAt: string;
  };
  type TaskKind = "code-change" | "figma-component";
  type TaskTab = "backlog" | "in-progress" | "ready";
  type ReviewOutcome = "accepted" | "needs_revision" | "not_accepted";
  type BatchUsage =
    | {
        availability: "reported";
        capture: "direct" | "host-reported";
        provider?: string;
        source: string;
        scope: "apply-batch-turn";
        exact: true;
        model?: string;
        reasoningPolicy?: string;
        adapterVersion?: string;
        tokens: {
          inputTokens: number;
          cachedInputTokens: number;
          cacheWriteInputTokens: number;
          outputTokens: number;
          reasoningOutputTokens: number;
        };
        apiEquivalentCost?:
          | {
              availability: "calculated";
              kind: "openai-api-equivalent";
              scope: "apply-batch-turn";
              model: string;
              reasoningPolicy?: string;
              amountUsd: string;
              billableTokens: {
                uncachedInputTokens: number;
                cachedInputTokens: number;
                cacheWriteInputTokens: number;
                outputTokens: number;
              };
              pricingSnapshot: {
                id: string;
                capturedAt: string;
                sourceUrl: string;
                currency: "USD";
                serviceTier: "standard";
                contextTierAssumption: "up-to-272k-input-per-request";
                inputUsdPerMillion: string;
                cachedInputUsdPerMillion: string;
                cacheWriteInputUsdPerMillion: string;
                outputUsdPerMillion: string;
                promotionalThrough?: string;
              };
              reasoningIncludedInOutput: true;
              estimateBasis: "aggregate-turn-short-context";
            }
          | { availability: "unavailable"; reason: string };
      }
    | { availability: "unavailable"; reason: string };
  type OverlayTask = {
    id: string;
    displayNumber?: number;
    kind: TaskKind;
    status: string;
    revision: number;
    protocolVersion: "0.1";
    surface: Record<string, unknown>;
    intent: {
      id: string;
      action: string;
      instruction: string;
      acceptanceCriteria: string[];
    };
    nodes: Array<Record<string, unknown> & { stableSelector?: string }>;
    regions: Array<Rect & { coordinateSpace: "viewport" | "surface" | "node" }>;
    frames: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
    annotations: Array<Record<string, unknown>>;
    attachments: Attachment[];
    batchId?: string;
    iterationId: string;
    rootTaskId: string;
    previousTaskId?: string;
    round: number;
    review?: {
      outcome: ReviewOutcome;
      reviewedAt: string;
      note?: string;
      followUpTaskId?: string;
    };
    rating?: { value: number; ratedAt: string };
    createdAt: string;
    updatedAt: string;
    result?: {
      summary: string;
      changedFiles: string[];
      notes: string[];
      classification?: {
        categories: string[];
        scale: string;
      };
    };
  };
  type OverlaySession = {
    displayName: string;
    repository: { name: string };
    executor: {
      kind: "disconnected" | "codex";
      status: string;
      ownership: "host-attached" | "visual-intent-owned";
      threadId?: string;
    };
  };
  type OverlayBatch = {
    id: string;
    status: string;
    taskIds: string[];
    attempt?: number;
    executorOwnership?: "host-attached" | "visual-intent-owned";
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    workingTreeBaseline?: {
      fingerprint: string;
      files: Array<{ path: string; status: string }>;
    };
    result?: {
      executionId?: string;
      summary: string;
      batchChangedFiles?: string[];
      preExistingDirtyFiles?: string[];
      technicalDetails?: string;
      retryable?: boolean;
      failureCode?: string;
      usage?: BatchUsage;
    };
  };
  type OverlayExecution = {
    id: string;
    batchId: string;
    attempt: number;
    taskIds: string[];
    model?: string;
    reasoningPolicy?: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    usage: BatchUsage;
  };
  type OverlayTaskGroup = {
    id: string;
    batch?: OverlayBatch;
    tasks: OverlayTask[];
  };
  type FormattedBatchUsage = {
    label: string;
    totalLabel: string;
    costLabel: string;
    tokenLabel: string;
    tokenParts: string[];
    partial: boolean;
    estimated: boolean;
    title: string;
    raw?: TaskUsageAllocationTotals & { total: number };
  };
  type DirtyWorktreePolicy = "allow-host-attached" | "require-confirmation";
  type OverlayProjectSettings = {
    dirtyWorktreePolicy: DirtyWorktreePolicy;
    revision: number;
    updatedAt: string;
  };
  type TargetContext = { rect: Rect; label: string; element?: Element };
  type ComposerDraftSnapshot = {
    target: TargetContext;
    kind: TaskKind;
    text: string;
    attachments: Attachment[];
    placementRect?: Rect;
    editingTask?: OverlayTask;
    revisionSourceTask?: OverlayTask;
  };
  type HistoryCommand = {
    undo(): void | Promise<void>;
    redo(): void | Promise<void>;
  };

  const apiBase = "/_visual-intent/api";
  const apiToken = "__VISUAL_INTENT_TOKEN__";
  const icons = JSON.parse("__VISUAL_INTENT_ICONS__") as Record<string, string>;
  const overlayHost = document.createElement("div");
  overlayHost.id = "visual-intent-overlay-root";
  for (const [property, value] of Object.entries({
    position: "fixed",
    inset: "0",
    display: "block",
    margin: "0",
    padding: "0",
    border: "0",
    "z-index": "2147483647",
    "pointer-events": "none",
  }))
    overlayHost.style.setProperty(property, value, "important");
  document.documentElement.append(overlayHost);
  const shadow = overlayHost.attachShadow({ mode: "open" });
  const icon = (name: string): string => icons[name] ?? "";
  function createIconElement(name: string): SVGSVGElement {
    const template = document.createElement("template");
    template.innerHTML = icon(name);
    const element = template.content.firstElementChild;
    if (!(element instanceof SVGSVGElement))
      throw new Error(`Visual Intent icon is missing: ${name}`);
    return element;
  }

  shadow.innerHTML = `
  <style>
    :host{all:initial!important;position:fixed!important;inset:0!important;display:block!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;pointer-events:none!important}
    *{box-sizing:border-box}button,textarea,input{font:inherit}button{appearance:none;border:0}button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
    .vip-shell{--bg:#fff;--soft:#f2f2f2;--text:#0c0e10;--muted:#8ca2a7;--disabled:#acaeb4;--border:rgba(148,163,184,.25);--blue:#1489f6;--danger:#dc2626;--scroll-thumb:#aeb3ba;--shadow:0 15px 29.6px rgba(15,23,42,.09);position:absolute;inset:0;pointer-events:none;color:var(--text);font:14px/20px Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.15px}
    .vip-shell[data-theme=dark]{--bg:#171a1d;--soft:#272b30;--text:#f8fafc;--muted:#9ba7ad;--disabled:#687078;--border:rgba(148,163,184,.28);--blue:#269cff;--shadow:0 15px 30px rgba(0,0,0,.38)}
    .vip-shell *{scrollbar-color:var(--scroll-thumb) transparent}.vip-shell *::-webkit-scrollbar-track,.vip-shell *::-webkit-scrollbar-corner{background:transparent}.vip-shell *::-webkit-scrollbar-thumb{border-radius:999px;background:var(--scroll-thumb)}
    .vip-icon{display:block;width:20px;height:20px;overflow:visible;color:currentColor;pointer-events:none}
    .vip-toolbar{pointer-events:auto;position:absolute;top:18px;left:50%;height:51px;display:flex;align-items:center;gap:20px;padding:8px 11px;border:1px solid var(--border);border-radius:16px;background:var(--bg);box-shadow:var(--shadow);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;white-space:nowrap}
    .vip-toolbar[data-dragging=true]{cursor:grabbing}.vip-toolbar[data-layout=draw] [data-select-only],.vip-toolbar[data-layout=select] [data-draw-only]{display:none}
    .vip-tools{display:flex;align-items:center;gap:4px}.vip-toolbar button{position:relative;display:grid;width:32px;height:32px;flex:0 0 32px;place-items:center;padding:4px;border-radius:4px;background:transparent;color:var(--text);cursor:pointer;transition:background-color .1s ease}.vip-toolbar button:hover:not(:disabled){background:var(--soft)}.vip-toolbar button[data-active=true],.vip-toolbar button[data-active=true]:hover{background:var(--blue);color:#fff}.vip-toolbar button:disabled{cursor:default;background:transparent;color:var(--disabled);opacity:1}
    .vip-brand{display:flex;width:102px;height:35px;flex:0 0 102px;flex-direction:column;justify-content:space-between;cursor:grab;overflow:hidden;user-select:none}.vip-brand-title{font-family:Manrope,Inter,sans-serif;font-size:14px;font-weight:700;line-height:20px;letter-spacing:-.01px;white-space:nowrap}.vip-brand-mode{color:var(--muted);font-family:Manrope,Inter,sans-serif;font-size:10px;font-weight:500;line-height:14px;letter-spacing:-.01px;white-space:nowrap}.vip-separator{position:relative;width:9px;height:28px;flex:0 0 9px}.vip-separator::after{content:"";position:absolute;inset:0 auto 0 4px;width:1px;background:var(--border)}
    .vip-draw-settings{display:flex;align-items:center;gap:4px;padding:0 6px}.vip-color-wrap{position:relative}.vip-color-button{border-radius:4px!important}.vip-color-dot{width:25px;height:25px;border:1px solid rgba(12,14,16,.55);border-radius:999px;background:var(--draw-color)}.vip-palette{position:absolute;top:40px;left:50%;display:none;grid-template-columns:repeat(3,28px);gap:7px;transform:translateX(-50%);padding:9px;border:1px solid var(--border);border-radius:12px;background:var(--bg);box-shadow:var(--shadow);pointer-events:auto}.vip-palette[data-open=true]{display:grid}.vip-palette button{width:28px;height:28px;border:1px solid var(--border);border-radius:999px}
    .vip-width-control{display:flex;width:194px;height:22px;align-items:center;overflow:hidden;border-radius:4px;background:var(--soft)}.vip-width-value{display:grid;width:44px;height:22px;flex:0 0 44px;place-items:center;border-right:1px solid var(--bg);font-size:12px;line-height:15px}.vip-width-control input{width:137px;height:12px;margin:0 6px;accent-color:var(--blue);cursor:pointer}
    .vip-apply{width:59px!important;height:35px!important;min-width:59px;padding:0 11px!important;border-radius:10px!important;background:#20293a!important;color:#fff!important;font-size:13px!important;font-weight:600!important;line-height:18px!important}.vip-shell[data-theme=dark] .vip-apply:not(:disabled){background:var(--blue)!important}.vip-apply:disabled{background:#c0c0c0!important;color:#fff!important;opacity:1!important}.vip-task-badge{position:absolute;top:-2px;right:-2px;display:none;min-width:16px;height:16px;place-items:center;padding:0 4px;border-radius:999px;background:#2563eb;color:#fff;font-size:8px;line-height:10px;font-weight:500;letter-spacing:0}.vip-task-badge[data-visible=true]{display:grid}
    .vip-canvas{position:fixed;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}.vip-highlight,.vip-frame-box{position:fixed;display:none;pointer-events:none;border:2px solid var(--blue);background:rgba(30,143,241,.11);border-radius:2px}.vip-frame-box{border:2px dashed #f59e0b;background:rgba(245,158,11,.08);border-radius:4px}
    .vip-element-inspector{pointer-events:none;position:fixed;display:none;width:240px;padding:9px 10px;border:1px solid var(--border);border-radius:12px;background:var(--bg);color:var(--text);box-shadow:0 10px 28px rgba(15,23,42,.16);font:500 12px/16px Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}.vip-shell[data-theme=dark] .vip-element-inspector{box-shadow:0 12px 32px rgba(0,0,0,.42)}.vip-element-inspector[data-visible=true]{display:grid;gap:2px}.vip-element-inspector-row{display:grid;grid-template-columns:50px minmax(0,1fr);align-items:center;gap:8px;min-width:0}.vip-element-inspector-row:first-child{grid-template-columns:minmax(0,1fr) auto}.vip-element-inspector-label{color:var(--muted)}.vip-element-inspector-value{min-width:0;overflow:hidden;text-align:right;text-overflow:ellipsis;white-space:nowrap}.vip-element-inspector-font{font-family:ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace}.vip-element-inspector::after{content:"";position:absolute;left:var(--inspector-anchor-x,24px);width:9px;height:9px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--bg)}.vip-element-inspector[data-placement=above]::after{bottom:-5px;transform:rotate(45deg)}.vip-element-inspector[data-placement=below]::after{top:-5px;transform:rotate(225deg)}.vip-element-inspector[data-placement=over]::after{display:none}
    .vip-anchor-layer{position:fixed;inset:0;pointer-events:none}.vip-anchor{pointer-events:auto;position:absolute;display:grid;width:27px;height:27px;place-items:center;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:999px;background:#2875e5;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.22);cursor:pointer;font-size:12px;font-weight:800}.vip-anchor .vip-icon{width:13px;height:13px}
    .vip-composer{pointer-events:auto;position:absolute;display:none;width:min(320px,calc(100vw - 24px));padding:8px 9px;border:1px solid var(--border);border-radius:25px;background:var(--bg);box-shadow:var(--shadow);transition:width .1s ease}.vip-composer[data-open=true]{display:flex;flex-direction:column;animation:vip-in .14s ease-out}.vip-composer[data-has-text=true][data-multiline=false]:not([data-has-attachments=true]){width:min(354px,calc(100vw - 24px))}.vip-composer[hidden]{display:none!important;pointer-events:none!important}@keyframes vip-in{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
    .vip-composer-main{display:flex;min-height:32px;align-items:center;justify-content:space-between}.vip-composer-content{display:flex;min-width:0;flex:1;align-items:center;gap:4px}.vip-context-icon{display:grid;width:32px;height:32px;flex:0 0 32px;place-items:center}.vip-context-icon .vip-icon{width:16px;height:16px}.vip-composer textarea{display:block;min-width:0;min-height:24px;height:24px;flex:1;resize:none;overflow:hidden;padding:2px 0;border:0;background:transparent;color:var(--text);outline:0;font:400 14px/20px Inter,ui-sans-serif,sans-serif;letter-spacing:-.1504px}.vip-composer textarea::placeholder{color:var(--muted);opacity:1}.vip-composer-actions{display:flex;height:32px;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:4px}.vip-composer[data-multiline=true] .vip-composer-main{flex-direction:column;align-items:stretch}.vip-composer[data-multiline=true] .vip-composer-content{align-items:flex-start}.vip-composer[data-multiline=true] .vip-composer-actions{align-self:flex-end}.vip-composer[data-kind=figma-component][data-multiline=true] .vip-composer-actions{align-self:auto;justify-content:flex-end;width:100%}.vip-kind{display:none;align-items:center;gap:4px;padding:0 8px;border-radius:8px;font-size:12px;font-weight:500}.vip-composer[data-kind=figma-component][data-multiline=true] .vip-kind{display:flex;margin-right:auto}.vip-kind .vip-icon{width:16px;height:16px}
    .vip-composer-button{display:grid;width:32px;height:32px;flex:0 0 32px;place-items:center;padding:0;border-radius:8px;background:transparent;color:var(--text);cursor:pointer}.vip-composer-button:hover{background:var(--soft)}.vip-composer-button .vip-icon{width:16px;height:16px}.vip-composer-button.vip-save,.vip-composer-button.vip-save:hover{width:28px;height:28px;flex-basis:28px;border-radius:999px;background:var(--blue);color:#fff}.vip-save[hidden]{display:none}
    .vip-attachments{display:flex;gap:4px;overflow:hidden;padding:6px 8px}.vip-attachments:empty{display:none}.vip-attachment{position:relative;width:80px;height:80px;flex:0 0 80px;overflow:hidden;border-radius:8px;background:#d9d9d9}.vip-attachment img{width:100%;height:100%;object-fit:cover}.vip-attachment-file{display:grid;height:100%;place-items:center;padding:6px;color:var(--text);font-size:10px;text-align:center;overflow-wrap:anywhere}.vip-attachment-remove{position:absolute;top:4px;right:4px;display:none;width:20px;height:20px;place-items:center;padding:0;border-radius:999px;background:rgba(12,14,16,.82);color:#fff;cursor:pointer;font-size:14px}.vip-attachment:hover .vip-attachment-remove,.vip-attachment:focus-within .vip-attachment-remove{display:grid}
    .vip-attachment-menu{position:absolute;z-index:4;top:calc(100% + 8px);right:-152px;display:none;width:200px;padding:9px 8px;border:1px solid var(--border);border-radius:16px;background:var(--bg);box-shadow:0 12px 36px rgba(15,23,42,.3)}.vip-attachment-menu[data-open=true]{display:flex;flex-direction:column;gap:4px}.vip-attachment-menu button{display:flex;width:184px;height:26px;align-items:center;gap:8px;padding:4px 8px;border-radius:8px;background:transparent;color:var(--text);cursor:pointer;font:500 12px/17px Manrope,Inter,sans-serif;letter-spacing:-.01px;text-align:left}.vip-attachment-menu button:hover{background:var(--soft)}.vip-attachment-menu .vip-icon{width:16px;height:16px}
    .vip-drop-overlay{position:absolute;z-index:5;inset:0;display:none;place-items:center;padding:16px;border:2px dashed var(--blue);border-radius:25px;background:color-mix(in srgb,var(--bg) 92%,var(--blue));color:var(--text);font-size:13px;font-weight:600;text-align:center}.vip-composer[data-drag-active=true] .vip-drop-overlay{display:grid}.vip-composer[data-drag-active=true]>.vip-attachments,.vip-composer[data-drag-active=true]>.vip-composer-main{visibility:hidden}
    .vip-panel{pointer-events:auto;position:absolute;top:82px;right:18px;display:none;width:min(460px,calc(100vw - 24px));max-height:calc(100vh - 100px);padding:12px;overflow:hidden;border:1px solid var(--border);border-radius:25px;background:var(--bg);box-shadow:var(--shadow);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.vip-panel[data-open=true]{display:flex;flex-direction:column;gap:14px}.vip-panel-top{display:flex;flex:0 0 auto;flex-direction:column;gap:8px}.vip-panel-heading{display:flex;height:31px;align-items:center;justify-content:space-between;padding-left:7px}.vip-panel-title{font-family:Manrope,Inter,sans-serif;font-size:20px;font-weight:800;line-height:24px;letter-spacing:-.3px}.vip-panel-close{display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;padding:0;border:1px solid var(--border);border-radius:999px;background:transparent;color:var(--muted);cursor:pointer}.vip-panel-close:hover{background:var(--soft);color:var(--text)}.vip-panel-close .vip-icon{width:16px;height:16px}
    .vip-runtime{display:flex;height:17px;align-items:center;gap:7px;padding:0 7px;color:var(--muted)}.vip-runtime-dot{width:14px;height:14px;flex:0 0 14px;border:4px solid color-mix(in srgb,#22c55e 24%,transparent);border-radius:999px;background:#aeb8c2;background-clip:padding-box}.vip-runtime[data-connected=true] .vip-runtime-dot{background:#4ade80;background-clip:padding-box}.vip-runtime-project{min-width:0;overflow:hidden;font-size:10px;font-weight:600;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.vip-runtime-executor{display:none}
    .vip-task-tabs{display:grid;height:37px;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--border)}.vip-task-tab{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 5px;border-radius:0;background:transparent;color:var(--text);cursor:pointer;font-size:14px;font-weight:500;line-height:20px}.vip-task-tab:hover{background:color-mix(in srgb,var(--soft) 65%,transparent)}.vip-task-tab[aria-selected=true]{color:#286eea;font-weight:700}.vip-task-tab[aria-selected=true]::after{content:"";position:absolute;right:0;bottom:-1px;left:0;height:3px;border-radius:2px 2px 0 0;background:#4386f5}.vip-tab-count{display:none;min-width:20px;height:20px;place-items:center;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--text) 5%,transparent);color:#b6c0cc;font-size:11px;font-weight:800;line-height:15px}.vip-tab-count[data-visible=true]{display:grid}.vip-tab-count[data-attention=true]{background:color-mix(in srgb,var(--blue) 14%,transparent);color:var(--blue)}
    .vip-panel-body{min-height:88px;overflow-x:hidden;overflow-y:auto;padding:0 1px}.vip-panel-body::-webkit-scrollbar{width:8px}.vip-task-list{display:flex;flex-direction:column;gap:8px}.vip-task-card{position:relative;display:flex;width:100%;min-height:66px;align-items:center;gap:8px;padding:11px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg);color:var(--text);cursor:pointer;text-align:left;transition:border-color .1s ease,background-color .1s ease,opacity .1s ease}.vip-task-card:hover,.vip-task-card:focus-within{border-color:color-mix(in srgb,var(--blue) 48%,var(--border));background:color-mix(in srgb,var(--soft) 62%,var(--bg))}.vip-task-number{display:grid;width:30px;height:30px;flex:0 0 30px;place-items:center;border-radius:999px;background:#286eea;color:#fff;font-size:14px;font-weight:800;line-height:20px}.vip-task-text{display:-webkit-box;min-width:0;flex:1;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--text);font-size:14px;font-weight:400;line-height:20px;text-overflow:ellipsis}.vip-task-delete{display:none;width:32px;height:32px;flex:0 0 32px;place-items:center;padding:0;border-radius:8px;background:transparent;color:#ef4444;cursor:pointer}.vip-task-card:hover .vip-task-delete,.vip-task-card:focus-within .vip-task-delete{display:grid}.vip-task-delete:hover{background:color-mix(in srgb,#ef4444 10%,transparent)}.vip-task-delete .vip-icon{width:20px;height:20px}.vip-task-card[data-readonly=true]{cursor:pointer}.vip-task-card[data-readonly=true]:hover{background:color-mix(in srgb,var(--soft) 45%,var(--bg))}.vip-task-card[data-rated=true]{opacity:.56}.vip-task-card[data-rated=true]:hover,.vip-task-card[data-rated=true]:focus-within{opacity:.78}
    .vip-batch{display:flex;flex-direction:column;gap:8px}.vip-batch+.vip-batch{margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}.vip-batch-head{display:flex;min-height:26px;align-items:center;gap:7px;padding:0 7px;color:var(--text)}.vip-batch[data-rated=true] .vip-batch-head{opacity:.58}.vip-batch-title{font-size:14px;font-weight:800;line-height:20px}.vip-batch-pill{padding:3px 7px;border-radius:999px;background:color-mix(in srgb,var(--blue) 7%,transparent);color:color-mix(in srgb,var(--blue) 45%,#fff);font-size:10px;font-weight:600;line-height:14px}.vip-shell[data-theme=light] .vip-batch-pill{color:#91c1ff}.vip-batch-duration{margin-left:auto}.vip-batch-toggle{display:grid;width:24px;height:24px;flex:0 0 24px;place-items:center;padding:0;border-radius:7px;background:transparent;color:var(--muted);cursor:pointer}.vip-progress-batch .vip-batch-toggle,.vip-unbatched-ready .vip-batch-toggle{margin-left:auto}.vip-batch-toggle:hover{background:var(--soft);color:var(--text)}.vip-batch-toggle .vip-icon{width:16px;height:16px;transition:transform .12s ease}.vip-batch[data-collapsed=true] .vip-batch-toggle .vip-icon{transform:rotate(-90deg)}.vip-batch[data-collapsed=true] .vip-batch-tasks{display:none}.vip-ready-card{min-height:104px;align-items:flex-start}.vip-ready-content{display:flex;min-width:0;flex:1;align-self:stretch;align-items:stretch;flex-direction:column;gap:7px;text-align:left}.vip-task-tokens{display:flex;min-width:0;flex-wrap:nowrap;align-items:center;gap:6px;overflow-x:auto;overflow-y:hidden;padding-bottom:2px;color:var(--muted);font-size:10px;font-weight:650;line-height:14px;text-align:left;white-space:nowrap}.vip-task-tokens::-webkit-scrollbar{height:4px}.vip-task-tokens-total,.vip-task-token-metric{white-space:nowrap}.vip-ready-footer{display:flex;width:100%;min-width:0;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;margin-top:auto}.vip-ready-footer .vip-task-cost{font-size:14px;line-height:20px}.vip-task-cost{color:var(--blue);font-weight:800}.vip-batch-usage-detail{display:flex;flex-wrap:wrap;gap:3px 6px;padding:0 7px;color:var(--muted);font-size:10px;font-weight:650;line-height:14px}.vip-batch-usage-detail .vip-task-cost{color:var(--blue)}.vip-rating{display:flex;flex:0 0 auto;align-self:center;gap:3px;margin-left:auto}.vip-star{display:grid;width:18px;height:18px;place-items:center;padding:0;background:transparent;color:#d7dce2;cursor:pointer}.vip-star .vip-icon{width:16px;height:16px;fill:transparent}.vip-rating[data-tone=bad] .vip-star[data-selected=true],.vip-rating[data-tone=bad] .vip-star:hover{color:#ef4444}.vip-rating[data-tone=medium] .vip-star[data-selected=true],.vip-rating[data-tone=medium] .vip-star:hover{color:#f59e0b}.vip-rating[data-tone=good] .vip-star[data-selected=true],.vip-rating[data-tone=good] .vip-star:hover{color:#22c55e}.vip-star[data-selected=true] .vip-icon,.vip-star:hover .vip-icon{fill:currentColor}.vip-rating:hover .vip-star{color:#d7dce2}.vip-rating .vip-star:hover,.vip-rating .vip-star:has(~.vip-star:hover){color:var(--rating-preview,#22c55e)}.vip-rating .vip-star:hover .vip-icon,.vip-rating .vip-star:has(~.vip-star:hover) .vip-icon{fill:currentColor}
    .vip-last-batch{display:flex;flex-direction:column;gap:6px;margin:0 0 8px;padding:9px 10px;border-radius:10px;background:color-mix(in srgb,var(--blue) 10%,var(--bg));font-size:11px}.vip-last-batch[data-status=failed],.vip-last-batch[data-status=needs_input]{background:color-mix(in srgb,#ef4444 12%,var(--bg))}.vip-last-batch-title{font-weight:800}.vip-last-batch-copy{color:var(--muted)}.vip-last-batch details{margin-top:3px}.vip-last-batch summary{cursor:pointer}.vip-last-batch pre{max-height:140px;overflow:auto;margin:6px 0 0;padding:7px;border-radius:7px;background:var(--soft);font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.vip-continuation{display:block;width:100%;min-height:72px;margin:0 0 8px;resize:vertical;padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:var(--soft);color:var(--text);font-size:12px;line-height:17px}.vip-continuation[hidden]{display:none}.vip-continuation::placeholder{color:var(--muted)}.vip-wide{width:100%;margin:0 0 8px;padding:9px 11px;border-radius:10px;background:var(--blue);color:#fff;cursor:pointer}.vip-wide[hidden]{display:none}.vip-approve-dirty{background:#fbbf24;color:#422006}.vip-empty{color:var(--muted);padding:24px 8px;text-align:center}.vip-panel-footer{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:10px;padding:0 1px}.vip-panel-clear,.vip-panel-apply{height:35px;padding:0 12px;border-radius:10px;background:transparent;color:var(--text);cursor:pointer;font-size:13px;font-weight:650;line-height:18px}.vip-panel-clear:hover:not(:disabled){background:var(--soft)}.vip-panel-clear:disabled{color:var(--disabled);cursor:default}.vip-panel-apply{background:#20293a;color:#fff}.vip-shell[data-theme=dark] .vip-panel-apply:not(:disabled){background:var(--blue)}.vip-panel-apply:disabled{background:#c0c0c0;color:#fff;cursor:default}
    .vip-modal-backdrop{pointer-events:auto;position:fixed;inset:0;display:none;place-items:center;background:rgba(12,14,16,.28)}.vip-modal-backdrop[data-open=true]{display:grid}.vip-modal{width:min(390px,calc(100vw - 32px));padding:20px;border:1px solid var(--border);border-radius:18px;background:var(--bg);box-shadow:var(--shadow)}.vip-modal h2{margin:0 0 8px;font-size:18px}.vip-modal p{margin:0;color:var(--muted)}.vip-modal-count{color:var(--blue);font-weight:600}.vip-modal .vip-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.vip-modal button{padding:9px 13px;border-radius:10px;background:var(--soft);color:var(--text);cursor:pointer}.vip-modal button.vip-confirm,.vip-modal button.vip-confirm:hover{background:var(--blue);color:#fff}
    .vip-settings-backdrop{pointer-events:auto;position:fixed;z-index:30;inset:0;display:none;place-items:center;padding:16px;background:rgba(15,23,42,.2)}.vip-shell[data-theme=dark] .vip-settings-backdrop{background:rgba(248,250,252,.11)}.vip-settings-backdrop[data-open=true]{display:grid}.vip-settings{width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:18px;border:1px solid var(--border);border-radius:18px;background:var(--bg);box-shadow:0 24px 70px rgba(15,23,42,.25)}.vip-settings-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.vip-settings-header h2{margin:0;font-size:18px;line-height:24px}.vip-settings-close{display:grid;width:32px;height:32px;place-items:center;padding:0;border-radius:8px;background:transparent;color:var(--text);cursor:pointer}.vip-settings-close:hover{background:var(--soft)}.vip-settings-close .vip-icon{width:18px;height:18px}.vip-settings-group+.vip-settings-group{margin-top:20px;padding-top:18px;border-top:1px solid var(--border)}.vip-settings-group h3{margin:0 0 4px;font-size:13px;line-height:18px}.vip-settings-description{margin:0 0 12px;color:var(--muted);font-size:11px;line-height:16px}.vip-theme-options{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px;border-radius:12px;background:var(--soft)}.vip-theme-option{height:34px;padding:0 12px;border-radius:8px;background:transparent;color:var(--text);cursor:pointer}.vip-theme-option[data-selected=true]{background:var(--bg);box-shadow:0 1px 4px rgba(15,23,42,.12);color:var(--blue);font-weight:700}.vip-policy-options{display:grid;gap:8px}.vip-policy-option{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;padding:12px;border:1px solid var(--border);border-radius:12px;background:transparent;color:var(--text);cursor:pointer;text-align:left}.vip-policy-option:hover{background:var(--soft)}.vip-policy-option[data-selected=true]{border-color:var(--blue);background:color-mix(in srgb,var(--blue) 8%,var(--bg))}.vip-policy-radio{display:grid;width:18px;height:18px;place-items:center;border:1.5px solid var(--muted);border-radius:999px}.vip-policy-option[data-selected=true] .vip-policy-radio{border:5px solid var(--blue)}.vip-policy-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;line-height:17px}.vip-recommended{padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--blue) 14%,var(--bg));color:var(--blue);font-size:9px;line-height:14px}.vip-policy-copy{display:block;margin-top:2px;color:var(--muted);font-size:10px;line-height:15px}.vip-settings-note{margin:10px 0 0;color:var(--muted);font-size:10px;line-height:15px}
    .vip-crop-layer{position:fixed;inset:0;display:none;pointer-events:none}.vip-crop-layer[data-open=true]{display:block}.vip-crop{pointer-events:auto;position:fixed;min-width:80px;min-height:80px;border:2px solid var(--blue);border-radius:4px;background:rgba(30,143,241,.04);box-shadow:0 0 0 9999px rgba(12,14,16,.18);cursor:move}.vip-crop-actions{pointer-events:auto;position:fixed;z-index:2;display:flex;gap:6px;padding:5px;border-radius:10px;background:#111827;box-shadow:0 8px 24px rgba(0,0,0,.3)}.vip-crop-actions button{padding:7px 10px;border-radius:7px;background:transparent;color:#fff;cursor:pointer}.vip-crop-actions button:last-child{background:var(--blue)}.vip-crop-handle{position:absolute;width:14px;height:14px;border:2px solid #fff;border-radius:3px;background:var(--blue)}.vip-crop-handle[data-handle=nw]{left:-8px;top:-8px;cursor:nwse-resize}.vip-crop-handle[data-handle=ne]{right:-8px;top:-8px;cursor:nesw-resize}.vip-crop-handle[data-handle=sw]{left:-8px;bottom:-8px;cursor:nesw-resize}.vip-crop-handle[data-handle=se]{right:-8px;bottom:-8px;cursor:nwse-resize}.vip-shell[data-capturing=true] .vip-toolbar,.vip-shell[data-capturing=true] .vip-composer,.vip-shell[data-capturing=true] .vip-panel,.vip-shell[data-capturing=true] .vip-highlight,.vip-shell[data-capturing=true] .vip-frame-box,.vip-shell[data-capturing=true] .vip-element-inspector,.vip-shell[data-capturing=true] .vip-anchor-layer,.vip-shell[data-capturing=true] .vip-crop-layer,.vip-shell[data-capturing=true] .vip-tooltip,.vip-shell[data-capturing=true] .vip-toast{visibility:hidden!important}
    .vip-tooltip{pointer-events:none;position:fixed;display:none;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;background:#101214;color:#fff;box-shadow:0 7px 20px rgba(0,0,0,.25);font-size:12px;white-space:nowrap}.vip-shell[data-theme=dark] .vip-tooltip{background:#fff;color:#101214}.vip-tooltip[data-visible=true]{display:flex}.vip-tooltip kbd{padding:2px 5px;border:1px solid currentColor;border-radius:4px;font:10px/1.2 ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace;opacity:.75}.vip-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%) translateY(18px);opacity:0;padding:9px 13px;border-radius:999px;background:#101214;color:#fff;box-shadow:0 12px 36px rgba(0,0,0,.28);transition:.16s ease}.vip-toast[data-visible=true]{opacity:1;transform:translateX(-50%) translateY(0)}.vip-file-input{display:none}
    @media(max-width:900px){.vip-toolbar{gap:10px}.vip-brand{display:none}.vip-width-control{width:128px}.vip-width-control input{width:71px}}
  </style>
  <div class="vip-shell" data-theme="light">
    <svg class="vip-canvas" aria-hidden="true"></svg><div class="vip-highlight"></div><div class="vip-frame-box"></div><div class="vip-element-inspector"><div class="vip-element-inspector-row"><span data-inspector="tag"></span><span class="vip-element-inspector-value" data-inspector="size"></span></div><div class="vip-element-inspector-row"><span class="vip-element-inspector-label">цвет</span><span class="vip-element-inspector-value" data-inspector="color"></span></div><div class="vip-element-inspector-row"><span class="vip-element-inspector-label">шрифт</span><span class="vip-element-inspector-value vip-element-inspector-font" data-inspector="font"></span></div></div><div class="vip-anchor-layer"></div>
    <div class="vip-toolbar" data-layout="select" role="toolbar" aria-label="Visual Intent">
      <button class="vip-menu" data-action="settings" data-tooltip="Настройки">${icon("menu")}</button>
      <div class="vip-brand" data-drag-handle><div class="vip-brand-title">Visual Intent</div><div class="vip-brand-mode">Режим просмотра</div></div>
      <div class="vip-tools">
        <button data-action="undo" data-tooltip="Отменить" data-shortcut="⌘Z" disabled>${icon("undo")}</button><button data-action="redo" data-tooltip="Повторить" data-shortcut="⇧⌘Z" disabled>${icon("redo")}</button><span class="vip-separator"></span>
        <button data-action="select" data-tooltip="Выделить элемент" data-shortcut="V">${icon("select")}</button><button data-action="pencil" data-tooltip="Карандаш" data-shortcut="P">${icon("pencil")}</button><button data-action="square" data-tooltip="Прямоугольник" data-shortcut="R" data-draw-only>${icon("square")}</button>
        <span class="vip-draw-settings" data-draw-only><span class="vip-color-wrap"><button class="vip-color-button" data-action="color" data-tooltip="Цвет линии"><span class="vip-color-dot"></span></button><span class="vip-palette"></span></span><span class="vip-width-control"><span class="vip-width-value">2</span><input type="range" min="1" max="10" value="2" aria-label="Толщина линии"></span></span>
        <button data-action="frame" data-tooltip="Область с комментарием" data-shortcut="F" data-select-only>${icon("frame")}</button><button data-action="clear" data-tooltip="Очистить рисунки" data-shortcut="⌫" disabled>${icon("clear")}</button><span class="vip-separator"></span>
        <button data-action="screenshot" data-tooltip="Сделать скриншот" data-shortcut="⇧S">${icon("screenshot")}</button><button data-action="figma" data-tooltip="Отправить компонент в Figma" data-select-only>${icon("figma")}</button><button data-action="tasks" data-tooltip="Список задач" data-select-only aria-pressed="false">${icon("tasks")}<span class="vip-task-badge">0</span></button>
      </div>
      <button class="vip-apply" data-action="apply" data-tooltip="Отправить задачи" disabled>Apply</button>
    </div>
    <section class="vip-panel" aria-label="Список задач"><header class="vip-panel-top"><div class="vip-panel-heading"><span class="vip-panel-title">Список задач</span><button class="vip-panel-close" type="button" aria-label="Закрыть список задач">${icon("close")}</button></div><div class="vip-runtime"><span class="vip-runtime-dot"></span><span class="vip-runtime-project">Загрузка проекта…</span><span class="vip-runtime-executor">disconnected</span></div><div class="vip-task-tabs" role="tablist" aria-label="Состояние задач"><button class="vip-task-tab" type="button" role="tab" data-task-tab="backlog" aria-selected="true">Backlog <span class="vip-tab-count" data-tab-count="backlog">0</span></button><button class="vip-task-tab" type="button" role="tab" data-task-tab="in-progress" aria-selected="false">In progress <span class="vip-tab-count" data-tab-count="in-progress">0</span></button><button class="vip-task-tab" type="button" role="tab" data-task-tab="ready" aria-selected="false">Ready <span class="vip-tab-count" data-tab-count="ready">0</span></button></div></header><div class="vip-panel-body" role="tabpanel"><div class="vip-progress-controls" hidden><div class="vip-last-batch" hidden></div><button class="vip-wide vip-approve-dirty" hidden>Продолжить поверх текущих изменений</button><textarea class="vip-continuation" maxlength="12000" placeholder="Ответьте агенту, чтобы продолжить…" hidden></textarea><button class="vip-wide vip-retry" hidden>Повторить пакет</button></div><div class="vip-task-list"></div></div><footer class="vip-panel-footer"><button class="vip-panel-clear" type="button" data-panel-action="clear">Clear All</button><button class="vip-panel-apply" type="button" data-panel-action="apply" disabled>Apply</button></footer></section>
    <section class="vip-composer" aria-label="Новая задача" data-has-text="false" data-multiline="false" data-has-attachments="false" data-kind="code-change"><div class="vip-drop-overlay">Перетащите сюда и отпустите изображение</div><div class="vip-attachments"></div><div class="vip-composer-main"><div class="vip-composer-content"><div class="vip-context-icon" aria-hidden="true">${icon("settings")}</div><textarea rows="1" aria-label="Комментарий" placeholder="Type a comment..."></textarea></div><div class="vip-composer-actions"><div class="vip-kind">${icon("figma")}<span>Send to Figma</span></div><button class="vip-composer-button" data-composer-action="attach-menu" data-tooltip="Добавить вложение">${icon("paperclip")}</button><button class="vip-composer-button vip-save" data-composer-action="save" data-tooltip="Добавить в задачи" data-shortcut="⌘↵" hidden>${icon("check")}</button></div></div><div class="vip-attachment-menu"><button data-composer-action="screenshot">${icon("screenshot")}<span>Сделать скриншот</span></button><button data-composer-action="upload">${icon("paperclip")}<span>Загрузить файл</span></button></div></section>
    <input class="vip-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif" multiple>
    <div class="vip-modal-backdrop" aria-hidden="true"><section class="vip-modal" role="dialog" aria-modal="true" aria-labelledby="vip-apply-title"><h2 id="vip-apply-title">Отправить задачи?</h2><p class="vip-modal-copy"></p><div class="vip-actions"><button data-modal-action="cancel">Отмена</button><button class="vip-confirm" data-modal-action="confirm">Отправить</button></div></section></div>
    <div class="vip-settings-backdrop" aria-hidden="true"><section class="vip-settings" role="dialog" aria-modal="true" aria-labelledby="vip-settings-title"><header class="vip-settings-header"><h2 id="vip-settings-title">Настройки</h2><button class="vip-settings-close" data-settings-action="close" aria-label="Закрыть настройки">${icon("close")}</button></header><section class="vip-settings-group"><h3>Оформление</h3><p class="vip-settings-description">Тема интерфейса Visual Intent в этом браузере.</p><div class="vip-theme-options"><button class="vip-theme-option" data-theme-value="light">Светлая</button><button class="vip-theme-option" data-theme-value="dark">Тёмная</button></div></section><section class="vip-settings-group"><h3>Работа с изменениями</h3><p class="vip-settings-description">Как отправлять задачи, если в репозитории уже есть незакоммиченные файлы.</p><div class="vip-policy-options"><button class="vip-policy-option" data-policy-value="allow-host-attached"><span class="vip-policy-radio"></span><span><span class="vip-policy-title">Передавать сразу <span class="vip-recommended">Рекомендуется</span></span><span class="vip-policy-copy">Для связанного чата: baseline сохраняется, а агент сам проверяет пересечения.</span></span></button><button class="vip-policy-option" data-policy-value="require-confirmation"><span class="vip-policy-radio"></span><span><span class="vip-policy-title">Спрашивать подтверждение</span><span class="vip-policy-copy">Останавливать каждый Apply, если рабочее дерево уже изменено.</span></span></button></div><p class="vip-settings-note">Автономный исполнитель всегда требует отдельного подтверждения — эта настройка действует только для связанного чата Codex.</p></section></section></div>
    <div class="vip-crop-layer"><div class="vip-crop"><span class="vip-crop-handle" data-handle="nw"></span><span class="vip-crop-handle" data-handle="ne"></span><span class="vip-crop-handle" data-handle="sw"></span><span class="vip-crop-handle" data-handle="se"></span></div><div class="vip-crop-actions"><button data-crop-action="cancel">Отмена</button><button data-crop-action="capture">Сделать снимок</button></div></div>
    <div class="vip-tooltip"><span></span><kbd hidden></kbd></div><div class="vip-toast"></div>
  </div>`;

  function required<T extends Element>(selector: string): T {
    const element = shadow.querySelector<T>(selector);
    if (!element)
      throw new Error(`Visual Intent overlay is missing ${selector}`);
    return element;
  }

  const shell = required<HTMLElement>(".vip-shell");
  const toolbar = required<HTMLElement>(".vip-toolbar");
  const modeLabel = required<HTMLElement>(".vip-brand-mode");
  const canvas = required<SVGSVGElement>(".vip-canvas");
  const highlight = required<HTMLElement>(".vip-highlight");
  const frameBox = required<HTMLElement>(".vip-frame-box");
  const elementInspector = required<HTMLElement>(".vip-element-inspector");
  const inspectorTag = required<HTMLElement>("[data-inspector='tag']");
  const inspectorSize = required<HTMLElement>("[data-inspector='size']");
  const inspectorColor = required<HTMLElement>("[data-inspector='color']");
  const inspectorFont = required<HTMLElement>("[data-inspector='font']");
  const anchorLayer = required<HTMLElement>(".vip-anchor-layer");
  const composer = required<HTMLElement>(".vip-composer");
  const textarea = required<HTMLTextAreaElement>(".vip-composer textarea");
  const attachmentsElement = required<HTMLElement>(".vip-attachments");
  const attachmentMenu = required<HTMLElement>(".vip-attachment-menu");
  const fileInput = required<HTMLInputElement>(".vip-file-input");
  const panel = required<HTMLElement>(".vip-panel");
  const taskList = required<HTMLElement>(".vip-task-list");
  const panelBody = required<HTMLElement>(".vip-panel-body");
  const progressControls = required<HTMLElement>(".vip-progress-controls");
  const panelCloseButton = required<HTMLButtonElement>(".vip-panel-close");
  const panelClearButton = required<HTMLButtonElement>(
    "[data-panel-action='clear']",
  );
  const panelApplyButton = required<HTMLButtonElement>(
    "[data-panel-action='apply']",
  );
  const taskTabButtons =
    shadow.querySelectorAll<HTMLButtonElement>("[data-task-tab]");
  const backlogTabCount = required<HTMLElement>("[data-tab-count='backlog']");
  const progressTabCount = required<HTMLElement>(
    "[data-tab-count='in-progress']",
  );
  const completedTabCount = required<HTMLElement>("[data-tab-count='ready']");
  const taskBadge = required<HTMLElement>(".vip-task-badge");
  const applyButton = required<HTMLButtonElement>("[data-action='apply']");
  const undoButton = required<HTMLButtonElement>("[data-action='undo']");
  const redoButton = required<HTMLButtonElement>("[data-action='redo']");
  const clearButton = required<HTMLButtonElement>("[data-action='clear']");
  const tasksButton = required<HTMLButtonElement>("[data-action='tasks']");
  const saveButton = required<HTMLButtonElement>(
    "[data-composer-action='save']",
  );
  const widthInput = required<HTMLInputElement>(".vip-width-control input");
  const widthValue = required<HTMLElement>(".vip-width-value");
  const palette = required<HTMLElement>(".vip-palette");
  const colorDot = required<HTMLElement>(".vip-color-dot");
  const runtime = required<HTMLElement>(".vip-runtime");
  const runtimeProject = required<HTMLElement>(".vip-runtime-project");
  const runtimeExecutor = required<HTMLElement>(".vip-runtime-executor");
  const lastBatch = required<HTMLElement>(".vip-last-batch");
  const approveDirtyButton = required<HTMLButtonElement>(".vip-approve-dirty");
  const continuationInput = required<HTMLTextAreaElement>(".vip-continuation");
  const retryButton = required<HTMLButtonElement>(".vip-retry");
  const modalBackdrop = required<HTMLElement>(".vip-modal-backdrop");
  const modalCopy = required<HTMLElement>(".vip-modal-copy");
  const settingsBackdrop = required<HTMLElement>(".vip-settings-backdrop");
  const themeOptions =
    shadow.querySelectorAll<HTMLButtonElement>("[data-theme-value]");
  const policyOptions = shadow.querySelectorAll<HTMLButtonElement>(
    "[data-policy-value]",
  );
  const cropLayer = required<HTMLElement>(".vip-crop-layer");
  const crop = required<HTMLElement>(".vip-crop");
  const cropActions = required<HTMLElement>(".vip-crop-actions");
  const tooltip = required<HTMLElement>(".vip-tooltip");
  const toastElement = required<HTMLElement>(".vip-toast");

  let mode: Mode = "idle";
  let previousMode: Mode = "idle";
  let targetContext: TargetContext | null = null;
  let drawStart: Point | null = null;
  let activeDrawing: Drawing | null = null;
  let drawings: Drawing[] = [];
  let drawColor = "#1e8ff1";
  let drawWidth = 2;
  let draftKind: TaskKind = "code-change";
  let draftAttachments: Attachment[] = [];
  let editingTask: OverlayTask | null = null;
  let revisionSourceTask: OverlayTask | null = null;
  let composerPlacementRect: Rect | null = null;
  let readyTasks: OverlayTask[] = [];
  let allTasks: OverlayTask[] = [];
  let currentBatches: OverlayBatch[] = [];
  let currentExecutions: OverlayExecution[] = [];
  let activeTaskTab: TaskTab = "backlog";
  let currentSession: OverlaySession | null = null;
  let currentSettings: OverlayProjectSettings | null = null;
  let toastTimer: number | undefined;
  let historyBusy = false;
  let composerDragDepth = 0;
  let hoveredInspectionElement: Element | null = null;
  const undoStack: HistoryCommand[] = [];
  const redoStack: HistoryCommand[] = [];
  const expandedBatchIds = new Set<string>();
  const autoExpandedReadyBatchIds = new Set<string>();
  let readyAutoExpandPending = false;
  const colors = [
    "#0c0e10",
    "#ef4444",
    "#1e8ff1",
    "#22c55e",
    "#facc15",
    "#ffffff",
  ];
  const id = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `vip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
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
      parts.unshift(
        `${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""}`,
      );
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function showToast(message: string): void {
    toastElement.textContent = message;
    toastElement.dataset.visible = "true";
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastElement.dataset.visible = "false";
    }, 2800);
  }

  function apiFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (apiToken) headers.set("x-visual-intent-token", apiToken);
    return fetch(input, { ...init, headers });
  }

  async function responseError(response: Response): Promise<Error> {
    try {
      const body = (await response.json()) as { error?: string };
      if (
        response.status === 403 &&
        body.error === "Invalid Visual Intent session token"
      )
        return new Error(
          "Сессия Visual Intent устарела. Обновите страницу один раз.",
        );
      return new Error(body.error ?? `HTTP ${response.status}`);
    } catch {
      return new Error(`HTTP ${response.status}`);
    }
  }

  function displayRect(element: HTMLElement, rect: Rect | null): void {
    if (!rect) {
      element.style.display = "none";
      return;
    }
    Object.assign(element.style, {
      display: "block",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function hideElementInspector(): void {
    hoveredInspectionElement = null;
    elementInspector.dataset.visible = "false";
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

  function formatCssColor(value: string): string {
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

  function showElementInspector(element: Element, rect: DOMRect): void {
    const computed = getComputedStyle(element);
    inspectorTag.textContent = element.tagName.toLowerCase();
    inspectorSize.textContent = `${formatDimension(rect.width)}×${formatDimension(rect.height)}`;
    inspectorColor.textContent = formatCssColor(computed.color);
    inspectorFont.textContent = `${computed.fontSize} ${computed.fontFamily.replace(/["']/g, "")}`;
    inspectorFont.title = inspectorFont.textContent;
    elementInspector.dataset.visible = "true";
    const width = elementInspector.offsetWidth || 240;
    const height = elementInspector.offsetHeight || 76;
    const gap = 8;
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - width - 8),
    );
    let top: number;
    let placement: "above" | "below" | "over";
    if (rect.top >= height + gap) {
      top = rect.top - height - gap;
      placement = "above";
    } else if (window.innerHeight - rect.bottom >= height + gap) {
      top = rect.bottom + gap;
      placement = "below";
    } else {
      top = Math.max(
        8,
        Math.min(rect.top + 8, window.innerHeight - height - 8),
      );
      placement = "over";
    }
    const anchorX = Math.max(
      14,
      Math.min(rect.left + Math.min(50, rect.width / 2) - left, width - 14),
    );
    elementInspector.dataset.placement = placement;
    elementInspector.style.left = `${left}px`;
    elementInspector.style.top = `${top}px`;
    elementInspector.style.setProperty("--inspector-anchor-x", `${anchorX}px`);
  }
  const surfaceToViewport = (rect: Rect): Rect => ({
    ...rect,
    x: rect.x - window.scrollX,
    y: rect.y - window.scrollY,
  });

  function currentTargetRect(): Rect | null {
    if (!targetContext) return null;
    if (!targetContext.element) return targetContext.rect;
    const box = targetContext.element.getBoundingClientRect();
    return {
      x: box.x + window.scrollX,
      y: box.y + window.scrollY,
      width: box.width,
      height: box.height,
    };
  }

  function currentComposerPlacementRect(): Rect | null {
    return composerPlacementRect ?? currentTargetRect();
  }

  function setMode(next: Mode): void {
    mode = next;
    if (next !== "select" && next !== "figma") hideElementInspector();
    toolbar.dataset.layout =
      next === "pencil" || next === "square" ? "draw" : "select";
    modeLabel.textContent = (
      {
        idle: "Режим просмотра",
        select: "Режим выделения",
        pencil: "Режим рисования",
        square: "Прямоугольник",
        frame: "Область с комментарием",
        figma: "Компонент в Figma",
        screenshot: "Скриншот",
      } as Record<Mode, string>
    )[next];
    shadow
      .querySelectorAll<HTMLButtonElement>("[data-action]")
      .forEach((button) => {
        button.dataset.active = String(button.dataset.action === next);
      });
    if (["select", "pencil", "square", "frame", "figma"].includes(next))
      document.documentElement.style.setProperty(
        "cursor",
        "crosshair",
        "important",
      );
    else document.documentElement.style.removeProperty("cursor");
  }

  function enterNeutralMode(): void {
    drawStart = null;
    activeDrawing = null;
    if (composer.dataset.open !== "true") targetContext = null;
    renderDrawings();
    displayRect(highlight, null);
    displayRect(frameBox, null);
    setMode("idle");
  }

  function updateHistoryButtons(): void {
    undoButton.disabled = historyBusy || undoStack.length === 0;
    redoButton.disabled = historyBusy || redoStack.length === 0;
    clearButton.disabled = drawings.length === 0;
  }
  function recordCommand(command: HistoryCommand): void {
    undoStack.push(command);
    redoStack.length = 0;
    updateHistoryButtons();
  }
  async function runHistory(direction: "undo" | "redo"): Promise<void> {
    if (historyBusy) return;
    const source = direction === "undo" ? undoStack : redoStack;
    const destination = direction === "undo" ? redoStack : undoStack;
    const command = source.pop();
    if (!command) return;
    historyBusy = true;
    updateHistoryButtons();
    try {
      await command[direction]();
      destination.push(command);
    } catch (error) {
      source.push(command);
      showToast(
        `Не удалось ${direction === "undo" ? "отменить" : "повторить"}: ${String(error)}`,
      );
    } finally {
      historyBusy = false;
      updateHistoryButtons();
    }
  }

  function renderDrawings(): void {
    canvas.setAttribute(
      "viewBox",
      `${window.scrollX} ${window.scrollY} ${window.innerWidth} ${window.innerHeight}`,
    );
    canvas.replaceChildren();
    for (const drawing of activeDrawing
      ? [...drawings, activeDrawing]
      : drawings) {
      if (drawing.type === "path") {
        const [first, ...rest] = drawing.points;
        if (!first) continue;
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute(
          "d",
          `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`,
        );
        Object.entries({
          fill: "none",
          stroke: drawing.color,
          "stroke-width": String(drawing.width),
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }).forEach(([key, value]) => path.setAttribute(key, value));
        canvas.append(path);
      } else {
        const rect = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "rect",
        );
        Object.entries({
          x: String(drawing.rect.x),
          y: String(drawing.rect.y),
          width: String(drawing.rect.width),
          height: String(drawing.rect.height),
          rx: "4",
          fill: "none",
          stroke: drawing.color,
          "stroke-width": String(drawing.width),
        }).forEach(([key, value]) => rect.setAttribute(key, value));
        canvas.append(rect);
      }
    }
    updateHistoryButtons();
  }

  function addDrawing(drawing: Drawing): void {
    drawings = [...drawings, drawing];
    renderDrawings();
    recordCommand({
      undo: () => {
        drawings = drawings.filter((item) => item.id !== drawing.id);
        renderDrawings();
      },
      redo: () => {
        drawings = [
          ...drawings.filter((item) => item.id !== drawing.id),
          drawing,
        ];
        renderDrawings();
      },
    });
  }
  function clearDrawings(): void {
    if (!drawings.length) return;
    const snapshot = clone(drawings);
    drawings = [];
    activeDrawing = null;
    renderDrawings();
    recordCommand({
      undo: () => {
        drawings = clone(snapshot);
        renderDrawings();
      },
      redo: () => {
        drawings = [];
        renderDrawings();
      },
    });
  }

  function positionComposer(rect: Rect): void {
    const margin = 12,
      gap = 10,
      width = composer.offsetWidth || Math.min(320, innerWidth - 24),
      height = composer.offsetHeight || 50;
    const maxLeft = Math.max(margin, innerWidth - width - margin),
      maxTop = Math.max(margin, innerHeight - height - margin);
    let left = rect.x + rect.width + gap;
    if (left + width > innerWidth - margin) left = rect.x - width - gap;
    if (left < margin) left = Math.min(maxLeft, Math.max(margin, rect.x));
    let top = Math.min(maxTop, Math.max(margin, rect.y));
    if (
      rect.x + rect.width + gap + width > innerWidth - margin &&
      rect.x - gap - width < margin
    )
      top =
        rect.y + rect.height + gap + height <= innerHeight - margin
          ? rect.y + rect.height + gap
          : Math.max(margin, rect.y - height - gap);
    composer.style.left = `${Math.min(maxLeft, Math.max(margin, left))}px`;
    composer.style.top = `${top}px`;
  }

  function syncComposerLayout(): void {
    const hasText = textarea.value.length > 0;
    textarea.style.height = "24px";
    const contentHeight = Math.min(200, Math.max(24, textarea.scrollHeight));
    const multiline = textarea.scrollHeight > 24;
    textarea.style.height = `${contentHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 200 ? "auto" : "hidden";
    composer.dataset.hasText = String(hasText);
    composer.dataset.multiline = String(multiline);
    composer.dataset.hasAttachments = String(draftAttachments.length > 0);
    composer.dataset.kind = draftKind;
    saveButton.hidden = !(
      hasText ||
      (!revisionSourceTask && draftKind === "figma-component")
    );
    const rect = currentComposerPlacementRect();
    if (rect && composer.dataset.open === "true" && !composer.hidden)
      positionComposer(surfaceToViewport(rect));
  }

  function setPanelOpen(open: boolean): void {
    expandedBatchIds.clear();
    readyAutoExpandPending = false;
    if (open) activeTaskTab = "backlog";
    panel.dataset.open = String(open);
    tasksButton.dataset.active = String(open);
    tasksButton.setAttribute("aria-pressed", String(open));
    if (open) renderTaskPanel();
  }

  function setTaskTab(tab: TaskTab): void {
    if (tab === activeTaskTab) return;
    expandedBatchIds.clear();
    activeTaskTab = tab;
    readyAutoExpandPending = tab === "ready";
    renderTaskPanel();
  }

  function openComposer(
    target: TargetContext,
    kind: TaskKind,
    options: {
      editingTask?: OverlayTask;
      revisionSourceTask?: OverlayTask;
      placementRect?: Rect;
    } = {},
  ): void {
    targetContext = target;
    draftKind = kind;
    editingTask = options.editingTask ? clone(options.editingTask) : null;
    revisionSourceTask = options.revisionSourceTask
      ? clone(options.revisionSourceTask)
      : null;
    composerPlacementRect = options.placementRect
      ? { ...options.placementRect }
      : null;
    composer.dataset.editing = String(Boolean(editingTask));
    composer.dataset.revision = String(Boolean(revisionSourceTask));
    composer.setAttribute(
      "aria-label",
      revisionSourceTask
        ? "Новая правка"
        : editingTask
          ? "Редактирование задачи"
          : "Новая задача",
    );
    saveButton.dataset.tooltip = revisionSourceTask
      ? "Добавить правку"
      : editingTask
        ? "Сохранить изменения"
        : "Добавить в задачи";
    textarea.placeholder = revisionSourceTask
      ? "Что нужно поправить?"
      : "Type a comment...";
    setPanelOpen(false);
    attachmentMenu.dataset.open = "false";
    composer.hidden = false;
    composer.inert = false;
    composer.dataset.open = "true";
    syncComposerLayout();
    const placementRect = currentComposerPlacementRect();
    if (placementRect) positionComposer(surfaceToViewport(placementRect));
    textarea.focus();
  }
  function resetComposer(): void {
    textarea.blur();
    composer.dataset.open = "false";
    composer.hidden = false;
    composer.inert = false;
    textarea.value = "";
    draftAttachments = [];
    renderAttachments();
    draftKind = "code-change";
    editingTask = null;
    revisionSourceTask = null;
    composerPlacementRect = null;
    composer.dataset.editing = "false";
    composer.dataset.revision = "false";
    composer.setAttribute("aria-label", "Новая задача");
    saveButton.dataset.tooltip = "Добавить в задачи";
    textarea.placeholder = "Type a comment...";
    targetContext = null;
    attachmentMenu.dataset.open = "false";
    composer.dataset.dragActive = "false";
    syncComposerLayout();
    displayRect(highlight, null);
    displayRect(frameBox, null);
    setMode("idle");
  }

  function snapshotComposerDraft(): ComposerDraftSnapshot | null {
    if (!targetContext || composer.dataset.open !== "true") return null;
    return {
      target: {
        ...targetContext,
        rect: { ...targetContext.rect },
      },
      kind: draftKind,
      text: textarea.value,
      attachments: draftAttachments.map((attachment) => ({ ...attachment })),
      ...(composerPlacementRect
        ? { placementRect: { ...composerPlacementRect } }
        : {}),
      ...(editingTask ? { editingTask: clone(editingTask) } : {}),
      ...(revisionSourceTask
        ? { revisionSourceTask: clone(revisionSourceTask) }
        : {}),
    };
  }

  function restoreComposerDraft(snapshot: ComposerDraftSnapshot): void {
    const target = {
      ...snapshot.target,
      rect: { ...snapshot.target.rect },
    };
    textarea.value = snapshot.text;
    draftAttachments = snapshot.attachments.map((attachment) => ({
      ...attachment,
    }));
    renderAttachments();
    openComposer(target, snapshot.kind, {
      ...(snapshot.placementRect
        ? { placementRect: { ...snapshot.placementRect } }
        : {}),
      ...(snapshot.editingTask
        ? { editingTask: clone(snapshot.editingTask) }
        : {}),
      ...(snapshot.revisionSourceTask
        ? { revisionSourceTask: clone(snapshot.revisionSourceTask) }
        : {}),
    });
    const rect = currentTargetRect() ?? target.rect;
    target.rect = rect;
    if (target.element) displayRect(highlight, surfaceToViewport(rect));
    else displayRect(frameBox, surfaceToViewport(rect));
  }

  function cancelComposerDraft(): void {
    const snapshot = snapshotComposerDraft();
    resetComposer();
    if (!snapshot) return;
    recordCommand({
      undo: () => {
        restoreComposerDraft(snapshot);
        showToast("Черновик восстановлен");
      },
      redo: () => {
        resetComposer();
        showToast("Черновик снова отменён");
      },
    });
  }

  function selectTarget(element: Element, kind: TaskKind): void {
    const box = element.getBoundingClientRect();
    const rect = {
      x: box.x + scrollX,
      y: box.y + scrollY,
      width: box.width,
      height: box.height,
    };
    displayRect(frameBox, null);
    displayRect(highlight, box);
    setMode("idle");
    openComposer(
      { rect, element, label: `Выбрано: ${selectorFor(element)}` },
      kind,
    );
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      if (mode !== "select" && mode !== "figma") return;
      if (isOverlayEvent(event)) {
        displayRect(highlight, null);
        hideElementInspector();
        return;
      }
      const element = event.target instanceof Element ? event.target : null;
      if (!element) {
        displayRect(highlight, null);
        hideElementInspector();
        return;
      }
      hoveredInspectionElement = element;
      const rect = element.getBoundingClientRect();
      displayRect(highlight, rect);
      showElementInspector(element, rect);
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if ((mode !== "select" && mode !== "figma") || isOverlayEvent(event))
        return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selectTarget(
        element,
        mode === "figma" ? "figma-component" : "code-change",
      );
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !(["pencil", "square", "frame"] as Mode[]).includes(mode) ||
        isOverlayEvent(event)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drawStart = { x: event.pageX, y: event.pageY };
      if (mode === "pencil")
        activeDrawing = {
          id: id(),
          type: "path",
          points: [drawStart],
          color: drawColor,
          width: drawWidth,
        };
      else if (mode === "square")
        activeDrawing = {
          id: id(),
          type: "rect",
          rect: { x: drawStart.x, y: drawStart.y, width: 0, height: 0 },
          color: drawColor,
          width: drawWidth,
        };
      else {
        targetContext = {
          rect: { x: drawStart.x, y: drawStart.y, width: 0, height: 0 },
          label: "Область",
        };
        displayRect(frameBox, surfaceToViewport(targetContext.rect));
      }
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!drawStart || isOverlayEvent(event)) return;
      if (mode === "pencil" && activeDrawing?.type === "path") {
        activeDrawing.points.push({ x: event.pageX, y: event.pageY });
        renderDrawings();
        return;
      }
      const rect = {
        x: Math.min(drawStart.x, event.pageX),
        y: Math.min(drawStart.y, event.pageY),
        width: Math.abs(event.pageX - drawStart.x),
        height: Math.abs(event.pageY - drawStart.y),
      };
      if (mode === "square" && activeDrawing?.type === "rect") {
        activeDrawing.rect = rect;
        renderDrawings();
      } else if (mode === "frame" && targetContext) {
        targetContext.rect = rect;
        displayRect(frameBox, surfaceToViewport(rect));
      }
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (!drawStart || isOverlayEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drawStart = null;
      if ((mode === "pencil" || mode === "square") && activeDrawing) {
        const finished = activeDrawing;
        activeDrawing = null;
        if (
          (finished.type === "path" && finished.points.length > 1) ||
          (finished.type === "rect" &&
            finished.rect.width >= 3 &&
            finished.rect.height >= 3)
        )
          addDrawing(finished);
        else renderDrawings();
      } else if (mode === "frame" && targetContext) {
        if (targetContext.rect.width < 4 || targetContext.rect.height < 4) {
          targetContext = null;
          displayRect(frameBox, null);
          showToast("Нарисуйте область крупнее");
          return;
        }
        targetContext.label = `Область: ${Math.round(targetContext.rect.width)} × ${Math.round(targetContext.rect.height)} px`;
        const target = targetContext;
        setMode("idle");
        openComposer(target, "code-change");
      }
    },
    true,
  );

  function updateTaskCount(): void {
    const backlogCount = readyTasks.length;
    const progress = progressTasks();
    const completed = completedTasks();
    const progressNeedsAttention = progress.some(
      (task) =>
        task.status === "needs_input" ||
        task.status === "rejected" ||
        currentBatches.some(
          (batch) =>
            batch.id === task.batchId &&
            (batch.status === "needs_input" || batch.status === "failed"),
        ),
    );
    const completedNeedsAttention = completed.some((task) => !task.rating);
    taskBadge.textContent = String(backlogCount);
    taskBadge.dataset.visible = String(backlogCount > 0);
    applyButton.disabled = backlogCount === 0;
    panelApplyButton.disabled = backlogCount === 0;
    panelClearButton.disabled = backlogCount === 0;
    setTabCount(backlogTabCount, backlogCount, false);
    setTabCount(progressTabCount, progress.length, progressNeedsAttention);
    setTabCount(completedTabCount, completed.length, completedNeedsAttention);
  }

  function setTabCount(
    element: HTMLElement,
    count: number,
    attention: boolean,
  ): void {
    element.textContent = String(count);
    element.dataset.visible = String(count > 0);
    element.dataset.attention = String(count > 0 && attention);
  }

  function orderedTasks(tasks = allTasks): OverlayTask[] {
    return [...tasks].sort(
      (left, right) =>
        (left.displayNumber ?? Number.MAX_SAFE_INTEGER) -
          (right.displayNumber ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  function orderedBacklogTasks(): OverlayTask[] {
    return orderedTasks(readyTasks);
  }

  function orderedGroupTasks(group: OverlayTaskGroup): OverlayTask[] {
    if (!group.batch) return orderedTasks(group.tasks);
    const taskById = new Map(group.tasks.map((task) => [task.id, task]));
    const ordered = group.batch.taskIds.flatMap((id) => {
      const task = taskById.get(id);
      return task ? [task] : [];
    });
    const included = new Set(ordered.map((task) => task.id));
    return [
      ...ordered,
      ...orderedTasks(group.tasks.filter((task) => !included.has(task.id))),
    ];
  }

  function progressTasks(): OverlayTask[] {
    return orderedTasks(
      allTasks.filter((task) =>
        ["queued", "in_progress", "needs_input", "rejected"].includes(
          task.status,
        ),
      ),
    );
  }

  function completedTasks(): OverlayTask[] {
    return orderedTasks(allTasks.filter((task) => task.status === "applied"));
  }

  function taskDisplayNumber(task: OverlayTask): number {
    if (task.status === "ready" && !task.batchId) {
      const backlogIndex = orderedBacklogTasks().findIndex(
        (candidate) => candidate.id === task.id,
      );
      if (backlogIndex >= 0) return backlogIndex + 1;
    }
    if (task.batchId) {
      const batch = currentBatches.find(
        (candidate) => candidate.id === task.batchId,
      );
      const batchIndex = batch?.taskIds.indexOf(task.id) ?? -1;
      if (batchIndex >= 0) return batchIndex + 1;
      const storedBatchIndex = orderedTasks(
        allTasks.filter((candidate) => candidate.batchId === task.batchId),
      ).findIndex((candidate) => candidate.id === task.id);
      if (storedBatchIndex >= 0) return storedBatchIndex + 1;
    }
    if (task.displayNumber && task.displayNumber > 0) return task.displayNumber;
    const rootIds = [
      ...new Set(
        orderedTasks().map((candidate) => candidate.rootTaskId ?? candidate.id),
      ),
    ];
    return Math.max(1, rootIds.indexOf(task.rootTaskId ?? task.id) + 1);
  }

  function targetContextFromTask(task: OverlayTask): TargetContext | null {
    const region = task.regions[0];
    if (!region) return null;
    const selector = task.nodes.find(
      (node) => node.stableSelector,
    )?.stableSelector;
    let element: Element | undefined;
    if (selector)
      try {
        element = document.querySelector(selector) ?? undefined;
      } catch {
        element = undefined;
      }
    if (element) {
      const box = element.getBoundingClientRect();
      return {
        rect: {
          x: box.x + scrollX,
          y: box.y + scrollY,
          width: box.width,
          height: box.height,
        },
        element,
        label: `Выбрано: ${selectorFor(element)}`,
      };
    }
    return {
      rect: {
        x: region.x + (region.coordinateSpace === "surface" ? 0 : scrollX),
        y: region.y + (region.coordinateSpace === "surface" ? 0 : scrollY),
        width: region.width,
        height: region.height,
      },
      label: "Область комментария",
    };
  }

  function anchorPlacementRect(
    target: TargetContext,
    anchor?: HTMLElement,
  ): Rect {
    if (anchor) {
      const box = anchor.getBoundingClientRect();
      return {
        x: box.x + scrollX,
        y: box.y + scrollY,
        width: box.width,
        height: box.height,
      };
    }
    return {
      x: target.rect.x + Math.min(target.rect.width, 14) - 13.5,
      y: target.rect.y + Math.min(target.rect.height, 14) - 13.5,
      width: 27,
      height: 27,
    };
  }

  function moveViewportToTask(task: OverlayTask): TargetContext | null {
    const initialTarget = targetContextFromTask(task);
    if (!initialTarget) return null;
    if (initialTarget.element) {
      initialTarget.element.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "auto",
      });
    } else {
      const top = Math.max(
        0,
        initialTarget.rect.y - innerHeight / 2 + initialTarget.rect.height / 2,
      );
      const left = Math.max(
        0,
        initialTarget.rect.x - innerWidth / 2 + initialTarget.rect.width / 2,
      );
      window.scrollTo({ top, left, behavior: "auto" });
    }
    return targetContextFromTask(task);
  }

  function focusTaskOnPage(task: OverlayTask): TargetContext | null {
    const target = moveViewportToTask(task);
    if (!target) {
      showToast("У задачи не сохранилась область на странице");
      return null;
    }
    setPanelOpen(false);
    const rect = surfaceToViewport(target.rect);
    if (target.element) {
      displayRect(frameBox, null);
      displayRect(highlight, rect);
    } else {
      displayRect(highlight, null);
      displayRect(frameBox, rect);
    }
    renderAnchors();
    return target;
  }

  function openTaskComposer(task: OverlayTask): void {
    const target = focusTaskOnPage(task);
    if (!target) return;
    setMode("idle");
    textarea.value = task.intent.instruction;
    draftAttachments = clone(task.attachments);
    renderAttachments();
    openComposer(target, task.kind, {
      editingTask: task,
      placementRect: anchorPlacementRect(target),
    });
    syncComposerLayout();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function openRevisionComposer(task: OverlayTask): void {
    const target = focusTaskOnPage(task);
    if (!target) return;
    setMode("idle");
    textarea.value = "";
    draftAttachments = clone(task.attachments);
    renderAttachments();
    openComposer(target, task.kind, {
      revisionSourceTask: task,
      placementRect: anchorPlacementRect(target),
    });
    syncComposerLayout();
    textarea.focus({ preventScroll: true });
  }

  function renderAnchors(): void {
    anchorLayer.replaceChildren();
    const latestByRoot = new Map<string, OverlayTask>();
    orderedBacklogTasks().forEach((task) => {
      const rootId = task.rootTaskId ?? task.id;
      const existing = latestByRoot.get(rootId);
      if (!existing || task.round >= existing.round)
        latestByRoot.set(rootId, task);
    });
    [...latestByRoot.values()].forEach((task) => {
      const region = task.regions[0];
      if (!region) return;
      const x =
        region.coordinateSpace === "surface" ? region.x - scrollX : region.x;
      const y =
        region.coordinateSpace === "surface" ? region.y - scrollY : region.y;
      if (x < -30 || y < -30 || x > innerWidth + 30 || y > innerHeight + 30)
        return;
      const anchor = document.createElement("button");
      anchor.className = "vip-anchor";
      anchor.dataset.taskId = task.id;
      anchor.style.left = `${x + Math.min(region.width, 14)}px`;
      anchor.style.top = `${y + Math.min(region.height, 14)}px`;
      anchor.title = task.intent.instruction;
      anchor.textContent = String(taskDisplayNumber(task));
      anchor.addEventListener("click", () => openTaskComposer(task));
      anchorLayer.append(anchor);
    });
  }

  function renderAttachments(): void {
    attachmentsElement.replaceChildren();
    for (const attachment of draftAttachments) {
      const item = document.createElement("div");
      item.className = "vip-attachment";
      if (/^image\/(?:png|jpe?g|webp|gif)$/iu.test(attachment.mimeType)) {
        const image = document.createElement("img");
        image.src = `${apiBase}/attachments/${encodeURIComponent(attachment.id)}`;
        image.alt = attachment.fileName;
        image.draggable = false;
        item.append(image);
      } else {
        const label = document.createElement("div");
        label.className = "vip-attachment-file";
        label.textContent = attachment.fileName;
        item.append(label);
      }
      const remove = document.createElement("button");
      remove.className = "vip-attachment-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Удалить вложение";
      remove.addEventListener("click", () => void removeAttachment(attachment));
      item.append(remove);
      item.addEventListener("dragstart", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      });
      attachmentsElement.append(item);
    }
    syncComposerLayout();
  }
  async function uploadAttachment(
    blob: Blob,
    kind: Attachment["kind"],
    fileName: string,
    dimensions?: { width: number; height: number },
  ): Promise<Attachment> {
    if (draftAttachments.length >= 3)
      throw new Error("Можно прикрепить не больше трёх файлов");
    const query = new URLSearchParams({ kind, fileName });
    if (dimensions) {
      query.set("width", String(dimensions.width));
      query.set("height", String(dimensions.height));
    }
    const response = await apiFetch(`${apiBase}/attachments?${query}`, {
      method: "POST",
      headers: { "content-type": blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as Attachment;
  }
  async function deleteStoredAttachment(attachmentId: string): Promise<void> {
    const response = await apiFetch(
      `${apiBase}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw await responseError(response);
  }
  async function removeAttachment(attachment: Attachment): Promise<void> {
    try {
      const belongsToEditingTask = editingTask?.attachments.some(
        (item) => item.id === attachment.id,
      );
      if (!belongsToEditingTask) await deleteStoredAttachment(attachment.id);
      draftAttachments = draftAttachments.filter(
        (item) => item.id !== attachment.id,
      );
      renderAttachments();
    } catch (error) {
      showToast(`Не удалось удалить вложение: ${String(error)}`);
    }
  }
  function isSupportedImage(file: File): boolean {
    return (
      /^image\/(?:png|jpe?g|webp|heic|heif)$/iu.test(file.type) ||
      /\.(?:png|jpe?g|webp|heic|heif)$/iu.test(file.name)
    );
  }
  function clipboardImageFiles(data: DataTransfer | null): File[] {
    if (!data) return [];
    const directFiles = [...data.files].filter(isSupportedImage);
    if (directFiles.length > 0) return directFiles;
    return [...data.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file && isSupportedImage(file)));
  }
  async function attachFiles(files: FileList | File[] | null): Promise<void> {
    if (!files) return;
    const provided = [...files];
    const supported = provided.filter(isSupportedImage);
    if (supported.length < provided.length)
      showToast("Поддерживаются PNG, JPEG, WebP, HEIC и HEIF");
    const selected = supported.slice(0, 3 - draftAttachments.length);
    if (selected.length < supported.length)
      showToast("К одной задаче можно прикрепить максимум три файла");
    for (const file of selected)
      try {
        draftAttachments.push(await uploadAttachment(file, "file", file.name));
        renderAttachments();
      } catch (error) {
        showToast(`Не удалось прикрепить ${file.name}: ${String(error)}`);
      }
    fileInput.value = "";
  }

  let cropRect: Rect = { x: 80, y: 100, width: 640, height: 420 };
  let cropInteraction: {
    type: "move" | "resize";
    handle?: string;
    start: Point;
    original: Rect;
  } | null = null;
  let screenshotResumesComposer = false;
  let screenshotStream: MediaStream | null = null;
  let screenshotVideo: HTMLVideoElement | null = null;
  let screenshotPreparing = false;
  function clampCrop(rect: Rect): Rect {
    const viewportWidth = Math.max(1, innerWidth),
      viewportHeight = Math.max(1, innerHeight),
      minimumWidth = Math.min(80, viewportWidth),
      minimumHeight = Math.min(80, viewportHeight),
      width = Math.max(minimumWidth, Math.min(rect.width, viewportWidth)),
      height = Math.max(minimumHeight, Math.min(rect.height, viewportHeight));
    return {
      x: Math.max(0, Math.min(rect.x, viewportWidth - width)),
      y: Math.max(0, Math.min(rect.y, viewportHeight - height)),
      width,
      height,
    };
  }
  function positionCropActions(): void {
    const margin = 8,
      gap = 8,
      actionsWidth = cropActions.offsetWidth || 210,
      actionsHeight = cropActions.offsetHeight || 42,
      above = cropRect.y - actionsHeight - gap,
      below = cropRect.y + cropRect.height + gap;
    let top: number;
    if (above >= margin) top = above;
    else if (below + actionsHeight <= innerHeight - margin) top = below;
    else
      top = Math.max(
        margin,
        Math.min(cropRect.y + gap, innerHeight - actionsHeight - margin),
      );
    const left = Math.max(
      margin,
      Math.min(cropRect.x, innerWidth - actionsWidth - margin),
    );
    cropActions.style.left = `${left}px`;
    cropActions.style.top = `${top}px`;
  }
  function renderCrop(): void {
    cropRect = clampCrop(cropRect);
    Object.assign(crop.style, {
      left: `${cropRect.x}px`,
      top: `${cropRect.y}px`,
      width: `${cropRect.width}px`,
      height: `${cropRect.height}px`,
    });
    positionCropActions();
  }
  function stopScreenshotStream(): void {
    screenshotStream?.getTracks().forEach((track) => track.stop());
    if (screenshotVideo) {
      screenshotVideo.pause();
      screenshotVideo.srcObject = null;
    }
    screenshotStream = null;
    screenshotVideo = null;
  }
  async function beginScreenshot(): Promise<void> {
    if (screenshotPreparing || cropLayer.dataset.open === "true") return;
    if (draftAttachments.length >= 3) {
      showToast("К одной задаче можно прикрепить максимум три файла");
      return;
    }
    screenshotPreparing = true;
    attachmentMenu.dataset.open = "false";
    if (navigator.mediaDevices?.getDisplayMedia) {
      try {
        showToast("Выберите в браузере текущую вкладку для снимка");
        const options = {
          video: { frameRate: { ideal: 5, max: 10 } },
          audio: false,
          preferCurrentTab: true,
          selfBrowserSurface: "include",
          surfaceSwitching: "exclude",
        } as DisplayMediaStreamOptions & Record<string, unknown>;
        screenshotStream =
          await navigator.mediaDevices.getDisplayMedia(options);
        const track = screenshotStream.getVideoTracks()[0];
        if (!track) throw new Error("Браузер не вернул видеопоток вкладки");
        const displaySurface = track.getSettings().displaySurface;
        if (displaySurface && displaySurface !== "browser")
          throw new Error(
            "Для точного снимка выберите текущую вкладку, а не окно или экран",
          );
        track.contentHint = "detail";
        screenshotVideo = document.createElement("video");
        screenshotVideo.muted = true;
        screenshotVideo.playsInline = true;
        screenshotVideo.srcObject = screenshotStream;
        await new Promise<void>((resolve, reject) => {
          const video = screenshotVideo;
          if (!video) return reject(new Error("Поток вкладки недоступен"));
          if (video.readyState >= 1) return resolve();
          video.addEventListener("loadedmetadata", () => resolve(), {
            once: true,
          });
          video.addEventListener(
            "error",
            () => reject(new Error("Не удалось прочитать изображение вкладки")),
            { once: true },
          );
        });
        await screenshotVideo.play();
        track.addEventListener(
          "ended",
          () => {
            if (cropLayer.dataset.open === "true") cancelScreenshot();
          },
          { once: true },
        );
      } catch (error) {
        stopScreenshotStream();
        const errorName = error instanceof DOMException ? error.name : "";
        if (
          errorName === "InvalidStateError" ||
          errorName === "NotSupportedError"
        )
          showToast("Browser capture недоступен — используется DOM fallback");
        else {
          screenshotPreparing = false;
          showToast(`Снимок отменён: ${String(error)}`);
          return;
        }
      }
    } else {
      showToast("Browser capture недоступен — используется DOM fallback");
    }
    screenshotResumesComposer = composer.dataset.open === "true";
    previousMode = mode;
    const target = currentTargetRect();
    cropRect = target
      ? clampCrop(surfaceToViewport(target))
      : clampCrop({
          x: innerWidth * 0.16,
          y: Math.max(90, innerHeight * 0.16),
          width: innerWidth * 0.68,
          height: innerHeight * 0.62,
        });
    composer.hidden = true;
    composer.inert = true;
    cropLayer.dataset.open = "true";
    renderCrop();
    setMode("screenshot");
    screenshotPreparing = false;
  }
  function cancelScreenshot(): void {
    stopScreenshotStream();
    screenshotPreparing = false;
    cropLayer.dataset.open = "false";
    composer.hidden = false;
    composer.inert = false;
    setMode(previousMode === "screenshot" ? "idle" : previousMode);
    if (screenshotResumesComposer) {
      composer.dataset.open = "true";
      const rect = currentComposerPlacementRect();
      if (rect) positionComposer(surfaceToViewport(rect));
      textarea.focus();
    }
  }
  function drawRoundedRect(
    context: CanvasRenderingContext2D,
    rect: Rect,
    radius: number,
  ): void {
    const r = Math.min(radius, rect.width / 2, rect.height / 2);
    context.beginPath();
    context.moveTo(rect.x + r, rect.y);
    context.lineTo(rect.x + rect.width - r, rect.y);
    context.quadraticCurveTo(
      rect.x + rect.width,
      rect.y,
      rect.x + rect.width,
      rect.y + r,
    );
    context.lineTo(rect.x + rect.width, rect.y + rect.height - r);
    context.quadraticCurveTo(
      rect.x + rect.width,
      rect.y + rect.height,
      rect.x + rect.width - r,
      rect.y + rect.height,
    );
    context.lineTo(rect.x + r, rect.y + rect.height);
    context.quadraticCurveTo(
      rect.x,
      rect.y + rect.height,
      rect.x,
      rect.y + rect.height - r,
    );
    context.lineTo(rect.x, rect.y + r);
    context.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
    context.closePath();
  }
  function compositeDrawings(output: HTMLCanvasElement, pageRect: Rect): void {
    const context = output.getContext("2d");
    if (!context) return;
    const scale = output.width / pageRect.width;
    context.save();
    context.scale(scale, scale);
    context.translate(-pageRect.x, -pageRect.y);
    for (const drawing of drawings) {
      context.strokeStyle = drawing.color;
      context.lineWidth = drawing.width;
      context.lineCap = "round";
      context.lineJoin = "round";
      if (drawing.type === "path") {
        const [first, ...rest] = drawing.points;
        if (!first) continue;
        context.beginPath();
        context.moveTo(first.x, first.y);
        rest.forEach((point) => context.lineTo(point.x, point.y));
        context.stroke();
      } else {
        drawRoundedRect(context, drawing.rect, 4);
        context.stroke();
      }
    }
    context.restore();
  }

  function modernColorToRgba(value: string): string {
    const match = value.match(/^(oklab|lab|oklch|lch)\((.*)\)$/iu);
    if (!match?.[1] || !match[2]) return value;
    const [channelsPart, alphaPart] = match[2]
      .split("/")
      .map((part) => part.trim());
    const channels = channelsPart?.split(/\s+/u) ?? [];
    if (channels.length < 3) return value;
    const number = (raw: string, percentScale = 1): number =>
      raw.endsWith("%")
        ? (Number.parseFloat(raw) / 100) * percentScale
        : Number.parseFloat(raw);
    let first = number(channels[0] ?? "0");
    let second = number(channels[1] ?? "0");
    let third = number(channels[2] ?? "0");
    const alpha = alphaPart ? Math.max(0, Math.min(1, number(alphaPart))) : 1;
    const space = match[1].toLowerCase();
    if (space.endsWith("lch")) {
      const hue = (third * Math.PI) / 180;
      const chroma = second;
      second = chroma * Math.cos(hue);
      third = chroma * Math.sin(hue);
    }
    let linearRed: number;
    let linearGreen: number;
    let linearBlue: number;
    if (space.startsWith("ok")) {
      const l = first + 0.3963377774 * second + 0.2158037573 * third;
      const m = first - 0.1055613458 * second - 0.0638541728 * third;
      const s = first - 0.0894841775 * second - 1.291485548 * third;
      const l3 = l ** 3;
      const m3 = m ** 3;
      const s3 = s ** 3;
      linearRed = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
      linearGreen = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
      linearBlue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
    } else {
      if (channels[0]?.endsWith("%")) first *= 100;
      const fy = (first + 16) / 116;
      const fx = fy + second / 500;
      const fz = fy - third / 200;
      const inverse = (channel: number): number =>
        channel ** 3 > 216 / 24389
          ? channel ** 3
          : (116 * channel - 16) / (24389 / 27);
      const x50 = 0.96422 * inverse(fx);
      const y50 = inverse(fy);
      const z50 = 0.82521 * inverse(fz);
      const x = 0.9555766 * x50 - 0.0230393 * y50 + 0.0631636 * z50;
      const y = -0.0282895 * x50 + 1.0099416 * y50 + 0.0210077 * z50;
      const z = 0.0122982 * x50 - 0.020483 * y50 + 1.3299098 * z50;
      linearRed = 3.2406 * x - 1.5372 * y - 0.4986 * z;
      linearGreen = -0.9689 * x + 1.8758 * y + 0.0415 * z;
      linearBlue = 0.0557 * x - 0.204 * y + 1.057 * z;
    }
    const encode = (channel: number): number => {
      const encoded =
        channel <= 0.0031308
          ? 12.92 * channel
          : 1.055 * channel ** (1 / 2.4) - 0.055;
      return Math.round(Math.max(0, Math.min(1, encoded)) * 255);
    };
    return `rgba(${encode(linearRed)}, ${encode(linearGreen)}, ${encode(linearBlue)}, ${alpha})`;
  }

  function normalizeModernColors(value: string): string {
    return value.replace(/(oklab|lab|oklch|lch)\([^()]+\)/giu, (color) =>
      modernColorToRgba(color),
    );
  }

  function normalizeScreenshotClone(clonedDocument: Document): void {
    const properties = [
      "color",
      "background-color",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
      "outline-color",
      "text-decoration-color",
      "caret-color",
      "column-rule-color",
      "fill",
      "stroke",
      "box-shadow",
      "text-shadow",
    ];
    const originals = [
      document.documentElement,
      ...document.documentElement.querySelectorAll("*"),
    ];
    const clones = [
      clonedDocument.documentElement,
      ...clonedDocument.documentElement.querySelectorAll("*"),
    ];
    originals.forEach((original, index) => {
      const target = clones[index];
      if (!target || !("style" in target)) return;
      const styledTarget = target as HTMLElement | SVGElement;
      const computed = getComputedStyle(original);
      properties.forEach((property) => {
        const value = computed.getPropertyValue(property);
        if (/(?:ok)?l(?:ab|ch)\(/iu.test(value)) {
          styledTarget.style.setProperty(
            property,
            normalizeModernColors(value),
            "important",
          );
        }
      });
    });
    const pseudoFallback = clonedDocument.createElement("style");
    pseudoFallback.textContent =
      "*::before,*::after{border-color:rgba(229,231,235,1);outline-color:rgba(156,163,175,.5)}";
    clonedDocument.head.append(pseudoFallback);
  }

  function normalizePageColorsForCapture(): () => void {
    const properties = [
      "color",
      "background-color",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
      "outline-color",
      "text-decoration-color",
      "caret-color",
      "column-rule-color",
      "fill",
      "stroke",
      "box-shadow",
      "text-shadow",
    ];
    const changes: Array<{
      target: HTMLElement | SVGElement;
      property: string;
      value: string;
      priority: string;
    }> = [];
    const elements = [
      document.documentElement,
      ...document.documentElement.querySelectorAll("*"),
    ];
    elements.forEach((element) => {
      if (!("style" in element)) return;
      const target = element as HTMLElement | SVGElement;
      const computed = getComputedStyle(element);
      properties.forEach((property) => {
        const value = computed.getPropertyValue(property);
        if (!/(?:ok)?l(?:ab|ch)\(/iu.test(value)) return;
        changes.push({
          target,
          property,
          value: target.style.getPropertyValue(property),
          priority: target.style.getPropertyPriority(property),
        });
        target.style.setProperty(
          property,
          normalizeModernColors(value),
          "important",
        );
      });
    });
    const pseudoFallback = document.createElement("style");
    pseudoFallback.textContent =
      "*::before,*::after{border-color:rgba(229,231,235,1)!important;outline-color:rgba(156,163,175,.5)!important}";
    document.head.append(pseudoFallback);
    return () => {
      pseudoFallback.remove();
      changes.forEach(({ target, property, value, priority }) => {
        if (value) target.style.setProperty(property, value, priority);
        else target.style.removeProperty(property);
      });
    };
  }

  async function nextCapturedFrame(): Promise<void> {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
  }

  async function captureBrowserPixels(): Promise<HTMLCanvasElement> {
    const video = screenshotVideo;
    if (!video || video.videoWidth < 1 || video.videoHeight < 1)
      throw new Error("Поток текущей вкладки недоступен");
    shell.dataset.capturing = "true";
    try {
      await nextCapturedFrame();
      const scaleX = video.videoWidth / innerWidth;
      const scaleY = video.videoHeight / innerHeight;
      const output = document.createElement("canvas");
      output.width = Math.max(1, Math.round(cropRect.width * scaleX));
      output.height = Math.max(1, Math.round(cropRect.height * scaleY));
      const context = output.getContext("2d");
      if (!context) throw new Error("Canvas для снимка недоступен");
      context.drawImage(
        video,
        cropRect.x * scaleX,
        cropRect.y * scaleY,
        cropRect.width * scaleX,
        cropRect.height * scaleY,
        0,
        0,
        output.width,
        output.height,
      );
      return output;
    } finally {
      shell.dataset.capturing = "false";
    }
  }

  async function captureDomPixels(pageRect: Rect): Promise<HTMLCanvasElement> {
    const html2canvas = (
      window as Window & {
        html2canvas?: (
          element: HTMLElement,
          options: Record<string, unknown>,
        ) => Promise<HTMLCanvasElement>;
      }
    ).html2canvas;
    if (!html2canvas) throw new Error("Модуль DOM fallback не загрузился");
    const restorePageColors = normalizePageColorsForCapture();
    try {
      const output = await html2canvas(document.documentElement, {
        x: pageRect.x,
        y: pageRect.y,
        width: pageRect.width,
        height: pageRect.height,
        scale: devicePixelRatio || 1,
        scrollX: 0,
        scrollY: 0,
        useCORS: true,
        foreignObjectRendering: true,
        backgroundColor: null,
        logging: false,
        onclone: normalizeScreenshotClone,
        ignoreElements: (element: Element) => element === overlayHost,
      });
      compositeDrawings(output, pageRect);
      return output;
    } finally {
      restorePageColors();
    }
  }

  async function captureScreenshot(): Promise<void> {
    const button = required<HTMLButtonElement>("[data-crop-action='capture']");
    button.disabled = true;
    const pageRect = {
      x: cropRect.x + scrollX,
      y: cropRect.y + scrollY,
      width: cropRect.width,
      height: cropRect.height,
    };
    try {
      const output = screenshotVideo
        ? await captureBrowserPixels()
        : await captureDomPixels(pageRect);
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error("Не удалось создать PNG")),
          "image/png",
        ),
      );
      draftAttachments.push(
        await uploadAttachment(
          blob,
          "screenshot",
          `visual-intent-${Date.now()}.png`,
          { width: output.width, height: output.height },
        ),
      );
      renderAttachments();
      if (!targetContext)
        targetContext = {
          rect: pageRect,
          label: `Скриншот: ${Math.round(pageRect.width)} × ${Math.round(pageRect.height)} px`,
        };
      cropLayer.dataset.open = "false";
      stopScreenshotStream();
      composer.hidden = false;
      composer.inert = false;
      setMode(previousMode === "screenshot" ? "idle" : previousMode);
      openComposer(targetContext, draftKind, {
        ...(editingTask ? { editingTask: clone(editingTask) } : {}),
        ...(composerPlacementRect
          ? { placementRect: { ...composerPlacementRect } }
          : {}),
      });
      showToast("Скриншот прикреплён");
    } catch (error) {
      showToast(`Не удалось сделать скриншот: ${String(error)}`);
      cancelScreenshot();
    } finally {
      button.disabled = false;
    }
  }

  crop.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("button")) return;
    const handle = target?.dataset.handle;
    cropInteraction = {
      type: handle ? "resize" : "move",
      ...(handle ? { handle } : {}),
      start: { x: event.clientX, y: event.clientY },
      original: { ...cropRect },
    };
    crop.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  crop.addEventListener("pointermove", (event) => {
    if (!cropInteraction) return;
    const dx = event.clientX - cropInteraction.start.x,
      dy = event.clientY - cropInteraction.start.y,
      original = cropInteraction.original;
    if (cropInteraction.type === "move")
      cropRect = { ...original, x: original.x + dx, y: original.y + dy };
    else {
      const handle = cropInteraction.handle ?? "se";
      let { x, y, width, height } = original;
      if (handle.includes("e")) width += dx;
      if (handle.includes("s")) height += dy;
      if (handle.includes("w")) {
        x += dx;
        width -= dx;
      }
      if (handle.includes("n")) {
        y += dy;
        height -= dy;
      }
      if (width < 80) {
        if (handle.includes("w")) x -= 80 - width;
        width = 80;
      }
      if (height < 80) {
        if (handle.includes("n")) y -= 80 - height;
        height = 80;
      }
      cropRect = { x, y, width, height };
    }
    renderCrop();
  });
  crop.addEventListener("pointerup", (event) => {
    cropInteraction = null;
    if (crop.hasPointerCapture(event.pointerId))
      crop.releasePointerCapture(event.pointerId);
  });

  function buildTaskPayload(
    instruction: string,
  ): Record<string, unknown> | null {
    const rect = currentTargetRect();
    if (!rect) return null;
    const surfaceId = id(),
      frameId = id(),
      nodeId = targetContext?.element ? id() : null,
      regionId = id();
    const attributes: Record<string, string> = {};
    if (targetContext?.element)
      ["role", "aria-label", "data-testid"].forEach((name) => {
        const value = targetContext?.element?.getAttribute(name);
        if (value) attributes[name] = value;
      });
    return {
      protocolVersion: "0.1",
      kind: draftKind,
      surface: {
        id: surfaceId,
        platform: "web",
        uri: location.href,
        title: document.title,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio: devicePixelRatio || 1,
        },
        adapter: { name: "web-overlay", version: "0.1.0" },
      },
      nodes:
        targetContext?.element && nodeId
          ? [
              {
                id: nodeId,
                surfaceId,
                kind: "element",
                name: targetContext.element.tagName.toLowerCase(),
                stableSelector: selectorFor(targetContext.element),
                text: (targetContext.element.textContent ?? "")
                  .trim()
                  .slice(0, 240),
                attributes,
              },
            ]
          : [],
      frames: [
        {
          id: frameId,
          surfaceId,
          x: scrollX,
          y: scrollY,
          width: innerWidth,
          height: innerHeight,
          scrollX,
          scrollY,
          scale: devicePixelRatio || 1,
        },
      ],
      regions: [
        {
          id: regionId,
          surfaceId,
          frameId,
          ...rect,
          unit: "px",
          coordinateSpace: "surface",
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
      annotations: instruction
        ? [
            {
              id: id(),
              kind: "comment",
              body: instruction,
              ...(nodeId ? { nodeId } : {}),
              regionId,
              createdAt: new Date().toISOString(),
            },
          ]
        : [],
      attachments: clone(draftAttachments),
      intent: {
        id: id(),
        action: "change",
        instruction,
        acceptanceCriteria: [],
      },
    };
  }
  const createPayloadFromTask = (task: OverlayTask): Record<string, unknown> =>
    clone({
      protocolVersion: task.protocolVersion,
      ...(task.displayNumber ? { displayNumber: task.displayNumber } : {}),
      kind: task.kind,
      surface: task.surface,
      nodes: task.nodes,
      regions: task.regions,
      frames: task.frames,
      relations: task.relations,
      annotations: task.annotations,
      attachments: task.attachments,
      intent: task.intent,
    });
  async function postTask(
    payload: Record<string, unknown>,
  ): Promise<OverlayTask> {
    const response = await apiFetch(`${apiBase}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as OverlayTask;
  }
  async function deleteTask(taskId: string): Promise<void> {
    const response = await apiFetch(
      `${apiBase}/tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw await responseError(response);
  }
  async function updateReadyTask(
    task: OverlayTask,
    instruction: string,
    attachments: Attachment[],
  ): Promise<OverlayTask> {
    const response = await apiFetch(
      `${apiBase}/tasks/${encodeURIComponent(task.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: task.revision,
          instruction,
          attachments,
        }),
      },
    );
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as OverlayTask;
  }
  async function postTaskReview(
    task: OverlayTask,
    outcome: ReviewOutcome,
    options: {
      note?: string;
      revision?: { instruction: string; attachments?: Attachment[] };
    } = {},
  ): Promise<void> {
    const response = await apiFetch(
      `${apiBase}/tasks/${encodeURIComponent(task.id)}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: task.revision,
          outcome,
          ...(options.note ? { note: options.note } : {}),
          ...(options.revision ? { revision: options.revision } : {}),
        }),
      },
    );
    if (!response.ok) throw await responseError(response);
  }
  async function putTaskRating(
    task: OverlayTask,
    value: number,
  ): Promise<OverlayTask> {
    const response = await apiFetch(
      `${apiBase}/tasks/${encodeURIComponent(task.id)}/rating`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: task.revision,
          value,
        }),
      },
    );
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as OverlayTask;
  }
  async function saveTask(): Promise<void> {
    const instruction = textarea.value.trim();
    if (!currentTargetRect()) {
      showToast("Сначала выберите элемент или область");
      return;
    }
    if (
      !instruction &&
      (Boolean(revisionSourceTask) || draftKind !== "figma-component")
    ) {
      showToast("Опишите, что нужно изменить");
      textarea.focus();
      return;
    }
    const taskBeingEdited = editingTask ? clone(editingTask) : null;
    const taskBeingRevised = revisionSourceTask
      ? clone(revisionSourceTask)
      : null;
    const payload =
      taskBeingEdited || taskBeingRevised
        ? null
        : buildTaskPayload(instruction);
    if (!taskBeingEdited && !taskBeingRevised && !payload) return;
    const button = required<HTMLButtonElement>("[data-composer-action='save']");
    button.disabled = true;
    try {
      if (taskBeingRevised) {
        await postTaskReview(taskBeingRevised, "needs_revision", {
          revision: {
            instruction,
            ...(draftAttachments.length
              ? { attachments: clone(draftAttachments) }
              : {}),
          },
        });
        resetComposer();
        showToast("Правка добавлена в активную итерацию");
        await Promise.all([loadTasks(), loadRuntime()]);
      } else if (taskBeingEdited) {
        const nextInstruction = instruction;
        const nextAttachments = clone(draftAttachments);
        let currentTask = await updateReadyTask(
          taskBeingEdited,
          nextInstruction,
          nextAttachments,
        );
        recordCommand({
          undo: async () => {
            currentTask = await updateReadyTask(
              currentTask,
              taskBeingEdited.intent.instruction,
              clone(taskBeingEdited.attachments),
            );
            await loadTasks();
          },
          redo: async () => {
            currentTask = await updateReadyTask(
              currentTask,
              nextInstruction,
              clone(nextAttachments),
            );
            await loadTasks();
          },
        });
        resetComposer();
        showToast("Задача обновлена");
        await loadTasks();
      } else if (payload) {
        const created = await postTask(payload);
        let taskId = created.id;
        recordCommand({
          undo: async () => {
            await deleteTask(taskId);
            await loadTasks();
          },
          redo: async () => {
            taskId = (await postTask(payload)).id;
            await loadTasks();
          },
        });
        resetComposer();
        showToast("Задача добавлена в список");
        await loadTasks();
      }
    } catch (error) {
      showToast(`Не удалось сохранить задачу: ${String(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  function taskInstruction(task: OverlayTask): string {
    return task.intent.instruction || "Собрать выбранный компонент в Figma";
  }

  function renderTaskCard(
    task: OverlayTask,
    options: {
      deletable?: boolean;
      completed?: boolean;
      usage?: FormattedBatchUsage;
    } = {},
  ): HTMLElement {
    const item = document.createElement("article");
    item.className = `vip-task-card${options.completed ? " vip-ready-card" : ""}`;
    item.dataset.taskId = task.id;
    item.dataset.readonly = String(!options.deletable);
    if (options.completed) item.dataset.rated = String(Boolean(task.rating));
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute(
      "aria-label",
      `Задача ${taskDisplayNumber(task)}: ${taskInstruction(task)}`,
    );
    const number = document.createElement("span");
    number.className = "vip-task-number";
    number.textContent = String(taskDisplayNumber(task));
    const content = document.createElement("div");
    content.className = options.completed
      ? "vip-ready-content"
      : "vip-task-text";
    const copy = document.createElement("div");
    copy.className = "vip-task-text";
    copy.textContent = taskInstruction(task);
    if (options.completed) content.append(copy);
    else content.textContent = taskInstruction(task);
    const open = (): void => {
      if (task.status === "ready") openTaskComposer(task);
      else if (task.status === "applied") openRevisionComposer(task);
      else focusTaskOnPage(task);
    };
    item.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("button"))
        return;
      open();
    });
    item.addEventListener("keydown", (event) => {
      if (event.target instanceof Element && event.target.closest("button"))
        return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    item.append(number, content);
    if (options.deletable) {
      const remove = document.createElement("button");
      remove.className = "vip-task-delete";
      remove.type = "button";
      remove.setAttribute(
        "aria-label",
        `Удалить задачу ${taskDisplayNumber(task)}`,
      );
      remove.append(createIconElement("trash"));
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void deleteBacklogTask(task, remove);
      });
      item.append(remove);
    }
    if (options.completed) {
      if (options.usage) content.append(renderTaskUsageTokens(options.usage));
      const footer = document.createElement("div");
      footer.className = "vip-ready-footer";
      if (options.usage?.raw) footer.append(renderUsageCost(options.usage));
      footer.append(renderRating(task));
      content.append(footer);
    }
    return item;
  }

  async function deleteBacklogTask(
    task: OverlayTask,
    button?: HTMLButtonElement,
  ): Promise<void> {
    if (button) button.disabled = true;
    const payload = createPayloadFromTask(task);
    let taskId = task.id;
    try {
      await deleteTask(taskId);
      recordCommand({
        undo: async () => {
          taskId = (await postTask(payload)).id;
          await loadTasks();
        },
        redo: async () => {
          await deleteTask(taskId);
          await loadTasks();
        },
      });
      await loadTasks();
      showToast("Задача удалена · ⌘Z — вернуть");
    } catch (error) {
      showToast(`Не удалось удалить задачу: ${String(error)}`);
      if (button) button.disabled = false;
    }
  }

  async function clearBacklog(): Promise<void> {
    const tasks = orderedBacklogTasks();
    if (!tasks.length) return;
    panelClearButton.disabled = true;
    const entries = tasks.map((task) => ({
      taskId: task.id,
      payload: createPayloadFromTask(task),
    }));
    try {
      for (const entry of entries) await deleteTask(entry.taskId);
      recordCommand({
        undo: async () => {
          for (const entry of entries)
            entry.taskId = (await postTask(entry.payload)).id;
          await loadTasks();
        },
        redo: async () => {
          for (const entry of entries) await deleteTask(entry.taskId);
          await loadTasks();
        },
      });
      await loadTasks();
      showToast(`Удалено задач: ${entries.length} · ⌘Z — вернуть`);
    } catch (error) {
      showToast(`Не удалось очистить Backlog: ${String(error)}`);
      await loadTasks();
    }
  }

  function formatInteger(value: number): string {
    return new Intl.NumberFormat("ru-RU").format(value);
  }

  function formatCompactTokens(value: number): string {
    if (value < 1_000) return `${formatInteger(value)} tokens`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)} K tokens`;
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} M tokens`;
  }

  function formatCompactMetric(value: number): string {
    if (value < 1_000) return formatInteger(value);
    if (value < 1_000_000) {
      const scaled = value / 1_000;
      const digits = scaled < 100 && !Number.isInteger(scaled) ? 1 : 0;
      return `${scaled.toFixed(digits).replace(".", ",")} K`;
    }
    const scaled = value / 1_000_000;
    const digits = scaled < 100 && !Number.isInteger(scaled) ? 1 : 0;
    return `${scaled.toFixed(digits).replace(".", ",")} M`;
  }

  function formatUsd(value: number): string {
    if (value > 0 && value < 0.01) return "<$0,01";
    return `$${new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)}`;
  }

  function formatBatchUsage(batch: OverlayBatch): FormattedBatchUsage {
    const executions = currentExecutions.filter(
      (candidate) => candidate.batchId === batch.id,
    );
    const candidates: BatchUsage[] = executions.length
      ? executions.map((execution) => execution.usage)
      : batch.result?.usage
        ? [batch.result.usage]
        : [];
    const reported = candidates.filter(
      (usage): usage is Extract<BatchUsage, { availability: "reported" }> =>
        usage.availability === "reported",
    );
    if (!reported.length) {
      const reason = candidates.find(
        (usage) => usage.availability === "unavailable",
      );
      const reasonCode =
        reason?.availability === "unavailable" ? reason.reason : undefined;
      const hostAttached = reasonCode === "host_usage_not_exposed";
      const unavailableLabel = hostAttached
        ? "Токены не измерены"
        : "Токены недоступны";
      const unavailableDetail = hostAttached
        ? "Токены не измерены · пакет выполнил подключённый чат"
        : "Токены недоступны · исполнитель не передал статистику";
      return {
        label: unavailableLabel,
        totalLabel: "—",
        costLabel: "$—",
        tokenLabel: unavailableDetail,
        tokenParts: [unavailableDetail],
        partial: false,
        estimated: false,
        title: hostAttached
          ? "Подключённый чат выполнил пакет, но не передал Visual Intent статистику токенов."
          : reasonCode
            ? `Исполнитель не передал статистику токенов: ${reasonCode}`
            : "Исполнитель не передал статистику токенов",
      };
    }
    const totals = reported.reduce(
      (sum, usage) => ({
        input: sum.input + usage.tokens.inputTokens,
        cached: sum.cached + usage.tokens.cachedInputTokens,
        cacheWrite: sum.cacheWrite + usage.tokens.cacheWriteInputTokens,
        output: sum.output + usage.tokens.outputTokens,
        reasoning: sum.reasoning + usage.tokens.reasoningOutputTokens,
      }),
      { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    );
    const total = totals.input + totals.output;
    const partial = reported.length !== candidates.length;
    const calculatedCosts = reported
      .map((usage) => usage.apiEquivalentCost)
      .filter(
        (
          cost,
        ): cost is Extract<
          NonNullable<
            Extract<
              BatchUsage,
              { availability: "reported" }
            >["apiEquivalentCost"]
          >,
          { availability: "calculated" }
        > => cost?.availability === "calculated",
      );
    const costPartial =
      partial ||
      calculatedCosts.length !== reported.length ||
      calculatedCosts.length !== candidates.length;
    const costTotal = calculatedCosts.reduce(
      (sum, cost) => sum + Number(cost.amountUsd),
      0,
    );
    const costLabel = calculatedCosts.length
      ? `≈${costPartial ? " ≥" : ""}${formatUsd(costTotal)}`
      : "$—";
    const tokenParts = [
      `In ${formatCompactMetric(totals.input)}`,
      `Out ${formatCompactMetric(totals.output)}`,
      `Cache ${formatCompactMetric(totals.cached)}`,
      ...(totals.cacheWrite > 0
        ? [`CW ${formatCompactMetric(totals.cacheWrite)}`]
        : []),
      `R ${formatCompactMetric(totals.reasoning)}`,
    ];
    const pricedModels = [
      ...new Set(calculatedCosts.map((cost) => cost.model)),
    ];
    const pricingNote = calculatedCosts.length
      ? `API-эквивалентная оценка: ${costLabel}. Модель: ${pricedModels.join(", ")}. Reasoning входит в Output и повторно не тарифицируется. Расчёт по сохранённому short-context тарифу OpenAI; комиссии инструментов не включены.`
      : "API-эквивалентная стоимость не была сохранена для этого запуска.";
    return {
      label: `${partial ? "≥ " : ""}${formatCompactTokens(total)}`,
      totalLabel: `${partial ? "≥ " : ""}${formatCompactMetric(total)}`,
      costLabel,
      tokenLabel: `${partial ? "≥ " : ""}${tokenParts.join(" · ")}`,
      tokenParts,
      partial,
      estimated: false,
      title: `${partial ? "Нижняя граница: часть запусков не передала usage. " : ""}Input: ${formatInteger(totals.input)} · Output: ${formatInteger(totals.output)} · Cached input: ${formatInteger(totals.cached)} · Cache write: ${formatInteger(totals.cacheWrite)} · Reasoning: ${formatInteger(totals.reasoning)}. ${pricingNote}`,
      raw: {
        input: totals.input,
        cached: totals.cached,
        cacheWrite: totals.cacheWrite,
        output: totals.output,
        reasoning: totals.reasoning,
        ...(calculatedCosts.length
          ? { costMicros: Math.round(costTotal * 1_000_000) }
          : {}),
        total,
      },
    };
  }

  function formatEstimatedTaskUsage(
    allocation: EstimatedTaskUsageAllocation,
    batchUsage: FormattedBatchUsage,
  ): FormattedBatchUsage {
    const tokenParts = [
      `In ${formatCompactMetric(allocation.input)}`,
      `Out ${formatCompactMetric(allocation.output)}`,
      `Cache ${formatCompactMetric(allocation.cached)}`,
      ...(allocation.cacheWrite > 0
        ? [`CW ${formatCompactMetric(allocation.cacheWrite)}`]
        : []),
      `R ${formatCompactMetric(allocation.reasoning)}`,
    ];
    const percent = new Intl.NumberFormat("ru-RU", {
      maximumFractionDigits: 1,
    }).format(allocation.share * 100);
    const lowerBound = batchUsage.partial
      ? " Пакетный usage неполный, поэтому оценка построена по его нижней границе."
      : "";
    const estimatePrefix = batchUsage.partial ? "≈ ≥ " : "≈ ";
    const allocationScope =
      " Распределение выполнено между всеми задачами Apply-пакета; видимые Ready-карточки могут быть только его готовой частью.";
    return {
      label: `${estimatePrefix}${formatCompactTokens(allocation.total)}`,
      totalLabel: `${estimatePrefix}${formatCompactMetric(allocation.total)}`,
      costLabel:
        allocation.costMicros === undefined
          ? "$—"
          : `${estimatePrefix.trim()}${formatUsd(allocation.costMicros / 1_000_000)}`,
      tokenLabel: `${estimatePrefix}${tokenParts.join(" · ")}`,
      tokenParts,
      partial: batchUsage.partial,
      estimated: true,
      title: `${batchUsage.partial ? "Оценочная доля доступной нижней границы usage" : "Оценочная доля измеренного Apply-пакета"}: ${percent}%. Распределение heuristic-v1 учитывает AI-классификацию, масштаб задачи и количество затронутых файлов; это не измерение отдельного agent turn.${lowerBound}${allocationScope}`,
      raw: {
        input: allocation.input,
        cached: allocation.cached,
        cacheWrite: allocation.cacheWrite,
        output: allocation.output,
        reasoning: allocation.reasoning,
        ...(allocation.costMicros === undefined
          ? {}
          : { costMicros: allocation.costMicros }),
        total: allocation.total,
      },
    };
  }

  function renderUsageCost(usage: FormattedBatchUsage): HTMLElement {
    const cost = document.createElement("span");
    cost.className = "vip-task-cost";
    cost.textContent = usage.costLabel;
    cost.title = usage.title;
    return cost;
  }

  function renderTaskUsageTokens(usage: FormattedBatchUsage): HTMLElement {
    const line = document.createElement("div");
    line.className = "vip-task-tokens";
    line.dataset.available = String(Boolean(usage.raw));
    line.title = usage.title;
    if (!usage.raw) {
      const unavailable = document.createElement("span");
      unavailable.className = "vip-task-usage-unavailable";
      unavailable.textContent = usage.tokenLabel;
      line.append(unavailable);
      return line;
    }
    const total = document.createElement("span");
    total.className = "vip-task-tokens-total";
    total.textContent = `Total ${usage.totalLabel}`;
    line.append(total);
    usage.tokenParts.forEach((part) => {
      const metric = document.createElement("span");
      metric.className = "vip-task-token-metric";
      metric.textContent = `${usage.estimated ? "" : usage.partial ? "≥ " : ""}${part}`;
      line.append(metric);
    });
    return line;
  }

  function renderUsageLine(
    usage: FormattedBatchUsage,
    className: string,
  ): HTMLElement {
    const line = document.createElement("div");
    line.className = className;
    line.title = usage.title;
    const tokens = document.createElement("span");
    tokens.textContent = usage.tokenLabel;
    if (usage.raw) line.append(renderUsageCost(usage), tokens);
    else line.append(tokens);
    return line;
  }

  function formatBatchDuration(batch: OverlayBatch): string {
    const end = batch.completedAt ?? batch.updatedAt;
    const milliseconds = Math.max(
      0,
      new Date(end).getTime() - new Date(batch.createdAt).getTime(),
    );
    const totalMinutes = Math.floor(milliseconds / 60_000);
    if (totalMinutes < 1)
      return `${Math.max(1, Math.round(milliseconds / 1_000))}s`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours ? `${hours}h${minutes ? ` ${minutes}m` : ""}` : `${minutes}m`;
  }

  function ratingTone(value: number): "bad" | "medium" | "good" {
    if (value <= 1) return "bad";
    if (value <= 3) return "medium";
    return "good";
  }

  function renderRating(task: OverlayTask): HTMLElement {
    const rating = document.createElement("div");
    rating.className = "vip-rating";
    rating.dataset.tone = ratingTone(task.rating?.value ?? 5);
    rating.setAttribute(
      "aria-label",
      task.rating ? `Оценка ${task.rating.value} из 5` : "Оценить результат",
    );
    for (let value = 1; value <= 5; value += 1) {
      const star = document.createElement("button");
      star.className = "vip-star";
      star.type = "button";
      star.dataset.selected = String(value <= (task.rating?.value ?? 0));
      star.setAttribute("aria-label", `${value} из 5`);
      star.title = `${value} из 5`;
      star.append(createIconElement("star"));
      star.addEventListener("pointerenter", () => {
        rating.dataset.tone = ratingTone(value);
        rating.style.setProperty(
          "--rating-preview",
          value === 1 ? "#ef4444" : value <= 3 ? "#f59e0b" : "#22c55e",
        );
      });
      star.addEventListener("click", (event) => {
        event.stopPropagation();
        void saveRating(task, value, rating);
      });
      rating.append(star);
    }
    rating.addEventListener("pointerleave", () => {
      rating.dataset.tone = ratingTone(task.rating?.value ?? 5);
      rating.style.removeProperty("--rating-preview");
    });
    return rating;
  }

  async function saveRating(
    task: OverlayTask,
    value: number,
    rating: HTMLElement,
  ): Promise<void> {
    const buttons = rating.querySelectorAll<HTMLButtonElement>("button");
    buttons.forEach((button) => (button.disabled = true));
    try {
      const updated = await putTaskRating(task, value);
      allTasks = allTasks.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      );
      readyTasks = allTasks.filter((candidate) => candidate.status === "ready");
      if (updated.batchId) {
        const completedInBatch = allTasks.filter(
          (candidate) =>
            candidate.status === "applied" &&
            candidate.batchId === updated.batchId,
        );
        if (
          completedInBatch.length > 0 &&
          completedInBatch.every((candidate) => Boolean(candidate.rating))
        )
          expandedBatchIds.delete(updated.batchId);
      }
      updateTaskCount();
      renderTaskPanel();
      showToast(`Оценка сохранена: ${value} из 5`);
    } catch (error) {
      showToast(`Не удалось сохранить оценку: ${String(error)}`);
      await loadTasks();
    }
  }

  function toggleBatchExpansion(groupId: string): void {
    if (expandedBatchIds.has(groupId)) expandedBatchIds.delete(groupId);
    else expandedBatchIds.add(groupId);
    renderTaskPanel();
  }

  function createBatchToggle(groupId: string): HTMLButtonElement {
    const toggle = document.createElement("button");
    toggle.className = "vip-batch-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Свернуть или раскрыть пакет");
    toggle.setAttribute("aria-expanded", String(expandedBatchIds.has(groupId)));
    toggle.append(createIconElement("chevronDown"));
    toggle.addEventListener("click", () => toggleBatchExpansion(groupId));
    return toggle;
  }

  function renderProgressBatch(group: OverlayTaskGroup): HTMLElement {
    const section = document.createElement("section");
    section.className = "vip-batch vip-progress-batch";
    section.dataset.batchId = group.id;
    section.dataset.collapsed = String(!expandedBatchIds.has(group.id));
    const head = document.createElement("div");
    head.className = "vip-batch-head";
    const title = document.createElement("span");
    title.className = "vip-batch-title";
    title.textContent = `${group.tasks.length} ${group.tasks.length === 1 ? "задача" : "задачи"}`;
    head.append(title, createBatchToggle(group.id));
    const cards = document.createElement("div");
    cards.className = "vip-task-list vip-batch-tasks";
    orderedGroupTasks(group).forEach((task) =>
      cards.append(renderTaskCard(task)),
    );
    section.append(head, cards);
    return section;
  }

  function renderReadyBatch(groupData: OverlayTaskGroup): HTMLElement {
    const { batch, tasks } = groupData;
    const usage = batch ? formatBatchUsage(batch) : undefined;
    const group = document.createElement("section");
    group.className = `vip-batch${batch ? "" : " vip-unbatched-ready"}`;
    group.dataset.batchId = groupData.id;
    group.dataset.collapsed = String(!expandedBatchIds.has(groupData.id));
    group.dataset.rated = String(tasks.every((task) => Boolean(task.rating)));
    const head = document.createElement("div");
    head.className = "vip-batch-head";
    const totalInBatch = batch
      ? allTasks.filter((task) => task.batchId === batch.id).length
      : tasks.length;
    const title = document.createElement("span");
    title.className = "vip-batch-title";
    title.textContent =
      totalInBatch > tasks.length
        ? `${tasks.length} из ${totalInBatch} готовы`
        : `${tasks.length} ${tasks.length === 1 ? "задача" : "задачи"}`;
    head.append(title);
    if (batch && usage) {
      const usagePill = document.createElement("span");
      usagePill.className = "vip-batch-pill";
      usagePill.textContent = usage.label;
      usagePill.title = usage.title;
      const duration = document.createElement("span");
      duration.className = "vip-batch-pill vip-batch-duration";
      duration.textContent = formatBatchDuration(batch);
      duration.title = "Время от Apply до готового результата";
      head.append(usagePill, duration);
    }
    head.append(createBatchToggle(groupData.id));
    const cards = document.createElement("div");
    cards.className = "vip-task-list vip-batch-tasks";
    const batchTasks = batch
      ? orderedTasks(
          allTasks.filter((candidate) => candidate.batchId === batch.id),
        )
      : tasks;
    const usageByTaskId = new Map<string, FormattedBatchUsage>();
    if (usage && batchTasks.length === 1 && batchTasks[0]) {
      usageByTaskId.set(batchTasks[0].id, usage);
    } else if (usage?.raw && batchTasks.length > 1) {
      const allocations = allocateEstimatedTaskUsage(
        usage.raw,
        batchTasks.map((task) => ({
          id: task.id,
          categories: task.result?.classification?.categories,
          scale: task.result?.classification?.scale,
          changedFiles: task.result?.changedFiles,
        })),
      );
      batchTasks.forEach((task) => {
        const allocation = allocations[task.id];
        if (allocation)
          usageByTaskId.set(
            task.id,
            formatEstimatedTaskUsage(allocation, usage),
          );
      });
    } else if (usage && batchTasks.length > 1) {
      batchTasks.forEach((task) => usageByTaskId.set(task.id, usage));
    }
    if (batch && batchTasks.length > 1 && usage)
      cards.append(renderUsageLine(usage, "vip-batch-usage-detail"));
    orderedGroupTasks(groupData).forEach((task) =>
      cards.append(
        renderTaskCard(task, {
          completed: true,
          usage: usageByTaskId.get(task.id),
        }),
      ),
    );
    group.append(head, cards);
    return group;
  }

  function groupTasksByBatch(
    tasks: OverlayTask[],
    namespace: "progress" | "ready",
  ): OverlayTaskGroup[] {
    const batchById = new Map(currentBatches.map((batch) => [batch.id, batch]));
    const grouped = new Map<string, OverlayTask[]>();
    tasks.forEach((task) => {
      const key = task.batchId ?? `${namespace}:unbatched`;
      const group = grouped.get(key) ?? [];
      group.push(task);
      grouped.set(key, group);
    });
    return [...grouped.entries()]
      .map(([id, groupTasks]) => ({
        id,
        batch: batchById.get(id),
        tasks: groupTasks,
      }))
      .sort((left, right) =>
        (
          right.batch?.createdAt ??
          right.tasks[0]?.createdAt ??
          ""
        ).localeCompare(
          left.batch?.createdAt ?? left.tasks[0]?.createdAt ?? "",
        ),
      );
  }

  function autoExpandLatestUnratedReadyBatch(groups: OverlayTaskGroup[]): void {
    if (!readyAutoExpandPending || !groups.length) return;
    readyAutoExpandPending = false;
    const latestUnrated = groups.find(
      (group) =>
        !group.id.startsWith("ready:unbatched") &&
        group.tasks.some((task) => !task.rating),
    );
    if (!latestUnrated || autoExpandedReadyBatchIds.has(latestUnrated.id))
      return;
    expandedBatchIds.add(latestUnrated.id);
    autoExpandedReadyBatchIds.add(latestUnrated.id);
  }

  function appendEmpty(label: string): void {
    const empty = document.createElement("div");
    empty.className = "vip-empty";
    empty.textContent = label;
    taskList.append(empty);
  }

  function renderTaskPanel(): void {
    taskTabButtons.forEach((button) => {
      const selected = button.dataset.taskTab === activeTaskTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panelBody.setAttribute(
      "aria-label",
      activeTaskTab === "backlog"
        ? "Backlog"
        : activeTaskTab === "in-progress"
          ? "In progress"
          : "Ready",
    );
    progressControls.hidden = activeTaskTab !== "in-progress";
    taskList.replaceChildren();
    if (activeTaskTab === "backlog") {
      const tasks = orderedBacklogTasks();
      if (!tasks.length) appendEmpty("Backlog пуст.");
      else
        tasks.forEach((task) =>
          taskList.append(renderTaskCard(task, { deletable: true })),
        );
      return;
    }
    if (activeTaskTab === "in-progress") {
      const tasks = progressTasks();
      if (!tasks.length) appendEmpty("Нет задач в работе.");
      else
        groupTasksByBatch(tasks, "progress").forEach((group) =>
          taskList.append(renderProgressBatch(group)),
        );
      return;
    }
    const tasks = completedTasks();
    if (!tasks.length) {
      appendEmpty("Нет готовых задач.");
      return;
    }
    const groups = groupTasksByBatch(tasks, "ready");
    autoExpandLatestUnratedReadyBatch(groups);
    groups.forEach((group) => taskList.append(renderReadyBatch(group)));
  }

  async function loadTasks(): Promise<void> {
    try {
      const response = await apiFetch(`${apiBase}/tasks`);
      if (!response.ok) throw await responseError(response);
      allTasks = (await response.json()) as OverlayTask[];
      readyTasks = allTasks.filter((task) => task.status === "ready");
      updateTaskCount();
      renderTaskPanel();
      renderAnchors();
    } catch (error) {
      showToast(`Не удалось загрузить задачи: ${String(error)}`);
    }
  }
  function appendDetails(
    parent: HTMLElement,
    label: string,
    content: string,
  ): void {
    const details = document.createElement("details"),
      summary = document.createElement("summary"),
      pre = document.createElement("pre");
    summary.textContent = label;
    pre.textContent = content;
    details.append(summary, pre);
    parent.append(details);
  }
  async function loadRuntime(): Promise<void> {
    try {
      const [sessionResponse, batchesResponse, executionsResponse] =
        await Promise.all([
          apiFetch(`${apiBase}/session`),
          apiFetch(`${apiBase}/batches`),
          apiFetch(`${apiBase}/executions`),
        ]);
      if (!sessionResponse.ok) throw await responseError(sessionResponse);
      if (!batchesResponse.ok) throw await responseError(batchesResponse);
      if (!executionsResponse.ok) throw await responseError(executionsResponse);
      const session = (await sessionResponse.json()) as OverlaySession;
      currentSession = session;
      currentBatches = (await batchesResponse.json()) as OverlayBatch[];
      currentExecutions =
        (await executionsResponse.json()) as OverlayExecution[];
      updateTaskCount();
      renderTaskPanel();
      const connected =
        session.executor.kind === "codex" &&
        session.executor.status !== "disconnected";
      runtime.dataset.connected = String(connected);
      runtimeProject.textContent = session.displayName;
      runtimeProject.title = `Репозиторий: ${session.repository.name}`;
      const state: Record<string, string> = {
        connected: "подключён",
        busy: "в работе",
        needs_input: "нужен ответ",
        error: "ошибка",
        disconnected: "отключён",
      };
      const executorMode =
        session.executor.ownership === "visual-intent-owned"
          ? "автономный worker · статистика включена"
          : "связанный диалог";
      runtimeExecutor.textContent = connected
        ? `Codex · ${executorMode} · ${state[session.executor.status] ?? session.executor.status}`
        : "Codex · отключён";
      const batch = currentBatches.find(
        (candidate) => candidate.status !== "completed",
      );
      if (!batch) {
        lastBatch.hidden = true;
        approveDirtyButton.hidden = true;
        continuationInput.hidden = true;
        continuationInput.value = "";
        retryButton.hidden = true;
        return;
      }
      lastBatch.hidden = false;
      lastBatch.dataset.status = batch.status;
      const labels: Record<string, string> = {
        waiting_for_executor: "Ожидает Codex",
        queued: "В очереди",
        in_progress: "В работе",
        completed: "Готово",
        needs_input: "Нужен ответ",
        failed: "Ошибка выполнения",
      };
      const title = document.createElement("div");
      title.className = "vip-last-batch-title";
      title.textContent = `${labels[batch.status] ?? batch.status} · ${batch.taskIds.length}`;
      const copy = document.createElement("div");
      copy.className = "vip-last-batch-copy";
      const owned =
        batch.executorOwnership === "visual-intent-owned" ||
        session.executor.ownership === "visual-intent-owned";
      const statusCopy: Record<string, string> = {
        waiting_for_executor:
          session.executor.kind === "codex"
            ? "Пакет ждёт обработки в связанном диалоге Codex."
            : "Пакет ждёт подключения Codex к проекту.",
        queued: owned
          ? "Пакет поставлен в очередь автономного Codex worker. Статистика будет сохранена."
          : "Пакет поставлен в очередь Codex.",
        in_progress: owned
          ? `Автономный Codex worker выполняет пакет. Задач: ${batch.taskIds.length}. Статистика записывается.`
          : `Codex выполняет пакет. Задач: ${batch.taskIds.length}.`,
        needs_input: owned
          ? "Автономному Codex worker нужно уточнение. Ответьте ниже, чтобы продолжить тот же пакет."
          : "Codex ожидает уточнение. Ответьте ниже, чтобы продолжить нерешённые задачи пакета.",
        failed: owned
          ? "Автономное выполнение завершилось ошибкой. Пакет сохранён."
          : "Codex завершил пакет с ошибкой. Пакет сохранён.",
      };
      copy.textContent =
        batch.result?.summary ?? statusCopy[batch.status] ?? "";
      lastBatch.replaceChildren(title, copy);
      const dirty =
        batch.status === "needs_input" &&
        batch.result?.failureCode === "dirty_worktree_approval_required";
      const needsContinuation = batch.status === "needs_input" && !dirty;
      continuationInput.hidden = !needsContinuation;
      if (!needsContinuation) continuationInput.value = "";
      retryButton.textContent = needsContinuation
        ? "Отправить ответ и продолжить"
        : "Повторить пакет";
      const preExisting =
        batch.result?.preExistingDirtyFiles ??
        batch.workingTreeBaseline?.files.map((file) => file.path) ??
        [];
      if (preExisting.length)
        appendDetails(
          lastBatch,
          `Изменения до Apply · ${preExisting.length}`,
          preExisting.join("\n"),
        );
      const changed = batch.result?.batchChangedFiles ?? [];
      if (changed.length)
        appendDetails(
          lastBatch,
          `Изменено этим Apply · ${changed.length}`,
          changed.join("\n"),
        );
      if (batch.result?.technicalDetails)
        appendDetails(
          lastBatch,
          "Technical details",
          batch.result.technicalDetails,
        );
      const conflict =
        batch.result?.failureCode === "host_thread_active_writer" ||
        /already has an active writer|thread-store conflict/iu.test(
          batch.result?.technicalDetails ?? batch.result?.summary ?? "",
        );
      retryButton.hidden = !(
        (batch.status === "needs_input" && !dirty) ||
        (batch.status === "failed" &&
          (batch.result?.retryable === true || conflict))
      );
      retryButton.dataset.batchId = batch.id;
      const baseline = batch.workingTreeBaseline?.fingerprint;
      approveDirtyButton.hidden = !dirty || !baseline;
      approveDirtyButton.dataset.batchId = batch.id;
      if (baseline) approveDirtyButton.dataset.baselineFingerprint = baseline;
    } catch {
      currentSession = null;
      continuationInput.hidden = true;
      runtime.dataset.connected = "false";
      runtimeProject.textContent = "Visual Intent недоступен";
      runtimeExecutor.textContent = "отключён";
    }
  }

  function openApplyModal(): void {
    if (!readyTasks.length) return;
    const taskCount = document.createElement("span");
    taskCount.className = "vip-modal-count";
    taskCount.textContent = `${readyTasks.length} ${readyTasks.length === 1 ? "задачу" : "задачи"}`;
    const recipient =
      currentSession?.executor.kind === "codex" &&
      currentSession.executor.ownership === "visual-intent-owned"
        ? ` автономному Codex worker проекта «${currentSession.displayName}»?`
        : currentSession?.executor.kind === "codex"
          ? ` в связанный диалог «${currentSession.displayName}»?`
          : ` в очередь проекта «${currentSession?.displayName ?? "текущий проект"}»?`;
    modalCopy.replaceChildren(
      document.createTextNode("Отправить "),
      taskCount,
      document.createTextNode(recipient),
    );
    modalBackdrop.dataset.open = "true";
    modalBackdrop.setAttribute("aria-hidden", "false");
  }
  async function applyTasks(): Promise<void> {
    modalBackdrop.dataset.open = "false";
    modalBackdrop.setAttribute("aria-hidden", "true");
    if (!readyTasks.length) return;
    applyButton.disabled = true;
    try {
      const response = await apiFetch(`${apiBase}/tasks/apply`, {
        method: "POST",
      });
      if (!response.ok) throw await responseError(response);
      const result = (await response.json()) as {
        accepted: number;
        batch?: {
          status: string;
          executorOwnership?: "host-attached" | "visual-intent-owned";
        };
        session?: OverlaySession;
      };
      await Promise.all([loadTasks(), loadRuntime()]);
      const responseSession = result.session ?? currentSession;
      const owned =
        result.batch?.executorOwnership === "visual-intent-owned" ||
        responseSession?.executor.ownership === "visual-intent-owned";
      const projectName = responseSession?.displayName ?? "текущий проект";
      showToast(
        owned &&
          (result.batch?.status === "queued" ||
            result.batch?.status === "in_progress")
          ? `Автономный запуск начат. Передано задач: ${result.accepted}. Статистика включена.`
          : result.batch?.status === "waiting_for_executor" &&
              responseSession?.executor.kind === "codex"
            ? `В диалог «${projectName}» передано задач: ${result.accepted}. Ожидает Codex.`
            : `В очередь проекта «${projectName}» передано задач: ${result.accepted}.`,
      );
    } catch (error) {
      showToast(`Не удалось применить задачи: ${String(error)}`);
      updateTaskCount();
    }
  }
  async function retryBatch(): Promise<void> {
    const batchId = retryButton.dataset.batchId;
    if (!batchId) return;
    const answer = continuationInput.hidden
      ? undefined
      : continuationInput.value.trim();
    if (!continuationInput.hidden && !answer) {
      showToast("Сначала напишите ответ агенту");
      continuationInput.focus();
      return;
    }
    retryButton.disabled = true;
    try {
      const response = await apiFetch(
        `${apiBase}/batches/${encodeURIComponent(batchId)}/retry`,
        {
          method: "POST",
          ...(answer
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ answer }),
              }
            : {}),
        },
      );
      if (!response.ok) throw await responseError(response);
      continuationInput.value = "";
      await Promise.all([loadTasks(), loadRuntime()]);
      showToast("Пакет снова поставлен в очередь");
    } catch (error) {
      showToast(`Не удалось повторить пакет: ${String(error)}`);
    } finally {
      retryButton.disabled = false;
    }
  }
  async function approveDirtyBatch(
    source: "overlay" | "project-settings" = "overlay",
  ): Promise<void> {
    const batchId = approveDirtyButton.dataset.batchId,
      expectedBaselineFingerprint =
        approveDirtyButton.dataset.baselineFingerprint;
    if (!batchId || !expectedBaselineFingerprint) return;
    approveDirtyButton.disabled = true;
    try {
      const response = await apiFetch(
        `${apiBase}/batches/${encodeURIComponent(batchId)}/approve-dirty`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedBaselineFingerprint,
            source,
          }),
        },
      );
      if (!response.ok) throw await responseError(response);
      const result = (await response.json()) as { approved: boolean };
      await Promise.all([loadTasks(), loadRuntime()]);
      showToast(
        result.approved
          ? "Продолжение подтверждено"
          : "Список изменений обновился — проверьте его ещё раз",
      );
    } catch (error) {
      showToast(`Не удалось подтвердить продолжение: ${String(error)}`);
    } finally {
      approveDirtyButton.disabled = false;
    }
  }

  function setTheme(theme: "light" | "dark"): void {
    shell.dataset.theme = theme;
    localStorage.setItem("visual-intent-theme", theme);
    themeOptions.forEach((button) => {
      button.dataset.selected = String(button.dataset.themeValue === theme);
    });
  }

  function syncSettingsUi(): void {
    const theme = shell.dataset.theme === "dark" ? "dark" : "light";
    themeOptions.forEach((button) => {
      button.dataset.selected = String(button.dataset.themeValue === theme);
    });
    policyOptions.forEach((button) => {
      button.dataset.selected = String(
        button.dataset.policyValue === currentSettings?.dirtyWorktreePolicy,
      );
      button.disabled = currentSettings === null;
    });
  }

  function closeSettings(): void {
    settingsBackdrop.dataset.open = "false";
    settingsBackdrop.setAttribute("aria-hidden", "true");
  }

  async function loadSettings(): Promise<void> {
    policyOptions.forEach((button) => (button.disabled = true));
    try {
      const response = await apiFetch(`${apiBase}/settings`);
      if (!response.ok) throw await responseError(response);
      currentSettings = (await response.json()) as OverlayProjectSettings;
      syncSettingsUi();
    } catch (error) {
      currentSettings = null;
      syncSettingsUi();
      showToast(`Не удалось загрузить настройки: ${String(error)}`);
    }
  }

  function openSettings(): void {
    setPanelOpen(false);
    tooltip.dataset.visible = "false";
    settingsBackdrop.dataset.open = "true";
    settingsBackdrop.setAttribute("aria-hidden", "false");
    syncSettingsUi();
    void loadSettings();
  }

  async function updateDirtyWorktreePolicy(
    dirtyWorktreePolicy: DirtyWorktreePolicy,
  ): Promise<void> {
    if (!currentSettings) return;
    policyOptions.forEach((button) => (button.disabled = true));
    try {
      const response = await apiFetch(`${apiBase}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: currentSettings.revision,
          dirtyWorktreePolicy,
        }),
      });
      if (!response.ok) throw await responseError(response);
      currentSettings = (await response.json()) as OverlayProjectSettings;
      syncSettingsUi();
      showToast("Настройка сохранена");
      if (
        dirtyWorktreePolicy === "allow-host-attached" &&
        currentSession?.executor.kind === "codex" &&
        currentSession.executor.ownership === "host-attached" &&
        !approveDirtyButton.hidden
      ) {
        await approveDirtyBatch("project-settings");
      }
    } catch (error) {
      showToast(`Не удалось сохранить настройку: ${String(error)}`);
      await loadSettings();
    }
  }

  function activate(next: Mode): void {
    palette.dataset.open = "false";
    if (mode === next) enterNeutralMode();
    else setMode(next);
    setPanelOpen(false);
  }
  required<HTMLButtonElement>("[data-action='select']").addEventListener(
    "click",
    () => activate("select"),
  );
  required<HTMLButtonElement>("[data-action='pencil']").addEventListener(
    "click",
    () => activate("pencil"),
  );
  required<HTMLButtonElement>("[data-action='square']").addEventListener(
    "click",
    () => activate("square"),
  );
  required<HTMLButtonElement>("[data-action='frame']").addEventListener(
    "click",
    () => activate("frame"),
  );
  required<HTMLButtonElement>("[data-action='figma']").addEventListener(
    "click",
    () => activate("figma"),
  );
  required<HTMLButtonElement>("[data-action='screenshot']").addEventListener(
    "click",
    () => void beginScreenshot(),
  );
  clearButton.addEventListener("click", clearDrawings);
  undoButton.addEventListener("click", () => void runHistory("undo"));
  redoButton.addEventListener("click", () => void runHistory("redo"));
  required<HTMLButtonElement>("[data-action='color']").addEventListener(
    "click",
    () => {
      palette.dataset.open = palette.dataset.open === "true" ? "false" : "true";
    },
  );
  tasksButton.addEventListener("click", () => {
    const open = panel.dataset.open !== "true";
    setPanelOpen(open);
    if (open) void Promise.all([loadTasks(), loadRuntime()]);
  });
  panelCloseButton.addEventListener("click", () => setPanelOpen(false));
  panelClearButton.addEventListener("click", () => void clearBacklog());
  panelApplyButton.addEventListener("click", openApplyModal);
  taskTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.taskTab as TaskTab | undefined;
      if (!tab) return;
      setTaskTab(tab);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const buttons = [...taskTabButtons];
      const index = buttons.indexOf(button);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next =
        buttons[(index + direction + buttons.length) % buttons.length];
      const tab = next?.dataset.taskTab as TaskTab | undefined;
      if (!next || !tab) return;
      setTaskTab(tab);
      next.focus();
    });
  });
  applyButton.addEventListener("click", openApplyModal);
  approveDirtyButton.addEventListener("click", () => void approveDirtyBatch());
  retryButton.addEventListener("click", () => void retryBatch());
  required<HTMLButtonElement>("[data-action='settings']").addEventListener(
    "click",
    openSettings,
  );
  saveButton.addEventListener("click", () => void saveTask());
  required<HTMLButtonElement>(
    "[data-composer-action='attach-menu']",
  ).addEventListener("click", () => {
    attachmentMenu.dataset.open =
      attachmentMenu.dataset.open === "true" ? "false" : "true";
  });
  required<HTMLButtonElement>(
    "[data-composer-action='screenshot']",
  ).addEventListener("click", () => void beginScreenshot());
  required<HTMLButtonElement>(
    "[data-composer-action='upload']",
  ).addEventListener("click", () => {
    attachmentMenu.dataset.open = "false";
    fileInput.click();
  });
  fileInput.addEventListener("change", () => void attachFiles(fileInput.files));
  textarea.addEventListener("input", () => {
    if (redoStack.length > 0) {
      redoStack.length = 0;
      updateHistoryButtons();
    }
    syncComposerLayout();
  });
  window.addEventListener(
    "paste",
    (event) => {
      if (
        composer.dataset.open !== "true" ||
        composer.hidden ||
        shadow.activeElement !== textarea
      )
        return;
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void attachFiles(files);
    },
    true,
  );
  composer.addEventListener("dragstart", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".vip-attachment")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  composer.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    composerDragDepth += 1;
    composer.dataset.dragActive = "true";
  });
  composer.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    event.dataTransfer.dropEffect = "copy";
  });
  composer.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    composerDragDepth = Math.max(0, composerDragDepth - 1);
    if (composerDragDepth === 0) composer.dataset.dragActive = "false";
  });
  composer.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    composerDragDepth = 0;
    composer.dataset.dragActive = "false";
    void attachFiles(event.dataTransfer?.files ?? null);
  });
  shadow.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      !target?.closest(
        ".vip-attachment-menu,[data-composer-action='attach-menu']",
      )
    )
      attachmentMenu.dataset.open = "false";
  });
  required<HTMLButtonElement>("[data-modal-action='cancel']").addEventListener(
    "click",
    () => {
      modalBackdrop.dataset.open = "false";
      modalBackdrop.setAttribute("aria-hidden", "true");
    },
  );
  required<HTMLButtonElement>("[data-modal-action='confirm']").addEventListener(
    "click",
    () => void applyTasks(),
  );
  required<HTMLButtonElement>(
    "[data-settings-action='close']",
  ).addEventListener("click", closeSettings);
  settingsBackdrop.addEventListener("click", (event) => {
    if (event.target === settingsBackdrop) closeSettings();
  });
  themeOptions.forEach((button) => {
    button.addEventListener("click", () => {
      const theme = button.dataset.themeValue;
      if (theme === "light" || theme === "dark") setTheme(theme);
    });
  });
  policyOptions.forEach((button) => {
    button.addEventListener("click", () => {
      const policy = button.dataset.policyValue;
      if (policy === "allow-host-attached" || policy === "require-confirmation")
        void updateDirtyWorktreePolicy(policy);
    });
  });
  required<HTMLButtonElement>("[data-crop-action='cancel']").addEventListener(
    "click",
    cancelScreenshot,
  );
  required<HTMLButtonElement>("[data-crop-action='capture']").addEventListener(
    "click",
    () => void captureScreenshot(),
  );

  widthInput.addEventListener("input", () => {
    drawWidth = Math.max(1, Math.min(10, Number(widthInput.value) || 2));
    widthValue.textContent = String(drawWidth);
  });
  for (const color of colors) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.background = color;
    button.title = color;
    button.addEventListener("click", () => {
      drawColor = color;
      colorDot.style.setProperty("--draw-color", color);
      palette.dataset.open = "false";
    });
    palette.append(button);
  }
  colorDot.style.setProperty("--draw-color", drawColor);
  const storedTheme = localStorage.getItem("visual-intent-theme");
  setTheme(storedTheme === "dark" ? "dark" : "light");

  toolbar.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button,input,.vip-palette")) return;
    const start = { x: event.clientX, y: event.clientY },
      rect = toolbar.getBoundingClientRect();
    toolbar.dataset.dragging = "true";
    toolbar.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      toolbar.style.left = `${Math.max(8, Math.min(rect.left + moveEvent.clientX - start.x, innerWidth - toolbar.offsetWidth - 8))}px`;
      toolbar.style.top = `${Math.max(8, Math.min(rect.top + moveEvent.clientY - start.y, innerHeight - toolbar.offsetHeight - 8))}px`;
    };
    const up = (upEvent: PointerEvent): void => {
      toolbar.dataset.dragging = "false";
      toolbar.releasePointerCapture(upEvent.pointerId);
      toolbar.removeEventListener("pointermove", move);
      toolbar.removeEventListener("pointerup", up);
      localStorage.setItem(
        "visual-intent-toolbar-position",
        JSON.stringify({ left: toolbar.offsetLeft, top: toolbar.offsetTop }),
      );
    };
    toolbar.addEventListener("pointermove", move);
    toolbar.addEventListener("pointerup", up);
    event.preventDefault();
  });
  function restoreToolbarPosition(): void {
    try {
      const raw = localStorage.getItem("visual-intent-toolbar-position"),
        saved = raw ? (JSON.parse(raw) as { left: number; top: number }) : null;
      const left = saved?.left ?? (innerWidth - toolbar.offsetWidth) / 2,
        top = saved?.top ?? 18;
      toolbar.style.left = `${Math.max(8, Math.min(left, innerWidth - toolbar.offsetWidth - 8))}px`;
      toolbar.style.top = `${Math.max(8, Math.min(top, innerHeight - toolbar.offsetHeight - 8))}px`;
    } catch {
      toolbar.style.left = `${Math.max(8, (innerWidth - toolbar.offsetWidth) / 2)}px`;
    }
  }

  shadow.addEventListener("pointerover", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-tooltip]")
        : null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    required<HTMLElement>(".vip-tooltip span").textContent =
      target.dataset.tooltip ?? "";
    const shortcut = required<HTMLElement>(".vip-tooltip kbd");
    shortcut.textContent = target.dataset.shortcut ?? "";
    shortcut.hidden = !target.dataset.shortcut;
    tooltip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2, innerWidth - 110))}px`;
    tooltip.style.top = `${Math.min(innerHeight - 42, rect.bottom + 8)}px`;
    tooltip.style.transform = "translateX(-50%)";
    tooltip.dataset.visible = "true";
  });
  shadow.addEventListener("pointerout", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-tooltip]")
    )
      tooltip.dataset.visible = "false";
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveTask();
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null,
        shadowFocused = shadow.activeElement,
        editing = Boolean(
          target?.closest("input,textarea,[contenteditable='true']") ||
            shadowFocused instanceof HTMLInputElement ||
            shadowFocused instanceof HTMLTextAreaElement ||
            (shadowFocused instanceof HTMLElement &&
              shadowFocused.isContentEditable),
        );
      if (event.key === "Escape") {
        if (settingsBackdrop.dataset.open === "true") closeSettings();
        else if (modalBackdrop.dataset.open === "true") {
          modalBackdrop.dataset.open = "false";
          modalBackdrop.setAttribute("aria-hidden", "true");
        } else if (cropLayer.dataset.open === "true") cancelScreenshot();
        else if (composer.dataset.open === "true") cancelComposerDraft();
        else if (panel.dataset.open === "true") setPanelOpen(false);
        else if (mode !== "idle") enterNeutralMode();
        else return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      if (
        !editing &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        void runHistory(event.shiftKey ? "redo" : "undo");
        return;
      }
      if (!editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "s" && event.shiftKey) {
          event.preventDefault();
          void beginScreenshot();
          return;
        }
        if (event.shiftKey) return;
        const next = (
          {
            v: "select",
            p: "pencil",
            r: "square",
            f: "frame",
          } as Record<string, Mode>
        )[key];
        if (next) {
          event.preventDefault();
          activate(next);
        }
      }
    },
    true,
  );

  function refreshPositions(): void {
    renderDrawings();
    if (hoveredInspectionElement && (mode === "select" || mode === "figma")) {
      const hoveredRect = hoveredInspectionElement.getBoundingClientRect();
      displayRect(highlight, hoveredRect);
      showElementInspector(hoveredInspectionElement, hoveredRect);
    }
    const rect = currentTargetRect();
    if (rect && targetContext) {
      targetContext.rect = rect;
      if (targetContext.element)
        displayRect(highlight, surfaceToViewport(rect));
      else displayRect(frameBox, surfaceToViewport(rect));
      if (composer.dataset.open === "true" && !composer.hidden) {
        const placementRect = currentComposerPlacementRect();
        if (placementRect) positionComposer(surfaceToViewport(placementRect));
      }
    }
    renderAnchors();
  }
  function connectSocket(): void {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}/_visual-intent/ws?token=${encodeURIComponent(apiToken)}`,
    );
    socket.addEventListener("message", () => {
      void loadTasks();
      void loadRuntime();
    });
    socket.addEventListener("close", () => setTimeout(connectSocket, 1500));
  }
  addEventListener("resize", () => {
    restoreToolbarPosition();
    refreshPositions();
    if (cropLayer.dataset.open === "true") renderCrop();
  });
  document.addEventListener("scroll", refreshPositions, true);
  requestAnimationFrame(restoreToolbarPosition);
  renderDrawings();
  updateTaskCount();
  void loadTasks();
  void loadRuntime();
  connectSocket();
}

export function createOverlayScript(
  options: { apiToken?: string } = {},
): string {
  const allocator = allocateEstimatedTaskUsage.toString();
  const source = bootOverlay
    .toString()
    .replace(
      '"__VISUAL_INTENT_TOKEN__"',
      JSON.stringify(options.apiToken ?? ""),
    )
    .replace(
      '"__VISUAL_INTENT_ICONS__"',
      JSON.stringify(JSON.stringify(ICONS)),
    );
  return `;(()=>{const allocateEstimatedTaskUsage=${allocator};(${source})();})();`;
}
