import { recordLatencySummary } from './latency-summary.js';

export function createLatencyTracker(log, baseMeta = {}) {
    const startedAt = Date.now();
    let firstDeltaAt = null;

    const checkpoint = (stage, extra = {}) => {
        log('Latency checkpoint', {
            ...baseMeta,
            stage,
            elapsedMs: Date.now() - startedAt,
            ...extra
        });
    };

    const markFirstDelta = (extra = {}) => {
        if (firstDeltaAt !== null) return;
        firstDeltaAt = Date.now();
        checkpoint('first_delta', extra);
        recordLatencySummary(baseMeta.route, {
            stream: Boolean(baseMeta.stream),
            firstDeltaMs: firstDeltaAt - startedAt,
            sessionId: extra.sessionId || null,
            via: extra.via || null,
            model: extra.model || null
        });
    };

    const finalize = (extra = {}) => {
        recordLatencySummary(baseMeta.route, {
            stream: Boolean(baseMeta.stream),
            firstDeltaMs: firstDeltaAt === null ? null : firstDeltaAt - startedAt,
            totalMs: Date.now() - startedAt,
            sessionId: extra.sessionId || null,
            via: extra.via || null,
            model: extra.model || null
        });
    };

    return {
        checkpoint,
        markFirstDelta,
        finalize,
        getStartedAt: () => startedAt,
        getFirstDeltaAt: () => firstDeltaAt
    };
}
