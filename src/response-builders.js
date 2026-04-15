export function buildChatCompletionResponse({ model, content, reasoning, fullPromptText }) {
    const promptTokens = Math.ceil((fullPromptText || '').length / 4);
    const completionTokensCalc = Math.ceil((content || '').length / 4);
    const reasoningTokensCalc = Math.ceil((reasoning || '').length / 4);
    const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;

    let finalContent = content;
    if (reasoning) {
        finalContent = `<think>\n${reasoning}\n</think>\n\n${content}`;
    }

    return {
        body: {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: finalContent },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokensCalc + reasoningTokensCalc,
                total_tokens: totalTokens,
                completion_tokens_details: {
                    reasoning_tokens: reasoningTokensCalc
                }
            }
        },
        metrics: {
            promptTokens,
            completionTokens: completionTokensCalc + reasoningTokensCalc,
            totalTokens
        }
    };
}

export function buildResponsesApiResponse({ id, model, content, reasoning, reasoningLevel, fullPromptText, meta = {} }) {
    const promptTokens = Math.ceil(fullPromptText.length / 4);
    const completionTokens = Math.ceil(content.length / 4);
    const reasoningTokens = Math.ceil(reasoning.length / 4);

    return {
        id: id || `resp_${Date.now()}`,
        object: 'response',
        created: Math.floor(Date.now() / 1000),
        model,
        reasoning: reasoning ? { effort: reasoningLevel, summary: reasoning.substring(0, 100) } : undefined,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }],
        usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens + reasoningTokens,
            total_tokens: promptTokens + completionTokens + reasoningTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: reasoningTokens }
        },
        meta: Object.keys(meta).length ? meta : undefined
    };
}
