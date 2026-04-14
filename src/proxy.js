import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createOpencodeClient } from '@opencode-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxyError, normalizeProxyError } from './errors.js';
import { backendState, buildBackendAuthHeaders, checkHealth, getBackendHealthStatus } from './backend-health.js';
import { createRequestRuntime } from './request-runtime.js';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
    DEFAULT_SERVER_HEADERS_TIMEOUT_MS,
    DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS,
    DEFAULT_SERVER_SOCKET_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_GRACE_MS,
    resolveServerTimeouts,
    resolveShutdownGraceMs
} from './timeouts.js';
import { createModelsRuntime } from './models.js';
import { DEFAULT_MAX_IMAGE_BYTES, getImageDataUri } from './image.js';
import { buildSystemPrompt, normalizeReasoningEffort, stripFunctionCalls, createToolCallFilter } from './prompt-utils.js';
import { registerProcessCleanup } from './cleanup.js';
import { createToolOverridesRuntime } from './tool-overrides.js';
import { pollForAssistantResponse, collectFromEvents } from './events.js';
import { resolveOpencodePath } from './opencode-path.js';
import { ensureBackend } from './backend-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
registerProcessCleanup();

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = 120000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 20000;
const DEFAULT_TOOL_TIMEOUT_MS = 600000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create Express app with proper configuration
 */
export function createApp(config) {
    const {
        API_KEY,
        OPENCODE_SERVER_URL,
        OPENCODE_SERVER_PASSWORD,
        REQUEST_TIMEOUT_MS,
        DEBUG,
        DISABLE_TOOLS,
        PROMPT_MODE,
        OMIT_SYSTEM_PROMPT,
        AUTO_CLEANUP_CONVERSATIONS,
        CLEANUP_INTERVAL_MS,
        CLEANUP_MAX_AGE_MS,
        OPENCODE_HOME_BASE
    } = config;

    const app = express();
    const {
        SERVER_REQUEST_TIMEOUT_MS,
        SERVER_HEADERS_TIMEOUT_MS,
        SERVER_KEEPALIVE_TIMEOUT_MS,
        SERVER_SOCKET_TIMEOUT_MS
    } = resolveServerTimeouts(config, REQUEST_TIMEOUT_MS);
    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }));
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

    const clientHeaders = buildBackendAuthHeaders(OPENCODE_SERVER_PASSWORD);
    const client = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL, headers: clientHeaders });
    const modelsRuntime = createModelsRuntime(client, config.MODEL_CACHE_MS);
    const getModelsList = modelsRuntime.getModelsList;
    const resolveRequestedModel = modelsRuntime.resolveRequestedModel;

    const MAX_IMAGE_BYTES = Number.isFinite(Number(config.MAX_IMAGE_BYTES)) && Number(config.MAX_IMAGE_BYTES) > 0
        ? Number(config.MAX_IMAGE_BYTES)
        : DEFAULT_MAX_IMAGE_BYTES;
    const ALLOW_PRIVATE_IMAGE_HOSTS = config.ALLOW_PRIVATE_IMAGE_HOSTS === true;

    const runtime = createRequestRuntime(config.MAX_CONCURRENT_REQUESTS, (...args) => logDebug(...args));
    const withRequestSlot = runtime.withRequestSlot;
    const createRequestLogger = runtime.createRequestLogger;
    const toolOverridesRuntime = createToolOverridesRuntime(client, DISABLE_TOOLS, (...args) => logDebug(...args));
    const getToolOverrides = toolOverridesRuntime.getToolOverrides;

    // Auth middleware
    app.use((req, res, next) => {
        if (
            req.method === 'OPTIONS' ||
            req.path === '/' ||
            req.path === '/health' ||
            req.path === '/health/live' ||
            req.path === '/health/ready'
        ) return next();
        if (API_KEY && API_KEY.trim() !== '') {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
                return res.status(401).json({ error: { message: 'Unauthorized' } });
            }
        }
        next();
    });

    // Models endpoint
    app.get('/v1/models', async (req, res) => {
        const { requestId, log } = createRequestLogger(req, res);
        try {
            const models = await getModelsList();
            log('Models fetched', { count: models.length });
            res.json({ object: 'list', data: models });
        } catch (error) {
            console.error('[Proxy] Model Fetch Error:', error.message);
            log('Model fetch fallback', { error: error.message });
            res.json({ object: 'list', data: [{ id: 'opencode/kimi-k2.5-free', object: 'model' }] });
        }
    });

    const logDebug = (...args) => {
        if (DEBUG) {
            console.log('[Proxy][Debug]', ...args);
        }
    };

    async function promptWithTimeout(promptParams, timeoutMs, retryCount = 2) {
        const attempt = async (retriesLeft) => {
            try {
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
                });
                return Promise.race([client.session.prompt(promptParams), timeoutPromise]);
            } catch (err) {
                if (retriesLeft > 0 && (err.message.includes('timeout') || err.message.includes('network') || err.message.includes('ECONNREFUSED'))) {
                    logDebug('Prompt failed, retrying', { retriesLeft, error: err.message });
                    await sleep(1000);
                    return attempt(retriesLeft - 1);
                }
                throw err;
            }
        };
        return attempt(retryCount);
    }

    const getCleanupRoots = () => {
        const roots = [];
        const add = (dir) => {
            if (!dir) return;
            if (!roots.includes(dir)) roots.push(dir);
        };
        add(OPENCODE_HOME_BASE ? path.join(OPENCODE_HOME_BASE, '.local', 'share', 'opencode', 'storage') : null);
        add('/home/node/.local/share/opencode/storage');
        return roots;
    };

    const cleanupConversationFiles = async () => {
        if (!AUTO_CLEANUP_CONVERSATIONS) return { removed: 0, scanned: 0 };
        const now = Date.now();
        let removed = 0;
        let scanned = 0;
        for (const storageRoot of getCleanupRoots()) {
            for (const sub of ['message', 'session']) {
                const dir = path.join(storageRoot, sub);
                if (!fs.existsSync(dir)) continue;
                let entries = [];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    continue;
                }
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    let stat;
                    try {
                        stat = fs.statSync(full);
                    } catch (e) {
                        continue;
                    }
                    scanned += 1;
                    const mtime = stat.mtimeMs || stat.ctimeMs || now;
                    if (now - mtime < CLEANUP_MAX_AGE_MS) continue;
                    try {
                        fs.rmSync(full, { recursive: true, force: true });
                        removed += 1;
                    } catch (e) {
                        logDebug('Cleanup remove failed', { full, error: e.message });
                    }
                }
            }
        }
        if (removed > 0) {
            logDebug('Conversation cleanup completed', { removed, scanned, maxAgeMs: CLEANUP_MAX_AGE_MS });
        }
        return { removed, scanned };
    };

    if (AUTO_CLEANUP_CONVERSATIONS) {
        setTimeout(() => {
            cleanupConversationFiles().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
        }, 3000);
        const cleanupTimer = setInterval(() => {
            cleanupConversationFiles().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
        }, CLEANUP_INTERVAL_MS);
        if (cleanupTimer.unref) cleanupTimer.unref();
    }

    // Chat completions endpoint
