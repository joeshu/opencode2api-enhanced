import { createProxyError } from './errors.js';

export function createRequestRuntime(maxConcurrentRequests, logDebug) {
    const MAX_CONCURRENT_REQUESTS = Number.isFinite(Number(maxConcurrentRequests)) && Number(maxConcurrentRequests) > 0
        ? Number(maxConcurrentRequests)
        : 8;
    let activeRequests = 0;

    const withRequestSlot = async (requestId, task) => {
        if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
            throw createProxyError(`Too many concurrent requests: limit ${MAX_CONCURRENT_REQUESTS}`, 429, 'rate_limit_exceeded');
        }
        activeRequests += 1;
        try {
            return await task();
        } finally {
            activeRequests = Math.max(0, activeRequests - 1);
        }
    };

    const createRequestLogger = (req, res) => {
        const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (!res.headersSent) {
            res.setHeader('x-request-id', requestId);
        }
        const startedAt = Date.now();
        const log = (event, data = {}) => {
            logDebug(event, {
                requestId,
                elapsedMs: Date.now() - startedAt,
                ...data,
                activeRequests,
                maxConcurrentRequests: MAX_CONCURRENT_REQUESTS
            });
        };
        return { requestId, startedAt, log };
    };

    const getActiveRequests = () => activeRequests;
    const getMaxConcurrentRequests = () => MAX_CONCURRENT_REQUESTS;

    return {
        withRequestSlot,
        createRequestLogger,
        getActiveRequests,
        getMaxConcurrentRequests
    };
}
