import type {
  ApplyBatch,
  ExecutionRecord,
  Task,
  VisualIntentEvent,
} from "@visual-intent/protocol";

export interface MetricsInput {
  tasks: Task[];
  batches: ApplyBatch[];
  executions: ExecutionRecord[];
  events: VisualIntentEvent[];
  since?: string;
}

export interface MetricsSummary {
  generatedAt: string;
  since?: string;
  tasks: {
    total: number;
    ready: number;
    applied: number;
    reviewed: number;
  };
  iterations: {
    total: number;
    accepted: number;
    firstPassAccepted: number;
    firstPassSuccessRate: number | null;
    additionalRounds: number;
    medianTimeToAcceptedMs: number | null;
  };
  reviews: {
    accepted: number;
    needsRevision: number;
    notAccepted: number;
  };
  ratings: {
    rated: number;
    unratedApplied: number;
    average: number | null;
    distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  };
  apply: {
    batches: number;
    executions: number;
    singleTaskExecutions: number;
    multiTaskExecutions: number;
    medianDurationMs: number | null;
    p90DurationMs: number | null;
  };
  usage: {
    reportedExecutions: number;
    unavailableExecutions: number;
    coverage: number | null;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    acceptedTasksInReportedExecutions: number;
    batchTokensPerAcceptedTask: number | null;
    acceptedSingleTaskExecutions: number;
    medianTokensAcceptedSingleTask: number | null;
  };
  observedOperations: {
    commandExecutions: number;
    mcpToolCalls: number;
    webSearches: number;
    fileChangeOperations: number;
    failedOperations: number;
  };
  classifications: {
    categories: Record<string, number>;
    scales: Record<string, number>;
  };
  guardrails: {
    failedBatches: number;
    needsInputBatches: number;
    unavailableUsageExecutions: number;
    lifecycleEvents: number;
    retryEvents: number;
  };
}

export interface MetricsExecutionRow {
  executionId: string;
  batchId: string;
  attempt: number;
  taskCount: number;
  mode: "single-task" | "multi-task";
  status: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  usageAvailability: "reported" | "unavailable";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  acceptedTasks: number;
  needsRevisionTasks: number;
  notAcceptedTasks: number;
  categories: string;
  scales: string;
}

type ReviewOutcome = NonNullable<Task["review"]>["outcome"];

