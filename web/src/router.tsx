import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    useSearch,
} from '@tanstack/react-router'
import { getScrollRestorationKey } from '@/lib/scrollRestorationKey'
import {
    getSessionListSelectionNavigation,
    PRESERVE_SESSION_SIDEBAR_SCROLL,
} from '@/lib/sessionNavigation'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { CodexSessionSyncDialog } from '@/components/CodexSessionSyncDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { NewSession } from '@/components/NewSession'
import { WorkspaceBrowser } from '@/components/WorkspaceBrowser'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { useSession } from '@/hooks/queries/useSession'
import { useCursorChatStoreStatus } from '@/hooks/queries/useCursorChatStoreStatus'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { useSkillUsage } from '@/hooks/queries/useSkillUsage'
import { getSessionTitle } from '@/lib/sessionTitle'
import { buildSessionReferenceText, matchSessionsForMention } from '@/lib/sessionReference'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { useSendMessage, type SendErrorInfo } from '@/hooks/mutations/useSendMessage'
import type { ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { ApiError } from '@/api/client'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { seedMessageWindowFromSession, syncTailMessages } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { AGENT_DONE_RING_OPTIONS, type AgentDoneRing } from '@/lib/agentDoneSound'
import type { ApiClient } from '@/api/client'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { getDraftAttachments } from '@/lib/composer-attachment-drafts'
import { refreshSessionDetailPreservingActive } from '@/lib/session-detail-optimistic'
import { inactiveSessionCanResume, resolveCursorReopenGate } from '@/lib/sessionResume'
import { initializeSessionLastSeen, markSessionSeen } from '@/lib/sessionLastSeen'
import { useSessionBrowserTitle } from '@/hooks/useSessionBrowserTitle'
import { clearCodexImportedSession, markCodexSessionsImported } from '@/lib/codexImportedSessions'
import { getSupersedingSessionId, prepareFollowSupersedingSession, shouldFollowSupersedingSession } from '@/routes/sessions/followSupersedingSession'
import { migrateSuppressedSendError } from '@/lib/suppressed-send-error'
import type { Machine, ScheduledMessage, SessionSummary, CodexDuplicateSessionGroup, CodexLocalSessionSummary } from '@/types/api'
import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'
import TerminalPage from '@/routes/sessions/terminal'
import SettingsLayout from '@/routes/settings/layout'
import SettingsHubPage from '@/routes/settings'
import SettingsGeneralPage from '@/routes/settings/general'
import SettingsDisplayPage from '@/routes/settings/display'
import SettingsChatPage from '@/routes/settings/chat'
import SettingsVoicePage from '@/routes/settings/voice'
import SettingsVoiceVoicesPage from '@/routes/settings/voice-voices'
import SettingsVoiceAdvancedPage from '@/routes/settings/voice-advanced'
import SettingsMachinesPage from '@/routes/settings/machines'
import SettingsAboutPage from '@/routes/settings/about'
import SettingsStoragePage from '@/routes/settings/storage'
import SettingsUsagePage from '@/routes/settings/usage'
import SharePage from '@/routes/share'
import { retargetSharePendingTransfer, setSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer, parseShareSearch } from '@/lib/shareTransfer'


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

function CodexImportIcon(props: { className?: string }) {
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
            {/* 中文注释：入口图标改成纯更新箭头，弱化“聊天”含义，避免用户误解成会话本身而不是导入动作。 */}
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </svg>
    )
}

