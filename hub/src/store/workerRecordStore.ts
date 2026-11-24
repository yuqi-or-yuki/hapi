import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

/** One row on a worker's board: whatever fields the worker chose to report. */
export type WorkerRecord = {
    key: string
    data: Record<string, unknown>
    createdAt: number
    updatedAt: number
}

export type WorkerBoardStats = {
    count: number
    updatedAt: number
    /** Rows with no saved review, and when the newest of them was added. */
    unreviewed: number
    newestUnreviewedAt: number
}

type DbRow = { key: string; data: string; created_at: number; updated_at: number }

export const MAX_WORKER_RECORDS = 5000

function filled(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function mapRow(row: DbRow): WorkerRecord {
    let data: Record<string, unknown> = {}
    try {
        const parsed: unknown = JSON.parse(row.data)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
    } catch {
        // A row we cannot read is shown empty rather than breaking the whole board.
    }
    return { key: row.key, data, createdAt: row.created_at, updatedAt: row.updated_at }
}

/**
 * The structured output of swarm workers, kept in the hub so a board can be
 * read while its worker is asleep.
 *
 * The table is ensured here instead of through the migration ladder: it is
 * new, empty and self-contained, so creating it idempotently avoids a schema
 * version bump on a large live database.
 */
export class WorkerRecordStore {
    private readonly statsCache = new Map<string, Map<string, WorkerBoardStats>>()

    constructor(private readonly db: Database) {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS worker_records (
                namespace TEXT NOT NULL DEFAULT 'default',
                session_id TEXT NOT NULL,
                key TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, key)
            );
            CREATE TABLE IF NOT EXISTS worker_review_history (
                namespace TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
                event_id TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (session_id, kind, event_id)
            );
        `)
    }

    private archiveReviews(namespace: string, sessionId: string, data: Record<string, unknown>): void {
        const insert = this.db.query('INSERT OR IGNORE INTO worker_review_history (namespace, session_id, kind, event_id, data) VALUES (?, ?, ?, ?, ?)')
        const upgrade = this.db.query('UPDATE worker_review_history SET data = ? WHERE session_id = ? AND kind = ? AND event_id = ? AND data = ?')
        const category = filled(data.category) ? data.category.trim() : null
        for (const kind of ['linkedinReviews', 'approvalReviews']) {
            const events = data[kind]
            if (!Array.isArray(events)) continue
            for (const event of events) {
                if (!event || typeof event !== 'object' || Array.isArray(event)) continue
                const json = JSON.stringify(event)
                const id = typeof event.id === 'string' && event.id ? event.id : createHash('sha256').update(json).digest('hex')
                // The hit rate is kept per category for good, so each archived
                // review must carry its own category: the row it came from can
                // be edited or deleted later. A talent review already names its
                // role; any other takes the row's category as it is right now.
                const stamped = category && !filled(event.role) && !filled(event.category)
                    ? JSON.stringify({ ...event, category })
                    : json
                insert.run(namespace, sessionId, kind, id, stamped)
                // A review archived before its row had a category gains one; it never loses or changes one.
                if (stamped !== json) upgrade.run(stamped, sessionId, kind, id, json)
            }
        }
    }

    reviewHistory(namespace: string, sessionId: string): WorkerRecord[] {
        // Backfill pre-existing reviews on first read; new reviews are archived on write.
        for (const row of this.list(namespace, sessionId)) this.archiveReviews(namespace, sessionId, row.data)
        const rows = this.db.query<{ kind: string; event_id: string; data: string }, [string, string]>('SELECT kind, event_id, data FROM worker_review_history WHERE namespace = ? AND session_id = ? ORDER BY rowid').all(namespace, sessionId)
        return rows.map((row) => ({ key: `history:${row.kind}:${row.event_id}`, data: { [row.kind]: [JSON.parse(row.data)] }, createdAt: 0, updatedAt: 0 }))
    }

    list(namespace: string, sessionId: string): WorkerRecord[] {
        return this.db.query<DbRow, [string, string]>(`
            SELECT key, data, created_at, updated_at FROM worker_records
            WHERE namespace = ? AND session_id = ?
            ORDER BY created_at DESC, key ASC
        `).all(namespace, sessionId).map(mapRow)
    }

    /**
     * Insert new rows and patch existing ones. Fields are merged onto the
     * stored row, so a worker can later report just `{ emailSent: true }` for
     * a key without resending everything; a `null` field removes it.
     */
    upsert(namespace: string, sessionId: string, records: readonly { key: string; data: Record<string, unknown> }[]): number {
        const now = Date.now()
        const existing = this.db.query<{ data: string }, [string, string]>(
            'SELECT data FROM worker_records WHERE session_id = ? AND key = ?'
        )
        const write = this.db.query(`
            INSERT INTO worker_records (namespace, session_id, key, data, created_at, updated_at)
            VALUES ($namespace, $session_id, $key, $data, $now, $now)
            ON CONFLICT(session_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
        `)
        const run = this.db.transaction(() => {
            for (const record of records) {
                const stored = existing.get(sessionId, record.key)
                const merged: Record<string, unknown> = stored ? mapRow({ key: record.key, data: stored.data, created_at: 0, updated_at: 0 }).data : {}
                this.archiveReviews(namespace, sessionId, merged)
                for (const [field, value] of Object.entries(record.data)) {
                    if (value === null) delete merged[field]
                    else merged[field] = value
                }
                this.archiveReviews(namespace, sessionId, merged)
                write.run({ namespace, session_id: sessionId, key: record.key, data: JSON.stringify(merged), now })
            }
            const { count } = this.db.query<{ count: number }, [string]>(
                'SELECT COUNT(*) AS count FROM worker_records WHERE session_id = ?'
            ).get(sessionId) ?? { count: 0 }
            if (count > MAX_WORKER_RECORDS) {
                throw new Error(`A board holds at most ${MAX_WORKER_RECORDS} rows; remove old ones first`)
            }
        })
        run()
        this.statsCache.clear()
        return records.length
    }

    remove(namespace: string, sessionId: string, key: string): boolean {
        this.statsCache.clear()
        const old = this.list(namespace, sessionId).find((row) => row.key === key)
        if (old) this.archiveReviews(namespace, sessionId, old.data)
        return this.db.query(
            'DELETE FROM worker_records WHERE namespace = ? AND session_id = ? AND key = ?'
        ).run(namespace, sessionId, key).changes > 0
    }

    /**
     * Per-board totals for the session list, including how many rows no one
     * has reviewed yet. Counting those means reading every row's JSON, and the
     * session list is requested constantly, so the result is cached and only
     * dropped when a board is written.
     */
    stats(namespace: string): Map<string, WorkerBoardStats> {
        const cached = this.statsCache.get(namespace)
        if (cached) return cached
        const unreviewed = `COALESCE(json_array_length(data, '$.linkedinReviews'), 0) = 0
            AND COALESCE(json_array_length(data, '$.approvalReviews'), 0) = 0`
        const rows = this.db.query<{ session_id: string; count: number; updated_at: number; unreviewed: number; newest_unreviewed: number | null }, [string]>(`
            SELECT session_id, COUNT(*) AS count, MAX(updated_at) AS updated_at,
                SUM(CASE WHEN ${unreviewed} THEN 1 ELSE 0 END) AS unreviewed,
                MAX(CASE WHEN ${unreviewed} THEN created_at END) AS newest_unreviewed
            FROM worker_records WHERE namespace = ? GROUP BY session_id
        `).all(namespace)
        const stats = new Map(rows.map((row) => [row.session_id, {
            count: row.count,
            updatedAt: row.updated_at,
            unreviewed: row.unreviewed,
            newestUnreviewedAt: row.newest_unreviewed ?? 0
        }]))
        this.statsCache.set(namespace, stats)
        return stats
    }

    /** A worker resumed under a new session id keeps its board. */
    transfer(oldSessionId: string, newSessionId: string): void {
        this.statsCache.clear()
        this.db.query('UPDATE OR IGNORE worker_records SET session_id = ? WHERE session_id = ?').run(newSessionId, oldSessionId)
        this.db.query('DELETE FROM worker_records WHERE session_id = ?').run(oldSessionId)
        this.db.query('UPDATE OR IGNORE worker_review_history SET session_id = ? WHERE session_id = ?').run(newSessionId, oldSessionId)
        this.db.query('DELETE FROM worker_review_history WHERE session_id = ?').run(oldSessionId)
    }
}
