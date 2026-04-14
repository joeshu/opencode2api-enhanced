export const TOOL_GUARD_MESSAGE = 'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';

export function buildSystemPrompt(systemMsg, reasoningEffort = null, options = {}) {
    const omitSystemPrompt = options.omitSystemPrompt === true;
    const disableTools = options.disableTools === true;
    const promptMode = options.promptMode || 'standard';
    const parts = [];
    if (!omitSystemPrompt && systemMsg && systemMsg.trim()) {
        parts.push(systemMsg.trim());
    }
    if (reasoningEffort && reasoningEffort !== 'none') {
        parts.push(`[Reasoning Effort: ${reasoningEffort}]`);
    }
    if (disableTools && promptMode !== 'plugin-inject') {
        parts.push(TOOL_GUARD_MESSAGE);
    }
    const finalPrompt = parts.join('\n\n').trim();
    return finalPrompt || undefined;
}

export function normalizeReasoningEffort(value, fallback = null) {
    if (!value || typeof value !== 'string') return fallback;
    const effortMap = {
        'none': 'none',
        'minimal': 'none',
        'low': 'low',
        'medium': 'medium',
        'high': 'high',
        'xhigh': 'high'
    };
    return effortMap[value.toLowerCase()] || fallback;
}

export function stripFunctionCalls(text, trim = true, disableTools = true) {
    if (!disableTools || !text) return text;
    const cleaned = text
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
        .replace(/<\/?function_calls>/g, '');
    return trim ? cleaned.trim() : cleaned;
}

export function createToolCallFilter(disableTools = true) {
    if (!disableTools) return (chunk) => chunk;
    let inBlock = false;
    return (chunk) => {
        if (!chunk) return chunk;
        let output = '';
        let remaining = chunk;
        while (remaining.length) {
            if (inBlock) {
                const endIdx = remaining.indexOf('</function_calls>');
                if (endIdx === -1) {
                    return output;
                }
                remaining = remaining.slice(endIdx + '</function_calls>'.length);
                inBlock = false;
                continue;
            }
            const startIdx = remaining.indexOf('<function_calls>');
            if (startIdx === -1) {
                output += remaining;
                return output;
            }
            output += remaining.slice(0, startIdx);
            remaining = remaining.slice(startIdx + '<function_calls>'.length);
            inBlock = true;
        }
        return output;
    };
}
