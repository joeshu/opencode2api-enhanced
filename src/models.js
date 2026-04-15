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
    return aliases;
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
                        aliases: buildModelAliases(`${p.id}/${mId}`)
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

    const normalizeModelID = (modelID) => {
        if (!modelID || typeof modelID !== 'string') return modelID;
        return modelID
            .replace(/^gpt(\d)/i, 'gpt-$1')
            .replace(/^o(\d)/i, 'o$1');
    };

    const resolveRequestedModel = async (requestedModel) => {
        const models = await getModelsList();
        const fallbackModel = models[0]?.id || 'opencode/kimi-k2.5-free';
        let [providerID, modelID] = (requestedModel || fallbackModel).split('/');
        if (!modelID) {
            modelID = providerID;
            providerID = 'opencode';
        }
        const originalModelID = modelID;
        const normalizedModelID = normalizeModelID(modelID);
        const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))];
        const exact = models.find((m) => candidateModelIDs.some((candidate) => m.id === `${providerID}/${candidate}`));
        if (exact) {
            const [, resolvedModelID] = exact.id.split('/');
            return {
                providerID,
                modelID: resolvedModelID,
                models,
                resolved: exact.id,
                ...(resolvedModelID !== originalModelID && { aliasFrom: `${providerID}/${originalModelID}` })
            };
        }
        const sameProvider = models.filter((m) => m.owned_by === providerID);
        const suffixMatch = sameProvider.find((m) => candidateModelIDs.some((candidate) => m.id.endsWith(`/${candidate}-free`) || m.id.endsWith(`/${candidate}`)));
        if (suffixMatch) {
            const [, resolvedModelID] = suffixMatch.id.split('/');
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
