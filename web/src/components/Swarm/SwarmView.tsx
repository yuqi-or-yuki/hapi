import { useMemo, useState } from 'react'
import type { SessionSummary } from '@/types/api'
import { formatFutureRelativeTime } from '@/lib/scheduledTime'
import { useTranslation } from '@/lib/use-translation'
import { SwarmRailIcon } from '@/components/AppRail'
import { RunStrip } from './RunStrip'
import { SwarmOffice } from './SwarmOffice'
import { WorkerAvatar } from './WorkerAvatar'
import { describeSchedule, newToReview, workerName, workerSeed, workerState, type WorkerState } from './worker'

/** The office is the default; the list stays for small screens and for scanning many workers. */
const VIEW_MODES = ['office', 'list'] as const
type SwarmViewMode = typeof VIEW_MODES[number]
const VIEW_KEY = 'hapi.swarm.view.v1'

function readViewMode(): SwarmViewMode {
    try {
        return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'office'
    } catch {
        return 'office'
    }
}

export type Worker = {
    session: SessionSummary
    job: string
    promotedAt: number
}

/** Sessions promoted to workers, newest post first. */
export function selectWorkers(sessions: readonly SessionSummary[]): Worker[] {
    return sessions
        .flatMap((session) => {
            const swarm = session.metadata?.swarm
            if (!swarm?.job) return []
            return [{ session, job: swarm.job, promotedAt: swarm.promotedAt ?? 0 }]
        })
        .sort((a, b) => b.promotedAt - a.promotedAt)
}

const STATE_STYLES: Record<WorkerState, string> = {
    working: 'text-emerald-600 dark:text-emerald-400',
    failing: 'text-red-600 dark:text-red-400',
    scheduled: 'text-[var(--app-hint)]',
    paused: 'text-[var(--app-hint)]',
    onDemand: 'text-[var(--app-hint)]'
}

/** The one line that answers "is this worker fine, and when does it work next?" */
function useStateLine(session: SessionSummary, state: WorkerState): string {
    const { t } = useTranslation()
    const run = session.workerRun
    if (state === 'failing' && run?.lastError) return run.lastError
    if (state === 'scheduled' && run) {
        const next = run.nextRunAt <= Date.now() ? t('swarm.schedule.dueNow') : formatFutureRelativeTime(run.nextRunAt, t)
        return `${describeSchedule(run, t, session.metadata?.swarm?.activeWindow)} · ${next}`
    }
    return t(`swarm.state.${state}`)
}

/**
 * A card says who the worker is, what it does, and whether it needs you.
 * Everything else (machine, permissions, editing) is one click
 * away on the worker's page, so a healthy swarm reads as a quiet list.
 */
