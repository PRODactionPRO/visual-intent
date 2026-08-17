export function resolveCodexThreadId({
  explicit,
  requestMeta,
  environment = process.env,
} = {}) {
  const meta = isRecord(requestMeta) ? requestMeta : {};
  const candidates = [
    explicit,
    meta["codex/threadId"],
    meta["codex/thread_id"],
    meta.threadId,
    meta.thread_id,
    meta.conversationId,
    meta.conversation_id,
    meta.sessionId,
    meta.session_id,
    environment.CODEX_THREAD_ID,
    environment.CODEX_SESSION_ID,
  ];
  return candidates.find(isNonEmptyString)?.trim();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
