export function buildChatStreamChunk({ id, model, content, finishReason = null }) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }]
    };
}

export function buildChatStreamUsageChunk({ id, promptTokens, completionTokens, reasoningTokens }) {
    return {
        id,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens + reasoningTokens,
            total_tokens: promptTokens + completionTokens + reasoningTokens,
            completion_tokens_details: {
                reasoning_tokens: reasoningTokens
            }
        }
    };
}
