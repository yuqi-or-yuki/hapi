import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { ZeroshotMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class ZeroshotSession extends AgentSessionBase<ZeroshotMode> {
    readonly startedBy: 'runner' | 'terminal';
    localLaunchFailure: LocalLaunchFailure | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<ZeroshotMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        startedBy: 'runner' | 'terminal';
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: 'local',
            sessionLabel: 'ZeroshotSession',
            sessionIdLabel: 'Zeroshot',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                zeroshotSessionId: sessionId
            })
        });

        this.startedBy = opts.startedBy;
    }

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message);
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };

    /** Persists the ledger poll cursor so a restarted launcher can resume without re-forwarding/losing messages. */
    setLastMessageTimestamp = (timestamp: number): void => {
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            zeroshotLastMessageTimestamp: timestamp
        }));
    };

    /** Persists the coarse run stage shown as a session-list badge. */
    setStage = (stage: 'plan' | 'implement' | 'verify' | 'done' | 'failed'): void => {
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            zeroshotStage: stage
        }));
    };
}
