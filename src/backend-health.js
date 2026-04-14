import http from 'http';

export const backendState = new Map();

export function buildBackendAuthHeaders(password = '') {
    if (!password) return undefined;
    const token = Buffer.from(`opencode:${password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}

export function checkHealth(serverUrl, password = '') {
    return new Promise((resolve, reject) => {
        const headers = buildBackendAuthHeaders(password);
        const options = headers ? { headers } : undefined;
        const req = http.get(`${serverUrl}/health`, options, (res) => {
            if (res.statusCode === 200) resolve(true);
            else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

export function getBackendStateSnapshot(serverUrl) {
    const state = backendState.get(serverUrl);
    return {
        configured: Boolean(serverUrl),
        serverUrl,
        isStarting: Boolean(state?.isStarting),
        hasManagedProcess: Boolean(state?.process),
        lastStartAttemptAt: state?.lastStartAttemptAt || null,
        lastReadyAt: state?.lastReadyAt || null,
        lastError: state?.lastError || null,
        startupMode: state?.startupMode || null
    };
}

export async function getBackendHealthStatus(serverUrl, password = '') {
    const snapshot = getBackendStateSnapshot(serverUrl);
    try {
        await checkHealth(serverUrl, password);
        return {
            ok: true,
            reachable: true,
            ...snapshot
        };
    } catch (error) {
        return {
            ok: false,
            reachable: false,
            error: error.message,
            ...snapshot
        };
    }
}
