import type { ActiveWindow } from './schemas'

/** `HH:MM` on the local clock → the next moment the clock reads that time. Shared by the web dialog and `hapi worker`. */
export function nextDailyRun(time: string, now: number): number {
    const match = time.match(/^(\d{1,2}):(\d{2})$/)
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
        throw new Error(`Invalid time of day: ${time} (expected HH:MM)`)
    }
    const first = new Date(now)
    first.setHours(Number(match[1]), Number(match[2]), 0, 0)
    // A minute of margin: the hub rejects schedules that are due immediately.
    if (first.getTime() <= now + 60_000) first.setDate(first.getDate() + 1)
    return first.getTime()
}

/** Whether a moment falls inside a worker's active window, on this machine's local clock. */
export function isWithinWindow(at: number, window: ActiveWindow): boolean {
    const date = new Date(at)
    const day = date.getDay()
    if (window.weekdaysOnly && (day === 0 || day === 6)) return false
    if (window.startHour === undefined || window.endHour === undefined) return true
    const hour = date.getHours() + date.getMinutes() / 60
    return hour >= window.startHour && hour < window.endHour
}

/**
 * The first slot at or after `dueAt` that falls inside the window, stepping
 * in whole intervals so the schedule keeps its phase. Returns `dueAt` when no
 * slot in the next two weeks fits (a window no slot can ever hit), so a
 * mis-set window degrades to "runs as before" instead of "never runs".
 */
export function firstSlotInWindow(dueAt: number, intervalMs: number, window: ActiveWindow): number {
    const limit = dueAt + 14 * 86_400_000
    for (let slot = dueAt; slot <= limit; slot += intervalMs) {
        if (isWithinWindow(slot, window)) return slot
    }
    return dueAt
}
