import type { SessionSummary } from '@/types/api'
import type { PermissionAutonomy } from '@hapi/protocol/modes'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'
import { WorkerAvatar } from './WorkerAvatar'
import { describeSchedule, runMark, trustLevel, workerName, workerSeed, type RunMark } from './worker'

const TRUST_STYLES: Record<PermissionAutonomy | 'unknown', string> = {
    asks: 'border-[var(--app-border)] text-[var(--app-hint)]',
    guarded: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
    free: 'border-red-500/40 text-red-600 dark:text-red-400',
    unknown: 'border-[var(--app-border)] text-[var(--app-hint)]'
}

const RUN_MARK_STYLES: Record<RunMark, string> = {
    onTime: 'bg-emerald-500',
    late: 'bg-amber-500',
    missed: 'bg-red-500'
}

type Run = NonNullable<SessionSummary['workerRun']>

/** One mark per recent run, oldest to newest: the record of whether the schedule is being kept. */
function RunHistory(props: { recent: Run['recent']; nextRunAt: number | null }) {
    const { t } = useTranslation()
    // This line is the record of the *schedule*, so an empty one only means the
    // clock has not struck yet. A worker almost always does its job once while
    // being set up, and that run is not a scheduled delivery -- saying "has not
    // run yet" next to a board full of its results reads as broken. Name the
    // next run instead, which is the thing the operator actually wants.
    if (props.recent.length === 0) {
        const when = props.nextRunAt
            ? new Date(props.nextRunAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : null
        return <span>{when ? t('swarm.schedule.firstRunAt', { time: when }) : t('swarm.schedule.neverRan')}</span>
    }
    const marks = props.recent.map(runMark)
    return (
        <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1" role="img" aria-label={t('swarm.runs.label')}>
                {[...props.recent].reverse().map((event) => {
                    const mark = runMark(event)
                    const when = new Date(event.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                    const detail = mark === 'late' ? t('swarm.runs.late', { n: Math.round(event.lateMs / 60_000) }) : t(`swarm.runs.${mark}`)
                    return <span key={event.at} title={`${when} · ${detail}`} className={`h-3.5 w-1.5 rounded-full ${RUN_MARK_STYLES[mark]}`} />
                })}
            </span>
            {t('swarm.runs.summary', { onTime: marks.filter((mark) => mark === 'onTime').length, total: marks.length })}
        </span>
    )
}

/**
 * Everything about a worker that the swarm card leaves out: its clock and
 * whether it has been keeping it, its review period, and where it runs.
 */
export function WorkerDetails(props: {
    session: SessionSummary
    machineLabel: string | null
    /** Sets how many runs are still to be reviewed; 0 lets the worker run free. */
    onReview: (runsLeft: number) => void
}) {
    const { t } = useTranslation()
    const { session } = props
    const swarm = session.metadata?.swarm
    const run = session.workerRun
    const trust = trustLevel(session)
    const lastRun = run?.lastRunAt ? formatRelativeTime(run.lastRunAt, t) : null

    return (
        <div className="mx-auto w-full max-w-[1400px] px-3 pt-4 sm:px-4 sm:pt-5">
            <div className="flex items-start gap-3">
                <WorkerAvatar seed={workerSeed(session)} size={48} flavor={session.metadata?.flavor} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold text-[var(--app-fg)]">{workerName(session)}</span>
                        <span
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${TRUST_STYLES[trust]}`}
                            title={t(`swarm.trust.${trust}.hint`)}
                        >
                            {t(`swarm.trust.${trust}`)}
                        </span>
                    </div>
                    <p className="text-sm text-[var(--app-fg)]">{swarm?.job}</p>
                    <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--app-hint)]">
                        {props.machineLabel ? <span>{props.machineLabel}</span> : null}
                        {session.metadata?.path ? <span className="truncate">{session.metadata.path}</span> : null}
                    </p>
                </div>
            </div>

            <dl className="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
                <dt className="text-[var(--app-hint)]">{t('swarm.details.schedule')}</dt>
                <dd className="text-[var(--app-fg)]">
                    {run
                        ? `${describeSchedule(run, t)}${run.paused ? ` · ${t('swarm.state.paused')}` : ''}${lastRun ? ` · ${t('swarm.schedule.lastRun', { time: lastRun })}` : ''}`
                        : t('swarm.schedule.none')}
                </dd>
                {run ? (
                    <>
                        <dt className="text-[var(--app-hint)]">{t('swarm.details.runs')}</dt>
                        <dd className="text-[var(--app-fg)]"><RunHistory recent={run.recent} nextRunAt={run.paused ? null : run.nextRunAt} /></dd>
                    </>
                ) : null}
                {run?.lastError ? (
                    <>
                        <dt className="text-[var(--app-hint)]">{t('swarm.details.problem')}</dt>
                        <dd className="text-red-600 dark:text-red-400" role="status">{run.lastError}</dd>
                    </>
                ) : null}
            </dl>

            {swarm?.review ? (
                <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-amber-700 dark:text-amber-300">{t('swarm.review.title', { n: swarm.review.runsLeft })}</p>
                        <p className="text-[var(--app-hint)]">{t('swarm.review.body')}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => props.onReview(swarm.review!.runsLeft - 1)}
                        className="rounded-full bg-amber-600 px-3 py-1 font-medium text-white hover:opacity-90"
                    >
                        {t('swarm.review.approve')}
                    </button>
                    <button type="button" onClick={() => props.onReview(0)} className="text-[var(--app-hint)] hover:text-[var(--app-fg)]">
                        {t('swarm.review.end')}
                    </button>
                </div>
            ) : null}
        </div>
    )
}
