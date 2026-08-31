import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ZeroshotClusterState =
    | 'setup'
    | 'initializing'
    | 'running'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'killed'
    | 'corrupted';

export type ZeroshotClusterRecord = {
    id: string;
    state: ZeroshotClusterState;
    pid?: number;
    createdAt?: number;
    issue?: string;
    /** Non-null when the run failed; null/absent on the (state='stopped') success path. */
    failureInfo?: unknown;
    [key: string]: unknown;
};

const TERMINAL_STATES: ReadonlySet<ZeroshotClusterState> = new Set([
    'completed', 'failed', 'stopped', 'killed', 'corrupted'
]);

export function isTerminalZeroshotState(state: ZeroshotClusterState): boolean {
    return TERMINAL_STATES.has(state);
}

export function getZeroshotHomeDir(): string {
    return join(homedir(), '.zeroshot');
}

export function getZeroshotDbPath(clusterId: string): string {
    return join(getZeroshotHomeDir(), `${clusterId}.db`);
}

/**
 * Reads `~/.zeroshot/clusters.json` directly rather than depending on
 * Zeroshot's own internal module — this registry file's shape is a stable,
 * externally-observed contract (the same one Zeroshot's own `list`/`status`
 * CLI commands read), not an implementation detail we need to import.
 */
export function readZeroshotCluster(clusterId: string): ZeroshotClusterRecord | null {
    const registryPath = join(getZeroshotHomeDir(), 'clusters.json');
    let raw: string;
    try {
        raw = readFileSync(registryPath, 'utf8');
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const record = (parsed as Record<string, unknown>)[clusterId];
    if (!record || typeof record !== 'object') {
        return null;
    }
    const candidate = record as Record<string, unknown>;
    if (typeof candidate.state !== 'string') {
        return null;
    }
    return { ...candidate, id: clusterId, state: candidate.state as ZeroshotClusterState };
}

/** Best-effort liveness check for a cluster daemon's tracked pid. */
export function isPidAlive(pid: number | undefined): boolean {
    if (!pid) {
        return false;
    }
    try {
        // Signal 0 performs no-op existence/permission check without killing anything.
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
