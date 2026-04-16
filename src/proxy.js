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
import { buildChatPromptParts, normalizeResponsesMessages } from './message-orchestration.js';
import { promptWithTimeout } from './prompt-executor.js';
import { cleanupConversationFiles, registerConversationCleanup } from './conversation-cleanup.js';
import { createServerRuntime } from './server-runtime.js';
import { getUserFacingHint } from './user-facing-errors.js';
import { buildStartProxyConfig } from './start-proxy-config.js';
import { buildChatCompletionResponse, buildResponsesApiResponse } from './response-builders.js';
import { buildChatStreamChunk, buildChatStreamUsageChunk } from './stream-builders.js';
import { buildToolStatusEvent } from './tool-status-builders.js';
import { cleanupSessionLater } from './session-cleanup.js';
import { extractConversationKey } from './session-store.js';
import { sanitizeAssistantPayload, detectCorruptedUpstreamContent } from './output-sanitizer.js';
import { buildResponsesCreatedEvent, buildResponsesMessageOutputAddedEvent, buildResponsesContentPartAddedEvent, buildResponsesReasoningOutputAddedEvent, buildResponsesReasoningDeltaEvent, buildResponsesTextDeltaEvent, buildResponsesReasoningDoneEvent, buildResponsesReasoningItemDoneEvent, buildResponsesTextDoneEvent, buildResponsesContentPartDoneEvent, buildResponsesMessageItemDoneEvent, buildResponsesCompletedEvent } from './responses-stream-builders.js';
import { ensureModelSession, buildPromptParams } from './session-preparation.js';
import { createLatencyTracker } from './latency-tracker.js';
import { getLatencySummary } from './latency-summary.js';

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
        TRACE,
        DISABLE_TOOLS,
        TOOL_POLICY,
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
    const toolOverridesRuntime = createToolOverridesRuntime(client, DISABLE_TOOLS, (...args) => logTrace(...args), TOOL_POLICY);
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
                return res.status(401).json({ error: { message: 'Unauthorized', type: 'authentication_error', retryable: false, hint: 'Authentication failed. Please check the API key configuration.' } });
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

    const logTrace = (...args) => {
        if (TRACE) {
            console.log('[Proxy][Trace]', ...args);
        }
    };

    const runConversationCleanup = () => cleanupConversationFiles({
        autoCleanupConversations: AUTO_CLEANUP_CONVERSATIONS,
        opencodeHomeBase: OPENCODE_HOME_BASE,
        cleanupMaxAgeMs: CLEANUP_MAX_AGE_MS,
        logDebug
    });

    registerConversationCleanup({
        autoCleanupConversations: AUTO_CLEANUP_CONVERSATIONS,
        cleanupIntervalMs: CLEANUP_INTERVAL_MS,
        runCleanup: runConversationCleanup,
        logDebug
    });

    // Chat completions endpoint
