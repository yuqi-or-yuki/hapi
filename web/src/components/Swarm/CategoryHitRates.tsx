import { useMemo } from 'react'
import type { WorkerRecord } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { categoryHitRates } from './hitRates'

function rate(hits: number, total: number): string {
    return total > 0 ? `${Math.round(100 * hits / total)}%` : '—'
}

/** The worker's suggestion hit rate, per category. Hidden until there is a saved review to count. */
export function CategoryHitRates(props: { records: readonly WorkerRecord[]; talent: boolean }) {
    const { t } = useTranslation()
    const rows = useMemo(() => categoryHitRates(props.records), [props.records])
    if (rows.length === 0) return null

    return (
        <section className="mt-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 sm:p-5" aria-label={t('swarm.hitRate.title')}>
            <h2 className="text-sm font-semibold text-[var(--app-fg)]">{t('swarm.hitRate.title')}</h2>
            <p className="mt-1 text-xs text-[var(--app-hint)]">{t('swarm.hitRate.body')}</p>
            <table className="mt-3 w-full text-left text-sm">
                <thead className="text-xs text-[var(--app-hint)]">
                    <tr>
                        <th scope="col" className="py-1.5 pr-3 font-medium">{t(props.talent ? 'swarm.hitRate.role' : 'swarm.hitRate.category')}</th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('swarm.hitRate.choice')}</th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('swarm.hitRate.both')}</th>
                        <th scope="col" className="py-1.5 text-right font-medium">{t('swarm.hitRate.reviews')}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(({ category, stats }) => (
                        <tr key={category} className="border-t border-[var(--app-border)] text-[var(--app-fg)]">
                            <th scope="row" className="py-2 pr-3 font-medium">{category}</th>
                            <td className="py-2 pr-3 text-right font-semibold tabular-nums">{rate(stats.choiceMatches, stats.eligible)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-[var(--app-hint)]">{rate(stats.bothMatches, stats.eligible)}</td>
                            <td className="py-2 text-right tabular-nums text-[var(--app-hint)]">
                                {stats.eligible}
                                {stats.unavailable > 0 ? <span title={t('swarm.hitRate.excluded', { n: stats.unavailable })}> +{stats.unavailable}</span> : null}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    )
}
