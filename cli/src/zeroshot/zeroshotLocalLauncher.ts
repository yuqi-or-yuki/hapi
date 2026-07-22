import { logger } from '@/ui/logger';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { ZeroshotSession } from './session';
import { zeroshotRun, zeroshotStop } from './zeroshotLocal';
import { ZeroshotLedgerReader } from './utils/zeroshotLedgerScanner';
import { convertZeroshotLedgerRow } from './utils/zeroshotEventConverter';
import { readZeroshotCluster, isTerminalZeroshotState, isPidAlive } from './utils/zeroshotRegistry';

const POLL_INTERVAL_MS = 1500;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export type ZeroshotLocalLauncherOptions = {
    /** Resolves the task text from the first queued user message; null if aborted before one arrived. */
    getTask: (signal: AbortSignal) => Promise<string | null>;
    /** Set when resuming an already-started cluster (from session metadata). */
    initialClusterId?: string;
    /** Ledger poll cursor to resume from, when resuming. */
    initialCursor?: number;
};

/**
 * Structurally different from other backends' local launchers: `zeroshot run
 * -d` exits almost immediately after detaching its daemon, so the actual
 * work happens in a process we don't hold a handle to. The `launch()`
 * callback below therefore doesn't watch a child process — it IS the poll
 * loop, and must not resolve until the run reaches a terminal state (or the
 * launcher is aborted), since BaseLocalLauncher treats a resolved `launch()`
 * as "the process exited, we're done".
 */
export async function zeroshotLocalLauncher(
    session: ZeroshotSession,
    opts: ZeroshotLocalLauncherOptions
): Promise<'switch' | 'exit'> {
    const launcher = new BaseLocalLauncher({
        label: 'zeroshot-local',
        failureLabel: 'Zeroshot run failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: 'local',
        launch: async (abortSignal) => {
            let clusterId = opts.initialClusterId;
            let cursor = opts.initialCursor ?? 0;

            if (!clusterId) {
                const task = await opts.getTask(abortSignal);
                if (task === null) {
                    // Aborted/switched before a task was ever provided — nothing was spawned.
                    return;
                }
                clusterId = await zeroshotRun({ task, cwd: session.path });
                // Persist immediately — a crash right after this point must
                // still be able to reattach on restart rather than orphaning
                // the daemon or double-spawning a second cluster.
                session.onSessionFound(clusterId);
                logger.debug(`[zeroshot-local]: Started cluster ${clusterId}`);
            } else {
                const record = readZeroshotCluster(clusterId);
                if (record && isTerminalZeroshotState(record.state)) {
                    logger.debug(`[zeroshot-local]: Resuming already-terminal cluster ${clusterId} (state=${record.state})`);
                } else if (record && !isPidAlive(record.pid)) {
                    throw new Error(
                        `Zeroshot cluster ${clusterId} is in state '${record.state}' but its daemon (pid ${record.pid ?? 'unknown'}) is not running. `
                        + `It may have crashed or been killed outside HAPI. Check with: zeroshot status ${clusterId}`
                    );
                } else if (!record) {
                    throw new Error(`Zeroshot cluster ${clusterId} was not found in ~/.zeroshot/clusters.json.`);
                }
            }

            const reader = new ZeroshotLedgerReader(clusterId);
            try {
                while (true) {
                    const { rows, nextTimestamp } = reader.pollNewRows(cursor);
                    for (const row of rows) {
                        const converted = convertZeroshotLedgerRow(row);
                        if (!converted) {
                            continue;
                        }
                        if (converted.userMessage) {
                            session.sendUserMessage(converted.userMessage);
                        }
                        if (converted.message) {
                            session.sendAgentMessage(converted.message);
                        }
                        if (converted.stage) {
                            session.setStage(converted.stage);
                        }
                    }
                    if (nextTimestamp !== cursor) {
                        cursor = nextTimestamp;
                        session.setLastMessageTimestamp(cursor);
                    }

                    const record = readZeroshotCluster(clusterId);
                    if (record && isTerminalZeroshotState(record.state)) {
                        logger.debug(`[zeroshot-local]: Cluster ${clusterId} reached terminal state ${record.state}`);
                        session.setStage(record.state === 'completed' ? 'done' : 'failed');
                        return;
                    }

                    if (abortSignal.aborted) {
                        zeroshotStop(clusterId);
                        return;
                    }

                    await sleep(POLL_INTERVAL_MS, abortSignal);
                }
            } finally {
                reader.close();
            }
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    await launcher.run();
    // No remote/ACP mode exists for Zeroshot — any termination (clean finish,
    // abort, or launch failure) is a session exit, never a switch.
    return 'exit';
}
