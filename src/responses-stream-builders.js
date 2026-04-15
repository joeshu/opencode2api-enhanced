export function buildResponsesCreatedEvent({ responseId, model, sequenceNumber }) {
    return {
        type: 'response.created',
        sequence_number: sequenceNumber,
        response: {
            id: responseId,
            object: 'response',
            created: Math.floor(Date.now() / 1000),
            model
        }
    };
}

export function buildResponsesMessageOutputAddedEvent({ sequenceNumber, outputIndex, itemId }) {
    return {
        type: 'response.output_item.added',
        sequence_number: sequenceNumber,
        output_index: outputIndex,
        item: {
            id: itemId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: []
        }
    };
}

export function buildResponsesContentPartAddedEvent({ sequenceNumber, outputIndex, contentIndex, itemId }) {
    return {
        type: 'response.content_part.added',
        sequence_number: sequenceNumber,
        output_index: outputIndex,
        content_index: contentIndex,
        item_id: itemId,
        part: { type: 'output_text', text: '' }
    };
}

export function buildResponsesReasoningOutputAddedEvent({ sequenceNumber, outputIndex, itemId }) {
    return {
        type: 'response.output_item.added',
        sequence_number: sequenceNumber,
        output_index: outputIndex,
        item: {
            id: itemId,
            type: 'reasoning',
            status: 'in_progress',
            summary: [{ type: 'summary_text', text: '' }]
        }
    };
}

export function buildResponsesReasoningDeltaEvent({ sequenceNumber, outputIndex, itemId, delta }) {
    return {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: sequenceNumber,
        output_index: outputIndex,
        item_id: itemId,
        summary_index: 0,
        delta
    };
}

export function buildResponsesTextDeltaEvent({ sequenceNumber, outputIndex, contentIndex, itemId, delta }) {
    return {
        type: 'response.output_text.delta',
        sequence_number: sequenceNumber,
        output_index: outputIndex,
        content_index: contentIndex,
        item_id: itemId,
        delta
    };
}
