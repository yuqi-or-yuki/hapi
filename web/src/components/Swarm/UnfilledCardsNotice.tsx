import { unfilledCards, type BoardConfig } from '@hapi/protocol/workerReview'
import type { WorkerRecord } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'

/** The review cards that are not prefilled, by display name. Empty means the review is valid. */
export function invalidReviewCards(records: readonly WorkerRecord[], board: BoardConfig): { name: string; missing: string[] }[] {
    const byKey = new Map(records.map((record) => [record.key, record.data]))
    return unfilledCards(records, board).map((card) => {
        const data = byKey.get(card.key) ?? {}
        const name = typeof data.name === 'string' && data.name.trim() ? data.name : typeof data.title === 'string' && data.title.trim() ? data.title : card.key
        return { name, missing: card.missing }
    })
}

/**
 * Shown instead of the review when any card awaiting review has no suggested
 * decision and reason. One unfilled card invalidates the whole review: the
 * user is never asked to approve something the worker has not assessed.
 */
export function UnfilledCardsNotice(props: { cards: readonly { name: string; missing: string[] }[] }) {
    const { t } = useTranslation()
    if (props.cards.length === 0) return null
    return (
        <div role="alert" className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
            <p className="font-medium text-red-700 dark:text-red-300">{t('swarm.unfilled.title', { n: props.cards.length })}</p>
            <p className="mt-1 text-xs text-[var(--app-hint)]">{t('swarm.unfilled.body')}</p>
            <ul className="mt-2 space-y-0.5 text-xs text-[var(--app-fg)]">
                {props.cards.slice(0, 8).map((card) => (
                    <li key={card.name}>{card.name} <span className="text-[var(--app-hint)]">· {card.missing.join(', ')}</span></li>
                ))}
                {props.cards.length > 8 ? <li className="text-[var(--app-hint)]">{t('swarm.unfilled.more', { n: props.cards.length - 8 })}</li> : null}
            </ul>
        </div>
    )
}
