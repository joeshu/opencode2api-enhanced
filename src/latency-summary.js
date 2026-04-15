const latencySummary = new Map();

function key(route) {
    return route || 'unknown';
}

export function recordLatencySummary(route, payload = {}) {
    latencySummary.set(key(route), {
        recordedAt: Date.now(),
        ...payload
    });
}

export function getLatencySummary() {
    const out = {};
    for (const [route, value] of latencySummary.entries()) {
        out[route] = value;
    }
    return out;
}
