import { useEffect, useRef, useState } from 'react'
import type { SetSessionSwarmRequest } from '@hapi/protocol/apiTypes'
import type { SessionSummary } from '@/types/api'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import { WorkerAvatar } from './WorkerAvatar'
import {
    defaultWorkerName,
    draftFromRun,
    draftToRequest,
    randomSeed,
    sameDraft,
    type ScheduleDraft
} from './worker'

export type WorkerDraft = SetSessionSwarmRequest & { job: string }

type WorkerSubject = {
    id: string
    flavor?: string | null
    swarm?: { job: string; name?: string; avatarSeed?: string; playbook?: string; review?: { runsLeft: number } } | null
    workerRun?: SessionSummary['workerRun']
}

const INPUT_CLASS = 'rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]'

const REVIEW_CHOICES = [0, 1, 3, 5] as const

const SCHEDULE_MODES: readonly ScheduleDraft['mode'][] = ['none', 'every', 'daily']

function switchMode(mode: ScheduleDraft['mode'], previous: ScheduleDraft): ScheduleDraft {
    if (mode === previous.mode) return previous
    if (mode === 'every') return { mode, every: 1, unit: 'hours' }
    if (mode === 'daily') return { mode, time: '09:00' }
    return { mode }
}

/**
 * Sets up a worker: who it is (name and face), the standing job it owns, and
 * the clock it runs on. Everything else (machine, agent, permission mode) the
 * session already carries.
 */
