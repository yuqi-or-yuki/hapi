import React from "react";
import { Session } from "./session";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { LoopEvaluator } from "./loopEvaluator";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { uploadImagesInLogMessage } from "./utils/imageUpload";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from "@/modules/common/remote/RemoteLauncherBase";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: ClaudePermissionMode;
    allowedTools?: string[];
}

class ClaudeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: Session;
    private abortController: AbortController | null = null;
    private abortFuture: Future<void> | null = null;
    private permissionHandler: PermissionHandler | null = null;
    private handleSessionFound: ((sessionId: string) => void) | null = null;

    constructor(session: Session) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context);
    }

    private async abort(): Promise<void> {
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
        await this.abortFuture?.promise;
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[remote]: doAbort');
        await this.abort();
    }

    private async handleSwitchRequest(): Promise<void> {
        logger.debug('[remote]: doSwitch');
        await this.requestExit('switch', async () => {
            await this.abort();
        });
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[remote]: Exiting client via Ctrl-C');
        await this.requestExit('exit', async () => {
            await this.abort();
        });
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[remote]: Switching to local mode via double space');
        await this.handleSwitchRequest();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[claudeRemoteLauncher] Starting remote launcher');
        logger.debug(`[claudeRemoteLauncher] TTY available: ${this.hasTTY}`);

        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const permissionHandler = new PermissionHandler(session);
        this.permissionHandler = permissionHandler;

        const messageQueue = new OutgoingMessageQueue(
            (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
        );

        permissionHandler.setOnPermissionRequest((toolCallId: string) => {
            messageQueue.releaseToolCall(toolCallId);
        });

        const sdkToLogConverter = new SDKToLogConverter({
            sessionId: session.sessionId || 'unknown',
            cwd: session.path,
            version: process.env.npm_package_version
        }, permissionHandler.getResponses());

        const handleSessionFound = (sessionId: string) => {
            sdkToLogConverter.updateSessionId(sessionId);
        };
        this.handleSessionFound = handleSessionFound;
        session.addSessionFoundCallback(handleSessionFound);

        let planModeToolCalls = new Set<string>();
        let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();

        // Serial chain ensures messages are sent in order even when blob uploads are async
        let messageChain: Promise<void> = Promise.resolve()

        function enqueueWithImageUpload(logMsg: any, options?: { delay?: number; toolCallIds?: string[] }) {
            messageChain = messageChain
                .then(async () => {
                    const processed = await uploadImagesInLogMessage(logMsg, (mimeType, data) => session.client.uploadBlobToHub(mimeType, data))
                    messageQueue.enqueue(processed, options)
                })
                .catch(e => {
                    logger.debug('[remote]: message chain error, enqueueing unprocessed', e)
                    messageQueue.enqueue(logMsg, options)
                })
        }

        function onMessage(message: SDKMessage) {
            formatClaudeMessageForInk(message, messageBuffer);
            permissionHandler.onMessage(message);

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                            logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                            planModeToolCalls.add(c.id! as string);
                        }
                    }
                }
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use') {
                            logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                            ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                        }
                    }
                }
            }
            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            ongoingToolCalls.delete(c.tool_use_id);
                            messageQueue.releaseToolCall(c.tool_use_id);
                        }
                    }
                }
            }

            let msg = message;

            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    msg = {
                        ...umessage,
                        message: {
                            ...umessage.message,
                            content: umessage.message.content.map((c) => {
                                if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                    if (c.content === PLAN_FAKE_REJECT) {
                                        logger.debug('[remote]: hack plan mode exit');
                                        logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                        return {
                                            ...c,
                                            is_error: false,
                                            content: 'Plan approved',
                                            mode: c.mode
                                        };
                                    } else {
                                        return c;
                                    }
                                }
                                return c;
                            })
                        }
                    };
                }
            }

            const logMessage = sdkToLogConverter.convert(msg);
            if (logMessage) {
                if (logMessage.type === 'user' && logMessage.message?.content) {
                    const content = Array.isArray(logMessage.message.content)
                        ? logMessage.message.content
                        : [];

                    for (let i = 0; i < content.length; i++) {
                        const c = content[i];
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            const responses = permissionHandler.getResponses();
                            const response = responses.get(c.tool_use_id);

                            if (response) {
                                const permissions: PermissionsField = {
                                    date: response.receivedAt || Date.now(),
                                    result: response.approved ? 'approved' : 'denied'
                                };

                                if (response.mode) {
                                    permissions.mode = response.mode;
                                }

                                if (response.allowTools && response.allowTools.length > 0) {
                                    permissions.allowedTools = response.allowTools;
                                }

                                content[i] = {
                                    ...c,
                                    permissions
                                };
                            }
                        }
                    }
                }

                if (logMessage.type === 'assistant' && message.type === 'assistant') {
                    const assistantMsg = message as SDKAssistantMessage;
                    const toolCallIds: string[] = [];

                    if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                        for (const block of assistantMsg.message.content) {
                            if (block.type === 'tool_use' && block.id) {
                                toolCallIds.push(block.id);
                            }
                        }
                    }

                    if (toolCallIds.length > 0) {
                        const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                        if (!isSidechain) {
                            enqueueWithImageUpload(logMessage, {
                                delay: 250,
                                toolCallIds
                            });
                            return;
                        }
                    }
                }

                enqueueWithImageUpload(logMessage);
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                            const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                            if (logMessage2) {
                                enqueueWithImageUpload(logMessage2);
                            }
                        }
                    }
                }
            }
        }

        try {
            let pending: {
                message: string;
                mode: EnhancedMode;
            } | null = null;

            const loopEvaluator = LoopEvaluator.isLoopMode(session.path) && LoopEvaluator.acquireLock(session.path, session.client.sessionId)
                ? new LoopEvaluator(session.path, LoopEvaluator.readConfig(session.path).maxIterations)
                : null
            if (loopEvaluator) {
                logger.debug(`[loop] Loop mode active: SUCCESS_CONDITION.md found in ${session.path}`)
            } else if (LoopEvaluator.isLoopMode(session.path)) {
                logger.debug(`[loop] SUCCESS_CONDITION.md present but loop lock held by another session — running normally`)
            }

            let previousSessionId: string | null = null;
            while (!this.exitReason) {
                logger.debug('[remote]: launch');
                messageBuffer.addMessage('═'.repeat(40), 'status');

                const isNewSession = session.sessionId !== previousSessionId;
                if (isNewSession) {
                    messageBuffer.addMessage('Starting new Claude session...', 'status');
                    permissionHandler.reset();
                    sdkToLogConverter.resetParentChain();
                    logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                } else {
                    messageBuffer.addMessage('Continuing Claude session...', 'status');
                    logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
                }

                previousSessionId = session.sessionId;
                const controller = new AbortController();
                this.abortController = controller;
                this.abortFuture = new Future<void>();
                let modeHash: string | null = null;
                let mode: EnhancedMode | null = null;
                try {
                    await claudeRemote({
                        sessionId: session.sessionId,
                        path: session.path,
                        allowedTools: session.allowedTools ?? [],
                        mcpServers: session.mcpServers,
                        hookSettingsPath: session.hookSettingsPath,
                        canCallTool: permissionHandler.handleToolCall,
                        isAborted: (toolCallId: string) => {
                            return permissionHandler.isAborted(toolCallId);
                        },
                        nextMessage: async () => {
                            if (pending) {
                                let p = pending;
                                pending = null;
                                permissionHandler.handleModeChange(p.mode.permissionMode);
                                return p;
                            }

                            let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                            if (msg) {
                                if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                    logger.debug('[remote]: mode has changed, pending message');
                                    pending = msg;
                                    return null;
                                }
                                modeHash = msg.hash;
                                mode = msg.mode;
                                permissionHandler.handleModeChange(mode.permissionMode);
                                return {
                                    message: msg.message,
                                    mode: msg.mode
                                };
                            }

                            return null;
                        },
                        onSessionFound: (sessionId) => {
                            session.onSessionFound(sessionId);
                        },
                        onThinkingChange: session.onThinkingChange,
                        claudeEnvVars: session.claudeEnvVars,
                        claudeArgs: session.claudeArgs,
                        onMessage,
                        onCompletionEvent: (message: string) => {
                            logger.debug(`[remote]: Completion event: ${message}`);
                            session.client.sendSessionEvent({ type: 'message', message });
                        },
                        onSessionReset: () => {
                            logger.debug('[remote]: Session reset');
                            session.clearSessionId();
                        },
                        onReady: async () => {
                            logger.debug(
                                `[claudeRemoteLauncher][async-debug] onReady callback ` +
                                `(hasPending=${Boolean(pending)}, queueSize=${session.queue.size()})`
                            );
                            await messageQueue.flush();
                            logger.debug('[claudeRemoteLauncher][async-debug] message queue flushed before ready');

                            // Loop mode: run evaluator after each Claude turn
                            if (loopEvaluator && !this.exitReason && !pending && session.queue.size() === 0) {
                                logger.debug('[loop] running evaluator...')
                                const judgment = await loopEvaluator.evaluate()
                                if (!judgment.success && loopEvaluator.currentIteration < loopEvaluator.maxIterations) {
                                    const feedback = [
                                        `[Loop — iteration ${loopEvaluator.currentIteration} of ${loopEvaluator.maxIterations}]`,
                                        ``,
                                        `Not yet complete. ${judgment.reason}`,
                                        ``,
                                        `Suggestions:`,
                                        judgment.suggestions,
                                    ].join('\n')
                                    const loopMode: EnhancedMode = mode ?? { permissionMode: 'default' }
                                    session.queue.push(feedback, loopMode)
                                    logger.debug('[loop] injected evaluator feedback, continuing loop')
                                    // Don't send ready — the queued feedback drives the next iteration
                                    return
                                } else if (judgment.success) {
                                    logger.debug('[loop] SUCCESS — task complete')
                                    LoopEvaluator.releaseLock(session.path)
                                    session.client.sendSessionEvent({
                                        type: 'message',
                                        message: `Loop complete after ${loopEvaluator.currentIteration} iteration(s): ${judgment.reason}`,
                                    })
                                } else {
                                    logger.debug('[loop] max iterations reached without success')
                                    LoopEvaluator.releaseLock(session.path)
                                    session.client.sendSessionEvent({
                                        type: 'message',
                                        message: `Loop ended after ${loopEvaluator.currentIteration} iteration(s) (max reached). Last status: ${judgment.reason}`,
                                    })
                                }
                            }

                            if (!pending && session.queue.size() === 0) {
                                session.client.sendSessionEvent({ type: 'ready' });
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event sent to hub');
                            } else {
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event suppressed (pending input exists)');
                            }
                        },
                        signal: controller.signal,
                    });

                    session.consumeOneTimeFlags();

                    if (!this.exitReason && controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }
                } catch (e) {
                    logger.debug('[remote]: launch error', e);
                    if (!this.exitReason) {
                        const detail = e instanceof Error ? e.message : String(e);
                        session.client.sendSessionEvent({ type: 'message', message: `Process exited unexpectedly: ${detail}` });
                        continue;
                    }
                } finally {
                    logger.debug('[remote]: launch finally');

                    for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                        const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                        if (converted) {
                            logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                            session.client.sendClaudeSessionMessage(converted);
                        }
                    }
                    ongoingToolCalls.clear();

                    logger.debug('[remote]: flushing message queue');
                    await messageQueue.flush();
                    messageQueue.destroy();
                    logger.debug('[remote]: message queue flushed');

                    this.abortController = null;
                    this.abortFuture?.resolve(undefined);
                    this.abortFuture = null;
                    logger.debug('[remote]: launch done');
                    permissionHandler.reset();
                    modeHash = null;
                    mode = null;
                }
            }
        } finally {
            if (this.permissionHandler) {
                this.permissionHandler.reset();
            }
            // Release loop lock if this session owned it (covers abort/crash paths)
            if (LoopEvaluator.isLoopMode(session.path)) {
                LoopEvaluator.releaseLock(session.path)
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.handleSessionFound) {
            this.session.removeSessionFoundCallback(this.handleSessionFound);
            this.handleSessionFound = null;
        }

        if (this.permissionHandler) {
            this.permissionHandler.reset();
        }

        if (this.abortFuture) {
            this.abortFuture.resolve(undefined);
        }
    }
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    const launcher = new ClaudeRemoteLauncher(session);
    return launcher.launch();
}