async function handleChatCompletions(req, res, config, client, REQUEST_TIMEOUT_MS) {
                let sessionId = null;
                let conversationKey = '';
                let eventStream = null;
                let stream = false;
                let pID = 'opencode';
                let mID = 'kimi-k2.5-free';
                let id = `chatcmpl-${Date.now()}`;
                let insideReasoning = false;
                let keepaliveInterval = null;
                const { requestId, log } = createRequestLogger(req, res);
                const latency = createLatencyTracker(log, { route: '/v1/chat/completions', stream: Boolean(stream) });

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
                    conversationKey = extractConversationKey(req);

                    const prepared = await ensureModelSession(config, {
                        client,
                        resolveRequestedModel,
                        ensureBackend,
                        backendState,
                        checkHealth,
                        resolveOpencodePath,
                        STARTUP_WAIT_ITERATIONS,
                        STARTUP_WAIT_INTERVAL_MS,
                        STARTING_WAIT_ITERATIONS,
                        STARTING_WAIT_INTERVAL_MS,
                        logDebug: (...args) => logDebug(...args),
                        model,
                        log,
                        conversationKey,
                        sessionLogLabel: 'Session created'
                    });
                    pID = prepared.providerID;
                    mID = prepared.modelID;
                    sessionId = prepared.sessionId;
                    latency.checkpoint('session_ready', { model: `${pID}/${mID}`, sessionId });

                    const { parts, system: systemMsg, fullPromptText, lastUserMsg } = await buildChatPromptParts(messages, {
                        getImageDataUri,
                        maxImageBytes: MAX_IMAGE_BYTES,
                        allowPrivateHosts: ALLOW_PRIVATE_IMAGE_HOSTS
                    });
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

                    id = `chatcmpl-${Date.now()}`;
                    insideReasoning = false;
                    keepaliveInterval = null;
                    let completionTokens = 0;
                    let reasoningTokens = 0;

                    const promptParams = buildPromptParams({
                        sessionId,
                        providerID: pID,
                        modelID: mID,
                        system: systemWithGuard,
                        parts,
                        max_tokens: requestParams.max_tokens,
                        temperature: requestParams.temperature,
                        top_p: requestParams.top_p,
                        stop: requestParams.stop
                    });
                    const toolOverrides = await getToolOverrides();
                    if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                        promptParams.body.tools = toolOverrides;
                    }

                    res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    const toolsActuallyEnabled = !DISABLE_TOOLS && TOOL_POLICY !== 'off';
                    if (stream) {
                        const filterContentDelta = createToolCallFilter(DISABLE_TOOLS);
                        const filterReasoningDelta = createToolCallFilter(DISABLE_TOOLS);
                        let streamedContent = '';
                        let streamedReasoning = '';
                        let streamCorrupted = false;
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
                            if (streamCorrupted) return;
                            if (detectCorruptedUpstreamContent(filtered)) {
                                streamCorrupted = true;
                                logDebug('Suppressed corrupted stream delta', { sessionId, isReasoning, preview: filtered.slice(0, 120) });
                                const fallbackMessage = '[Tool workflow failed. Please retry or switch to stable mode.]';
                                if (insideReasoning) {
                                    res.write(`data: ${JSON.stringify(buildChatStreamChunk({
                                        id,
                                        model: `${pID}/${mID}`,
                                        content: '\n</think>\n\n'
                                    }))}\n\n`);
                                    insideReasoning = false;
                                }
                                streamedContent += fallbackMessage;
                                completionTokens += Math.ceil(fallbackMessage.length / 4);
                                res.write(`data: ${JSON.stringify(buildChatStreamChunk({
                                    id,
                                    model: `${pID}/${mID}`,
                                    content: fallbackMessage
                                }))}\n\n`);
                                return;
                            }
                            latency.markFirstDelta({ model: `${pID}/${mID}`, sessionId, isReasoning });
                            if (isReasoning) {
                                if (!insideReasoning) {
                                    res.write(`data: ${JSON.stringify(buildChatStreamChunk({
                                        id,
                                        model: `${pID}/${mID}`,
                                        content: '<think>\n'
                                    }))}\n\n`);
                                    insideReasoning = true;
                                }
                                streamedReasoning += filtered;
                                reasoningTokens += Math.ceil(filtered.length / 4);
                            } else {
                                if (insideReasoning) {
                                    res.write(`data: ${JSON.stringify(buildChatStreamChunk({
                                        id,
                                        model: `${pID}/${mID}`,
                                        content: '\n</think>\n\n'
                                    }))}\n\n`);
                                    insideReasoning = false;
                                }
                                streamedContent += filtered;
                                completionTokens += Math.ceil(filtered.length / 4);
                            }
                            const chunk = buildChatStreamChunk({
                                id,
                                model: `${pID}/${mID}`,
                                content: filtered
                            });
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        };

                        const emitToolStatus = (stage, message, error = undefined) => {
                            res.write(`data: ${JSON.stringify(buildToolStatusEvent({
                                sequenceNumber: Date.now(),
                                stage,
                                message,
                                error
                            }))}

`);
                        };

                        if (toolsActuallyEnabled) emitToolStatus('starting', 'Starting tool-enabled generation');
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
                            (...args) => logTrace(...args),
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            sendDelta,
                            DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                            DEFAULT_EVENT_IDLE_TIMEOUT_MS
                        );
                            const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                            const promptStart = Date.now();
                            client.session.prompt(promptParams).catch(err => logDebug('Prompt error:', err.message));
                            if (toolsActuallyEnabled) emitToolStatus('running', 'Tool-enabled generation in progress');
                            collected = await safeCollect;
                        } catch (e) {
                            logDebug('Stream error:', e.message);
                        }

                        if (collected && collected.__error) {
                            if (clientDisconnected) {
                                logDebug('Client disconnected before fallback', { sessionId });
                                return;
                            }
                            if (toolsActuallyEnabled) emitToolStatus('failed', 'Tool-enabled stream failed, falling back to polling');
                            logDebug('SSE collect error, falling back to polling', {
                                sessionId,
                                error: collected.__error?.message
                            });
                            const { content, reasoning, error } = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
                        latency.markFirstDelta({ model: `${pID}/${mID}`, sessionId, via: 'polling_fallback' });
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
                            if (toolsActuallyEnabled) emitToolStatus('running', 'No stream data yet, polling for completion');
                            logDebug('Fallback to polling after no SSE data', { sessionId, suspectedUpstreamIssue: true });
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
                            if (toolsActuallyEnabled) emitToolStatus('running', 'Stream idle, polling for completion');
                            logDebug('SSE idle timeout, polling for completion', { sessionId, suspectedUpstreamIssue: !collected.receivedDelta });
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
                            logDebug('SSE returned empty, falling back to polling', { sessionId, suspectedUpstreamIssue: true });
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
                            res.write(`data: ${JSON.stringify(buildChatStreamChunk({
                                id,
                                model: `${pID}/${mID}`,
                                content: '\n</think>\n\n'
                            }))}\n\n`);
                        }

                        res.write(`data: ${JSON.stringify(buildChatStreamChunk({
                            id,
                            model: `${pID}/${mID}`,
                            finishReason: 'stop'
                        }))}\n\n`);

                        if (keepaliveInterval) clearInterval(keepaliveInterval);
                        
                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                        const totalTokens = promptTokens + completionTokens + reasoningTokens;
                        
                        res.write(`data: ${JSON.stringify(buildChatStreamUsageChunk({
                            id,
                            promptTokens,
                            completionTokens,
                            reasoningTokens
                        }))}\n\n`);
                        if (toolsActuallyEnabled) emitToolStatus('completed', 'Tool-enabled generation completed');
                        res.write('data: [DONE]\n\n');
                        latency.finalize({ sessionId, model: `${pID}/${mID}`, via: 'stream' });
                        res.end();
                    } else {
                        const promptSentAt = Date.now();
                        const promptResult = await promptWithTimeout(client, (...args) => logDebug(...args), sleep, promptParams, REQUEST_TIMEOUT_MS);
                        log('Prompt sent', { sessionId, phase: 'non-stream' });
                        latency.checkpoint('prompt_sent', { model: `${pID}/${mID}`, sessionId, stream: false });

                        let content = '';
                        let reasoning = '';
                        const promptParts = promptResult?.data?.parts || promptResult?.parts || [];
                        if (Array.isArray(promptParts) && promptParts.length) {
                            content = promptParts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
                            reasoning = promptParts.filter((part) => part.type === 'reasoning').map((part) => part.text || '').join('\n');
                            latency.markFirstDelta({ model: `${pID}/${mID}`, sessionId, via: 'non_stream_prompt_result' });
                        }

                        let error = null;
                        if (!content && !reasoning) {
                            const polled = await pollForAssistantResponse(client, (...args) => logDebug(...args), sleep, sessionId, REQUEST_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, promptSentAt);
                            content = polled.content || '';
                            reasoning = polled.reasoning || '';
                            error = polled.error || null;
                        }

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
                        const sanitized = sanitizeAssistantPayload({ content: safeContent, reasoning: safeReasoning });
                        if (sanitized.corrupted) {
                            return res.status(502).json({ error: sanitized.error });
                        }

                        const built = buildChatCompletionResponse({
                            model: `${pID}/${mID}`,
                            content: sanitized.content,
                            reasoning: sanitized.reasoning,
                            fullPromptText
                        });

                        res.json(built.body);
                        latency.finalize({ sessionId, model: `${pID}/${mID}`, via: 'non_stream_prompt_result' });
                        log('Request complete', {
                            sessionId,
                            phase: 'non-stream',
                            promptTokens: built.metrics.promptTokens,
                            completionTokens: built.metrics.completionTokens,
                            totalTokens: built.metrics.totalTokens
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
                        const userHint = getUserFacingHint({ code: error.code, message: errorMessage });
                        res.status(statusCode).json({
                            error: {
                                message: errorMessage,
                                type: error.code || error.constructor.name,
                                retryable: userHint.retryable,
                                hint: userHint.hint,
                                ...(error.availableModels && { available_models: error.availableModels })
                            }
                        });
                    } else if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                        res.end();
                    }
                    if (sessionId) {
                        cleanupSessionLater(client, sessionId, 3000, conversationKey);
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
                const userHint = getUserFacingHint(normalizedError);
                res.status(normalizedError.statusCode || 500).json({
                    error: {
                        message: normalizedError.message,
                        type: normalizedError.code || normalizedError.constructor.name,
                        retryable: userHint.retryable,
                        hint: userHint.hint,
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
            mode: config.MANAGE_BACKEND ? 'managed-backend' : 'external-backend',
            backend,
            latency: getLatencySummary(),
            config: {
                manageBackend: config.MANAGE_BACKEND,
                disableTools: DISABLE_TOOLS,
                toolPolicy: TOOL_POLICY,
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
        proxy: true,
        mode: config.MANAGE_BACKEND ? 'managed-backend' : 'external-backend'
    }));

    app.get('/health/ready', async (req, res) => {
        const backend = await getBackendHealthStatus(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
        if (backend.ok) {
            return res.json({ status: 'ready', ready: true, mode: config.MANAGE_BACKEND ? 'managed-backend' : 'external-backend', backend });
        }
        return res.status(503).json({ status: backend.isStarting ? 'starting' : 'not_ready', ready: false, mode: config.MANAGE_BACKEND ? 'managed-backend' : 'external-backend', backend });
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
            const latency = createLatencyTracker(log, { route: '/v1/responses', stream: Boolean(stream) });

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

            let messages = normalizeResponsesMessages({
                chatMessages,
                prompt,
                input,
                instructions
            });
            const conversationKey = extractConversationKey(req);

            if (!messages.length) {
                log('Responses request rejected', { reason: 'input is required' });
                return res.status(400).json({ error: { message: 'input is required' } });
            }

            const prepared = await ensureModelSession(config, {
                client,
                resolveRequestedModel,
                ensureBackend,
                backendState,
                checkHealth,
                resolveOpencodePath,
                STARTUP_WAIT_ITERATIONS,
                STARTUP_WAIT_INTERVAL_MS,
                STARTING_WAIT_ITERATIONS,
                STARTING_WAIT_INTERVAL_MS,
                logDebug: (...args) => logDebug(...args),
                model,
                log,
                conversationKey,
                sessionLogLabel: 'Responses session created'
            });
            const pID = prepared.providerID;
            const mID = prepared.modelID;
            const sessionId = prepared.sessionId;
            latency.checkpoint('session_ready', { model: `${pID}/${mID}`, sessionId });

            const parts = [];
            let fullPromptText = '';
            for (const msg of messages) {
                if (msg.role === 'system') continue;
                parts.push({ type: 'text', text: msg.content });
                fullPromptText += `${msg.role}: ${msg.content}\n\n`;
            }

            const promptParams = buildPromptParams({
                sessionId,
                providerID: pID,
                modelID: mID,
                system: buildSystemPrompt(instructions, reasoningLevel, {
                    omitSystemPrompt: OMIT_SYSTEM_PROMPT,
                    disableTools: DISABLE_TOOLS,
                    promptMode: PROMPT_MODE
                }),
                parts,
                max_tokens: max_output_tokens,
                temperature,
                top_p
            });

            const toolsActuallyEnabled = !DISABLE_TOOLS && TOOL_POLICY !== 'off';
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
                const emitToolStatus = (stage, message, error = undefined) => emit(buildToolStatusEvent({
                    sequenceNumber: nextSeq(),
                    stage,
                    message,
                    error
                }));

                if (toolsActuallyEnabled) emitToolStatus('starting', 'Starting tool-enabled generation');
                emit(buildResponsesCreatedEvent({
                    responseId,
                    model: `${pID}/${mID}`,
                    sequenceNumber: nextSeq(),
                    meta: {
                        tool_policy: TOOL_POLICY,
                        disable_tools: DISABLE_TOOLS
                    }
                }));

                const filterContentDelta = createToolCallFilter(DISABLE_TOOLS);
                const filterReasoningDelta = createToolCallFilter(DISABLE_TOOLS);
                const ensureOutputScaffold = () => {
                    if (!announcedOutput) {
                        emit(buildResponsesMessageOutputAddedEvent({
                            sequenceNumber: nextSeq(),
                            outputIndex: messageOutputIndex,
                            itemId: outputItemId
                        }));
                        announcedOutput = true;
                    }
                    if (!announcedContent) {
                        emit(buildResponsesContentPartAddedEvent({
                            sequenceNumber: nextSeq(),
                            outputIndex: messageOutputIndex,
                            contentIndex: contentIndex,
                            itemId: outputItemId
                        }));
                        announcedContent = true;
                    }
                };
                const ensureReasoningScaffold = () => {
                    if (!announcedReasoning) {
                        emit(buildResponsesReasoningOutputAddedEvent({
                            sequenceNumber: nextSeq(),
                            outputIndex: reasoningOutputIndex,
                            itemId: reasoningItemId
                        }));
                        announcedReasoning = true;
                    }
                };
                const sendResponsesDelta = (delta, isReasoning = false) => {
                    if (!delta) return;
                    const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                    if (!filtered) return;
                    if (responsesStreamCorrupted) return;
                    if (detectCorruptedUpstreamContent(filtered)) {
                        responsesStreamCorrupted = true;
                        logDebug('Suppressed corrupted responses delta', { sessionId, isReasoning, preview: filtered.slice(0, 120) });
                        const fallbackMessage = '[Tool workflow failed. Please retry or switch to stable mode.]';
                        ensureOutputScaffold();
                        content += fallbackMessage;
                        emit(buildResponsesTextDeltaEvent({
                            sequenceNumber: nextSeq(),
                            outputIndex: messageOutputIndex,
                            contentIndex: contentIndex,
                            itemId: outputItemId,
                            delta: fallbackMessage
                        }));
                        return;
                    }
                    latency.markFirstDelta({ model: `${pID}/${mID}`, sessionId, isReasoning });
                    if (isReasoning) {
                        ensureReasoningScaffold();
                        reasoning += filtered;
                        emit(buildResponsesReasoningDeltaEvent({
                            sequenceNumber: nextSeq(),
                            outputIndex: reasoningOutputIndex,
                            itemId: reasoningItemId,
                            delta: filtered
                        }));
                    } else {
                        ensureOutputScaffold();
                        content += filtered;
                        emit(buildResponsesTextDeltaEvent({
                            sequenceNumber: nextSeq(),
                            outputIndex: messageOutputIndex,
                            contentIndex: contentIndex,
                            itemId: outputItemId,
                            delta: filtered
                        }));
                    }
                };

                let collected = null;
                try {
                    const collectPromise = collectFromEvents(
                        client,
                        (...args) => logTrace(...args),
                        sessionId,
                        REQUEST_TIMEOUT_MS,
                        sendResponsesDelta,
                        DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                        DEFAULT_EVENT_IDLE_TIMEOUT_MS
                    );
                    const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                    client.session.prompt(promptParams).catch(err => logDebug('Responses prompt error:', err.message));
                    if (toolsActuallyEnabled) emitToolStatus('running', 'Tool-enabled generation in progress');
                    latency.checkpoint('prompt_sent', { model: `${pID}/${mID}`, sessionId, stream: true });
                    collected = await safeCollect;
                } catch (e) {
                    if (toolsActuallyEnabled) emitToolStatus('failed', 'Tool-enabled stream failed', { type: 'upstream_tool_execution_error', retryable: true });
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

                if (!announcedOutput) {
                    ensureOutputScaffold();
                }

                if (announcedReasoning) {
                    emit(buildResponsesReasoningDoneEvent({
                        sequenceNumber: nextSeq(),
                        outputIndex: reasoningOutputIndex,
                        itemId: reasoningItemId,
                        text: reasoning
                    }));
                    emit(buildResponsesReasoningItemDoneEvent({
                        sequenceNumber: nextSeq(),
                        outputIndex: reasoningOutputIndex,
                        itemId: reasoningItemId,
                        text: reasoning
                    }));
                }

                if (announcedContent) {
                    emit(buildResponsesTextDoneEvent({
                        sequenceNumber: nextSeq(),
                        outputIndex: messageOutputIndex,
                        contentIndex: contentIndex,
                        itemId: outputItemId,
                        text: content
                    }));
                    emit(buildResponsesContentPartDoneEvent({
                        sequenceNumber: nextSeq(),
                        outputIndex: messageOutputIndex,
                        contentIndex: contentIndex,
                        itemId: outputItemId,
                        text: content
                    }));
                    emit(buildResponsesMessageItemDoneEvent({
                        sequenceNumber: nextSeq(),
                        outputIndex: messageOutputIndex,
                        itemId: outputItemId,
                        text: content
                    }));
                }

                const sanitized = sanitizeAssistantPayload({ content, reasoning });
                if (sanitized.corrupted) {
                    emit(buildResponsesCompletedEvent({
                        sequenceNumber: nextSeq(),
                        response: {
                            id: responseId,
                            object: 'response',
                            created: Math.floor(Date.now() / 1000),
                            model: `${pID}/${mID}`,
                            error: sanitized.error
                        }
                    }));
                    res.write('data: [DONE]\n\n');
                    cleanupSessionLater(client, sessionId, 3000, conversationKey);
                    return res.end();
                }

                const response = buildResponsesApiResponse({
                    id: responseId,
                    model: `${pID}/${mID}`,
                    content: sanitized.content,
                    reasoning: sanitized.reasoning,
                    reasoningLevel,
                    fullPromptText,
                    meta: {
                        tool_policy: TOOL_POLICY,
                        disable_tools: DISABLE_TOOLS
                    }
                });
                emit(buildResponsesCompletedEvent({ sequenceNumber: nextSeq(), response }));
                res.write('data: [DONE]\n\n');
                latency.finalize({ sessionId, model: `${pID}/${mID}`, via: 'stream' });
                cleanupSessionLater(client, sessionId, 3000, conversationKey);
                return res.end();
            }

            latency.checkpoint('prompt_sent', { model: `${pID}/${mID}`, sessionId, stream: false });
            const responseRes = await client.session.prompt(promptParams);
            latency.markFirstDelta({ model: `${pID}/${mID}`, sessionId, via: 'non_stream_response' });
            const responseParts = responseRes.data?.parts || [];
            
            content = responseParts.filter(p => p.type === 'text').map(p => p.text).join('\n');
            reasoning = responseParts.filter(p => p.type === 'reasoning').map(p => p.text).join('\n');

            if (!content && responseRes.data) {
                const data = responseRes.data;
                content = typeof data === 'string' ? data : data?.message || JSON.stringify(data);
            }

            const sanitized = sanitizeAssistantPayload({ content, reasoning });
            if (sanitized.corrupted) {
                cleanupSessionLater(client, sessionId, 3000, conversationKey);
                return res.status(502).json({ error: sanitized.error });
            }

            const response = buildResponsesApiResponse({
                model: `${pID}/${mID}`,
                content: sanitized.content,
                reasoning: sanitized.reasoning,
                reasoningLevel,
                fullPromptText,
                meta: {
                    tool_policy: TOOL_POLICY,
                    disable_tools: DISABLE_TOOLS
                }
            });

            cleanupSessionLater(client, sessionId, 3000, conversationKey);
            latency.finalize({ sessionId, model: `${pID}/${mID}`, via: 'non_stream_response' });

            return res.json(response);
            });
        } catch (error) {
            console.error('[Proxy] Responses API Error:', error.message);
            const normalizedError = normalizeProxyError(error);
            const userHint = getUserFacingHint(normalizedError);
            res.status(normalizedError.statusCode || 500).json({ 
                error: { 
                    message: normalizedError.message,
                    type: normalizedError.code || normalizedError.constructor.name,
                    retryable: userHint.retryable,
                    hint: userHint.hint,
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
    const config = buildStartProxyConfig(options);

    const { app } = createApp(config);

    return createServerRuntime(app, config, {
        backendState,
        ensureBackend,
        checkHealth,
        resolveOpencodePath,
        resolveShutdownGraceMs,
        STARTUP_WAIT_ITERATIONS,
        STARTUP_WAIT_INTERVAL_MS,
        STARTING_WAIT_ITERATIONS,
        STARTING_WAIT_INTERVAL_MS
    });
}
