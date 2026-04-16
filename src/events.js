function getEventSessionId(event) {
    return event?.properties?.part?.sessionID ||
        event?.properties?.info?.sessionID ||
        event?.properties?.sessionID ||
        event?.sessionID ||
        null;
}

function getEventDelta(event) {
    return event?.properties?.delta || event?.delta || '';
}

function getEventPartType(event) {
    return event?.properties?.part?.type ||
        event?.part?.type ||
        (event?.type === 'message.part.delta' && event?.properties?.field === 'text'
            ? (String(event?.properties?.messageID || '').includes('reasoning') ? 'reasoning' : null)
            : null);
}

export function extractFromParts(parts) {
    if (!Array.isArray(parts)) return { content: '', reasoning: '' };
    const content = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    const reasoning = parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('');
    return { content, reasoning };
}

export function extractAssistantPayloadFromPromptResult(result) {
    const data = result?.data ?? result;

    if (Array.isArray(data)) {
        for (let i = data.length - 1; i >= 0; i -= 1) {
            const entry = data[i];
            const info = entry?.info;
            if (info?.role && info.role !== 'assistant') continue;
            const extracted = extractFromParts(entry?.parts || []);
            if (extracted.content || extracted.reasoning) return extracted;
        }
    }

    if (data && Array.isArray(data.parts)) {
        return extractFromParts(data.parts);
    }

    return { content: '', reasoning: '' };
}

export async function pollForAssistantResponse(client, logDebug, sleep, sessionId, timeoutMs, intervalMs, minMessageRank = 0) {
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
                const messageRank = info?.time?.completed || info?.time?.created || i;
                if (minMessageRank && messageRank < minMessageRank) continue;
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
                        error: error ? error.name : null,
                        messageRank,
                        minMessageRank
                    });
                    return { content, reasoning, error, messageRank };
                }
            }
        }
        await sleep(intervalMs);
    }
    logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart, minMessageRank });
    throw new Error(`poll_response_timeout after ${timeoutMs}ms`);
}

export async function collectFromEvents(client, logDebug, sessionId, timeoutMs, onDelta, firstDeltaTimeoutMs, idleTimeoutMs) {
    const controller = new AbortController();
    const eventStreamResult = await client.event.subscribe({ signal: controller.signal });
    const eventStream = eventStreamResult.stream;
    let finished = false;
    let content = '';
    let reasoning = '';
    let receivedDelta = false;
    let sawProgressSignal = false;
    let pendingPermission = null;
    let deltaChars = 0;
    let firstDeltaAt = null;
    const startedAt = Date.now();

    const finishPromise = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            if (finished) return;
            finished = true;
            controller.abort();
            reject(new Error(`stream_request_timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const firstDeltaTimer = firstDeltaTimeoutMs
            ? setTimeout(() => {
                if (finished || receivedDelta) return;
                finished = true;
                controller.abort();
                if (pendingPermission) {
                    logDebug('Permission prompt blocked completion', { sessionId, ms: Date.now() - startedAt, pendingPermission });
                    resolve({ content, reasoning, noData: true, stage: 'permission_asked', permissionAsked: pendingPermission, sawProgressSignal });
                    return;
                }
                logDebug('No event data received', { sessionId, ms: Date.now() - startedAt, sawProgressSignal });
                resolve({ content, reasoning, noData: true, stage: sawProgressSignal ? 'progress_without_payload' : 'first_delta_timeout' });
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
                    const eventSessionId = getEventSessionId(event);
                    const deltaValue = getEventDelta(event);
                    const partType = getEventPartType(event);
                    if (event.type === 'message.part.delta') {
                        logDebug('SSE raw message.part.delta', {
                            sessionId,
                            raw: JSON.stringify(event).slice(0, 2000)
                        });
                    }
                    logDebug('SSE event received', {
                        type: event?.type,
                        sessionId: eventSessionId,
                        hasDelta: Boolean(deltaValue),
                        deltaLen: deltaValue?.length || 0,
                        partType
                    });

                    if ((event.type === 'message.part.updated' || event.type === 'message.part.delta') && eventSessionId === sessionId) {
                        if (partType === 'tool' || partType === 'step-start' || partType === 'step-finish') {
                            sawProgressSignal = true;
                        }
                        const delta = deltaValue;
                        if (delta) {
                            receivedDelta = true;
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            scheduleIdleTimer();
                            if (!firstDeltaAt) {
                                firstDeltaAt = Date.now();
                                logDebug('SSE first delta', {
                                    sessionId,
                                    ms: firstDeltaAt - startedAt,
                                    type: partType || event?.properties?.field || null
                                });
                            }
                            const inferredReasoning = partType === 'reasoning' || event?.properties?.messageID?.includes('reasoning');
                            if (inferredReasoning) {
                                reasoning += delta;
                                if (onDelta) onDelta(delta, true);
                            } else {
                                content += delta;
                                if (onDelta) onDelta(delta, false);
                            }
                            deltaChars += delta.length;
                        }
                    }
                    if (event.type === 'permission.asked') {
                        pendingPermission = event?.properties || { asked: true };
                        sawProgressSignal = true;
                    }
                    if (event.type === 'message.updated' &&
                        event.properties.info.sessionID === sessionId &&
                        event.properties.info.finish === 'stop') {
                        if (!finished) {
                            finished = true;
                            clearTimeout(timeoutId);
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            if (idleTimer) clearTimeout(idleTimer);
                            const emptyCompleted = deltaChars === 0 && content.length === 0 && reasoning.length === 0;
                            logDebug(emptyCompleted ? 'SSE completed without payload' : 'SSE completed', {
                                sessionId,
                                ms: Date.now() - startedAt,
                                deltaChars,
                                finalContentLen: content.length,
                                finalReasoningLen: reasoning.length,
                                emptyCompleted
                            });
                            resolve({ content, reasoning, emptyCompleted });
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
