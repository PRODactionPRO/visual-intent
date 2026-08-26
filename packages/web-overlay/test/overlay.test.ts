import { describe, expect, it } from "vitest";

import { createOverlayScript } from "../src/index.js";

describe("createOverlayScript", () => {
  it("returns an injectable self-contained script", () => {
    const script = createOverlayScript();

    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("visual-intent-overlay-root");
    expect(script).toContain("Добавить в задачи");
    expect(script).toContain("apiFetch(`${apiBase}/tasks`)");
    expect(script).toContain("tasks/apply");
    expect(script).toContain("apiFetch(`${apiBase}/executions`)");
    expect(script).toContain("/review");
    expect(script).toContain('method: "DELETE"');
    expect(script).toContain("Ожидает Codex");
    expect(script).toContain("автономный worker · статистика включена");
    expect(script).toContain("связанный диалог");
    expect(script).toContain(
      "Автономное выполнение завершилось ошибкой. Пакет сохранён.",
    );
    expect(script).toContain("Codex завершил пакет с ошибкой. Пакет сохранён.");
    expect(script).not.toContain("изменения не применялись");
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
      'anchor.addEventListener("click", () => openTaskComposer(task))',
    );
    expect(script).toContain("function openTaskComposer(task)");
    expect(script).toContain("currentComposerPlacementRect()");
    expect(script).toContain("Редактирование задачи");
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
    expect(script).toContain("!revisionSourceTask && draftKind");
    expect(script).toContain("Boolean(revisionSourceTask)");
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
    expect(script).toContain('class="vip-panel-title">Список задач</span>');
    expect(script).toContain('aria-label="Закрыть список задач"');
    expect(script).toContain('data-task-tab="backlog"');
    expect(script).toContain('data-task-tab="in-progress"');
    expect(script).toContain('data-task-tab="ready"');
    expect(script).toContain('data-tab-count="backlog"');
    expect(script).toContain('data-tab-count="in-progress"');
    expect(script).toContain('data-tab-count="ready"');
    expect(script).toContain("completedNeedsAttention");
    expect(script).toContain("completed.some((task) => !task.rating)");
    expect(script).toContain(".vip-tab-count[data-attention=true]{background:");
    expect(script).toContain("Токены недоступны");
    expect(script).toContain(
      "Токены не измерены · пакет выполнил подключённый чат",
    );
    expect(script).toContain('data-panel-action="clear">Clear All</button>');
    expect(script).toContain('data-panel-action="apply" disabled>Apply');
    expect(script).not.toContain("vip-panel-count");
    expect(script).not.toContain("vip-panel-subtitle");
    expect(script).not.toContain("relativeEffort");
    expect(script).toContain('else if (mode !== "idle") enterNeutralMode()');
    expect(script).toContain('class="vip-element-inspector"');
    expect(script).toContain("function showElementInspector(element, rect)");
    expect(script).toContain("function oklabToSrgb(");
    expect(script).toContain('name === "oklab" || name === "oklch"');
    expect(script).toContain("element.tagName.toLowerCase()");
    expect(script).toContain('data-inspector="size"');
    expect(script).toContain('data-inspector="color"');
    expect(script).toContain('data-inspector="font"');
    expect(script).toContain('next !== "select" && next !== "figma"');
    expect(script).toContain("window.innerHeight - rect.bottom");
    expect(script).toContain("event.stopImmediatePropagation()");
    expect(script).not.toContain('class="vip-target"');
    expect(script).not.toContain("vip-task-target");
    expect(script).not.toContain("import ");
  });

  it("implements the three-state Tasks panel and page-first backlog editing", () => {
    const script = createOverlayScript();

    expect(script).toContain('class="vip-panel-title">Список задач</span>');
    expect(script).toContain('aria-label="Закрыть список задач"');
    expect(script).toContain(
      'class="vip-task-tabs" role="tablist" aria-label="Состояние задач"',
    );
    expect(script).toContain('data-task-tab="backlog" aria-selected="true"');
    expect(script).toContain('data-task-tab="in-progress"');
    expect(script).toContain('data-task-tab="ready"');
    expect(script).toContain(
      "setTabCount(backlogTabCount, backlogCount, false)",
    );
    expect(script).toContain(
      "setTabCount(progressTabCount, progress.length, progressNeedsAttention)",
    );
    expect(script).toContain(
      "setTabCount(completedTabCount, completed.length, completedNeedsAttention)",
    );
    expect(script).toContain("activeTaskTab = tab");
    expect(script).not.toContain("vip-panel-count");
    expect(script).not.toContain("vip-panel-subtitle");

    expect(script).toContain("function taskDisplayNumber(task)");
    expect(script).toContain("function orderedBacklogTasks()");
    expect(script).toContain("function orderedGroupTasks(group)");
    expect(script).toContain(
      "const backlogIndex = orderedBacklogTasks().findIndex(",
    );
    expect(script).toContain(
      "const batchIndex = batch?.taskIds.indexOf(task.id)",
    );
    expect(script).toContain("task.displayNumber && task.displayNumber > 0");
    expect(script).toContain(
      "number.textContent = String(taskDisplayNumber(task))",
    );
    expect(script).toContain("initialTarget.element.scrollIntoView({");
    expect(script).toContain('block: "center"');
    expect(script).toContain("window.scrollTo({");
    expect(script).toContain('behavior: "auto"');
    expect(script).toContain("function openTaskComposer(task)");
    expect(script).toContain("draftAttachments = clone(task.attachments)");
    expect(script).toContain("textarea.focus({ preventScroll: true })");
    expect(script).toContain(
      "textarea.setSelectionRange(textarea.value.length, textarea.value.length)",
    );
    expect(script).not.toContain("vip-task-editor");
  });

  it("deletes backlog cards without confirmation and restores them through Undo", () => {
    const script = createOverlayScript();
    const start = script.indexOf("async function deleteBacklogTask");
    const end = script.indexOf("async function clearBacklog", start);
    const deletion = script.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(script).toContain(
      ".vip-task-card:hover .vip-task-delete,.vip-task-card:focus-within .vip-task-delete{display:grid}",
    );
    expect(script).toContain('remove.className = "vip-task-delete"');
    expect(deletion).toContain("await deleteTask(taskId)");
    expect(deletion).toContain("recordCommand({");
    expect(deletion).toContain("undo: async () => {");
    expect(deletion).toContain("taskId = (await postTask(payload)).id");
    expect(deletion).toContain("redo: async () => {");
    expect(deletion).toContain("Задача удалена · ⌘Z — вернуть");
    expect(deletion).not.toContain("confirm(");
  });

  it("stores an independent five-star rating for a completed task", () => {
    const script = createOverlayScript();
    const start = script.indexOf("async function saveRating");
    const end = script.indexOf("function renderReadyBatch", start);
    const ratingSave = script.slice(start, end);

    expect(script).toContain("async function putTaskRating(");
    expect(script).toContain(
      "`${apiBase}/tasks/${encodeURIComponent(task.id)}/rating`",
    );
    expect(script).toContain('method: "PUT"');
    expect(script).toContain("for (let value = 1; value <= 5; value += 1)");
    expect(script).toContain(
      'star.setAttribute("aria-label", `${value} из 5`)',
    );
    expect(ratingSave).toContain(
      "const updated = await putTaskRating(task, value)",
    );
    expect(ratingSave).not.toContain("postTaskReview");
    expect(script).toContain("completed.some((task) => !task.rating)");
  });

  it("shows anchors only for the active backlog", () => {
    const script = createOverlayScript();
    const start = script.indexOf("function renderAnchors");
    const end = script.indexOf("function renderAttachments", start);
    const anchorRenderer = script.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(anchorRenderer).toContain("orderedBacklogTasks()");
    expect(anchorRenderer).not.toContain("orderedTasks()");
    expect(anchorRenderer).toContain(
      'anchor.addEventListener("click", () => openTaskComposer(task))',
    );
  });

  it("restarts visible numbering for every Backlog and preserves batch-local order", () => {
    const script = createOverlayScript();

    expect(script).toContain('if (task.status === "ready" && !task.batchId)');
    expect(script).toContain("if (backlogIndex >= 0) return backlogIndex + 1");
    expect(script).toContain("if (task.batchId)");
    expect(script).toContain("if (batchIndex >= 0) return batchIndex + 1");
    expect(script).toContain("group.batch.taskIds.flatMap((id) => {");
    expect(script).toContain("orderedGroupTasks(group).forEach((task) =>");
    expect(script).toContain("orderedGroupTasks(groupData).forEach((task) =>");
  });

  it("keeps historical batches collapsed and expands the latest unrated batch once", () => {
    const script = createOverlayScript();

    expect(script).toContain("const expandedBatchIds = new Set()");
    expect(script).toContain(
      "section.dataset.collapsed = String(!expandedBatchIds.has(group.id))",
    );
    expect(script).toContain(
      "group.dataset.collapsed = String(!expandedBatchIds.has(groupData.id))",
    );
    expect(script).toContain('groupTasksByBatch(tasks, "progress")');
    expect(script).toContain("function autoExpandLatestUnratedReadyBatch(");
    expect(script).toContain("autoExpandedReadyBatchIds.has(latestUnrated.id)");
    expect(script).toContain("expandedBatchIds.add(latestUnrated.id)");
    expect(script).toContain("autoExpandedReadyBatchIds.add(latestUnrated.id)");
    expect(script).toContain('readyAutoExpandPending = tab === "ready"');
    expect(script).toContain("expandedBatchIds.clear()");
  });

  it("mutes completed cards and batches after a rating is saved", () => {
    const script = createOverlayScript();

    expect(script).toContain(".vip-task-card[data-rated=true]{opacity:.56}");
    expect(script).toContain(
      "item.dataset.rated = String(Boolean(task.rating))",
    );
    expect(script).toContain(
      "group.dataset.rated = String(tasks.every((task) => Boolean(task.rating)))",
    );
    expect(script).toContain("expandedBatchIds.delete(updated.batchId)");
  });

  it("shows exact batch usage and an explicit estimate on every multi-task Ready card", () => {
    const script = createOverlayScript();
    const cardStart = script.indexOf("function renderTaskCard");
    const cardEnd = script.indexOf(
      "async function deleteBacklogTask",
      cardStart,
    );
    const cardRenderer = script.slice(cardStart, cardEnd);
    const batchStart = script.indexOf("function renderReadyBatch");
    const batchEnd = script.indexOf("function appendEmpty", batchStart);
    const batchRenderer = script.slice(batchStart, batchEnd);

    expect(script).toContain("function formatBatchUsage(batch)");
    expect(script).toContain("const total = totals.input + totals.output");
    expect(script).toContain("function formatUsd(value)");
    expect(script).toContain(
      '`≈${costPartial ? " ≥" : ""}${formatUsd(costTotal)}`',
    );
    expect(script).toContain("`In ${formatCompactMetric(totals.input)}`");
    expect(script).toContain("`Out ${formatCompactMetric(totals.output)}`");
    expect(script).toContain("`Cache ${formatCompactMetric(totals.cached)}`");
    expect(script).toContain("`R ${formatCompactMetric(totals.reasoning)}`");
    expect(script).toContain("Reasoning входит в Output");
    expect(script).toContain(
      'tokenLabel: `${partial ? "≥ " : ""}${tokenParts.join(" · ")}`',
    );
    expect(script).toContain("function formatBatchDuration(batch)");
    expect(script).toContain(
      "const end = batch.completedAt ?? batch.updatedAt",
    );
    expect(script).toContain(
      "new Date(end).getTime() - new Date(batch.createdAt).getTime()",
    );
    expect(batchRenderer).toContain(
      "const usage = batch ? formatBatchUsage(batch) : undefined",
    );
    expect(batchRenderer).toContain("const usageByTaskId = new Map");
    expect(batchRenderer).toContain("allocateEstimatedTaskUsage(");
    expect(batchRenderer).toContain(
      "formatEstimatedTaskUsage(allocation, usage)",
    );
    expect(batchRenderer).toContain(
      "batchTasks.forEach((task) => usageByTaskId.set(task.id, usage))",
    );
    expect(batchRenderer).toContain("usage: usageByTaskId.get(task.id)");
    expect(batchRenderer).toContain("batchTasks.length > 1");
    expect(batchRenderer).toContain('"vip-batch-usage-detail"');
    expect(batchRenderer).toContain(
      "duration.textContent = formatBatchDuration(batch)",
    );
    expect(batchRenderer).toContain(
      'duration.title = "Время от Apply до готового результата"',
    );
    expect(cardRenderer).toContain("if (options.usage)");
    expect(cardRenderer).toContain(
      "content.append(renderTaskUsageTokens(options.usage))",
    );
    expect(cardRenderer).toContain(
      "footer.append(renderUsageCost(options.usage))",
    );
    expect(cardRenderer).toContain("if (options.usage?.raw)");
    expect(cardRenderer.indexOf("renderTaskUsageTokens")).toBeLessThan(
      cardRenderer.indexOf('footer.className = "vip-ready-footer"'),
    );
    expect(script).toContain("`Total ${usage.totalLabel}`");
    expect(script).toContain('line.className = "vip-task-tokens"');
    expect(script).toContain("line.append(total)");
    expect(script).not.toContain('label.textContent = "Tokens"');
    expect(script).toContain("usage.tokenParts.forEach((part) => {");
    expect(script).toContain('metric.className = "vip-task-token-metric"');
    expect(script).toContain(
      'metric.textContent = `${usage.estimated ? "" : usage.partial ? "≥ " : ""}${part}`',
    );
    expect(script).toContain("Оценочная доля измеренного Apply-пакета");
    expect(script).toContain("Оценочная доля доступной нижней границы usage");
    expect(script).toContain('batchUsage.partial ? "≈ ≥ " : "≈ "');
    expect(script).toContain("heuristic-v1");
    expect(script).toContain("это не измерение отдельного agent turn");
    expect(script).toContain(
      "Распределение выполнено между всеми задачами Apply-пакета",
    );
    expect(script).toContain("tokenParts,");
    expect(script).toContain("partial,");
    expect(script).toContain("estimated:");
    expect(script).toContain(
      ".vip-task-tokens-total,.vip-task-token-metric{white-space:nowrap}",
    );
    expect(script).toContain(
      ".vip-task-tokens{display:flex;min-width:0;flex-wrap:nowrap",
    );
    expect(script).toContain("overflow-x:auto;overflow-y:hidden");
    expect(script).toContain("width:min(460px,calc(100vw - 24px))");
    expect(script).toContain(
      ".vip-ready-footer{display:flex;width:100%;min-width:0;flex-wrap:wrap",
    );
    expect(script).toContain("line.append(renderUsageCost(usage), tokens)");
    expect(script).toContain('reasonCode === "host_usage_not_exposed"');
    expect(script).toContain(
      "line.dataset.available = String(Boolean(usage.raw))",
    );
    expect(script).toContain("if (!usage.raw) {");
    expect(script).toContain(
      'unavailable.className = "vip-task-usage-unavailable"',
    );
    expect(script).toContain(
      "if (usage.raw) line.append(renderUsageCost(usage), tokens)",
    );
    expect(script).not.toContain("relativeEffort");
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

  it("describes both Apply recipients without opening Tasks", () => {
    const script = createOverlayScript();

    expect(script).toContain("автономному Codex worker проекта");
    expect(script).toContain("в связанный диалог");
    expect(script).toContain("в очередь проекта");
    expect(script).toContain(
      "Пакет поставлен в очередь автономного Codex worker. Статистика будет сохранена.",
    );
    expect(script).toContain("Автономный Codex worker выполняет пакет. Задач:");
    expect(script).toContain("Автономный запуск начат. Передано задач:");
    expect(script).toContain("Статистика включена.");
    expect(script).toContain("Ожидает Codex.");
    expect(script).not.toContain("setPanelOpen(true)");
  });

  it("does not open a Ready composer when a rating button handles Enter or Space", () => {
    const script = createOverlayScript();
    const cardStart = script.indexOf("function renderTaskCard");
    const cardEnd = script.indexOf(
      "async function deleteBacklogTask",
      cardStart,
    );
    const cardRenderer = script.slice(cardStart, cardEnd);

    expect(cardRenderer).toContain(
      'if (event.target instanceof Element && event.target.closest("button"))',
    );
  });
});
