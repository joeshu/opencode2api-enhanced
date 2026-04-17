function inferModelCapabilities(modelId) {
    const id = String(modelId || '').toLowerCase();
    return {
        supports_streaming: true,
        supports_reasoning: true,
        supports_tools: !id.includes('no-tools'),
        supports_images: false
    };
}

function buildModelAliases(fullId) {
    const id = String(fullId || '');
    const [, modelId = id] = id.split('/');
    const aliases = [id, modelId];
    const normalized = modelId.replace(/^gpt(\d)/i, 'gpt-$1');
    if (!aliases.includes(normalized)) aliases.push(normalized);

    const lowerModelId = modelId.toLowerCase();
    const codingAliases = [
        'kimi-for-coding',
        'kimi coding',
        'kimi-coding',
        'kimi_code',
        'kimi-code'
    ];

    if (lowerModelId.startsWith('kimi')) {
        codingAliases.forEach((alias) => {
            if (!aliases.includes(alias)) aliases.push(alias);
        });
    }

    return aliases;
}

function normalizeModelID(modelID) {
    if (!modelID || typeof modelID !== 'string') return modelID;
    const trimmed = modelID.trim();
    const lower = trimmed.toLowerCase();
    const aliasMap = {
        'gpt5-nano': 'gpt-5-nano',
        'kimi for coding': 'kimi-for-coding',
        'kimi-coding': 'kimi-for-coding',
        'kimi_code': 'kimi-for-coding',
        'kimi-code': 'kimi-for-coding'
    };
    return aliasMap[lower] || trimmed.replace(/^gpt(\d)/i, 'gpt-$1').replace(/^o(\d)/i, 'o$1');
}

function scoreKimiCodingCandidate(model) {
    const id = String(model?.id || '').toLowerCase();
    const [, modelId = id] = id.split('/');
    let score = 0;
    if (model?.owned_by === 'opencode') score += 50;
    if (modelId.startsWith('kimi')) score += 100;
    if (modelId.includes('coding') || modelId.includes('code')) score += 80;
    if (modelId.includes('k2.6')) score += 30;
    if (modelId.includes('k2.5')) score += 25;
    if (modelId.includes('k2')) score += 20;
    if (modelId.includes('free')) score += 5;
    return score;
}

function resolveSpecialModelAlias(models, providerID, modelID, originalModelID) {
    const normalized = String(modelID || '').toLowerCase();
    if (normalized !== 'kimi-for-coding') return null;

    const sameProvider = models.filter((m) => m.owned_by === providerID);
    const pool = sameProvider.length > 0 ? sameProvider : models;
    const kimiCandidates = pool.filter((m) => String(m.id || '').toLowerCase().includes('/kimi'));
    const ranked = kimiCandidates.sort((a, b) => scoreKimiCodingCandidate(b) - scoreKimiCodingCandidate(a));
    const target = ranked[0];
    if (!target) return null;

    const [resolvedProviderID, resolvedModelID] = String(target.id).split('/');
    return {
        providerID: resolvedProviderID,
        modelID: resolvedModelID,
        models,
        resolved: target.id,
        aliasFrom: `${providerID}/${originalModelID}`
    };
}

function exactIdParts(fullId) {
    return String(fullId || '').split('/');
}

