import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

export async function ensureBackend(config, deps) {
    const {
        backendState,
        checkHealth,
        resolveOpencodePath,
        STARTUP_WAIT_ITERATIONS,
        STARTUP_WAIT_INTERVAL_MS,
        STARTING_WAIT_ITERATIONS,
        STARTING_WAIT_INTERVAL_MS
    } = deps;

    const {
        OPENCODE_SERVER_URL,
        OPENCODE_PATH,
        USE_ISOLATED_HOME,
        ZEN_API_KEY,
        OPENCODE_SERVER_PASSWORD,
        MANAGE_BACKEND,
        PROMPT_MODE
    } = config;
    const backendPassword = OPENCODE_SERVER_PASSWORD || '';
    const stateKey = OPENCODE_SERVER_URL;

    if (!backendState.has(stateKey)) {
        backendState.set(stateKey, {
            isStarting: false,
            process: null,
            jailRoot: null,
            lastStartAttemptAt: null,
            lastReadyAt: null,
            lastError: null,
            startupMode: null
        });
    }

    const state = backendState.get(stateKey);

    if (state.isStarting) {
        for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
            await new Promise((r) => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                state.lastReadyAt = Date.now();
                state.lastError = null;
                return;
            } catch (e) {
                state.lastError = e.message;
            }
        }
        state.lastError = 'Backend startup timeout';
        throw new Error('Backend startup timeout');
    }

    try {
        await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
        state.lastReadyAt = Date.now();
        state.lastError = null;
    } catch (err) {
        if (!MANAGE_BACKEND) {
            state.startupMode = 'external';
            state.lastStartAttemptAt = Date.now();
            for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
                await new Promise((r) => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
                try {
                    await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                    state.lastReadyAt = Date.now();
                    state.lastError = null;
                    return;
                } catch (e) {
                    state.lastError = e.message;
                }
            }
            state.lastError = err.message;
            throw err;
        }

        state.isStarting = true;
        state.startupMode = 'managed';
        state.lastStartAttemptAt = Date.now();
        state.lastError = err.message;
        console.log(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

        if (state.process) {
            try {
                state.process.kill();
            } catch (e) {}
        }

        if (state.jailRoot && fs.existsSync(state.jailRoot)) {
            try {
                fs.rmSync(state.jailRoot, { recursive: true, force: true });
            } catch (e) {}
        }

        const isWindows = process.platform === 'win32';
        const useIsolatedHome = typeof USE_ISOLATED_HOME === 'boolean'
            ? USE_ISOLATED_HOME
            : String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
              process.env.OPENCODE_USE_ISOLATED_HOME === '1';

        const salt = Math.random().toString(36).substring(7);
        const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
        state.jailRoot = jailRoot;
        config.OPENCODE_HOME_BASE = jailRoot;
        const workspace = path.join(jailRoot, 'empty-workspace');

        let envVars;
        let cwd;

        if (isWindows) {
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;
            envVars = {
                ...process.env,
                OPENCODE_PROJECT_DIR: workspace
            };
            console.log('[Proxy] Running on Windows, using standard user home directory');
        } else {
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;

            if (useIsolatedHome) {
                const fakeHome = path.join(jailRoot, 'fake-home');
                const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
                const storageDir = path.join(opencodeDir, 'storage');
                const messageDir = path.join(storageDir, 'message');
                const sessionDir = path.join(storageDir, 'session');

                [fakeHome, opencodeDir, storageDir, messageDir, sessionDir].forEach((d) => {
                    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                });

                envVars = {
                    ...process.env,
                    HOME: fakeHome,
                    USERPROFILE: fakeHome,
                    OPENCODE_PROJECT_DIR: workspace
                };

                if (PROMPT_MODE === 'plugin-inject') {
                    const configDir = path.join(fakeHome, '.config', 'opencode');
                    const pluginDir = path.join(configDir, 'plugin', 'opencode2api-empty');
                    fs.mkdirSync(pluginDir, { recursive: true });
                    fs.writeFileSync(path.join(pluginDir, 'index.js'), `export const Opencode2apiEmptyPlugin = async () => ({})\nexport default Opencode2apiEmptyPlugin\n`, 'utf8');
                    fs.writeFileSync(
                        path.join(configDir, 'opencode.json'),
                        JSON.stringify({
                            plugin: [path.join(pluginDir, 'index.js')],
                            instructions: [],
                            theme: 'system'
                        }, null, 2),
                        'utf8'
                    );
                    console.log('[Proxy] Using plugin-inject prompt mode');
                }
                console.log('[Proxy] Using isolated home for OpenCode');
            } else {
                envVars = {
                    ...process.env,
                    OPENCODE_PROJECT_DIR: workspace
                };
                console.log('[Proxy] Using real HOME for OpenCode (isolation disabled)');
            }
        }

        const [, , portStr] = OPENCODE_SERVER_URL.split(':');
        const port = portStr ? portStr.split('/')[0] : '10001';
        const resolved = resolveOpencodePath(OPENCODE_PATH);
        const opencodeBin = resolved.path || OPENCODE_PATH || 'opencode';
        if (resolved.path) {
            console.log(`[Proxy] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`);
        } else {
            console.warn(`[Proxy] Unable to resolve OpenCode binary for '${OPENCODE_PATH}'. Using as-is.`);
        }

        const useShell = process.platform === 'win32' || !resolved.path ||
            opencodeBin.endsWith('.cmd') || opencodeBin.endsWith('.bat');
        const spawnOptions = {
            stdio: 'inherit',
            cwd,
            env: envVars,
            shell: useShell
        };

        const spawnArgs = ['serve', '--port', port, '--hostname', '127.0.0.1'];
        if (backendPassword) {
            spawnArgs.push('--password', backendPassword);
        } else if (ZEN_API_KEY) {
            console.warn('[Proxy] ZEN_API_KEY is configured but OPENCODE_SERVER_PASSWORD is empty. ZEN_API_KEY will not be used as backend password.');
        }
        state.process = spawn(opencodeBin, spawnArgs, spawnOptions);

        state.process.on('error', (spawnErr) => {
            state.lastError = spawnErr.message;
            console.error(`[Proxy] Failed to spawn OpenCode: ${spawnErr.message}`);
            if (spawnErr.code === 'ENOENT') {
                console.error(`[Proxy] Command '${OPENCODE_PATH}' not found. Please ensure OpenCode is installed and in your PATH.`);
                console.error(`[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`);
            }
        });

        let started = false;
        for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
            await new Promise((r) => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                console.log('[Proxy] OpenCode backend ready.');
                state.lastReadyAt = Date.now();
                state.lastError = null;
                started = true;
                break;
            } catch (e) {
                state.lastError = e.message;
            }
        }

        state.isStarting = false;

        if (!started) {
            state.lastError = 'Backend start timeout';
            console.warn('[Proxy] Backend start timed out.');
            throw new Error('Backend start timeout');
        }
    }
}
