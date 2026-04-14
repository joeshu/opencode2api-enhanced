export function normalizeMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            return '';
        }).join('');
    }
    if (content && typeof content.text === 'string') return content.text;
    if (content === null || content === undefined) return '';
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    return '';
}

export async function buildChatPromptParts(rawMessages, deps) {
    const { getImageDataUri, maxImageBytes, allowPrivateHosts } = deps;
    const parts = [];
    const systemChunks = [];
    const userContents = [];

    for (const m of rawMessages) {
        const role = (m?.role || 'user').toLowerCase();
        const content = m?.content;

        if (role === 'system') {
            const text = normalizeMessageContent(content);
            if (text) systemChunks.push(text);
            continue;
        }

        if (!content) continue;

        if (typeof content === 'string') {
            if (role === 'user') userContents.push(content);
            const roleLabel = role.toUpperCase();
            const nameSuffix = m?.name ? `(${m.name})` : '';
            parts.push({ type: 'text', text: `${roleLabel}${nameSuffix}: ${content}` });
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (!part) continue;
                if (part.type === 'text') {
                    const text = part.text || '';
                    if (role === 'user') userContents.push(text);
                    const roleLabel = role.toUpperCase();
                    const nameSuffix = m?.name ? `(${m.name})` : '';
                    parts.push({ type: 'text', text: `${roleLabel}${nameSuffix}: ${text}` });
                } else if (part.type === 'image_url') {
                    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                    if (imageUrl) {
                        try {
                            const dataUri = await getImageDataUri(imageUrl, {
                                maxImageBytes,
                                allowPrivateHosts
                            });
                            const mime = dataUri.split(';')[0].split(':')[1];
                            parts.push({ type: 'file', mime, url: dataUri, filename: 'image' });
                        } catch (imgErr) {
                            console.warn('[Proxy] Skipping image due to error:', imgErr.message);
                        }
                    }
                }
            }
        }
    }

    return {
        parts,
        system: systemChunks.join('\n\n'),
        fullPromptText: parts.map((p) => p.text).join('\n\n'),
        lastUserMsg: userContents[userContents.length - 1] || ''
    };
}

function coerceTextParts(content) {
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part?.type === 'input_text' || part?.type === 'text' || typeof part?.text === 'string') return part.text || '';
            if (part?.type === 'output_text') return part.text || '';
            return '';
        }).join('');
    }
    return typeof content === 'string' ? content : content?.text || '';
}

export function normalizeResponsesMessages({ chatMessages, prompt, input, instructions }) {
    let messages = [];
    if (Array.isArray(chatMessages) && chatMessages.length) {
        messages = chatMessages.map((item) => ({
            role: item?.role || 'user',
            content: coerceTextParts(item?.content)
        })).filter((item) => item.content);
    } else if (typeof prompt === 'string' && prompt.trim()) {
        messages = [{ role: 'user', content: prompt }];
    } else if (typeof input === 'string') {
        messages = [{ role: 'user', content: input }];
    } else if (Array.isArray(input)) {
        for (const item of input) {
            if (!item) continue;
            if (item.type === 'message') {
                const content = coerceTextParts(item.content) || item.content || '';
                if (content) messages.push({ role: item.role || 'user', content });
            } else if (item.type === 'input_text') {
                if (item.text) messages.push({ role: 'user', content: item.text });
            } else if (typeof item.text === 'string' && item.text) {
                messages.push({ role: item.role || 'user', content: item.text });
            } else if (typeof item.content === 'string' && item.content) {
                messages.push({ role: item.role || 'user', content: item.content });
            } else if (Array.isArray(item.content)) {
                const content = coerceTextParts(item.content);
                if (content) messages.push({ role: item.role || 'user', content });
            }
        }
    } else if (input && typeof input === 'object') {
        if (input.type === 'message') {
            const content = Array.isArray(input.content)
                ? input.content.map((part) => part?.text || '').join('')
                : input.content?.text || input.content || '';
            if (content) messages = [{ role: input.role || 'user', content }];
        } else if (typeof input.text === 'string' && input.text) {
            messages = [{ role: input.role || 'user', content: input.text }];
        }
    }

    if (instructions) {
        messages.unshift({ role: 'system', content: instructions });
    }

    return messages;
}
