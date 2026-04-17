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
        Authorization: `Bearer ${apiKey}`
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

export function createOfficialCompatRuntime(config) {
    const baseUrl = String(config.OPENAI_COMPAT_BASE_URL || '').trim().replace(/\/$/, '');
    const apiKeyEnvName = String(config.OPENAI_COMPAT_API_KEY_ENV || '').trim();
    const apiKey = apiKeyEnvName ? String(process.env[apiKeyEnvName] || '').trim() : '';
    const enabled = Boolean(baseUrl && apiKey);

    const callOfficial = async (path, payload) => {
        if (!enabled) {
            throw createProxyError('Official upstream is not configured', 500, 'official_upstream_not_configured');
        }
        const fetchImpl = getFetchImpl();
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method: payload ? 'POST' : 'GET',
            headers: buildOfficialHeaders(apiKey),
            ...(payload ? { body: JSON.stringify(payload) } : {})
        });
        const data = await parseJsonSafe(response);
        if (!response.ok) {
            const message = data?.error?.message || data?.message || `Official upstream error (${response.status})`;
            throw createProxyError(message, response.status, 'official_upstream_error', { data });
        }
        return data;
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
        }
    };
}
