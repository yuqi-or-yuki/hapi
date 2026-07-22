import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { createRunnerLifecycle } from '@/agent/runnerLifecycle';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { ZeroshotSession } from './session';
import { zeroshotLocalLauncher } from './zeroshotLocalLauncher';
import type { ZeroshotMode } from './types';

export async function runZeroshot(opts: {
    startedBy?: 'runner' | 'terminal';
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[zeroshot] Starting with options: startedBy=${startedBy}`);

    // Zeroshot runs fully autonomously with no interactive local terminal to
    // hand control to/from — there's no local/remote distinction to track.
    const initialState: AgentState = { controlledByUser: false };

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'zeroshot',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'zeroshot',
            startedBy,
            workingDirectory,
            agentState: initialState
        });
    const { api, session, metadata } = bootstrap;

    const messageQueue = new MessageQueue2<ZeroshotMode>(() => hashObject({}));

    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, {}, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[zeroshot] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'zeroshot'
    });
    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle);

    const zeroshotSession = new ZeroshotSession({
        api,
        client: session,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        sessionId: opts.resumeSessionId ?? null,
        messageQueue,
        onModeChange: () => {},
        startedBy
    });

    if (opts.resumeSessionId) {
        zeroshotSession.onSessionFound(opts.resumeSessionId);
    }

    let crashed = false;
    try {
        await zeroshotLocalLauncher(zeroshotSession, {
            getTask: async (signal) => {
                const result = await messageQueue.waitForMessagesAndGetAsString(signal);
                return result?.message ?? null;
            },
            initialClusterId: metadata.zeroshotSessionId,
            initialCursor: metadata.zeroshotLastMessageTimestamp
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[zeroshot] Loop error:', error);
    } finally {
        const localFailure = zeroshotSession.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Zeroshot run failed: ${localFailure.message.slice(0, 200)}`);
            lifecycle.setSessionEndReason('error');
        } else if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
