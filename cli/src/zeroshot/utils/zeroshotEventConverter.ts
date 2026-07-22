import type { CodexMessage } from '@/agent/messageConverter';
import type { ZeroshotLedgerRow } from './zeroshotLedgerScanner';

export type ZeroshotStage = 'plan' | 'implement' | 'verify' | 'done' | 'failed';

export type ZeroshotConversion = {
    userMessage?: string;
    message?: CodexMessage;
    stage?: ZeroshotStage;
    /** Informational only — clusters.json's `state` field is the authoritative
     *  terminal signal the launcher gates its polling loop on, not this. */
    terminal?: 'complete' | 'failed';
};

function parseContentData(row: ZeroshotLedgerRow): Record<string, unknown> {
    if (!row.content_data) {
        return {};
    }
    try {
        const parsed = JSON.parse(row.content_data);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const VALIDATION_TOPICS = new Set([
    'VALIDATION_RESULT',
    'QUICK_VALIDATION_RESULT',
    'HEAVY_VALIDATION_RESULT'
]);

/**
 * Pure mapping from a Zeroshot ledger row to HAPI's internal message shape.
 * v1 scope covers: ISSUE_OPENED, AGENT_LIFECYCLE, the VALIDATION_RESULT
 * family, TOKEN_USAGE, and CLUSTER_COMPLETE/CLUSTER_FAILED. Raw AGENT_OUTPUT
 * (per-provider transcript replay) is intentionally not parsed here — see
 * the implementation plan for why reusing HAPI's existing codex converter
 * would silently produce nothing for Zeroshot's `codex exec --json` output
 * schema, which doesn't match it.
 *
 * Deliberately defensive: cluster templates can vary agent role/event names,
 * so unrecognized shapes degrade to a generic passthrough rather than throwing.
 */
export function convertZeroshotLedgerRow(row: ZeroshotLedgerRow): ZeroshotConversion | null {
    const data = parseContentData(row);

    switch (row.topic) {
        case 'ISSUE_OPENED': {
            const text = row.content_text ?? asString(data.text) ?? asString(data.issue);
            if (!text) {
                return null;
            }
            return { userMessage: text, stage: 'plan' };
        }

        case 'AGENT_LIFECYCLE': {
            const event = asString(data.event) ?? 'lifecycle';
            const role = asString(data.role);
            const callId = `zeroshot-agent:${row.id}`;
            return {
                message: {
                    type: 'tool-call',
                    name: 'ZeroshotAgent',
                    callId,
                    input: {
                        event,
                        agent: asString(data.agent),
                        role,
                        state: asString(data.state),
                        model: asString(data.model),
                        provider: asString(data.provider),
                        iteration: asNumber(data.iteration)
                    },
                    status: 'completed'
                },
                stage: role === 'validator' ? 'verify' : 'implement'
            };
        }

        case 'VALIDATION_RESULT':
        case 'QUICK_VALIDATION_RESULT':
        case 'HEAVY_VALIDATION_RESULT': {
            const approved = data.approved === true;
            const callId = `zeroshot-verdict:${row.id}`;
            return {
                message: {
                    type: 'tool-call',
                    name: 'ZeroshotVerdict',
                    callId,
                    input: {
                        topic: row.topic,
                        approved,
                        summary: asString(data.summary),
                        errors: Array.isArray(data.errors) ? data.errors : undefined,
                        criteriaResults: data.criteriaResults
                    },
                    status: 'completed'
                },
                stage: 'verify'
            };
        }

        case 'TOKEN_USAGE': {
            const inputTokens = asNumber(data.inputTokens) ?? 0;
            const outputTokens = asNumber(data.outputTokens) ?? 0;
            const cachedInputTokens = asNumber(data.cacheReadInputTokens);
            return {
                message: {
                    type: 'token_count',
                    info: {
                        total: { inputTokens, outputTokens, cachedInputTokens }
                    }
                }
            };
        }

        case 'CLUSTER_COMPLETE': {
            const summary = row.content_text ?? asString(data.reason) ?? 'Zeroshot run completed.';
            return { message: { type: 'message', message: summary }, stage: 'done', terminal: 'complete' };
        }

        case 'CLUSTER_FAILED': {
            const summary = row.content_text ?? asString(data.reason) ?? 'Zeroshot run failed.';
            return { message: { type: 'message', message: summary }, stage: 'failed', terminal: 'failed' };
        }

        default:
            return null;
    }
}
