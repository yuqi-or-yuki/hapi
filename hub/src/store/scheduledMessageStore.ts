import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'

export type ScheduledMessageStatus = 'pending' | 'sent' | 'failed' | 'cancelled'
export type ScheduledMessageHistoryEvent = 'created' | 'updated' | 'sent' | 'failed' | 'cancelled' | 'skipped' | 'enabled' | 'disabled'

export type ScheduledMessageHistoryRow = {
    id: string
    scheduledMessageId: string
    namespace: string
    event: ScheduledMessageHistoryEvent
    sourceSessionId: string
    targetSessionId: string | null
    text: string
    dueAt: number
    cloneBeforeSend: boolean
    intervalMs: number | null
    maxOccurrences: number | null
    occurrenceCount: number
    enabled: boolean
    status: ScheduledMessageStatus
    error: string | null
    createdAt: number
}

export type ScheduledMessageRow = {
    id: string
    namespace: string
    sourceSessionId: string
    targetSessionId: string | null
    text: string
    dueAt: number
    cloneBeforeSend: boolean
    intervalMs: number | null
    maxOccurrences: number | null
    occurrenceCount: number
    enabled: boolean
    status: ScheduledMessageStatus
    error: string | null
    createdAt: number
    updatedAt: number
    sentAt: number | null
    history: ScheduledMessageHistoryRow[]
}

/** Default cap on total sends for a repeating schedule when the caller doesn't specify one.
 *  `null` (forever) must be requested explicitly. */
const DEFAULT_MAX_OCCURRENCES = 10

type DbRow = {
    id: string
    namespace: string
    source_session_id: string
    target_session_id: string | null
    text: string
    due_at: number
    clone_before_send: number
    interval_ms: number | null
    max_occurrences: number | null
    occurrence_count: number
    enabled: number
    status: ScheduledMessageStatus
    error: string | null
    created_at: number
    updated_at: number
    sent_at: number | null
}

type HistoryDbRow = {
    id: string
    scheduled_message_id: string
    namespace: string
    event: ScheduledMessageHistoryEvent
    source_session_id: string
    target_session_id: string | null
    text: string
    due_at: number
    clone_before_send: number
    interval_ms: number | null
    max_occurrences: number | null
    occurrence_count: number
    enabled: number
    status: ScheduledMessageStatus
    error: string | null
    created_at: number
}

function mapRow(row: DbRow): ScheduledMessageRow {
    return {
        id: row.id,
        namespace: row.namespace,
        sourceSessionId: row.source_session_id,
        targetSessionId: row.target_session_id,
        text: row.text,
        dueAt: row.due_at,
        cloneBeforeSend: row.clone_before_send === 1,
        intervalMs: row.interval_ms,
        maxOccurrences: row.max_occurrences,
        occurrenceCount: row.occurrence_count,
        enabled: row.enabled !== 0,
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sentAt: row.sent_at,
        history: []
    }
}

function mapHistoryRow(row: HistoryDbRow): ScheduledMessageHistoryRow {
    return {
        id: row.id,
        scheduledMessageId: row.scheduled_message_id,
        namespace: row.namespace,
        event: row.event,
        sourceSessionId: row.source_session_id,
        targetSessionId: row.target_session_id,
        text: row.text,
        dueAt: row.due_at,
        cloneBeforeSend: row.clone_before_send === 1,
        intervalMs: row.interval_ms,
        maxOccurrences: row.max_occurrences,
        occurrenceCount: row.occurrence_count,
        enabled: row.enabled !== 0,
        status: row.status,
        error: row.error,
        createdAt: row.created_at
    }
}

export class ScheduledMessageStore {
    constructor(private readonly db: Database) {}

    create(input: {
        namespace: string
        sourceSessionId: string
        text: string
        dueAt: number
        cloneBeforeSend: boolean
        intervalMs?: number | null
        /** Cap on total sends for a repeating schedule. Omit for the default of 10;
         *  pass `null` explicitly to repeat forever. Ignored for one-shot schedules. */
        maxOccurrences?: number | null
        enabled?: boolean
    }): ScheduledMessageRow {
        const now = Date.now()
        const isRepeating = Boolean(input.intervalMs && input.intervalMs > 0)
        const row = {
            id: randomUUID(),
            namespace: input.namespace,
            source_session_id: input.sourceSessionId,
            target_session_id: null,
            text: input.text,
            due_at: input.dueAt,
            clone_before_send: input.cloneBeforeSend ? 1 : 0,
            interval_ms: input.intervalMs ?? null,
            max_occurrences: isRepeating
                ? (input.maxOccurrences === undefined ? DEFAULT_MAX_OCCURRENCES : input.maxOccurrences)
                : null,
            occurrence_count: 0,
            enabled: input.enabled === false ? 0 : 1,
            status: 'pending' as ScheduledMessageStatus,
            error: null,
            created_at: now,
            updated_at: now,
            sent_at: null
        }

        this.db.query(`
            INSERT INTO scheduled_messages (
                id, namespace, source_session_id, target_session_id, text, due_at,
                clone_before_send, interval_ms, max_occurrences, occurrence_count, enabled, status, error, created_at, updated_at, sent_at
            ) VALUES (
                $id, $namespace, $source_session_id, $target_session_id, $text, $due_at,
                $clone_before_send, $interval_ms, $max_occurrences, $occurrence_count, $enabled, $status, $error, $created_at, $updated_at, $sent_at
            )
        `).run(row)

        const created = mapRow(row)
        this.recordHistory(created, 'created')
        return { ...created, history: this.historyForId(created.id) }
    }

