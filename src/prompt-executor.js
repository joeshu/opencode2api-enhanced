export async function promptWithTimeout(client, logDebug, sleep, promptParams, timeoutMs, retryCount = 2) {
    const attempt = async (retriesLeft) => {
        try {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
            });
            return Promise.race([client.session.prompt(promptParams), timeoutPromise]);
        } catch (err) {
            if (retriesLeft > 0 && (err.message.includes('timeout') || err.message.includes('network') || err.message.includes('ECONNREFUSED'))) {
                logDebug('Prompt failed, retrying', { retriesLeft, error: err.message });
                await sleep(1000);
                return attempt(retriesLeft - 1);
            }
            throw err;
        }
    };
    return attempt(retryCount);
}
