import { z } from "zod";

export const PROTOCOL_VERSION = "0.1" as const;

const id = z.string().min(1);
const timestamp = z.iso.datetime();

export const PlatformSchema = z.enum([
  "web",
  "react-native",
  "ios",
  "android",
  "canvas",
]);

export const SurfaceSchema = z.object({
  id,
  platform: PlatformSchema,
  uri: z.string().min(1),
  title: z.string().optional(),
  viewport: z
    .object({
      width: z.number().nonnegative(),
      height: z.number().nonnegative(),
      devicePixelRatio: z.number().positive(),
    })
    .optional(),
  adapter: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
});

export const NodeSchema = z.object({
  id,
  surfaceId: id,
  kind: z.enum(["element", "component", "view", "layer", "virtual"]),
  name: z.string().optional(),
  stableSelector: z.string().optional(),
  text: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
});

export const FrameSchema = z.object({
  id,
  surfaceId: id,
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  scrollX: z.number(),
  scrollY: z.number(),
  scale: z.number().positive(),
});

export const RegionSchema = z.object({
  id,
  surfaceId: id,
  frameId: id,
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  unit: z.enum(["px", "normalized"]),
  coordinateSpace: z.enum(["viewport", "surface", "node"]),
});

export const EntityRefSchema = z.object({
  entity: z.enum(["surface", "node", "region", "frame", "annotation"]),
  id,
});

export const RelationSchema = z.object({
  id,
  type: z.enum(["contains", "targets", "anchors", "precedes", "relates-to"]),
  from: EntityRefSchema,
  to: EntityRefSchema,
});

export const AnnotationSchema = z.object({
  id,
  kind: z.enum(["comment", "highlight", "drawing", "measurement"]),
  body: z.string().optional(),
  nodeId: id.optional(),
  regionId: id.optional(),
  author: z.string().optional(),
  createdAt: timestamp,
});

export const IntentSchema = z.object({
  id,
  action: z.enum(["change", "review", "question", "bug"]),
  instruction: z.string(),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
});

export const TaskKindSchema = z.enum(["code-change", "figma-component"]);

export const AttachmentSchema = z.object({
  id,
  kind: z.enum(["screenshot", "file"]),
  mimeType: z.string().min(1),
  fileName: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  path: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  createdAt: timestamp,
});

export const TaskStatusSchema = z.enum([
  "draft",
  "ready",
  "queued",
  "in_progress",
  "needs_input",
  "applied",
  "rejected",
]);

export const TaskCategorySchema = z.enum([
  "style",
  "layout",
  "text",
  "behavior",
  "bug",
  "image",
  "figma",
  "unknown",
]);

export const TaskScaleSchema = z.enum([
  "element",
  "region",
  "screen",
  "multi-screen",
  "system",
  "unknown",
]);

export const TaskClassificationSchema = z
  .object({
    categories: z.array(TaskCategorySchema).min(1),
    scale: TaskScaleSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.categories).size !== value.categories.length) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: "Task classification categories must be unique",
      });
    }
    if (value.categories.includes("unknown") && value.categories.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: "Unknown cannot be combined with other task categories",
      });
    }
  });

export const ReviewOutcomeSchema = z.enum([
  "accepted",
  "needs_revision",
  "not_accepted",
]);

export const TaskRatingValueSchema = z.number().int().min(1).max(5);

export const TaskRatingSchema = z.object({
  value: TaskRatingValueSchema,
  ratedAt: timestamp,
});

export const TaskReviewSchema = z.object({
  outcome: ReviewOutcomeSchema,
  reviewedAt: timestamp,
  note: z.string().trim().min(1).optional(),
  followUpTaskId: id.optional(),
});

export const RepositorySchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1),
});

export const WorkingTreeFileSchema = z.object({
  path: z.string().min(1),
  status: z.string().min(1),
  fingerprint: z.string().min(1),
});

export const WorkingTreeBaselineSchema = z.object({
  capturedAt: timestamp,
  fingerprint: z.string().min(1),
  files: z.array(WorkingTreeFileSchema).default([]),
});

