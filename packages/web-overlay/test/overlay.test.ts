import { describe, expect, it } from "vitest";

import { createOverlayScript } from "../src/index.js";

describe("createOverlayScript", () => {
  it("returns an injectable self-contained script", () => {
    const script = createOverlayScript();

    expect(script).toContain("visual-intent-overlay-root");
    expect(script).toContain("Добавить в задачи");
    expect(script).toContain("tasks?status=ready");
    expect(script).toContain("tasks/apply");
    expect(script).toContain('method: "DELETE"');
    expect(script).toContain("Ожидает Codex");
    expect(script).toContain("изолированный");
    expect(script).toContain(
      "Не удалось передать задачи в Codex. Пакет сохранён, изменения не применялись.",
    );
    expect(script).toContain("Technical details");
    expect(script).toContain("batch.result?.retryable === true");
    expect(script).toContain("dirty_worktree_approval_required");
    expect(script).toContain("approve-dirty");
    expect(script).toContain("Продолжить поверх текущих изменений");
    expect(script).toContain("Изменено этим Apply");
    expect(script).toContain("!readyTasks.length");
    expect(script).toContain("figma-component");
    expect(script).toContain('data-action="settings"');
    expect(script).toContain(
      'data-action="tasks" data-tooltip="Список задач" data-select-only aria-pressed="false"',
    );
    expect(script).toContain("tasksButton.dataset.active = String(open)");
    expect(script).toContain(
      'tasksButton.setAttribute("aria-pressed", String(open))',
    );
    expect(script).toContain(
      'anchor.addEventListener("click", () => openTaskComposer(task, anchor))',
    );
    expect(script).toContain("function openTaskComposer(task, anchor)");
    expect(script).toContain("currentComposerPlacementRect()");
    expect(script).toContain('editingTask ? "Сохранить изменения"');
    expect(script).toContain("updateReadyTask(");
    expect(script).toContain("attachments,");
    expect(script).not.toContain("vip-task-editor");
    expect(script).toContain('class="vip-settings-backdrop"');
    expect(script).toContain("Оформление");
    expect(script).toContain("Работа с изменениями");
    expect(script).toContain("Передавать сразу");
    expect(script).toContain("Спрашивать подтверждение");
    expect(script).toContain('data-policy-value="allow-host-attached"');
    expect(script).toContain('data-policy-value="require-confirmation"');
    expect(script).toContain("apiFetch(`${apiBase}/settings`)");
    expect(script).toContain('method: "PATCH"');
    expect(script).toContain('await approveDirtyBatch("project-settings")');
    expect(script).toContain(
      ".vip-shell[data-theme=dark] .vip-settings-backdrop",
    );
    expect(script).not.toContain('data-action="theme"');
    expect(script).toContain(
      'saveButton.hidden = !(hasText || draftKind === "figma-component")',
    );
    expect(script).toContain(
      'if (!instruction && draftKind !== "figma-component")',
    );
    expect(script).toContain(
      ".vip-composer[data-kind=figma-component][data-multiline=true] .vip-kind{display:flex;margin-right:auto}",
    );
    expect(script).not.toContain(
      "[data-kind=figma-component][data-multiline=true] .vip-composer-actions{align-self:auto;justify-content:space-between",
    );
    expect(script).toContain("Прямоугольник");
    expect(script).toContain("Можно прикрепить не больше трёх файлов");
    expect(script).toContain("visual-intent-toolbar-position");
    expect(script).toContain("height:51px");
    expect(script).toContain("width:32px;height:32px");
    expect(script).toContain("vip-icon");
    expect(script).toContain("data-icon-source");
    expect(script).toContain("currentColor");
    expect(script).not.toContain('preserveAspectRatio="none"');
    expect(script).not.toContain("strokke=");
    expect(script).not.toContain("stroke-lineap=");
    expect(script).toContain('placeholder="Type a comment..."');
    expect(script).toContain('data-composer-action="attach-menu"');
    expect(script).toContain('data-composer-action="upload"');
    expect(script).toContain("Перетащите сюда и отпустите изображение");
    expect(script).toContain('window.addEventListener("paste"');
    expect(script).toContain("shadow.activeElement !== textarea");
    expect(script).toContain("image.draggable = false");
    expect(script).toContain('composer.addEventListener("drop"');
    expect(script).not.toContain("min-height:207px");
    expect(script).toContain(
      ".vip-composer-button.vip-save,.vip-composer-button.vip-save:hover",
    );
    expect(script).toContain(
      ".vip-shell[data-theme=dark] .vip-apply:not(:disabled){background:var(--blue)!important}",
    );
    expect(script).toContain(".vip-modal-count{color:var(--blue)");
    expect(script).toContain(".vip-modal .vip-actions{display:flex");
    expect(script).toContain("gap:8px");
    expect(script).toContain(
      ".vip-modal button.vip-confirm,.vip-modal button.vip-confirm:hover{background:var(--blue);color:#fff}",
    );
    expect(script).toContain('taskCount.className = "vip-modal-count"');
    expect(script).toContain("modalCopy.replaceChildren(");
    expect(script).toContain(
      ".vip-apply:disabled{background:#c0c0c0!important",
    );
    expect(script).toContain("navigator.mediaDevices?.getDisplayMedia");
    expect(script).toContain("preferCurrentTab: true");
    expect(script).toContain('shell.dataset.capturing = "true"');
    expect(script).toContain("positionCropActions");
    expect(script).toContain("x: Math.max(0");
    expect(script).toContain("y: Math.max(0");
    expect(script).toContain("--scroll-thumb:#aeb3ba");
    expect(script).toContain("scrollbar-color:var(--scroll-thumb) transparent");
    expect(script).toContain(
      "::-webkit-scrollbar-track,.vip-shell *::-webkit-scrollbar-corner{background:transparent}",
    );
    expect(script).toContain(
      "::-webkit-scrollbar-thumb{border-radius:999px;background:var(--scroll-thumb)}",
    );
    expect(script).not.toContain("scrollbar-width:");
    expect(script).toContain(
      '<div class="vip-crop-actions"><button data-crop-action="cancel">',
    );
    expect(script).not.toContain(
      '<div class="vip-crop"><div class="vip-crop-actions">',
    );
    expect(script).toContain("foreignObjectRendering: true");
    expect(script).toContain("normalizeScreenshotClone");
    expect(script).toContain("normalizePageColorsForCapture");
    expect(script).toContain("⇧⌘Z");
    expect(script).toContain('data-shortcut="⇧S"');
    expect(script).not.toContain('data-shortcut="S"');
    expect(script).toContain("shadow.activeElement");
    expect(script).toContain("shadowFocused instanceof HTMLTextAreaElement");
    expect(script).toContain('if (key === "s" && event.shiftKey)');
    expect(script).not.toContain('s: "screenshot"');
    expect(script).not.toContain("setPanelOpen(true)");
    expect(script).toContain("Режим просмотра");
    expect(script).toContain("cancelComposerDraft");
    expect(script).toContain("restoreComposerDraft");
    expect(script).toContain('else if (mode !== "idle") enterNeutralMode()');
    expect(script).toContain("event.stopImmediatePropagation()");
    expect(script).not.toContain('class="vip-target"');
    expect(script).not.toContain("vip-task-target");
    expect(script).not.toContain("import ");
  });

  it("mounts controls into a viewport-sized pointer-safe shadow host", () => {
    const script = createOverlayScript();

    expect(script).toContain('position: "fixed"');
    expect(script).toContain('"z-index": "2147483647"');
    expect(script).toContain('"pointer-events": "none"');
    expect(script).toContain(
      ":host{all:initial!important;position:fixed!important;inset:0!important;display:block!important;",
    );
    expect(script).toContain(".vip-shell{");
    expect(script).toContain("position:absolute;inset:0;pointer-events:none");
    expect(script).toContain(".vip-toolbar{pointer-events:auto;");
    expect(script).toContain(".vip-composer{pointer-events:auto;");
    expect(script).toContain(".vip-panel{pointer-events:auto;");
  });
});
