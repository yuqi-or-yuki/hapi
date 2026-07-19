import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { uploadImagesInCodexOutput } from './imageUpload';

describe('uploadImagesInCodexOutput', () => {
    it('uploads MCP image content blocks and replaces them with HAPI blob references', async () => {
        const upload = vi.fn(async () => 'blob-1');

        const output = await uploadImagesInCodexOutput({
            content: [
                { type: 'text', text: 'screenshot' },
                { type: 'image', data: 'abc123', mimeType: 'image/png' }
            ]
        }, upload);

        expect(upload).toHaveBeenCalledWith('image/png', 'abc123');
        expect(output).toEqual({
            content: [
                { type: 'text', text: 'screenshot' },
                { type: 'hapi_image', blobId: 'blob-1', mimeType: 'image/png' }
            ]
        });
    });

    it('uploads Anthropic-style nested base64 image blocks', async () => {
        const upload = vi.fn(async () => 'blob-2');

        const output = await uploadImagesInCodexOutput([
            {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: 'jpeg-data'
                }
            }
        ], upload);

        expect(upload).toHaveBeenCalledWith('image/jpeg', 'jpeg-data');
        expect(output).toEqual([
            { type: 'hapi_image', blobId: 'blob-2', mimeType: 'image/jpeg' }
        ]);
    });

    it('uploads Codex localImage blocks', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-codex-image-'));
        const path = join(dir, 'shot.png');
        await writeFile(path, Buffer.from('png-bytes'));
        const upload = vi.fn(async () => 'blob-local');

        const output = await uploadImagesInCodexOutput({ type: 'localImage', path }, upload);

        expect(upload).toHaveBeenCalledWith('image/png', (await readFile(path)).toString('base64'));
        expect(output).toEqual({ type: 'hapi_image', blobId: 'blob-local', mimeType: 'image/png' });
    });

    it('uploads local screenshot paths from Codex shell stdout and appends renderable image content', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-codex-path-image-'));
        const path = join(dir, 'localhost-3006-real-chrome.png');
        await writeFile(path, Buffer.from('screenshot-bytes'));
        const upload = vi.fn(async () => 'blob-path');

        const output = await uploadImagesInCodexOutput({
            command: 'node screenshot.mjs',
            stdout: JSON.stringify({ ok: true, screenshot: path }) + '\n',
            exit_code: 0
        }, upload);

        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload).toHaveBeenCalledWith('image/png', (await readFile(path)).toString('base64'));
        expect(output).toEqual({
            command: 'node screenshot.mjs',
            stdout: JSON.stringify({ ok: true, screenshot: path }) + '\n',
            exit_code: 0,
            content: [
                { type: 'hapi_image', blobId: 'blob-path', mimeType: 'image/png' }
            ]
        });
    });

    it('does not duplicate uploads for explicit Codex localImage blocks', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-codex-local-image-'));
        const path = join(dir, 'shot.png');
        await writeFile(path, Buffer.from('png-bytes'));
        const upload = vi.fn(async () => 'blob-local');

        const output = await uploadImagesInCodexOutput({ type: 'localImage', path }, upload);

        expect(upload).toHaveBeenCalledTimes(1);
        expect(output).toEqual({ type: 'hapi_image', blobId: 'blob-local', mimeType: 'image/png' });
    });

});
