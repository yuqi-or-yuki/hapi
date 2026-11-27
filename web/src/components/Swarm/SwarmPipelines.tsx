import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { buildPipelines, linksInto, looseLinks, type Pipeline, type PipelineLink } from './pipeline'
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

/** The arrow between two stages, carrying the links that cross it. */
function Connector(props: { links: PipelineLink[]; name: (id: string) => string; disabled: boolean; onUnlink: (link: PipelineLink) => void }) {
    const { t } = useTranslation()
    return (
        <div className="flex items-start gap-2 py-1.5 pl-5 text-xs text-[var(--app-hint)]">
            <span aria-hidden="true" className="mt-px text-base leading-none">↓</span>
            <ul className="min-w-0 space-y-0.5">
                {props.links.map((link) => (
                    <li key={`${link.from}>${link.to}`} className={link.pending > 0 ? 'text-amber-700 dark:text-amber-300' : ''}>
                        {t('swarm.pipeline.link', { from: props.name(link.from), to: props.name(link.to), pending: link.pending, handled: link.handled })}
                        <button
                            type="button"
                            className="ml-1.5 text-[var(--app-link)] hover:underline disabled:opacity-50"
                            disabled={props.disabled}
                            onClick={() => props.onUnlink(link)}
                        >
                            {t('swarm.pipeline.unlink')}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    )
}

/**
 * The swarm laid out the way work flows: linked workers stacked top to bottom,
 * each full-width card separated by the arrow that carries its links, and
 * everyone else below as before. Vertical on purpose — a wide pipeline used to
 * divide one row between its stages, which squeezed long chains into unreadable
 * slivers; down the page every stage gets the same room however long it grows.
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
    const loose = (pipeline: Pipeline<Worker>) => looseLinks(pipeline, idOf)

    return (
        <div className="space-y-4">
            {pipelines.map((pipeline) => (
                <section key={pipeline.links.map((link) => `${link.from}>${link.to}`).join('|')} className="rounded-2xl border border-[var(--app-border)] p-3">
                    <div className="flex flex-col items-stretch">
                        {pipeline.stages.map((stage, index) => (
                            <Fragment key={stage.map(idOf).join('|')}>
                                {index > 0 ? <Connector links={linksInto(pipeline, index, idOf)} name={name} disabled={change.isPending} onUnlink={(link) => change.mutate({ from: link.from, to: link.to, remove: true })} /> : null}
                                <div className="min-w-0 space-y-2">
                                    {stage.map((worker) => <div key={idOf(worker)}>{props.renderCard(worker)}</div>)}
                                </div>
                            </Fragment>
                        ))}
                    </div>
                    {/* Only a cycle can leave a link off every connector. */}
                    {loose(pipeline).length > 0 ? <Connector links={loose(pipeline)} name={name} disabled={change.isPending} onUnlink={(link) => change.mutate({ from: link.from, to: link.to, remove: true })} /> : null}
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