async function handleChatCompletions(req, res, config, client, REQUEST_TIMEOUT_MS) {
                let sessionId = null;
                let eventStream = null;
                let stream = false;
                let pID = 'opencode';
                let mID = 'kimi-k2.5-free';
                let id = `chatcmpl-${Date.now()}`;
                let insideReasoning = false;
                let keepaliveInterval = null;
                const { requestId, log } = createRequestLogger(req, res);

                try {
                    const { messages, model, stream: requestStream, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stop, reasoning_effort, reasoning } = req.body;
                    stream = Boolean(requestStream);
                    if (!messages || !Array.isArray(messages) || messages.length === 0) {
                        return res.status(400).json({ error: { message: 'messages array is required' } });
                    }

                    const reasoningLevel = normalizeReasoningEffort(
                        reasoning_effort || reasoning?.effort,
                        null
                    );

                    const requestParams = {
                        temperature: typeof temperature === 'number' ? temperature : 0.7,
                        max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
                        top_p: typeof top_p === 'number' ? top_p : 1.0,
                        frequency_penalty: typeof frequency_penalty === 'number' ? frequency_penalty : 0,
                        presence_penalty: typeof presence_penalty === 'number' ? presence_penalty : 0,
                        stop: Array.isArray(stop) ? stop : (stop ? [stop] : null),
                        reasoning_effort: reasoningLevel
                    };

                    log('Request params', { temperature: requestParams.temperature, max_tokens: requestParams.max_tokens, top_p: requestParams.top_p, reasoning_effort: reasoningLevel });

                    const resolvedModel = await resolveRequestedModel(model);
                    pID = resolvedModel.providerID;
                    mID = resolvedModel.modelID;
                    if (resolvedModel.aliasFrom) {
                        log('Resolved model alias', { from: resolvedModel.aliasFrom, to: resolvedModel.resolved });
                    }

                    const normalizeMessageContent = (content) => {
                        if (typeof content === 'string') return content;
                        if (Array.isArray(content)) {
                            return content.map((part) => {
                                if (typeof part === 'string') return part;
                                if (part && typeof part.text === 'string') return part.text;
                                return '';
                            }).join('');
                        }
                        if (content && typeof content.text === 'string') return content.text;
                        if (content === null || content === undefined) return '';
                        if (typeof content === 'number' || typeof content === 'boolean') return String(content);
                        return '';
                    };

                    const buildPromptParts = async (rawMessages) => {
                        const parts = [];
                        const systemChunks = [];
                        const userContents = [];
                        
                        for (const m of rawMessages) {
                            const role = (m?.role || 'user').toLowerCase();
                            const content = m?.content;
                            
                            if (role === 'system') {
                                const text = normalizeMessageContent(content);
                                if (text) systemChunks.push(text);
                                continue;
                            }
                            
                            if (!content) continue;
                            
                            if (typeof content === 'string') {
                                if (role === 'user') userContents.push(content);
                                const roleLabel = role.toUpperCase();
                                const nameSuffix = m?.name ? `(${m.name})` : '';
                                parts.push({
                                    type: 'text',
                                    text: `${roleLabel}${nameSuffix}: ${content}`
                                });
                            } else if (Array.isArray(content)) {
                                for (const part of content) {
                                    if (!part) continue;
                                    
                                    if (part.type === 'text') {
                                        const text = part.text || '';
                                        if (role === 'user') userContents.push(text);
                                        const roleLabel = role.toUpperCase();
                                        const nameSuffix = m?.name ? `(${m.name})` : '';
                                        parts.push({
                                            type: 'text',
                                            text: `${roleLabel}${nameSuffix}: ${text}`
                                        });
                                    } else if (part.type === 'image_url') {
                                        const imageUrl = typeof part.image_url === 'string' 
                                            ? part.image_url 
                                            : part.image_url?.url;
                                        if (imageUrl) {
                                            try {
                                                const dataUri = await getImageDataUri(imageUrl, {
                                                    maxImageBytes: MAX_IMAGE_BYTES,
                                                    allowPrivateHosts: ALLOW_PRIVATE_IMAGE_HOSTS
                                                });
                                                const mime = dataUri.split(';')[0].split(':')[1];
                                                parts.push({
                                                    type: 'file',
                                                    mime: mime,
                                                    url: dataUri,
                                                    filename: 'image'
                                                });
                                            } catch (imgErr) {
                                                console.warn('[Proxy] Skipping image due to error:', imgErr.message);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        return {
                            parts,
                            system: systemChunks.join('\n\n'),
                            fullPromptText: parts.map(p => p.text).join('\n\n'),
                            lastUserMsg: userContents[userContents.length - 1] || ''
                        };
                    };

                    const { parts, system: systemMsg, fullPromptText, lastUserMsg } = await buildPromptParts(messages);
                    const systemWithGuard = buildSystemPrompt(systemMsg, requestParams.reasoning_effort, {
                        omitSystemPrompt: OMIT_SYSTEM_PROMPT,
                        disableTools: DISABLE_TOOLS,
                        promptMode: PROMPT_MODE
                    });
                    if (!parts.length) {
                        return res.status(400).json({ error: { message: 'messages must include at least one non-system text message' } });
                    }
                    log('Request start', {
                        model: `${pID}/${mID}`,
                        stream: Boolean(stream),
                        userMessages: messages.length,
                        system: Boolean(systemMsg),
                        lastUserLength: lastUserMsg?.length || 0,
                        parts: parts.length,
                        disableTools: DISABLE_TOOLS
                    });

                    // Ensure backend is running
                    await ensureBackend(config, {
                        backendState,
                        checkHealth,
                        resolveOpencodePath,
                        STARTUP_WAIT_ITERATIONS,
                        STARTUP_WAIT_INTERVAL_MS,
                        STARTING_WAIT_ITERATIONS,
                        STARTING_WAIT_INTERVAL_MS
                    });

                    // Set active model
                    try {
                        await client.config.update({
                            body: {
                                activeModel: { providerID: pID, modelID: mID }
                            }
                        });
                    } catch (confError) {
                        logDebug('Failed to set active model:', confError.message);
                    }

                    // Create session
                    const sessionRes = await client.session.create();
                    sessionId = sessionRes.data?.id;
                    if (!sessionId) throw new Error('Failed to create OpenCode session');
                    log('Session created', { sessionId });

                    id = `chatcmpl-${Date.now()}`;
                    insideReasoning = false;
                    keepaliveInterval = null;
                    let completionTokens = 0;
                    let reasoningTokens = 0;

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            parts: parts,
                            ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
                            ...(requestParams.temperature !== undefined && { temperature: requestParams.temperature }),
                            ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
                            ...(requestParams.stop && { stop: requestParams.stop })
                        }
                    };
                    const toolOverrides = await getToolOverrides();
                    if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                        promptParams.body.tools = toolOverrides;
                    }

                    res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    if (stream) {
                        const filterContentDelta = createToolCallFilter(DISABLE_TOOLS);
                        const filterReasoningDelta = createToolCallFilter(DISABLE_TOOLS);
                        let streamedContent = '';
                        let streamedReasoning = '';
                        insideReasoning = false;
                        keepaliveInterval = null;
                        completionTokens = 0;
                        reasoningTokens = 0;

                        const ensureKeepalive = () => {
                            if (!keepaliveInterval) {
                                keepaliveInterval = setInterval(() => {
                                    if (!res.destroyed && res.writable) {
                                        res.write(': keepalive\n\n');
                                    }
                                }, 10000);
                            }
                        };
                        ensureKeepalive();

                        const sendDelta = (delta, isReasoning = false) => {
                            if (clientDisconnected) return;
                            if (!delta || typeof delta !== 'string') return;
                            const trimmed = delta.trim();
                            if (!trimmed) return;
                            if (!res.writable) {
                                clientDisconnected = true;
                                return;
                            }
                            const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                            if (!filtered) return;
                            if (isReasoning) {
                                if (!insideReasoning) {
                                    res.write(`data: ${JSON.stringify({
                                        id,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: `${pID}/${mID}`,
                                        choices: [{
                                            index: 0,
                                            delta: { content: '<think>\n' },
                                            finish_reason: null
                                        }]
                                    })}\n\n`);
                                    insideReasoning = true;
                                }
                                streamedReasoning += filtered;
                                reasoningTokens += Math.ceil(filtered.length / 4);
                            } else {
                                if (insideReasoning) {
                                    res.write(`data: ${JSON.stringify({
                                        id,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: `${pID}/${mID}`,
                                        choices: [{
                                            index: 0,
                                            delta: { content: '\n</think>\n\n' },
                                            finish_reason: null
                                        }]
                                    })}\n\n`);
                                    insideReasoning = false;
                                }
                                streamedContent += filtered;
                                completionTokens += Math.ceil(filtered.length / 4);
                            }
                            const chunk = {
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{ index: 0, delta: { content: filtered }, finish_reason: null }]
                            };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        };

                        let clientDisconnected = false;
                        res.on('close', () => {
                            clientDisconnected = true;
                            logDebug('Client disconnected', { sessionId });
                            if (keepaliveInterval) clearInterval(keepaliveInterval);
                        });

                        res.on('error', (err) => {
                            clientDisconnected = true;
                            logDebug('Response error', { sessionId, error: err.message });
                        });

                        let collected = null;
                        try {
                            const collectPromise = collectFromEvents(
                            client,
                            (...args) => logDebug(...args),
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            sendDelta,
                            DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                            DEFAULT_EVENT_IDLE_TIMEOUT_MS
                        );
                            const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                            const promptStart = Date.now();
                            client.session.prompt(promptParams).catch(err => logDebug('Prompt error:', err.message));
                            collected = await safeCollect;
                        } catch (e) {
                            logDebug('Stream error:', e.message);
                        }

                        if (collected && collected.__error) {
                            if (clientDisconnected) {
                                logDebug('Client disconnected before fallback', { sessionId });
                                return;
                            }
                            logDebug('SSE collect error, falling back to polling', {
                                sessionId,
                                error: collected.__error?.message
                            });
                            const { content, reasoning, error } = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                const safeReasoning = stripFunctionCalls(reasoning, false, DISABLE_TOOLS);
                                const safeContent = stripFunctionCalls(content, false, DISABLE_TOOLS);
                                if (safeReasoning) sendDelta(safeReasoning, true);
                                if (safeContent) sendDelta(safeContent, false);
                            }
                        } else if (collected && collected.noData) {
                            if (clientDisconnected) {
                                logDebug('Client disconnected before fallback', { sessionId });
                                return;
                            }
                            logDebug('Fallback to polling (stream)', { sessionId });
                            const { content, reasoning, error } = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                const safeReasoning = stripFunctionCalls(reasoning, false, DISABLE_TOOLS);
                                const safeContent = stripFunctionCalls(content, false, DISABLE_TOOLS);
                                if (safeReasoning) sendDelta(safeReasoning, true);
                                if (safeContent) sendDelta(safeContent, false);
                            }
                        } else if (collected && collected.idleTimeout) {
                            if (clientDisconnected) {
                                logDebug('Client disconnected before fallback', { sessionId });
                                return;
                            }
                            logDebug('SSE idle timeout, polling for completion', { sessionId });
                            const { content, reasoning, error } = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                const safeReasoning = stripFunctionCalls(reasoning, false, DISABLE_TOOLS);
                                const safeContent = stripFunctionCalls(content, false, DISABLE_TOOLS);
                                const remainingReasoning = safeReasoning && safeReasoning.startsWith(streamedReasoning)
                                    ? safeReasoning.slice(streamedReasoning.length)
                                    : safeReasoning;
                                const remainingContent = safeContent && safeContent.startsWith(streamedContent)
                                    ? safeContent.slice(streamedContent.length)
                                    : safeContent;
                                if (remainingReasoning) sendDelta(remainingReasoning, true);
                                if (remainingContent) sendDelta(remainingContent, false);
                            }
                        }

                        if (collected && !streamedContent && !streamedReasoning && (collected.reasoning || collected.content)) {
                            if (clientDisconnected) {
                                logDebug('Client disconnected, skipping remaining delta', { sessionId });
                                return;
                            }
                            if (collected.reasoning) sendDelta(collected.reasoning, true);
                            if (collected.content) sendDelta(collected.content, false);
                        }

                        if (!streamedContent && !streamedReasoning) {
                            if (clientDisconnected) {
                                logDebug('Client disconnected before fallback', { sessionId });
                                return;
                            }
                            logDebug('SSE returned empty, falling back to polling', { sessionId });
                            try {
                                const pollResult = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                                const { content: pollContent, reasoning: pollReasoning, error } = pollResult;
                                if (error && !pollContent && !pollReasoning) {
                                    sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                                } else {
                                    const safeReasoning = stripFunctionCalls(pollReasoning || '', false, DISABLE_TOOLS);
                                    const safeContent = stripFunctionCalls(pollContent || '', false, DISABLE_TOOLS);
                                    logDebug('Polling fallback result', {
                                        sessionId,
                                        contentLen: safeContent.length,
                                        reasoningLen: safeReasoning.length
                                    });
                                    if (safeReasoning) sendDelta(safeReasoning, true);
                                    if (safeContent) sendDelta(safeContent, false);
                                }
                            } catch (pollError) {
                                logDebug('Polling fallback error', { sessionId, error: pollError.message });
                                sendDelta(`[Proxy Error] Polling failed: ${pollError.message}`);
                            }
                        } else if (streamedContent || streamedReasoning) {
                            logDebug('SSE stream completed', {
                                sessionId,
                                streamedContentLen: streamedContent.length,
                                streamedReasoningLen: streamedReasoning.length
                            });
                        }

                        if (clientDisconnected) {
                            logDebug('Client disconnected, stopping stream', { sessionId });
                            if (keepaliveInterval) clearInterval(keepaliveInterval);
                            return;
                        }

                        if (insideReasoning) {
                            res.write(`data: ${JSON.stringify({
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{
                                    index: 0,
                                    delta: { content: '\n</think>\n\n' },
                                    finish_reason: null
                                }]
                            })}\n\n`);
                        }

                        if (keepaliveInterval) clearInterval(keepaliveInterval);
                        
                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                        const totalTokens = promptTokens + completionTokens + reasoningTokens;
                        
                        res.write(`data: ${JSON.stringify({ 
                            id, 
                            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                            usage: {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionTokens + reasoningTokens,
                                total_tokens: totalTokens,
                                completion_tokens_details: {
                                    reasoning_tokens: reasoningTokens
                                }
                            }
                        })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                        log('Prompt sent', { sessionId, phase: 'non-stream' });
                        const { content, reasoning, error } = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                        if (error && !content && !reasoning) {
                            return res.status(502).json({
                                error: {
                                    message: error.data?.message || error.message || 'OpenCode provider error',
                                    type: error.name || 'OpenCodeError'
                                }
                            });
                        }
                        const safeContent = stripFunctionCalls(content, true, DISABLE_TOOLS);
                        const safeReasoning = stripFunctionCalls(reasoning, true, DISABLE_TOOLS);

                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                        const completionTokensCalc = Math.ceil((content || '').length / 4);
                        const reasoningTokensCalc = Math.ceil((reasoning || '').length / 4);
                        const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;

                        let finalContent = safeContent;
                        if (safeReasoning) {
                            finalContent = `<think>\n${safeReasoning}\n</think>\n\n${safeContent}`;
                        }

                        res.json({
                            id: `chatcmpl-${Date.now()}`,
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: `${pID}/${mID}`,
                            choices: [{
                                index: 0,
                                message: { role: 'assistant', content: finalContent },
                                finish_reason: 'stop'
                            }],
                            usage: {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionTokensCalc + reasoningTokensCalc,
                                total_tokens: totalTokens,
                                completion_tokens_details: {
                                    reasoning_tokens: reasoningTokensCalc
                                }
                            }
                        });
                        log('Request complete', {
                            sessionId,
                            phase: 'non-stream',
                            promptTokens,
                            completionTokens: completionTokensCalc + reasoningTokensCalc,
                            totalTokens
                        });
                    }
                } catch (error) {
                    console.error('[Proxy] API Error:', error.message);
                    console.error('[Proxy] Error details:', error);
                    log('Request failed', { sessionId, stream, error: error.message, errorType: error.code || error.constructor?.name || 'Error' });

                    if (stream && typeof insideReasoning !== 'undefined' && insideReasoning) {
                        res.write(`data: ${JSON.stringify({
                            id,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: `${pID}/${mID}`,
                            choices: [{
                                index: 0,
                                delta: { content: '\n\n' },
                                finish_reason: null
                            }]
                        })}\n\n`);
                    }

                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    if (!res.headersSent) {
                        let errorMessage = error.message;
                        let statusCode = 500;
                        if (error.statusCode) {
                            statusCode = error.statusCode;
                        }
                        if (error.message && error.message.includes('Request timeout')) {
                            statusCode = 504;
                        }
                        if (error.message && error.message.includes('ENOENT')) {
                            errorMessage = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
                        }
                        res.status(statusCode).json({
                            error: {
                                message: errorMessage,
                                type: error.code || error.constructor.name,
                                ...(error.availableModels && { available_models: error.availableModels })
                            }
                        });
                    } else if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                        res.end();
                    }
                    if (sessionId) {
                        try {
                            await client.session.delete({ path: { id: sessionId } });
                        } catch (e) {
                            console.error('[Proxy] Failed to cleanup session on error:', e.message);
                        }
                    }
                } finally {
                    if (typeof keepaliveInterval !== 'undefined' && keepaliveInterval) clearInterval(keepaliveInterval);
                    if (eventStream && eventStream.close) {
                        eventStream.close();
                    }
                }
}

    app.post('/v1/chat/completions', async (req, res) => {
        const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
            await withRequestSlot(requestId, async () => handleChatCompletions(req, res, config, client, REQUEST_TIMEOUT_MS));
        } catch (error) {
            const normalizedError = normalizeProxyError(error);
            console.error('[Proxy] Request Handler Error:', normalizedError.message);
            if (!res.headersSent) {
                res.status(normalizedError.statusCode || 500).json({
                    error: {
                        message: normalizedError.message,
                        type: normalizedError.code || normalizedError.constructor.name,
                        ...(normalizedError.availableModels && { available_models: normalizedError.availableModels })
                    }
                });
            }
        }
    });

    // Health check
    app.get('/health', async (req, res) => {
        const backend = await getBackendHealthStatus(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
        const status = backend.ok ? 'ok' : (backend.isStarting ? 'starting' : 'degraded');
        res.status(backend.ok ? 200 : 503).json({
            status,
            proxy: true,
            backend,
            config: {
                manageBackend: config.MANAGE_BACKEND,
                disableTools: DISABLE_TOOLS,
                promptMode: PROMPT_MODE,
                autoCleanupConversations: AUTO_CLEANUP_CONVERSATIONS,
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                serverRequestTimeoutMs: SERVER_REQUEST_TIMEOUT_MS,
                serverHeadersTimeoutMs: SERVER_HEADERS_TIMEOUT_MS,
                serverKeepAliveTimeoutMs: SERVER_KEEPALIVE_TIMEOUT_MS,
                serverSocketTimeoutMs: SERVER_SOCKET_TIMEOUT_MS
            }
        });
    });

    app.get('/health/live', (req, res) => res.json({
        status: 'ok',
        proxy: true
    }));

    app.get('/health/ready', async (req, res) => {
        const backend = await getBackendHealthStatus(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
        if (backend.ok) {
            return res.json({ status: 'ready', ready: true, backend });
        }
        return res.status(503).json({ status: backend.isStarting ? 'starting' : 'not_ready', ready: false, backend });
    });

    app.post('/v1/responses', async (req, res) => {
        const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
            await withRequestSlot(requestId, async () => {
            const { requestId, log } = createRequestLogger(req, res);
            const { 
                model, 
                input, 
                reasoning_effort,
                reasoning: requestReasoning,
                max_output_tokens,
                store = true,
                tools = [],
                instructions,
                temperature,
                top_p,
                stream = false,
                messages: chatMessages,
                prompt
            } = req.body;

            const reasoningLevel = normalizeReasoningEffort(
                reasoning_effort || requestReasoning?.effort,
                'medium'
            );

            log('Responses API request', { 
                model, 
                reasoning_effort: reasoning_effort || requestReasoning?.effort,
                reasoningLevel,
                max_output_tokens,
                stream
            });

            let messages = [];
            if (Array.isArray(chatMessages) && chatMessages.length) {
                messages = chatMessages.map((item) => ({
                    role: item?.role || 'user',
                    content: Array.isArray(item?.content)
                        ? item.content.map((part) => {
                            if (typeof part === 'string') return part;
                            if (part?.type === 'input_text' || part?.type === 'text' || typeof part?.text === 'string') return part.text || '';
                            if (part?.type === 'output_text') return part.text || '';
                            return '';
                        }).join('')
                        : typeof item?.content === 'string'
                            ? item.content
                            : item?.content?.text || ''
                })).filter((item) => item.content);
            } else if (typeof prompt === 'string' && prompt.trim()) {
                messages = [{ role: 'user', content: prompt }];
            } else if (typeof input === 'string') {
                messages = [{ role: 'user', content: input }];
            } else if (Array.isArray(input)) {
                for (const item of input) {
                    if (!item) continue;
                    if (item.type === 'message') {
                        const content = Array.isArray(item.content)
                            ? item.content.map((part) => {
                                if (typeof part === 'string') return part;
                                if (part?.type === 'input_text' || part?.type === 'text' || typeof part?.text === 'string') return part.text || '';
                                if (part?.type === 'output_text') return part.text || '';
                                return '';
                            }).join('')
                            : item.content?.text || item.content || '';
                        if (content) {
                            messages.push({
                                role: item.role || 'user',
                                content
                            });
                        }
                    } else if (item.type === 'input_text') {
                        if (item.text) messages.push({ role: 'user', content: item.text });
                    } else if (typeof item.text === 'string' && item.text) {
                        messages.push({ role: item.role || 'user', content: item.text });
                    } else if (typeof item.content === 'string' && item.content) {
                        messages.push({ role: item.role || 'user', content: item.content });
                    } else if (Array.isArray(item.content)) {
                        const content = item.content.map((part) => {
                            if (typeof part === 'string') return part;
                            if (part?.type === 'input_text' || part?.type === 'text' || typeof part?.text === 'string') return part.text || '';
                            if (part?.type === 'output_text') return part.text || '';
                            return '';
                        }).join('');
                        if (content) {
                            messages.push({ role: item.role || 'user', content });
                        }
                    }
                }
            } else if (input && typeof input === 'object') {
                if (input.type === 'message') {
                    const content = Array.isArray(input.content)
                        ? input.content.map((part) => part?.text || '').join('')
                        : input.content?.text || input.content || '';
                    if (content) {
                        messages = [{ role: input.role || 'user', content }];
                    }
                } else if (typeof input.text === 'string' && input.text) {
                    messages = [{ role: input.role || 'user', content: input.text }];
                }
            }

            if (!messages.length) {
                log('Responses request rejected', { reason: 'input is required' });
                return res.status(400).json({ error: { message: 'input is required' } });
            }

            if (instructions) {
                messages.unshift({ role: 'system', content: instructions });
            }

            const resolvedModel = await resolveRequestedModel(model);
            const pID = resolvedModel.providerID;
            const mID = resolvedModel.modelID;
            if (resolvedModel.aliasFrom) {
                log('Resolved model alias', { from: resolvedModel.aliasFrom, to: resolvedModel.resolved });
            }

            await ensureBackend(config, {
                backendState,
                checkHealth,
                resolveOpencodePath,
                STARTUP_WAIT_ITERATIONS,
                STARTUP_WAIT_INTERVAL_MS,
                STARTING_WAIT_ITERATIONS,
                STARTING_WAIT_INTERVAL_MS
            });

            try {
                await client.config.update({
                    body: { activeModel: { providerID: pID, modelID: mID } }
                });
            } catch (e) { }

            const sessionRes = await client.session.create();
            const sessionId = sessionRes.data?.id;
            if (!sessionId) {
                throw new Error('Failed to create OpenCode session');
            }
            log('Responses session created', { sessionId, model: `${pID}/${mID}` });

            const parts = [];
            let fullPromptText = '';
            for (const msg of messages) {
                if (msg.role === 'system') continue;
                parts.push({ type: 'text', text: msg.content });
                fullPromptText += `${msg.role}: ${msg.content}\n\n`;
            }

            const promptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID: pID, modelID: mID },
                    ...(buildSystemPrompt(instructions, reasoningLevel, {
                        omitSystemPrompt: OMIT_SYSTEM_PROMPT,
                        disableTools: DISABLE_TOOLS,
                        promptMode: PROMPT_MODE
                    }) ? { system: buildSystemPrompt(instructions, reasoningLevel, {
                        omitSystemPrompt: OMIT_SYSTEM_PROMPT,
                        disableTools: DISABLE_TOOLS,
                        promptMode: PROMPT_MODE
                    }) } : {}),
                    parts,
                    ...(max_output_tokens && { max_tokens: max_output_tokens }),
                    ...(temperature !== undefined && { temperature }),
                    ...(top_p !== undefined && { top_p })
                }
            };

            let content = '';
            let reasoning = '';
            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                const responseId = `resp_${Date.now()}`;
                const messageOutputIndex = 0;
                const reasoningOutputIndex = 1;
                const contentIndex = 0;
                const outputItemId = `msg_${Date.now()}`;
                const reasoningItemId = 'reasoning-0';
                let sequenceNumber = 0;
                let announcedOutput = false;
                let announcedContent = false;
                let announcedReasoning = false;
                const nextSeq = () => sequenceNumber++;
                const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

                emit({
                    type: 'response.created',
                    sequence_number: nextSeq(),
                    response: { id: responseId, object: 'response', created: Math.floor(Date.now() / 1000), model: `${pID}/${mID}` }
                });

                const filterContentDelta = createToolCallFilter(DISABLE_TOOLS);
                const filterReasoningDelta = createToolCallFilter(DISABLE_TOOLS);
                const ensureOutputScaffold = () => {
                    if (!announcedOutput) {
                        emit({
                            type: 'response.output_item.added',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            item: {
                                id: outputItemId,
                                type: 'message',
                                status: 'in_progress',
                                role: 'assistant',
                                content: []
                            }
                        });
                        announcedOutput = true;
                    }
                    if (!announcedContent) {
                        emit({
                            type: 'response.content_part.added',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            content_index: contentIndex,
                            item_id: outputItemId,
                            part: { type: 'output_text', text: '' }
                        });
                        announcedContent = true;
                    }
                };
                const ensureReasoningScaffold = () => {
                    if (!announcedReasoning) {
                        emit({
                            type: 'response.output_item.added',
                            sequence_number: nextSeq(),
                            output_index: reasoningOutputIndex,
                            item: {
                                id: reasoningItemId,
                                type: 'reasoning',
                                status: 'in_progress',
                                summary: [{ type: 'summary_text', text: '' }]
                            }
                        });
                        announcedReasoning = true;
                    }
                };
                const sendResponsesDelta = (delta, isReasoning = false) => {
                    if (!delta) return;
                    const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                    if (!filtered) return;
                    if (isReasoning) {
                        ensureReasoningScaffold();
                        reasoning += filtered;
                        emit({
                            type: 'response.reasoning_summary_text.delta',
                            sequence_number: nextSeq(),
                            output_index: reasoningOutputIndex,
                            item_id: reasoningItemId,
                            summary_index: 0,
                            delta: filtered
                        });
                    } else {
                        ensureOutputScaffold();
                        content += filtered;
                        emit({
                            type: 'response.output_text.delta',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            content_index: contentIndex,
                            item_id: outputItemId,
                            delta: filtered
                        });
                    }
                };

                let collected = null;
                try {
                    const collectPromise = collectFromEvents(
                        client,
                        (...args) => logDebug(...args),
                        sessionId,
                        REQUEST_TIMEOUT_MS,
                        sendResponsesDelta,
                        DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                        DEFAULT_EVENT_IDLE_TIMEOUT_MS
                    );
                    const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                    client.session.prompt(promptParams).catch(err => logDebug('Responses prompt error:', err.message));
                    collected = await safeCollect;
                } catch (e) {
                    collected = { __error: e };
                }

                if (!content && !reasoning) {
                    const polled = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                    if (polled.error && !polled.content && !polled.reasoning) throw polled.error;
                    if (polled.reasoning) sendResponsesDelta(polled.reasoning, true);
                    if (polled.content) sendResponsesDelta(polled.content, false);
                } else if (collected && collected.idleTimeout) {
                    const polled = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                    const remainingReasoning = polled.reasoning && polled.reasoning.startsWith(reasoning)
                        ? polled.reasoning.slice(reasoning.length)
                        : polled.reasoning;
                    const remainingContent = polled.content && polled.content.startsWith(content)
                        ? polled.content.slice(content.length)
                        : polled.content;
                    if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
                    if (remainingContent) sendResponsesDelta(remainingContent, false);
                } else if (collected && (collected.content || collected.reasoning)) {
                    if (!reasoning && collected.reasoning) sendResponsesDelta(collected.reasoning, true);
                    if (!content && collected.content) sendResponsesDelta(collected.content, false);
                }

                if (announcedReasoning) {
                    emit({
                        type: 'response.reasoning_summary_text.done',
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item_id: reasoningItemId,
                        summary_index: 0,
                        text: reasoning
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item: {
                            id: reasoningItemId,
                            type: 'reasoning',
                            status: 'completed',
                            summary: [{ type: 'summary_text', text: reasoning }]
                        }
                    });
                }

                if (announcedContent) {
                    emit({
                        type: 'response.output_text.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        content_index: contentIndex,
                        item_id: outputItemId,
                        text: content
                    });
                    emit({
                        type: 'response.content_part.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        content_index: contentIndex,
                        item_id: outputItemId,
                        part: { type: 'output_text', text: content }
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        item: {
                            id: outputItemId,
                            type: 'message',
                            status: 'completed',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: content }]
                        }
                    });
                }

                const promptTokens = Math.ceil(fullPromptText.length / 4);
                const completionTokens = Math.ceil(content.length / 4);
                const reasoningTokens = Math.ceil(reasoning.length / 4);
                const response = {
                    id: responseId,
                    object: 'response',
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    reasoning: reasoning ? { effort: reasoningLevel, summary: reasoning.substring(0, 100) } : undefined,
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }],
                    usage: {
                        input_tokens: promptTokens,
                        output_tokens: completionTokens + reasoningTokens,
                        total_tokens: promptTokens + completionTokens + reasoningTokens,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: reasoningTokens }
                    }
                };
                emit({ type: 'response.completed', sequence_number: nextSeq(), response });
                res.write('data: [DONE]\n\n');
                try {
                    await client.session.delete({ path: { id: sessionId } });
                } catch (e) { }
                return res.end();
            }

            const responseRes = await client.session.prompt(promptParams);
            const responseParts = responseRes.data?.parts || [];
            
            content = responseParts.filter(p => p.type === 'text').map(p => p.text).join('\n');
            reasoning = responseParts.filter(p => p.type === 'reasoning').map(p => p.text).join('\n');

            if (!content && responseRes.data) {
                const data = responseRes.data;
                content = typeof data === 'string' ? data : data?.message || JSON.stringify(data);
            }

            const promptTokens = Math.ceil(fullPromptText.length / 4);
            const completionTokens = Math.ceil(content.length / 4);
            const reasoningTokens = Math.ceil(reasoning.length / 4);

            const response = {
                id: `resp_${Date.now()}`,
                object: 'response',
                created: Math.floor(Date.now() / 1000),
                model: `${pID}/${mID}`,
                reasoning: reasoning ? { effort: reasoningLevel, summary: reasoning.substring(0, 100) } : undefined,
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [
                            {
                                type: 'output_text',
                                text: content
                            }
                        ]
                    }
                ],
                usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens + reasoningTokens,
                    total_tokens: promptTokens + completionTokens + reasoningTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: reasoningTokens }
                }
            };

            try {
                await client.session.delete({ path: { id: sessionId } });
            } catch (e) { }

            return res.json(response);
            });
        } catch (error) {
            console.error('[Proxy] Responses API Error:', error.message);
            const normalizedError = normalizeProxyError(error);
            res.status(normalizedError.statusCode || 500).json({ 
                error: { 
                    message: normalizedError.message,
                    type: normalizedError.code || normalizedError.constructor.name,
                    ...(normalizedError.availableModels && { available_models: normalizedError.availableModels })
                } 
            });
        }
    });

    app.use((req, res) => {
        res.status(404).json({
            error: {
                message: `Route not found: ${req.method} ${req.path}`,
                type: 'not_found_error'
            }
        });
    });

    return { app, client };
}

/**
 * Starts the OpenCode-to-OpenAI Proxy server.
 */
export function startProxy(options) {
    const normalizeBool = (value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value === 1;
        if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
            if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
        }
        return undefined;
    };

    const disableTools =
        normalizeBool(options.DISABLE_TOOLS) ??
        normalizeBool(options.disableTools) ??
        normalizeBool(process.env.OPENCODE_DISABLE_TOOLS) ??
        false;

    const promptMode = options.PROMPT_MODE || options.promptMode || process.env.OPENCODE_PROXY_PROMPT_MODE || 'standard';
    const cleanupIntervalMs = Number(options.CLEANUP_INTERVAL_MS || process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS || 12 * 60 * 60 * 1000);
    const cleanupMaxAgeMs = Number(options.CLEANUP_MAX_AGE_MS || process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS || 24 * 60 * 60 * 1000);

    const config = {
        PORT: options.PORT || 10000,
        API_KEY: options.API_KEY || '',
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
        REQUEST_TIMEOUT_MS: Number(options.REQUEST_TIMEOUT_MS || process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
        MANAGE_BACKEND: normalizeBool(options.MANAGE_BACKEND) ??
            normalizeBool(process.env.OPENCODE_PROXY_MANAGE_BACKEND) ??
            true,
        DISABLE_TOOLS: disableTools,
        DEBUG: String(options.DEBUG || '').toLowerCase() === 'true' ||
            options.DEBUG === '1' ||
            String(process.env.OPENCODE_PROXY_DEBUG || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_PROXY_DEBUG === '1',
        ZEN_API_KEY: options.ZEN_API_KEY || process.env.OPENCODE_ZEN_API_KEY || '',
        MODEL_CACHE_MS: Number(options.MODEL_CACHE_MS || process.env.OPENCODE_PROXY_MODEL_CACHE_MS || 60 * 1000),
        MAX_IMAGE_BYTES: Number(options.MAX_IMAGE_BYTES || process.env.OPENCODE_PROXY_MAX_IMAGE_BYTES || DEFAULT_MAX_IMAGE_BYTES),
        ALLOW_PRIVATE_IMAGE_HOSTS: normalizeBool(options.ALLOW_PRIVATE_IMAGE_HOSTS) ??
            normalizeBool(process.env.OPENCODE_PROXY_ALLOW_PRIVATE_IMAGE_HOSTS) ??
            false,
        MAX_CONCURRENT_REQUESTS: Number(options.MAX_CONCURRENT_REQUESTS || process.env.OPENCODE_PROXY_MAX_CONCURRENT_REQUESTS || 8),
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

    const { app } = createApp(config);
    
    const server = app.listen(config.PORT, config.BIND_HOST, async () => {
        console.log(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
        try {
            await ensureBackend(config, {
                backendState,
                checkHealth,
                resolveOpencodePath,
                STARTUP_WAIT_ITERATIONS,
                STARTUP_WAIT_INTERVAL_MS,
                STARTING_WAIT_ITERATIONS,
                STARTING_WAIT_INTERVAL_MS
            });
        } catch (error) {
            console.error('[Proxy] Backend warmup failed:', error.message);
        }
    });

    server.requestTimeout = config.SERVER_REQUEST_TIMEOUT_MS;
    server.headersTimeout = config.SERVER_HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = config.SERVER_KEEPALIVE_TIMEOUT_MS;
    server.setTimeout(config.SERVER_SOCKET_TIMEOUT_MS, (socket) => {
        try {
            socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
        } catch (e) {
            socket.destroy();
        }
    });
    server.on('clientError', (err, socket) => {
        if (!socket || socket.destroyed) return;
        const code = err?.code || 'client_error';
        const body = JSON.stringify({
            error: {
                message: code === 'HPE_HEADER_OVERFLOW' ? 'Request headers too large' : 'Invalid HTTP request',
                type: code === 'HPE_HEADER_OVERFLOW' ? 'headers_overflow_error' : 'bad_request_error'
            }
        });
        try {
            socket.end(
                `HTTP/1.1 ${code === 'HPE_HEADER_OVERFLOW' ? 431 : 400} ${code === 'HPE_HEADER_OVERFLOW' ? 'Request Header Fields Too Large' : 'Bad Request'}\r\n` +
                'Content-Type: application/json\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                'Connection: close\r\n\r\n' +
                body
            );
        } catch (e) {
            socket.destroy();
        }
    });

    const killBackend = () => {
        const state = backendState.get(config.OPENCODE_SERVER_URL);
        if (state && state.process) {
            state.process.kill();
        }
        if (state && state.jailRoot && process.platform !== 'win32') {
            try {
                fs.rmSync(state.jailRoot, { recursive: true, force: true });
            } catch (e) { }
        }
    };

    const shutdown = (reason = 'shutdown') => new Promise((resolve) => {
        const graceMs = resolveShutdownGraceMs(config);
        let settled = false;
        const finalize = () => {
            if (settled) return;
            settled = true;
            killBackend();
            resolve();
        };
        const forceTimer = setTimeout(() => {
            console.warn(`[Shutdown] Grace period exceeded after ${graceMs}ms (${reason}), force closing active connections`);
            try {
                server.closeAllConnections?.();
            } catch (e) { }
            try {
                server.closeIdleConnections?.();
            } catch (e) { }
            finalize();
        }, graceMs);
        if (forceTimer.unref) forceTimer.unref();
        server.close(() => {
            clearTimeout(forceTimer);
            finalize();
        });
    });

    return {
        server,
        killBackend,
        shutdown
    };
}
