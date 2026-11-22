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
