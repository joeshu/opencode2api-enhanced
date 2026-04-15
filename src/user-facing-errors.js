export function getUserFacingHint(errorLike) {
    const type = errorLike?.code || errorLike?.type || '';
    const message = errorLike?.message || '';

    if (type === 'authentication_error' || message.includes('Unauthorized')) {
        return {
            retryable: false,
            hint: 'Authentication failed. Please check the API key configuration.'
        };
    }
    if (type === 'rate_limit_error') {
        return {
            retryable: true,
            hint: 'Too many requests are being processed at once. Please retry shortly.'
        };
    }
    if (type === 'prompt_send_timeout_error') {
        return {
            retryable: true,
            hint: 'The backend took too long to accept the prompt. Please retry shortly.'
        };
    }
    if (type === 'poll_response_timeout_error') {
        return {
            retryable: true,
            hint: 'The backend accepted the prompt but no final response was collected in time. Please retry.'
        };
    }
    if (type === 'stream_request_timeout_error') {
        return {
            retryable: true,
            hint: 'The stream did not complete in time. Please retry or switch to a non-streaming request.'
        };
    }
    if (type === 'upstream_tool_execution_error') {
        return {
            retryable: true,
            hint: 'The tool-enabled backend failed before producing a clean answer. Please retry or switch to stable mode.'
        };
    }
    if (type === 'backend_not_ready_error') {
        return {
            retryable: true,
            hint: 'The OpenCode backend is not ready yet. Check /health/ready or retry shortly.'
        };
    }
    if (type === 'upstream_connection_error' || message.includes('ECONNREFUSED') || message.includes('connect ')) {
        return {
            retryable: true,
            hint: 'The upstream backend may still be warming up or temporarily unavailable. Please retry shortly.'
        };
    }
    if (type === 'upstream_timeout_error' || message.includes('Request timeout') || message.includes('Timeout')) {
        return {
            retryable: true,
            hint: 'The request timed out. The model may be slow to respond or the network may be unstable.'
        };
    }
    if (type === 'model_not_found') {
        return {
            retryable: false,
            hint: 'The requested model is unavailable. Refresh the model list or switch to another model.'
        };
    }
    if (type === 'invalid_request_error' || type === 'invalid_image_url' || type === 'image_too_large') {
        return {
            retryable: false,
            hint: 'The request payload is invalid or contains unsupported media.'
        };
    }
    if (message.includes('warming up') || message.includes('not ready')) {
        return {
            retryable: true,
            hint: 'The backend is still warming up. Please wait a moment and retry.'
        };
    }
    return {
        retryable: true,
        hint: 'The request failed. Please retry. If the problem persists, check backend readiness and network stability.'
    };
}
