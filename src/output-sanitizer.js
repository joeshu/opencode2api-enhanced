const SUSPICIOUS_PATTERNS = [
    /NotFoundError/i,
    /Session not found/i,
    /\$bunfs\/root\//i,
    /chunk-[a-z0-9]+\.js/i,
    /at <anonymous>/i,
    /at runLoop/i,
    /at evaluate/i,
    /failed to restore snapshot/i,
    /git cat-file --batch/i,
    /<\/tool_call>/i,
    /<\/function>/i,
    /<\/parameter>/i,
    /<tool_call>/i,
    /<function>/i,
    /<parameter>/i,
    /let'?s craft our final response/i,
    /we can now consider the task complete/i,
    /we'?ll respond with a summary/i,
    /final response:/i,
    /the user said .* which means/i,
    /however, we must not output/i,
    /we can end there/i,
    /we have created:/i
];

export function detectCorruptedUpstreamContent(text) {
    const value = String(text || '');
    if (!value.trim()) return false;
    return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeAssistantPayload({ content, reasoning }) {
    const joined = `${reasoning || ''}\n${content || ''}`;
    if (!detectCorruptedUpstreamContent(joined)) {
        return { content, reasoning, corrupted: false };
    }
    return {
        content: '',
        reasoning: '',
        corrupted: true,
        error: {
            message: 'The upstream tool workflow failed before producing a clean response.',
            type: 'upstream_tool_execution_error',
            retryable: true,
            hint: 'Please retry. If the problem persists, switch to stable mode or disable tools.'
        }
    };
}
