import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useMachines(api: ApiClient | null, enabled: boolean): {
    machines: Machine[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.machines,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getMachines()
        },
        enabled: Boolean(api && enabled),
        // SSE `machine-updated` patches this cache and reconnect invalidates it;
        // the default 5s staleness made every one of the ~7 mounts refetch.
        staleTime: 60_000,
    })

    return {
        machines: query.data?.machines ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load machines' : null,
        refetch: query.refetch,
    }
}
