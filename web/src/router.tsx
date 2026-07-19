import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    Navigate,
    Outlet,
    createRootRoute,
    createRoute,
    createRouter,
    useLocation,
    useMatchRoute,
    useNavigate,
    useParams,
} from '@tanstack/react-router'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { NewSession } from '@/components/NewSession'
import { WorkspaceBrowser } from '@/components/WorkspaceBrowser'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { useSkillUsage } from '@/hooks/queries/useSkillUsage'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { fetchLatestMessages, seedMessageWindowFromSession } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { AGENT_DONE_RING_OPTIONS, type AgentDoneRing } from '@/lib/agentDoneSound'
import type { ApiClient } from '@/api/client'
import type { Machine, ScheduledMessage, SessionSummary } from '@/types/api'
import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'
import TerminalPage from '@/routes/sessions/terminal'
import SettingsPage from '@/routes/settings'

const NTFY_SESSION_DONE_KEY = 'hapi-ntfy-session-done-v1'
const NTFY_ALL_CLEAR_KEY = 'hapi-ntfy-all-clear-v1'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
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

function FolderOpenIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function SettingsIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function BellIcon(props: { className?: string; muted?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M10.3 21a2 2 0 0 0 3.4 0" />
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            {props.muted ? <path d="M3 3l18 18" /> : (
                <>
                    <path d="M4 4C2.8 5.2 2 6.8 2 8.5" />
                    <path d="M20 4c1.2 1.2 2 2.8 2 4.5" />
                </>
            )}
        </svg>
    )
}

function PlayIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
        >
            <path d="M8 5v14l11-7z" />
        </svg>
    )
}

function ChartIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 3v18h18" />
            <path d="M7 16V9" />
            <path d="M12 16V5" />
            <path d="M17 16v-4" />
        </svg>
    )
}

function CalendarClockIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M8 2v4" />
            <path d="M16 2v4" />
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M3 10h18" />
            <path d="M12 14v3l2 1" />
        </svg>
    )
}

