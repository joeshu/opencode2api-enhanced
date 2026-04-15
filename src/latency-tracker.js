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
    };

    return {
        checkpoint,
        markFirstDelta,
        getStartedAt: () => startedAt,
        getFirstDeltaAt: () => firstDeltaAt
    };
}
