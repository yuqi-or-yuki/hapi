import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useQueryClient } from '@tanstack/react-query'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { CloneSessionDialog } from '@/components/CloneSessionDialog'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useHideArchivedSessions } from '@/hooks/useHideArchivedSessions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CopyIcon, CheckIcon, ScheduleIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { useSessionGroups, type UserSessionGroup } from '@/hooks/useSessionGroups'
import { DEFAULT_SESSION_PREVIEW_LIMIT, useSessionPreviewLimit } from '@/hooks/useSessionPreviewLimit'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { useSessionListStatusMode } from '@/hooks/useSessionListStatusMode'
import { useShowActiveSessionsOnly } from '@/hooks/useShowActiveSessionsOnly'
import { classifySessionAttention } from '@/lib/sessionAttention'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'
import { getAttentionLabel, SessionAttentionIndicator } from '@/components/SessionAttentionIndicator'
import { HoverTooltip, SESSION_ROW_TOOLTIP_FOCUS_CLASS, useSessionRowTooltipIds } from '@/components/HoverTooltip'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatScheduledTooltipDetail } from '@/lib/scheduledTime'
import { getCodexImportedAt, subscribeCodexImportedSessions } from '@/lib/codexImportedSessions'
import { formatReopenError } from '@/lib/reopenError'
import { getSessionTitle } from '@/lib/sessionTitle'
import type { Machine } from '@/types/api'
import { getMachinePlatform, presentMachineHealth } from '@/lib/machineHealth'
import { MachineGroupHeader } from '@/components/MachineGroupHeader'
import { useCursorChatStoreStatus } from '@/hooks/queries/useCursorChatStoreStatus'

type SessionGroup = {
    key: string
    directory: string
    displayName: string
    machineId: string | null
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

export type SessionTimeRange = {
    start: number | null
    end: number | null
}

function parseLocalDate(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
    return date
}

export function getSessionTimeRange(start: string, end: string): SessionTimeRange | null {
    const startDate = parseLocalDate(start)
    const endDate = parseLocalDate(end)
    if (!startDate || !endDate) return null
    if (endDate) endDate.setDate(endDate.getDate() + 1)
    return { start: startDate.getTime(), end: endDate.getTime() }
}

export function sessionMatchesTimeRange(session: SessionSummary, range: SessionTimeRange | null): boolean {
    if (!range) return true
    if (range.start !== null && session.updatedAt < range.start) return false
    if (range.end !== null && session.updatedAt >= range.end) return false
    return true
}

function SessionsEmptyState(props: {
    onNewSession: () => void
    onBrowse?: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="44"
                height="44"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[var(--app-hint)] opacity-60"
            >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18" />
                <path d="M8 14h8" />
                <path d="M8 17h5" />
            </svg>
            <div className="text-base font-medium text-[var(--app-fg)]">
                {t('sessions.empty.title')}
            </div>
            <div className="max-w-sm text-sm text-[var(--app-hint)]">
                {t('sessions.empty.hint')}
            </div>
            <div className="flex items-center gap-2 mt-2">
                <button
                    type="button"
                    onClick={props.onNewSession}
                    className="px-4 py-1.5 text-sm rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium hover:opacity-90 transition-opacity"
                >
                    {t('sessions.empty.startSession')}
                </button>
                {props.onBrowse && (
                    <button
                        type="button"
                        onClick={props.onBrowse}
                        className="px-4 py-1.5 text-sm rounded-lg border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                    >
                        {t('sessions.empty.browse')}
                    </button>
                )}
            </div>
        </div>
    )
}

type MachineGroup = {
    machineId: string | null
    label: string
    projectGroups: SessionGroup[]
    totalSessions: number
    hasActiveSession: boolean
    latestUpdatedAt: number
}

function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export const UNKNOWN_MACHINE_ID = '__unknown__'
export const GROUP_SESSION_PREVIEW_LIMIT = DEFAULT_SESSION_PREVIEW_LIMIT

export function getSessionDedupKey(session: SessionSummary): string | null {
    const agentId = session.metadata?.agentSessionId?.trim()
    if (!agentId) return null
    // Scope by flavor: agentSessionId is flattened from native ids and can retain a
    // stale cross-flavor value (codexSessionId ?? claudeSessionId ?? ...).
    return `${session.metadata?.flavor ?? 'unknown'}:${agentId}`
}

export function deduplicateSessionsByAgentId(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    const byAgentId = new Map<string, SessionSummary[]>()
    const result: SessionSummary[] = []

    for (const session of sessions) {
        const dedupKey = getSessionDedupKey(session)
        if (!dedupKey) {
            result.push(session)
            continue
        }
        const group = byAgentId.get(dedupKey)
        if (group) {
            group.push(session)
        } else {
            byAgentId.set(dedupKey, [session])
        }
    }

    for (const group of byAgentId.values()) {
        group.sort((a, b) => {
            // Active session always wins — it's the live connection
            if (a.active !== b.active) return a.active ? -1 : 1
            // Among inactive duplicates, keep the selected one visible
            if (a.id === selectedSessionId) return -1
            if (b.id === selectedSessionId) return 1
            return b.updatedAt - a.updatedAt
        })
        result.push(group[0])
    }

    return result
}

function hasSidebarTitleSignal(session: SessionSummary): boolean {
    const meta = session.metadata
    if (!meta) return false
    if (meta.name?.trim()) return true
    if (meta.summary?.text?.trim()) return true
    return false
}

export function isSidebarEmptySessionStub(session: SessionSummary): boolean {
    if (session.active) return false
    const meta = session.metadata
    if (!meta) return true
    if (meta.agentSessionId?.trim()) return false
    if (hasSidebarTitleSignal(session)) return false
    return true
}

export function shouldShowSessionInSidebar(session: SessionSummary, selectedSessionId?: string | null): boolean {
    if (session.id === selectedSessionId) return true
    if (session.active) return true
    return !isSidebarEmptySessionStub(session)
}

export function prepareSidebarSessions(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return deduplicateSessionsByAgentId(sessions, selectedSessionId)
        .filter(session => shouldShowSessionInSidebar(session, selectedSessionId))
}

// "Active sessions only" view: hide inactive sessions, but never hide the one the
// operator currently has open — otherwise toggling the filter would yank the
// selected session out from under them.
export function filterActiveSessionsOnly(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return sessions.filter(session => session.active || session.id === selectedSessionId)
}

// Paginated "Show N more": reveal one batch (step) at a time instead of expanding
// every hidden session at once. Always advances by at least one and never exceeds
// the total so the button reliably reaches a fully-expanded state.
export function getNextSessionVisibleCount(current: number, step: number, total: number): number {
    return Math.min(current + Math.max(1, step), total)
}

function groupSessionsByDirectory(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, { directory: string; machineId: string | null; sessions: SessionSummary[] }>()

    sessions.forEach(session => {
        const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
        const machineId = session.metadata?.machineId ?? null
        const key = `${machineId ?? UNKNOWN_MACHINE_ID}::${path}`
        if (!groups.has(key)) {
            groups.set(key, {
                directory: path,
                machineId,
                sessions: []
            })
        }
        groups.get(key)!.sessions.push(session)
    })

    return Array.from(groups.entries())
        .map(([key, group]) => {
            const sortedSessions = [...group.sessions].sort((a, b) => {
                const rankA = a.active && a.thinking ? 0 : a.active ? (a.pendingRequestsCount > 0 ? 1 : 2) : 3
                const rankB = b.active && b.thinking ? 0 : b.active ? (b.pendingRequestsCount > 0 ? 1 : 2) : 3
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = group.sessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = group.sessions.some(s => s.active)
            const displayName = getGroupDisplayName(group.directory)

            return {
                key,
                directory: group.directory,
                displayName,
                machineId: group.machineId,
                sessions: sortedSessions,
                latestUpdatedAt,
                hasActiveSession
            }
        })
        .sort((a, b) => {
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
}


export function expandSelectedSessionCollapseOverrides(
    overrides: Map<string, boolean>,
    group: { key: string; machineId: string | null }
): Map<string, boolean> {
    const next = new Map(overrides)
    let changed = false

    // Expand project group if collapsed. Project and machine keys use true = collapsed.
    if (overrides.has(group.key) && overrides.get(group.key)) {
        next.delete(group.key)
        changed = true
    }

    const machineKey = `machine::${group.machineId ?? UNKNOWN_MACHINE_ID}`
    if (overrides.has(machineKey) && overrides.get(machineKey)) {
        next.delete(machineKey)
        changed = true
    }

    return changed ? next : overrides
}

function groupByMachine(
    groups: SessionGroup[],
    resolveMachineLabel: (id: string | null) => string
): MachineGroup[] {
    const map = new Map<string, MachineGroup>()
    for (const g of groups) {
        const key = g.machineId ?? UNKNOWN_MACHINE_ID
        let mg = map.get(key)
        if (!mg) {
            mg = {
                machineId: g.machineId,
                label: resolveMachineLabel(g.machineId),
                projectGroups: [],
                totalSessions: 0,
                hasActiveSession: false,
                latestUpdatedAt: 0,
            }
            map.set(key, mg)
        }
        mg.projectGroups.push(g)
        mg.totalSessions += g.sessions.length
        if (g.hasActiveSession) mg.hasActiveSession = true
        if (g.latestUpdatedAt > mg.latestUpdatedAt) mg.latestUpdatedAt = g.latestUpdatedAt
    }
    return [...map.values()].sort((a, b) => {
        if (a.hasActiveSession !== b.hasActiveSession) return a.hasActiveSession ? -1 : 1
        return b.latestUpdatedAt - a.latestUpdatedAt
    })
}

function CopyPathButton({ path, className }: { path: string; className?: string }) {
    const [copied, setCopied] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        navigator.clipboard.writeText(path)
        setCopied(true)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1500)
    }

    useEffect(() => () => clearTimeout(timerRef.current), [])

    return (
        <button
            type="button"
            className={`shrink-0 p-0.5 rounded transition-colors ${copied ? 'text-[var(--app-badge-success-text)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'} ${className ?? ''}`}
            title={copied ? 'Copied!' : `Copy: ${path}`}
            onClick={handleClick}
        >
            {copied
                ? <CheckIcon className="h-3.5 w-3.5" />
                : <CopyIcon className="h-3.5 w-3.5" />
            }
        </button>
    )
}


function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
        </svg>
    )
}

function XIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function LoaderIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <line x1="12" y1="2" x2="12" y2="6" />
            <line x1="12" y1="18" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
            <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="6" y2="12" />
            <line x1="18" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
            <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
        </svg>
    )
}

function BulbIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12c.6.6 1 1.2 1 2h6c0-.8.4-1.4 1-2a7 7 0 0 0-4-12Z" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

export { getSessionTitle } from '@/lib/sessionTitle'

export function getWorktreeSessionLabel(session: SessionSummary): string | null {
    const worktree = session.metadata?.worktree
    if (!worktree) {
        return null
    }

    const name = worktree.name.trim()
    if (name) {
        return name
    }

    const path = (worktree.worktreePath ?? session.metadata?.path ?? '').replace(/[\\/]+$/, '')
    const parts = path.split(/[\\/]+/).filter(Boolean)
    return parts.at(-1) ?? null
}

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

export function normalizeSearch(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase()
}

export function sessionMatchesQuery(session: SessionSummary, query: string, machineLabel: string): boolean {
    if (!query) return true
    const searchable = [
        getSessionTitle(session),
        getWorktreeSessionLabel(session),
        session.id,
        session.metadata?.path,
        session.metadata?.worktree?.basePath,
        session.metadata?.worktree?.worktreePath,
        session.metadata?.name,
        session.metadata?.summary?.text,
        session.metadata?.flavor,
        machineLabel,
    ]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n')
        .toLowerCase()
    return searchable.includes(query)
}


export function getVisibleSessionPreview(
    sessions: SessionSummary[],
    options: {
        expanded?: boolean
        selectedSessionId?: string | null
        limit?: number
    } = {}
): SessionSummary[] {
    const limit = options.limit ?? GROUP_SESSION_PREVIEW_LIMIT
    if (options.expanded || sessions.length <= limit) return sessions

    const requiredIds = new Set<string>()
    for (const session of sessions) {
        if (session.pendingRequestsCount > 0) requiredIds.add(session.id)
    }
    if (options.selectedSessionId && sessions.some(session => session.id === options.selectedSessionId)) {
        requiredIds.add(options.selectedSessionId)
    }

    const visible: SessionSummary[] = sessions.filter((session, index) => {
        return index < limit || requiredIds.has(session.id)
    })

    for (let index = visible.length - 1; visible.length > limit && index >= 0; index -= 1) {
        const session = visible[index]
        if (!session || requiredIds.has(session.id)) continue
        visible.splice(index, 1)
    }

    return visible
}

function CalendarIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 10h18" />
        </svg>
    )
}


function isEditableShortcutTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

function isDeleteShortcut(event: Pick<KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>): boolean {
    const isDeleteKey = event.key === 'Backspace' || event.key === 'Delete'
    return isDeleteKey && (event.metaKey || event.ctrlKey)
}

function shouldBlockSidebarDeleteShortcut(
    event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
    containerRef?: RefObject<HTMLElement | null>
): boolean {
    if (!isDeleteShortcut(event)) return false
    if (isEditableShortcutTarget(event.target)) return false

    const target = event.target instanceof Node ? event.target : null
    const activeElement = document.activeElement
    const container = containerRef?.current ?? null

    if (target instanceof HTMLElement && target.closest('.session-list-item')) return true
    if (activeElement instanceof HTMLElement && activeElement.closest('.session-list-item')) return true

    // Native browser/app shortcuts can arrive at document/body even though keyboard
    // focus is visually in the sidebar. If focus is anywhere inside SessionList,
    // block the destructive delete shortcut, but keep inputs editable above.
    if (container && activeElement instanceof Node && container.contains(activeElement)) return true
    if (container && target && container.contains(target)) return true

    return false
}


function isSessionItemArchiveShortcut(event: KeyboardEvent<HTMLElement>): boolean {
    if (event.key.toLowerCase() !== 'e') return false
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    if (isEditableShortcutTarget(event.target)) return false

    const target = event.target
    return target instanceof HTMLElement && target.closest('.session-list-item') !== null
}

