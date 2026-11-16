import { describe, expect, it } from 'vitest'
import { capCompletedRequests } from './completedRequests'

const entry = (completedAt?: number) => ({
    tool: 'Bash',
    arguments: {},
    status: 'approved' as const,
    ...(completedAt === undefined ? {} : { completedAt })
})

describe('capCompletedRequests', () => {
    it('returns the same object when under the cap', () => {
        const completed = { a: entry(1), b: entry(2) }
        expect(capCompletedRequests(completed, 2)).toBe(completed)
    })

    it('keeps the most recent entries by completedAt', () => {
        const capped = capCompletedRequests({ newest: entry(30), oldest: entry(10), middle: entry(20) }, 2)
        expect(Object.keys(capped)).toEqual(['middle', 'newest'])
    })

    it('falls back to insertion order when completedAt is missing', () => {
        const capped = capCompletedRequests({ a: entry(), b: entry(), c: entry() }, 2)
        expect(Object.keys(capped)).toEqual(['b', 'c'])
    })
})
