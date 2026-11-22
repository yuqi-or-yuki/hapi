import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SkillSummary } from '@/types/api'

/**
 * Agents that keep their own skills directory. A skill is "shared" when it
 * lives somewhere every agent reads (`~/.agents/skills`) and therefore comes
 * back for all of them.
 */
export const SKILL_FLAVORS = ['claude', 'codex', 'grok', 'copilot'] as const
export type SkillFlavor = typeof SKILL_FLAVORS[number]

export type UnifiedSkill = {
    name: string
    description?: string
    /** Agents whose catalog includes this skill, in SKILL_FLAVORS order. */
    flavors: SkillFlavor[]
}

/**
 * Merges per-agent catalogs into one library keyed by skill name.
 *
 * A skill written once and readable by every agent must appear once, not four
 * times under four tabs — the duplication is what makes a skill library feel
 * bound to a single harness. The first non-empty description wins; agents that
 * read the same file report the same text anyway.
 */
export function mergeSkillsByName(
    byFlavor: ReadonlyArray<{ flavor: SkillFlavor; skills: readonly SkillSummary[] }>
): UnifiedSkill[] {
    const merged = new Map<string, UnifiedSkill>()
    for (const { flavor, skills } of byFlavor) {
        for (const skill of skills) {
            const existing = merged.get(skill.name)
            if (existing) {
                if (!existing.flavors.includes(flavor)) existing.flavors.push(flavor)
                if (!existing.description && skill.description) existing.description = skill.description
            } else {
                merged.set(skill.name, {
                    name: skill.name,
                    description: skill.description,
                    flavors: [flavor]
                })
            }
        }
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The whole skill library on a machine, across every agent.
 *
 * Each agent is a separate RPC that walks directories on that machine — much
 * costlier than a cached GET — so the catalogs are held for the session and
 * never refetched on focus or reconnect.
 */
export function useMachineSkills(api: ApiClient | null, machineId: string | null): {
    skills: UnifiedSkill[]
    isLoading: boolean
    /** Agents that failed to answer, so the UI can say the list is partial. */
    failedFlavors: SkillFlavor[]
    error: string | null
    refetch: () => void
} {
    const queries = useQueries({
        queries: SKILL_FLAVORS.map((flavor) => ({
            queryKey: ['machine-skills', machineId, flavor],
            queryFn: async () => {
                if (!api || !machineId) throw new Error('API unavailable')
                const response = await api.getMachineSkills(machineId, flavor)
                if (!response.success) throw new Error(response.error || 'Failed to list skills')
                return response.skills ?? []
            },
            enabled: Boolean(api && machineId),
            staleTime: Infinity,
            gcTime: 30 * 60_000,
            refetchOnWindowFocus: false,
            retry: false
        }))
    })

    const skills = useMemo(
        () => mergeSkillsByName(
            SKILL_FLAVORS
                .map((flavor, index) => ({ flavor, skills: queries[index].data ?? [] }))
                .filter((entry) => entry.skills.length > 0)
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [queries.map((query) => query.dataUpdatedAt).join(',')]
    )

    const failedFlavors = SKILL_FLAVORS.filter((_, index) => queries[index].isError)

    return {
        skills,
        isLoading: queries.some((query) => query.isLoading),
        failedFlavors,
        // Only a total failure is an error; one silent agent just narrows the list.
        error: failedFlavors.length === SKILL_FLAVORS.length
            ? (queries[0].error instanceof Error ? queries[0].error.message : 'Failed to list skills')
            : null,
        refetch: () => { for (const query of queries) void query.refetch() }
    }
}
