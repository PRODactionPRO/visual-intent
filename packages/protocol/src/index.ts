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
  "in_progress",
  "needs_input",
  "applied",
  "rejected",
]);

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
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  result: TaskResultSchema.optional(),
});

export const UpdateTaskSchema = z
  .object({
    expectedRevision: z.number().int().positive().optional(),
    status: TaskStatusSchema.optional(),
    result: TaskResultSchema.optional(),
  })
  .refine((value) => value.status !== undefined || value.result !== undefined, {
    message: "At least one task field must be updated",
  });

export type Platform = z.infer<typeof PlatformSchema>;
export type Surface = z.infer<typeof SurfaceSchema>;
export type VisualNode = z.infer<typeof NodeSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type CreateTask = z.infer<typeof CreateTaskSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;