export const DirtyWorktreeApprovalSourceSchema = z.enum([
  "overlay",
  "cli",
  "mcp",
  "project-settings",
]);

export const DirtyWorktreeApprovalSchema = z.object({
  approvedAt: timestamp,
  baselineFingerprint: z.string().min(1),
  source: DirtyWorktreeApprovalSourceSchema,
});

export const TaskResultSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()).default([]),
  batchChangedFiles: z.array(z.string()).optional(),
  preExistingDirtyFiles: z.array(z.string()).optional(),
  notes: z.array(z.string()).default([]),
  classification: TaskClassificationSchema.optional(),
});

export const AgentTaskResultSchema = z.object({
  taskId: id,
  status: z.enum(["completed", "needs_input", "failed"]),
  summary: z.string().min(1),
  changedFiles: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  classification: TaskClassificationSchema,
});

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
});

const usdRateDecimal = z.string().regex(/^\d+(?:\.\d{1,6})?$/u);
const usdAmountDecimal = z.string().regex(/^\d+(?:\.\d{1,9})?$/u);

function usdDecimalToNano(value: string): bigint {
  const [units, fraction = ""] = value.split(".");
  return (
    BigInt(units ?? "0") * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"))
  );
}

export const OpenAiApiPricingSnapshotSchema = z.object({
  id: z.string().min(1),
  capturedAt: timestamp,
  sourceUrl: z.url(),
  currency: z.literal("USD"),
  serviceTier: z.literal("standard"),
  contextTierAssumption: z.literal("up-to-272k-input-per-request"),
  inputUsdPerMillion: usdRateDecimal,
  cachedInputUsdPerMillion: usdRateDecimal,
  cacheWriteInputUsdPerMillion: usdRateDecimal,
  outputUsdPerMillion: usdRateDecimal,
  promotionalThrough: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
});

