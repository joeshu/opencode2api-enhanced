const activeModelCache = new Map();

function getCacheKey(serverUrl) {
    return serverUrl || 'default';
}

function isSameActiveModel(cached, providerID, modelID) {
    return Boolean(cached) && cached.providerID === providerID && cached.modelID === modelID;
}

export function shouldUpdateActiveModel(serverUrl, providerID, modelID) {
    const cached = activeModelCache.get(getCacheKey(serverUrl));
    return !isSameActiveModel(cached, providerID, modelID);
}

export function markActiveModel(serverUrl, providerID, modelID) {
    activeModelCache.set(getCacheKey(serverUrl), { providerID, modelID, updatedAt: Date.now() });
}

export function getActiveModelCacheSnapshot(serverUrl) {
    return activeModelCache.get(getCacheKey(serverUrl)) || null;
}
