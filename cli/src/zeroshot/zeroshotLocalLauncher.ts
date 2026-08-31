import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
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
 * Deliberately does NOT use BaseLocalLauncher. That helper is built for the
 * local↔remote model where a spawned child process runs for the session's
 * lifetime and any queued message means "switch to remote/interactive mode"
 * — it registers `queue.setOnMessage(() => doSwitch())` and early-returns
 * `'switch'` when the queue is non-empty. Zeroshot has no remote mode and
 * uses that same queue to *deliver its task*, so routing through
 * BaseLocalLauncher makes the task message instantly abort the launch.
 *
 * Instead this owns a simple abort-able poll loop: pull the task, spawn
 * `zeroshot run -d`, then tail the run's SQLite ledger until it reaches a
 * terminal state (authoritative signal is clusters.json's `state`, not any
 * ledger row). The daemon outlives this process by design, so on abort we
 * best-effort `zeroshot stop` it; on a hapi-runner restart the resume path
 * reattaches from the persisted cluster id + cursor.
 */
export async function zeroshotLocalLauncher(
    session: ZeroshotSession,
    opts: ZeroshotLocalLauncherOptions
): Promise<'switch' | 'exit'> {
    const abortController = new AbortController();
    const abortSignal = abortController.signal;

    // Wire the stop/abort/kill RPCs (the web stop button, session kill) so the
    // poll loop actually unwinds. kill-session additionally drives process exit
    // via the lifecycle handler registered in runZeroshot; here we just make
    // sure the loop stops waiting and the daemon is asked to stop.
    const abort = () => {
        if (!abortSignal.aborted) {
            abortController.abort();
        }
    };
    session.client.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, abort);
    session.client.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, abort);

    try {
        let clusterId = opts.initialClusterId;
        let cursor = opts.initialCursor ?? 0;

        if (!clusterId) {
            const task = await opts.getTask(abortSignal);
            if (task === null) {
                // Aborted before a task was ever provided — nothing was spawned.
                return 'exit';
            }
            clusterId = await zeroshotRun({ task, cwd: session.path });
            // Persist immediately — a crash right after this point must still
            // be able to reattach on restart rather than orphaning the daemon
            // or double-spawning a second cluster.
            session.onSessionFound(clusterId);
            session.setStage('plan');
            logger.debug(`[zeroshot-local]: Started cluster ${clusterId}`);
            // Immediate acknowledgement: without this the sender gets no signal
            // their message landed or that it was taken (verbatim) as the run's
            // task — the #1 confusion when someone treats this like a chat.
            session.sendAgentMessage({
                type: 'message',
                message: `▶️ **Zeroshot run started** (cluster \`${clusterId}\`).\n\n`
                    + `Your message was taken as the task to run autonomously:\n\n> ${task}\n\n`
                    + `An executor agent will implement it, then an independent verifier checks it — repeating until verified. `
                    + `Watch the stage badge (plan → implement → verify → done) and the agent/verdict cards below. `
                    + `This is a one-shot run, not a chat: follow-up messages won't steer it.`
            });
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
        // The ledger's CLUSTER_COMPLETE/CLUSTER_FAILED row is the authoritative
        // success/failure signal for the stage badge. clusters.json's `state`
        // is authoritative for *when to stop polling* but NOT for done-vs-failed:
        // Zeroshot's happy path finishes in state 'stopped' (with failureInfo
        // null), not 'completed', so mapping state→stage directly would
        // mislabel a successful run as failed.
        let sawTerminalLedgerStage = false;
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
                    if (converted.terminal) {
                        sawTerminalLedgerStage = true;
                    }
                }
                if (nextTimestamp !== cursor) {
                    cursor = nextTimestamp;
                    session.setLastMessageTimestamp(cursor);
                }

                const record = readZeroshotCluster(clusterId);
                if (record && isTerminalZeroshotState(record.state)) {
                    logger.debug(`[zeroshot-local]: Cluster ${clusterId} reached terminal state ${record.state}`);
                    // Only fall back to a state-inferred stage if the ledger never
                    // gave us a definitive one (e.g. killed/corrupted mid-run).
                    const failed = record.state === 'failed'
                        || record.state === 'corrupted'
                        || record.failureInfo != null;
                    if (!sawTerminalLedgerStage) {
                        session.setStage(failed ? 'failed' : 'done');
                    }
                    // Always leave one unambiguous closing line in the transcript,
                    // so a finished run never just trails off into silence.
                    session.sendAgentMessage({
                        type: 'message',
                        message: failed
                            ? `⚠️ **Zeroshot run ended without a verified result** (cluster \`${clusterId}\`, state: ${record.state}). Review the messages above, or check \`zeroshot status ${clusterId}\` for details.`
                            : `✅ **Zeroshot run complete** (cluster \`${clusterId}\`) — the change was implemented and independently verified. Review the diff in this session's working directory.`
                    });
                    return 'exit';
                }

                if (abortSignal.aborted) {
                    zeroshotStop(clusterId);
                    return 'exit';
                }

                await sleep(POLL_INTERVAL_MS, abortSignal);
            }
        } finally {
            reader.close();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.sendSessionEvent({ type: 'message', message: `Zeroshot run failed: ${message}` });
        session.recordLocalLaunchFailure(message, 'exit');
        logger.warn(`[zeroshot-local]: ${message}`);
        return 'exit';
    } finally {
        // Reset the handlers so a lingering reference can't fire post-teardown.
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {});
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async () => {});
    }
}
