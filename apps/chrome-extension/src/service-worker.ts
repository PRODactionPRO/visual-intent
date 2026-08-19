import type {
  BridgeSession,
  ExtensionRequest,
  ExtensionResponse,
  PendingAttachment,
  ReferenceTask,
} from "./types.js";

const BRIDGE_URL = "http://127.0.0.1:7309";
const TOKEN_KEY = "visualIntentBridgeToken";
const SESSION_KEY = "visualIntentSelectedSession";

chrome.runtime.onMessage.addListener(
  (rawMessage: ExtensionRequest, _sender, sendResponse) => {
    void handleMessage(rawMessage)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies ExtensionResponse),
      );
    return true;
  },
);

async function handleMessage(message: ExtensionRequest): Promise<unknown> {
  if (message.type === "bridge:state") {
    const stored = await chrome.storage.local.get([TOKEN_KEY, SESSION_KEY]);
    return {
      paired: typeof stored[TOKEN_KEY] === "string",
      selectedSessionId:
        typeof stored[SESSION_KEY] === "string"
          ? stored[SESSION_KEY]
          : undefined,
    };
  }
  if (message.type === "bridge:pair") {
    const response = await bridgeFetch<{ apiToken: string }>(
      "/api/pair",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: message.code }),
      },
      false,
    );
    await chrome.storage.local.set({ [TOKEN_KEY]: response.apiToken });
    return { paired: true };
  }
  if (message.type === "bridge:list") return listSessions();
  if (message.type === "bridge:select-session") {
    await chrome.storage.local.set({ [SESSION_KEY]: message.sessionId });
    return { selectedSessionId: message.sessionId };
  }
  if (message.type === "bridge:start-selection") {
    const session = (await listSessions()).find(
      (candidate) => candidate.id === message.sessionId,
    );
    if (!session) throw new Error("Выбранный проект сейчас не запущен");
    await chrome.storage.local.set({ [SESSION_KEY]: session.id });
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("Активная вкладка не найдена");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, {
      type: "visual-intent:start-selection",
      session,
    });
    return { started: true };
  }
  if (message.type === "bridge:create-task") {
    const attachments = await Promise.all(
      message.attachments.map((attachment) =>
        uploadAttachment(message.sessionId, attachment),
      ),
    );
    const task: ReferenceTask = { ...message.task, attachments };
    return bridgeFetch(
      `/api/sessions/${encodeURIComponent(message.sessionId)}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(task),
      },
    );
  }
  if (message.type === "bridge:apply") {
    return bridgeFetch(
      `/api/sessions/${encodeURIComponent(message.sessionId)}/apply`,
      { method: "POST" },
    );
  }
  throw new Error("Unsupported Visual Intent extension message");
}

async function listSessions(): Promise<BridgeSession[]> {
  return bridgeFetch<BridgeSession[]>("/api/sessions");
}

async function uploadAttachment(
  sessionId: string,
  attachment: PendingAttachment,
): Promise<Record<string, unknown>> {
  const fileResponse = await fetch(attachment.dataUrl);
  const body = await fileResponse.arrayBuffer();
  return bridgeFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/attachments?fileName=${encodeURIComponent(attachment.fileName)}`,
    {
      method: "POST",
      headers: { "content-type": attachment.mimeType },
      body,
    },
  );
}

async function bridgeFetch<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
  authenticated = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (authenticated) {
    const stored = await chrome.storage.local.get(TOKEN_KEY);
    const token = stored[TOKEN_KEY];
    if (typeof token !== "string") {
      throw new Error("Сначала подключите расширение к локальному Bridge");
    }
    headers.set("authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${BRIDGE_URL}${path}`, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok)
    throw new Error(body.error ?? `Bridge HTTP ${response.status}`);
  return body as T;
}