function formatDateValue(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function SessionDateRangePicker(props: {
    start: string
    end: string
    onChange: (start: string, end: string) => void
    onClose: () => void
}) {
    const { t } = useTranslation()
    const initialDate = parseLocalDate(props.start) ?? new Date()
    const [visibleMonth, setVisibleMonth] = useState(() => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1))
    const firstWeekday = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1).getDay()
    const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate()
    const weekdays = Array.from({ length: 7 }, (_, day) => (
        new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2026, 5, 7 + day))
    ))

    const selectDate = (value: string) => {
        if (!props.start || props.end) {
            props.onChange(value, '')
            return
        }
        props.onChange(value < props.start ? value : props.start, value < props.start ? props.start : value)
        props.onClose()
    }

    return (
        <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
                <button
                    type="button"
                    onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))}
                    className="rounded-lg p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('sessions.timeFilter.previousMonth')}
                >
                    <span aria-hidden="true">‹</span>
                </button>
                <div className="text-sm font-medium">
                    {visibleMonth.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
                </div>
                <button
                    type="button"
                    onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))}
                    className="rounded-lg p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('sessions.timeFilter.nextMonth')}
                >
                    <span aria-hidden="true">›</span>
                </button>
            </div>
            <div className="mb-1 grid grid-cols-7 text-center text-[10px] text-[var(--app-hint)]">
                {weekdays.map((weekday, index) => <div key={`${weekday}-${index}`} className="py-1">{weekday}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
                {Array.from({ length: firstWeekday }, (_, index) => <div key={`blank-${index}`} />)}
                {Array.from({ length: daysInMonth }, (_, index) => {
                    const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), index + 1)
                    const value = formatDateValue(date)
                    const isEndpoint = value === props.start || value === props.end
                    const isInRange = Boolean(props.start && props.end && value > props.start && value < props.end)
                    return (
                        <button
                            key={value}
                            type="button"
                            onClick={() => selectDate(value)}
                            aria-label={date.toLocaleDateString()}
                            className={cn(
                                'h-8 rounded-lg text-xs transition-colors',
                                isEndpoint && 'bg-[var(--app-link)] text-white',
                                isInRange && 'bg-[var(--app-link)]/15 text-[var(--app-link)]',
                                !isEndpoint && !isInRange && 'hover:bg-[var(--app-subtle-bg)]'
                            )}
                        >
                            {index + 1}
                        </button>
                    )
                })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-[var(--app-divider)] pt-2 text-xs">
                <span className="text-[var(--app-hint)]">
                    {!props.start
                        ? t('sessions.timeFilter.pickStart')
                        : !props.end
                            ? t('sessions.timeFilter.pickEnd')
                            : `${props.start} – ${props.end}`}
                </span>
                {props.start ? (
                    <button type="button" onClick={() => props.onChange('', '')} className="text-[var(--app-link)]">
                        {t('sessions.timeFilter.clear')}
                    </button>
                ) : null}
            </div>
        </div>
    )
}

