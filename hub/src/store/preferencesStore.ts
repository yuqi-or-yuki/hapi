import type { Database } from 'bun:sqlite'

export class PreferencesStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    get(namespace: string, key: string): unknown | null {
        const row = this.db.prepare(
            'SELECT value FROM preferences WHERE namespace = ? AND key = ?'
        ).get(namespace, key) as { value: string } | undefined
        if (!row) return null
        try {
            return JSON.parse(row.value)
        } catch {
            return null
        }
    }

    set(namespace: string, key: string, value: unknown): void {
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO preferences (namespace, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(namespace, key, JSON.stringify(value), now)
    }
}
