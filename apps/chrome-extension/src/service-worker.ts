import type {
  BridgeSession,
  ExtensionRequest,
  ExtensionResponse,
  PendingAttachment,
  ReferenceTask,
} from "./types.js";
import {
  addEmbeddedFrameContext,
  collectCrossOriginFramePermissions,
  type BrowserFrameSummary,
} from "./frame-access.js";

const BRIDGE_URL = "http://127.0.0.1:7309";
const TOKEN_KEY = "visualIntentBridgeToken";
const SESSION_KEY = "visualIntentSelectedSession";
const ACTIVE_FRAMES_PREFIX = "visualIntentActiveFrames:";

chrome.runtime.onMessage.addListener(
  (rawMessage: ExtensionRequest, sender, sendResponse) => {
    void handleMessage(rawMessage, sender)
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

async function handleMessage(
  message: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
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
  if (message.type === "bridge:frame-origins") {
    const tab = await activeTab();
    return framePermissionPatterns(tab);
  }
  if (message.type === "bridge:start-selection") {
    const session = (await listSessions()).find(
      (candidate) => candidate.id === message.sessionId,
    );
    if (!session) throw new Error("Выбранный проект сейчас не запущен");
    await chrome.storage.local.set({ [SESSION_KEY]: session.id });
    const tab = await activeTab();
    return startFrameSelection(tab, session);
  }
  if (message.type === "bridge:frame-active") {
    const tabId = requireSenderTabId(sender);
    await broadcastToFrames(
      tabId,
      { type: "visual-intent:clear-hover" },
      sender.frameId,
    );
    return { activeFrameId: sender.frameId ?? 0 };
  }
  if (message.type === "bridge:frame-capture") {
    const tabId = requireSenderTabId(sender);
    const frameId = sender.frameId ?? 0;
    const reference = addEmbeddedFrameContext(message.reference, {
      frameId,
      frameUrl: sender.url,
      topLevelUrl: sender.tab?.url,
    });
    await stopFrameSelection(tabId);
    await chrome.tabs.sendMessage(
      tabId,
      {
        type: "visual-intent:open-reference",
        reference,
        anchor: message.anchor,
        sourceFrameId: frameId,
      },
      { frameId: 0 },
    );
    return { captured: true, sourceFrameId: frameId };
  }
  if (message.type === "bridge:finish-selection") {
    const tabId = requireSenderTabId(sender);
    await stopFrameSelection(tabId);
    await chrome.storage.session.remove(activeFramesKey(tabId));
    return { finished: true };
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

async function activeTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Активная вкладка не найдена");
  return tab as chrome.tabs.Tab & { id: number };
}

async function startFrameSelection(
  tab: chrome.tabs.Tab & { id: number },
  session: BridgeSession,
): Promise<Record<string, unknown>> {
  let injections: chrome.scripting.InjectionResult[];
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });
  } catch {
    throw new Error(
      "Chrome не разрешает запуск Visual Intent на этой служебной странице",
    );
  }
  const frameIds = [...new Set(injections.map((result) => result.frameId))];
  if (!frameIds.includes(0))
    throw new Error("Не удалось подключить Visual Intent к основной странице");
  await chrome.storage.session.set({ [activeFramesKey(tab.id)]: frameIds });
  const results = await Promise.allSettled(
    frameIds.map((frameId) =>
      chrome.tabs.sendMessage(
        tab.id,
        { type: "visual-intent:start-selection", session },
        { frameId },
      ),
    ),
  );
  return {
    started: true,
    frameCount: results.filter((result) => result.status === "fulfilled")
      .length,
  };
}

async function stopFrameSelection(tabId: number): Promise<void> {
  await broadcastToFrames(tabId, { type: "visual-intent:stop-selection" });
}

async function broadcastToFrames(
  tabId: number,
  message:
    | Record<string, unknown>
    | ((frameId: number) => Record<string, unknown>),
  excludedFrameId?: number,
): Promise<void> {
  const stored = await chrome.storage.session.get(activeFramesKey(tabId));
  const candidate = stored[activeFramesKey(tabId)];
  const frameIds = Array.isArray(candidate)
    ? candidate.filter((value): value is number => typeof value === "number")
    : [0];
  await Promise.allSettled(
    frameIds
      .filter((frameId) => frameId !== excludedFrameId)
      .map((frameId) =>
        chrome.tabs.sendMessage(
          tabId,
          typeof message === "function" ? message(frameId) : message,
          { frameId },
        ),
      ),
  );
}

async function framePermissionPatterns(
  tab: chrome.tabs.Tab & { id: number },
): Promise<string[]> {
  const [inspection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      topUrl: location.href,
      frameUrls: Array.from(
        document.querySelectorAll<HTMLIFrameElement>("iframe[src]"),
      )
        .filter((frame) => {
          const rect = frame.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((frame) => frame.src),
    }),
  });
  const result = inspection?.result as
    | { topUrl?: string; frameUrls?: string[] }
    | undefined;
  const frames: BrowserFrameSummary[] = [
    {
      frameId: 0,
      parentFrameId: -1,
      url: result?.topUrl ?? tab.url ?? "",
    },
    ...(result?.frameUrls ?? []).map((url, index) => ({
      frameId: index + 1,
      parentFrameId: 0,
      url,
    })),
  ];
  return collectCrossOriginFramePermissions(frames);
}

function activeFramesKey(tabId: number): string {
  return `${ACTIVE_FRAMES_PREFIX}${tabId}`;
}

function requireSenderTabId(sender: chrome.runtime.MessageSender): number {
  if (typeof sender.tab?.id !== "number")
    throw new Error("Сообщение Visual Intent пришло не со страницы");
  return sender.tab.id;
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
