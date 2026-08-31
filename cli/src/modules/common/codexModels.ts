import type { CodexModelsResponse, CodexModelSummary } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { ModelListParams, ModelListResponse } from '@/codex/appServerTypes';
import { getErrorMessage } from './rpcResponses';

export interface ListCodexModelsRequest {
    includeHidden?: boolean;
}

export type ListCodexModelsResponse = CodexModelsResponse;

type CodexModelListClient = {
    connect(): Promise<void>;
    initialize(params: Parameters<CodexAppServerClient['initialize']>[0]): Promise<unknown>;
    listModels(params?: ModelListParams): Promise<ModelListResponse>;
    disconnect(): Promise<void>;
};

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSupportedReasoningEfforts(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const efforts = value
        .map((entry) => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            const reasoningEffort = asNonEmptyString((entry as { reasoningEffort?: unknown }).reasoningEffort);
            return reasoningEffort;
        })
        .filter((entry): entry is string => entry !== null);

    return efforts.length > 0 ? efforts : undefined;
}

// The Codex model catalog advertises which service tiers are available for a
// model in the *current* account/auth context — e.g. an API-key session or a
// plan without Fast credits simply won't list a Fast tier. We surface the tier
// id AND display name as lowercased search tokens so the web can gate the
// Fast-mode toggle on real availability. The Fast tier's catalog id is
// `'priority'` but its name is `'Fast'`, so capturing the name is what lets a
// `/fast/i` match recognise it. (See OpenAI Codex speed docs: Fast maps to the
// request value `priority`.)
function normalizeServiceTiers(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const tokens = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const record = entry as { id?: unknown; name?: unknown };
        const id = asNonEmptyString(record.id);
        const name = asNonEmptyString(record.name);
        if (id) tokens.add(id.toLowerCase());
        if (name) tokens.add(name.toLowerCase());
    }

    return tokens.size > 0 ? [...tokens] : undefined;
}

export function normalizeCodexModel(entry: unknown): CodexModelSummary | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const record = entry as Record<string, unknown>;
    const id = asNonEmptyString(record.id) ?? asNonEmptyString(record.model);
    if (!id) {
        return null;
    }

    return {
        id,
        displayName: asNonEmptyString(record.displayName) ?? id,
        isDefault: record.isDefault === true,
        defaultReasoningEffort: asNonEmptyString(record.defaultReasoningEffort),
        supportedReasoningEfforts: normalizeSupportedReasoningEfforts(record.supportedReasoningEfforts),
        serviceTiers: normalizeServiceTiers(record.serviceTiers)
    };
}

function responseModels(response: ModelListResponse): unknown[] {
    if (Array.isArray(response.data)) {
        return response.data;
    }

    // Be lenient with future Codex app-server response envelopes while still
    // treating Codex as the source of truth. No HAPI-side static catalog/fallback.
    const record = response as Record<string, unknown>;
    if (Array.isArray(record.models)) {
        return record.models;
    }
    if (Array.isArray(record.items)) {
        return record.items;
    }
    return [];
}

export async function listCodexModelsWithClient(
    client: CodexModelListClient,
    includeHidden: boolean = false
): Promise<CodexModelSummary[]> {
    await client.connect();
    await client.initialize({
        clientInfo: {
            name: 'hapi-codex-models',
            version: '1.0.0'
        },
        capabilities: {
            experimentalApi: true
        }
    });

    const models: CodexModelSummary[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined;

    do {
        const response = await client.listModels({
            includeHidden,
            ...(cursor ? { cursor } : {})
        });
        for (const model of responseModels(response)) {
            const normalized = normalizeCodexModel(model);
            if (!normalized || seen.has(normalized.id)) {
                continue;
            }
            seen.add(normalized.id);
            models.push(normalized);
        }
        cursor = asNonEmptyString(response.nextCursor);
    } while (cursor);

    return models;
}

export async function listCodexModels(includeHidden: boolean = false): Promise<CodexModelSummary[]> {
    const client = new CodexAppServerClient();

    try {
        return await listCodexModelsWithClient(client, includeHidden);
    } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to list Codex models'));
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}
