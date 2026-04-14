import http from 'http';
import https from 'https';
import { createProxyError, normalizeProxyError } from './errors.js';

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function isPrivateHostname(hostname) {
    const normalized = (hostname || '').trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
    if (/^127\./.test(normalized)) return true;
    if (/^10\./.test(normalized)) return true;
    if (/^192\.168\./.test(normalized)) return true;
    if (/^169\.254\./.test(normalized)) return true;
    const match172 = normalized.match(/^172\.(\d+)\./);
    if (match172) {
        const second = Number(match172[1]);
        if (second >= 16 && second <= 31) return true;
    }
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
    return false;
}

export async function getImageDataUri(url, options = {}) {
    if (url.startsWith('data:')) {
        return url;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw createProxyError(`Invalid URL scheme: ${url}`, 400, 'invalid_request_error');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (error) {
        throw createProxyError(`Invalid image URL: ${url}`, 400, 'invalid_request_error');
    }

    const maxImageBytes = Number.isFinite(Number(options.maxImageBytes)) && Number(options.maxImageBytes) > 0
        ? Number(options.maxImageBytes)
        : DEFAULT_MAX_IMAGE_BYTES;
    const allowPrivateHosts = options.allowPrivateHosts === true;
    const allowedMimeTypes = Array.isArray(options.allowedMimeTypes) && options.allowedMimeTypes.length
        ? options.allowedMimeTypes
        : DEFAULT_ALLOWED_IMAGE_MIME_TYPES;

    if (!allowPrivateHosts && isPrivateHostname(parsedUrl.hostname)) {
        throw createProxyError(`Private image host is not allowed: ${parsedUrl.hostname}`, 400, 'invalid_image_url');
    }

    return new Promise((resolve, reject) => {
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const req = protocol.get(parsedUrl, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) {
                return reject(createProxyError(`Failed to fetch image: HTTP ${res.statusCode}`, 400, 'invalid_image_url'));
            }

            const contentType = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim().toLowerCase();
            if (!allowedMimeTypes.includes(contentType)) {
                req.destroy();
                return reject(createProxyError(`Unsupported image content type: ${contentType}`, 400, 'invalid_image_url'));
            }

            const contentLength = Number(res.headers['content-length'] || 0);
            if (contentLength && contentLength > maxImageBytes) {
                req.destroy();
                return reject(createProxyError(`Image too large: ${contentLength} bytes`, 413, 'image_too_large'));
            }

            const chunks = [];
            let totalBytes = 0;
            let aborted = false;

            res.on('data', (chunk) => {
                if (aborted) return;
                totalBytes += chunk.length;
                if (totalBytes > maxImageBytes) {
                    aborted = true;
                    req.destroy();
                    reject(createProxyError(`Image too large: exceeded ${maxImageBytes} bytes`, 413, 'image_too_large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (aborted) return;
                try {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    resolve(`data:${contentType};base64,${base64}`);
                } catch (e) {
                    reject(createProxyError(`Failed to encode image: ${e.message}`, 500, 'internal_error'));
                }
            });
        });

        req.on('error', (e) => reject(normalizeProxyError(e)));
        req.on('timeout', () => {
            req.destroy();
            reject(createProxyError('Image fetch timeout', 504, 'upstream_timeout_error'));
        });
    });
}
