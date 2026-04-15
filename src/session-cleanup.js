import { clearReusableSession, getReusableSessionTtlMs, scheduleReusableSessionCleanup } from './session-store.js';

export function cleanupSessionLater(client, sessionId, delayMs = 3000, conversationKey = '') {
    if (!sessionId) return;

    const effectiveDelayMs = conversationKey ? getReusableSessionTtlMs() : delayMs;
    const timer = setTimeout(async () => {
        try {
            await client.session.delete({ path: { id: sessionId } });
        } catch (e) {
            // best-effort cleanup only
        } finally {
            if (conversationKey) clearReusableSession(conversationKey);
        }
    }, effectiveDelayMs);

    if (conversationKey) {
        scheduleReusableSessionCleanup(conversationKey, timer);
    }

    if (timer.unref) timer.unref();
}