export function buildMetrics(input: MetricsInput): {
  summary: MetricsSummary;
  executions: MetricsExecutionRow[];
} {
  const tasks = input.since
    ? input.tasks.filter((task) => task.createdAt >= input.since!)
    : input.tasks;
  const batches = input.since
    ? input.batches.filter((batch) => batch.createdAt >= input.since!)
    : input.batches;
  const executions = input.since
    ? input.executions.filter(
        (execution) => execution.completedAt >= input.since!,
      )
    : input.executions;
  const events = input.since
    ? input.events.filter((event) => event.occurredAt >= input.since!)
    : input.events;

  const reviewsByExecution = mapTaskReviewsToExecutions(tasks, executions);
  const iterationTasks = new Map<string, Task[]>();
  for (const task of tasks) {
    const group = iterationTasks.get(task.iterationId) ?? [];
    group.push(task);
    iterationTasks.set(task.iterationId, group);
  }

  const acceptedTasks = tasks.filter(
    (task) => task.review?.outcome === "accepted",
  );
  const ratingValues = tasks.flatMap((task) =>
    task.rating ? [task.rating.value] : [],
  );
  const ratingDistribution: MetricsSummary["ratings"]["distribution"] = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
  };
  for (const value of ratingValues) {
    ratingDistribution[String(value) as keyof typeof ratingDistribution] += 1;
  }
  const acceptedIterationIds = new Set(
    acceptedTasks.map((task) => task.iterationId),
  );
  const evaluatedIterationIds = new Set(
    tasks
      .filter((task) => task.review !== undefined || task.rating !== undefined)
      .map((task) => task.iterationId),
  );
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));
  const firstPassAccepted = [...evaluatedIterationIds].filter((iterationId) => {
    const group = iterationTasks.get(iterationId) ?? [];
    if (group.some((task) => task.review?.outcome === "needs_revision")) {
      return false;
    }
    const accepted = group.find(
      (task) => task.round === 1 && task.review?.outcome === "accepted",
    );
    if (!accepted || group.some((task) => task.round > 1)) return false;
    const batch = accepted.batchId
      ? batchById.get(accepted.batchId)
      : undefined;
    if (!batch || batch.attempt !== 1 || batch.status !== "completed") {
      return false;
    }
    return !events.some(
      (event) =>
        event.batchId === batch.id &&
        (event.type === "batch.retried" ||
          (event.type === "batch.dispatched" &&
            event.data?.status === "needs_input")),
    );
  }).length;
  const timeToAccepted = [...acceptedIterationIds]
    .map((iterationId) => {
      const group = iterationTasks.get(iterationId) ?? [];
      const startedAt = group.map((task) => task.createdAt).sort()[0];
      const acceptedAt = group
        .filter((task) => task.review?.outcome === "accepted")
        .map((task) => task.review?.reviewedAt)
        .sort()[0];
      return startedAt && acceptedAt
        ? Math.max(
            0,
            new Date(acceptedAt).getTime() - new Date(startedAt).getTime(),
          )
        : undefined;
    })
    .filter((value): value is number => value !== undefined);
  const additionalRounds = [...iterationTasks.values()].reduce(
    (sum, group) => sum + Math.max(0, ...group.map((task) => task.round)) - 1,
    0,
  );

  const reported = executions.filter(
    (execution) => execution.usage.availability === "reported",
  );
  const usage = reported.reduce(
    (totals, execution) => {
      if (execution.usage.availability !== "reported") return totals;
      const tokens = execution.usage.tokens;
      totals.inputTokens += tokens.inputTokens;
      totals.cachedInputTokens += tokens.cachedInputTokens;
      totals.cacheWriteInputTokens += tokens.cacheWriteInputTokens;
      totals.outputTokens += tokens.outputTokens;
      totals.reasoningOutputTokens += tokens.reasoningOutputTokens;
      totals.totalTokens += tokens.inputTokens + tokens.outputTokens;
      return totals;
    },
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  );
  const operations = executions.reduce(
    (totals, execution) => {
      const observed = execution.observedOperations;
      if (!observed) return totals;
      totals.commandExecutions += observed.commandExecutions;
      totals.mcpToolCalls += observed.mcpToolCalls;
      totals.webSearches += observed.webSearches;
      totals.fileChangeOperations += observed.fileChangeOperations;
      totals.failedOperations += observed.failedOperations;
      return totals;
    },
    {
      commandExecutions: 0,
      mcpToolCalls: 0,
      webSearches: 0,
      fileChangeOperations: 0,
      failedOperations: 0,
    },
  );
  const acceptedTasksInReportedExecutions = reported.reduce(
    (sum, execution) =>
      sum +
      countReviewOutcome(reviewsByExecution.get(execution.id), "accepted"),
    0,
  );
  const acceptedSingleTaskTokens = reported
    .filter(
      (execution) =>
        execution.taskIds.length === 1 &&
        countReviewOutcome(reviewsByExecution.get(execution.id), "accepted") ===
          1,
    )
    .map((execution) => {
      if (execution.usage.availability !== "reported") return 0;
      return (
        execution.usage.tokens.inputTokens + execution.usage.tokens.outputTokens
      );
    });
  const categories: Record<string, number> = {};
  const scales: Record<string, number> = {};
  for (const task of tasks) {
    const classification = task.result?.classification;
    if (!classification) continue;
    for (const category of classification.categories) {
      categories[category] = (categories[category] ?? 0) + 1;
    }
    scales[classification.scale] = (scales[classification.scale] ?? 0) + 1;
  }

  const rows = executions.map((execution) => {
    const executionReviews = reviewsByExecution.get(execution.id);
    const classifications = execution.taskResults.map(
      (result) => result.classification,
    );
    const reportedUsage =
      execution.usage.availability === "reported"
        ? execution.usage.tokens
        : undefined;
    return {
      executionId: execution.id,
      batchId: execution.batchId,
      attempt: execution.attempt,
      taskCount: execution.taskIds.length,
      mode:
        execution.taskIds.length === 1
          ? ("single-task" as const)
          : ("multi-task" as const),
      status: execution.status,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      durationMs: execution.durationMs,
      usageAvailability: execution.usage.availability,
      inputTokens: reportedUsage?.inputTokens ?? null,
      cachedInputTokens: reportedUsage?.cachedInputTokens ?? null,
      cacheWriteInputTokens: reportedUsage?.cacheWriteInputTokens ?? null,
      outputTokens: reportedUsage?.outputTokens ?? null,
      reasoningOutputTokens: reportedUsage?.reasoningOutputTokens ?? null,
      totalTokens: reportedUsage
        ? reportedUsage.inputTokens + reportedUsage.outputTokens
        : null,
      acceptedTasks: countReviewOutcome(executionReviews, "accepted"),
      needsRevisionTasks: countReviewOutcome(
        executionReviews,
        "needs_revision",
      ),
      notAcceptedTasks: countReviewOutcome(executionReviews, "not_accepted"),
      categories: [
        ...new Set(
          classifications.flatMap((classification) =>
            classification.categories.filter(
              (category) => category !== "unknown",
            ),
          ),
        ),
      ].join("|"),
      scales: [
        ...new Set(
          classifications
            .map((classification) => classification.scale)
            .filter((scale) => scale !== "unknown"),
        ),
      ].join("|"),
    };
  });
  const durations = executions.map((execution) => execution.durationMs);

  return {
    summary: {
      generatedAt: new Date().toISOString(),
      ...(input.since ? { since: input.since } : {}),
      tasks: {
        total: tasks.length,
        ready: tasks.filter((task) => task.status === "ready").length,
        applied: tasks.filter((task) => task.status === "applied").length,
        reviewed: tasks.filter((task) => task.review !== undefined).length,
      },
      iterations: {
        total: iterationTasks.size,
        accepted: acceptedIterationIds.size,
        firstPassAccepted,
        firstPassSuccessRate:
          evaluatedIterationIds.size > 0
            ? firstPassAccepted / evaluatedIterationIds.size
            : null,
        additionalRounds,
        medianTimeToAcceptedMs: percentile(timeToAccepted, 0.5),
      },
      reviews: {
        accepted: acceptedTasks.length,
        needsRevision: tasks.filter(
          (task) => task.review?.outcome === "needs_revision",
        ).length,
        notAccepted: tasks.filter(
          (task) => task.review?.outcome === "not_accepted",
        ).length,
      },
      ratings: {
        rated: ratingValues.length,
        unratedApplied: tasks.filter(
          (task) => task.status === "applied" && task.rating === undefined,
        ).length,
        average:
          ratingValues.length > 0
            ? ratingValues.reduce((sum, value) => sum + value, 0) /
              ratingValues.length
            : null,
        distribution: ratingDistribution,
      },
      apply: {
        batches: batches.length,
        executions: executions.length,
        singleTaskExecutions: executions.filter(
          (execution) => execution.taskIds.length === 1,
        ).length,
        multiTaskExecutions: executions.filter(
          (execution) => execution.taskIds.length > 1,
        ).length,
        medianDurationMs: percentile(durations, 0.5),
        p90DurationMs: percentile(durations, 0.9),
      },
      usage: {
        reportedExecutions: reported.length,
        unavailableExecutions: executions.length - reported.length,
        coverage:
          executions.length > 0 ? reported.length / executions.length : null,
        ...usage,
        acceptedTasksInReportedExecutions,
        batchTokensPerAcceptedTask:
          acceptedTasksInReportedExecutions > 0
            ? usage.totalTokens / acceptedTasksInReportedExecutions
            : null,
        acceptedSingleTaskExecutions: acceptedSingleTaskTokens.length,
        medianTokensAcceptedSingleTask: percentile(
          acceptedSingleTaskTokens,
          0.5,
        ),
      },
      observedOperations: operations,
      classifications: { categories, scales },
      guardrails: {
        failedBatches: batches.filter((batch) => batch.status === "failed")
          .length,
        needsInputBatches: batches.filter(
          (batch) => batch.status === "needs_input",
        ).length,
        unavailableUsageExecutions: executions.length - reported.length,
        lifecycleEvents: events.length,
        retryEvents: batches.reduce(
          (total, batch) => total + Math.max(0, batch.attempt - 1),
          0,
        ),
      },
    },
    executions: rows,
  };
}