export const ApiEquivalentCostSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("calculated"),
    kind: z.literal("openai-api-equivalent"),
    scope: z.literal("apply-batch-turn"),
    model: z.string().min(1),
    reasoningPolicy: z.string().min(1).optional(),
    amountUsd: usdAmountDecimal,
    billableTokens: z.object({
      uncachedInputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative(),
      cacheWriteInputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
    pricingSnapshot: OpenAiApiPricingSnapshotSchema,
    reasoningIncludedInOutput: z.literal(true),
    estimateBasis: z.literal("aggregate-turn-short-context"),
  }),
  z.object({
    availability: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);

export const BatchUsageSchema = z
  .discriminatedUnion("availability", [
    z.object({
      availability: z.literal("reported"),
      capture: z.enum(["direct", "host-reported"]),
      provider: z.string().min(1).optional(),
      source: z.string().min(1),
      scope: z.literal("apply-batch-turn"),
      exact: z.literal(true),
      tokens: TokenUsageSchema,
      model: z.string().min(1).optional(),
      reasoningPolicy: z.string().min(1).optional(),
      adapterVersion: z.string().min(1).optional(),
      apiEquivalentCost: ApiEquivalentCostSchema.optional(),
    }),
    z.object({
      availability: z.literal("unavailable"),
      reason: z.string().min(1),
    }),
  ])
  .superRefine((usage, context) => {
    if (usage.availability !== "reported") return;
    const attributedInput =
      usage.tokens.cachedInputTokens + usage.tokens.cacheWriteInputTokens;
    if (attributedInput > usage.tokens.inputTokens) {
      context.addIssue({
        code: "custom",
        path: ["tokens"],
        message: "Cached and cache-write input cannot exceed total input",
      });
    }
    if (usage.tokens.reasoningOutputTokens > usage.tokens.outputTokens) {
      context.addIssue({
        code: "custom",
        path: ["tokens", "reasoningOutputTokens"],
        message: "Reasoning output cannot exceed total output",
      });
    }
    const cost = usage.apiEquivalentCost;
    if (cost?.availability !== "calculated") return;
    const expectedUncached = Math.max(
      0,
      usage.tokens.inputTokens - attributedInput,
    );
    const billableMatches =
      cost.billableTokens.uncachedInputTokens === expectedUncached &&
      cost.billableTokens.cachedInputTokens ===
        usage.tokens.cachedInputTokens &&
      cost.billableTokens.cacheWriteInputTokens ===
        usage.tokens.cacheWriteInputTokens &&
      cost.billableTokens.outputTokens === usage.tokens.outputTokens;
    if (!billableMatches) {
      context.addIssue({
        code: "custom",
        path: ["apiEquivalentCost", "billableTokens"],
        message: "Billable tokens must match the reported usage subsets",
      });
      return;
    }
    const pricing = cost.pricingSnapshot;
    const numerator =
      BigInt(expectedUncached) * usdDecimalToNano(pricing.inputUsdPerMillion) +
      BigInt(usage.tokens.cachedInputTokens) *
        usdDecimalToNano(pricing.cachedInputUsdPerMillion) +
      BigInt(usage.tokens.cacheWriteInputTokens) *
        usdDecimalToNano(pricing.cacheWriteInputUsdPerMillion) +
      BigInt(usage.tokens.outputTokens) *
        usdDecimalToNano(pricing.outputUsdPerMillion);
    const expectedNanoUsd = (numerator + 500_000n) / 1_000_000n;
    if (usdDecimalToNano(cost.amountUsd) !== expectedNanoUsd) {
      context.addIssue({
        code: "custom",
        path: ["apiEquivalentCost", "amountUsd"],
        message: "Stored API-equivalent cost does not match usage and pricing",
      });
    }
  });

export const ObservedOperationsSchema = z.object({
  completeness: z.enum(["complete", "partial"]),
  sdkTurns: z.number().int().nonnegative(),
  commandExecutions: z.number().int().nonnegative(),
  mcpToolCalls: z.number().int().nonnegative(),
  webSearches: z.number().int().nonnegative(),
  fileChangeOperations: z.number().int().nonnegative(),
  failedOperations: z.number().int().nonnegative(),
  uniqueChangedPaths: z.number().int().nonnegative(),
});

const CreateTaskFieldsSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  displayNumber: z.number().int().positive().optional(),
  kind: TaskKindSchema.default("code-change"),
  surface: SurfaceSchema,
  nodes: z.array(NodeSchema).default([]),
  regions: z.array(RegionSchema).default([]),
  frames: z.array(FrameSchema).default([]),
  relations: z.array(RelationSchema).default([]),
  annotations: z.array(AnnotationSchema).default([]),
  attachments: z.array(AttachmentSchema).max(3).default([]),
  intent: IntentSchema,
});

function requireCodeChangeInstruction(
  value: z.infer<typeof CreateTaskFieldsSchema>,
  context: z.RefinementCtx,
): void {
  if (
    value.kind === "code-change" &&
    value.intent.instruction.trim().length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["intent", "instruction"],
      message: "A code-change task requires an instruction",
    });
  }
}

export const CreateTaskSchema = CreateTaskFieldsSchema.superRefine(
  requireCodeChangeInstruction,
);

