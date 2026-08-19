export interface BridgeSession {
  id: string;
  projectKey: string;
  displayName: string;
  targetUrl: string;
  proxyUrl: string;
  executor: { kind: string; status: string; ownership: string };
  readyTaskCount: number;
}

export interface PendingAttachment {
  fileName: string;
  mimeType: string;
  dataUrl: string;
}

export interface ReferenceTask {
  protocolVersion: "0.1";
  kind: "code-change";
  surface: Record<string, unknown>;
  nodes: Array<Record<string, unknown>>;
  regions: Array<Record<string, unknown>>;
  frames: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  annotations: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  intent: Record<string, unknown>;
}

export type ExtensionRequest =
  | { type: "bridge:state" }
  | { type: "bridge:pair"; code: string }
  | { type: "bridge:list" }
  | { type: "bridge:select-session"; sessionId: string }
  | { type: "bridge:start-selection"; sessionId: string }
  | { type: "bridge:apply"; sessionId: string }
  | {
      type: "bridge:create-task";
      sessionId: string;
      task: ReferenceTask;
      attachments: PendingAttachment[];
    };

export interface ExtensionResponse<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}