export function formatMetricsTable(summary: MetricsSummary): string {
  const percent = (value: number | null): string =>
    value === null ? "—" : `${(value * 100).toFixed(1)}%`;
  const duration = (value: number | null): string =>
    value === null ? "—" : formatDuration(value);
  const rating = (value: number | null): string =>
    value === null
      ? "—"
      : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}/5`;
  return [
    "Visual Intent — локальная аналитика",
    summary.since ? `Период: с ${summary.since}` : "Период: всё время",
    "",
    `Правки: ${summary.iterations.total}; принято: ${summary.iterations.accepted}`,
    `Успех с первого раунда: ${percent(summary.iterations.firstPassSuccessRate)}`,
    `Медиана до принятия: ${duration(summary.iterations.medianTimeToAcceptedMs)}`,
    `Дополнительные раунды: ${summary.iterations.additionalRounds}`,
    "",
    `Apply: ${summary.apply.batches}; запусков: ${summary.apply.executions} (${summary.apply.singleTaskExecutions} одиночных / ${summary.apply.multiTaskExecutions} пакетных)`,
    `Медиана выполнения: ${duration(summary.apply.medianDurationMs)}; p90: ${duration(summary.apply.p90DurationMs)}`,
    `Покрытие usage: ${summary.usage.reportedExecutions}/${summary.apply.executions} (${percent(summary.usage.coverage)})`,
    `Токены: input ${summary.usage.inputTokens.toLocaleString("ru-RU")}; output ${summary.usage.outputTokens.toLocaleString("ru-RU")}; всего ${summary.usage.totalTokens.toLocaleString("ru-RU")}`,
    `На принятое задание в измеренных пакетах: ${summary.usage.batchTokensPerAcceptedTask === null ? "—" : Math.round(summary.usage.batchTokensPerAcceptedTask).toLocaleString("ru-RU")} токенов; медиана принятого одиночного Apply: ${summary.usage.medianTokensAcceptedSingleTask === null ? "—" : Math.round(summary.usage.medianTokensAcceptedSingleTask).toLocaleString("ru-RU")}`,
    "",
    `Пятизвёздочная оценка: ${summary.ratings.rated}; средняя ${rating(summary.ratings.average)}; без оценки среди готовых ${summary.ratings.unratedApplied}`,
    `Распределение звёзд: 1★ ${summary.ratings.distribution["1"]}; 2★ ${summary.ratings.distribution["2"]}; 3★ ${summary.ratings.distribution["3"]}; 4★ ${summary.ratings.distribution["4"]}; 5★ ${summary.ratings.distribution["5"]}`,
    `Решения по результату: принято ${summary.reviews.accepted}; нужна правка ${summary.reviews.needsRevision}; не принято ${summary.reviews.notAccepted}`,
    `Guardrails: failed ${summary.guardrails.failedBatches}; needs input ${summary.guardrails.needsInputBatches}; retry ${summary.guardrails.retryEvents}; usage недоступен ${summary.guardrails.unavailableUsageExecutions}`,
  ].join("\n");
}

export function formatMetricsCsv(rows: MetricsExecutionRow[]): string {
  const headers = [
    "executionId",
    "batchId",
    "attempt",
    "taskCount",
    "mode",
    "status",
    "startedAt",
    "completedAt",
    "durationMs",
    "usageAvailability",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
    "acceptedTasks",
    "needsRevisionTasks",
    "notAcceptedTasks",
    "categories",
    "scales",
  ] as const;
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvCell(row[header])).join(","),
    ),
  ].join("\n");
}

export function parseSince(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const duration = value.match(/^(\d+)([dh])$/u);
  if (duration?.[1] && duration[2]) {
    const amount = Number.parseInt(duration[1], 10);
    const milliseconds =
      amount * (duration[2] === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
    return new Date(Date.now() - milliseconds).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("--since must be an ISO date, Nd, or Nh");
  }
  return parsed.toISOString();
}

function mapTaskReviewsToExecutions(
  tasks: Task[],
  executions: ExecutionRecord[],
): Map<string, Map<string, ReviewOutcome>> {
  const reviewsByExecution = new Map<string, Map<string, ReviewOutcome>>();

  for (const task of tasks) {
    if (!task.review) continue;
    const reviewedAt = new Date(task.review.reviewedAt).getTime();
    let reviewedExecution: ExecutionRecord | undefined;
    let reviewedExecutionCompletedAt = Number.NEGATIVE_INFINITY;

    for (const execution of executions) {
      if (task.batchId && execution.batchId !== task.batchId) continue;
      const completedAt = new Date(execution.completedAt).getTime();
      if (completedAt > reviewedAt) continue;
      if (
        !execution.taskResults.some(
          (result) =>
            result.taskId === task.id && result.status === "completed",
        )
      ) {
        continue;
      }
      if (
        !reviewedExecution ||
        completedAt > reviewedExecutionCompletedAt ||
        (completedAt === reviewedExecutionCompletedAt &&
          execution.attempt > reviewedExecution.attempt)
      ) {
        reviewedExecution = execution;
        reviewedExecutionCompletedAt = completedAt;
      }
    }

    if (!reviewedExecution) continue;
    const executionReviews =
      reviewsByExecution.get(reviewedExecution.id) ??
      new Map<string, ReviewOutcome>();
    executionReviews.set(task.id, task.review.outcome);
    reviewsByExecution.set(reviewedExecution.id, executionReviews);
  }

  return reviewsByExecution;
}

function countReviewOutcome(
  reviews: Map<string, ReviewOutcome> | undefined,
  outcome: ReviewOutcome,
): number {
  if (!reviews) return 0;
  let count = 0;
  for (const review of reviews.values()) {
    if (review === outcome) count += 1;
  }
  return count;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? null;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)} сек`;
  if (milliseconds < 3_600_000)
    return `${Math.round(milliseconds / 60_000)} мин`;
  return `${(milliseconds / 3_600_000).toFixed(1)} ч`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
