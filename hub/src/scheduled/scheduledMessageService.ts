import type { Store, ScheduledMessageRow } from '../store'
import { currentSlot } from '../store/scheduledMessageStore'
import type { ActiveWindow } from '@hapi/protocol/schemas'
import { isWithinWindow } from '@hapi/protocol/workerSchedule'
import type { Session, SyncEngine } from '../sync/syncEngine'

const POLL_MS = 30_000
const NON_RECURRING_SKIP_DELAY_MS = 60_000
/** A repeating job that finds its session busy tries again this soon, not next interval. */
const BUSY_RETRY_MS = 2 * 60_000
const FAILURE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]
/** Consecutive failed attempts before the operator is told. */
const ALERT_AFTER_FAILURES = 3

export type ScheduledAlert = (session: Session, summary: string) => void

/**
 * Per-job retry bookkeeping. Kept in memory on purpose: the job's `dueAt` is
 * never moved for a retry (that would lose the schedule's phase), and a hub
 * restart simply retries straight away.
 */
type Attempt = {
    notBefore: number
    failures: number
    alerted: boolean
}

export class ScheduledMessageService {
    private timer: ReturnType<typeof setInterval> | null = null
    private running = false
    private readonly attempts = new Map<string, Attempt>()

    constructor(
        private readonly store: Store,
        private readonly getSyncEngine: () => SyncEngine | null,
        private readonly alert?: ScheduledAlert
    ) {}

