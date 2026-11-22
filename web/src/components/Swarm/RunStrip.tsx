import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { runMark, type RunMark } from './worker'

const RUN_MARK_STYLES: Record<RunMark, string> = {
    onTime: 'bg-emerald-500',
    late: 'bg-amber-500',
    missed: 'bg-red-500'
}

/**
 * One mark per recent scheduled run, oldest to newest, with the on-time count:
 * the record of whether a worker is keeping its schedule. Shared by the swarm
 * card and the worker page so the two can never disagree.
 */
export function RunStrip(props: { recent: NonNullable<SessionSummary['workerRun']>['recent'] }) {
    const { t } = useTranslation()
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
