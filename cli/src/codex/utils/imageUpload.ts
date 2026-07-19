import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { logger } from '@/ui/logger';

type UploadBlobFn = (mimeType: string, data: string) => Promise<string>;

type Base64Image = {
    mimeType: string;
    data: string;
};

const MAX_AUTO_UPLOAD_IMAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_EXT_MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif'
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}


function inferImageMimeType(path: string, explicitMimeType?: unknown): string | null {
    const ext = extname(path).toLowerCase();
    const mimeType = asNonEmptyString(explicitMimeType) ?? IMAGE_EXT_MIME_TYPES[ext];
    return mimeType?.startsWith('image/') ? mimeType : null;
}

async function readLocalImage(path: string, explicitMimeType?: unknown): Promise<Base64Image | null> {
    const mimeType = inferImageMimeType(path, explicitMimeType);
    if (!mimeType) return null;

    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_AUTO_UPLOAD_IMAGE_BYTES) {
        return null;
    }

    const buffer = await readFile(path);
    return { mimeType, data: buffer.toString('base64') };
}

function normalizeLocalImagePath(value: string): string | null {
    if (value.startsWith('file://')) {
        try {
            return decodeURIComponent(new URL(value).pathname);
        } catch {
            return null;
        }
    }
    return value.startsWith('/') ? value : null;
}

