import spawn from 'cross-spawn';
import { logger } from '@/ui/logger';

const STARTED_LINE = /^Started (\S+)/m;

export class ZeroshotNotInstalledError extends Error {
    constructor(cause: unknown) {
        super(
            'Zeroshot CLI not found. Install it with: npm install -g @the-open-engine/zeroshot',
            { cause }
        );
        this.name = 'ZeroshotNotInstalledError';
    }
}

/**
 * One-shot spawn: `zeroshot run <task> -d` prints `Started <clusterId>` to
 * stdout and exits once the daemon is registered/detached (typically 1-2s) —
 * this is not a long-lived process we hold open, unlike other backends'
 * local launchers, so it doesn't use spawnWithAbort's kill-tree machinery.
 */
export async function zeroshotRun(opts: { task: string; cwd: string }): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('zeroshot', ['run', opts.task, '-d'], {
            cwd: opts.cwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

        child.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                reject(new ZeroshotNotInstalledError(error));
                return;
            }
            reject(error);
        });

        child.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`zeroshot run exited with code ${code ?? 'null'}: ${stderr.trim() || stdout.trim() || '(no output)'}`));
                return;
            }
            const match = STARTED_LINE.exec(stdout);
            if (!match) {
                reject(new Error(`zeroshot run succeeded but no cluster id was found in its output: ${stdout.trim()}`));
                return;
            }
            resolve(match[1]);
        });
    });
}

/** Fire-and-forget graceful stop — best-effort, never blocks session teardown on it. */
export function zeroshotStop(clusterId: string): void {
    try {
        const child = spawn('zeroshot', ['stop', clusterId], { stdio: 'ignore' });
        child.on('error', (error) => {
            logger.debug(`[zeroshot-local]: zeroshot stop ${clusterId} failed to spawn`, error);
        });
    } catch (error) {
        logger.debug(`[zeroshot-local]: zeroshot stop ${clusterId} threw`, error);
    }
}
