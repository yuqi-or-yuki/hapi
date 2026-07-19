import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SkillUsage } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSkillUsage(api: ApiClient | null): {
    skills: SkillUsage[]
    isLoading: boolean
    error: string | null
} {
    const query = useQuery({
        queryKey: queryKeys.skillUsage,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getSkillUsage()
        },
        enabled: Boolean(api),
        refetchInterval: 30000,
    })

    return {
        skills: query.data?.skills ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load skill usage' : null,
    }
}
