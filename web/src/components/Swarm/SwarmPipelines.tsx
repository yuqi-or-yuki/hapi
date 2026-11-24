import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { buildPipelines, pendingInto, type PipelineLink } from './pipeline'
import type { Worker } from './SwarmView'
import { workerName } from './worker'

const LINKS_KEY = ['swarm-links'] as const
const idOf = (worker: Worker) => worker.session.id

export function useSwarmLinks(): PipelineLink[] {
    const { api } = useAppContext()
    const query = useQuery({
        queryKey: LINKS_KEY,
        queryFn: async () => (api ? (await api.getSwarmLinks()).links : []),
        enabled: Boolean(api),
        refetchInterval: 15_000,
    })
    return query.data ?? []
}

/**
 * The swarm laid out the way work flows: linked workers side by side with an
 * arrow carrying the number of approved items waiting for the next stage, and
 * everyone else below as before.
 */
export function SwarmPipelines(props: { workers: Worker[]; renderCard: (worker: Worker) => ReactNode }) {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const links = useSwarmLinks()
    const { pipelines, alone } = useMemo(() => buildPipelines(props.workers, links, idOf), [props.workers, links])
    const [from, setFrom] = useState('')
    const [to, setTo] = useState('')

    const change = useMutation({
        mutationFn: async (args: { from: string; to: string; remove?: boolean }) => {
            if (!api) throw new Error('API unavailable')
            await api.setWorkerLink(args.to, args.from, args.remove === true)
        },
        onSuccess: () => {
            setFrom('')
            setTo('')
            void queryClient.invalidateQueries({ queryKey: LINKS_KEY })
        },
    })
    const name = (id: string) => {
        const worker = props.workers.find((candidate) => candidate.session.id === id)
        return worker ? workerName(worker.session) : id.slice(0, 8)
    }

    return (
        <div className="space-y-4">
            {pipelines.map((pipeline) => (
                <section key={pipeline.links.map((link) => `${link.from}>${link.to}`).join('|')} className="rounded-2xl border border-[var(--app-border)] p-3">
                    <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center">
                        {pipeline.stages.map((stage, index) => (
                            <Fragment key={stage.map(idOf).join('|')}>
                                {index > 0 ? (
                                    <div className="flex shrink-0 items-center justify-center gap-1 text-xs text-[var(--app-hint)] lg:flex-col" aria-hidden="true">
                                        <span className="text-lg leading-none lg:hidden">↓</span>
                                        <span className="hidden text-lg leading-none lg:inline">→</span>
                                        <span className={pendingInto(pipeline, index, idOf) > 0 ? 'font-medium text-amber-700 dark:text-amber-300' : ''}>
                                            {t('swarm.pipeline.waiting', { n: pendingInto(pipeline, index, idOf) })}
                                        </span>
                                    </div>
                                ) : null}
                                <div className="min-w-0 flex-1 space-y-2">
                                    {stage.map((worker) => <div key={idOf(worker)}>{props.renderCard(worker)}</div>)}
                                </div>
                            </Fragment>
                        ))}
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--app-hint)]">
                        {pipeline.links.map((link) => (
                            <li key={`${link.from}>${link.to}`}>
                                {t('swarm.pipeline.link', { from: name(link.from), to: name(link.to), pending: link.pending, handled: link.handled })}
                                <button
                                    type="button"
                                    className="ml-1.5 text-[var(--app-link)] hover:underline disabled:opacity-50"
                                    disabled={change.isPending}
                                    onClick={() => change.mutate({ from: link.from, to: link.to, remove: true })}
                                >
                                    {t('swarm.pipeline.unlink')}
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}

            {alone.length > 0 ? (
                <div className="grid gap-3 lg:grid-cols-2">
                    {alone.map((worker) => <div key={idOf(worker)}>{props.renderCard(worker)}</div>)}
                </div>
            ) : null}

            {props.workers.length > 1 ? (
                <form
                    className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-hint)]"
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (from && to && from !== to) change.mutate({ from, to })
                    }}
                >
                    <span>{t('swarm.pipeline.connect')}</span>
                    {([[from, setFrom, 'swarm.pipeline.from'], [to, setTo, 'swarm.pipeline.to']] as const).map(([value, setValue, label], index) => (
                        <Fragment key={label}>
                            {index === 1 ? <span aria-hidden="true">→</span> : null}
                            <select
                                value={value}
                                onChange={(event) => setValue(event.target.value)}
                                aria-label={t(label)}
                                className="max-w-[12rem] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[var(--app-fg)]"
                            >
                                <option value="">{t(label)}</option>
                                {props.workers.map((worker) => <option key={idOf(worker)} value={idOf(worker)}>{workerName(worker.session)}</option>)}
                            </select>
                        </Fragment>
                    ))}
                    <button type="submit" disabled={!from || !to || from === to || change.isPending} className="font-medium text-[var(--app-link)] hover:underline disabled:opacity-50">
                        {t('swarm.pipeline.connectAction')}
                    </button>
                    <span>{t('swarm.pipeline.connectHint')}</span>
                    {change.error ? <span role="alert" className="text-red-600 dark:text-red-400">{change.error.message}</span> : null}
                </form>
            ) : null}
        </div>
    )
}
