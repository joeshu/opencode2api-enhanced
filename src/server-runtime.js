import fs from 'fs';

export function createServerRuntime(app, config, deps) {
    const {
        backendState,
        ensureBackend,
        checkHealth,
        resolveOpencodePath,
        resolveShutdownGraceMs,
        STARTUP_WAIT_ITERATIONS,
        STARTUP_WAIT_INTERVAL_MS,
        STARTING_WAIT_ITERATIONS,
        STARTING_WAIT_INTERVAL_MS
    } = deps;

    const server = app.listen(config.PORT, config.BIND_HOST, async () => {
        console.log(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
        try {
            await ensureBackend(config, {
                backendState,
                checkHealth,
                resolveOpencodePath,
                STARTUP_WAIT_ITERATIONS,
                STARTUP_WAIT_INTERVAL_MS,
                STARTING_WAIT_ITERATIONS,
                STARTING_WAIT_INTERVAL_MS
            });
        } catch (error) {
            console.error('[Proxy] Backend warmup failed:', error.message);
        }
    });

    server.requestTimeout = config.SERVER_REQUEST_TIMEOUT_MS;
    server.headersTimeout = config.SERVER_HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = config.SERVER_KEEPALIVE_TIMEOUT_MS;
    server.setTimeout(config.SERVER_SOCKET_TIMEOUT_MS, (socket) => {
        try {
            socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
        } catch (e) {
            socket.destroy();
        }
    });
    server.on('clientError', (err, socket) => {
        if (!socket || socket.destroyed) return;
        const code = err?.code || 'client_error';
        const body = JSON.stringify({
            error: {
                message: code === 'HPE_HEADER_OVERFLOW' ? 'Request headers too large' : 'Invalid HTTP request',
                type: code === 'HPE_HEADER_OVERFLOW' ? 'headers_overflow_error' : 'bad_request_error'
            }
        });
        try {
            socket.end(
                `HTTP/1.1 ${code === 'HPE_HEADER_OVERFLOW' ? 431 : 400} ${code === 'HPE_HEADER_OVERFLOW' ? 'Request Header Fields Too Large' : 'Bad Request'}\r\n` +
                'Content-Type: application/json\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                'Connection: close\r\n\r\n' +
                body
            );
        } catch (e) {
            socket.destroy();
        }
    });

    const killBackend = () => {
        const state = backendState.get(config.OPENCODE_SERVER_URL);
        if (state && state.process) {
            state.process.kill();
        }
        if (state && state.jailRoot && process.platform !== 'win32') {
            try {
                fs.rmSync(state.jailRoot, { recursive: true, force: true });
            } catch (e) { }
        }
    };

    const shutdown = (reason = 'shutdown') => new Promise((resolve) => {
        const graceMs = resolveShutdownGraceMs(config);
        let settled = false;
        const finalize = () => {
            if (settled) return;
            settled = true;
            killBackend();
            resolve();
        };
        const forceTimer = setTimeout(() => {
            console.warn(`[Shutdown] Grace period exceeded after ${graceMs}ms (${reason}), force closing active connections`);
            try {
                server.closeAllConnections?.();
            } catch (e) { }
            try {
                server.closeIdleConnections?.();
            } catch (e) { }
            finalize();
        }, graceMs);
        if (forceTimer.unref) forceTimer.unref();
        server.close(() => {
            clearTimeout(forceTimer);
            finalize();
        });
    });

    return {
        server,
        killBackend,
        shutdown
    };
}
