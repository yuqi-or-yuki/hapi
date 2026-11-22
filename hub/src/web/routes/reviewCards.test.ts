import { describe, expect, it } from 'bun:test'
import { unfilledAfterWrite } from './sessions'

const board = { columns: ['name', 'suggestedDecision', 'suggestedReason'] }
const row = (key: string, data: Record<string, unknown>) => ({ key, data, createdAt: 0, updatedAt: 0 })

describe('unfilledAfterWrite', () => {
    it('rejects a new card with no suggestion and accepts a prefilled one', () => {
        expect(unfilledAfterWrite([], [{ key: 'a', data: { name: 'Ann' } }], board)).toEqual([{ key: 'a', missing: ['suggestedDecision', 'suggestedReason'] }])
        expect(unfilledAfterWrite([], [{ key: 'a', data: { name: 'Ann', suggestedDecision: 'no', suggestedReason: 'No PM background.' } }], board)).toEqual([])
    })

    it('judges the merged row, so a patch can complete a card or break one', () => {
        const stored = [row('a', { name: 'Ann', suggestedDecision: 'yes' })]
        expect(unfilledAfterWrite(stored, [{ key: 'a', data: { suggestedReason: 'Shipped three products.' } }], board)).toEqual([])
        const complete = [row('a', { name: 'Ann', suggestedDecision: 'yes', suggestedReason: 'Shipped.' })]
        expect(unfilledAfterWrite(complete, [{ key: 'a', data: { suggestedReason: null } }], board)).toEqual([{ key: 'a', missing: ['suggestedReason'] }])
    })

    it('leaves reviewed rows, untouched rows and ordinary boards alone', () => {
        const stored = [row('reviewed', { name: 'Bo', approvalReviews: [{ decision: 'no' }] }), row('other', { name: 'Unfilled' })]
        expect(unfilledAfterWrite(stored, [{ key: 'reviewed', data: { note: 'x' } }], board)).toEqual([])
        expect(unfilledAfterWrite([], [{ key: 'a', data: { name: 'Ann' } }], { columns: ['name'] })).toEqual([])
    })
})
