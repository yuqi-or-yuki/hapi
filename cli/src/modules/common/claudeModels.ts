import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ModelInfo, SDKControlResponse } from '@/claude/sdk';
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils';

export interface ListClaudeModelsRequest {}

export interface ListClaudeModelsResponse {
    success: boolean;
    models?: ModelInfo[];
    error?: string;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;

let cache: { expiresAt: number; models: ModelInfo[] } | null = null;
let inflight: Promise<ModelInfo[]> | null = null;

/**
 * Spawns a throwaway `claude` process and asks it for its supported models via
 * the `list_models` control request — no prompt, no conversation turn needed;
 * the CLI answers control requests immediately after spawn. Mirrors how
 * listCodexModels() in codexModels.ts opens a standalone connection rather than
 * reusing a live session.
 */
function probeClaudeModels(): Promise<ModelInfo[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(getDefaultClaudeCodePath(), [
            '--output-format', 'stream-json',
            '--verbose',
            '--input-format', 'stream-json'
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const rl = createInterface({ input: child.stdout });
        let settled = false;

        const finish = (result: { ok: true; models: ModelInfo[] } | { ok: false; error: Error }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rl.close();
            child.kill('SIGKILL');
            if (result.ok) {
                resolve(result.models);
            } else {
                reject(result.error);
            }
        };

        const timer = setTimeout(() => {
            finish({ ok: false, error: new Error('Timed out waiting for Claude Code to report supported models') });
        }, PROBE_TIMEOUT_MS);

        rl.on('line', (line) => {
            if (!line.trim()) return;
            let message: SDKControlResponse;
            try {
                message = JSON.parse(line);
            } catch {
                return;
            }
            if (message.type !== 'control_response' || message.response.request_id !== 'list-models') {
                return;
            }
            if (message.response.subtype === 'success') {
                finish({ ok: true, models: message.response.response?.models ?? [] });
            } else {
                finish({ ok: false, error: new Error(message.response.error ?? 'Failed to list Claude models') });
            }
        });

        child.on('error', (error) => {
            finish({ ok: false, error });
        });
        child.on('close', (code) => {
            if (!settled) {
                finish({ ok: false, error: new Error(`Claude Code process exited with code ${code} before reporting models`) });
            }
        });

        child.stdin.write(JSON.stringify({
            request_id: 'list-models',
            type: 'control_request',
            request: { subtype: 'list_models' }
        }) + '\n');
    });
}

export async function listClaudeModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
        return cache.models;
    }
    if (!inflight) {
        inflight = probeClaudeModels()
            .then((models) => {
                cache = { expiresAt: Date.now() + CACHE_TTL_MS, models };
                return models;
            })
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}
