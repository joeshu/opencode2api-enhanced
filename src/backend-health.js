import http from 'http';

export const backendState = new Map();

export function buildBackendAuthHeaders(password = '') {
    if (!password) return undefined;
    const token = Buffer.from(`opencode:${password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}

function requestOnce(url, headers) {
    return new Promise((resolve, reject) => {
        const options = headers ? { headers } : undefined;
        const req = http.get(url, options, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                if (body.length < 4096) body += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body
                });
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

function looksLikeOpencodeHtml(response) {
    const type = String(response?.headers?.['content-type'] || '').toLowerCase();
    const body = String(response?.body || '');
    return type.includes('text/html') && (body.includes('<title>OpenCode</title>') || body.includes('id="root"'));
}

export async function checkHealth(serverUrl, password = '') {
    const headers = buildBackendAuthHeaders(password);

    const healthRes = await requestOnce(`${serverUrl}/health`, headers);
    if (healthRes.statusCode === 200) return true;

    if (!password) {
        const rootRes = await requestOnce(`${serverUrl}/`, headers);
        if (rootRes.statusCode === 200 && looksLikeOpencodeHtml(rootRes)) return true;
    }

    throw new Error(`Status ${healthRes.statusCode}`);
}

export function getBackendStateSnapshot(serverUrl) {
    const state = backendState.get(serverUrl);
    const startupMode = state?.startupMode || null;
    return {
        configured: Boolean(serverUrl),
        serverUrl,
        isStarting: Boolean(state?.isStarting),
        hasManagedProcess: startupMode === 'managed' ? Boolean(state?.process) : false,
        lastStartAttemptAt: state?.lastStartAttemptAt || null,
        lastReadyAt: state?.lastReadyAt || null,
        lastError: state?.lastError || null,
        startupMode
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
