import { createProxyError } from './errors.js';

function getFetchImpl() {
    if (typeof fetch !== 'function') {
        throw new Error('global fetch is unavailable');
    }
    return fetch;
}

function buildOfficialHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'claude-code/1.0',
        'X-Client-Name': 'claude-code'
    };
}

function buildAnthropicHeaders(apiKey) {
    return {
        ...buildOfficialHeaders(apiKey),
        'anthropic-version': '2023-06-01'
    };
}

async function parseJsonSafe(response) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

function toAnthropicMessages(messages = []) {
    return messages.map((msg) => {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        if (Array.isArray(msg.content)) {
            return {
                role,
                content: msg.content.map((item) => {
                    if (item?.type === 'text') return { type: 'text', text: item.text || '' };
                    if (item?.type === 'input_text') return { type: 'text', text: item.text || '' };
                    return { type: 'text', text: item?.text || '' };
                })
            };
        }
        return {
            role,
            content: [{ type: 'text', text: String(msg.content || '') }]
        };
    });
}

function anthropicToOpenAIChat(data, fallbackModel) {
    const text = Array.isArray(data?.content)
        ? data.content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('')
        : '';
    const promptTokens = data?.usage?.input_tokens || 0;
    const completionTokens = data?.usage?.output_tokens || 0;
    return {
        id: `chatcmpl-${data?.id || Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data?.model || fallbackModel,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: data?.stop_reason === 'end_turn' ? 'stop' : 'stop'
        }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
        }
    };
}

export function createOfficialCompatRuntime(config) {
    const baseUrl = String(config.OPENAI_COMPAT_BASE_URL || '').trim().replace(/\/$/, '');
    const apiKeyEnvName = String(config.OPENAI_COMPAT_API_KEY_ENV || '').trim();
    const apiKey = apiKeyEnvName ? String(process.env[apiKeyEnvName] || '').trim() : '';
    const enabled = Boolean(baseUrl && apiKey);

    const callOfficial = async (path, payload, headers = buildOfficialHeaders(apiKey)) => {
        if (!enabled) {
            throw createProxyError('Official upstream is not configured', 500, 'official_upstream_not_configured');
        }
        const fetchImpl = getFetchImpl();
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method: payload ? 'POST' : 'GET',
            headers,
            ...(payload ? { body: JSON.stringify(payload) } : {})
        });
        const data = await parseJsonSafe(response);
        if (!response.ok) {
            const message = data?.error?.message || data?.message || `Official upstream error (${response.status})`;
            throw createProxyError(message, response.status, 'official_upstream_error', { data });
        }
        return data;
    };

    const callOfficialStream = async (path, payload, headers = buildOfficialHeaders(apiKey)) => {
        if (!enabled) {
            throw createProxyError('Official upstream is not configured', 500, 'official_upstream_not_configured');
        }
        const fetchImpl = getFetchImpl();
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const data = await parseJsonSafe(response);
            const message = data?.error?.message || data?.message || `Official upstream error (${response.status})`;
            throw createProxyError(message, response.status, 'official_upstream_error', { data });
        }
        return response;
    };

    return {
        enabled,
        baseUrl,
        callOfficial,
        async listModels() {
            return await callOfficial('/models');
        },
        async chatCompletions(payload) {
            return await callOfficial('/chat/completions', payload);
        },
        async anthropicMessagesFromOpenAIChat(payload) {
            const upstreamModel = String(payload?.model || 'kimi-for-coding').trim() || 'kimi-for-coding';
            const anthropicPayload = {
                model: upstreamModel,
                max_tokens: payload?.max_tokens || 4096,
                messages: toAnthropicMessages(payload?.messages || [])
            };
            const data = await callOfficial('/messages', anthropicPayload, buildAnthropicHeaders(apiKey));
            return anthropicToOpenAIChat(data, upstreamModel);
        },
        async anthropicMessagesStreamFromOpenAIChat(payload, handlers = {}) {
            const upstreamModel = String(payload?.model || 'kimi-for-coding').trim() || 'kimi-for-coding';
            const anthropicPayload = {
                model: upstreamModel,
                max_tokens: payload?.max_tokens || 4096,
                messages: toAnthropicMessages(payload?.messages || []),
                stream: true
            };
            const response = await callOfficialStream('/messages', anthropicPayload, buildAnthropicHeaders(apiKey));
            const reader = response.body?.getReader?.();
            if (!reader) throw createProxyError('Official upstream stream reader unavailable', 500, 'official_stream_unavailable');
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n\n')) >= 0) {
                    const rawEvent = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const lines = rawEvent.split('\n').filter((line) => line.startsWith('data:'));
                    for (const line of lines) {
                        const dataText = line.slice(5).trim();
                        if (!dataText || dataText === '[DONE]') continue;
                        let event;
                        try {
                            event = JSON.parse(dataText);
                        } catch {
                            continue;
                        }
                        handlers.onEvent?.(event, upstreamModel);
                    }
                }
            }
            handlers.onDone?.(upstreamModel);
        }
    };
}
