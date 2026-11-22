import type { Database } from 'bun:sqlite'

/** One row on a worker's board: whatever fields the worker chose to report. */
export type WorkerRecord = {
    key: string
    data: Record<string, unknown>
    createdAt: number
    updatedAt: number
}

export type WorkerBoardStats = { count: number; updatedAt: number }

type DbRow = { key: string; data: string; created_at: number; updated_at: number }

export const MAX_WORKER_RECORDS = 5000

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
        `)
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
                for (const [field, value] of Object.entries(record.data)) {
                    if (value === null) delete merged[field]
                    else merged[field] = value
                }
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
        return records.length
    }

    remove(namespace: string, sessionId: string, key: string): boolean {
        return this.db.query(
            'DELETE FROM worker_records WHERE namespace = ? AND session_id = ? AND key = ?'
        ).run(namespace, sessionId, key).changes > 0
    }

    stats(namespace: string): Map<string, WorkerBoardStats> {
        const rows = this.db.query<{ session_id: string; count: number; updated_at: number }, [string]>(`
            SELECT session_id, COUNT(*) AS count, MAX(updated_at) AS updated_at
            FROM worker_records WHERE namespace = ? GROUP BY session_id
        `).all(namespace)
        return new Map(rows.map((row) => [row.session_id, { count: row.count, updatedAt: row.updated_at }]))
    }

    /** A worker resumed under a new session id keeps its board. */
    transfer(oldSessionId: string, newSessionId: string): void {
        this.db.query('UPDATE OR IGNORE worker_records SET session_id = ? WHERE session_id = ?').run(newSessionId, oldSessionId)
        this.db.query('DELETE FROM worker_records WHERE session_id = ?').run(oldSessionId)
    }
}
