import { describe, expect, it } from 'vitest'
import { nextDailyRun } from '@hapi/protocol/workerSchedule'
import { parseRows } from './worker'

describe('parseRows', () => {
    it('accepts flat rows, nested rows and a single object', () => {
        expect(parseRows([{ key: 'a', name: 'Ann' }, { key: 'b', data: { name: 'Bo' } }])).toEqual([
            { key: 'a', data: { name: 'Ann' } },
            { key: 'b', data: { name: 'Bo' } }
        ])
        expect(parseRows({ key: 7, sent: true })).toEqual([{ key: '7', data: { sent: true } }])
    })

    it('rejects a row with no key', () => {
        expect(() => parseRows([{ name: 'Ann' }])).toThrow('no "key"')
    })
})

describe('nextDailyRun', () => {
    it('picks today when the time is still ahead, otherwise tomorrow', () => {
        const now = new Date(2026, 0, 1, 10, 0).getTime()
        expect(nextDailyRun('14:30', now)).toBe(new Date(2026, 0, 1, 14, 30).getTime())
        expect(nextDailyRun('09:00', now)).toBe(new Date(2026, 0, 2, 9, 0).getTime())
        expect(() => nextDailyRun('25:00', now)).toThrow('Invalid time of day')
    })
})