const PersistedTaskSchema = CreateTaskFieldsSchema.extend({
  id,
  status: TaskStatusSchema,
  repository: RepositorySchema.optional(),
  batchId: id.optional(),
  iterationId: id,
  rootTaskId: id,
  previousTaskId: id.optional(),
  round: z.number().int().positive().default(1),
  review: TaskReviewSchema.optional(),
  rating: TaskRatingSchema.optional(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  result: TaskResultSchema.optional(),
});

export const TaskSchema = z
  .preprocess((value) => {
    if (typeof value !== "object" || value === null || !("id" in value)) {
      return value;
    }
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string") return value;
    return {
      ...task,
      iterationId: task.iterationId ?? task.id,
      rootTaskId: task.rootTaskId ?? task.id,
      round: task.round ?? 1,
    };
  }, PersistedTaskSchema)
  .superRefine(requireCodeChangeInstruction);

export const ExecutorKindSchema = z.enum(["disconnected", "codex"]);

export const ExecutorOwnershipSchema = z.enum([
  "host-attached",
  "visual-intent-owned",
]);

export const ExecutorStatusSchema = z.enum([
  "disconnected",
  "connected",
  "busy",
  "needs_input",
  "error",
]);

export const ExecutorSourceSchema = z.enum(["cli", "plugin", "generated"]);

export const ProjectExecutorSchema = z.object({
  kind: ExecutorKindSchema,
  status: ExecutorStatusSchema,
  ownership: ExecutorOwnershipSchema.default("host-attached"),
  threadId: id.optional(),
  source: ExecutorSourceSchema.optional(),
  attachedAt: timestamp.optional(),
  lastError: z.string().min(1).optional(),
});

export const ProjectControllerSchema = z.object({
  kind: z.literal("codex"),
  threadId: id,
  source: ExecutorSourceSchema,
  attachedAt: timestamp,
});

export const ProjectSdkWorkerSchema = z.object({
  kind: z.literal("codex"),
  ownership: z.literal("visual-intent-owned"),
  threadId: id.optional(),
  source: ExecutorSourceSchema,
  attachedAt: timestamp.optional(),
});

export const ProjectSessionSchema = z.object({
  id,
  projectKey: z.string().min(1),
  displayName: z.string().min(1),
  repository: RepositorySchema,
  targetUrl: z.url(),
  proxyUrl: z.url(),
  executor: ProjectExecutorSchema,
  controller: ProjectControllerSchema.optional(),
  sdkWorker: ProjectSdkWorkerSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const DirtyWorktreePolicySchema = z.enum([
  "allow-host-attached",
  "require-confirmation",
]);

export const ProjectSettingsSchema = z.object({
  dirtyWorktreePolicy: DirtyWorktreePolicySchema.default("allow-host-attached"),
  revision: z.number().int().positive(),
  updatedAt: timestamp,
});

export const UpdateProjectSettingsSchema = z.object({
  expectedRevision: z.number().int().positive(),
  dirtyWorktreePolicy: DirtyWorktreePolicySchema,
});

export const ConfigureProjectSessionSchema = z.object({
  projectKey: z.string().min(1),
  displayName: z.string().min(1),
  repository: RepositorySchema,
  targetUrl: z.url(),
  proxyUrl: z.url(),
  executor: ProjectExecutorSchema.optional(),
  sdkWorker: ProjectSdkWorkerSchema.optional(),
});

export const AttachExecutorSchema = z.object({
  repositoryRoot: z.string().min(1),
  threadId: id,
  ownership: z.literal("host-attached").default("host-attached"),
  source: z.enum(["cli", "plugin", "generated"]).default("plugin"),
});

export const BatchStatusSchema = z.enum([
  "waiting_for_executor",
  "queued",
  "in_progress",
  "needs_input",
  "completed",
  "failed",
]);

export const PROJECT_CONTEXT_MAX_CHARACTERS = 24_000 as const;

export const ProjectContextSnapshotSchema = z.object({
  revision: z.number().int().positive(),
  content: z.string().min(1).max(PROJECT_CONTEXT_MAX_CHARACTERS),
  capturedAt: timestamp,
});

export const BatchContinuationSchema = z.object({
  answer: z.string().trim().min(1).max(12_000),
  answeredAt: timestamp,
});

export const RetryBatchSchema = z.object({
  answer: z.string().trim().min(1).max(12_000).optional(),
});

export const ClaimBatchSchema = z.object({
  controllerThreadId: id.optional(),
});

export const BatchClaimSchema = z.object({
  id,
  attempt: z.number().int().positive(),
  executorOwnership: ExecutorOwnershipSchema,
  executorThreadId: id.optional(),
  controllerThreadId: id.optional(),
  claimedAt: timestamp,
});

export const FinishBatchClaimSchema = z.object({
  claimId: id,
  expectedAttempt: z.number().int().positive(),
  controllerThreadId: id.optional(),
});

export const BatchResultSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()).default([]),
  batchChangedFiles: z.array(z.string()).optional(),
  preExistingDirtyFiles: z.array(z.string()).optional(),
  notes: z.array(z.string()).default([]),
  technicalDetails: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  failureCode: z.string().min(1).optional(),
  executionId: id.optional(),
  taskResults: z.array(AgentTaskResultSchema).optional(),
  usage: BatchUsageSchema.optional(),
  observedOperations: ObservedOperationsSchema.optional(),
});

