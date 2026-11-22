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

    it('moves a board to the session id a worker was resumed under', () => {
        const { workerRecords } = new Store(':memory:')
        workerRecords.upsert('default', 'old', [{ key: 'a', data: { n: 1 } }])
        workerRecords.transfer('old', 'new')

        expect(workerRecords.list('default', 'old')).toHaveLength(0)
        expect(workerRecords.list('default', 'new')).toHaveLength(1)
    })
})
