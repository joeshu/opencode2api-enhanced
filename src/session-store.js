const reusableSessions = new Map();
const DEFAULT_REUSE_TTL_MS = 15 * 60 * 1000;

function normalizeString(value) {
    if (typeof value !== 'string') return '';
    const v = value.trim();
    return v;
}

export function extractConversationKey(req) {
    const headerKeys = [
        req?.headers?.['x-opencode-session-key'],
        req?.headers?.['x-conversation-id'],
        req?.headers?.['x-session-id']
    ];
    for (const value of headerKeys) {
        const normalized = normalizeString(value);
        if (normalized) return normalized;
    }

    const body = req?.body || {};
    const bodyKeys = [
        body.conversation_id,
        body.session_key,
        body.session_id,
        body.metadata?.conversation_id,
        body.metadata?.session_key,
        body.previous_response_id,
        body.response_id
    ];
    for (const value of bodyKeys) {
        const normalized = normalizeString(value);
        if (normalized) return normalized;
    }
    return '';
}

export function getReusableSession(conversationKey, { serverUrl, providerID, modelID }) {
    if (!conversationKey) return null;
    const entry = reusableSessions.get(conversationKey);
    if (!entry) return null;
    if (entry.serverUrl !== serverUrl) return null;
    if (entry.providerID !== providerID || entry.modelID !== modelID) return null;
    return entry;
}

export function rememberReusableSession(conversationKey, payload) {
    if (!conversationKey) return null;
    const next = {
        ...payload,
        timer: reusableSessions.get(conversationKey)?.timer || null,
        updatedAt: Date.now()
    };
    reusableSessions.set(conversationKey, next);
    return next;
}

export function clearReusableSession(conversationKey) {
    if (!conversationKey) return;
    const existing = reusableSessions.get(conversationKey);
    if (existing?.timer) clearTimeout(existing.timer);
    reusableSessions.delete(conversationKey);
}

export function scheduleReusableSessionCleanup(conversationKey, timer) {
    if (!conversationKey) return;
    const existing = reusableSessions.get(conversationKey);
    if (!existing) return;
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = timer;
    existing.expiresAt = Date.now() + DEFAULT_REUSE_TTL_MS;
    reusableSessions.set(conversationKey, existing);
}

export function getReusableSessionTtlMs() {
    return DEFAULT_REUSE_TTL_MS;
}
