import type {
  BridgeSession,
  ExtensionRequest,
  ExtensionResponse,
} from "./types.js";

const pairing = required("pairing");
const workspace = required("workspace");
const pairingCode = requiredInput("pairing-code");
const pairButton = requiredButton("pair");
const refreshButton = requiredButton("refresh");
const sessionsElement = required("sessions");
const empty = required("empty");
const selectButton = requiredButton("select");
const applyButton = requiredButton("apply");
const status = required("status");
let sessions: BridgeSession[] = [];
let selectedSessionId: string | undefined;

void initialize();

pairButton.addEventListener("click", () => void pair());
pairingCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void pair();
});
refreshButton.addEventListener("click", () => void loadSessions());
selectButton.addEventListener("click", () => void startSelection());
applyButton.addEventListener("click", () => void applyTasks());

async function initialize(): Promise<void> {
  const state = await send<{ paired: boolean; selectedSessionId?: string }>({
    type: "bridge:state",
  });
  selectedSessionId = state.selectedSessionId;
  pairing.hidden = state.paired;
  workspace.hidden = !state.paired;
  if (state.paired) await loadSessions();
}

async function pair(): Promise<void> {
  const code = pairingCode.value.trim();
  if (!/^\d{6}$/u.test(code)) {
    setStatus("Введите шестизначный код", true);
    return;
  }
  await action(async () => {
    await send({ type: "bridge:pair", code });
    pairing.hidden = true;
    workspace.hidden = false;
    await loadSessions();
  });
}

async function loadSessions(): Promise<void> {
  await action(async () => {
    sessions = await send<BridgeSession[]>({ type: "bridge:list" });
    if (!sessions.some((session) => session.id === selectedSessionId)) {
      selectedSessionId = sessions[0]?.id;
      if (selectedSessionId)
        await send({
          type: "bridge:select-session",
          sessionId: selectedSessionId,
        });
    }
    renderSessions();
  });
}

function renderSessions(): void {
  sessionsElement.replaceChildren();
  empty.hidden = sessions.length > 0;
  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session${session.id === selectedSessionId ? " active" : ""}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "session-name";
    name.textContent = session.displayName;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(session.readyTaskCount);
    button.append(dot, name, count);
    button.addEventListener("click", () => void chooseSession(session.id));
    sessionsElement.append(button);
  }
  const selected = sessions.find((session) => session.id === selectedSessionId);
  selectButton.disabled = !selected;
  applyButton.disabled = !selected || selected.readyTaskCount === 0;
  applyButton.textContent = selected?.readyTaskCount
    ? `Apply · ${selected.readyTaskCount}`
    : "Нет задач для Apply";
}

async function chooseSession(sessionId: string): Promise<void> {
  selectedSessionId = sessionId;
  await send({ type: "bridge:select-session", sessionId });
  renderSessions();
}

async function startSelection(): Promise<void> {
  if (!selectedSessionId) return;
  await action(async () => {
    await send({
      type: "bridge:start-selection",
      sessionId: selectedSessionId as string,
    });
    window.close();
  });
}

async function applyTasks(): Promise<void> {
  if (!selectedSessionId) return;
  await action(async () => {
    const result = await send<{ accepted?: number }>({
      type: "bridge:apply",
      sessionId: selectedSessionId as string,
    });
    setStatus(`Отправлено задач: ${result.accepted ?? 0}`);
    await loadSessions();
  });
}

async function action(operation: () => Promise<void>): Promise<void> {
  setStatus("");
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not paired|подключите/iu.test(message)) {
      pairing.hidden = false;
      workspace.hidden = true;
    }
    setStatus(message, true);
  }
}

async function send<T = Record<string, unknown>>(
  message: ExtensionRequest,
): Promise<T> {
  const response = (await chrome.runtime.sendMessage(
    message,
  )) as ExtensionResponse<T>;
  if (!response.ok)
    throw new Error(response.error ?? "Visual Intent extension error");
  return response.value as T;
}

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element;
}
function requiredButton(id: string): HTMLButtonElement {
  return required(id) as HTMLButtonElement;
}
function requiredInput(id: string): HTMLInputElement {
  return required(id) as HTMLInputElement;
}
