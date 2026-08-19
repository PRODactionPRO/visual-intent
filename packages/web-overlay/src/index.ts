import { ICONS } from "./icon-data.js";

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
  type OverlayTask = {
    id: string;
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
    workingTreeBaseline?: {
      fingerprint: string;
      files: Array<{ path: string; status: string }>;
    };
    result?: {
      summary: string;
      batchChangedFiles?: string[];
      preExistingDirtyFiles?: string[];
      technicalDetails?: string;
      retryable?: boolean;
      failureCode?: string;
    };
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
    .vip-panel{pointer-events:auto;position:absolute;top:98px;right:18px;display:none;width:min(420px,calc(100vw - 36px));max-height:calc(100vh - 118px);overflow:auto;padding:14px;border:1px solid var(--border);border-radius:18px;background:var(--bg);box-shadow:var(--shadow)}.vip-panel[data-open=true]{display:block}.vip-panel-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:16px;font-weight:780}.vip-panel-subtitle{margin-bottom:10px;color:var(--muted);font-size:12px}
    .vip-runtime{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;margin-bottom:10px;padding:9px 10px;border:1px solid var(--border);border-radius:11px;background:var(--soft)}.vip-runtime-dot{width:8px;height:8px;border-radius:999px;background:#f59e0b}.vip-runtime[data-connected=true] .vip-runtime-dot{background:#22c55e}.vip-runtime-project{min-width:0;overflow:hidden;font-size:12px;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.vip-runtime-executor{color:var(--muted);font-size:11px}
    .vip-last-batch{margin-bottom:10px;padding:9px 10px;border-radius:10px;background:rgba(30,143,241,.1);font-size:11px}.vip-last-batch[data-status=failed],.vip-last-batch[data-status=needs_input]{background:rgba(220,38,38,.1)}.vip-last-batch-title{font-weight:800}.vip-last-batch-copy{margin-top:3px}.vip-last-batch details{margin-top:7px}.vip-last-batch summary{cursor:pointer}.vip-last-batch pre{max-height:170px;overflow:auto;margin:6px 0 0;padding:7px;border-radius:7px;background:var(--soft);font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
    .vip-wide{width:100%;margin:0 0 10px;padding:9px 11px;border-radius:10px;background:var(--blue);color:#fff;cursor:pointer}.vip-wide[hidden]{display:none}.vip-approve-dirty{background:#fbbf24;color:#422006}.vip-task{margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:11px;background:var(--soft)}.vip-task-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.vip-task-status{display:flex;align-items:center;gap:6px;color:#16803c;font-size:11px;font-weight:800;text-transform:uppercase}.vip-task-status .vip-icon{width:11px;height:16px}.vip-task-copy{width:100%;margin-top:6px;padding:0;background:transparent;color:var(--text);cursor:pointer;font-weight:500;text-align:left;white-space:pre-wrap}.vip-task-actions{display:flex;justify-content:flex-end;gap:5px;margin-top:8px}.vip-task-actions button{padding:6px 8px;border-radius:8px;background:transparent;color:var(--text);cursor:pointer}.vip-task-actions button:hover{background:var(--border)}.vip-task-actions .vip-danger{color:var(--danger)}.vip-empty{color:var(--muted);padding:16px 2px 10px;text-align:center}
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
    <section class="vip-panel" aria-label="Visual tasks"><div class="vip-panel-header"><span>Задачи</span><span class="vip-panel-count">0</span></div><div class="vip-panel-subtitle">Активная итерация правок до нажатия Apply.</div><div class="vip-runtime"><span class="vip-runtime-dot"></span><span class="vip-runtime-project">Загрузка проекта…</span><span class="vip-runtime-executor">disconnected</span></div><div class="vip-last-batch" hidden></div><button class="vip-wide vip-approve-dirty" hidden>Продолжить поверх текущих изменений</button><button class="vip-wide vip-retry" hidden>Повторить пакет</button><div class="vip-task-list"></div></section>
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
  const taskBadge = required<HTMLElement>(".vip-task-badge");
  const panelCount = required<HTMLElement>(".vip-panel-count");
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
  let composerPlacementRect: Rect | null = null;
  let readyTasks: OverlayTask[] = [];
  let currentSession: OverlaySession | null = null;
  let currentSettings: OverlayProjectSettings | null = null;
  let toastTimer: number | undefined;
  let historyBusy = false;
  let composerDragDepth = 0;
  let hoveredInspectionElement: Element | null = null;
  const undoStack: HistoryCommand[] = [];
  const redoStack: HistoryCommand[] = [];
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
    saveButton.hidden = !(hasText || draftKind === "figma-component");
    const rect = currentComposerPlacementRect();
    if (rect && composer.dataset.open === "true" && !composer.hidden)
      positionComposer(surfaceToViewport(rect));
  }

  function setPanelOpen(open: boolean): void {
    panel.dataset.open = String(open);
    tasksButton.dataset.active = String(open);
    tasksButton.setAttribute("aria-pressed", String(open));
  }

  function openComposer(
    target: TargetContext,
    kind: TaskKind,
    options: { editingTask?: OverlayTask; placementRect?: Rect } = {},
  ): void {
    targetContext = target;
    draftKind = kind;
    editingTask = options.editingTask ? clone(options.editingTask) : null;
    composerPlacementRect = options.placementRect
      ? { ...options.placementRect }
      : null;
    composer.dataset.editing = String(Boolean(editingTask));
    composer.setAttribute(
      "aria-label",
      editingTask ? "Редактирование задачи" : "Новая задача",
    );
    saveButton.dataset.tooltip = editingTask
      ? "Сохранить изменения"
      : "Добавить в задачи";
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
    composerPlacementRect = null;
    composer.dataset.editing = "false";
    composer.setAttribute("aria-label", "Новая задача");
    saveButton.dataset.tooltip = "Добавить в задачи";
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
    const count = readyTasks.length;
    taskBadge.textContent = String(count);
    taskBadge.dataset.visible = String(count > 0);
    panelCount.textContent = String(count);
    applyButton.disabled = count === 0;
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

  function openTaskComposer(task: OverlayTask, anchor?: HTMLElement): void {
    const target = targetContextFromTask(task);
    if (!target) {
      showToast("У задачи не сохранилась область на странице");
      return;
    }
    setMode("idle");
    textarea.value = task.intent.instruction;
    draftAttachments = clone(task.attachments);
    renderAttachments();
    openComposer(target, task.kind, {
      editingTask: task,
      placementRect: anchorPlacementRect(target, anchor),
    });
    const rect = surfaceToViewport(target.rect);
    if (target.element) {
      displayRect(frameBox, null);
      displayRect(highlight, rect);
    } else {
      displayRect(highlight, null);
      displayRect(frameBox, rect);
    }
  }

  function renderAnchors(): void {
    anchorLayer.replaceChildren();
    readyTasks.forEach((task, index) => {
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
      if (task.kind === "figma-component") {
        anchor.append(createIconElement("figma"));
      } else anchor.textContent = String(index + 1);
      anchor.addEventListener("click", () => openTaskComposer(task, anchor));
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
  async function saveTask(): Promise<void> {
    const instruction = textarea.value.trim();
    if (!currentTargetRect()) {
      showToast("Сначала выберите элемент или область");
      return;
    }
    if (!instruction && draftKind !== "figma-component") {
      showToast("Опишите, что нужно изменить");
      textarea.focus();
      return;
    }
    const taskBeingEdited = editingTask ? clone(editingTask) : null;
    const payload = taskBeingEdited ? null : buildTaskPayload(instruction);
    if (!taskBeingEdited && !payload) return;
    const button = required<HTMLButtonElement>("[data-composer-action='save']");
    button.disabled = true;
    try {
      if (taskBeingEdited) {
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

  function renderTask(task: OverlayTask): HTMLElement {
    const item = document.createElement("article");
    item.className = "vip-task";
    item.dataset.taskId = task.id;
    const head = document.createElement("div");
    head.className = "vip-task-head";
    const status = document.createElement("div");
    status.className = "vip-task-status";
    if (task.kind === "figma-component") {
      status.append(createIconElement("figma"));
    }
    status.append(document.createTextNode(task.status.replaceAll("_", " ")));
    const shortId = document.createElement("span");
    shortId.textContent = task.id.slice(0, 8);
    shortId.title = task.id;
    head.append(status, shortId);
    const copy = document.createElement("button");
    copy.className = "vip-task-copy";
    copy.textContent =
      task.intent.instruction || "Собрать выбранный компонент в Figma";
    const actions = document.createElement("div");
    actions.className = "vip-task-actions";
    const edit = document.createElement("button");
    edit.textContent = "Изменить";
    const remove = document.createElement("button");
    remove.className = "vip-danger";
    remove.textContent = "Удалить";
    actions.append(edit, remove);
    const openEditor = (): void => {
      const anchor = anchorLayer.querySelector<HTMLElement>(
        `[data-task-id="${CSS.escape(task.id)}"]`,
      );
      openTaskComposer(task, anchor ?? undefined);
    };
    copy.addEventListener("click", openEditor);
    edit.addEventListener("click", openEditor);
    remove.addEventListener(
      "click",
      () =>
        void (async () => {
          remove.disabled = true;
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
            showToast("Задача удалена");
          } catch (error) {
            showToast(`Не удалось удалить задачу: ${String(error)}`);
            remove.disabled = false;
          }
        })(),
    );
    item.append(head, copy, actions);
    return item;
  }

  async function loadTasks(): Promise<void> {
    try {
      const response = await apiFetch(`${apiBase}/tasks?status=ready`);
      if (!response.ok) throw await responseError(response);
      readyTasks = (await response.json()) as OverlayTask[];
      updateTaskCount();
      taskList.replaceChildren();
      if (!readyTasks.length) {
        const empty = document.createElement("div");
        empty.className = "vip-empty";
        empty.textContent = "Нет задач, ожидающих Apply.";
        taskList.append(empty);
      } else readyTasks.forEach((task) => taskList.append(renderTask(task)));
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
      const [sessionResponse, batchesResponse] = await Promise.all([
        apiFetch(`${apiBase}/session`),
        apiFetch(`${apiBase}/batches`),
      ]);
      if (!sessionResponse.ok) throw await responseError(sessionResponse);
      if (!batchesResponse.ok) throw await responseError(batchesResponse);
      const session = (await sessionResponse.json()) as OverlaySession;
      currentSession = session;
      const batches = (await batchesResponse.json()) as OverlayBatch[];
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
      runtimeExecutor.textContent = connected
        ? `Codex · ${session.executor.ownership === "visual-intent-owned" ? "изолированный · " : ""}${state[session.executor.status] ?? session.executor.status}`
        : "Codex · отключён";
      const batch = batches[0];
      if (!batch) {
        lastBatch.hidden = true;
        approveDirtyButton.hidden = true;
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
      copy.textContent =
        batch.status === "failed"
          ? "Не удалось передать задачи в Codex. Пакет сохранён, изменения не применялись."
          : batch.status === "waiting_for_executor"
            ? "Ожидает обработки подключённой задачей Codex."
            : (batch.result?.summary ?? "");
      lastBatch.replaceChildren(title, copy);
      const dirty =
        batch.status === "needs_input" &&
        batch.result?.failureCode === "dirty_worktree_approval_required";
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
    modalCopy.replaceChildren(
      document.createTextNode("Отправить "),
      taskCount,
      document.createTextNode(
        ` в диалог «${currentSession?.displayName ?? "текущий диалог Codex"}»?`,
      ),
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
        batch?: { status: string };
      };
      await Promise.all([loadTasks(), loadRuntime()]);
      showToast(
        result.batch?.status === "waiting_for_executor"
          ? `Передано задач: ${result.accepted}. Ожидает Codex.`
          : `Передано задач: ${result.accepted}`,
      );
    } catch (error) {
      showToast(`Не удалось применить задачи: ${String(error)}`);
      updateTaskCount();
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
    if (open) void loadTasks();
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
  return `;(${source})();`;
}
