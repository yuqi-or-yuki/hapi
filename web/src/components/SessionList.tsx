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
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { useSessionGroups, type UserSessionGroup } from '@/hooks/useSessionGroups'

type SessionGroup = {
    key: string
    directory: string
    displayName: string
    machineId: string | null
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
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
export const GROUP_SESSION_PREVIEW_LIMIT = 8

export function deduplicateSessionsByAgentId(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    const byAgentId = new Map<string, SessionSummary[]>()
    const result: SessionSummary[] = []

    for (const session of sessions) {
        const agentId = session.metadata?.agentSessionId
        if (!agentId) {
            result.push(session)
            continue
        }
        const group = byAgentId.get(agentId)
        if (group) {
            group.push(session)
        } else {
            byAgentId.set(agentId, [session])
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

    // Session preview keys use inverted semantics: false = expanded, true/missing = collapsed.
    const sessionPreviewKey = `sessions::${group.key}`
    if (overrides.get(sessionPreviewKey) !== false) {
        next.set(sessionPreviewKey, false)
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

export function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
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
        session.id,
        session.metadata?.path,
        session.metadata?.worktree?.basePath,
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
        if (session.active) requiredIds.add(session.id)
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

function SessionListSearch(props: {
    value: string
    onChange: (value: string) => void
}) {
    const { t } = useTranslation()
    return (
        <div className="relative px-3 pb-2">
            <div className="pointer-events-none absolute inset-y-0 left-5 flex items-center pb-2 text-[var(--app-hint)]">
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
                    className="absolute inset-y-0 right-5 flex items-center pb-2 rounded p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    title={t('sessions.search.clear')}
                >
                    <XIcon className="h-3.5 w-3.5" />
                </button>
            ) : null}
        </div>
    )
}

const FLAVOR_BADGES: Record<string, { label: string; colors: string }> = {
    claude: {
        label: 'Cl',
        colors: 'bg-[#d97706] text-white',
    },
    codex: {
        label: 'Cx',
        colors: 'bg-[#111827] text-white',
    },
    cursor: {
        label: 'Cu',
        colors: 'bg-[#0f766e] text-white',
    },
    gemini: {
        label: 'Gm',
        colors: 'bg-[#2563eb] text-white',
    },
    opencode: {
        label: 'Op',
        colors: 'bg-[#15803d] text-white',
    },
}

function FlavorIcon({ flavor, className }: { flavor?: string | null; className?: string }) {
    const badge = FLAVOR_BADGES[(flavor ?? 'claude').trim().toLowerCase()] ?? FLAVOR_BADGES.claude
    return (
        <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center rounded-sm text-[8px] font-semibold leading-none ${badge.colors} ${className ?? 'h-4 w-4'}`}
        >
            {badge.label}
        </span>
    )
}

function MachineIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
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

function formatRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
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
}) {
    const { t } = useTranslation()
    const { session: s, onSelect, showPath = true, api, selected = false, selectionMode = false, isMultiSelected = false } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [cloneOpen, setCloneOpen] = useState(false)

    const { archiveSession, renameSession, deleteSession, cloneSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )

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
    const todoProgress = getTodoProgress(s)
    const readyForReview = s.metadata?.readyForReview === true

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
                >
                    <div className={`flex items-center justify-between gap-3 ${!s.active ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="relative shrink-0">
                                <FlavorIcon flavor={s.metadata?.flavor} className="h-4 w-4" />
                                {readyForReview && !selectionMode ? (
                                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-blue-500 ring-1 ring-[var(--app-bg)]" />
                                ) : null}
                            </div>
                            <div className={`truncate text-sm font-medium ${s.active ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}>
                                {sessionName}
                            </div>
                            {s.active && s.thinking ? (
                                <LoaderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-badge-success-text)] animate-spin-slow" />
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
                            {s.pendingRequestsCount > 0 ? (
                                <span className="text-[var(--app-badge-warning-text)]">
                                    {t('session.item.pending')} {s.pendingRequestsCount}
                                </span>
                            ) : null}
                            <span className="text-[var(--app-hint)]">
                                {formatRelativeTime(s.updatedAt, t)}
                            </span>
                        </div>
                    </div>
                    {showPath ? (
                        <div className="truncate text-xs text-[var(--app-hint)]">
                            {s.metadata?.path ?? s.id}
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
                        onArchive={() => setArchiveOpen(true)}
                        onDelete={() => setDeleteOpen(true)}
                        onClone={() => setCloneOpen(true)}
                        anchorPoint={menuAnchorPoint}
                    />

                    <RenameSessionDialog
                        isOpen={renameOpen}
                        onClose={() => setRenameOpen(false)}
                        currentName={sessionName}
                        onRename={renameSession}
                        isPending={isPending}
                    />

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
    selectedSessionId?: string | null
    onCloned?: (newSessionId: string) => void
    unreadDoneOrders?: Record<string, number>
    onMarkReviewed?: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const { renderHeader = true, api, selectedSessionId, machineLabelsById = {}, onNewSessionInDirectory, onCloned } = props
    const { hideArchivedSessions } = useHideArchivedSessions()
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
    const isSearching = normalizedQuery.length > 0

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
        () => hideArchivedSessions
            ? props.sessions.filter(s => s.active || s.id === selectedSessionId)
            : props.sessions,
        [props.sessions, hideArchivedSessions, selectedSessionId]
    )
    const visibleSessions = useMemo(
        () => isSearching
            ? allSessions.filter(session => sessionMatchesQuery(
                session,
                normalizedQuery,
                resolveMachineLabel(session.metadata?.machineId ?? null)
            ))
            : allSessions,
        [allSessions, isSearching, normalizedQuery, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
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
    const isGroupCollapsed = (group: SessionGroup): boolean => {
        if (isSearching) return false
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

    const isSessionGroupExpanded = (group: SessionGroup): boolean => {
        if (isSearching || group.sessions.length <= GROUP_SESSION_PREVIEW_LIMIT) return true
        const key = `sessions::${group.key}`
        const override = collapseOverrides.get(key)
        if (override !== undefined) return !override
        return false
    }

    const toggleSessionGroup = (group: SessionGroup) => {
        const key = `sessions::${group.key}`
        const expanded = isSessionGroupExpanded(group)
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(key, expanded)
            return next
        })
    }

    const getVisibleGroupSessions = (group: SessionGroup): SessionSummary[] => {
        return getVisibleSessionPreview(
            group.sessions,
            {
                expanded: isSessionGroupExpanded(group),
                selectedSessionId
            }
        )
    }

    const machineGroups = useMemo(
        () => groupByMachine(groups, resolveMachineLabel),
        [groups, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )

    const isMachineCollapsed = (mg: MachineGroup): boolean => {
        if (isSearching) return false
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

    // Auto-expand group (and machine) containing selected session
    useEffect(() => {
        if (!selectedSessionId) return
        setCollapseOverrides(prev => {
            const group = allGroups.find(g =>
                g.sessions.some(s => s.id === selectedSessionId)
            )
            if (!group) return prev
            return expandSelectedSessionCollapseOverrides(prev, group)
        })
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
                            expanded: isSessionGroupExpanded(pg),
                            selectedSessionId,
                        })

                        return [...groupedSessions, ...visibleUngrouped]
                    })
            )
    }, [machineGroups, collapseOverrides, selectedSessionId, isSearching, userGroups]) // eslint-disable-line react-hooks/exhaustive-deps

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
                        {isSearching
                            ? t('sessions.search.count', { n: visibleSessions.length, total: allSessions.length })
                            : t('sessions.count', { n: props.sessions.length, m: allGroups.length })}
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
                <SessionListSearch value={searchQuery} onChange={setSearchQuery} />
            ) : null}

            {props.sessions.length === 0 && (
                <SessionsEmptyState
                    onNewSession={props.onNewSession}
                    onBrowse={props.onBrowse}
                />
            )}

            {props.sessions.length > 0 && isSearching && visibleSessions.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                    {t('sessions.search.noResults')}
                </div>
            ) : null}

            <div className="flex flex-col gap-3 px-2 pt-1 pb-2">
                {machineGroups.map((mg) => {
                    const machineCollapsed = isMachineCollapsed(mg)
                    return (
                        <div key={mg.machineId ?? UNKNOWN_MACHINE_ID}>
                            {/* Level 1: Machine */}
                            <button
                                type="button"
                                onClick={() => toggleMachine(mg)}
                                className="flex w-full items-center gap-2 px-1 py-1.5 text-left rounded-lg transition-colors hover:bg-[var(--app-subtle-bg)] select-none"
                            >
                                <ChevronIcon className="h-4 w-4 text-[var(--app-hint)] shrink-0" collapsed={machineCollapsed} />
                                <MachineIcon className="h-4 w-4 text-[var(--app-hint)] shrink-0" />
                                <span className="text-sm font-semibold truncate flex-1">{mg.label}</span>
                                <span className="text-[11px] tabular-nums text-[var(--app-hint)] shrink-0">({mg.totalSessions})</span>
                            </button>

                            {/* Level 2: Projects */}
                            <div className="collapsible-panel" data-open={!machineCollapsed || undefined}>
                                <div className="collapsible-inner">
                                <div className="flex flex-col ml-3.5 pl-1 mt-0.5">
                                    {mg.projectGroups.map((group) => {
                                        const isCollapsed = isGroupCollapsed(group)
                                        const sessionGroupExpanded = isSessionGroupExpanded(group)
                                        const canStartInGroupDirectory = group.directory !== 'Other'
                                        const projectUserGroups = getGroupsForProject(group.key)
                                        // Use all user groups (not just this project's) so a session that moved
                                        // project groups is still excluded from ungrouped and stays in its group.
                                        const allGroupedIds = new Set(userGroups.flatMap(ug => ug.sessionIds))
                                        const ungroupedSessions = group.sessions.filter(s => !allGroupedIds.has(s.id))
                                        const visibleUngroupedSessions = getVisibleSessionPreview(ungroupedSessions, {
                                            expanded: sessionGroupExpanded,
                                            selectedSessionId,
                                        })
                                        const hiddenUngroupedCount = ungroupedSessions.length - visibleUngroupedSessions.length
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
                                                            if (isSearching && ugSessions.length === 0) return null
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
                                                                    />
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {!isSearching && ungroupedSessions.length > GROUP_SESSION_PREVIEW_LIMIT && (sessionGroupExpanded || hiddenUngroupedCount > 0) ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleSessionGroup(group)}
                                                                className={cn(
                                                                    'mx-2 my-1 rounded-md px-2 py-1 text-left text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                                                                    hiddenUngroupedCount > 0 && 'border border-dashed border-[var(--app-border)]'
                                                                )}
                                                            >
                                                                {sessionGroupExpanded
                                                                    ? t('sessions.group.showLess')
                                                                    : t('sessions.group.showMore', { n: hiddenUngroupedCount })}
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
