export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
export const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS + 30000;
export const DEFAULT_SERVER_HEADERS_TIMEOUT_MS = 65000;
export const DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS = 5000;
export const DEFAULT_SERVER_SOCKET_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS + 60000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10000;

export function resolveServerTimeouts(config, requestTimeoutMs) {
    const SERVER_REQUEST_TIMEOUT_MS = Number.isFinite(Number(config.SERVER_REQUEST_TIMEOUT_MS)) && Number(config.SERVER_REQUEST_TIMEOUT_MS) > 0
        ? Number(config.SERVER_REQUEST_TIMEOUT_MS)
        : Math.max(requestTimeoutMs + 30000, DEFAULT_SERVER_REQUEST_TIMEOUT_MS);
    const SERVER_HEADERS_TIMEOUT_MS = Number.isFinite(Number(config.SERVER_HEADERS_TIMEOUT_MS)) && Number(config.SERVER_HEADERS_TIMEOUT_MS) > 0
        ? Number(config.SERVER_HEADERS_TIMEOUT_MS)
        : DEFAULT_SERVER_HEADERS_TIMEOUT_MS;
    const SERVER_KEEPALIVE_TIMEOUT_MS = Number.isFinite(Number(config.SERVER_KEEPALIVE_TIMEOUT_MS)) && Number(config.SERVER_KEEPALIVE_TIMEOUT_MS) > 0
        ? Number(config.SERVER_KEEPALIVE_TIMEOUT_MS)
        : DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS;
    const SERVER_SOCKET_TIMEOUT_MS = Number.isFinite(Number(config.SERVER_SOCKET_TIMEOUT_MS)) && Number(config.SERVER_SOCKET_TIMEOUT_MS) > 0
        ? Number(config.SERVER_SOCKET_TIMEOUT_MS)
        : Math.max(SERVER_REQUEST_TIMEOUT_MS + 30000, DEFAULT_SERVER_SOCKET_TIMEOUT_MS);

    return {
        SERVER_REQUEST_TIMEOUT_MS,
        SERVER_HEADERS_TIMEOUT_MS,
        SERVER_KEEPALIVE_TIMEOUT_MS,
        SERVER_SOCKET_TIMEOUT_MS
    };
}

export function resolveShutdownGraceMs(config) {
    return Number.isFinite(Number(config.SHUTDOWN_GRACE_MS)) && Number(config.SHUTDOWN_GRACE_MS) > 0
        ? Number(config.SHUTDOWN_GRACE_MS)
        : DEFAULT_SHUTDOWN_GRACE_MS;
}
