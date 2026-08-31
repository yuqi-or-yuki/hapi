import { describe, expect, it } from 'vitest';
import type { ModelListParams, ModelListResponse } from '@/codex/appServerTypes';
import { listCodexModelsWithClient } from './codexModels';

class FakeCodexModelClient {
    readonly requests: ModelListParams[] = [];
    connected = false;
    initialized = false;

    constructor(private readonly responses: ModelListResponse[]) {}

    async connect(): Promise<void> {
        this.connected = true;
    }

    async initialize(): Promise<unknown> {
        this.initialized = true;
        return {};
    }

    async listModels(params?: ModelListParams): Promise<ModelListResponse> {
        this.requests.push(params ?? {});
        const response = this.responses.shift();
        if (!response) throw new Error('unexpected extra listModels call');
        return response;
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }
}

describe('listCodexModelsWithClient', () => {
    it('returns the Codex app-server catalog without a HAPI static fallback', async () => {
        const client = new FakeCodexModelClient([{
            data: [{
                id: 'gpt-future-codex',
                displayName: 'GPT Future Codex',
                isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: 'max' }],
                serviceTiers: [{ id: 'priority', name: 'Fast' }]
            }]
        }]);

        await expect(listCodexModelsWithClient(client)).resolves.toEqual([{
            id: 'gpt-future-codex',
            displayName: 'GPT Future Codex',
            isDefault: true,
            defaultReasoningEffort: null,
            supportedReasoningEfforts: ['max'],
            serviceTiers: ['priority', 'fast']
        }]);
        expect(client.requests).toEqual([{ includeHidden: false }]);
    });

    it('follows Codex model/list pagination and deduplicates model ids', async () => {
        const client = new FakeCodexModelClient([
            {
                data: [
                    { id: 'gpt-a', displayName: 'GPT A' },
                    { id: 'gpt-b', displayName: 'GPT B' }
                ],
                nextCursor: 'page-2'
            },
            {
                data: [
                    { id: 'gpt-b', displayName: 'Duplicate GPT B' },
                    { id: 'gpt-c', displayName: 'GPT C' }
                ],
                nextCursor: null
            }
        ]);

        const models = await listCodexModelsWithClient(client, true);

        expect(models.map((model) => model.id)).toEqual(['gpt-a', 'gpt-b', 'gpt-c']);
        expect(client.requests).toEqual([
            { includeHidden: true },
            { includeHidden: true, cursor: 'page-2' }
        ]);
    });
});
