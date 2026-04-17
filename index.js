import { startProxy } from './src/proxy.js';
import { buildStartProxyConfig, normalizeBool } from './src/start-proxy-config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');
let fileConfig = {};

if (fs.existsSync(configPath)) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        fileConfig = JSON.parse(content);
        console.log('[Config] Loaded from config.json');
    } catch (err) {
        console.error('[Config] Error parsing config.json:', err.message);
    }
}

function parseBool(value, fallback) {
    const normalized = normalizeBool(value);
    if (typeof normalized === 'boolean') return normalized;
    if (value === undefined || value === null) return fallback;
    return Boolean(value);
}

// Build base config using the same profile-aware logic as the main proxy
const baseConfig = buildStartProxyConfig({
    PORT: parseInt(process.env.OPENCODE_PROXY_PORT) || parseInt(process.env.PORT) || fileConfig.PORT || 10000,
    API_KEY: process.env.API_KEY || fileConfig.API_KEY || '',
    OPENCODE_PROFILE: process.env.OPENCODE_PROFILE || fileConfig.OPENCODE_PROFILE,
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL || fileConfig.OPENCODE_SERVER_URL || `http://127.0.0.1:${process.env.OPENCODE_SERVER_PORT || 10001}`,
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD || fileConfig.OPENCODE_SERVER_PASSWORD || '',
    MANAGE_BACKEND: parseBool(process.env.OPENCODE_PROXY_MANAGE_BACKEND, parseBool(fileConfig.MANAGE_BACKEND, false)),
    OPENCODE_PATH: process.env.OPENCODE_PATH || fileConfig.OPENCODE_PATH || 'opencode',
    BIND_HOST: process.env.BIND_HOST || fileConfig.BIND_HOST || '0.0.0.0',
    DISABLE_TOOLS: process.env.OPENCODE_DISABLE_TOOLS ?? fileConfig.DISABLE_TOOLS,
    TOOL_POLICY: process.env.OPENCODE_TOOL_POLICY || fileConfig.TOOL_POLICY,
    RESPONSE_REASONING_VISIBILITY: process.env.OPENCODE_RESPONSE_REASONING_VISIBILITY || fileConfig.RESPONSE_REASONING_VISIBILITY,
    USE_ISOLATED_HOME: parseBool(process.env.OPENCODE_USE_ISOLATED_HOME, parseBool(fileConfig.USE_ISOLATED_HOME, false)),
    REQUEST_TIMEOUT_MS: parseInt(process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS) || fileConfig.REQUEST_TIMEOUT_MS,
    SERVER_REQUEST_TIMEOUT_MS: parseInt(process.env.OPENCODE_PROXY_SERVER_REQUEST_TIMEOUT_MS) || fileConfig.SERVER_REQUEST_TIMEOUT_MS,
    SERVER_HEADERS_TIMEOUT_MS: parseInt(process.env.OPENCODE_PROXY_SERVER_HEADERS_TIMEOUT_MS) || fileConfig.SERVER_HEADERS_TIMEOUT_MS,
    SERVER_KEEPALIVE_TIMEOUT_MS: parseInt(process.env.OPENCODE_PROXY_SERVER_KEEPALIVE_TIMEOUT_MS) || fileConfig.SERVER_KEEPALIVE_TIMEOUT_MS,
    SERVER_SOCKET_TIMEOUT_MS: parseInt(process.env.OPENCODE_PROXY_SERVER_SOCKET_TIMEOUT_MS) || fileConfig.SERVER_SOCKET_TIMEOUT_MS,
    SHUTDOWN_GRACE_MS: parseInt(process.env.OPENCODE_PROXY_SHUTDOWN_GRACE_MS) || fileConfig.SHUTDOWN_GRACE_MS,
    ZEN_API_KEY: process.env.OPENCODE_ZEN_API_KEY || fileConfig.ZEN_API_KEY || '',
    MODEL_CACHE_MS: parseInt(process.env.OPENCODE_PROXY_MODEL_CACHE_MS) || fileConfig.MODEL_CACHE_MS,
    MAX_IMAGE_BYTES: parseInt(process.env.OPENCODE_PROXY_MAX_IMAGE_BYTES) || fileConfig.MAX_IMAGE_BYTES,
    ALLOW_PRIVATE_IMAGE_HOSTS: parseBool(process.env.OPENCODE_PROXY_ALLOW_PRIVATE_IMAGE_HOSTS, parseBool(fileConfig.ALLOW_PRIVATE_IMAGE_HOSTS, false)),
    MAX_CONCURRENT_REQUESTS: parseInt(process.env.OPENCODE_PROXY_MAX_CONCURRENT_REQUESTS) || fileConfig.MAX_CONCURRENT_REQUESTS,
    PROMPT_MODE: process.env.OPENCODE_PROXY_PROMPT_MODE || fileConfig.PROMPT_MODE || 'standard',
    OMIT_SYSTEM_PROMPT: parseBool(process.env.OPENCODE_PROXY_OMIT_SYSTEM_PROMPT, parseBool(fileConfig.OMIT_SYSTEM_PROMPT, false)),
    AUTO_CLEANUP_CONVERSATIONS: parseBool(process.env.OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS, parseBool(fileConfig.AUTO_CLEANUP_CONVERSATIONS, false)),
    CLEANUP_INTERVAL_MS: parseInt(process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS) || fileConfig.CLEANUP_INTERVAL_MS,
    CLEANUP_MAX_AGE_MS: parseInt(process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS) || fileConfig.CLEANUP_MAX_AGE_MS,
    OPENAI_COMPAT_PROVIDER_ID: process.env.OPENCODE_OPENAI_COMPAT_PROVIDER_ID || fileConfig.OPENAI_COMPAT_PROVIDER_ID,
    OPENAI_COMPAT_BASE_URL: process.env.OPENCODE_OPENAI_COMPAT_BASE_URL || fileConfig.OPENAI_COMPAT_BASE_URL || process.env.MOONSHOT_BASE_URL,
    OPENAI_COMPAT_API_KEY_ENV: process.env.OPENCODE_OPENAI_COMPAT_API_KEY_ENV || fileConfig.OPENAI_COMPAT_API_KEY_ENV || (process.env.MOONSHOT_API_KEY ? 'MOONSHOT_API_KEY' : undefined),
    OPENAI_COMPAT_MODEL: process.env.OPENCODE_OPENAI_COMPAT_MODEL || fileConfig.OPENAI_COMPAT_MODEL,
    OPENAI_COMPAT_SMALL_MODEL: process.env.OPENCODE_OPENAI_COMPAT_SMALL_MODEL || fileConfig.OPENAI_COMPAT_SMALL_MODEL,
    DEBUG: parseBool(process.env.OPENCODE_PROXY_DEBUG, parseBool(process.env.DEBUG, parseBool(fileConfig.DEBUG, false)))
});