    listForSession(namespace: string, sessionId: string): ScheduledMessageRow[] {
        return this.db.query<DbRow, [string, string]>(`
            SELECT * FROM scheduled_messages
            WHERE namespace = ? AND source_session_id = ? AND status = 'pending'
            ORDER BY due_at ASC, created_at ASC
        `).all(namespace, sessionId).map(mapRow).map(row => this.withHistory(row))
    }

    list(namespace: string, options: { status?: ScheduledMessageStatus | 'all'; limit?: number } = {}): ScheduledMessageRow[] {
        const limit = options.limit ?? 200
        if (options.status && options.status !== 'all') {
            return this.db.query<DbRow, [string, ScheduledMessageStatus, number]>(`
                SELECT * FROM scheduled_messages
                WHERE namespace = ? AND status = ?
                ORDER BY due_at ASC, created_at ASC
                LIMIT ?
            `).all(namespace, options.status, limit).map(mapRow).map(row => this.withHistory(row))
        }
        return this.db.query<DbRow, [string, number]>(`
            SELECT * FROM scheduled_messages
            WHERE namespace = ?
            ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, due_at ASC, created_at ASC
            LIMIT ?
        `).all(namespace, limit).map(mapRow).map(row => this.withHistory(row))
    }

    update(namespace: string, id: string, patch: {
        sourceSessionId?: string
        text?: string
        dueAt?: number
        cloneBeforeSend?: boolean
        intervalMs?: number | null
        maxOccurrences?: number | null
        enabled?: boolean
    }): ScheduledMessageRow | null {
        const existing = this.get(namespace, id)
        if (!existing || existing.status !== 'pending') return null
        const nextEnabled = patch.enabled ?? existing.enabled
        const nextIntervalMs = patch.intervalMs === undefined ? existing.intervalMs : patch.intervalMs
        const nextIsRepeating = Boolean(nextIntervalMs && nextIntervalMs > 0)
        const nextMaxOccurrences = !nextIsRepeating
            ? null
            : (patch.maxOccurrences === undefined ? existing.maxOccurrences : patch.maxOccurrences)
        const next = {
            id,
            namespace,
            source_session_id: patch.sourceSessionId ?? existing.sourceSessionId,
            text: patch.text ?? existing.text,
            due_at: patch.dueAt ?? existing.dueAt,
            clone_before_send: (patch.cloneBeforeSend ?? existing.cloneBeforeSend) ? 1 : 0,
            interval_ms: nextIntervalMs,
            max_occurrences: nextMaxOccurrences,
            enabled: nextEnabled ? 1 : 0,
            updated_at: Date.now()
        }
        this.db.query(`
            UPDATE scheduled_messages
            SET source_session_id = $source_session_id, text = $text, due_at = $due_at, clone_before_send = $clone_before_send, interval_ms = $interval_ms, max_occurrences = $max_occurrences, enabled = $enabled, updated_at = $updated_at
            WHERE id = $id AND namespace = $namespace AND status = 'pending'
        `).run(next)
        const updated = this.get(namespace, id)
        if (updated) {
            const event = existing.enabled !== updated.enabled
                ? (updated.enabled ? 'enabled' : 'disabled')
                : 'updated'
            this.recordHistory(updated, event)
        }
        return updated ? this.withHistory(updated) : null
    }

    due(now: number, limit = 20): ScheduledMessageRow[] {
        return this.db.query<DbRow, [number, number]>(`
            SELECT * FROM scheduled_messages
            WHERE status = 'pending' AND enabled = 1 AND due_at <= ?
            ORDER BY due_at ASC, created_at ASC
            LIMIT ?
        `).all(now, limit).map(mapRow)
    }

    cancel(namespace: string, id: string): ScheduledMessageRow | null {
        const now = Date.now()
        const existing = this.get(namespace, id)
        if (!existing || existing.status !== 'pending') return null
        this.db.query(`
            UPDATE scheduled_messages
            SET status = 'cancelled', updated_at = $updated_at
            WHERE id = $id AND namespace = $namespace AND status = 'pending'
        `).run({ id, namespace, updated_at: now })
        const cancelled = this.get(namespace, id)
        if (cancelled?.status === 'cancelled') this.recordHistory(cancelled, 'cancelled')
        return cancelled ? this.withHistory(cancelled) : null
    }

