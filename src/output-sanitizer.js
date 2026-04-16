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
    /we have created:/i,
    /^the user has sent /im,
    /^i should /im,
    /^according to my instructions/im,
    /^i don'?t need to use tools/im,
    /^i think (it'?s|a good idea)/im,
    /^i want to /im,
    /^it'?s important to /im,
    /^i can (help|reply|suggest|offer)/im
];

const LEAKED_REASONING_PREFIX_PATTERNS = [
    /^the user (is asking|asks|wants|said)/i,
    /^this is a simple/i,
    /^i should /i,
    /^we need to /i,
    /^用户要求/i,
    /^用户想让我/i,
    /^这是一个简单/i,
    /^我需要/i,
    /^上一轮/i
];

const LEAKED_REASONING_EXPLANATION_PATTERNS = [
    /\n\n/,
    /which means/i,
    /according to/i,
    /based on the conversation/i,
    /这是一个简单/i,
    /这个问题/i,
    /根据对话/i,
    /用户的指令/i
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

export function stripLeakedReasoningPreamble(text) {
    const value = String(text || '');
    if (!value.trim()) return value;
    const markers = [
        /\n\nHello[!.]/,
        /\n\nHi there[!.]/,
        /\n\nHi[!.]/,
        /\n\n我/,
        /\n\n你好/,
        /\n\nHello! /,
        /\n\nHi there. /
    ];
    for (const marker of markers) {
        const match = value.match(marker);
        if (match && typeof match.index === 'number') {
            return value.slice(match.index + 2).trim();
        }
    }
    return value;
}

export function splitLeakedReasoningPrefix(text) {
    const value = String(text || '');
    if (!value.trim()) return { reasoningPrefix: '', contentRemainder: value };

    const normalized = value.replace(/^\s+/, '');
    const separators = ['\n\n', '\n\n\n'];
    for (const separator of separators) {
        const idx = normalized.lastIndexOf(separator);
        if (idx <= 0) continue;
        const prefix = normalized.slice(0, idx).trim();
        const suffix = normalized.slice(idx + separator.length).trim();
        if (!prefix || !suffix) continue;
        if (LEAKED_REASONING_PREFIX_PATTERNS.some((pattern) => pattern.test(prefix))) {
            return {
                reasoningPrefix: prefix,
                contentRemainder: suffix
            };
        }
    }

    return { reasoningPrefix: '', contentRemainder: value };
}

export function looksLikeLeakedReasoningPrefix(text) {
    const value = String(text || '').trimStart();
    if (!value) return false;
    return LEAKED_REASONING_PREFIX_PATTERNS.some((pattern) => pattern.test(value));
}
