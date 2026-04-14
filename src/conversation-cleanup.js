import fs from 'fs';
import path from 'path';

export function getCleanupRoots(opencodeHomeBase) {
    const roots = [];
    const add = (dir) => {
        if (!dir) return;
        if (!roots.includes(dir)) roots.push(dir);
    };
    add(opencodeHomeBase ? path.join(opencodeHomeBase, '.local', 'share', 'opencode', 'storage') : null);
    add('/home/node/.local/share/opencode/storage');
    return roots;
}

export async function cleanupConversationFiles(options) {
    const {
        autoCleanupConversations,
        opencodeHomeBase,
        cleanupMaxAgeMs,
        logDebug
    } = options;

    if (!autoCleanupConversations) return { removed: 0, scanned: 0 };
    const now = Date.now();
    let removed = 0;
    let scanned = 0;
    for (const storageRoot of getCleanupRoots(opencodeHomeBase)) {
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
                if (now - mtime < cleanupMaxAgeMs) continue;
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
        logDebug('Conversation cleanup completed', { removed, scanned, maxAgeMs: cleanupMaxAgeMs });
    }
    return { removed, scanned };
}

export function registerConversationCleanup(options) {
    const {
        autoCleanupConversations,
        cleanupIntervalMs,
        runCleanup,
        logDebug
    } = options;

    if (!autoCleanupConversations) return null;

    setTimeout(() => {
        runCleanup().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
    }, 3000);

    const cleanupTimer = setInterval(() => {
        runCleanup().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
    }, cleanupIntervalMs);
    if (cleanupTimer.unref) cleanupTimer.unref();
    return cleanupTimer;
}
