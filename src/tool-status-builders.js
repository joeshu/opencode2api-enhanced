export function buildToolStatusEvent({ sequenceNumber, stage, name = 'generic_tool', label = 'Tool', message, error }) {
    return {
        type: 'x-opencode.tool',
        sequence_number: sequenceNumber,
        stage,
        tool: {
            name,
            label
        },
        ...(message ? { message } : {}),
        ...(error ? { error } : {})
    };
}
