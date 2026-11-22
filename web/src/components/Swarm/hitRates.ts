import { reviewCategory } from '@hapi/protocol/workerReview'
import type { WorkerRecord } from '@/api/client'
import { approvalAgreement, type Agreement } from './approvalMetrics'

const HISTORIES = ['linkedinReviews', 'approvalReviews'] as const

export type CategoryHitRate = { category: string; stats: Agreement }

/**
 * How often the worker's suggestions hit, one line per category (the role on a
 * talent board, the row's `category` elsewhere). Suggestions are only
 * comparable within a category, so there is deliberately no blended total:
 * a strong category must not hide a weak one.
 *
 * Counting itself stays in `approvalAgreement`; this only sorts each saved
 * review into its category first, so the two views can never count differently.
 */
export function categoryHitRates(records: readonly WorkerRecord[]): CategoryHitRate[] {
    const byCategory = new Map<string, WorkerRecord[]>()
    for (const record of records) {
        for (const kind of HISTORIES) {
            const events = record.data[kind]
            if (!Array.isArray(events)) continue
            for (const event of events) {
                if (!event || typeof event !== 'object' || Array.isArray(event)) continue
                // A review saved before categories were snapshotted falls back to the row it sits on.
                const category = reviewCategory({ category: record.data.category, ...(event as Record<string, unknown>) })
                const bucket = byCategory.get(category) ?? []
                bucket.push({ ...record, data: { [kind]: [event] } })
                byCategory.set(category, bucket)
            }
        }
    }
    return [...byCategory]
        .map(([category, rows]) => ({ category, stats: approvalAgreement(rows) }))
        .sort((a, b) => b.stats.eligible - a.stats.eligible || a.category.localeCompare(b.category))
}