export const FinishBatchResultSchema = BatchResultSchema.extend({
  taskResults: z.array(AgentTaskResultSchema).min(1),
});

export const ApplyBatchSchema = z.object({
  id,
  sessionId: id,
  taskIds: z.array(id).min(1),
  attempt: z.number().int().positive().default(1),
  status: BatchStatusSchema,
  executorOwnership: ExecutorOwnershipSchema.optional(),
  executorThreadId: id.optional(),
  claim: BatchClaimSchema.optional(),
  projectContext: ProjectContextSnapshotSchema.optional(),
  continuation: BatchContinuationSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.optional(),
  completedAt: timestamp.optional(),
  workingTreeBaseline: WorkingTreeBaselineSchema.optional(),
  dirtyWorktreeApproval: DirtyWorktreeApprovalSchema.optional(),
  result: BatchResultSchema.optional(),
});

export const ReviewTaskSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    outcome: ReviewOutcomeSchema,
    note: z.string().trim().min(1).optional(),
    revision: z
      .object({
        instruction: z.string().trim().min(1),
        attachments: z.array(AttachmentSchema).max(3).optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.outcome === "needs_revision" && !value.revision) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "A needs-revision review requires the next instruction",
      });
    }
    if (value.outcome !== "needs_revision" && value.revision) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Only a needs-revision review can create a follow-up task",
      });
    }
  });

export const RateTaskSchema = z.object({
  expectedRevision: z.number().int().positive(),
  value: TaskRatingValueSchema,
});

export const VisualIntentEventTypeSchema = z.enum([
  "task.created",
  "task.updated",
  "task.deleted",
  "task.reviewed",
  "task.rated",
  "task.revision_created",
  "batch.dispatched",
  "batch.claimed",
  "batch.retried",
  "batch.finished",
]);

export const VisualIntentEventSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  type: VisualIntentEventTypeSchema,
  occurredAt: timestamp,
  actor: z.enum(["user", "visual-intent", "agent"]),
  sessionId: id.optional(),
  taskId: id.optional(),
  iterationId: id.optional(),
  round: z.number().int().positive().optional(),
  batchId: id.optional(),
  attempt: z.number().int().positive().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const ExecutionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  sessionId: id,
  batchId: id,
  attempt: z.number().int().positive(),
  taskIds: z.array(id).min(1),
  executorOwnership: ExecutorOwnershipSchema.optional(),
  executorThreadId: id.optional(),
  provider: z.string().min(1),
  adapter: z.string().min(1),
  adapterVersion: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningPolicy: z.string().min(1).optional(),
  status: z.enum(["completed", "needs_input", "failed"]),
  startedAt: timestamp,
  completedAt: timestamp,
  durationMs: z.number().int().nonnegative(),
  usage: BatchUsageSchema,
  observedOperations: ObservedOperationsSchema.optional(),
  taskResults: z.array(AgentTaskResultSchema).min(1),
});

export const ApproveDirtyBatchSchema = z.object({
  expectedBaselineFingerprint: z.string().min(1),
  source: DirtyWorktreeApprovalSourceSchema.default("overlay"),
});

export const FinishBatchSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed"]),
  result: FinishBatchResultSchema,
  claim: FinishBatchClaimSchema,
});

