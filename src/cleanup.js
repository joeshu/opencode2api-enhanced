import fs from 'fs';
import os from 'os';
import path from 'path';

export function cleanupTempDirs() {
    if (process.platform === 'win32') return;

    const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail');
    try {
        if (fs.existsSync(jailRoot)) {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[Cleanup] Failed to remove temp dirs:', e.message);
    }
}

export function registerProcessCleanup() {
    process.on('exit', cleanupTempDirs);

    if (process.platform !== 'win32') {
        process.on('SIGINT', () => {
            console.log('\n[Shutdown] Received SIGINT, cleaning up...');
            cleanupTempDirs();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            console.log('\n[Shutdown] Received SIGTERM, cleaning up...');
            cleanupTempDirs();
            process.exit(0);
        });
    }
}