function RefreshIcon(props: { className?: string }) {
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
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
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

function MoreIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className={props.className}>
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
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
        clearUnreadDone,
        baseUrl,
        titleSuggestionAvailable = false
    } = useAppContext()
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { addToast } = useToast()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const [initializedHub, setInitializedHub] = useState<string | null>(null)
    const { machines } = useMachines(api, true)
    const [isSyncingCodexSession, setIsSyncingCodexSession] = useState(false)
    const [codexSessions, setCodexSessions] = useState<CodexLocalSessionSummary[]>([])
    const [codexImportMachineId, setCodexImportMachineId] = useState<string | null>(null)
    const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
    const moreButtonRef = useRef<HTMLButtonElement | null>(null)
    const [isLoadingCodexSessions, setIsLoadingCodexSessions] = useState(false)
    const [isSyncConfirmOpen, setIsSyncConfirmOpen] = useState(false)
    const [isRestartingCodexDesktop, setIsRestartingCodexDesktop] = useState(false)
    const [pendingDuplicateSessionIds, setPendingDuplicateSessionIds] = useState<string[]>([])
    const [duplicateSessionGroups, setDuplicateSessionGroups] = useState<CodexDuplicateSessionGroup[]>([])
    const [isDuplicateMergeConfirmOpen, setIsDuplicateMergeConfirmOpen] = useState(false)
    const [isMergingDuplicateSessions, setIsMergingDuplicateSessions] = useState(false)
    const [codexImportWorkDirectoryOverride, setCodexImportWorkDirectoryOverride] = useState<string | null>(null)

    const handleRefresh = useCallback(() => {
        return (async () => {
            try {
                await refetch()
            } catch (error) {
                addToast({
                    title: t('sessions.refresh.failed.title'),
                    body: error instanceof Error ? error.message : t('dialog.error.default'),
                    sessionId: '',
                    url: ''
                })
            }
        })()
    }, [addToast, refetch, t])

    const projectCount = useMemo(() => new Set(sessions.map(s =>
        s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other'
    )).size, [sessions])
    const machineLabelsById = useMachineLabels(machines)
    const machinesById = useMemo(() => {
        const byId: Record<string, typeof machines[number]> = {}
        for (const machine of machines) {
            byId[machine.id] = machine
        }
        return byId
    }, [machines])
    // Workspace browsing is opt-in per runner (`--workspace-root`); only show
    // browse affordances when at least one machine reported roots.
    const canBrowse = useMemo(
        () => machines.some(m => (m.metadata?.workspaceRoots?.length ?? 0) > 0),
        [machines]
    )
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const selectedSession = useMemo(
        () => selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) ?? null : null,
        [selectedSessionId, sessions]
    )
    useEffect(() => {
        if (isLoading || error) {
            return
        }
        initializeSessionLastSeen(baseUrl, sessions)
        setInitializedHub(baseUrl)
    }, [baseUrl, error, isLoading, sessions])
    useEffect(() => {
        if (!selectedSessionId || !selectedSession) {
            return
        }
        markSessionSeen(selectedSessionId, selectedSession.updatedAt)
    }, [selectedSessionId, selectedSession?.updatedAt])
    const currentWorkDirectory = codexImportWorkDirectoryOverride
        ?? selectedSession?.metadata?.worktree?.basePath
        ?? selectedSession?.metadata?.path
        ?? null
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const sidebar = useSidebarResize()
    const handleNewSessionInDirectory = useCallback((args: { machineId: string | null; directory: string }) => {
        navigate({
            to: '/sessions/new',
            search: args.machineId
                ? { directory: args.directory, machineId: args.machineId }
                : { directory: args.directory },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate])

    const isCodexScriptTimeout = useCallback((message: string | null | undefined): boolean => {
        const raw = (message ?? '').trim()
        return /执行超时|timed\s*out|timeout/i.test(raw)
    }, [])

    const normalizeCodexScriptError = useCallback((message: string | null | undefined, fallback: string): string => {
        const raw = (message ?? '').trim()
        if (!raw) return fallback
        if (isCodexScriptTimeout(raw)) {
            return t('codexSync.error.timeout')
        }
        if (/当前会话仍处于活跃状态，请等待会话结束后重试|Active Hapi process already has this Codex thread/i.test(raw)) {
            return t('codexSync.error.active')
        }
        if (/未安装\/找不到codex客户端|unable to find codex launcher|找不到.*codex/i.test(raw)) {
            return t('codexSync.restart.failed.notFound')
        }
        return raw
    }, [isCodexScriptTimeout, t])

    const formatCodexSyncFailureBody = useCallback((reason: string): string => {
        if (
            reason === t('codexSync.error.timeout') ||
            reason === t('codexSync.error.active') ||
            reason === t('codexSync.restart.failed.notFound')
        ) {
            return reason
        }
        return t('codexSync.failed.bodyWithReason', { reason })
    }, [t])

    const closeDuplicateMergeDialog = useCallback(() => {
        // 中文注释：重复会话确认框关闭时一并清空“本次选中导入”的上下文，确保后续检测不会误用上一轮的 codexSessionId。
        setIsDuplicateMergeConfirmOpen(false)
        setPendingDuplicateSessionIds([])
        setDuplicateSessionGroups([])
    }, [])

    const handleRestartCodexDesktop = useCallback(async () => {
        setIsRestartingCodexDesktop(true)
        try {
            const status = await api.getCodexDesktopStatus()
            if (!status.codexClientAvailable) {
                throw new Error(t('codexSync.restart.failed.notFound'))
            }

            const result = await api.restartCodexDesktop()
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.restart.failed.body')))
            }
            addToast({
                title: t('codexSync.restart.started.title'),
                body: t('codexSync.restart.started.body'),
                sessionId: '',
                url: ''
            })
        } catch (error) {
            addToast({
                title: t('codexSync.restart.failed.title'),
                body: normalizeCodexScriptError(
                    error instanceof Error ? error.message : null,
                    t('codexSync.restart.failed.body')
                ),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsRestartingCodexDesktop(false)
        }
    }, [addToast, api, normalizeCodexScriptError, t])

    const handleMergeDuplicateSessions = useCallback(async () => {
        if (isMergingDuplicateSessions || pendingDuplicateSessionIds.length === 0) return

        setIsMergingDuplicateSessions(true)
        try {
            const result = await api.mergeCodexDuplicateSessions({ sessionIds: pendingDuplicateSessionIds })
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.duplicates.merge.failed.body')))
            }

            addToast({
                title: t('codexSync.duplicates.merge.success.title'),
                body: t('codexSync.duplicates.merge.success.body'),
                sessionId: '',
                url: ''
            })

            const redirectTarget = selectedSessionId
                ? result.merged.find((group) => group.removedSessionIds?.includes(selectedSessionId))
                : undefined

            closeDuplicateMergeDialog()
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
                selectedSessionId
                    ? queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) })
                    : Promise.resolve(),
                selectedSessionId
                    ? queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedSessionId) })
                    : Promise.resolve()
            ])
            await refetch()

            if (redirectTarget?.canonicalSessionId) {
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: redirectTarget.canonicalSessionId }
                })
            }
        } catch (error) {
            addToast({
                title: t('codexSync.duplicates.merge.failed.title'),
                body: normalizeCodexScriptError(
                    error instanceof Error ? error.message : null,
                    t('codexSync.duplicates.merge.failed.body')
                ),
                sessionId: '',
                url: ''
            })
            throw error
        } finally {
            setIsMergingDuplicateSessions(false)
        }
    }, [
        addToast,
        api,
        closeDuplicateMergeDialog,
        isMergingDuplicateSessions,
        navigate,
        normalizeCodexScriptError,
        pendingDuplicateSessionIds,
        queryClient,
        refetch,
        selectedSessionId,
        t
    ])

    const openCodexImportDialog = useCallback(async (workDirectory?: string | null) => {
        setCodexImportWorkDirectoryOverride(workDirectory?.trim() || null)
        if (isLoadingCodexSessions) return

        setIsSyncConfirmOpen(true)
        setIsLoadingCodexSessions(true)
        try {
            const result = await api.getCodexSessions(workDirectory)
            setCodexSessions(result.sessions)
            setCodexImportMachineId(result.machineId ?? null)
        } catch (error) {
            setCodexSessions([])
            setCodexImportMachineId(null)
            const reason = normalizeCodexScriptError(
                error instanceof Error ? error.message : null,
                t('dialog.error.default')
            )
            addToast({
                title: t('codexSync.failed.title'),
                body: formatCodexSyncFailureBody(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsLoadingCodexSessions(false)
        }
    }, [addToast, api, formatCodexSyncFailureBody, isLoadingCodexSessions, normalizeCodexScriptError, t])

    const handleArchiveCodexSession = useCallback(async (codexSession: import('@/types/api').CodexLocalSessionSummary) => {
        if (!api) return
        const result = await api.archiveCodexSession(codexSession.id, codexImportMachineId)
        if (!result.success) {
            throw new Error(result.error)
        }
        setCodexSessions((current) => current.filter((session) => session.id !== codexSession.id))
    }, [api, codexImportMachineId])

    const handleImportCodexSessions = useCallback(async (sessionIds: string[]) => {
        if (isSyncingCodexSession || isLoadingCodexSessions) return

        setIsSyncingCodexSession(true)
        try {
            // 中文注释：弹窗提交的是本地 Codex thread ID；后端会直接读取这些 transcript 并导入到 Hapi。
            const result = await api.syncCodexSession({ sessionIds, cwd: currentWorkDirectory, machineId: codexImportMachineId })
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.failed.body')))
            }

            addToast({
                title: t('codexSync.success.title'),
                body: t('codexSync.success.body', { n: result.syncedCount ?? sessionIds.length }),
                sessionId: '',
                url: ''
            })
            // 中文注释：导入成功后先在浏览器侧记住这些 Codex thread 的导入时间，供左侧会话列表显示特殊时间文案。
            markCodexSessionsImported(sessionIds)
            setIsSyncConfirmOpen(false)
            await refetch()

            setPendingDuplicateSessionIds([])
            setDuplicateSessionGroups([])
            setIsDuplicateMergeConfirmOpen(false)
            try {
                // 中文注释：重复会话检测严格限定在这次用户勾选导入的 codexSessionId 范围内；未勾选的其它会话不参与检测，也不弹合并提示。
                const duplicateResult = await api.getCodexDuplicateSessions({ sessionIds })
                if (!duplicateResult.success) {
                    throw new Error(normalizeCodexScriptError(
                        duplicateResult.error,
                        t('codexSync.duplicates.detect.failed.body')
                    ))
                }

                if (duplicateResult.duplicates.length > 0) {
                    setPendingDuplicateSessionIds(sessionIds)
                    setDuplicateSessionGroups(duplicateResult.duplicates)
                    setIsDuplicateMergeConfirmOpen(true)
                }
            } catch (duplicateError) {
                addToast({
                    title: t('codexSync.duplicates.detect.failed.title'),
                    body: normalizeCodexScriptError(
                        duplicateError instanceof Error ? duplicateError.message : null,
                        t('codexSync.duplicates.detect.failed.body')
                    ),
                    sessionId: '',
                    url: ''
                })
            }
        } catch (syncError) {
            const reason = normalizeCodexScriptError(
                syncError instanceof Error ? syncError.message : null,
                t('dialog.error.default')
            )
            addToast({
                title: t('codexSync.failed.title'),
                body: formatCodexSyncFailureBody(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsSyncingCodexSession(false)
        }
    }, [
        addToast,
        api,
        formatCodexSyncFailureBody,
        codexImportMachineId,
        currentWorkDirectory,
        isLoadingCodexSessions,
        isSyncingCodexSession,
        normalizeCodexScriptError,
        refetch,
        setDuplicateSessionGroups,
        setIsDuplicateMergeConfirmOpen,
        setPendingDuplicateSessionIds,
        t
    ])

    return (
        <>
            <div className="flex h-full min-h-0">
            <div
                className={`${isSessionsIndex ? 'flex' : 'hidden split:flex'} w-full shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
            >
                <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0 truncate text-xs text-[var(--app-hint)]">
                            {t('sessions.count', { n: sessions.length, m: projectCount })}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            {/* Navigational actions: room for these on tablet/desktop; collapsed
                                into the overflow menu below sm so the session count never has to
                                fight 5+ fixed-width items for space and wrap onto multiple lines. */}
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/dashboard' })}
                                className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title="Open dashboard"
                            >
                                <ChartIcon className="h-4 w-4" />
                                Dashboard
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/scheduled-jobs' })}
                                className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title="Open scheduled jobs"
                            >
                                <CalendarClockIcon className="h-4 w-4" />
                                Jobs
                            </button>
                            <button
                                type="button"
                                onClick={() => void openCodexImportDialog()}
                                disabled={isSyncingCodexSession || isLoadingCodexSessions}
                                aria-label={t('codexSync.tooltip')}
                                aria-busy={isSyncingCodexSession || isLoadingCodexSessions}
                                className="hidden sm:flex p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors disabled:opacity-60 disabled:cursor-wait"
                                title={t('codexSync.tooltip')}
                            >
                                <CodexImportIcon className={`h-5 w-5 ${isLoadingCodexSessions ? 'animate-spin' : ''}`} />
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/browse' })}
                                className="hidden sm:flex p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('browse.nav')}
                            >
                                <FolderOpenIcon className="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/settings' })}
                                className="hidden sm:flex p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('settings.title')}
                            >
                                <SettingsIcon className="h-5 w-5" />
                            </button>

                            {/* Mobile-only overflow trigger for the actions hidden above. */}
                            <button
                                ref={moreButtonRef}
                                type="button"
                                onClick={() => setIsMoreMenuOpen((open) => !open)}
                                aria-haspopup="menu"
                                aria-expanded={isMoreMenuOpen}
                                className="sm:hidden p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title="More"
                            >
                                <MoreIcon className="h-5 w-5" />
                            </button>
                            <HeaderOverflowMenu
                                isOpen={isMoreMenuOpen}
                                onClose={() => setIsMoreMenuOpen(false)}
                                triggerRef={moreButtonRef}
                                items={[
                                    { key: 'dashboard', icon: <ChartIcon className="h-4 w-4" />, label: 'Dashboard', onClick: () => navigate({ to: '/dashboard' }) },
                                    { key: 'jobs', icon: <CalendarClockIcon className="h-4 w-4" />, label: 'Scheduled jobs', onClick: () => navigate({ to: '/scheduled-jobs' }) },
                                    { key: 'codex-sync', icon: <CodexImportIcon className="h-4 w-4" />, label: t('codexSync.tooltip'), onClick: () => void openCodexImportDialog() },
                                    { key: 'browse', icon: <FolderOpenIcon className="h-4 w-4" />, label: t('browse.nav'), onClick: () => navigate({ to: '/browse' }) },
                                    { key: 'settings', icon: <SettingsIcon className="h-4 w-4" />, label: t('settings.title'), onClick: () => navigate({ to: '/settings' }) }
                                ]}
                            />

                            {/* Always-visible actions: frequent, non-navigational (or the primary CTA). */}
                            <button
                                type="button"
                                onClick={handleRefresh}
                                disabled={isLoading}
                                aria-label={t('button.refresh')}
                                aria-busy={isLoading}
                                className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors disabled:opacity-60 disabled:cursor-wait"
                                title={t('button.refresh')}
                            >
                                <RefreshIcon className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />
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
                        key={initializedHub === baseUrl ? 'last-seen-ready' : 'last-seen-pending'}
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={(sessionId) => {
                            clearUnreadDone(sessionId)
                            navigate(getSessionListSelectionNavigation(sessionId))
                        }}
                        onNewSession={() => navigate({
                            to: '/sessions/new',
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        })}
                        onNewSessionInDirectory={handleNewSessionInDirectory}
                        onBrowse={canBrowse ? () => navigate({ to: '/browse' }) : undefined}
                        onRefresh={handleRefresh}
                        isLoading={isLoading}
                        renderHeader={false}
                        headerActions={(
                            <div className="flex items-center gap-2">
                                {canBrowse && (
                                    <button
                                        type="button"
                                        onClick={() => navigate({ to: '/browse' })}
                                        className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                        title={t('browse.nav')}
                                    >
                                        <FolderOpenIcon className="h-5 w-5" />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => navigate({ to: '/settings' })}
                                    className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                    title={t('settings.title')}
                                >
                                    <SettingsIcon className="h-5 w-5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => navigate({
                                        to: '/sessions/new',
                                        ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                                    })}
                                    className="session-list-new-button flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-link)] transition-colors"
                                    title={t('sessions.new')}
                                >
                                    <PlusIcon className="h-5 w-5" />
                                </button>
                            </div>
                        )}
                        api={api}
                        titleSuggestionAvailable={titleSuggestionAvailable}
                        machineLabelsById={machineLabelsById}
                        unreadDoneOrders={unreadDoneOrders}
                        onCloned={(newSessionId) => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: newSessionId },
                        })}
                        machinesById={machinesById}
                    />
                </div>
            </div>

            {/* Resize handle - desktop only */}
            <div
                className="sidebar-resize-handle hidden split:block shrink-0"
                data-dragging={sidebar.isDragging || undefined}
                onPointerDown={sidebar.onPointerDown}
            />

            <div className={`${isSessionsIndex ? 'hidden split:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
            </div>
        </>
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

/**
 * Classify a thrown send error into a {message, code} pair the composer can
 * render.  `code` lets the consumer attach a recovery affordance (Reopen on
 * `session_inactive`) without re-inspecting the raw error.
 *
 * `request<T>` in the api client throws `ApiError` for !res.ok with `status`
 * and `code` parsed from the JSON body.  Older / non-JSON failures arrive as
 * plain `Error`; we surface those by their message verbatim, falling back to
 * a localized default when nothing usable is present (e.g. an aborted fetch
 * that resolved with no message).
 */
function classifySendError(
    error: unknown,
    t: (key: string) => string,
): { message: string; code: string | null } {
    if (error instanceof ApiError && error.status === 409 && error.code === 'session_inactive') {
        return { message: t('chat.sendError.sessionInactive'), code: 'session_inactive' }
    }
    if (error instanceof Error && error.message) {
        return { message: error.message, code: null }
    }
    return { message: t('chat.sendError.fallback'), code: null }
}

function SessionPage() {
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const { outline } = useSearch({ from: '/sessions/$sessionId' })
    const {
        session,
        error: sessionError,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        status: cursorChatStoreStatus,
        isApplicable: cursorChatStoreApplicable,
        error: cursorChatStoreError,
        isLoading: cursorChatStoreLoading,
    } = useCursorChatStoreStatus({ api, session })
    const {
        messages,
        warning: messagesWarning,
        isSyncingTail: messagesSyncingTail,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        cancelLoadMore: cancelLoadMoreMessages,
        refetch: refetchMessages,
        viewMode: messagesViewMode,
        messagesVersion,
        historyVersion,
        tailRevision,
        setViewMode,
    } = useMessages(api, sessionId)

    // Tracks the most recent send the hub rejected (4xx/5xx/network), keyed
    // by the session the failed POST actually targeted (post-resolveSessionId).
    // assistant-ui clears the composer eagerly when a send is invoked, so to
    // retain the typed text on error we keep it here and hand it back to the
    // composer for restore + visual error affordance.  Keying by sessionId
    // covers the inactive-session resume race: useSendMessage can resolve
    // the target id, kick off async navigation to it, and then have the POST
    // fail before navigation completes.  Without keying, we'd restore the
    // text into the OLD session's composer and the next render would clear
    // it.  The bumped `id` still lets the composer dedupe restorations of
    // identical text.
    //
    // We persist the classifier `code` (not the bound action) so the
    // composer-visible action stays reactive to `reopeningSessionId` state
    // changes -- the action is built fresh on each render from {raw error
    // record} x {current reopen state}.  See classifySendError + the
    // Reopen affordance below.
    type RawSendError = {
        id: number
        text: string
        message: string
        code: string | null
        scheduledAt: number | null
        deliveryMode: MessageDeliveryMode
        mutationStarted: boolean
        restoreSuppressed: boolean
    }
    const [sendErrors, setSendErrors] = useState<Record<string, RawSendError>>({})
    const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null)
    const sendErrorIdRef = useRef(0)
    const clearSendError = useCallback(() => {
        setSendErrors((prev) => {
            if (!(sessionId in prev)) return prev
            const next = { ...prev }
            delete next[sessionId]
            return next
        })
    }, [sessionId])

    const suppressSendErrorRestore = useCallback((id: number) => {
        setSendErrors((prev) => {
            const current = prev[sessionId]
            if (!current || current.id !== id || current.restoreSuppressed) return prev
            return {
                ...prev,
                [sessionId]: { ...current, restoreSuppressed: true }
            }
        })
    }, [sessionId])

    // Reopen recovery (#918): one-click affordance attached to the inline
    // composer error when the rejected send was inactive-session.  Mirrors
    // SessionList's Reopen UX -- POST /sessions/:id/reopen via
    // api.reopenSession -- so the operator's mental model is consistent
    // across surfaces.  We do NOT auto-replay the send: per #917 the reopen
    // path has known fragility, so the operator re-clicks Send on the
    // restored composer text once Reopen lands.
    const reopenFromErrorAffordance = useCallback((errorSessionId: string) => {
        if (!api) return
        setReopeningSessionId((prev) => prev ?? errorSessionId)
        void (async () => {
            try {
                const result = await api.reopenSession(errorSessionId)
                // Clear the inline error -- the operator now has a live
                // session to retry against.
                setSendErrors((prev) => {
                    if (!(errorSessionId in prev)) return prev
                    const next = { ...prev }
                    delete next[errorSessionId]
                    return next
                })
                await queryClient.invalidateQueries({ queryKey: queryKeys.session(result.sessionId) })
                await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                if (result.sessionId && result.sessionId !== errorSessionId) {
                    retargetSharePendingTransfer(errorSessionId, result.sessionId)
                    await transferComposerDraftThenNavigate(
                        errorSessionId,
                        result.sessionId,
                        () => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: result.sessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : t('dialog.error.default')
                addToast({
                    title: t('resume.failed.title'),
                    body: message,
                    sessionId: errorSessionId,
                    url: ''
                })
            } finally {
                setReopeningSessionId(null)
            }
        })()
    }, [api, queryClient, navigate, addToast, t])

    const cursorReopenGate = resolveCursorReopenGate({
        applicable: cursorChatStoreApplicable,
        onDisk: cursorChatStoreStatus?.onDisk,
        error: cursorChatStoreError,
        isLoading: cursorChatStoreLoading,
    })
    const cursorReopenDisabledReason = cursorReopenGate.disabledReason === 'missing'
        ? t('session.action.reopenCursorMissing')
        : cursorReopenGate.disabledReason === 'checking'
            ? t('session.action.reopenCursorChecking')
            : undefined
    const cursorReopenUnverifiedHint = cursorReopenGate.probeUnverified
        ? t('session.action.reopenCursorUnverified')
        : undefined
    const canOfferInactiveReopen = session
        ? inactiveSessionCanResume(session, messages.length, cursorChatStoreStatus?.onDisk)
        : false
    const rawSendError = sendErrors[sessionId] ?? null
    const sendError: ComposerSendError | null = rawSendError
        ? {
            id: rawSendError.id,
            text: rawSendError.text,
            message: rawSendError.message,
            scheduledAt: rawSendError.scheduledAt,
            deliveryMode: rawSendError.deliveryMode,
            mutationStarted: rawSendError.mutationStarted,
            restoreSuppressed: rawSendError.restoreSuppressed,
            action: rawSendError.code === 'session_inactive' && canOfferInactiveReopen
                ? {
                    label: t('chat.sendError.sessionInactive.action'),
                    onClick: () => reopenFromErrorAffordance(sessionId),
                    pending: reopeningSessionId === sessionId
                }
                : null
        }
        : null

    const resolvedSessionRef = useRef<{ source: string; target: Promise<string> } | null>(null)
    // Clear when the session id or active flag changes so a same-id resume
    // that later archives again cannot reuse a stale in-flight/cached resume.
    useEffect(() => {
        resolvedSessionRef.current = null
    }, [session?.id, session?.active])
    const resolveSessionId = useCallback(async (currentSessionId: string) => {
        if (!api || !session || session.active) {
            return { sessionId: currentSessionId, resumed: false }
        }
        const cached = resolvedSessionRef.current
        if (cached?.source === currentSessionId) {
            return { sessionId: await cached.target, resumed: true }
        }
        if (!inactiveSessionCanResume(session, messages.length, cursorChatStoreStatus?.onDisk)) {
            throw new ApiError(
                t('chat.sendError.sessionInactive'),
                409,
                'session_inactive',
            )
        }
        try {
            const target = api.resumeSession(currentSessionId, { permissionMode: session.permissionMode ?? undefined })
            resolvedSessionRef.current = { source: currentSessionId, target }
            return { sessionId: await target, resumed: true }
        } catch (error) {
            if (resolvedSessionRef.current?.source === currentSessionId) {
                resolvedSessionRef.current = null
            }
            const message = error instanceof Error ? error.message : t('dialog.error.default')
            addToast({
                title: t('resume.failed.title'),
                body: message,
                sessionId: currentSessionId,
                url: ''
            })
            throw new ApiError(
                t('chat.sendError.sessionInactive'),
                409,
                'session_inactive',
            )
        }
    }, [api, session, messages.length, cursorChatStoreStatus?.onDisk, t, addToast])

    const handleSessionResolved = useCallback((resolvedSessionId: string) => {
        if (session) {
            if (resolvedSessionId !== session.id) {
                retargetSharePendingTransfer(session.id, resolvedSessionId)
                seedMessageWindowFromSession(session.id, resolvedSessionId)
            }
            queryClient.setQueryData(queryKeys.session(resolvedSessionId), (previous: { session?: typeof session } | undefined) => ({
                session: { ...(previous?.session ?? session), id: resolvedSessionId, active: true }
            }))
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: resolvedSessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
        if (api) {
            void refreshSessionDetailPreservingActive(
                queryClient,
                resolvedSessionId,
                () => api.getSession(resolvedSessionId),
            )
            void syncTailMessages(api, resolvedSessionId).catch(() => {})
        }
    }, [api, navigate, queryClient, session])

    const {
        sendMessage,
        retryMessage,
        isSending,
        sendSettlement,
    } = useSendMessage(api, sessionId, {
        isSessionThinking: session?.thinking ?? false,
        onSuccess: (sentSessionId) => {
            clearDraftsAfterSend(sentSessionId, sessionId)
            // 中文注释：一旦用户已经在 Hapi 内继续这个 Codex 会话，就清除"刚从 Codex 导入"的标记。
            clearCodexImportedSession(session?.metadata?.codexSessionId)
            // A successful send supersedes any previously-rendered error
            // for that session.  Other sessions' errors stay put.
            setSendErrors((prev) => {
                if (!(sentSessionId in prev)) return prev
                const next = { ...prev }
                delete next[sentSessionId]
                return next
            })
        },
        onError: (info: SendErrorInfo) => {
            sendErrorIdRef.current += 1
            const { message, code } = classifySendError(info.error, t)
            setSendErrors((prev) => ({
                ...prev,
                [info.sessionId]: {
                    id: sendErrorIdRef.current,
                    text: info.text,
                    message,
                    code,
                    scheduledAt: info.scheduledAt,
                    deliveryMode: info.deliveryMode,
                    mutationStarted: info.mutationStarted,
                    restoreSuppressed: false,
                }
            }))
        },
        resolveSessionId,
        onSessionResolved: async (resolvedSessionId, context) => {
            if (!sessionId) return undefined
            setSendErrors((prev) => migrateSuppressedSendError(prev, sessionId, resolvedSessionId))
            await transferComposerDraftThenNavigate(
                sessionId,
                resolvedSessionId,
                () => handleSessionResolved(resolvedSessionId),
                [],
                // assistant-ui clears composer text without awaiting this path;
                // keep the submitted snapshot so deferred hydration still has it.
                { textOverride: context.text },
            )
            // Cross-session resume: visible metadata may still carry source-scoped
            // upload paths, and inactive remounts hide stored files entirely.
            // Always defer so the active target can hydrate/re-upload before POST.
            const stored = await getDraftAttachments(resolvedSessionId)
            if ((context.attachments?.length ?? 0) > 0 || stored.length > 0) {
                return { deferUntilDraftHydrated: true }
            }
            return undefined
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
    // Mention pool is stricter than sidebar (#1506): titled sessions only; match via sessionMatchesQuery.
    const { sessions: allSessions } = useSessions(api)
    const { machines: mentionMachines } = useMachines(api, true)
    const mentionMachineLabelsById = useMachineLabels(mentionMachines)
    // Same fallbacks as share picker / SessionList search.
    const resolveMentionMachineLabel = useCallback((machineId: string | null) => {
        if (machineId && mentionMachineLabelsById[machineId]) {
            return mentionMachineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }, [mentionMachineLabelsById, t])

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('@')) {
            const search = query.slice(1)
            // v1: plain-text expansion (same grammar as Copy reference) — #1213.
            // v2: segmented rich composer with inline session tokens — #1215.
            // Match via sessionMatchesQuery (share/sidebar); label/insert via getSessionTitle.
            const sessionHits = matchSessionsForMention(allSessions, search, {
                excludeId: sessionId,
                limit: 20,
                resolveMachineLabel: resolveMentionMachineLabel,
            }).map((s) => {
                const title = getSessionTitle(s)
                const mentionText = buildSessionReferenceText(title, s.id)
                const idPrefix = s.id.slice(0, 8)
                return {
                    key: `session:${s.id}`,
                    text: mentionText,
                    label: `@${title || idPrefix}`,
                    description: s.active
                        ? `Session · ${idPrefix} · active`
                        : `Session · ${idPrefix}`,
                    // Rich composer atom; textarea path still inserts `text` prose.
                    sessionMention: { id: s.id, title: title || idPrefix },
                }
            })

            const fileHits: Suggestion[] = []
            if ((agentType === 'codex' || agentType === 'copilot') && api && sessionId) {
                const response = await api.searchSessionFiles(sessionId, search, 50)
                if (response.success && response.files) {
                    for (const file of response.files) {
                        // Codex App Server expects @"path"; Copilot CLI uses @path (relative preferred).
                        const mentionText = agentType === 'copilot'
                            ? `@${file.fullPath}`
                            : `@"${file.fullPath.replace(/(["\\])/g, '\\$1')}"`
                        fileHits.push({
                            key: mentionText,
                            text: mentionText,
                            label: `@${file.fileName}`,
                            description: file.filePath || file.fullPath,
                        })
                    }
                }
            }

            return [...sessionHits, ...fileHits]
        }
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [
        agentType,
        api,
        sessionId,
        allSessions,
        resolveMentionMachineLabel,
        getSkillSuggestions,
        getSlashSuggestions,
    ])

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    const handleInitialOutlineConsumed = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    if (!session) {
        if (sessionError) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                    <div className="text-sm font-medium text-[var(--app-fg)]">Session unavailable</div>
                    <div className="max-w-md text-xs text-[var(--app-hint)]">{sessionError}</div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions', replace: true })}
                            className="rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                        >
                            Back to sessions
                        </button>
                        <button
                            type="button"
                            onClick={() => { void refetchSession() }}
                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-sm text-[var(--app-button-text)]"
                        >
                            Retry
                        </button>
                    </div>
                </div>
            )
        }
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    return (
        <SessionChat
            api={api}
            titleSuggestionAvailable={titleSuggestionAvailable}
            session={session}
            cursorChatOnDisk={cursorChatStoreStatus?.onDisk}
            reopenDisabledReason={cursorReopenDisabledReason}
            reopenHint={cursorReopenUnverifiedHint}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            isSyncingTail={messagesSyncingTail}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            sendSettlement={sendSettlement}
            viewMode={messagesViewMode}
            messagesVersion={messagesVersion}
            historyVersion={historyVersion}
            tailRevision={tailRevision}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onCancelLoadMore={cancelLoadMoreMessages}
            onSend={sendMessage}
            resolveSessionIdForUpload={async (id) => (await resolveSessionId(id)).sessionId}
            onUploadSessionResolved={handleSessionResolved}
            onViewModeChange={setViewMode}
            onRetryMessage={retryMessage}
            autocompleteSuggestions={getAutocompleteSuggestions}
            availableSlashCommands={slashCommands}
            onCloned={(newSessionId) => navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: newSessionId },
            })}
            sendError={sendError}
            onClearSendError={clearSendError}
            onSuppressSendErrorRestore={suppressSendErrorRestore}
            initialOutlineOpen={outline}
            onInitialOutlineConsumed={handleInitialOutlineConsumed}
            onAbortRestore={(text) => {
                sendErrorIdRef.current += 1
                setSendErrors((prev) => ({
                    ...prev,
                    [sessionId]: {
                        id: sendErrorIdRef.current,
                        text,
                        message: t('chat.sendError.aborted'),
                        code: 'abort',
                        scheduledAt: null,
                        deliveryMode: 'queue',
                        mutationStarted: true,
                        restoreSuppressed: false
                    }
                }))
            }}
        />
    )
}

function SessionDetailRoute() {
    const { api } = useAppContext()
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const navigate = useNavigate()
    const { session, notFound: sessionNotFound } = useSession(api, sessionId)
    useSessionBrowserTitle(session)
    const basePath = `/sessions/${sessionId}`
    const isChat = pathname === basePath || pathname === `${basePath}/`
    const supersedingSessionId = getSupersedingSessionId(sessionId, session?.metadata)
    const observedSessionRef = useRef<{
        sessionId: string
        supersedingSessionId: string | null
    } | null>(null)

    useEffect(() => {
        if (!session) {
            return
        }
        const shouldFollow = shouldFollowSupersedingSession(
            observedSessionRef.current,
            sessionId,
            session.metadata
        )
        observedSessionRef.current = { sessionId, supersedingSessionId }
        if (!shouldFollow || !supersedingSessionId) return
        prepareFollowSupersedingSession(sessionId, supersedingSessionId)
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: supersedingSessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, session, sessionId, supersedingSessionId])

    useEffect(() => {
        if (!sessionNotFound) {
            return
        }
        navigate({
            to: '/sessions',
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionNotFound, sessionId])

    if (sessionNotFound) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Session not found. Returning to sessions…" className="text-sm" />
            </div>
        )
    }

    return isChat ? <SessionPage /> : <Outlet />
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()
    const { directory: initialDirectory, machineId: initialMachineId, shareTransferId } = newSessionRoute.useSearch()

    const handleCancel = useCallback(() => {
        if (shareTransferId) {
            void deleteShareTransfer(shareTransferId)
        }
        navigate({
            to: '/sessions',
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, shareTransferId])

    const handleSuccess = useCallback((sessionId: string) => {
        if (shareTransferId) {
            setSharePendingTransfer(shareTransferId, sessionId)
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({
            to: '/sessions',
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
                ...PRESERVE_SESSION_SIDEBAR_SCROLL,
            })
        })
    }, [navigate, queryClient, shareTransferId])

    const handleChooseFolder = useCallback((args: { machineId: string | null; directory: string }) => {
        // Forward the currently-selected machine so /browse opens scoped to
        // it rather than falling back to `hapi:lastMachineId`, which can
        // disagree if the user changed machines without yet creating a
        // session. Preserve shareTransferId so a share-target spawn that
        // detours through /browse still seeds the composer after success.
        const search: { machineId?: string; shareTransferId?: string } = {}
        if (args.machineId) search.machineId = args.machineId
        if (shareTransferId) search.shareTransferId = shareTransferId
        navigate({ to: '/browse', search })
    }, [navigate, shareTransferId])

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
    const { machineId: initialMachineId, shareTransferId } = browseRoute.useSearch()

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        navigate({
            to: '/sessions/new',
            search: shareTransferId
                ? { directory, machineId, shareTransferId }
                : { directory, machineId }
        })
    }, [navigate, shareTransferId])

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
    validateSearch: (search: Record<string, unknown>): { outline?: boolean } => {
        const outline = search.outline === true || search.outline === 'true'
        return outline ? { outline: true } : {}
    },
    component: SessionDetailRoute,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories'; query?: string } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined
        const query = typeof search.query === 'string' && search.query.length > 0
            ? search.query
            : undefined

        return {
            ...(tab ? { tab } : {}),
            ...(query ? { query } : {}),
        }
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
    query?: string
    origin?: 'chat'
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
        const query = typeof search.query === 'string' && search.query.length > 0
            ? search.query
            : undefined
        const origin = search.origin === 'chat' ? 'chat' : undefined

        const result: SessionFileSearch = { path }
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        if (query !== undefined) {
            result.query = query
        }
        if (origin !== undefined) {
            result.origin = origin
        }
        return result
    },
    component: FilePage,
})

type NewSessionSearch = {
    directory?: string
    machineId?: string
    shareTransferId?: string
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
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: NewSessionPage,
})

const browseRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/browse',
    validateSearch: (search: Record<string, unknown>): { machineId?: string; shareTransferId?: string } => {
        const result: { machineId?: string; shareTransferId?: string } = {}
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: BrowsePage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsLayout,
})

const settingsIndexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/',
    component: SettingsHubPage,
})

const settingsGeneralRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'general',
    component: SettingsGeneralPage,
})

const settingsDisplayRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'display',
    component: SettingsDisplayPage,
})

const settingsChatRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'chat',
    component: SettingsChatPage,
})

const settingsVoiceRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice',
    component: SettingsVoicePage,
})

const settingsVoiceVoicesRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice/voices',
    component: SettingsVoiceVoicesPage,
})

const settingsVoiceAdvancedRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice/advanced',
    component: SettingsVoiceAdvancedPage,
})

const settingsMachinesRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'machines',
    component: SettingsMachinesPage,
})

const settingsAboutRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'about',
    component: SettingsAboutPage,
})

const settingsStorageRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'storage',
    component: SettingsStoragePage,
})

const settingsUsageRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'usage',
    component: SettingsUsagePage,
})

// Web Share Target landing route. Service worker (`web/src/sw.ts`)
// intercepts the manifest's `POST /share` and 303-redirects here with an
// IDB transfer id. `error=ingest` is set when the SW failed to write IDB.
// Native / deep-link clients open `/share#url=&text=&title=` (fragment, not
// query) so shared content is never part of the HTTP request line.
const shareRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/share',
    validateSearch: (search: Record<string, unknown>) => parseShareSearch(search),
    component: SharePage,
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
    settingsRoute.addChildren([
        settingsIndexRoute,
        settingsGeneralRoute,
        settingsDisplayRoute,
        settingsChatRoute,
        settingsVoiceRoute,
        settingsVoiceVoicesRoute,
        settingsVoiceAdvancedRoute,
        settingsMachinesRoute,
        settingsStorageRoute,
        settingsUsageRoute,
        settingsAboutRoute,
    ]),
    shareRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        // Disabled: TanStack scroll cache can exceed browser storage quota and hard-block the app.
        // See web/src/lib/scrollStorageGuard.ts and tsr-scroll-restoration-v1_3 quota errors.
        scrollRestoration: false,
        getScrollRestorationKey,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
