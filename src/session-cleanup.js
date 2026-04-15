export function cleanupSessionLater(client, sessionId, delayMs = 3000) {
    if (!sessionId) return;
    const timer = setTimeout(async () => {
        try {
            await client.session.delete({ path: { id: sessionId } });
        } catch (e) {
            // best-effort cleanup only
        }
    }, delayMs);
    if (timer.unref) timer.unref();
}
