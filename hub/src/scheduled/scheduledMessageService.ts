import type { Store, ScheduledMessageRow } from '../store'
import type { Session, SyncEngine } from '../sync/syncEngine'

const POLL_MS = 5_000
const NON_RECURRING_SKIP_DELAY_MS = 60_000

export class ScheduledMessageService {
    private timer: ReturnType<typeof setInterval> | null = null
    private running = false

    constructor(
        private readonly store: Store,
        private readonly getSyncEngine: () => SyncEngine | null
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
            for (const job of this.store.scheduledMessages.due(Date.now())) {
                await this.runJob(engine, job)
            }
        } finally {
            this.running = false
        }
    }

    private async runJob(engine: SyncEngine, job: ScheduledMessageRow): Promise<void> {
        try {
            const source = engine.getSession(job.sourceSessionId)
            if (!source) {
                throw new Error('Source session not found')
            }
            if (this.isSessionBusy(source)) {
                this.skipRunningJob(job, 'Source session is currently running')
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
                this.skipRunningJob(job, 'Target session is currently running')
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
        } catch (error) {
            this.store.scheduledMessages.markFailed(job.id, error instanceof Error ? error.message : 'Scheduled send failed')
        }
    }

    private skipRunningJob(job: ScheduledMessageRow, reason: string): void {
        const now = Date.now()
        const nextDueAt = job.intervalMs && job.intervalMs > 0
            ? Math.max(now + job.intervalMs, job.dueAt + job.intervalMs)
            : now + NON_RECURRING_SKIP_DELAY_MS
        this.store.scheduledMessages.markSkipped(job.id, reason, nextDueAt)
    }

    private isSessionBusy(session: Session): boolean {
        const pendingRequests = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0
        return Boolean(session.active && (session.thinking || pendingRequests > 0 || (session.backgroundTaskCount ?? 0) > 0))
    }
}
