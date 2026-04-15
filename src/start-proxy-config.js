import { DEFAULT_MAX_IMAGE_BYTES } from './image.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './timeouts.js';

export function normalizeBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
        if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    }
    return undefined;
}

function getProfileDefaults(profile) {
    const mode = String(profile || 'stable').trim().toLowerCase();
    if (mode === 'tools-stable') {
        return {
            DISABLE_TOOLS: false,
            TOOL_POLICY: 'full',
            MAX_CONCURRENT_REQUESTS: 2,
            REQUEST_TIMEOUT_MS: 240000,
            SERVER_REQUEST_TIMEOUT_MS: 270000,
            SERVER_HEADERS_TIMEOUT_MS: 65000,
            SERVER_KEEPALIVE_TIMEOUT_MS: 5000,
            SERVER_SOCKET_TIMEOUT_MS: 300000,
            SHUTDOWN_GRACE_MS: 15000
        };
    }
    if (mode === 'mobile-safe') {
        return {
            DISABLE_TOOLS: false,
            TOOL_POLICY: 'readonly',
            MAX_CONCURRENT_REQUESTS: 4,
            REQUEST_TIMEOUT_MS: 180000,
            SERVER_REQUEST_TIMEOUT_MS: 210000,
            SERVER_HEADERS_TIMEOUT_MS: 65000,
            SERVER_KEEPALIVE_TIMEOUT_MS: 5000,
            SERVER_SOCKET_TIMEOUT_MS: 240000,
            SHUTDOWN_GRACE_MS: 10000
        };
    }
    return {
        DISABLE_TOOLS: true,
        TOOL_POLICY: 'off',
        MAX_CONCURRENT_REQUESTS: 8,
        REQUEST_TIMEOUT_MS: 180000,
        SERVER_REQUEST_TIMEOUT_MS: 210000,
        SERVER_HEADERS_TIMEOUT_MS: 65000,
        SERVER_KEEPALIVE_TIMEOUT_MS: 5000,
        SERVER_SOCKET_TIMEOUT_MS: 240000,
        SHUTDOWN_GRACE_MS: 10000
    };
}