    markSent(id: string, targetSessionId: string): void {
        const now = Date.now()
        const job = this.getById(id)
        if (job) this.recordHistory({ ...job, targetSessionId, status: 'sent', sentAt: now, occurrenceCount: job.occurrenceCount + 1 }, 'sent')
        const occurrenceCount = (job?.occurrenceCount ?? 0) + 1
        const underLimit = job?.maxOccurrences === null || job?.maxOccurrences === undefined || occurrenceCount < job.maxOccurrences
        if (job?.intervalMs && job.intervalMs > 0 && underLimit) {
            const nextDueAt = Math.max(now + job.intervalMs, job.dueAt + job.intervalMs)
            this.db.query(`
                UPDATE scheduled_messages
                SET target_session_id = $target_session_id, due_at = $due_at, occurrence_count = $occurrence_count, sent_at = $sent_at, updated_at = $updated_at, error = NULL
                WHERE id = $id AND status = 'pending'
            `).run({ id, target_session_id: targetSessionId, due_at: nextDueAt, occurrence_count: occurrenceCount, sent_at: now, updated_at: now })
            return
        }
        this.db.query(`
            UPDATE scheduled_messages
            SET status = 'sent', target_session_id = $target_session_id, occurrence_count = $occurrence_count, sent_at = $sent_at, updated_at = $updated_at, error = NULL
            WHERE id = $id AND status = 'pending'
        `).run({ id, target_session_id: targetSessionId, occurrence_count: occurrenceCount, sent_at: now, updated_at: now })
    }

    markFailed(id: string, error: string): void {
        const now = Date.now()
        const job = this.getById(id)
        if (job) this.recordHistory({ ...job, error, status: 'failed' }, 'failed')
        this.db.query(`
            UPDATE scheduled_messages
            SET status = 'failed', error = $error, updated_at = $updated_at
            WHERE id = $id AND status = 'pending'
        `).run({ id, error, updated_at: now })
    }

    markSkipped(id: string, reason: string, nextDueAt: number): void {
        const now = Date.now()
        const job = this.getById(id)
        if (job) this.recordHistory({ ...job, dueAt: nextDueAt, error: reason }, 'skipped')
        this.db.query(`
            UPDATE scheduled_messages
            SET due_at = $due_at, updated_at = $updated_at
            WHERE id = $id AND status = 'pending'
        `).run({ id, due_at: nextDueAt, updated_at: now })
    }

    private get(namespace: string, id: string): ScheduledMessageRow | null {
        const row = this.db.query<DbRow, [string, string]>(`
            SELECT * FROM scheduled_messages WHERE namespace = ? AND id = ?
        `).get(namespace, id)
        return row ? this.withHistory(mapRow(row)) : null
    }

    private getById(id: string): ScheduledMessageRow | null {
        const row = this.db.query<DbRow, [string]>(`
            SELECT * FROM scheduled_messages WHERE id = ?
        `).get(id)
        return row ? mapRow(row) : null
    }

    private withHistory(row: ScheduledMessageRow): ScheduledMessageRow {
        return { ...row, history: this.historyForId(row.id) }
    }

    private historyForId(id: string): ScheduledMessageHistoryRow[] {
        return this.db.query<HistoryDbRow, [string]>(`
            SELECT * FROM scheduled_message_history
            WHERE scheduled_message_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 100
        `).all(id).map(mapHistoryRow)
    }

    private recordHistory(job: ScheduledMessageRow, event: ScheduledMessageHistoryEvent): void {
        this.db.query(`
            INSERT INTO scheduled_message_history (
                id, scheduled_message_id, namespace, event, source_session_id, target_session_id, text, due_at,
                clone_before_send, interval_ms, max_occurrences, occurrence_count, enabled, status, error, created_at
            ) VALUES (
                $id, $scheduled_message_id, $namespace, $event, $source_session_id, $target_session_id, $text, $due_at,
                $clone_before_send, $interval_ms, $max_occurrences, $occurrence_count, $enabled, $status, $error, $created_at
            )
        `).run({
            id: randomUUID(),
            scheduled_message_id: job.id,
            namespace: job.namespace,
            event,
            source_session_id: job.sourceSessionId,
            target_session_id: job.targetSessionId,
            text: job.text,
            due_at: job.dueAt,
            clone_before_send: job.cloneBeforeSend ? 1 : 0,
            interval_ms: job.intervalMs,
            max_occurrences: job.maxOccurrences,
            occurrence_count: job.occurrenceCount,
            enabled: job.enabled ? 1 : 0,
            status: job.status,
            error: job.error,
            created_at: Date.now()
        })
    }
}
