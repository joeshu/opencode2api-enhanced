export function createProxyError(message, statusCode = 500, code = 'internal_error', extra = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    Object.assign(error, extra);
    return error;
}

export function normalizeProxyError(error) {
    if (error?.statusCode && error?.code) return error;
    const message = error?.message || 'Unknown error';

    if (message.includes('Unauthorized')) {
        return createProxyError(message, 401, 'authentication_error');
    }

    if (message.includes('Too many concurrent requests')) {
        return createProxyError(message, 429, 'rate_limit_error');
    }

    if (message.includes('prompt_send_timeout')) {
        return createProxyError(message, 504, 'prompt_send_timeout_error');
    }

    if (message.includes('poll_response_timeout')) {
        return createProxyError(message, 504, 'poll_response_timeout_error');
    }

    if (message.includes('stream_request_timeout')) {
        return createProxyError(message, 504, 'stream_request_timeout_error');
    }

    if (message.includes('Backend startup timeout') || message.includes('not ready') || message.includes('warming up')) {
        return createProxyError(message, 503, 'backend_not_ready_error');
    }

    if (message.includes('Request timeout') || message.includes('Timeout')) {
        return createProxyError(message, 504, 'upstream_timeout_error');
    }

    if (message.includes('ECONNREFUSED') || message.includes('network') || message.includes('connect ')) {
        return createProxyError(message, 502, 'upstream_connection_error');
    }

    return createProxyError(message, error?.statusCode || 500, error?.code || 'internal_error', {
        availableModels: error?.availableModels
    });
}
