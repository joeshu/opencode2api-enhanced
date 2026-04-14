export function createToolOverridesRuntime(client, disableTools, logDebug) {
    const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
    let cachedToolOverrides = null;
    let cachedToolAt = 0;

    const getToolOverrides = async () => {
        if (!disableTools) return null;
        if (cachedToolOverrides && Date.now() - cachedToolAt < TOOL_IDS_CACHE_MS) {
            return cachedToolOverrides;
        }
        try {
            const idsRes = await client.tool.ids();
            const ids = Array.isArray(idsRes?.data)
                ? idsRes.data
                : Array.isArray(idsRes)
                    ? idsRes
                    : [];
            const overrides = {};
            ids.forEach((id) => {
                overrides[id] = false;
            });
            cachedToolOverrides = overrides;
            cachedToolAt = Date.now();
            logDebug('Tool overrides loaded', { count: ids.length });
            return overrides;
        } catch (e) {
            logDebug('Tool override fetch failed', { error: e.message });
            return null;
        }
    };

    return {
        getToolOverrides
    };
}