export function buildStartProxyConfig(options) {
    const profile = options.OPENCODE_PROFILE || options.profile || process.env.OPENCODE_PROFILE || 'stable';
    const profileDefaults = getProfileDefaults(profile);

    const disableTools =
        normalizeBool(options.DISABLE_TOOLS) ??
        normalizeBool(options.disableTools) ??
        normalizeBool(process.env.OPENCODE_DISABLE_TOOLS) ??
        profileDefaults.DISABLE_TOOLS;

    const toolPolicy = String(
        options.TOOL_POLICY ||
        options.toolPolicy ||
        process.env.OPENCODE_TOOL_POLICY ||
        profileDefaults.TOOL_POLICY ||
        (disableTools ? 'off' : 'full')
    ).trim().toLowerCase();

    const promptMode = options.PROMPT_MODE || options.promptMode || process.env.OPENCODE_PROXY_PROMPT_MODE || 'standard';
    const cleanupIntervalMs = Number(options.CLEANUP_INTERVAL_MS || process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS || 12 * 60 * 60 * 1000);
    const cleanupMaxAgeMs = Number(options.CLEANUP_MAX_AGE_MS || process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS || 24 * 60 * 60 * 1000);

    return {
        PORT: options.PORT || 10000,
        API_KEY: options.API_KEY || '',
        OPENCODE_PROFILE: profile,
        OPENCODE_SERVER_URL: options.OPENCODE_SERVER_URL || 'http://127.0.0.1:10001',
        OPENCODE_SERVER_PASSWORD: options.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '',
        OPENCODE_PATH: options.OPENCODE_PATH || 'opencode',
        BIND_HOST: options.BIND_HOST || options.bindHost || process.env.OPENCODE_PROXY_BIND_HOST || '0.0.0.0',
        USE_ISOLATED_HOME: typeof options.USE_ISOLATED_HOME === 'boolean'
            ? options.USE_ISOLATED_HOME
            : String(options.USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
              options.USE_ISOLATED_HOME === '1' ||
              String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
              process.env.OPENCODE_USE_ISOLATED_HOME === '1',
        REQUEST_TIMEOUT_MS: Number(options.REQUEST_TIMEOUT_MS || process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS || profileDefaults.REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
        SERVER_REQUEST_TIMEOUT_MS: Number(options.SERVER_REQUEST_TIMEOUT_MS || process.env.OPENCODE_PROXY_SERVER_REQUEST_TIMEOUT_MS || profileDefaults.SERVER_REQUEST_TIMEOUT_MS || 0) || undefined,
        SERVER_HEADERS_TIMEOUT_MS: Number(options.SERVER_HEADERS_TIMEOUT_MS || process.env.OPENCODE_PROXY_SERVER_HEADERS_TIMEOUT_MS || profileDefaults.SERVER_HEADERS_TIMEOUT_MS || 0) || undefined,
        SERVER_KEEPALIVE_TIMEOUT_MS: Number(options.SERVER_KEEPALIVE_TIMEOUT_MS || process.env.OPENCODE_PROXY_SERVER_KEEPALIVE_TIMEOUT_MS || profileDefaults.SERVER_KEEPALIVE_TIMEOUT_MS || 0) || undefined,
        SERVER_SOCKET_TIMEOUT_MS: Number(options.SERVER_SOCKET_TIMEOUT_MS || process.env.OPENCODE_PROXY_SERVER_SOCKET_TIMEOUT_MS || profileDefaults.SERVER_SOCKET_TIMEOUT_MS || 0) || undefined,
        SHUTDOWN_GRACE_MS: Number(options.SHUTDOWN_GRACE_MS || process.env.OPENCODE_PROXY_SHUTDOWN_GRACE_MS || profileDefaults.SHUTDOWN_GRACE_MS || 0) || undefined,
        MANAGE_BACKEND: normalizeBool(options.MANAGE_BACKEND) ??
            normalizeBool(process.env.OPENCODE_PROXY_MANAGE_BACKEND) ??
            false,
        TOOL_POLICY: toolPolicy,
        DISABLE_TOOLS: disableTools,
        DEBUG: String(options.DEBUG || '').toLowerCase() === 'true' ||
            options.DEBUG === '1' ||
            String(process.env.OPENCODE_PROXY_DEBUG || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_PROXY_DEBUG === '1',
        TRACE: String(options.TRACE || '').toLowerCase() === 'true' ||
            options.TRACE === '1' ||
            String(process.env.OPENCODE_PROXY_TRACE || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_PROXY_TRACE === '1',
        ZEN_API_KEY: options.ZEN_API_KEY || process.env.OPENCODE_ZEN_API_KEY || '',
        MODEL_CACHE_MS: Number(options.MODEL_CACHE_MS || process.env.OPENCODE_PROXY_MODEL_CACHE_MS || 60 * 1000),
        MAX_IMAGE_BYTES: Number(options.MAX_IMAGE_BYTES || process.env.OPENCODE_PROXY_MAX_IMAGE_BYTES || DEFAULT_MAX_IMAGE_BYTES),
        ALLOW_PRIVATE_IMAGE_HOSTS: normalizeBool(options.ALLOW_PRIVATE_IMAGE_HOSTS) ??
            normalizeBool(process.env.OPENCODE_PROXY_ALLOW_PRIVATE_IMAGE_HOSTS) ??
            false,
        MAX_CONCURRENT_REQUESTS: Number(options.MAX_CONCURRENT_REQUESTS || process.env.OPENCODE_PROXY_MAX_CONCURRENT_REQUESTS || profileDefaults.MAX_CONCURRENT_REQUESTS || 8),
        PROMPT_MODE: promptMode,
        OMIT_SYSTEM_PROMPT: normalizeBool(options.OMIT_SYSTEM_PROMPT) ??
            normalizeBool(process.env.OPENCODE_PROXY_OMIT_SYSTEM_PROMPT) ??
            promptMode === 'plugin-inject',
        AUTO_CLEANUP_CONVERSATIONS: normalizeBool(options.AUTO_CLEANUP_CONVERSATIONS) ??
            normalizeBool(process.env.OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS) ??
            false,
        CLEANUP_INTERVAL_MS: Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0 ? cleanupIntervalMs : 12 * 60 * 60 * 1000,
        CLEANUP_MAX_AGE_MS: Number.isFinite(cleanupMaxAgeMs) && cleanupMaxAgeMs > 0 ? cleanupMaxAgeMs : 24 * 60 * 60 * 1000,
        OPENCODE_HOME_BASE: options.OPENCODE_HOME_BASE || null
    };
}