function extractLocalImagePathsFromText(value: string): string[] {
    const paths = new Set<string>();
    const pathPattern = /(?:file:\/\/)?\/(?:[^\s"'`<>]|\\ )+?\.(?:png|jpe?g|webp|gif|bmp|avif)(?=$|[\s"'`<>),}\]])/gi;
    for (const match of value.matchAll(pathPattern)) {
        const path = normalizeLocalImagePath(match[0].replace(/\\ /g, ' '));
        if (path && inferImageMimeType(path)) {
            paths.add(path);
        }
    }
    return Array.from(paths);
}

function collectLocalImagePaths(value: unknown, paths = new Set<string>()): Set<string> {
    if (typeof value === 'string') {
        for (const path of extractLocalImagePathsFromText(value)) {
            paths.add(path);
        }
        return paths;
    }

    if (Array.isArray(value)) {
        for (const item of value) collectLocalImagePaths(item, paths);
        return paths;
    }

    if (!isRecord(value)) {
        return paths;
    }

    if (value.type === 'localImage' || value.type === 'local_image') {
        return paths;
    }

    for (const child of Object.values(value)) {
        collectLocalImagePaths(child, paths);
    }
    return paths;
}

function collectHapiImages(value: unknown, images: Array<{ type: 'hapi_image'; blobId: string; mimeType: string }> = []): Array<{ type: 'hapi_image'; blobId: string; mimeType: string }> {
    if (Array.isArray(value)) {
        for (const item of value) collectHapiImages(item, images);
        return images;
    }
    if (!isRecord(value)) return images;
    if (value.type === 'hapi_image' && typeof value.blobId === 'string' && typeof value.mimeType === 'string') {
        images.push({ type: 'hapi_image', blobId: value.blobId, mimeType: value.mimeType });
        return images;
    }
    for (const child of Object.values(value)) collectHapiImages(child, images);
    return images;
}

function appendRenderableImages(output: unknown, images: Array<{ type: 'hapi_image'; blobId: string; mimeType: string }>): unknown {
    if (images.length === 0) return output;

    const seen = new Set<string>();
    const uniqueImages = images.filter((image) => {
        if (seen.has(image.blobId)) return false;
        seen.add(image.blobId);
        return true;
    });
    if (uniqueImages.length === 0) return output;

    if (Array.isArray(output)) {
        const existing = new Set(collectHapiImages(output).map((image) => image.blobId));
        const missing = uniqueImages.filter((image) => !existing.has(image.blobId));
        return missing.length > 0 ? [...output, ...missing] : output;
    }

    if (isRecord(output)) {
        const content = Array.isArray(output.content) ? output.content : null;
        const existing = new Set(collectHapiImages(content ?? []).map((image) => image.blobId));
        const missing = uniqueImages.filter((image) => !existing.has(image.blobId));
        if (missing.length === 0) return output;
        return {
            ...output,
            content: content ? [...content, ...missing] : missing
        };
    }

    return uniqueImages;
}

function parseDataUrl(value: string): Base64Image | null {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
    if (!match) return null;
    return { mimeType: match[1] ?? 'image/png', data: match[2] ?? '' };
}

function extractInlineBase64Image(record: Record<string, unknown>): Base64Image | null {
    if (record.type !== 'image' && record.type !== 'input_image' && record.type !== 'screenshot') {
        return null;
    }

    // Anthropic/Claude shape: { type: 'image', source: { type: 'base64', media_type, data } }
    const source = isRecord(record.source) ? record.source : null;
    if (source?.type === 'base64') {
        const data = asNonEmptyString(source.data);
        if (data) {
            return {
                mimeType: asNonEmptyString(source.media_type ?? source.mimeType ?? source.mime_type) ?? 'image/png',
                data
            };
        }
    }

    // MCP image content shape: { type: 'image', data, mimeType }
    const data = asNonEmptyString(record.data ?? record.base64);
    if (data) {
        return {
            mimeType: asNonEmptyString(record.mimeType ?? record.mime_type ?? record.media_type) ?? 'image/png',
            data
        };
    }

    // Some runtimes surface data URLs as url/image_url fields.
    const url = asNonEmptyString(record.url ?? record.image_url);
    if (url) {
        return parseDataUrl(url);
    }

    return null;
}

async function extractLocalImage(record: Record<string, unknown>): Promise<Base64Image | null> {
    if (record.type !== 'localImage' && record.type !== 'local_image') {
        return null;
    }

    const path = asNonEmptyString(record.path);
    if (!path) return null;

    return readLocalImage(path, record.mimeType ?? record.mime_type ?? record.media_type);
}

/**
 * Converts Codex/MCP image-bearing tool outputs into HAPI blob references.
 * Supports Anthropic-style image blocks, MCP image content blocks, data URLs,
 * and Codex localImage blocks. Unknown shapes are preserved unchanged.
 */
export async function uploadImagesInCodexOutput(output: unknown, uploadBlob: UploadBlobFn): Promise<unknown> {
    const localImagePaths = collectLocalImagePaths(output);

    async function transform(value: unknown): Promise<unknown> {
        if (Array.isArray(value)) {
            let changed = false;
            const next = await Promise.all(value.map(async (item) => {
                const transformed = await transform(item);
                changed ||= transformed !== item;
                return transformed;
            }));
            return changed ? next : value;
        }

        if (!isRecord(value)) {
            return value;
        }

        if (value.type === 'hapi_image') {
            return value;
        }

        const inlineImage = extractInlineBase64Image(value);
        if (inlineImage) {
            try {
                const blobId = await uploadBlob(inlineImage.mimeType, inlineImage.data);
                return { type: 'hapi_image', blobId, mimeType: inlineImage.mimeType };
            } catch (error) {
                logger.debug('[codex-blob-upload]: Failed to upload inline image blob', error);
                return { type: 'text', text: `[image: ${inlineImage.mimeType}]` };
            }
        }

        try {
            const localImage = await extractLocalImage(value);
            if (localImage) {
                try {
                    const blobId = await uploadBlob(localImage.mimeType, localImage.data);
                    return { type: 'hapi_image', blobId, mimeType: localImage.mimeType };
                } catch (error) {
                    logger.debug('[codex-blob-upload]: Failed to upload local image blob', error);
                    return { type: 'text', text: `[image: ${localImage.mimeType}]` };
                }
            }
        } catch (error) {
            logger.debug('[codex-blob-upload]: Failed to read local image', error);
        }

        let changed = false;
        const next: Record<string, unknown> = { ...value };
        for (const [key, child] of Object.entries(value)) {
            const transformed = await transform(child);
            if (transformed !== child) {
                changed = true;
                next[key] = transformed;
            }
        }
        return changed ? next : value;
    }

    const transformedOutput = await transform(output);
    const uploadedPathImages: Array<{ type: 'hapi_image'; blobId: string; mimeType: string }> = [];

    for (const path of localImagePaths) {
        try {
            const localImage = await readLocalImage(path);
            if (!localImage) continue;
            try {
                const blobId = await uploadBlob(localImage.mimeType, localImage.data);
                uploadedPathImages.push({ type: 'hapi_image', blobId, mimeType: localImage.mimeType });
            } catch (error) {
                logger.debug('[codex-blob-upload]: Failed to upload image path blob', error);
            }
        } catch (error) {
            logger.debug('[codex-blob-upload]: Failed to read image path', error);
        }
    }

    return appendRenderableImages(transformedOutput, uploadedPathImages);
}