export function PromoteToWorkerDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessionTitle: string
    worker: WorkerSubject
    onPromote: (draft: WorkerDraft) => Promise<void>
}) {
    const { t } = useTranslation()
    const { worker } = props
    const savedSeed = worker.swarm?.avatarSeed ?? worker.id
    const savedSchedule = draftFromRun(worker.workerRun)
    const [job, setJob] = useState(worker.swarm?.job ?? '')
    const [name, setName] = useState(worker.swarm?.name ?? '')
    const [seed, setSeed] = useState(savedSeed)
    const [schedule, setSchedule] = useState<ScheduleDraft>(savedSchedule)
    const [playbook, setPlaybook] = useState(worker.swarm?.playbook ?? '')
    const [reviewRuns, setReviewRuns] = useState(worker.swarm?.review?.runsLeft ?? 0)
    const [error, setError] = useState<string | null>(null)
    const [isPending, setIsPending] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!props.isOpen) return
        setJob(worker.swarm?.job ?? '')
        setName(worker.swarm?.name ?? '')
        setSeed(savedSeed)
        setSchedule(savedSchedule)
        setPlaybook(worker.swarm?.playbook ?? '')
        setReviewRuns(worker.swarm?.review?.runsLeft ?? 0)
        setError(null)
        setIsPending(false)
        const timer = setTimeout(() => inputRef.current?.focus(), 100)
        return () => clearTimeout(timer)
        // Reset only when the dialog opens; live session updates must not wipe what is being typed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.isOpen])

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        const trimmed = job.trim()
        if (!trimmed) return
        setError(null)
        setIsPending(true)
        try {
            await props.onPromote({
                job: trimmed,
                name: name.trim(),
                avatarSeed: seed,
                playbook: playbook.trim(),
                reviewRuns,
                // An untouched schedule is left alone so saving a rename does not re-time the next run.
                schedule: sameDraft(schedule, savedSchedule) ? undefined : draftToRequest(schedule, Date.now())
            })
            props.onClose()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : t('dialog.error.default'))
        } finally {
            setIsPending(false)
        }
    }

    const isEdit = Boolean(worker.swarm)

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-h-[92vh] max-w-md overflow-y-auto">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {isEdit ? t('swarm.promote.editTitle') : t('swarm.promote.title')}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-5">
                    <div className="flex items-center gap-4">
                        <div className="flex flex-col items-center gap-1.5">
                            <WorkerAvatar seed={seed} size={64} flavor={worker.flavor} />
                            <button
                                type="button"
                                onClick={() => setSeed(randomSeed())}
                                disabled={isPending}
                                className="text-xs text-[var(--app-link)] hover:underline"
                            >
                                {t('swarm.promote.newFace')}
                            </button>
                        </div>
                        <div className="min-w-0 flex-1">
                            <label htmlFor="swarm-name" className="block text-sm font-medium text-[var(--app-fg)]">
                                {t('swarm.promote.nameLabel')}
                            </label>
                            <input
                                id="swarm-name"
                                type="text"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder={defaultWorkerName(seed)}
                                className={`mt-2 w-full ${INPUT_CLASS}`}
                                disabled={isPending}
                                maxLength={40}
                            />
                        </div>
                    </div>

                    <div>
                        <label htmlFor="swarm-job" className="block text-sm font-medium text-[var(--app-fg)]">
                            {t('swarm.promote.label')}
                        </label>
                        <input
                            id="swarm-job"
                            ref={inputRef}
                            type="text"
                            value={job}
                            onChange={(event) => setJob(event.target.value)}
                            placeholder={t('swarm.promote.placeholder')}
                            className={`mt-2 w-full ${INPUT_CLASS}`}
                            disabled={isPending}
                            maxLength={200}
                        />
                        <p className="mt-2 text-xs text-[var(--app-hint)]">
                            {t('swarm.promote.hint', { title: props.sessionTitle })}
                        </p>
                    </div>

                    <div>
                        <label htmlFor="swarm-playbook" className="block text-sm font-medium text-[var(--app-fg)]">
                            {t('swarm.promote.playbookLabel')}
                        </label>
                        <textarea
                            id="swarm-playbook"
                            value={playbook}
                            onChange={(event) => setPlaybook(event.target.value)}
                            placeholder={t('swarm.promote.playbookPlaceholder')}
                            rows={3}
                            maxLength={8000}
                            disabled={isPending}
                            className={`mt-2 w-full resize-y text-sm ${INPUT_CLASS}`}
                        />
                        <p className="mt-2 text-xs text-[var(--app-hint)]">{t('swarm.promote.playbookHint')}</p>
                    </div>

                    <fieldset disabled={isPending}>
                        <legend className="block text-sm font-medium text-[var(--app-fg)]">
                            {t('swarm.promote.scheduleLabel')}
                        </legend>
                        <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-[var(--app-subtle-bg)] p-1">
                            {SCHEDULE_MODES.map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    aria-pressed={schedule.mode === mode}
                                    onClick={() => setSchedule((previous) => switchMode(mode, previous))}
                                    className={`min-h-9 rounded-md px-2 text-sm transition-colors ${schedule.mode === mode
                                        ? 'bg-[var(--app-bg)] font-medium text-[var(--app-fg)] shadow-sm'
                                        : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
                                >
                                    {t(`swarm.promote.schedule.${mode}`)}
                                </button>
                            ))}
                        </div>
                        {schedule.mode === 'every' ? (
                            <div className="mt-3 flex items-center gap-2 text-sm text-[var(--app-fg)]">
                                <span>{t('swarm.promote.schedule.everyPrefix')}</span>
                                <input
                                    type="number"
                                    min={1}
                                    aria-label={t('swarm.promote.schedule.every')}
                                    value={schedule.every}
                                    onChange={(event) => setSchedule({ ...schedule, every: Math.max(1, Number(event.target.value) || 1) })}
                                    className={`w-20 ${INPUT_CLASS} py-2`}
                                />
                                <select
                                    aria-label={t('swarm.promote.schedule.unit')}
                                    value={schedule.unit}
                                    onChange={(event) => setSchedule({ ...schedule, unit: event.target.value === 'minutes' ? 'minutes' : 'hours' })}
                                    className={`${INPUT_CLASS} py-2`}
                                >
                                    <option value="minutes">{t('swarm.promote.schedule.minutes')}</option>
                                    <option value="hours">{t('swarm.promote.schedule.hours')}</option>
                                </select>
                            </div>
                        ) : null}
                        {schedule.mode === 'daily' ? (
                            <div className="mt-3 flex items-center gap-2 text-sm text-[var(--app-fg)]">
                                <span>{t('swarm.promote.schedule.dailyPrefix')}</span>
                                <input
                                    type="time"
                                    aria-label={t('swarm.promote.schedule.daily')}
                                    value={schedule.time}
                                    onChange={(event) => setSchedule({ ...schedule, time: event.target.value || '09:00' })}
                                    className={`${INPUT_CLASS} py-2`}
                                />
                            </div>
                        ) : null}
                        <p className="mt-2 text-xs text-[var(--app-hint)]">
                            {t(schedule.mode === 'none' ? 'swarm.promote.schedule.noneHint' : 'swarm.promote.schedule.hint')}
                        </p>
                    </fieldset>

                    <div>
                        <label htmlFor="swarm-review" className="block text-sm font-medium text-[var(--app-fg)]">
                            {t('swarm.promote.reviewLabel')}
                        </label>
                        <select
                            id="swarm-review"
                            value={reviewRuns}
                            onChange={(event) => setReviewRuns(Number(event.target.value))}
                            disabled={isPending}
                            className={`mt-2 w-full text-sm ${INPUT_CLASS}`}
                        >
                            {[...new Set([...REVIEW_CHOICES, reviewRuns])].sort((a, b) => a - b).map((runs) => (
                                <option key={runs} value={runs}>
                                    {runs === 0 ? t('swarm.promote.review.none') : t('swarm.promote.review.runs', { n: runs })}
                                </option>
                            ))}
                        </select>
                        <p className="mt-2 text-xs text-[var(--app-hint)]">{t('swarm.promote.reviewHint')}</p>
                    </div>

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-2">
                        <Button type="button" variant="secondary" onClick={props.onClose} disabled={isPending}>
                            {t('button.cancel')}
                        </Button>
                        <Button type="submit" disabled={isPending || !job.trim()}>
                            {isEdit ? t('swarm.promote.save') : t('swarm.promote.confirm')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