function RingSettingsButton(props: {
    api: ApiClient
    muted: boolean
    onMutedChange: (muted: boolean) => void
    agentRing: AgentDoneRing
    onAgentRingChange: (ring: AgentDoneRing) => void
    allDoneRing: AgentDoneRing
    onAllDoneRingChange: (ring: AgentDoneRing) => void
    onPreview: (ring?: AgentDoneRing) => void
}) {
    const [open, setOpen] = useState(false)
    const [ntfySessionDone, setNtfySessionDone] = useState(true)
    const [ntfyAllClear, setNtfyAllClear] = useState(true)
    const [ntfyLoaded, setNtfyLoaded] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (!open || ntfyLoaded) return
        let cancelled = false
        Promise.all([
            props.api.getPreference<boolean>(NTFY_SESSION_DONE_KEY),
            props.api.getPreference<boolean>(NTFY_ALL_CLEAR_KEY),
        ]).then(([sessionDone, allClear]) => {
            if (cancelled) return
            setNtfySessionDone(sessionDone !== false)
            setNtfyAllClear(allClear !== false)
            setNtfyLoaded(true)
        }).catch(() => {
            if (!cancelled) setNtfyLoaded(true)
        })
        return () => { cancelled = true }
    }, [open, ntfyLoaded, props.api])

    const updateNtfySessionDone = useCallback((enabled: boolean) => {
        setNtfySessionDone(enabled)
        void props.api.setPreference(NTFY_SESSION_DONE_KEY, enabled)
    }, [props.api])

    const updateNtfyAllClear = useCallback((enabled: boolean) => {
        setNtfyAllClear(enabled)
        void props.api.setPreference(NTFY_ALL_CLEAR_KEY, enabled)
    }, [props.api])

    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (rootRef.current?.contains(target)) return
            setOpen(false)
        }
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen(value => !value)}
                className={props.muted
                    ? 'p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors'
                    : 'p-1.5 rounded-full text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] transition-colors'
                }
                title={props.muted ? 'Agent rings muted' : 'Agent ring settings'}
                aria-label={props.muted ? 'Agent rings muted' : 'Agent ring settings'}
                aria-expanded={open}
            >
                <BellIcon className="h-5 w-5" muted={props.muted} />
            </button>

            {open ? (
                <div className="fixed inset-0 z-[100] bg-black/15 sm:bg-transparent" onClick={() => setOpen(false)}>
                    <div
                        className="absolute left-3 right-3 top-[calc(env(safe-area-inset-top)+3.25rem)] max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm shadow-2xl sm:left-3 sm:right-auto sm:top-14 sm:w-80"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="mb-3 flex items-center justify-between gap-3">
                            <div>
                                <div className="font-semibold text-[var(--app-fg)]">Notifications</div>
                                <div className="text-xs text-[var(--app-hint)]">Rings here; ntfy pushes to phone.</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => props.onMutedChange(!props.muted)}
                                className={props.muted
                                    ? 'rounded-full border border-[var(--app-border)] px-3 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
                                    : 'rounded-full bg-[var(--app-link)] px-3 py-1 text-xs font-medium text-white hover:opacity-90'
                                }
                            >
                                {props.muted ? 'Muted' : 'On'}
                            </button>
                        </div>

                        <RingSettingRow
                            label="Agent done ring"
                            hint="one session finished"
                            description="Plays when any individual agent/session completes."
                            value={props.agentRing}
                            onChange={(ring) => {
                                props.onAgentRingChange(ring)
                                props.onPreview(ring)
                            }}
                            onPreview={() => props.onPreview(props.agentRing)}
                        />
                        <RingSettingRow
                            label="All clear ring"
                            hint="everything finished"
                            description="Plays instead when that completion leaves zero active sessions."
                            value={props.allDoneRing}
                            onChange={(ring) => {
                                props.onAllDoneRingChange(ring)
                                props.onPreview(ring)
                            }}
                            onPreview={() => props.onPreview(props.allDoneRing)}
                        />
                        <div className="mt-2 rounded-xl border border-[var(--app-border)] p-2">
                            <div className="mb-1 flex items-baseline justify-between gap-2">
                                <span className="text-xs font-medium text-[var(--app-fg)]">Phone ntfy</span>
                                <span className="text-[10px] text-[var(--app-hint)]">server push</span>
                            </div>
                            <div className="mb-2 text-[11px] leading-snug text-[var(--app-hint)]">
                                Sends short ntfy messages even if this browser is closed.
                            </div>
                            <label className="flex items-center justify-between gap-3 rounded-lg py-1.5">
                                <span className="text-xs text-[var(--app-fg)]">Every session done</span>
                                <input
                                    type="checkbox"
                                    checked={ntfySessionDone}
                                    onChange={(event) => updateNtfySessionDone(event.target.checked)}
                                    className="h-4 w-4 accent-[var(--app-link)]"
                                />
                            </label>
                            <label className="flex items-center justify-between gap-3 rounded-lg py-1.5">
                                <span className="text-xs text-[var(--app-fg)]">All clear</span>
                                <input
                                    type="checkbox"
                                    checked={ntfyAllClear}
                                    onChange={(event) => updateNtfyAllClear(event.target.checked)}
                                    className="h-4 w-4 accent-[var(--app-link)]"
                                />
                            </label>
                        </div>

                        <div className="mt-3 text-[11px] leading-snug text-[var(--app-hint)]">
                            iPhone note: tap a preview button once to unlock sound for this page. ntfy settings apply after the hub receives the preference.
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

function RingSettingRow(props: {
    label: string
    hint?: string
    description: string
    value: AgentDoneRing
    onChange: (ring: AgentDoneRing) => void
    onPreview: () => void
}) {
    return (
        <div className="mt-2 rounded-xl border border-[var(--app-border)] p-2">
            <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-[var(--app-fg)]">{props.label}</span>
                {props.hint ? <span className="text-[10px] text-[var(--app-hint)]">{props.hint}</span> : null}
            </div>
            <div className="mb-2 text-[11px] leading-snug text-[var(--app-hint)]">
                {props.description}
            </div>
            <div className="flex items-center gap-2">
                <select
                    value={props.value}
                    onChange={(event) => props.onChange(event.target.value as AgentDoneRing)}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none hover:bg-[var(--app-subtle-bg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    {AGENT_DONE_RING_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    onClick={props.onPreview}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    title={`Preview ${props.label}`}
                    aria-label={`Preview ${props.label}`}
                >
                    <PlayIcon className="h-4 w-4" />
                </button>
            </div>
        </div>
    )
}

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

function SessionsPage() {
    const {
        api,
        agentDoneSoundMuted,
        setAgentDoneSoundMuted,
        agentDoneRing,
        setAgentDoneRing,
        allDoneRing,
        setAllDoneRing,
        previewAgentDoneRing,
        unreadDoneOrders,
        clearUnreadDone
    } = useAppContext()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const { machines } = useMachines(api, true)

    const handleRefresh = useCallback(() => {
        void refetch()
    }, [refetch])

    const projectCount = useMemo(() => new Set(sessions.map(s =>
        s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other'
    )).size, [sessions])
    const machineLabelsById = useMemo(() => {
        const labels: Record<string, string> = {}
        for (const machine of machines) {
            labels[machine.id] = getMachineTitle(machine)
        }
        return labels
    }, [machines])
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const sidebar = useSidebarResize()
    const handleNewSessionInDirectory = useCallback((args: { machineId: string | null; directory: string }) => {
        navigate({
            to: '/sessions/new',
            search: args.machineId
                ? { directory: args.directory, machineId: args.machineId }
                : { directory: args.directory }
        })
    }, [navigate])

    return (
        <div className="flex h-full min-h-0">
            <div
                className={`${isSessionsIndex ? 'flex' : 'hidden lg:flex'} w-full shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
            >
                <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content flex items-center justify-between px-3 py-2">
                        <div className="min-w-0 text-xs text-[var(--app-hint)]">
                            {t('sessions.count', { n: sessions.length, m: projectCount })}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/dashboard' })}
                                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title="Open dashboard"
                            >
                                <ChartIcon className="h-4 w-4" />
                                Dashboard
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/scheduled-jobs' })}
                                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title="Open scheduled jobs"
                            >
                                <CalendarClockIcon className="h-4 w-4" />
                                Jobs
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/browse' })}
                                className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('browse.nav')}
                            >
                                <FolderOpenIcon className="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/settings' })}
                                className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('settings.title')}
                            >
                                <SettingsIcon className="h-5 w-5" />
                            </button>
                            <RingSettingsButton
                                api={api}
                                muted={agentDoneSoundMuted}
                                onMutedChange={setAgentDoneSoundMuted}
                                agentRing={agentDoneRing}
                                onAgentRingChange={setAgentDoneRing}
                                allDoneRing={allDoneRing}
                                onAllDoneRingChange={setAllDoneRing}
                                onPreview={previewAgentDoneRing}
                            />
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/sessions/new' })}
                                className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                                title={t('sessions.new')}
                            >
                                <PlusIcon className="h-5 w-5" />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="app-scroll-y flex-1 min-h-0 desktop-scrollbar-left">
                    {error ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    <SessionList
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={(sessionId) => {
                            clearUnreadDone(sessionId)
                            navigate({
                                to: '/sessions/$sessionId',
                                params: { sessionId },
                            })
                        }}
                        onNewSession={() => navigate({ to: '/sessions/new' })}
                        onNewSessionInDirectory={handleNewSessionInDirectory}
                        onBrowse={() => navigate({ to: '/browse' })}
                        onRefresh={handleRefresh}
                        isLoading={isLoading}
                        renderHeader={false}
                        api={api}
                        machineLabelsById={machineLabelsById}
                        unreadDoneOrders={unreadDoneOrders}
                        onCloned={(newSessionId) => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: newSessionId },
                        })}
                    />
                </div>
            </div>

            {/* Resize handle - desktop only */}
            <div
                className="sidebar-resize-handle hidden lg:block shrink-0"
                data-dragging={sidebar.isDragging || undefined}
                onPointerDown={sidebar.onPointerDown}
            />

            <div className={`${isSessionsIndex ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
        </div>
    )
}


function normalizeMs(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
    return value < 1_000_000_000_000 ? value * 1000 : value
}

function getSessionStartedAt(session: SessionSummary): number | null {
    return normalizeMs(session.activeAt) ?? normalizeMs(session.updatedAt)
}

function getSessionEndedAt(session: SessionSummary, now: number): number | null {
    if (session.active) return now
    return normalizeMs(session.updatedAt)
}

function formatShortDateTime(ms: number): string {
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })
}

function formatAgentFlavor(session: SessionSummary): string {
    const flavor = (session.metadata?.flavor ?? 'claude').trim().toLowerCase()
    if (flavor === 'claude') return 'Claude Code'
    if (flavor === 'codex') return 'Codex'
    if (flavor === 'gemini') return 'Gemini'
    if (flavor === 'opencode') return 'OpenCode'
    if (flavor === 'cursor') return 'Cursor'
    return flavor ? flavor[0].toUpperCase() + flavor.slice(1) : 'Unknown'
}

function formatModelFamily(session: SessionSummary): string {
    const model = session.model?.trim()
    if (!model) return `${formatAgentFlavor(session)} auto`
    const normalized = model.toLowerCase()
    if (normalized.includes('fable')) return 'Claude Fable 5'
    if (normalized.includes('opus')) return `Claude ${model}`
    if (normalized.includes('sonnet')) return `Claude ${model}`
    if (normalized.includes('haiku')) return `Claude ${model}`
    if (normalized.includes('gpt') || normalized.includes('codex')) return model
    return model
}

function formatReasoning(session: SessionSummary): string {
    const modelReasoningEffort = session.modelReasoningEffort?.trim()
    if (modelReasoningEffort) return modelReasoningEffort
    const effort = session.effort?.trim()
    if (effort) return effort
    return 'default'
}

function buildConcurrencySeries(sessions: SessionSummary[], now: number): Array<{ t: number; count: number }> {
    const events: Array<{ t: number; delta: number }> = []
    for (const session of sessions) {
        const start = getSessionStartedAt(session)
        const end = getSessionEndedAt(session, now)
        if (start == null || end == null || end < start) continue
        events.push({ t: start, delta: 1 })
        events.push({ t: end, delta: -1 })
    }
    events.sort((a, b) => a.t - b.t || b.delta - a.delta)
    if (events.length === 0) return []

    const series: Array<{ t: number; count: number }> = []
    let count = 0
    let i = 0
    while (i < events.length) {
        const t = events[i]!.t
        let delta = 0
        while (i < events.length && events[i]!.t === t) {
            delta += events[i]!.delta
            i += 1
        }
        count = Math.max(0, count + delta)
        series.push({ t, count })
    }
    return series
}

function getDashboardStats(sessions: SessionSummary[]) {
    const now = Date.now()
    const series = buildConcurrencySeries(sessions, now)
    const maxConcurrent = series.reduce((max, point) => Math.max(max, point.count), 0)
    const activeNow = sessions.filter(s => s.active && s.thinking).length
    const flavorCounts = new Map<string, number>()
    const modelCounts = new Map<string, number>()
    const reasoningCounts = new Map<string, number>()
    const comboCounts = new Map<string, number>()
    for (const session of sessions) {
        const flavor = formatAgentFlavor(session)
        const model = formatModelFamily(session)
        const reasoning = formatReasoning(session)
        flavorCounts.set(flavor, (flavorCounts.get(flavor) ?? 0) + 1)
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1)
        reasoningCounts.set(reasoning, (reasoningCounts.get(reasoning) ?? 0) + 1)
        comboCounts.set(`${model} · ${reasoning}`, (comboCounts.get(`${model} · ${reasoning}`) ?? 0) + 1)
    }
    return { now, series, maxConcurrent, activeNow, flavorCounts, modelCounts, reasoningCounts, comboCounts }
}

function ConcurrencyChart(props: { series: Array<{ t: number; count: number }> }) {
    if (props.series.length === 0) {
        return <div className="rounded-xl border border-[var(--app-border)] p-6 text-sm text-[var(--app-hint)]">No session timing data yet.</div>
    }
    const width = 720
    const height = 260
    const pad = { left: 36, right: 12, top: 16, bottom: 34 }
    const minT = props.series[0]!.t
    const maxT = props.series[props.series.length - 1]!.t
    const maxC = Math.max(1, ...props.series.map(p => p.count))
    const x = (t: number) => pad.left + ((t - minT) / Math.max(1, maxT - minT)) * (width - pad.left - pad.right)
    const y = (c: number) => height - pad.bottom - (c / maxC) * (height - pad.top - pad.bottom)
    const path = props.series.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.t).toFixed(1)} ${y(point.count).toFixed(1)}`).join(' ')
    const area = `${path} L ${x(maxT).toFixed(1)} ${height - pad.bottom} L ${x(minT).toFixed(1)} ${height - pad.bottom} Z`
    const yTicks = Array.from({ length: maxC + 1 }, (_, i) => i).filter(i => i === 0 || i === maxC || i % Math.max(1, Math.ceil(maxC / 4)) === 0)

    return (
        <div className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]">
            <svg viewBox={`0 0 ${width} ${height}`} className="h-72 w-full">
                {yTicks.map(tick => (
                    <g key={tick}>
                        <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="var(--app-border)" strokeDasharray="4 4" />
                        <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" className="fill-[var(--app-hint)] text-[10px]">{tick}</text>
                    </g>
                ))}
                <path d={area} className="fill-blue-500/10" />
                <path d={path} className="fill-none stroke-blue-500" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
                <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="var(--app-border)" />
                <text x={pad.left} y={height - 10} className="fill-[var(--app-hint)] text-[10px]">{formatShortDateTime(minT)}</text>
                <text x={width - pad.right} y={height - 10} textAnchor="end" className="fill-[var(--app-hint)] text-[10px]">{formatShortDateTime(maxT)}</text>
            </svg>
        </div>
    )
}

function CountBars(props: { title: string; counts: Map<string, number> }) {
    const entries = [...props.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const max = Math.max(1, ...entries.map(([, count]) => count))
    const total = entries.reduce((sum, [, count]) => sum + count, 0)
    return (
        <div className="rounded-xl border border-[var(--app-border)] p-3">
            <div className="mb-3 text-sm font-semibold text-[var(--app-fg)]">{props.title}</div>
            {entries.length === 0 ? <div className="text-sm text-[var(--app-hint)]">No data yet.</div> : null}
            <div className="space-y-2">
                {entries.map(([label, count]) => (
                    <div key={label}>
                        <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                            <span className="truncate text-[var(--app-fg)]">{label}</span>
                            <span className="shrink-0 tabular-nums text-[var(--app-hint)]">{count} · {Math.round((count / Math.max(1, total)) * 100)}%</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                            <div className="h-full rounded-full bg-blue-500" style={{ width: `${(count / max) * 100}%` }} />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}


function toDatetimeLocalValue(ms: number): string {
    const date = new Date(ms)
    return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

const SCHEDULE_FLAVOR_BADGES: Record<string, { label: string; colors: string }> = {
    claude: { label: 'Cl', colors: 'bg-[#d97706] text-white' },
    codex: { label: 'Cx', colors: 'bg-[#111827] text-white' },
    cursor: { label: 'Cu', colors: 'bg-[#0f766e] text-white' },
    gemini: { label: 'Gm', colors: 'bg-[#2563eb] text-white' },
    opencode: { label: 'Op', colors: 'bg-[#15803d] text-white' },
}

function ScheduleFlavorBadge(props: { flavor?: string | null }) {
    const badge = SCHEDULE_FLAVOR_BADGES[(props.flavor ?? 'claude').trim().toLowerCase()] ?? SCHEDULE_FLAVOR_BADGES.claude
    return (
        <span className={`inline-flex h-4 w-4 items-center justify-center rounded-sm text-[8px] font-semibold leading-none ${badge.colors}`}>
            {badge.label}
        </span>
    )
}

function getScheduleSessionLabel(session: SessionSummary): string {
    return session.metadata?.name
        ?? session.metadata?.summary?.text
        ?? session.metadata?.path?.split('/').filter(Boolean).at(-1)
        ?? session.id.slice(0, 8)
}

function ScheduledJobCard(props: {
    job: ScheduledMessage
    sessions: SessionSummary[]
    onSave: (id: string, patch: { sourceSessionId?: string; text?: string; dueAt?: number; cloneBeforeSend?: boolean; intervalMs?: number | null; maxOccurrences?: number | null; enabled?: boolean }) => Promise<void>
    onCancel: (id: string) => Promise<void>
}) {
    const [editing, setEditing] = useState(false)
    const [sourceSessionId, setSourceSessionId] = useState(props.job.sourceSessionId)
    const [text, setText] = useState(props.job.text)
    const [dueAt, setDueAt] = useState(toDatetimeLocalValue(props.job.dueAt))
    const [cloneBeforeSend, setCloneBeforeSend] = useState(props.job.cloneBeforeSend)
    const [repeatMinutes, setRepeatMinutes] = useState(props.job.intervalMs ? String(Math.round(props.job.intervalMs / 60_000)) : '')
    const [repeatLimit, setRepeatLimit] = useState(props.job.maxOccurrences ? String(props.job.maxOccurrences) : '10')
    const [repeatForever, setRepeatForever] = useState(props.job.intervalMs ? props.job.maxOccurrences === null : false)
    const [busy, setBusy] = useState(false)
    const currentSession = props.sessions.find(session => session.id === props.job.sourceSessionId)

    useEffect(() => {
        setSourceSessionId(props.job.sourceSessionId)
        setText(props.job.text)
        setDueAt(toDatetimeLocalValue(props.job.dueAt))
        setCloneBeforeSend(props.job.cloneBeforeSend)
        setRepeatMinutes(props.job.intervalMs ? String(Math.round(props.job.intervalMs / 60_000)) : '')
        setRepeatLimit(props.job.maxOccurrences ? String(props.job.maxOccurrences) : '10')
        setRepeatForever(props.job.intervalMs ? props.job.maxOccurrences === null : false)
    }, [props.job.sourceSessionId, props.job.text, props.job.dueAt, props.job.cloneBeforeSend, props.job.intervalMs, props.job.maxOccurrences])

    const save = async () => {
        setBusy(true)
        try {
            const isRepeating = repeatMinutes.trim().length > 0
            await props.onSave(props.job.id, {
                sourceSessionId,
                text: text.trim(),
                dueAt: new Date(dueAt).getTime(),
                cloneBeforeSend,
                intervalMs: isRepeating ? Math.max(1, Number(repeatMinutes)) * 60_000 : null,
                maxOccurrences: isRepeating ? (repeatForever ? null : Math.max(1, Number(repeatLimit) || 10)) : null
            })
            setEditing(false)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className={`rounded-xl border p-3 ${props.job.enabled ? 'border-[var(--app-border)]' : 'border-[var(--app-border)] opacity-65'}`}>
            <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-xs text-[var(--app-hint)]">
                        {props.job.enabled ? 'on' : 'off'} · {new Date(props.job.dueAt).toLocaleString()} · {props.job.status} · {props.job.cloneBeforeSend ? 'clone first' : 'same session'}{props.job.intervalMs ? ` · every ${Math.round(props.job.intervalMs / 60_000)}m · ${props.job.occurrenceCount}/${props.job.maxOccurrences ?? '∞'} sent` : ''}
                    </div>
                    <div className="mt-1 break-words text-sm text-[var(--app-fg)]">{props.job.text}</div>
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-[var(--app-hint)]">
                        {currentSession ? <ScheduleFlavorBadge flavor={currentSession.metadata?.flavor} /> : null}
                        <span>source {currentSession ? getScheduleSessionLabel(currentSession) : props.job.sourceSessionId.slice(0, 8)}{props.job.targetSessionId ? ` → target ${props.job.targetSessionId.slice(0, 8)}` : ''}</span>
                    </div>
                    {props.job.error ? <div className="mt-1 text-xs text-red-500">{props.job.error}</div> : null}
                </div>
                {props.job.status === 'pending' ? (
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            onClick={() => void props.onSave(props.job.id, { enabled: !props.job.enabled })}
                            className={props.job.enabled
                                ? 'rounded-lg bg-[var(--app-link)] px-2 py-1 text-xs font-medium text-white'
                                : 'rounded-lg border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
                            }
                            title={props.job.enabled ? 'Turn job off' : 'Turn job on'}
                        >
                            {props.job.enabled ? 'On' : 'Off'}
                        </button>
                        <button type="button" onClick={() => setEditing(v => !v)} className="rounded-lg px-2 py-1 text-xs text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]">Edit</button>
                        <button type="button" onClick={() => void props.onCancel(props.job.id)} className="rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-500/10">Delete</button>
                    </div>
                ) : null}
            </div>
            {editing ? (
                <div className="space-y-2 border-t border-[var(--app-border)] pt-2">
                    <label className="block">
                        <span className="mb-1 block text-xs font-medium text-[var(--app-hint)]">Attached session</span>
                        <select value={sourceSessionId} onChange={e => setSourceSessionId(e.target.value)} className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm outline-none">
                            {props.sessions.map(session => (
                                <option key={session.id} value={session.id}>
                                    {((session.metadata?.flavor ?? 'claude').trim().toLowerCase() === 'codex' ? 'Cx' : (session.metadata?.flavor ?? 'claude').trim().toLowerCase() === 'claude' ? 'Cl' : (session.metadata?.flavor ?? 'agent').slice(0, 2))} · {getScheduleSessionLabel(session)} · {session.id.slice(0, 8)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <textarea value={text} onChange={e => setText(e.target.value)} rows={3} className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm outline-none" />
                    <input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm outline-none" />
                    <label className="flex items-center gap-2 text-sm text-[var(--app-fg)]">
                        <input type="checkbox" checked={cloneBeforeSend} onChange={e => setCloneBeforeSend(e.target.checked)} className="accent-[var(--app-link)]" />
                        Clone before send
                    </label>
                    <input type="number" min="1" value={repeatMinutes} onChange={e => setRepeatMinutes(e.target.value)} placeholder="Repeat every minutes (blank = one-shot)" className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm outline-none" />
                    {repeatMinutes.trim() ? (
                        <div className="flex items-center gap-2">
                            <input
                                type="number"
                                min="1"
                                value={repeatLimit}
                                disabled={repeatForever}
                                onChange={e => setRepeatLimit(e.target.value)}
                                placeholder="Stop after this many sends (10)"
                                className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm outline-none disabled:opacity-50"
                            />
                            <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--app-fg)]">
                                <input type="checkbox" checked={repeatForever} onChange={e => setRepeatForever(e.target.checked)} className="accent-[var(--app-link)]" />
                                Forever
                            </label>
                        </div>
                    ) : null}
                    <button type="button" disabled={busy || !text.trim()} onClick={() => void save()} className="rounded-lg bg-[var(--app-link)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Save</button>
                </div>
            ) : null}
            <div className="mt-3 border-t border-[var(--app-border)] pt-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">History</div>
                {props.job.history.length === 0 ? (
                    <div className="text-xs text-[var(--app-hint)]">No history yet.</div>
                ) : (
                    <div className="space-y-1.5">
                        {props.job.history.slice(0, 8).map(item => (
                            <div key={item.id} className="rounded-lg bg-[var(--app-subtle-bg)] px-2 py-1.5">
                                <div className="flex items-center justify-between gap-2 text-[11px]">
                                    <span className="font-medium text-[var(--app-fg)]">{item.event}</span>
                                    <span className="shrink-0 text-[var(--app-hint)]">{new Date(item.createdAt).toLocaleString()}</span>
                                </div>
                                <div className="mt-0.5 line-clamp-2 text-xs text-[var(--app-hint)]">
                                    due {new Date(item.dueAt).toLocaleString()} · {item.enabled ? 'on' : 'off'} · {item.status}{item.intervalMs ? ` · every ${Math.round(item.intervalMs / 60_000)}m · ${item.occurrenceCount}/${item.maxOccurrences ?? '∞'} sent` : ''} · source {item.sourceSessionId.slice(0, 8)}{item.targetSessionId ? ` · target ${item.targetSessionId.slice(0, 8)}` : ''}
                                </div>
                                {item.error ? <div className="mt-0.5 text-xs text-red-500">{item.error}</div> : null}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

function ScheduledJobsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { sessions } = useSessions(api)
    const [status, setStatus] = useState<'pending' | 'sent' | 'failed' | 'cancelled' | 'all'>('pending')
    const [jobs, setJobs] = useState<ScheduledMessage[]>([])
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const load = useCallback(async () => {
        if (!api) return
        setLoading(true)
        setError(null)
        try {
            const result = await api.getAllScheduledMessages(status)
            setJobs(result.scheduledMessages)
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Failed to load scheduled jobs')
        } finally {
            setLoading(false)
        }
    }, [api, status])

    useEffect(() => { void load() }, [load])

    const save = async (id: string, patch: { sourceSessionId?: string; text?: string; dueAt?: number; cloneBeforeSend?: boolean; intervalMs?: number | null; maxOccurrences?: number | null; enabled?: boolean }) => {
        if (!api) return
        const result = await api.updateScheduledMessage(id, patch)
        setJobs(prev => prev.map(job => job.id === id ? result.scheduledMessage : job))
    }
    const cancel = async (id: string) => {
        if (!api) return
        await api.cancelScheduledMessage(id)
        await load()
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <button type="button" onClick={goBack} className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"><BackIcon /></button>
                <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[var(--app-fg)]">Scheduled jobs</div>
                    <div className="text-xs text-[var(--app-hint)]">Track, edit, and delete scheduled HAPI messages.</div>
                </div>
                <select value={status} onChange={e => setStatus(e.target.value as typeof status)} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs">
                    <option value="pending">Pending</option>
                    <option value="all">All</option>
                    <option value="sent">Sent</option>
                    <option value="failed">Failed</option>
                    <option value="cancelled">Cancelled</option>
                </select>
            </div>
            <div className="app-scroll-y flex-1 min-h-0 p-4">
                <div className="mx-auto max-w-4xl space-y-3">
                    {error ? <div className="rounded-lg bg-red-500/10 p-2 text-sm text-red-600">{error}</div> : null}
                    {loading ? <LoadingState label="Loading scheduled jobs…" className="text-sm" /> : null}
                    {!loading && jobs.length === 0 ? <div className="rounded-xl border border-[var(--app-border)] p-6 text-sm text-[var(--app-hint)]">No scheduled jobs.</div> : null}
                    {jobs.map(job => <ScheduledJobCard key={job.id} job={job} sessions={sessions} onSave={save} onCancel={cancel} />)}
                </div>
            </div>
        </div>
    )
}

function DashboardPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { sessions, isLoading, error } = useSessions(api)
    const stats = useMemo(() => getDashboardStats(sessions), [sessions])
    const { skills: skillUsage } = useSkillUsage(api)
    const skillUsageCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const skill of skillUsage) {
            counts.set(skill.skillName, skill.count)
        }
        return counts
    }, [skillUsage])

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <button
                    type="button"
                    onClick={goBack}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                >
                    <BackIcon />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[var(--app-fg)]">Dashboard</div>
                    <div className="text-xs text-[var(--app-hint)]">Agent parallelism and usage mix.</div>
                </div>
            </div>
            <div className="app-scroll-y flex-1 min-h-0 p-4">
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
                    {error ? <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600">{error}</div> : null}
                    {isLoading ? <LoadingState label="Loading dashboard…" className="text-sm" /> : null}

                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-xl border border-[var(--app-border)] p-3">
                            <div className="text-xs text-[var(--app-hint)]">Running now</div>
                            <div className="mt-1 text-2xl font-semibold text-[var(--app-fg)]">{stats.activeNow}</div>
                        </div>
                        <div className="rounded-xl border border-[var(--app-border)] p-3">
                            <div className="text-xs text-[var(--app-hint)]">Peak parallel agents</div>
                            <div className="mt-1 text-2xl font-semibold text-[var(--app-fg)]">{stats.maxConcurrent}</div>
                        </div>
                        <div className="rounded-xl border border-[var(--app-border)] p-3">
                            <div className="text-xs text-[var(--app-hint)]">Sessions counted</div>
                            <div className="mt-1 text-2xl font-semibold text-[var(--app-fg)]">{sessions.length}</div>
                        </div>
                    </div>

                    <section className="rounded-2xl border border-[var(--app-border)] p-4">
                        <div className="mb-3">
                            <h2 className="text-base font-semibold text-[var(--app-fg)]">Parallel agents over time</h2>
                            <p className="text-sm text-[var(--app-hint)]">Counts a session from start/active time until it finishes; active sessions end at now.</p>
                        </div>
                        <ConcurrencyChart series={stats.series} />
                    </section>

                    <section className="rounded-2xl border border-[var(--app-border)] p-4">
                        <div className="mb-3">
                            <h2 className="text-base font-semibold text-[var(--app-fg)]">Agent usage mix</h2>
                            <p className="text-sm text-[var(--app-hint)]">Distribution by agent type and reasoning/model effort.</p>
                        </div>
                        <div className="grid gap-3 lg:grid-cols-4">
                            <CountBars title="Agent type" counts={stats.flavorCounts} />
                            <CountBars title="Model" counts={stats.modelCounts} />
                            <CountBars title="Reasoning" counts={stats.reasoningCounts} />
                            <CountBars title="Model × reasoning" counts={stats.comboCounts} />
                        </div>
                    </section>

                    <section className="rounded-2xl border border-[var(--app-border)] p-4">
                        <div className="mb-3">
                            <h2 className="text-base font-semibold text-[var(--app-fg)]">Skill usage</h2>
                            <p className="text-sm text-[var(--app-hint)]">How often each skill/slash command gets invoked, by you or the agent, tracked from now on.</p>
                        </div>
                        <div className="grid gap-3 lg:grid-cols-2">
                            <CountBars title="Skills" counts={skillUsageCounts} />
                        </div>
                    </section>
                </div>
            </div>
        </div>
    )
}

function SessionsIndexPage() {
    return null
}

function SessionPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const {
        session,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        messages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
        pendingCount,
        messagesVersion,
        flushPending,
        setAtBottom,
    } = useMessages(api, sessionId)
    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId, {
        isSessionThinking: session?.thinking ?? false,
        onSuccess: (sentSessionId) => {
            clearDraftsAfterSend(sentSessionId, sessionId)
        },
        resolveSessionId: async (currentSessionId) => {
            if (!api || !session || session.active) {
                return currentSessionId
            }
            try {
                return await api.resumeSession(currentSessionId, { permissionMode: session.permissionMode ?? undefined })
            } catch (error) {
                const message = error instanceof Error ? error.message : t('dialog.error.default')
                addToast({
                    title: t('resume.failed.title'),
                    body: message,
                    sessionId: currentSessionId,
                    url: ''
                })
                throw error
            }
        },
        onSessionResolved: (resolvedSessionId) => {
            void (async () => {
                if (api) {
                    if (session && resolvedSessionId !== session.id) {
                        seedMessageWindowFromSession(session.id, resolvedSessionId)
                        queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
                            session: { ...session, id: resolvedSessionId, active: true }
                        })
                    }
                    try {
                        await Promise.all([
                            queryClient.prefetchQuery({
                                queryKey: queryKeys.session(resolvedSessionId),
                                queryFn: () => api.getSession(resolvedSessionId),
                            }),
                            fetchLatestMessages(api, resolvedSessionId),
                        ])
                    } catch {
                    }
                }
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: resolvedSessionId },
                    replace: true
                })
            })()
        },
        onBlocked: (reason) => {
            if (reason === 'no-api') {
                addToast({
                    title: t('send.blocked.title'),
                    body: t('send.blocked.noConnection'),
                    sessionId: sessionId ?? '',
                    url: ''
                })
            }
            // 'no-session' and 'pending' don't need toast - either invalid state or expected behavior
        }
    })

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        commands: slashCommands,
        getSuggestions: getSlashSuggestions,
    } = useSlashCommands(api, sessionId, agentType)
    const {
        getSuggestions: getSkillSuggestions,
    } = useSkills(api, sessionId)

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [getSkillSuggestions, getSlashSuggestions])

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    if (!session) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    return (
        <SessionChat
            api={api}
            session={session}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            isLoadingMessages={messagesLoading}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            pendingCount={pendingCount}
            messagesVersion={messagesVersion}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onSend={sendMessage}
            onFlushPending={flushPending}
            onAtBottomChange={setAtBottom}
            onRetryMessage={retryMessage}
            autocompleteSuggestions={getAutocompleteSuggestions}
            availableSlashCommands={slashCommands}
            onCloned={(newSessionId) => navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: newSessionId },
            })}
        />
    )
}

function SessionDetailRoute() {
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const basePath = `/sessions/${sessionId}`
    const isChat = pathname === basePath || pathname === `${basePath}/`

    return isChat ? <SessionPage /> : <Outlet />
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()
    const { directory: initialDirectory, machineId: initialMachineId } = newSessionRoute.useSearch()

    const handleCancel = useCallback(() => {
        navigate({ to: '/sessions' })
    }, [navigate])

    const handleSuccess = useCallback((sessionId: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({ to: '/sessions', replace: true })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
            })
        })
    }, [navigate, queryClient])

    const handleChooseFolder = useCallback((args: { machineId: string | null; directory: string }) => {
        // Forward the currently-selected machine so /browse opens scoped to
        // it rather than falling back to `hapi:lastMachineId`, which can
        // disagree if the user changed machines without yet creating a
        // session.
        navigate({
            to: '/browse',
            search: args.machineId ? { machineId: args.machineId } : {}
        })
    }, [navigate])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">{t('newSession.title')}</div>
            </div>

            <div
                className="app-scroll-y flex-1 min-h-0"
                style={{ paddingBottom: 'calc(var(--app-floating-bottom-offset, 0px) + env(safe-area-inset-bottom))' }}
            >
                {machinesError ? (
                    <div className="p-3 text-sm text-red-600">
                        {machinesError}
                    </div>
                ) : null}

                <NewSession
                    api={api}
                    machines={machines}
                    isLoading={machinesLoading}
                    onCancel={handleCancel}
                    onSuccess={handleSuccess}
                    onChooseFolder={handleChooseFolder}
                    initialDirectory={initialDirectory}
                    initialMachineId={initialMachineId}
                />
            </div>
        </div>
    )
}

function BrowsePage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { t } = useTranslation()
    const { machineId: initialMachineId } = browseRoute.useSearch()

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        navigate({
            to: '/sessions/new',
            search: { directory, machineId }
        })
    }, [navigate])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">{t('browse.title')}</div>
            </div>

            <div className="flex-1 min-h-0">
                <WorkspaceBrowser
                    api={api}
                    machines={machines}
                    machinesLoading={machinesLoading}
                    onStartSession={handleStartSession}
                    initialMachineId={initialMachineId}
                />
            </div>
        </div>
    )
}

const rootRoute = createRootRoute({
    component: App,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Navigate to="/sessions" replace />,
})

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions',
    component: SessionsPage,
})

const sessionsIndexRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '/',
    component: SessionsIndexPage,
})

const sessionDetailRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '$sessionId',
    component: SessionDetailRoute,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories' } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        return tab ? { tab } : {}
    },
    component: FilesPage,
})

const sessionTerminalRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'terminal',
    component: TerminalPage,
})

type SessionFileSearch = {
    path: string
    staged?: boolean
    tab?: 'changes' | 'directories'
}

const sessionFileRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'file',
    validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
        const path = typeof search.path === 'string' ? search.path : ''
        const staged = search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined

        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        const result: SessionFileSearch = { path }
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        return result
    },
    component: FilePage,
})

type NewSessionSearch = {
    directory?: string
    machineId?: string
}

const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    validateSearch: (search: Record<string, unknown>): NewSessionSearch => {
        const result: NewSessionSearch = {}
        if (typeof search.directory === 'string' && search.directory) {
            result.directory = search.directory
        }
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        return result
    },
    component: NewSessionPage,
})

const browseRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/browse',
    validateSearch: (search: Record<string, unknown>): { machineId?: string } => {
        if (typeof search.machineId === 'string' && search.machineId) {
            return { machineId: search.machineId }
        }
        return {}
    },
    component: BrowsePage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsPage,
})

const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: DashboardPage,
})

const scheduledJobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled-jobs',
    component: ScheduledJobsPage,
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute.addChildren([
        sessionsIndexRoute,
        newSessionRoute,
        sessionDetailRoute.addChildren([
            sessionTerminalRoute,
            sessionFilesRoute,
            sessionFileRoute,
        ]),
    ]),
    browseRoute,
    dashboardRoute,
    scheduledJobsRoute,
    settingsRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: false,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