function WorkerCard(props: { worker: Worker; onOpen: () => void; onApprove: () => void }) {
    const { t } = useTranslation()
    const { session, job } = props.worker
    const state = workerState(session)
    const line = useStateLine(session, state)
    const review = session.metadata?.swarm?.review
    const rows = session.workerBoard?.count ?? 0
    const toReview = newToReview(session)

    return (
        <div className="relative min-w-0 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 transition-colors hover:border-[var(--app-hint)]">
            <div className="flex items-start gap-3">
                <span className="relative shrink-0">
                    <WorkerAvatar seed={workerSeed(session)} size={44} flavor={session.metadata?.flavor} />
                    {toReview > 0 ? (
                        <span
                            role="status"
                            aria-label={t('swarm.toReview', { n: toReview })}
                            title={t('swarm.toReview', { n: toReview })}
                            className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-500 ring-2 ring-[var(--app-subtle-bg)]"
                        />
                    ) : null}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                        {/* The stretched button makes the whole card the way in, while
                            the approve button below stays its own target. */}
                        <button
                            type="button"
                            onClick={props.onOpen}
                            className="truncate text-left text-base font-semibold text-[var(--app-fg)] after:absolute after:inset-0 after:rounded-2xl"
                        >
                            {workerName(session)}
                        </button>
                        {toReview > 0
                            ? <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">{t('swarm.toReview', { n: toReview })}</span>
                            : rows > 0 ? <span className="shrink-0 text-xs text-[var(--app-hint)]">{t('swarm.board.count', { n: rows })}</span> : null}
                    </div>
                    <p className="truncate text-sm text-[var(--app-fg)]">{job}</p>
                    <p className={`mt-1.5 flex items-center gap-1.5 text-xs ${STATE_STYLES[state]}`}>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${state === 'working' ? 'animate-pulse' : ''}`} />
                        <span className="truncate">{line}</span>
                    </p>
                    {/* Only once there is a record: an empty strip would say nothing. */}
                    {session.workerRun?.recent.length ? (
                        <p className="mt-1.5 text-xs text-[var(--app-hint)]">
                            <RunStrip recent={session.workerRun.recent} />
                        </p>
                    ) : null}
                </div>
            </div>

            {review ? (
                <div className="relative mt-3 flex items-center justify-between gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs">
                    <span className="font-medium text-amber-700 dark:text-amber-300">{t('swarm.review.title', { n: review.runsLeft })}</span>
                    <button
                        type="button"
                        onClick={props.onApprove}
                        className="shrink-0 rounded-full bg-amber-600 px-3 py-1 font-medium text-white hover:opacity-90"
                    >
                        {t('swarm.review.approve')}
                    </button>
                </div>
            ) : null}
        </div>
    )
}

export function SwarmView(props: {
    sessions: readonly SessionSummary[]
    onOpenWorker: (sessionId: string) => void
    /** Approve the last reviewed run of a worker in its review period. */
    onApprove: (session: SessionSummary) => void
}) {
    const { t } = useTranslation()
    const workers = useMemo(() => selectWorkers(props.sessions), [props.sessions])
    const [view, setView] = useState<SwarmViewMode>(readViewMode)
    const chooseView = (mode: SwarmViewMode) => {
        setView(mode)
        try {
            localStorage.setItem(VIEW_KEY, mode)
        } catch {
            // The choice simply does not survive a reload.
        }
    }
    const card = (worker: Worker) => (
        <WorkerCard
            worker={worker}
            onOpen={() => props.onOpenWorker(worker.session.id)}
            onApprove={() => props.onApprove(worker.session)}
        />
    )

    return (
        <div className="mx-auto w-full max-w-content px-3 py-4 sm:px-4 sm:py-5">
            {workers.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--app-border)] px-5 py-10 text-center">
                    <SwarmRailIcon className="mx-auto h-8 w-8 text-[var(--app-hint)]" />
                    <p className="mt-3 text-sm font-medium text-[var(--app-fg)]">{t('swarm.empty.title')}</p>
                    <p className="mx-auto mt-2 max-w-md text-sm text-[var(--app-hint)]">{t('swarm.empty.body')}</p>
                </div>
            ) : (
                <>
                    <div className="mb-3 flex justify-end">
                        <div className="inline-flex rounded-full bg-[var(--app-subtle-bg)] p-0.5 text-xs" role="group" aria-label={t('swarm.view.label')}>
                            {VIEW_MODES.map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    aria-pressed={view === mode}
                                    onClick={() => chooseView(mode)}
                                    className={`rounded-full px-3 py-1 ${view === mode ? 'bg-[var(--app-bg)] font-medium text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
                                >
                                    {t(`swarm.view.${mode}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                    {view === 'office' ? (
                        <SwarmOffice workers={workers} renderCard={card} onOpenWorker={props.onOpenWorker} />
                    ) : (
                        <div className="grid gap-3 lg:grid-cols-2">
                            {workers.map((worker) => <div key={worker.session.id}>{card(worker)}</div>)}
                        </div>
                    )}
                </>
            )}
        </div>
    )
}
