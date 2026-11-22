import { describe, it, expect } from 'vitest'
import { approvalAgreement } from './approvalMetrics'
import type { WorkerRecord } from '@/api/client'
const row = (data: Record<string, unknown>): WorkerRecord => ({ key: 'a', createdAt: 1, updatedAt: 1, data })
describe('approvalAgreement', () => {
    it('excludes old reviews and computes cumulative unchanged choice and reason', () => {
        const result = approvalAgreement([row({ linkedinReviews: [
            { at: '2026-01-01', decision: 'no', reason: 'old' },
            { at: '2026-01-03', decision: 'yes', reason: 'changed', predictedDecision: 'no', predictedReason: 'old', decisionUnchanged: false, reasonUnchanged: false },
            { at: '2026-01-02', decision: 'yes', reason: 'good', predictedDecision: 'yes', predictedReason: 'good', decisionUnchanged: true, reasonUnchanged: true },
        ] })])
        expect(result).toMatchObject({ unavailable: 1, eligible: 2, choiceMatches: 1, reasonMatches: 1, bothMatches: 1 })
        expect(result.trend.map((p) => p.percent)).toEqual([100, 50])
    })
    it('calculates each role independently, including separate trends and exclusions', () => {
        const records = [row({ linkedinReviews: [
            { at: '2026-01-01', role: 'A', decision: 'yes', reason: 'ok', predictedDecision: 'yes', predictedReason: 'ok' },
            { at: '2026-01-02', role: 'B', decision: 'no', reason: 'changed', predictedDecision: 'yes', predictedReason: 'old' },
            { at: '2026-01-03', role: 'A', decision: 'no', reason: 'old review' },
            { at: '2026-01-04', decision: 'yes', reason: 'unknown role', suggestionAccepted: true },
        ] })]
        expect(approvalAgreement(records, 'A')).toMatchObject({ eligible: 1, unavailable: 1, bothMatches: 1, trend: [{ count: 1, percent: 100 }] })
        expect(approvalAgreement(records, 'B')).toMatchObject({ eligible: 1, unavailable: 0, bothMatches: 0, trend: [{ count: 1, percent: 0 }] })
        expect(approvalAgreement(records, 'C')).toMatchObject({ eligible: 0, unavailable: 0 })
    })
    it('excludes a prediction for a different role', () => {
        const result = approvalAgreement([row({ approvalReviews: [{ at: '2026-01-01', decision: 'yes', reason: 'ok', predictedDecision: 'yes', predictedReason: 'ok', predictionRole: 'A', role: 'B' }] })])
        expect(result).toMatchObject({ eligible: 0, unavailable: 1 })
    })
    it('tracks unchanged choice separately from changed reasoning', () => {
        const result = approvalAgreement([row({ approvalReviews: [{ at: '2026-01-01', decision: 'yes', reason: 'edited', predictedDecision: 'yes', predictedReason: 'suggested', decisionUnchanged: true, reasonUnchanged: false }] })])
        expect(result).toMatchObject({ eligible: 1, choiceMatches: 1, reasonMatches: 0, bothMatches: 0 })
    })
    it('counts legacy explicit unchanged confirmations, but not ambiguous false flags', () => {
        const result = approvalAgreement([row({ linkedinReviews: [
            { at: '2026-01-01', decision: 'no', reason: 'reason', suggestionAccepted: true },
            { at: '2026-01-02', decision: 'yes', reason: 'other', suggestionAccepted: false }
        ] })])
        expect(result).toMatchObject({ eligible: 1, unavailable: 1, choiceMatches: 1, reasonMatches: 1, bothMatches: 1 })
    })
})
