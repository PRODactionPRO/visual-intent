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
  instruction: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
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

export const RepositorySchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1),
});

export const TaskResultSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export const CreateTaskSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  surface: SurfaceSchema,
  nodes: z.array(NodeSchema).default([]),
  regions: z.array(RegionSchema).default([]),
  frames: z.array(FrameSchema).default([]),
  relations: z.array(RelationSchema).default([]),
  annotations: z.array(AnnotationSchema).default([]),
  intent: IntentSchema,
});

export const TaskSchema = CreateTaskSchema.extend({
  id,
  status: TaskStatusSchema,
  repository: RepositorySchema.optional(),
  batchId: id.optional(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  result: TaskResultSchema.optional(),
});

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

export const ProjectExecutorSchema = z.object({
  kind: ExecutorKindSchema,
  status: ExecutorStatusSchema,
  ownership: ExecutorOwnershipSchema.default("host-attached"),
  threadId: id.optional(),
  source: z.enum(["cli", "plugin", "generated"]).optional(),
  attachedAt: timestamp.optional(),
  lastError: z.string().min(1).optional(),
});

export const ProjectSessionSchema = z.object({
  id,
  projectKey: z.string().min(1),
  displayName: z.string().min(1),
  repository: RepositorySchema,
  targetUrl: z.url(),
  proxyUrl: z.url(),
  executor: ProjectExecutorSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const ConfigureProjectSessionSchema = z.object({
  projectKey: z.string().min(1),
  displayName: z.string().min(1),
  repository: RepositorySchema,
  targetUrl: z.url(),
  proxyUrl: z.url(),
  executor: ProjectExecutorSchema.optional(),
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

export const BatchResultSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  technicalDetails: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  failureCode: z.string().min(1).optional(),
});

export const ApplyBatchSchema = z.object({
  id,
  sessionId: id,
  taskIds: z.array(id).min(1),
  status: BatchStatusSchema,
  executorOwnership: ExecutorOwnershipSchema.optional(),
  executorThreadId: id.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.optional(),
  completedAt: timestamp.optional(),
  result: BatchResultSchema.optional(),
});

export const FinishBatchSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed"]),
  result: BatchResultSchema,
});

export const UpdateTaskSchema = z
  .object({
    expectedRevision: z.number().int().positive().optional(),
    instruction: z.string().trim().min(1).optional(),
    status: TaskStatusSchema.optional(),
    result: TaskResultSchema.optional(),
  })
  .refine(
    (value) =>
      value.instruction !== undefined ||
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
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Repository = z.infer<typeof RepositorySchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type CreateTask = z.infer<typeof CreateTaskSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;
export type ExecutorKind = z.infer<typeof ExecutorKindSchema>;
export type ExecutorOwnership = z.infer<typeof ExecutorOwnershipSchema>;
export type ExecutorStatus = z.infer<typeof ExecutorStatusSchema>;
export type ProjectExecutor = z.infer<typeof ProjectExecutorSchema>;
export type ProjectSession = z.infer<typeof ProjectSessionSchema>;
export type ConfigureProjectSession = z.input<
  typeof ConfigureProjectSessionSchema
>;
export type AttachExecutor = z.input<typeof AttachExecutorSchema>;
export type BatchStatus = z.infer<typeof BatchStatusSchema>;
export type BatchResult = z.infer<typeof BatchResultSchema>;
export type ApplyBatch = z.infer<typeof ApplyBatchSchema>;
export type FinishBatch = z.infer<typeof FinishBatchSchema>;
