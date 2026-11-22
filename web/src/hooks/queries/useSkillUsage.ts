import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'

export type SkillUsage = { calls: number; lastUsedAt: number }

/**
 * Times each skill has been invoked, counted from your own prompts.
 *
 * Derived on the hub rather than tracked as it happens, so the numbers are
 * retroactive over your whole history. Held for the session: the scan is
 * incremental, but a usage count does not need to be live to the second.
 */
export function useSkillUsage(api: ApiClient | null): {
    usage: Record<string, SkillUsage>
    isLoading: boolean
} {
    const query = useQuery({
        queryKey: ['skill-usage'],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            const response = await api.getSkillUsage()
            if (!response.success) throw new Error(response.error || 'Failed to read skill usage')
            return response.counts ?? {}
        },
        enabled: Boolean(api),
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: false
    })

    return { usage: query.data ?? {}, isLoading: query.isLoading }
}