function SessionListSearch(props: {
    value: string
    onChange: (value: string) => void
    customStart: string
    customEnd: string
    onDateRangeChange: (start: string, end: string) => void
}) {
    const { t } = useTranslation()
    const [datePickerOpen, setDatePickerOpen] = useState(false)
    const hasDateRange = Boolean(props.customStart && props.customEnd)
    return (
        <div className="px-3 pb-2">
            <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <div className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[var(--app-hint)]">
                        <SearchIcon className="h-3.5 w-3.5" />
                    </div>
                    <input
                        type="search"
                        value={props.value}
                        onChange={(event) => props.onChange(event.target.value)}
                        placeholder={t('sessions.search.placeholder')}
                        className="w-full appearance-none rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] py-1.5 pl-8 pr-8 text-sm text-[var(--app-fg)] outline-none transition-colors placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
                    />
                    {props.value ? (
                        <button
                            type="button"
                            onClick={() => props.onChange('')}
                            className="absolute inset-y-0 right-2 flex items-center rounded p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                            title={t('sessions.search.clear')}
                        >
                            <XIcon className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                </div>
                <div className="relative shrink-0">
                    <button
                        type="button"
                        onClick={() => setDatePickerOpen(open => !open)}
                        className={cn(
                            'relative rounded-lg p-2 transition-colors hover:bg-[var(--app-subtle-bg)]',
                            hasDateRange ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)]'
                        )}
                        title={hasDateRange ? `${props.customStart} – ${props.customEnd}` : t('sessions.timeFilter.label')}
                        aria-label={t('sessions.timeFilter.label')}
                        aria-expanded={datePickerOpen}
                    >
                        <CalendarIcon className="h-5 w-5" />
                        {hasDateRange ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" /> : null}
                    </button>
                    {datePickerOpen ? (
                        <>
                            <button type="button" aria-label={t('sessions.timeFilter.close')} className="fixed inset-0 z-20 cursor-default" onClick={() => setDatePickerOpen(false)} />
                            <SessionDateRangePicker
                                start={props.customStart}
                                end={props.customEnd}
                                onChange={props.onDateRangeChange}
                                onClose={() => setDatePickerOpen(false)}
                            />
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

function formatCodexImportedRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.importedFromCodex.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.importedFromCodex.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.importedFromCodex.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.importedFromCodex.daysAgo', { n: days })
    return new Date(ms).toLocaleDateString()
}

function formatFutureRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = ms - Date.now()
    if (delta < 60_000) return t('session.time.dueNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.inMinutes', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.inHours', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.inDays', { n: days })
    return new Date(ms).toLocaleDateString()
}

function getSessionTimeLabel(session: SessionSummary, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const codexSessionId = session.metadata?.agentSessionId
    const importedAt = session.metadata?.flavor === 'codex'
        ? getCodexImportedAt(codexSessionId)
        : null

    // 中文注释：导入标记存在时优先显示“xx 前从 Codex 客户端导入”；等用户在 Hapi 里继续发消息后，再由发送逻辑清除该标记。
    if (importedAt !== null) {
        return formatCodexImportedRelativeTime(importedAt, t)
    }

    return formatRelativeTime(session.updatedAt, t)
}

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
    api: ApiClient | null
    selected?: boolean
    selectionMode?: boolean
    isMultiSelected?: boolean
    onToggleMultiSelect?: (sessionId: string) => void
    onCheckboxClick?: (sessionId: string, shiftKey: boolean) => void
    onCloned?: (newSessionId: string) => void
    unreadDoneOrder?: number
    showDetailedStatus?: boolean
}) {
    const { t } = useTranslation()
    const {
        session: s,
        onSelect,
        showPath = true,
        api,
        selected = false,
        selectionMode = false,
        isMultiSelected = false,
        showDetailedStatus = false
    } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [cloneOpen, setCloneOpen] = useState(false)

    const {
        status: cursorChatStoreStatus,
        isApplicable: cursorChatStoreApplicable,
        error: cursorChatStoreError,
    } = useCursorChatStoreStatus({
        api,
        session: s,
        enabled: menuOpen
    })
    const cursorReopenDisabledReason = cursorChatStoreApplicable && cursorChatStoreStatus?.onDisk !== true
        ? cursorChatStoreError
            ? t('session.action.reopenCursorCheckFailed')
            : cursorChatStoreStatus?.onDisk === false
                ? t('session.action.reopenCursorMissing')
                : t('session.action.reopenCursorChecking')
        : undefined

    const { archiveSession, reopenSession, renameSession, deleteSession, cloneSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )
    const [reopenError, setReopenError] = useState<string | null>(null)

    const handleReopen = async () => {
        setReopenError(null)
        try {
            const result = await reopenSession()
            // resumeSession may merge the row into a freshly-spawned sessionId.
            // Follow it so the operator lands on the live session.
            if (result.sessionId && result.sessionId !== s.id) {
                onSelect(result.sessionId)
            }
        } catch (error) {
            setReopenError(formatReopenError(error))
        }
    }

    const handleClone = async (model: string | null) => {
        const newId = await cloneSession(model)
        props.onCloned?.(newId)
    }

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (!menuOpen) {
                onSelect(s.id)
            }
        },
        threshold: 500
    })

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!isSessionItemArchiveShortcut(event)) return
        if (!s.active) return
        event.preventDefault()
        event.stopPropagation()
        setArchiveOpen(true)
    }

    const sessionName = getSessionTitle(s)
    const worktreeLabel = getWorktreeSessionLabel(s)
    const todoProgress = getTodoProgress(s)
    const readyForReview = s.metadata?.readyForReview === true

    const attention = useMemo(
        () => showDetailedStatus
            ? classifySessionAttention(s, {
                selected,
                lastSeenAt: getSessionLastSeenAt(s.id)
            })
            : null,
        [s, selected, showDetailedStatus]
    )
    const attentionLabel = attention ? getAttentionLabel(attention, t) : null
    const scheduledLabel = s.futureScheduledMessageCount > 1
        ? t('session.item.scheduledMessages', { count: s.futureScheduledMessageCount })
        : t('session.item.scheduledMessage')
    const hasScheduleTooltip = showDetailedStatus && s.futureScheduledMessageCount > 0
    const { attentionId, scheduleId, describedBy } = useSessionRowTooltipIds(
        Boolean(attention),
        hasScheduleTooltip
    )
    return (
        <>
            <div className={cn(
                'session-list-item group/session-row flex items-stretch rounded-lg transition-colors select-none',
                isMultiSelected ? 'bg-blue-500/10' : '',
                selected && !isMultiSelected ? 'bg-[var(--app-secondary-bg)]' : '',
                s.active && s.thinking ? 'border-l-2 border-[var(--app-badge-success-text)] bg-[var(--app-badge-success-bg)] -ml-2 pl-2' : 'border-l-2 border-transparent',
            )}>
                {/* Checkbox column — always present so layout is stable; visible on hover or in selection mode */}
                <button
                    type="button"
                    onClick={(e) => props.onCheckboxClick?.(s.id, e.shiftKey)}
                    className={cn(
                        'flex shrink-0 items-center justify-center transition-opacity',
                        selectionMode
                            ? 'w-7 opacity-100'
                            : 'w-7 opacity-100 sm:w-0 sm:overflow-hidden sm:opacity-0 sm:group-hover/session-row:w-7 sm:group-hover/session-row:opacity-100'
                    )}
                    style={{ transition: 'width 120ms ease, opacity 120ms ease' }}
                    tabIndex={-1}
                    aria-label={isMultiSelected ? 'Deselect session' : 'Select session'}
                >
                    <span className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                        isMultiSelected ? 'border-blue-500 bg-blue-500 text-white' : 'border-[var(--app-hint)]'
                    )}>
                        {isMultiSelected ? (
                            <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none">
                                <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        ) : null}
                    </span>
                </button>

                {/* Main row button */}
                <button
                    type="button"
                    data-session-id={s.id}
                    {...longPressHandlers}
                    onKeyDown={handleKeyDown}
                    title={s.active ? 'Press E to archive' : undefined}
                    className={cn(
                        'flex min-w-0 flex-1 flex-col gap-1 py-2 pr-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                        'pl-0'
                    )}
                    style={{ WebkitTouchCallout: 'none' }}
                    aria-current={selected ? 'page' : undefined}
                    aria-describedby={describedBy}
                >
                    <div className={`flex items-center justify-between gap-3 ${!s.active ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="relative shrink-0">
                                <AgentFlavorIcon flavor={s.metadata?.flavor} className="h-4 w-4" />
                                {readyForReview && !selectionMode ? (
                                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-blue-500 ring-1 ring-[var(--app-bg)]" />
                                ) : null}
                            </div>
                            <div className={`truncate text-sm font-medium ${s.active ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}>
                                {sessionName}
                            </div>
                            {s.active && s.thinking ? (
                                <LoaderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-badge-success-text)] animate-spin-slow" />
                            ) : attention ? (
                                <SessionAttentionIndicator
                                    attention={attention}
                                    summary={s}
                                    label={attentionLabel ?? ''}
                                    tooltipId={attentionId!}
                                />
                            ) : null}
                            {s.loopActive ? (
                                <span className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]">
                                    ⟳ loop
                                </span>
                            ) : null}
                            {s.debateActive ? (
                                <span className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-purple-500/10 text-purple-500">
                                    ⚖ debate
                                </span>
                            ) : null}
                            {s.scheduledDueAts.map((dueAt, index) => (
                                <span key={`${dueAt}-${index}`} className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-teal-500/10 text-teal-500">
                                    ⏰ {formatFutureRelativeTime(dueAt, t)}
                                </span>
                            ))}
                            {hasScheduleTooltip ? (
                                <HoverTooltip
                                    id={scheduleId!}
                                    target={<ScheduleIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />}
                                    side="bottom"
                                    align="start"
                                    className="shrink-0"
                                    revealOnParentFocusClass={SESSION_ROW_TOOLTIP_FOCUS_CLASS}
                                >
                                    <span className="block">
                                        <span className="block font-medium">{scheduledLabel}</span>
                                        <span className="mt-1 block text-[var(--app-hint)]">
                                            {formatScheduledTooltipDetail(s, t)}
                                        </span>
                                    </span>
                                </HoverTooltip>
                            ) : null}
                            {readyForReview && !selectionMode ? (
                                <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-blue-500/10 text-blue-500">
                                    review
                                </span>
                            ) : null}
                        </div>
                        <div className="flex items-center gap-2 shrink-0 text-xs">
                            {props.unreadDoneOrder ? (
                                <span
                                    className="inline-flex items-center rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm"
                                    title={props.unreadDoneOrder === 1 ? 'Next finished session to review' : `Finished session review priority ${props.unreadDoneOrder}`}
                                    aria-label={props.unreadDoneOrder === 1 ? 'Next finished session to review' : `Finished session review priority ${props.unreadDoneOrder}`}
                                >
                                    {props.unreadDoneOrder === 1 ? 'next' : `#${props.unreadDoneOrder}`}
                                </span>
                            ) : null}
                            {todoProgress ? (
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <BulbIcon className="h-3 w-3" />
                                    {todoProgress.completed}/{todoProgress.total}
                                </span>
                            ) : null}
                            {!attention && s.pendingRequestsCount > 0 ? (
                                <span className="text-[var(--app-badge-warning-text)]">
                                    {t('session.item.pending')} {s.pendingRequestsCount}
                                </span>
                            ) : null}
                            <span className="text-[var(--app-hint)]">
                                {getSessionTimeLabel(s, t)}
                            </span>
                        </div>
                    </div>
                    {showPath || worktreeLabel ? (
                        <div
                            className="truncate text-xs text-[var(--app-hint)]"
                            title={worktreeLabel
                                ? s.metadata?.worktree?.worktreePath ?? s.metadata?.path
                                : undefined}
                        >
                            {worktreeLabel ?? s.metadata?.path ?? s.id}
                        </div>
                    ) : null}
                </button>
            </div>

            {!selectionMode ? (
                <>
                    <SessionActionMenu
                        isOpen={menuOpen}
                        onClose={() => setMenuOpen(false)}
                        sessionActive={s.active}
                        onRename={() => setRenameOpen(true)}
                        onExport={() => setExportOpen(true)}
                        onArchive={() => setArchiveOpen(true)}
                        onReopen={cursorReopenDisabledReason ? undefined : handleReopen}
                        reopenDisabledReason={cursorReopenDisabledReason}
                        onDelete={() => setDeleteOpen(true)}
                        onClone={() => setCloneOpen(true)}
                        anchorPoint={menuAnchorPoint}
                    />

                    {reopenError ? (
                        <ConfirmDialog
                            isOpen={true}
                            onClose={() => setReopenError(null)}
                            title={t('dialog.reopen.errorTitle')}
                            description={reopenError}
                            confirmLabel={t('dialog.reopen.dismiss')}
                            confirmingLabel={t('dialog.reopen.dismiss')}
                            onConfirm={async () => setReopenError(null)}
                            isPending={false}
                        />
                    ) : null}

                    <RenameSessionDialog
                        isOpen={renameOpen}
                        onClose={() => setRenameOpen(false)}
                        currentName={sessionName}
                        onRename={renameSession}
                        isPending={isPending}
                    />

                    {exportOpen ? (
                        <SessionExportDialog
                            isOpen={true}
                            onClose={() => setExportOpen(false)}
                            sessionId={s.id}
                            api={api}
                        />
                    ) : null}

                    <ConfirmDialog
                        isOpen={archiveOpen}
                        onClose={() => setArchiveOpen(false)}
                        title={t('dialog.archive.title')}
                        description={t('dialog.archive.description', { name: sessionName })}
                        confirmLabel={t('dialog.archive.confirm')}
                        confirmingLabel={t('dialog.archive.confirming')}
                        onConfirm={() => archiveSession(true)}
                        isPending={isPending}
                        destructive
                    />

                    <ConfirmDialog
                        isOpen={deleteOpen}
                        onClose={() => setDeleteOpen(false)}
                        title={t('dialog.delete.title')}
                        description={t('dialog.delete.description', { name: sessionName })}
                        confirmLabel={t('dialog.delete.confirm')}
                        confirmingLabel={t('dialog.delete.confirming')}
                        onConfirm={deleteSession}
                        isPending={isPending}
                        destructive
                    />

                    <CloneSessionDialog
                        isOpen={cloneOpen}
                        onClose={() => setCloneOpen(false)}
                        sessionName={sessionName}
                        onClone={handleClone}
                        isPending={isPending}
                    />
                </>
            ) : null}
        </>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg className={props.className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function UserGroupHeader(props: {
    group: UserSessionGroup
    sessionCount: number
    onRename: (id: string, name: string) => void
    onDelete: (id: string) => void
    onToggleCollapsed: (id: string) => void
    isDragOver: boolean
    onDragOver: React.DragEventHandler<HTMLDivElement>
    onDragLeave: React.DragEventHandler<HTMLDivElement>
    onDrop: React.DragEventHandler<HTMLDivElement>
}) {
    const { group } = props
    const [isRenaming, setIsRenaming] = useState(false)
    const [renameValue, setRenameValue] = useState(group.name)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (isRenaming) inputRef.current?.select()
    }, [isRenaming])

    const commitRename = () => {
        const trimmed = renameValue.trim()
        if (trimmed && trimmed !== group.name) props.onRename(group.id, trimmed)
        else setRenameValue(group.name)
        setIsRenaming(false)
    }

    return (
        <div
            className={cn(
                'group/user-group flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors',
                props.isDragOver
                    ? 'bg-blue-500/20 ring-1 ring-blue-500/40'
                    : 'hover:bg-[var(--app-subtle-bg)]'
            )}
            onDragOver={props.onDragOver}
            onDragLeave={props.onDragLeave}
            onDrop={props.onDrop}
        >
            <button
                type="button"
                onClick={() => props.onToggleCollapsed(group.id)}
                className="shrink-0 rounded p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                aria-label={group.collapsed ? 'Expand group' : 'Collapse group'}
            >
                <ChevronIcon className="h-3 w-3" collapsed={group.collapsed} />
            </button>

            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]" />

            {isRenaming ? (
                <input
                    ref={inputRef}
                    className="min-w-0 flex-1 border-b border-[var(--app-link)] bg-transparent text-sm font-medium text-[var(--app-fg)] outline-none"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                        if (e.key === 'Escape') { setRenameValue(group.name); setIsRenaming(false) }
                    }}
                />
            ) : (
                <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--app-fg)] hover:text-[var(--app-link)]"
                    onClick={() => { setRenameValue(group.name); setIsRenaming(true) }}
                    title="Click to rename"
                >
                    {group.name}
                </button>
            )}

            <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                ({props.sessionCount})
            </span>

            <button
                type="button"
                onClick={() => props.onDelete(group.id)}
                className="shrink-0 rounded p-0.5 text-[var(--app-hint)] opacity-0 transition-opacity hover:text-red-500 group-hover/user-group:opacity-100"
                title="Dissolve group (sessions stay)"
            >
                <XIcon className="h-3 w-3" />
            </button>
        </div>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onNewSessionInDirectory?: (args: { machineId: string | null; directory: string }) => void
    onBrowse?: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    machineLabelsById?: Record<string, string>
    machinesById?: Record<string, Machine>
    selectedSessionId?: string | null
    onCloned?: (newSessionId: string) => void
    unreadDoneOrders?: Record<string, number>
    onMarkReviewed?: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const { renderHeader = true, api, selectedSessionId, machineLabelsById = {}, machinesById = {}, onNewSessionInDirectory, onCloned } = props
    const { hideArchivedSessions } = useHideArchivedSessions()
    const { sessionPreviewLimit } = useSessionPreviewLimit()
    const { sessionListStatusMode } = useSessionListStatusMode()
    const { showActiveSessionsOnly } = useShowActiveSessionsOnly()
    const showDetailedStatus = sessionListStatusMode === 'detailed'
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [, setCodexImportedSessionsVersion] = useState(0)
    const queryClient = useQueryClient()
    const { groups: userGroups, createGroup, renameGroup, deleteGroup, toggleGroupCollapsed, moveSessionToGroup, getGroupsForProject } = useSessionGroups(props.api)
    const draggingSessionId = useRef<string | null>(null)
    const [dragActive, setDragActive] = useState(false)
    const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)
    const [showGroupNameInput, setShowGroupNameInput] = useState(false)
    const [groupNameValue, setGroupNameValue] = useState('')
    const groupNameInputRef = useRef<HTMLInputElement>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set())
    const selectionMode = multiSelectedIds.size > 0
    const [reviewPending, setReviewPending] = useState(false)
    const [archivePending, setArchivePending] = useState(false)
    const [lastCheckedId, setLastCheckedId] = useState<string | null>(null)
    const selectedUnreadCount = useMemo(
        () => Array.from(multiSelectedIds).filter(id => props.unreadDoneOrders?.[id]).length,
        [multiSelectedIds, props.unreadDoneOrders]
    )

    const toggleMultiSelect = useCallback((sessionId: string) => {
        setMultiSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(sessionId)) {
                next.delete(sessionId)
            } else {
                next.add(sessionId)
            }
            return next
        })
    }, [])

    const exitSelectionMode = () => {
        setMultiSelectedIds(new Set())
        setLastCheckedId(null)
    }

    const markSelectedReadyForReview = async (readyForReview: boolean) => {
        if (!api || reviewPending) return
        setReviewPending(true)
        try {
            await Promise.all(
                Array.from(multiSelectedIds).map(id => api.setSessionReadyForReview(id, readyForReview))
            )
        } finally {
            setReviewPending(false)
            exitSelectionMode()
        }
    }

    const markSelectedReviewed = () => {
        for (const sessionId of multiSelectedIds) {
            props.onMarkReviewed?.(sessionId)
        }
        exitSelectionMode()
    }

    const archiveSelected = async () => {
        if (!api || archivePending) return
        setArchivePending(true)
        try {
            await Promise.all(
                Array.from(multiSelectedIds).map(id => api.archiveSession(id, true))
            )
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        } finally {
            setArchivePending(false)
            exitSelectionMode()
        }
    }
    const groupSelectedSessions = (name: string) => {
        const trimmed = name.trim() || 'New Group'
        const byProjectGroup = new Map<string, string[]>()
        for (const sessionId of multiSelectedIds) {
            const session = allSessions.find(s => s.id === sessionId)
            if (!session) continue
            const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
            const machineId = session.metadata?.machineId ?? null
            const key = `${machineId ?? UNKNOWN_MACHINE_ID}::${path}`
            if (!byProjectGroup.has(key)) byProjectGroup.set(key, [])
            byProjectGroup.get(key)!.push(sessionId)
        }
        for (const [key, ids] of byProjectGroup) {
            createGroup(trimmed, ids, key)
        }
        exitSelectionMode()
        setShowGroupNameInput(false)
        setGroupNameValue('')
    }

    const normalizedQuery = normalizeSearch(searchQuery)
    const timeRange = getSessionTimeRange(customStart, customEnd)
    const isFiltering = normalizedQuery.length > 0 || timeRange !== null

    useEffect(() => {
        // 中文注释：监听导入标记变化，让列表在“导入完成”或“用户已在 Hapi 中继续会话”后立即刷新时间文案。
        return subscribeCodexImportedSessions(() => {
            setCodexImportedSessionsVersion((value) => value + 1)
        })
    }, [])

    const resolveMachineLabel = (machineId: string | null): string => {
        if (machineId && machineLabelsById[machineId]) {
            return machineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }

    const allSessions = useMemo(
        () => {
            const prepared = prepareSidebarSessions(props.sessions, selectedSessionId)
            const activeOnly = hideArchivedSessions || showActiveSessionsOnly
            return activeOnly ? filterActiveSessionsOnly(prepared, selectedSessionId) : prepared
        },
        [props.sessions, selectedSessionId, hideArchivedSessions, showActiveSessionsOnly]
    )
    const visibleSessions = useMemo(
        () => isFiltering
            ? allSessions.filter(session => (
                sessionMatchesTimeRange(session, timeRange)
                && sessionMatchesQuery(
                    session,
                    normalizedQuery,
                    resolveMachineLabel(session.metadata?.machineId ?? null)
                )
            ))
            : allSessions,
        [allSessions, isFiltering, normalizedQuery, timeRange?.start, timeRange?.end, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const allGroups = useMemo(
        () => groupSessionsByDirectory(allSessions),
        [allSessions]
    )
    const groups = useMemo(
        () => groupSessionsByDirectory(visibleSessions),
        [visibleSessions]
    )
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const autoExpandedSelectedSessionKeyRef = useRef<string | null>(null)
    const isGroupCollapsed = (group: SessionGroup): boolean => {
        if (isFiltering) return false
        const override = collapseOverrides.get(group.key)
        if (override !== undefined) return override
        const hasSelectedSession = selectedSessionId
            ? group.sessions.some(session => session.id === selectedSessionId)
            : false
        return !group.hasActiveSession && !hasSelectedSession
    }

    const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }

    // Per-group reveal cap for paginated "Show N more". Absent = collapsed to the
    // preview limit; each "Show more" bumps it by one batch (step = preview limit).
    const [sessionVisibleCounts, setSessionVisibleCounts] = useState<Map<string, number>>(
        () => new Map()
    )

    const getGroupVisibleCount = (group: SessionGroup): number => {
        return sessionVisibleCounts.get(group.key) ?? sessionPreviewLimit
    }

    const showMoreSessions = (group: SessionGroup) => {
        setSessionVisibleCounts(prev => {
            const next = new Map(prev)
            const current = prev.get(group.key) ?? sessionPreviewLimit
            next.set(group.key, getNextSessionVisibleCount(current, sessionPreviewLimit, group.sessions.length))
            return next
        })
    }

    const collapseSessionGroup = (group: SessionGroup) => {
        setSessionVisibleCounts(prev => {
            if (!prev.has(group.key)) return prev
            const next = new Map(prev)
            next.delete(group.key)
            return next
        })
    }

    const getVisibleGroupSessions = (group: SessionGroup): SessionSummary[] => {
        return getVisibleSessionPreview(
            group.sessions,
            {
                expanded: isFiltering,
                selectedSessionId,
                limit: getGroupVisibleCount(group)
            }
        )
    }

    const machineGroups = useMemo(
        () => groupByMachine(groups, resolveMachineLabel),
        [groups, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )

    const isMachineCollapsed = (mg: MachineGroup): boolean => {
        if (isFiltering) return false
        const key = `machine::${mg.machineId ?? UNKNOWN_MACHINE_ID}`
        const override = collapseOverrides.get(key)
        if (override !== undefined) return override
        const hasSelected = selectedSessionId
            ? mg.projectGroups.some(pg => pg.sessions.some(s => s.id === selectedSessionId))
            : false
        return !mg.hasActiveSession && !hasSelected
    }

    const toggleMachine = (mg: MachineGroup) => {
        const key = `machine::${mg.machineId ?? UNKNOWN_MACHINE_ID}`
        const current = isMachineCollapsed(mg)
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(key, !current)
            return next
        })
    }

    // Auto-expand group (and machine) containing the selected session only when
    // the selected-session/group pair changes. Without this guard, every live
    // session-list refresh (for example tool-call updates from a running selected
    // session) reopens a path the user just collapsed.
    useEffect(() => {
        if (!selectedSessionId) {
            autoExpandedSelectedSessionKeyRef.current = null
            return
        }

        const group = allGroups.find(g =>
            g.sessions.some(s => s.id === selectedSessionId)
        )
        if (!group) return

        const autoExpandKey = `${selectedSessionId}::${group.key}`
        if (autoExpandedSelectedSessionKeyRef.current === autoExpandKey) return
        autoExpandedSelectedSessionKeyRef.current = autoExpandKey

        setCollapseOverrides(prev => expandSelectedSessionCollapseOverrides(prev, group))
    }, [selectedSessionId, allGroups])

    // Clean up stale collapse overrides
    useEffect(() => {
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownKeys = new Set<string>()
            for (const g of allGroups) {
                knownKeys.add(g.key)
                knownKeys.add(`sessions::${g.key}`)
                knownKeys.add(`machine::${g.machineId ?? UNKNOWN_MACHINE_ID}`)
            }
            let changed = false
            for (const key of next.keys()) {
                if (!knownKeys.has(key)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [allGroups])

    // Clean up reveal caps for groups that no longer exist.
    useEffect(() => {
        setSessionVisibleCounts(prev => {
            if (prev.size === 0) return prev
            const knownKeys = new Set(allGroups.map(g => g.key))
            const next = new Map(prev)
            let changed = false
            for (const key of next.keys()) {
                if (!knownKeys.has(key)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [allGroups])

    const containerRef = useRef<HTMLDivElement | null>(null)

    const flatVisibleSessions = useMemo(() => {
        return machineGroups
            .filter(mg => !isMachineCollapsed(mg))
            .flatMap(mg =>
                mg.projectGroups
                    .filter(pg => !isGroupCollapsed(pg))
                    .flatMap(pg => {
                        const projectUserGroups = getGroupsForProject(pg.key)
                        const allGroupedIds = new Set(userGroups.flatMap(g => g.sessionIds))
                        const ungrouped = pg.sessions.filter(s => !allGroupedIds.has(s.id))

                        const groupedSessions = projectUserGroups
                            .filter(ug => !ug.collapsed)
                            .flatMap(ug => pg.sessions.filter(s => ug.sessionIds.includes(s.id)))

                        const visibleUngrouped = getVisibleSessionPreview(ungrouped, {
                            expanded: isFiltering,
                            selectedSessionId,
                            limit: getGroupVisibleCount(pg)
                        })

                        return [...groupedSessions, ...visibleUngrouped]
                    })
            )
    }, [machineGroups, collapseOverrides, selectedSessionId, isFiltering, userGroups, sessionVisibleCounts, getGroupsForProject]) // eslint-disable-line react-hooks/exhaustive-deps

    const handleCheckboxClick = useCallback((sessionId: string, shiftKey: boolean) => {
        if (shiftKey && lastCheckedId) {
            const ids = flatVisibleSessions.map(s => s.id)
            const fromIdx = ids.indexOf(lastCheckedId)
            const toIdx = ids.indexOf(sessionId)
            if (fromIdx !== -1 && toIdx !== -1) {
                const start = Math.min(fromIdx, toIdx)
                const end = Math.max(fromIdx, toIdx)
                setMultiSelectedIds(prev => {
                    const next = new Set(prev)
                    for (let i = start; i <= end; i++) next.add(ids[i])
                    return next
                })
            }
        } else {
            toggleMultiSelect(sessionId)
        }
        setLastCheckedId(sessionId)
    }, [lastCheckedId, flatVisibleSessions, toggleMultiSelect])

    const blockSidebarDeleteShortcut = (event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
        if (!shouldBlockSidebarDeleteShortcut(event, containerRef)) return
        // Avoid accidental destructive cascades: on macOS, Cmd+Delete/Backspace on a
        // focused sidebar item can archive the selected session, then focus falls to
        // the next item and a repeated shortcut archives that one too.
        event.preventDefault()
        event.stopPropagation()
    }

    useEffect(() => {
        const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
            blockSidebarDeleteShortcut(event)
        }

        document.addEventListener('keydown', handleDocumentKeyDown, { capture: true })
        window.addEventListener('keydown', handleDocumentKeyDown, { capture: true })
        return () => {
            document.removeEventListener('keydown', handleDocumentKeyDown, { capture: true })
            window.removeEventListener('keydown', handleDocumentKeyDown, { capture: true })
        }
    })

    const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
        blockSidebarDeleteShortcut(event)
    }

    return (
        <div
            ref={containerRef}
            className="mx-auto w-full max-w-content flex flex-col relative"
            onKeyDownCapture={handleKeyDownCapture}
        >
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {isFiltering
                            ? t('sessions.search.count', { n: visibleSessions.length, total: allSessions.length })
                            : t('sessions.count', { n: allSessions.length, m: allGroups.length })}
                    </div>
                    <div className="flex items-center gap-1">
                        {selectionMode ? (
                            <button
                                type="button"
                                onClick={exitSelectionMode}
                                className="px-2 py-1 text-xs text-[var(--app-link)] transition-colors"
                            >
                                Cancel
                            </button>
                        ) : null}
                        {props.sessions.length > 0 ? (
                            <button
                                type="button"
                                onClick={props.onNewSession}
                                className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                                title={t('sessions.new')}
                            >
                                <PlusIcon className="h-5 w-5" />
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {props.sessions.length > 0 ? (
                <SessionListSearch
                    value={searchQuery}
                    onChange={setSearchQuery}
                    customStart={customStart}
                    customEnd={customEnd}
                    onDateRangeChange={(start, end) => {
                        setCustomStart(start)
                        setCustomEnd(end)
                    }}
                />
            ) : null}

            {props.sessions.length === 0 && (
                <SessionsEmptyState
                    onNewSession={props.onNewSession}
                    onBrowse={props.onBrowse}
                />
            )}

            {props.sessions.length > 0 && isFiltering && visibleSessions.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                    {t('sessions.search.noResults')}
                </div>
            ) : null}

            <div className="flex flex-col gap-3 px-2 pt-1 pb-2">
                {machineGroups.map((mg) => {
                    const machineCollapsed = isMachineCollapsed(mg)
                    const machine = mg.machineId ? machinesById[mg.machineId] : undefined
                    const healthPresentation = presentMachineHealth(
                        machine?.health,
                        getMachinePlatform(machine)
                    )
                    return (
                        <div key={mg.machineId ?? UNKNOWN_MACHINE_ID}>
                            <MachineGroupHeader
                                label={mg.label}
                                sessionCount={mg.totalSessions}
                                collapsed={machineCollapsed}
                                onToggle={() => toggleMachine(mg)}
                                machine={machine}
                                healthPresentation={healthPresentation}
                            />

                            {/* Level 2: Projects */}
                            <div className="collapsible-panel" data-open={!machineCollapsed || undefined}>
                                <div className="collapsible-inner">
                                <div className="flex flex-col ml-3.5 pl-1 mt-0.5">
                                    {mg.projectGroups.map((group) => {
                                        const isCollapsed = isGroupCollapsed(group)
                                        const ungroupedVisibleLimit = getGroupVisibleCount(group)
                                        const canStartInGroupDirectory = group.directory !== 'Other'
                                        const projectUserGroups = getGroupsForProject(group.key)
                                        // Use all user groups (not just this project's) so a session that moved
                                        // project groups is still excluded from ungrouped and stays in its group.
                                        const allGroupedIds = new Set(userGroups.flatMap(ug => ug.sessionIds))
                                        const ungroupedSessions = group.sessions.filter(s => !allGroupedIds.has(s.id))
                                        const visibleUngroupedSessions = getVisibleSessionPreview(ungroupedSessions, {
                                            expanded: isFiltering,
                                            selectedSessionId,
                                            limit: ungroupedVisibleLimit
                                        })
                                        const hiddenUngroupedCount = ungroupedSessions.length - visibleUngroupedSessions.length
                                        const canCollapseUngrouped = ungroupedVisibleLimit > sessionPreviewLimit
                                        const isDraggingGrouped = dragActive && projectUserGroups.some(ug => ug.sessionIds.includes(draggingSessionId.current ?? ''))
                                        return (
                                            <div key={group.key}>
                                                <div
                                                    className="group/project sticky top-0 z-10 flex items-center gap-2 px-1 py-1.5 text-left rounded-lg transition-colors hover:bg-[var(--app-subtle-bg)] cursor-pointer min-w-0 w-full select-none"
                                                    onClick={() => toggleGroup(group.key, isCollapsed)}
                                                    title={group.directory}
                                                >
                                                    <ChevronIcon className="h-3.5 w-3.5 text-[var(--app-hint)] shrink-0" collapsed={isCollapsed} />
                                                    <span className="font-medium text-sm truncate flex-1">
                                                        {group.displayName}
                                                    </span>
                                                    <CopyPathButton path={group.directory} className="opacity-0 group-hover/project:opacity-100 transition-opacity duration-150" />
                                                    {onNewSessionInDirectory && canStartInGroupDirectory ? (
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation()
                                                                onNewSessionInDirectory({
                                                                    machineId: group.machineId,
                                                                    directory: group.directory
                                                                })
                                                            }}
                                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] opacity-70 transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                                            title={t('sessions.group.new')}
                                                            aria-label={t('sessions.group.new')}
                                                        >
                                                            <PlusIcon className="h-3.5 w-3.5" />
                                                        </button>
                                                    ) : null}
                                                    <span className="text-[11px] tabular-nums text-[var(--app-hint)] shrink-0">
                                                        ({group.sessions.length})
                                                    </span>
                                                </div>

                                                {/* Level 3: User groups + ungrouped sessions */}
                                                <div className="collapsible-panel" data-open={!isCollapsed || undefined}>
                                                    <div className="collapsible-inner">
                                                    <div className="flex flex-col ml-3 pl-1 pr-1 py-1">
                                                        {/* User groups */}
                                                        {projectUserGroups.map(ug => {
                                                            const ugSessions = ug.sessionIds
                                                                // Fall back to allSessions if the session moved to a different
                                                                // project group (e.g. after a rename that changes metadata).
                                                                .map(id => group.sessions.find(s => s.id === id) ?? allSessions.find(s => s.id === id))
                                                                .filter((s): s is SessionSummary => !!s)
                                                            if (isFiltering && ugSessions.length === 0) return null
                                                            return (
                                                                <div key={ug.id} className="mb-0.5">
                                                                    <UserGroupHeader
                                                                        group={ug}
                                                                        sessionCount={ugSessions.length}
                                                                        onRename={renameGroup}
                                                                        onDelete={deleteGroup}
                                                                        onToggleCollapsed={toggleGroupCollapsed}
                                                                        isDragOver={dragOverTarget === `group:${ug.id}`}
                                                                        onDragOver={e => { e.preventDefault(); setDragOverTarget(`group:${ug.id}`) }}
                                                                        onDragLeave={() => setDragOverTarget(null)}
                                                                        onDrop={e => {
                                                                            e.preventDefault()
                                                                            const sid = e.dataTransfer.getData('text/plain')
                                                                            if (sid) moveSessionToGroup(sid, ug.id)
                                                                            setDragOverTarget(null)
                                                                        }}
                                                                    />
                                                                    {!ug.collapsed ? (
                                                                        <div className="flex flex-col gap-0.5 ml-4 border-l border-[var(--app-border)] pl-1.5 pb-0.5">
                                                                            {ugSessions.map(s => (
                                                                                <div
                                                                                    key={s.id}
                                                                                    draggable
                                                                                    onDragStart={e => {
                                                                                        e.dataTransfer.setData('text/plain', s.id)
                                                                                        e.dataTransfer.effectAllowed = 'move'
                                                                                        draggingSessionId.current = s.id
                                                                                        setDragActive(true)
                                                                                    }}
                                                                                    onDragEnd={() => {
                                                                                        draggingSessionId.current = null
                                                                                        setDragActive(false)
                                                                                        setDragOverTarget(null)
                                                                                    }}
                                                                                >
                                                                                    <SessionItem
                                                                                        session={s}
                                                                                        onSelect={props.onSelect}
                                                                                        showPath={false}
                                                                                        api={api}
                                                                                        selected={s.id === selectedSessionId}
                                                                                        selectionMode={selectionMode}
                                                                                        isMultiSelected={multiSelectedIds.has(s.id)}
                                                                                        onToggleMultiSelect={toggleMultiSelect}
                                                                                        onCheckboxClick={handleCheckboxClick}
                                                                                        onCloned={onCloned}
                                                                                        unreadDoneOrder={props.unreadDoneOrders?.[s.id]}
                                                                                        showDetailedStatus={showDetailedStatus}
                                                                                    />
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            )
                                                        })}

                                                        {/* Drop zone to remove session from a group (shown while dragging a grouped session) */}
                                                        {isDraggingGrouped ? (
                                                            <div
                                                                className={cn(
                                                                    'mx-1 my-1 cursor-copy rounded-lg border-2 border-dashed py-2 text-center text-xs transition-colors',
                                                                    dragOverTarget === `ungrouped:${group.key}`
                                                                        ? 'border-blue-400 bg-blue-500/10 text-blue-500'
                                                                        : 'border-[var(--app-border)] text-[var(--app-hint)]'
                                                                )}
                                                                onDragOver={e => { e.preventDefault(); setDragOverTarget(`ungrouped:${group.key}`) }}
                                                                onDragLeave={() => setDragOverTarget(null)}
                                                                onDrop={e => {
                                                                    e.preventDefault()
                                                                    const sid = e.dataTransfer.getData('text/plain')
                                                                    if (sid) moveSessionToGroup(sid, null)
                                                                    draggingSessionId.current = null
                                                                    setDragActive(false)
                                                                    setDragOverTarget(null)
                                                                }}
                                                            >
                                                                Remove from group
                                                            </div>
                                                        ) : null}

                                                        {/* Ungrouped sessions */}
                                                        <div className="flex flex-col gap-0.5">
                                                            {visibleUngroupedSessions.map(s => (
                                                                <div
                                                                    key={s.id}
                                                                    draggable={projectUserGroups.length > 0}
                                                                    onDragStart={e => {
                                                                        e.dataTransfer.setData('text/plain', s.id)
                                                                        e.dataTransfer.effectAllowed = 'move'
                                                                        draggingSessionId.current = s.id
                                                                        setDragActive(true)
                                                                    }}
                                                                    onDragEnd={() => {
                                                                        draggingSessionId.current = null
                                                                        setDragActive(false)
                                                                        setDragOverTarget(null)
                                                                    }}
                                                                >
                                                                    <SessionItem
                                                                        session={s}
                                                                        onSelect={props.onSelect}
                                                                        showPath={false}
                                                                        api={api}
                                                                        selected={s.id === selectedSessionId}
                                                                        selectionMode={selectionMode}
                                                                        isMultiSelected={multiSelectedIds.has(s.id)}
                                                                        onToggleMultiSelect={toggleMultiSelect}
                                                                        onCheckboxClick={handleCheckboxClick}
                                                                        onCloned={onCloned}
                                                                        unreadDoneOrder={props.unreadDoneOrders?.[s.id]}
                                                                        showDetailedStatus={showDetailedStatus}
                                                                    />
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {!isFiltering && ungroupedSessions.length > sessionPreviewLimit && (hiddenUngroupedCount > 0 || canCollapseUngrouped) ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => hiddenUngroupedCount > 0
                                                                    ? showMoreSessions(group)
                                                                    : collapseSessionGroup(group)}
                                                                className={cn(
                                                                    'mx-2 my-1 rounded-md px-2 py-1 text-left text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                                                                    hiddenUngroupedCount > 0 && 'border border-dashed border-[var(--app-border)]'
                                                                )}
                                                            >
                                                                {hiddenUngroupedCount > 0
                                                                    ? t('sessions.group.showMore', { n: Math.min(sessionPreviewLimit, hiddenUngroupedCount) })
                                                                    : t('sessions.group.showLess')}
                                                            </button>
                                                        ) : null}
                                                    </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>

            {selectionMode ? (
                <div className="sticky bottom-0 z-20 border-t border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 flex items-center gap-2 flex-wrap">
                    <span className="flex-1 text-sm text-[var(--app-hint)]">
                        {multiSelectedIds.size} selected
                    </span>
                    {multiSelectedIds.size > 0 && !showGroupNameInput ? (
                        <>
                            {selectedUnreadCount > 0 ? (
                                <button
                                    type="button"
                                    disabled={archivePending || reviewPending}
                                    onClick={markSelectedReviewed}
                                    className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                                >
                                    Mark reviewed ({selectedUnreadCount})
                                </button>
                            ) : null}
                            <button
                                type="button"
                                disabled={archivePending || reviewPending}
                                onClick={() => void archiveSelected()}
                                className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                            >
                                {archivePending ? 'Archiving…' : 'Archive'}
                            </button>
                            <button
                                type="button"
                                disabled={reviewPending || archivePending}
                                onClick={() => void markSelectedReadyForReview(false)}
                                className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                            >
                                Unmark
                            </button>
                            <button
                                type="button"
                                disabled={reviewPending || archivePending}
                                onClick={() => void markSelectedReadyForReview(true)}
                                className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                            >
                                {reviewPending ? 'Marking…' : 'Ready to Review'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setGroupNameValue('')
                                    setShowGroupNameInput(true)
                                    setTimeout(() => groupNameInputRef.current?.focus(), 0)
                                }}
                                className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                            >
                                Group
                            </button>
                        </>
                    ) : null}
                    {showGroupNameInput ? (
                        <>
                            <input
                                ref={groupNameInputRef}
                                type="text"
                                value={groupNameValue}
                                onChange={e => setGroupNameValue(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault()
                                        groupSelectedSessions(groupNameValue)
                                    }
                                    if (e.key === 'Escape') {
                                        setShowGroupNameInput(false)
                                        setGroupNameValue('')
                                    }
                                }}
                                placeholder="Group name…"
                                className="min-w-0 flex-1 rounded-lg border border-[var(--app-link)] bg-[var(--app-bg)] px-3 py-1.5 text-xs text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)]"
                            />
                            <button
                                type="button"
                                onClick={() => groupSelectedSessions(groupNameValue)}
                                disabled={!groupNameValue.trim()}
                                className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                            >
                                Create
                            </button>
                            <button
                                type="button"
                                onClick={() => { setShowGroupNameInput(false); setGroupNameValue('') }}
                                className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                            >
                                Cancel
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={exitSelectionMode}
                            className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                        >
                            Cancel
                        </button>
                    )}
                </div>
            ) : null}
        </div>
    )
}