    start(): void {
        if (this.timer) return
        this.timer = setInterval(() => void this.tick(), POLL_MS)
        void this.tick()
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    async tick(): Promise<void> {
        if (this.running) return
        const engine = this.getSyncEngine()
        if (!engine) return
        this.running = true
        try {
            const now = Date.now()
            const due = this.store.scheduledMessages.due(now)
            const dueIds = new Set(due.map((job) => job.id))
            for (const id of this.attempts.keys()) {
                // Sent, cancelled, disabled or re-timed since we last tried.
                if (!dueIds.has(id)) this.attempts.delete(id)
            }
            for (const job of due) {
                if (this.restArchivedWorker(engine, job, now)) continue
                if (this.deferToWindow(engine, job)) continue
                await this.runJob(engine, this.settleMissedSlot(engine, job, now))
            }
        } finally {
            this.running = false
        }
    }

    /** The active window of the worker this job is the schedule of, if it has one. */
    private windowFor(engine: SyncEngine, job: ScheduledMessageRow): ActiveWindow | undefined {
        const swarm = engine.getSession(job.sourceSessionId)?.metadata?.swarm
        return swarm?.scheduleId === job.id ? swarm.activeWindow : undefined
    }

    /**
     * An archived worker is off the swarm: its schedule must not wake it. The
     * schedule is kept and simply passes over each slot, so reopening the
     * session resumes the job at its next run with nothing to set up again.
     */
    private restArchivedWorker(engine: SyncEngine, job: ScheduledMessageRow, now: number): boolean {
        const session = engine.getSession(job.sourceSessionId)
        const isWorkerSchedule = session?.metadata?.swarm?.scheduleId === job.id
        if (!isWorkerSchedule || session?.metadata?.lifecycleState !== 'archived' || !isRepeating(job)) return false
        this.store.scheduledMessages.skipSlot(job.id, now)
        this.attempts.delete(job.id)
        return true
    }

    /**
     * A slot outside the worker's active window (a weekend, the middle of the
     * night) is not run at all: the worker is not woken, and the job moves to
     * its next slot inside the window. Judged by the slot, not by the clock,
     * so a run that is merely late for a slot inside the window still goes.
     */
    private deferToWindow(engine: SyncEngine, job: ScheduledMessageRow): boolean {
        const window = this.windowFor(engine, job)
        if (!window || isWithinWindow(job.dueAt, window)) return false
        this.store.scheduledMessages.alignToWindow(job.id, window)
        this.attempts.delete(job.id)
        return true
    }

    /**
     * A repeating job that spent a whole interval failing or waiting has
     * missed that run: record it, tell the operator, and move on to the slot
     * that is owed now instead of retrying a run that is already stale.
     */
    private settleMissedSlot(engine: SyncEngine, job: ScheduledMessageRow, now: number): ScheduledMessageRow {
        const attempt = this.attempts.get(job.id)
        if (!attempt || !isRepeating(job) || now < job.dueAt + job.intervalMs) return job

        const reason = job.error ? `Missed a run: ${job.error}` : 'Missed a run: session was busy the whole interval'
        const dueAt = currentSlot(job.dueAt, job.intervalMs, now)
        this.store.scheduledMessages.markSkipped(job.id, reason, dueAt)
        attempt.notBefore = 0
        this.raise(engine, job, attempt, reason)
        return { ...job, dueAt, error: reason }
    }

    private async runJob(engine: SyncEngine, job: ScheduledMessageRow): Promise<void> {
        const attempt = this.attempts.get(job.id)
        if (attempt && Date.now() < attempt.notBefore) return

        try {
            const source = engine.getSession(job.sourceSessionId)
            if (!source) {
                this.abandonJob(job, 'Source session no longer exists')
                return
            }
            if (this.isSessionBusy(source)) {
                this.deferBusyJob(job, 'Source session is currently running')
                return
            }

            let targetSessionId = job.sourceSessionId
            if (job.cloneBeforeSend) {
                const cloned = engine.cloneSession(job.sourceSessionId, job.namespace)
                targetSessionId = cloned.id
            }

            const target = engine.getSession(targetSessionId)
            if (!target) {
                throw new Error('Target session not found')
            }
            if (this.isSessionBusy(target)) {
                this.deferBusyJob(job, 'Target session is currently running')
                return
            }

            if (!target.active) {
                const resumed = await engine.resumeSession(targetSessionId, job.namespace)
                if (resumed.type !== 'success') {
                    throw new Error(resumed.message)
                }
                targetSessionId = resumed.sessionId
            }

            await engine.sendMessage(targetSessionId, {
                text: job.text,
                sentFrom: 'webapp'
            })
            this.store.scheduledMessages.markSent(job.id, targetSessionId)
            this.attempts.delete(job.id)
            // So the card shows the real next run (Monday 9:00), not a slot that will be skipped.
            const window = this.windowFor(engine, job)
            if (window) this.store.scheduledMessages.alignToWindow(job.id, window)
        } catch (error) {
            this.failJob(engine, job, error instanceof Error ? error.message : 'Scheduled send failed')
        }
    }

    private failJob(engine: SyncEngine, job: ScheduledMessageRow, message: string): void {
        if (!isRepeating(job)) {
            this.store.scheduledMessages.markFailed(job.id, message)
            this.notify(engine, job, `Scheduled message failed: ${message}`)
            return
        }

        const attempt = this.attemptFor(job.id)
        attempt.failures += 1
        attempt.notBefore = Date.now() + FAILURE_BACKOFF_MS[Math.min(attempt.failures, FAILURE_BACKOFF_MS.length) - 1]
        this.store.scheduledMessages.markRetry(job.id, message)
        if (attempt.failures >= ALERT_AFTER_FAILURES) {
            this.raise(engine, job, attempt, `Scheduled run keeps failing (${attempt.failures} tries): ${message}`)
        }
    }

    /**
     * The session this job belongs to is gone for good, so there is nothing to
     * retry: end the schedule instead of failing every poll forever.
     *
     * `engine.getSession` already falls back to the store, so a miss is a
     * deleted session and not a cold cache. Deleting a worker leaves its
     * schedule behind; without this, each orphan kept waking the scheduler,
     * writing a failure row and retrying for as long as the hub ran.
     */
    private abandonJob(job: ScheduledMessageRow, reason: string): void {
        this.store.scheduledMessages.markFailed(job.id, reason)
        this.attempts.delete(job.id)
    }

    private deferBusyJob(job: ScheduledMessageRow, reason: string): void {
        if (isRepeating(job)) {
            this.attemptFor(job.id).notBefore = Date.now() + BUSY_RETRY_MS
            return
        }
        this.store.scheduledMessages.markSkipped(job.id, reason, Date.now() + NON_RECURRING_SKIP_DELAY_MS)
    }

    private attemptFor(jobId: string): Attempt {
        let attempt = this.attempts.get(jobId)
        if (!attempt) {
            attempt = { notBefore: 0, failures: 0, alerted: false }
            this.attempts.set(jobId, attempt)
        }
        return attempt
    }

    /** One alert per outage: it re-arms only once a run goes through. */
    private raise(engine: SyncEngine, job: ScheduledMessageRow, attempt: Attempt, summary: string): void {
        if (attempt.alerted) return
        attempt.alerted = true
        this.notify(engine, job, summary)
    }

    private notify(engine: SyncEngine, job: ScheduledMessageRow, summary: string): void {
        const session = engine.getSession(job.sourceSessionId)
        if (session) this.alert?.(session, summary)
    }

    private isSessionBusy(session: Session): boolean {
        const pendingRequests = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0
        return Boolean(session.active && (session.thinking || pendingRequests > 0 || (session.backgroundTaskCount ?? 0) > 0))
    }
}

function isRepeating(job: ScheduledMessageRow): job is ScheduledMessageRow & { intervalMs: number } {
    return Boolean(job.intervalMs && job.intervalMs > 0)
}
