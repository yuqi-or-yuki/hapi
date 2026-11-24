import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('WorkerRecordStore', () => {
    it('merges fields onto an existing row and drops null fields', () => {
        const { workerRecords } = new Store(':memory:')
        workerRecords.upsert('default', 's1', [{ key: 'jane', data: { name: 'Jane', citations: 4120, emailSent: false } }])
        workerRecords.upsert('default', 's1', [{ key: 'jane', data: { emailSent: true, citations: null } }])

        const rows = workerRecords.list('default', 's1')
        expect(rows).toHaveLength(1)
        expect(rows[0].data).toEqual({ name: 'Jane', emailSent: true })
        expect(workerRecords.stats('default').get('s1')?.count).toBe(1)
    })

    it('keeps each review once after row changes, deletion, and session transfer', () => {
        const { workerRecords } = new Store(':memory:')
        const first = { id: 'r1', role: 'Designer', decision: 'yes', reason: 'good' }
        const second = { id: 'r2', role: 'Research', decision: 'no', reason: 'unclear' }
        workerRecords.upsert('default', 'old', [{ key: 'candidate', data: { linkedinReviews: [first] } }])
        workerRecords.upsert('default', 'old', [{ key: 'candidate', data: { linkedinReviews: [second] } }])
        workerRecords.upsert('default', 'old', [{ key: 'candidate', data: { linkedinReviews: null } }])
        workerRecords.remove('default', 'old', 'candidate')
        workerRecords.transfer('old', 'new')
        expect(workerRecords.reviewHistory('default', 'new').map((row) => row.data.linkedinReviews)).toEqual([[first], [second]])
        expect(workerRecords.reviewHistory('default', 'new')).toHaveLength(2)
    })

    it('keeps each review under its category for good, even after the row changes or goes', () => {
        const { workerRecords } = new Store(':memory:')
        const review = { id: 'r1', decision: 'yes', reason: 'bright corner unit' }
        // Reviewed before the row had a category: the review gains it once the row does.
        workerRecords.upsert('default', 's1', [{ key: 'office', data: { name: 'Suite 4', approvalReviews: [review] } }])
        workerRecords.upsert('default', 's1', [{ key: 'office', data: { category: 'SoMa' } }])
        // Later edits and deletion must not move or lose it.
        workerRecords.upsert('default', 's1', [{ key: 'office', data: { category: 'Mission' } }])
        workerRecords.remove('default', 's1', 'office')

        const history = workerRecords.reviewHistory('default', 's1')
        expect(history).toHaveLength(1)
        expect(history[0].data.approvalReviews).toEqual([{ ...review, category: 'SoMa' }])
    })

    it('leaves a talent review under the role it was saved with', () => {
        const { workerRecords } = new Store(':memory:')
        const review = { id: 'r1', role: 'Product Designer', decision: 'no', reason: 'no portfolio' }
        workerRecords.upsert('default', 's1', [{ key: 'c', data: { category: 'ignored', linkedinReviews: [review] } }])
        expect(workerRecords.reviewHistory('default', 's1')[0].data.linkedinReviews).toEqual([review])
    })

    it('counts rows nobody has reviewed yet, and recounts after a write', () => {
        const { workerRecords } = new Store(':memory:')
        workerRecords.upsert('default', 's1', [
            { key: 'a', data: { name: 'Ann' } },
            { key: 'b', data: { name: 'Bo', approvalReviews: [{ id: 'r1', decision: 'yes', reason: 'ok' }] } }
        ])
        expect(workerRecords.stats('default').get('s1')).toMatchObject({ count: 2, unreviewed: 1 })
        expect(workerRecords.stats('default').get('s1')?.newestUnreviewedAt).toBeGreaterThan(0)

        workerRecords.upsert('default', 's1', [{ key: 'a', data: { approvalReviews: [{ id: 'r2', decision: 'no', reason: 'no' }] } }])
        expect(workerRecords.stats('default').get('s1')).toMatchObject({ unreviewed: 0, newestUnreviewedAt: 0 })
    })

    it('moves a board to the session id a worker was resumed under', () => {
        const { workerRecords } = new Store(':memory:')
        workerRecords.upsert('default', 'old', [{ key: 'a', data: { n: 1 } }])
        workerRecords.transfer('old', 'new')

        expect(workerRecords.list('default', 'old')).toHaveLength(0)
        expect(workerRecords.list('default', 'new')).toHaveLength(1)
    })
})
