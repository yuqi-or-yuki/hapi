import { useState, useCallback, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export interface UserSessionGroup {
    id: string
    name: string
    sessionIds: string[]
    projectGroupKey: string
    collapsed: boolean
}

const STORAGE_KEY = 'hapi-session-groups-v1'
const PREF_KEY = 'sessionGroups'

function loadGroupsFromStorage(): UserSessionGroup[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw) as UserSessionGroup[]
        return parsed.map(g => ({ ...g, collapsed: g.collapsed ?? false }))
    } catch {
        return []
    }
}

function saveGroupsToStorage(groups: UserSessionGroup[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(groups))
    } catch {}
}

export function useSessionGroups(api: ApiClient | null) {
    const queryClient = useQueryClient()

    // Seed the query cache from localStorage immediately so the UI is instant
    // even before the server responds.
    const [localSeed] = useState<UserSessionGroup[]>(() => loadGroupsFromStorage())

    const { data: serverGroups } = useQuery({
        queryKey: queryKeys.sessionGroups,
        queryFn: async () => {
            if (!api) return localSeed
            const value = await api.getPreference<UserSessionGroup[]>(PREF_KEY)
            return value ?? []
        },
        enabled: Boolean(api),
        staleTime: 30_000,
    })

    // Server is canonical once loaded — keep localStorage in sync for offline reads.
    // Runs on every change (including legitimate deletes down to zero groups), unlike
    // the one-time migration below.
    useEffect(() => {
        if (!api || serverGroups === undefined) return
        saveGroupsToStorage(serverGroups)
    }, [api, serverGroups])

    // Migrate groups from localStorage to the server on first load if the
    // server has none (e.g. groups were created before server-side storage
    // existed, or a fresh install is loaded on a new device). Guarded by a ref
    // so this only ever runs once per mount — otherwise, deleting the last
    // remaining group makes serverGroups briefly [], which this effect would
    // misread as "never synced" and re-push the stale localSeed, undoing the
    // deletion.
    const hasMigratedRef = useRef(false)
    useEffect(() => {
        if (!api || serverGroups === undefined) return
        if (hasMigratedRef.current) return
        hasMigratedRef.current = true
        if (serverGroups.length === 0 && localSeed.length > 0) {
            // Push existing local groups to server so other devices see them.
            api.setPreference(PREF_KEY, localSeed)
                .then(() => {
                    queryClient.setQueryData(queryKeys.sessionGroups, localSeed)
                })
                .catch(() => {})
        }
    }, [api, serverGroups]) // eslint-disable-line react-hooks/exhaustive-deps

    const saveMutation = useMutation({
        mutationFn: async (groups: UserSessionGroup[]) => {
            saveGroupsToStorage(groups)
            if (api) await api.setPreference(PREF_KEY, groups)
        },
    })

    // The displayed groups: server data once loaded, local seed in the meantime.
    const groups = serverGroups ?? localSeed

    const update = useCallback((updater: (prev: UserSessionGroup[]) => UserSessionGroup[]) => {
        // Use the query cache as the source of truth so we always base updates
        // on the latest data, not on potentially stale local state.
        const current = queryClient.getQueryData<UserSessionGroup[]>(queryKeys.sessionGroups) ?? groups
        const next = updater(current)
        // Update query cache immediately so the UI reflects the change right away.
        queryClient.setQueryData(queryKeys.sessionGroups, next)
        saveMutation.mutate(next)
    }, [queryClient, groups, saveMutation])

    const createGroup = useCallback((name: string, sessionIds: string[], projectGroupKey: string): string => {
        const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        update(prev => [...prev, { id, name, sessionIds, projectGroupKey, collapsed: false }])
        return id
    }, [update])

    const renameGroup = useCallback((id: string, name: string) => {
        update(prev => prev.map(g => g.id === id ? { ...g, name } : g))
    }, [update])

    const deleteGroup = useCallback((id: string) => {
        update(prev => prev.filter(g => g.id !== id))
    }, [update])

    const toggleGroupCollapsed = useCallback((id: string) => {
        update(prev => prev.map(g => g.id === id ? { ...g, collapsed: !g.collapsed } : g))
    }, [update])

    const moveSessionToGroup = useCallback((sessionId: string, toGroupId: string | null) => {
        update(prev => prev.map(g => {
            if (g.id === toGroupId) {
                if (g.sessionIds.includes(sessionId)) return g
                return { ...g, sessionIds: [...g.sessionIds, sessionId] }
            }
            return { ...g, sessionIds: g.sessionIds.filter(id => id !== sessionId) }
        }))
    }, [update])

    const addSessionsToGroup = useCallback((groupId: string, sessionIds: string[]) => {
        update(prev => prev.map(g => {
            if (g.id !== groupId) return g
            const existing = new Set(g.sessionIds)
            const fresh = sessionIds.filter(id => !existing.has(id))
            if (fresh.length === 0) return g
            return { ...g, sessionIds: [...g.sessionIds, ...fresh] }
        }))
    }, [update])

    const getGroupsForProject = useCallback((projectGroupKey: string): UserSessionGroup[] => {
        return groups.filter(g => g.projectGroupKey === projectGroupKey)
    }, [groups])

    return {
        groups,
        createGroup,
        renameGroup,
        deleteGroup,
        toggleGroupCollapsed,
        moveSessionToGroup,
        addSessionsToGroup,
        getGroupsForProject,
    }
}
