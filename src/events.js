export function extractFromParts(parts) {
    if (!Array.isArray(parts)) return { content: '', reasoning: '' };
    const content = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    const reasoning = parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('');
    return { content, reasoning };
}

export async function pollForAssistantResponse(client, logDebug, sleep, sessionId, timeoutMs, intervalMs) {
    const pollStart = Date.now();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const messagesRes = await client.session.messages({ path: { id: sessionId } });
        const messages = messagesRes?.data || messagesRes || [];
        if (Array.isArray(messages) && messages.length) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const entry = messages[i];
                const info = entry?.info;
                if (info?.role !== 'assistant') continue;
                const { content, reasoning } = extractFromParts(entry?.parts || []);
                const error = info?.error || null;
                const done = Boolean(info.finish || info.time?.completed || error);
                if (done || content || reasoning) {
                    if (error) {
                        console.error('[Proxy] OpenCode assistant error:', error);
                    }
                    logDebug('Polling completed', {
                        sessionId,
                        ms: Date.now() - pollStart,
                        done,
                        contentLen: content.length,
                        reasoningLen: reasoning.length,
                        error: error ? error.name : null
                    });
                    return { content, reasoning, error };
                }
            }
        }
        await sleep(intervalMs);
    }
    logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart });
    throw new Error(`Request timeout after ${timeoutMs}ms`);
}

export async function collectFromEvents(client, logDebug, sessionId, timeoutMs, onDelta, firstDeltaTimeoutMs, idleTimeoutMs) {
    const controller = new AbortController();
    const eventStreamResult = await client.event.subscribe({ signal: controller.signal });
    const eventStream = eventStreamResult.stream;
    let finished = false;
    let content = '';
    let reasoning = '';
    let receivedDelta = false;
    let deltaChars = 0;
    let firstDeltaAt = null;
    const startedAt = Date.now();

    const finishPromise = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            if (finished) return;
            finished = true;
            controller.abort();
            reject(new Error(`Request timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const firstDeltaTimer = firstDeltaTimeoutMs
            ? setTimeout(() => {
                if (finished || receivedDelta) return;
                finished = true;
                controller.abort();
                logDebug('No event data received', { sessionId, ms: Date.now() - startedAt });
                resolve({ content: '', reasoning: '', noData: true });
            }, firstDeltaTimeoutMs)
            : null;

        let idleTimer = null;
        const scheduleIdleTimer = () => {
            if (!idleTimeoutMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (finished) return;
                finished = true;
                controller.abort();
                logDebug('Event idle timeout', {
                    sessionId,
                    ms: Date.now() - startedAt,
                    deltaChars
                });
                resolve({ content, reasoning, idleTimeout: true, receivedDelta });
            }, idleTimeoutMs);
        };

        (async () => {
            try {
                for await (const event of eventStream) {
                    logDebug('SSE event received', {
                        type: event?.type,
                        sessionId: event?.properties?.part?.sessionID || event?.properties?.info?.sessionID,
                        hasDelta: Boolean(event?.properties?.delta),
                        deltaLen: event?.properties?.delta?.length || 0,
                        partType: event?.properties?.part?.type
                    });

                    if (event.type === 'message.part.updated' && event.properties.part.sessionID === sessionId) {
                        const { part, delta } = event.properties;
                        if (delta) {
                            receivedDelta = true;
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            scheduleIdleTimer();
                            if (!firstDeltaAt) {
                                firstDeltaAt = Date.now();
                                logDebug('SSE first delta', {
                                    sessionId,
                                    ms: firstDeltaAt - startedAt,
                                    type: part.type
                                });
                            }
                            if (part.type === 'reasoning') {
                                reasoning += delta;
                                if (onDelta) onDelta(delta, true);
                            } else {
                                content += delta;
                                if (onDelta) onDelta(delta, false);
                            }
                            deltaChars += delta.length;
                        }
                    }
                    if (event.type === 'message.updated' &&
                        event.properties.info.sessionID === sessionId &&
                        event.properties.info.finish === 'stop') {
                        if (!finished) {
                            finished = true;
                            clearTimeout(timeoutId);
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            if (idleTimer) clearTimeout(idleTimer);
                            logDebug('SSE completed', {
                                sessionId,
                                ms: Date.now() - startedAt,
                                deltaChars,
                                finalContentLen: content.length,
                                finalReasoningLen: reasoning.length
                            });
                            resolve({ content, reasoning });
                        }
                        break;
                    }
                }
            } catch (e) {
                logDebug('SSE stream error', { error: e.message, sessionId });
                if (!finished) {
                    finished = true;
                    clearTimeout(timeoutId);
                    if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                    if (idleTimer) clearTimeout(idleTimer);
                    reject(e);
                }
            }
        })();
    });

    try {
        return await finishPromise;
    } finally {
        controller.abort();
    }
}