const finalConfig = {
    ...baseConfig,
    DEBUG: parseBool(process.env.OPENCODE_PROXY_DEBUG, parseBool(process.env.DEBUG, parseBool(fileConfig.DEBUG, baseConfig.DEBUG)))
};


// Validate required configuration
if (!finalConfig.OPENCODE_PATH) {
    console.error('[Error] OPENCODE_PATH is not set. Please configure it in config.json or environment variable.');
    process.exit(1);
}

// Check if opencode is available
import { execSync } from 'child_process';
try {
    execSync(`"${finalConfig.OPENCODE_PATH}" --version`, { stdio: 'ignore' });
} catch (e) {
    console.warn(`[Warning] Cannot verify OpenCode installation: ${finalConfig.OPENCODE_PATH}`);
    console.warn('[Warning] Please ensure OpenCode is installed:');
    console.warn('  Windows: npm install -g opencode-ai');
    console.warn('  Linux/macOS: curl -fsSL https://opencode.ai/install | bash');
    console.warn('[Warning] Or specify the full path in config.json:');
    console.warn('  { "OPENCODE_PATH": "C:\\\\Users\\\\YourName\\\\AppData\\\\Roaming\\\\npm\\\\opencode.cmd" }');
}

console.log('[Config] Starting with configuration:');
console.log(`  - Port: ${finalConfig.PORT}`);
console.log(`  - Bind Host: ${finalConfig.BIND_HOST}`);
console.log(`  - Backend: ${finalConfig.OPENCODE_SERVER_URL}`);
console.log(`  - Backend Password: ${finalConfig.OPENCODE_SERVER_PASSWORD ? 'Configured' : 'Not configured'}`);
console.log(`  - OpenCode Path: ${finalConfig.OPENCODE_PATH}`);
console.log(`  - API Key: ${finalConfig.API_KEY ? 'Configured' : 'Not configured (no auth)'}`);
console.log(`  - Zen API Key: ${finalConfig.ZEN_API_KEY ? 'Configured' : 'Not configured'}`);
console.log(`  - Model Cache TTL: ${finalConfig.MODEL_CACHE_MS}ms`);
console.log(`  - Max Image Bytes: ${finalConfig.MAX_IMAGE_BYTES}`);
console.log(`  - Allow Private Image Hosts: ${finalConfig.ALLOW_PRIVATE_IMAGE_HOSTS ? 'Yes' : 'No'}`);
console.log(`  - Max Concurrent Requests: ${finalConfig.MAX_CONCURRENT_REQUESTS}`);
console.log(`  - Disable Tools: ${finalConfig.DISABLE_TOOLS ? 'Yes' : 'No'}`);
console.log(`  - Use Isolated Home: ${finalConfig.USE_ISOLATED_HOME ? 'Yes' : 'No'}`);
console.log(`  - Request Timeout: ${finalConfig.REQUEST_TIMEOUT_MS}ms`);
console.log(`  - Server Request Timeout: ${finalConfig.SERVER_REQUEST_TIMEOUT_MS ?? 'auto'}ms`);
console.log(`  - Server Headers Timeout: ${finalConfig.SERVER_HEADERS_TIMEOUT_MS ?? 'auto'}ms`);
console.log(`  - Server Keep-Alive Timeout: ${finalConfig.SERVER_KEEPALIVE_TIMEOUT_MS ?? 'auto'}ms`);
console.log(`  - Server Socket Timeout: ${finalConfig.SERVER_SOCKET_TIMEOUT_MS ?? 'auto'}ms`);
console.log(`  - Shutdown Grace: ${finalConfig.SHUTDOWN_GRACE_MS}ms`);
console.log(`  - Prompt Mode: ${finalConfig.PROMPT_MODE}`);
console.log(`  - Omit System Prompt: ${finalConfig.OMIT_SYSTEM_PROMPT ? 'Yes' : 'No'}`);
console.log(`  - Auto Cleanup Conversations: ${finalConfig.AUTO_CLEANUP_CONVERSATIONS ? 'Yes' : 'No'}`);
console.log(`  - Cleanup Interval: ${finalConfig.CLEANUP_INTERVAL_MS}ms`);
console.log(`  - Cleanup Max Age: ${finalConfig.CLEANUP_MAX_AGE_MS}ms`);
console.log(`  - Debug: ${finalConfig.DEBUG ? 'Yes' : 'No'}`);

// Start the proxy
try {
    const proxy = startProxy(finalConfig);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n[Shutdown] Received SIGINT, shutting down gracefully...');
        try {
            await proxy.shutdown('SIGINT');
            console.log('[Shutdown] Server closed');
            process.exit(0);
        } catch (error) {
            console.error('[Shutdown] Graceful shutdown failed:', error.message);
            proxy.killBackend();
            process.exit(1);
        }
    });
    
    process.on('SIGTERM', async () => {
        console.log('\n[Shutdown] Received SIGTERM, shutting down gracefully...');
        try {
            await proxy.shutdown('SIGTERM');
            console.log('[Shutdown] Server closed');
            process.exit(0);
        } catch (error) {
            console.error('[Shutdown] Graceful shutdown failed:', error.message);
            proxy.killBackend();
            process.exit(1);
        }
    });
} catch (error) {
    console.error('[Fatal] Failed to start proxy:', error.message);
    process.exit(1);
}
