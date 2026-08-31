import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelListParams, ModelListResponse } from '@/codex/appServerTypes';

const { constructorOptions, listModelsMock } = vi.hoisted(() => ({
    constructorOptions: [] as unknown[],
    listModelsMock: vi.fn()
}));

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: vi.fn(() => '/neutral-home') };
});

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: class {
        constructor(options: unknown) {
            constructorOptions.push(options);
        }

        async connect(): Promise<void> {}
        async initialize(): Promise<void> {}
        async listModels(): Promise<{ data: unknown[] }> {
            return listModelsMock();
        }
        async disconnect(): Promise<void> {}
    }
}));

import { listCodexModels, listCodexModelsWithClient, _resetCodexModelsCacheForTests } from './codexModels';

describe('listCodexModels cwd', () => {
    beforeEach(() => {
        constructorOptions.length = 0;
        listModelsMock.mockReset();
        _resetCodexModelsCacheForTests();
    });

    it('starts discovery from the user home instead of the caller cwd', async () => {
        listModelsMock.mockResolvedValue({ data: [] });

        await listCodexModels();

        expect(constructorOptions).toEqual([{ cwd: '/neutral-home' }]);
    });

    it('caches the model list within the TTL so repeat calls skip the app-server spawn', async () => {
        listModelsMock.mockResolvedValue({
            data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true }]
        });

        const first = await listCodexModels();
        const second = await listCodexModels();

        expect(first).toEqual([expect.objectContaining({
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            isDefault: true
        })]);
        expect(second).toEqual(first);
        expect(constructorOptions).toHaveLength(1);
        expect(listModelsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps visible and hidden model lists in separate cache slots', async () => {
        listModelsMock.mockResolvedValue({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

        await listCodexModels(false);
        await listCodexModels(false);
        await listCodexModels(true);
        await listCodexModels(true);

        expect(constructorOptions).toHaveLength(2);
    });

    it('coalesces concurrent requests into a single app-server spawn', async () => {
        let resolveList: (value: { data: unknown[] }) => void = () => undefined;
        listModelsMock.mockImplementationOnce(
            () => new Promise((res) => { resolveList = res; })
        );

        const inflight1 = listCodexModels();
        const inflight2 = listCodexModels();

        // Allow the microtasks to schedule the first request before resolving it.
        await new Promise((resolve) => setImmediate(resolve));
        resolveList({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

        const [first, second] = await Promise.all([inflight1, inflight2]);

        expect(constructorOptions).toHaveLength(1);
        expect(listModelsMock).toHaveBeenCalledTimes(1);
        expect(first).toEqual(second);
        expect(first).toHaveLength(1);
    });

    it('expires the cache after the TTL so a later call respawns the app-server', async () => {
        vi.useFakeTimers();
        try {
            listModelsMock.mockResolvedValue({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

            await listCodexModels();
            expect(constructorOptions).toHaveLength(1);

            vi.advanceTimersByTime(5 * 60_000 + 1);
            await listCodexModels();
            expect(constructorOptions).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not cache empty or failed results', async () => {
        listModelsMock.mockResolvedValue({ data: [] });
        await listCodexModels();
        await listCodexModels();
        expect(constructorOptions).toHaveLength(2);

        listModelsMock.mockRejectedValue(new Error('app-server exploded'));
        await expect(listCodexModels()).rejects.toThrow('app-server exploded');
        await expect(listCodexModels()).rejects.toThrow('app-server exploded');
        expect(constructorOptions).toHaveLength(4);    });
});

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
            defaultServiceTier: null,
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
