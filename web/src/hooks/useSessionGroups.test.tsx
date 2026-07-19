import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useSessionGroups, type UserSessionGroup } from './useSessionGroups'

const STORAGE_KEY = 'hapi-session-groups-v1'

function makeApi(initialServerGroups: UserSessionGroup[]) {
    let serverStore: UserSessionGroup[] = initialServerGroups
    const api = {
        getPreference: vi.fn(async () => serverStore),
        setPreference: vi.fn(async (_key: string, value: UserSessionGroup[]) => {
            serverStore = value
        })
    } as unknown as ApiClient
    return { api, getServerStore: () => serverStore }
}

function makeWrapper() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const Wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return { Wrapper, queryClient }
}

describe('useSessionGroups', () => {
    it('deleting the last remaining group keeps it deleted (does not resurrect from stale localStorage)', async () => {
        const demoGroup: UserSessionGroup = {
            id: 'grp_demo',
            name: 'demo',
            sessionIds: [],
            projectGroupKey: 'machine::repo/tenera',
            collapsed: false
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify([demoGroup]))
        const { api, getServerStore } = makeApi([demoGroup])
        const { Wrapper, queryClient } = makeWrapper()

        const { result } = renderHook(() => useSessionGroups(api), { wrapper: Wrapper })

        // Wait for the real server fetch (not just the localSeed fallback) to land in
        // the query cache before deleting, so we're testing the same state a real user
        // interaction would see.
        await waitFor(() => expect(queryClient.getQueryData(queryKeys.sessionGroups)).toEqual([demoGroup]))

        act(() => {
            result.current.deleteGroup('grp_demo')
        })

        await waitFor(() => expect(result.current.groups).toHaveLength(0))
        await waitFor(() => expect(getServerStore()).toHaveLength(0))

        // The one-time migration effect must not fire again and re-push the stale
        // localSeed (which still contains "demo") back onto the now-empty server list.
        await new Promise(resolve => setTimeout(resolve, 50))

        expect(result.current.groups).toHaveLength(0)
        expect(getServerStore()).toHaveLength(0)
    })

    it('migrates local-only groups to the server exactly once on first load', async () => {
        const demoGroup: UserSessionGroup = {
            id: 'grp_demo',
            name: 'demo',
            sessionIds: [],
            projectGroupKey: 'machine::repo/tenera',
            collapsed: false
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify([demoGroup]))
        const { api, getServerStore } = makeApi([])
        const { Wrapper } = makeWrapper()

        renderHook(() => useSessionGroups(api), { wrapper: Wrapper })

        await waitFor(() => expect(getServerStore()).toHaveLength(1))
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(api.setPreference).toHaveBeenCalledTimes(1)
    })
})
