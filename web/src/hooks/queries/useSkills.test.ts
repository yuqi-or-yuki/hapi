import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useSkills } from './useSkills'

function wrapper(client: QueryClient) {
    return ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children)
}

function makeApi(getSkills: ReturnType<typeof vi.fn>): ApiClient {
    return { getSkills } as unknown as ApiClient
}

describe('useSkills menu refresh', () => {
    it('refreshes on any "$" query once the cache is stale, not only on a bare "$"', async () => {
        const getSkills = vi.fn().mockResolvedValue({ success: true, skills: [{ name: 'hapi-loop' }] })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const { result } = renderHook(() => useSkills(makeApi(getSkills), 'session-1'), {
            wrapper: wrapper(client)
        })

        await waitFor(() => expect(getSkills).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(result.current.skills).toHaveLength(1))

        // Fresh data: typing must not re-fetch.
        await result.current.getSuggestions('$hapi-wor')
        expect(getSkills).toHaveBeenCalledTimes(1)

        // Once stale, a mid-word query refreshes. Typing "$hapi-worker" fast
        // (or pasting it) never yields the lone "$" the old check waited for,
        // which is how a newly added skill stayed invisible.
        client.invalidateQueries({ queryKey: ['skills', 'session-1'], refetchType: 'none' })
        getSkills.mockResolvedValue({
            success: true,
            skills: [{ name: 'hapi-loop' }, { name: 'hapi-worker' }]
        })

        await waitFor(async () => {
            await result.current.getSuggestions('$hapi-wor')
            expect(getSkills).toHaveBeenCalledTimes(2)
        })
        await waitFor(() => expect(result.current.skills.map((s) => s.name)).toContain('hapi-worker'))
    })

    it('offers a skill whose name is only a prefix match', async () => {
        const getSkills = vi.fn().mockResolvedValue({
            success: true,
            skills: [{ name: 'hapi-loop' }, { name: 'hapi-worker' }]
        })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const { result } = renderHook(() => useSkills(makeApi(getSkills), 'session-1'), {
            wrapper: wrapper(client)
        })

        await waitFor(() => expect(result.current.skills).toHaveLength(2))

        const suggestions = await result.current.getSuggestions('$hapi-worker')
        expect(suggestions[0]?.text).toBe('$hapi-worker')
    })
})
