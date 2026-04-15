import { shouldUpdateActiveModel, markActiveModel } from './active-model-cache.js';
import { getReusableSession, rememberReusableSession } from './session-store.js';

export async function ensureModelSession(config, deps) {
    const {
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
        logDebug,
        model,
        log,
        sessionLogLabel = 'Session created',
        conversationKey = ''
    } = deps;

    const resolvedModel = await resolveRequestedModel(model);
    const providerID = resolvedModel.providerID;
    const modelID = resolvedModel.modelID;
    if (resolvedModel.aliasFrom && log) {
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

    const cacheKey = config.OPENCODE_SERVER_URL;
    const needActiveModelUpdate = shouldUpdateActiveModel(cacheKey, providerID, modelID);

    if (needActiveModelUpdate) {
        try {
            await client.config.update({
                body: {
                    activeModel: { providerID, modelID }
                }
            });
            markActiveModel(cacheKey, providerID, modelID);
            logDebug('Active model update applied', { providerID, modelID });
        } catch (confError) {
            logDebug('Failed to set active model:', confError.message);
        }
    } else {
        logDebug('Active model update skipped', { providerID, modelID });
    }

    const reusable = getReusableSession(conversationKey, {
        serverUrl: config.OPENCODE_SERVER_URL,
        providerID,
        modelID
    });
    if (reusable?.sessionId) {
        if (log) {
            log('Session reused', {
                sessionId: reusable.sessionId,
                model: `${providerID}/${modelID}`,
                conversationKey
            });
        }
        return {
            resolvedModel,
            providerID,
            modelID,
            sessionId: reusable.sessionId,
            reused: true,
            conversationKey
        };
    }

    const sessionRes = await client.session.create();
    const sessionId = sessionRes.data?.id;
    if (!sessionId) throw new Error('Failed to create OpenCode session');

    if (conversationKey) {
        rememberReusableSession(conversationKey, {
            sessionId,
            serverUrl: config.OPENCODE_SERVER_URL,
            providerID,
            modelID,
            createdAt: Date.now()
        });
    }

    if (log) {
        log(sessionLogLabel, { sessionId, model: `${providerID}/${modelID}`, ...(conversationKey ? { conversationKey } : {}) });
    }

    return {
        resolvedModel,
        providerID,
        modelID,
        sessionId,
        reused: false,
        conversationKey
    };
}

export function buildPromptParams({ sessionId, providerID, modelID, system, parts, max_tokens, temperature, top_p, stop }) {
    return {
        path: { id: sessionId },
        body: {
            model: { providerID, modelID },
            ...(system ? { system } : {}),
            parts,
            ...(max_tokens && { max_tokens }),
            ...(temperature !== undefined && { temperature }),
            ...(top_p !== undefined && { top_p }),
            ...(stop && { stop })
        }
    };
}
