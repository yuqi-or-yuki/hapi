import type { Database } from 'bun:sqlite'

/** "from's approved items go to to": one stage of a pipeline feeding the next. */
export type WorkerLink = {
    from: string
    to: string
    createdAt: number
    /** Items handed over that the downstream worker has not marked handled yet. */
    pending: number
    handled: number
}

export type InboxItem = {
    from: string
    key: string
    queuedAt: number
    data: Record<string, unknown>
}

/**
 * Pipelines between swarm workers. A link says one worker's approved board
 * rows are another worker's input; the inbox is the queue of rows handed over
 * and not yet handled. Rows are referenced, not copied: the inbox reads the
 * upstream board as it is now.
 *
 * Tables are ensured here instead of through the migration ladder, like the
 * boards themselves: new, empty and self-contained.
 */
export class WorkerPipelineStore {
    constructor(private readonly db: Database) {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS worker_links (
                namespace TEXT NOT NULL,
                from_session TEXT NOT NULL,
                to_session TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                wake_schedule_id TEXT,
                PRIMARY KEY (from_session, to_session)
            );
            CREATE TABLE IF NOT EXISTS worker_inbox (
                namespace TEXT NOT NULL,
                to_session TEXT NOT NULL,
                from_session TEXT NOT NULL,
                key TEXT NOT NULL,
                queued_at INTEGER NOT NULL,
                handled_at INTEGER,
                PRIMARY KEY (to_session, from_session, key)
            );
        `)
    }

    /** Refuses a link that would make a worker feed itself, directly or around a loop. */
    link(namespace: string, from: string, to: string): void {
        if (from === to) throw new Error('A worker cannot feed itself')
        const seen = new Set<string>([to])
        const queue = [to]
        while (queue.length > 0) {
            for (const next of this.downstream(namespace, queue.shift()!)) {
                if (next === from) throw new Error('That link would make the pipeline loop back on itself')
                if (!seen.has(next)) { seen.add(next); queue.push(next) }
            }
        }
        this.db.query('INSERT OR IGNORE INTO worker_links (namespace, from_session, to_session, created_at) VALUES (?, ?, ?, ?)')
            .run(namespace, from, to, Date.now())
    }

    unlink(namespace: string, from: string, to: string): boolean {
        this.db.query('DELETE FROM worker_inbox WHERE namespace = ? AND from_session = ? AND to_session = ? AND handled_at IS NULL').run(namespace, from, to)
        return this.db.query('DELETE FROM worker_links WHERE namespace = ? AND from_session = ? AND to_session = ?').run(namespace, from, to).changes > 0
    }

    downstream(namespace: string, from: string): string[] {
        return this.db.query<{ to_session: string }, [string, string]>(
            'SELECT to_session FROM worker_links WHERE namespace = ? AND from_session = ? ORDER BY created_at'
        ).all(namespace, from).map((row) => row.to_session)
    }

    links(namespace: string): WorkerLink[] {
        return this.db.query<{ from_session: string; to_session: string; created_at: number; pending: number; handled: number }, [string]>(`
            SELECT l.from_session, l.to_session, l.created_at,
                (SELECT COUNT(*) FROM worker_inbox i WHERE i.from_session = l.from_session AND i.to_session = l.to_session AND i.handled_at IS NULL) AS pending,
                (SELECT COUNT(*) FROM worker_inbox i WHERE i.from_session = l.from_session AND i.to_session = l.to_session AND i.handled_at IS NOT NULL) AS handled
            FROM worker_links l WHERE l.namespace = ? ORDER BY l.created_at
        `).all(namespace).map((row) => ({ from: row.from_session, to: row.to_session, createdAt: row.created_at, pending: row.pending, handled: row.handled }))
    }

    /** True when the two workers share a link in either direction. */
    linked(namespace: string, a: string, b: string): boolean {
        return this.db.query<{ n: number }, [string, string, string, string, string]>(`
            SELECT COUNT(*) AS n FROM worker_links
            WHERE namespace = ? AND ((from_session = ? AND to_session = ?) OR (from_session = ? AND to_session = ?))
        `).get(namespace, a, b, b, a)!.n > 0
    }

    /** Queue an approved row for a downstream worker. Returns false if it was already handed over. */
    enqueue(namespace: string, from: string, to: string, key: string): boolean {
        return this.db.query('INSERT OR IGNORE INTO worker_inbox (namespace, to_session, from_session, key, queued_at) VALUES (?, ?, ?, ?, ?)')
            .run(namespace, to, from, key, Date.now()).changes > 0
    }

    /** An approval that was taken back before the downstream worker handled it leaves the queue. */
    withdraw(namespace: string, from: string, key: string): void {
        this.db.query('DELETE FROM worker_inbox WHERE namespace = ? AND from_session = ? AND key = ? AND handled_at IS NULL').run(namespace, from, key)
    }

    inbox(namespace: string, to: string): InboxItem[] {
        return this.db.query<{ from_session: string; key: string; queued_at: number; data: string | null }, [string, string]>(`
            SELECT i.from_session, i.key, i.queued_at, r.data
            FROM worker_inbox i LEFT JOIN worker_records r ON r.session_id = i.from_session AND r.key = i.key
            WHERE i.namespace = ? AND i.to_session = ? AND i.handled_at IS NULL
            ORDER BY i.queued_at, i.key
        `).all(namespace, to).map((row) => {
            let data: Record<string, unknown> = {}
            try { data = row.data ? JSON.parse(row.data) : {} } catch { /* shown empty */ }
            return { from: row.from_session, key: row.key, queuedAt: row.queued_at, data }
        })
    }

    markHandled(namespace: string, to: string, keys: readonly string[]): number {
        const mark = this.db.query('UPDATE worker_inbox SET handled_at = ? WHERE namespace = ? AND to_session = ? AND key = ? AND handled_at IS NULL')
        let count = 0
        const now = Date.now()
        for (const key of keys) count += mark.run(now, namespace, to, key).changes
        return count
    }

    wakeScheduleId(from: string, to: string): string | null {
        return this.db.query<{ wake_schedule_id: string | null }, [string, string]>(
            'SELECT wake_schedule_id FROM worker_links WHERE from_session = ? AND to_session = ?'
        ).get(from, to)?.wake_schedule_id ?? null
    }

    setWakeScheduleId(from: string, to: string, scheduleId: string): void {
        this.db.query('UPDATE worker_links SET wake_schedule_id = ? WHERE from_session = ? AND to_session = ?').run(scheduleId, from, to)
    }

    /** A worker retired from the swarm leaves every pipeline it was in. */
    removeWorker(namespace: string, sessionId: string): void {
        this.db.query('DELETE FROM worker_links WHERE namespace = ? AND (from_session = ? OR to_session = ?)').run(namespace, sessionId, sessionId)
        this.db.query('DELETE FROM worker_inbox WHERE namespace = ? AND (from_session = ? OR to_session = ?) AND handled_at IS NULL').run(namespace, sessionId, sessionId)
    }

    /** A worker resumed under a new session id keeps its place in its pipelines. */
    transfer(oldSessionId: string, newSessionId: string): void {
        for (const [table, column] of [['worker_links', 'from_session'], ['worker_links', 'to_session'], ['worker_inbox', 'from_session'], ['worker_inbox', 'to_session']] as const) {
            this.db.query(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newSessionId, oldSessionId)
            this.db.query(`DELETE FROM ${table} WHERE ${column} = ?`).run(oldSessionId)
        }
    }
}