export const UpdateTaskSchema = z
  .object({
    expectedRevision: z.number().int().positive().optional(),
    instruction: z.string().trim().optional(),
    attachments: z.array(AttachmentSchema).max(3).optional(),
    status: TaskStatusSchema.optional(),
    result: TaskResultSchema.optional(),
  })
  .refine(
    (value) =>
      value.instruction !== undefined ||
      value.attachments !== undefined ||
      value.status !== undefined ||
      value.result !== undefined,
    {
      message: "At least one task field must be updated",
    },
  );

export type Platform = z.infer<typeof PlatformSchema>;
export type Surface = z.infer<typeof SurfaceSchema>;
export type VisualNode = z.infer<typeof NodeSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskCategory = z.infer<typeof TaskCategorySchema>;
export type TaskScale = z.infer<typeof TaskScaleSchema>;
export type TaskClassification = z.infer<typeof TaskClassificationSchema>;
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;
export type TaskReview = z.infer<typeof TaskReviewSchema>;
export type TaskRatingValue = z.infer<typeof TaskRatingValueSchema>;
export type TaskRating = z.infer<typeof TaskRatingSchema>;
export type Repository = z.infer<typeof RepositorySchema>;
export type WorkingTreeFile = z.infer<typeof WorkingTreeFileSchema>;
export type WorkingTreeBaseline = z.infer<typeof WorkingTreeBaselineSchema>;
export type DirtyWorktreeApprovalSource = z.infer<
  typeof DirtyWorktreeApprovalSourceSchema
>;
export type DirtyWorktreeApproval = z.infer<typeof DirtyWorktreeApprovalSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type AgentTaskResult = z.infer<typeof AgentTaskResultSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type OpenAiApiPricingSnapshot = z.infer<
  typeof OpenAiApiPricingSnapshotSchema
>;
export type ApiEquivalentCost = z.infer<typeof ApiEquivalentCostSchema>;
export type BatchUsage = z.infer<typeof BatchUsageSchema>;
export type ObservedOperations = z.infer<typeof ObservedOperationsSchema>;
export type CreateTask = z.infer<typeof CreateTaskSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;
export type ExecutorKind = z.infer<typeof ExecutorKindSchema>;
export type ExecutorOwnership = z.infer<typeof ExecutorOwnershipSchema>;
export type ExecutorStatus = z.infer<typeof ExecutorStatusSchema>;
export type ExecutorSource = z.infer<typeof ExecutorSourceSchema>;
export type ProjectExecutor = z.infer<typeof ProjectExecutorSchema>;
export type ProjectController = z.infer<typeof ProjectControllerSchema>;
export type ProjectSdkWorker = z.infer<typeof ProjectSdkWorkerSchema>;
export type ProjectSession = z.infer<typeof ProjectSessionSchema>;
export type DirtyWorktreePolicy = z.infer<typeof DirtyWorktreePolicySchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export type UpdateProjectSettings = z.infer<typeof UpdateProjectSettingsSchema>;
export type ConfigureProjectSession = z.input<
  typeof ConfigureProjectSessionSchema
>;
export type AttachExecutor = z.input<typeof AttachExecutorSchema>;
export type BatchStatus = z.infer<typeof BatchStatusSchema>;
export type BatchResult = z.infer<typeof BatchResultSchema>;
export type ProjectContextSnapshot = z.infer<
  typeof ProjectContextSnapshotSchema
>;
export type BatchContinuation = z.infer<typeof BatchContinuationSchema>;
export type RetryBatch = z.input<typeof RetryBatchSchema>;
export type ClaimBatch = z.input<typeof ClaimBatchSchema>;
export type BatchClaim = z.infer<typeof BatchClaimSchema>;
export type FinishBatchClaim = z.infer<typeof FinishBatchClaimSchema>;
export type ApplyBatch = z.infer<typeof ApplyBatchSchema>;
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;
export type RateTask = z.infer<typeof RateTaskSchema>;
export type VisualIntentEventType = z.infer<typeof VisualIntentEventTypeSchema>;
export type VisualIntentEvent = z.infer<typeof VisualIntentEventSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export type ApproveDirtyBatch = z.input<typeof ApproveDirtyBatchSchema>;
export type FinishBatch = z.infer<typeof FinishBatchSchema>;