export function createModelsRuntime(client, modelCacheMs) {
    const MODEL_CACHE_MS = Number.isFinite(Number(modelCacheMs)) && Number(modelCacheMs) > 0
        ? Number(modelCacheMs)
        : 60 * 1000;
    let cachedProvidersList = null;
    let cachedModelsList = null;
    let cachedModelsAt = 0;

    const getProvidersList = async (forceRefresh = false) => {
        const now = Date.now();
        if (!forceRefresh && cachedProvidersList && cachedModelsAt && now - cachedModelsAt < MODEL_CACHE_MS) {
            return cachedProvidersList;
        }
        const providersRes = await client.config.providers();
        const providersRaw = providersRes.data?.providers || [];
        const providersList = Array.isArray(providersRaw)
            ? providersRaw
            : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));
        cachedProvidersList = providersList;
        cachedModelsList = null;
        cachedModelsAt = now;
        return providersList;
    };

    const buildModelsList = (providersList) => {
        const models = [];
        providersList.forEach((p) => {
            if (p.models) {
                Object.entries(p.models).forEach(([mId, mData]) => {
                    models.push({
                        id: `${p.id}/${mId}`,
                        name: typeof mData === 'object' ? (mData.name || mData.label || mId) : mId,
                        object: 'model',
                        created: (mData && mData.release_date)
                            ? Math.floor(new Date(mData.release_date).getTime() / 1000)
                            : 1704067200,
                        owned_by: p.id,
                        capabilities: inferModelCapabilities(`${p.id}/${mId}`),
                        aliases: buildModelAliases(`${p.id}/${mId}`),
                        provider: p.id
                    });
                });
            }
        });
        return models;
    };

    const getModelsList = async (forceRefresh = false) => {
        const now = Date.now();
        if (!forceRefresh && cachedModelsList && cachedModelsAt && now - cachedModelsAt < MODEL_CACHE_MS) {
            return cachedModelsList;
        }
        const models = buildModelsList(await getProvidersList(forceRefresh));
        cachedModelsList = models;
        cachedModelsAt = now;
        return models;
    };

    const resolveRequestedModel = async (requestedModel) => {
        const models = await getModelsList();
        const fallbackModel = models[0]?.id || 'opencode/kimi-k2.5-free';
        let [providerID, modelID] = (requestedModel || fallbackModel).split('/');
        const hadExplicitProvider = Boolean(modelID);
        if (!modelID) {
            modelID = providerID;
            providerID = 'opencode';
        }
        const originalModelID = modelID;
        const normalizedModelID = normalizeModelID(modelID);
        const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))];

        if (!hadExplicitProvider) {
            const aliasMatch = models.find((m) => {
                const aliases = Array.isArray(m.aliases) ? m.aliases.map((a) => String(a).toLowerCase()) : [];
                return candidateModelIDs.some((candidate) => aliases.includes(String(candidate).toLowerCase()));
            });
            if (aliasMatch) {
                const [resolvedProviderID, resolvedModelID] = exactIdParts(aliasMatch.id);
                return {
                    providerID: resolvedProviderID,
                    modelID: resolvedModelID,
                    models,
                    resolved: aliasMatch.id,
                    aliasFrom: originalModelID
                };
            }
        }

        const exact = models.find((m) => candidateModelIDs.some((candidate) => m.id === `${providerID}/${candidate}`));
        if (exact) {
            const [, resolvedModelID] = exactIdParts(exact.id);
            return {
                providerID,
                modelID: resolvedModelID,
                models,
                resolved: exact.id,
                ...(resolvedModelID !== originalModelID && { aliasFrom: `${providerID}/${originalModelID}` })
            };
        }
        const specialAliasMatch = resolveSpecialModelAlias(models, providerID, normalizedModelID, originalModelID);
        if (specialAliasMatch) {
            return specialAliasMatch;
        }
        const sameProvider = models.filter((m) => m.owned_by === providerID);
        const suffixMatch = sameProvider.find((m) => candidateModelIDs.some((candidate) => m.id.endsWith(`/${candidate}-free`) || m.id.endsWith(`/${candidate}`)));
        if (suffixMatch) {
            const [, resolvedModelID] = exactIdParts(suffixMatch.id);
            return { providerID, modelID: resolvedModelID, models, resolved: suffixMatch.id, aliasFrom: `${providerID}/${originalModelID}` };
        }
        const error = new Error(`Model not found: ${providerID}/${modelID}`);
        error.statusCode = 400;
        error.code = 'model_not_found';
        error.availableModels = models.map((m) => m.id);
        throw error;
    };

    return {
        getProvidersList,
        buildModelsList,
        getModelsList,
        normalizeModelID,
        resolveRequestedModel
    };
}
