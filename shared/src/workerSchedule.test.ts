import { describe, expect, it } from 'bun:test'
import { firstSlotInWindow, isWithinWindow } from './workerSchedule'

const HOUR = 3_600_000
// 2026-11-20 is a Friday, 2026-11-22 a Sunday. Local time, like the hub.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const office = { weekdaysOnly: true, startHour: 9, endHour: 17 }

describe('isWithinWindow', () => {
    it('applies weekdays and hours on the local clock, end exclusive', () => {
        expect(isWithinWindow(at(20, 9), office)).toBe(true)
        expect(isWithinWindow(at(20, 16, 59), office)).toBe(true)
        expect(isWithinWindow(at(20, 17), office)).toBe(false)
        expect(isWithinWindow(at(22, 13), office)).toBe(false)
        expect(isWithinWindow(at(22, 13), { startHour: 9, endHour: 17 })).toBe(true)
        expect(isWithinWindow(at(22, 3), {})).toBe(true)
    })
})

describe('firstSlotInWindow', () => {
    it('carries a Friday-evening slot of a 2-hourly schedule to Monday morning, keeping its phase', () => {
        // Slots at :21 past odd hours; the first one inside Mon 9-17 is 9:21.
        expect(firstSlotInWindow(at(20, 17, 21), 2 * HOUR, office)).toBe(at(23, 9, 21))
    })

    it('leaves a slot inside the window alone', () => {
        expect(firstSlotInWindow(at(20, 11, 21), 2 * HOUR, office)).toBe(at(20, 11, 21))
    })

    it('skips the weekend for a daily schedule', () => {
        expect(firstSlotInWindow(at(21, 9), 24 * HOUR, { weekdaysOnly: true })).toBe(at(23, 9))
    })

    it('falls back to the original slot when no slot can ever fit', () => {
        // A daily 20:00 run can never land inside 9-17.
        expect(firstSlotInWindow(at(20, 20), 24 * HOUR, office)).toBe(at(20, 20))
    })
})
