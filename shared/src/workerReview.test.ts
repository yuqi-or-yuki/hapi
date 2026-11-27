import { describe, expect, it } from 'bun:test'
import { isItemApprovalBoard, missingCardFields, reviewCategory, unfilledCards, reviewQueue } from './workerReview'

const approval = { columns: ['name', 'suggestedDecision', 'suggestedReason'] }
const talent = { title: 'Talent intake' }
const full = { name: 'Ann', suggestedDecision: 'yes', suggestedReason: 'Led two launches.' }

describe('review cards', () => {
    it('knows which boards are reviewed item by item', () => {
        expect(isItemApprovalBoard(approval)).toBe(true)
        expect(isItemApprovalBoard(talent)).toBe(true)
        expect(isItemApprovalBoard({ columns: ['name'] })).toBe(false)
        expect(isItemApprovalBoard(undefined)).toBe(false)
    })

    it('lists what a card lacks, and asks talent cards for a role too', () => {
        expect(missingCardFields(full, false)).toEqual([])
        expect(missingCardFields({ name: 'Ann', suggestedDecision: 'maybe', suggestedReason: '  ' }, false)).toEqual(['suggestedDecision', 'suggestedReason'])
        expect(missingCardFields(full, true)).toEqual(['bestFitRole'])
        expect(missingCardFields({ ...full, bestFitRole: 'Product Designer' }, true)).toEqual([])
    })

    it('only holds cards still awaiting review to the rule', () => {
        const rows = [
            { key: 'a', data: full },
            { key: 'b', data: { name: 'Bo' } },
            { key: 'c', data: { name: 'Cy', approvalReviews: [{ decision: 'no' }] } }
        ]
        expect(unfilledCards(rows, approval)).toEqual([{ key: 'b', missing: ['suggestedDecision', 'suggestedReason'] }])
        expect(unfilledCards(rows, { columns: ['name'] })).toEqual([])
    })

    it('requires an HTTPS profile on product reviewer cards', () => {
        const board = { ...approval, title: 'Product Reviewer Pool' }
        const rows = [
            { key: 'missing', data: full },
            { key: 'invalid', data: { ...full, profileUrl: 'javascript:void(0)' } },
            { key: 'valid', data: { ...full, profileUrl: 'https://example.com/candidate' } }
        ]
        expect(unfilledCards(rows, board)).toEqual([
            { key: 'missing', missing: ['profileUrl'] },
            { key: 'invalid', missing: ['profileUrl'] }
        ])
        expect(unfilledCards(rows, approval)).toEqual([])
    })

    it('files a review under its role, then its category', () => {
        expect(reviewCategory({ role: 'Forward Deployment', category: 'x' })).toBe('Forward Deployment')
        expect(reviewCategory({ category: 'SoMa' })).toBe('SoMa')
        expect(reviewCategory({})).toBe('Uncategorized')
    })
})

describe('reviewQueue', () => {
    const card = (key: string, data: Record<string, unknown> = {}) => ({ key, data: { name: key, ...data } })
    const approval = { columns: ['name', 'suggestedDecision', 'suggestedReason'] }

    it('keeps board order, drops settled and held cards, so position 2 is the card after next', () => {
        const rows = [
            card('settled', { approvalReviews: [{ decision: 'yes' }] }),
            card('next'),
            card('held', { channel: 'hold' }),
            card('after-next'),
            card('later'),
        ]
        expect(reviewQueue(rows, approval).map((row) => row.key)).toEqual(['next', 'after-next', 'later'])
    })

    it('leads with research cards on a talent board, keeping their relative order', () => {
        const rows = [
            card('designer', { bestFitRole: 'Product Designer' }),
            card('research-one', { bestFitRole: 'Research Scientist, Modeling' }),
            card('research-two', { bestFitRole: 'Research Scientist, Evaluations' }),
        ]
        expect(reviewQueue(rows, { title: 'Talent intake' }).map((row) => row.key)).toEqual(['research-one', 'research-two', 'designer'])
    })

    it('is empty on a board that is not reviewed card by card', () => {
        expect(reviewQueue([card('a')], { columns: ['name'] })).toEqual([])
    })
})
