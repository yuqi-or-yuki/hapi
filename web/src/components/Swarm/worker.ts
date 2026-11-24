import type { SwarmScheduleRequest } from '@hapi/protocol/apiTypes'
import type { ActiveWindow } from '@hapi/protocol/schemas'
import { permissionAutonomy, type PermissionAutonomy } from '@hapi/protocol/modes'
import { nextDailyRun } from '@hapi/protocol/workerSchedule'
import { isItemApprovalBoard } from '@hapi/protocol/workerReview'
import type { SessionSummary } from '@/types/api'

type Translate = (key: string, params?: Record<string, string | number>) => string
type WorkerRun = NonNullable<SessionSummary['workerRun']>
type WorkerIdentitySource = {
    id: string
    metadata?: {
        name?: string
        summary?: { text: string }
        swarm?: { name?: string; job?: string; avatarSeed?: string }
    } | null
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** FNV-1a: small, stable across devices, and good enough to spread seeds over a palette. */
export function hashSeed(seed: string): number {
    let hash = 0x811c9dc5
    for (let i = 0; i < seed.length; i += 1) {
        hash ^= seed.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
}

export function workerSeed(session: WorkerIdentitySource): string {
    return session.metadata?.swarm?.avatarSeed ?? session.id
}

/**
 * A worker is called by what it does ("Talent Intake", "Laptop Cleaner"), in
 * two or three words, so the swarm reads as a list of functions. Until one is
 * set, fall back to something that still says what it does, never to an
 * invented personal name: the session's title, then the start of its job.
 */
export function workerName(session: WorkerIdentitySource): string {
    const meta = session.metadata
    const title = meta?.swarm?.name?.trim() || meta?.name?.trim() || meta?.summary?.text?.trim()
    if (title) return title
    return (meta?.swarm?.job ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join(' ')
}

export function randomSeed(): string {
    return Math.random().toString(36).slice(2, 12)
}

export type ScheduleDraft =
    | { mode: 'none' }
    | { mode: 'every'; every: number; unit: 'minutes' | 'hours' }
    | { mode: 'daily'; time: string }

function pad(value: number): string {
    return String(value).padStart(2, '0')
}

export function draftFromRun(run: WorkerRun | undefined): ScheduleDraft {
    if (!run) return { mode: 'none' }
    if (run.intervalMs === DAY) {
        const at = new Date(run.nextRunAt)
        return { mode: 'daily', time: `${pad(at.getHours())}:${pad(at.getMinutes())}` }
    }
    return run.intervalMs % HOUR === 0
        ? { mode: 'every', every: run.intervalMs / HOUR, unit: 'hours' }
        : { mode: 'every', every: Math.max(1, Math.round(run.intervalMs / MINUTE)), unit: 'minutes' }
}

/** `null` removes the schedule. Daily runs start at the next time the clock reads `time`. */
export function draftToRequest(draft: ScheduleDraft, now: number): SwarmScheduleRequest | null {
    if (draft.mode === 'none') return null
    if (draft.mode === 'every') {
        const intervalMs = Math.max(1, Math.floor(draft.every)) * (draft.unit === 'hours' ? HOUR : MINUTE)
        return { intervalMs, firstRunAt: now + intervalMs }
    }
    return { intervalMs: DAY, firstRunAt: nextDailyRun(draft.time, now) }
}

export function sameDraft(a: ScheduleDraft, b: ScheduleDraft): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

function describeCadence(run: WorkerRun, t: Translate): string {
    const draft = draftFromRun(run)
    if (draft.mode === 'daily') {
        const time = new Date(run.nextRunAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        return t('swarm.schedule.dailyAt', { time })
    }
    if (draft.mode === 'every') {
        return t(draft.unit === 'hours' ? 'swarm.schedule.everyHours' : 'swarm.schedule.everyMinutes', { n: draft.every })
    }
    return ''
}

function hourLabel(hour: number): string {
    return new Date(2000, 0, 1, hour % 24).toLocaleTimeString(undefined, { hour: 'numeric' })
}

/** "Every 2h, weekdays 9 AM–5 PM": the cadence plus the window that limits it, if any. */
export function describeSchedule(run: WorkerRun, t: Translate, window?: ActiveWindow): string {
    const limits = [
        window?.weekdaysOnly ? t('swarm.schedule.weekdays') : '',
        window?.startHour !== undefined && window.endHour !== undefined ? `${hourLabel(window.startHour)}–${hourLabel(window.endHour)}` : ''
    ].filter(Boolean).join(' ')
    return limits ? `${describeCadence(run, t)}, ${limits}` : describeCadence(run, t)
}

/**
 * The worker's state as the operator needs it: is it busy, is something wrong,
 * and otherwise when does it work next. Whether the process happens to be
 * alive is deliberately not a state; the hub wakes a worker for each run.
 */
export type WorkerState = 'working' | 'failing' | 'scheduled' | 'paused' | 'onDemand'

export function workerState(session: SessionSummary): WorkerState {
    const run = session.workerRun
    if (session.active && session.thinking) return 'working'
    if (!run) return 'onDemand'
    if (run.paused) return 'paused'
    return run.lastError ? 'failing' : 'scheduled'
}

/**
 * How far a worker may go before it stops and asks. Read from the session's
 * real permission mode rather than stored on the swarm record, so the badge
 * can never claim more (or less) freedom than the agent actually has.
 */
export function trustLevel(session: SessionSummary): PermissionAutonomy | 'unknown' {
    return permissionAutonomy(session.permissionMode)
}

const SEEN_KEY = 'hapi.swarm.reviewSeen.v1'

function readSeen(): Record<string, number> {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
        return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {}
    } catch {
        return {}
    }
}

/**
 * How many cards a worker has waiting that the user has not looked at yet.
 * "New" is judged against the last time this browser opened the worker's
 * page, so the dot clears by looking, not by finishing every review: a board
 * with a hundred pending cards should not shout forever.
 */
export function newToReview(session: SessionSummary): number {
    const board = session.workerBoard
    if (!board?.unreviewed || !isItemApprovalBoard(session.metadata?.swarm?.board)) return 0
    return board.newestUnreviewedAt > (readSeen()[session.id] ?? 0) ? board.unreviewed : 0
}

/** Called when the worker's page is shown: everything on its board up to now counts as seen. */
export function markReviewSeen(sessionId: string): void {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [sessionId]: Date.now() }))
    } catch {
        // Private mode or a full store: the dot simply stays until the next visit.
    }
}

/** On time means the run started within a few scheduler ticks of its slot. */
export const ON_TIME_MS = 5 * 60_000

export type RunMark = 'onTime' | 'late' | 'missed'

export function runMark(event: WorkerRun['recent'][number]): RunMark {
    if (event.outcome === 'missed') return 'missed'
    return event.lateMs <= ON_TIME_MS ? 'onTime' : 'late'
}
