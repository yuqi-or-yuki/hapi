import { describe, expect, it } from 'vitest'
import type { WorkerRecord } from '@/api/client'
import { categoryHitRates } from './hitRates'
import { invalidReviewCards } from './UnfilledCardsNotice'

const review = (role: string | undefined, decision: 'yes' | 'no', predicted: 'yes' | 'no', at: string) => ({
    id: at, at, role, decision, reason: 'because', predictedDecision: predicted, predictedReason: 'because', predictionRole: role
})
const row = (key: string, data: Record<string, unknown>): WorkerRecord => ({ key, data, createdAt: 0, updatedAt: 0 })

describe('categoryHitRates', () => {
    it('counts hits per role and never blends roles together', () => {
        const rates = categoryHitRates([
            row('a', { linkedinReviews: [review('Designer', 'yes', 'yes', '2026-01-01'), review('Research', 'no', 'yes', '2026-01-02')] }),
            row('b', { linkedinReviews: [review('Designer', 'no', 'yes', '2026-01-03')] })
        ])
        expect(rates.map((rate) => [rate.category, rate.stats.choiceMatches, rate.stats.eligible])).toEqual([
            ['Designer', 1, 2],
            ['Research', 0, 1]
        ])
    })

    it('files a review with no role under the row category, else Uncategorized', () => {
        const rates = categoryHitRates([
            row('a', { category: 'SoMa', approvalReviews: [review(undefined, 'yes', 'yes', '2026-01-01')] }),
            row('b', { approvalReviews: [review(undefined, 'yes', 'yes', '2026-01-02')] })
        ])
        expect(rates.map((rate) => rate.category).sort()).toEqual(['SoMa', 'Uncategorized'])
    })
})

describe('invalidReviewCards', () => {
    it('names the cards that block a review', () => {
        const board = { columns: ['name', 'suggestedDecision', 'suggestedReason'] }
        const cards = invalidReviewCards([
            row('a', { name: 'Ann', suggestedDecision: 'yes', suggestedReason: 'Strong.' }),
            row('b', { name: 'Bo', suggestedDecision: 'yes' })
        ], board)
        expect(cards).toEqual([{ name: 'Bo', missing: ['suggestedReason'] }])
    })
})
