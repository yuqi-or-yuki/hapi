import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, SCHEMA_VERSION } from './index'

describe('Store V19->current migration: usage re-index', () => {
    it('clears stale derived usage rows and scan state', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v19-to-v20-'))
        const dbPath = join(directory, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(dbPath)
            store.close()
            store = undefined

            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                INSERT INTO sessions (id, created_at, updated_at)
                VALUES ('session-1', 1, 1);
                INSERT INTO usage_events (
                    session_id, source_key, source_seq, created_at, agent, kind
                ) VALUES (
                    'session-1', 'legacy-key', 1, 1, 'codex', 'cumulative'
                );
                INSERT INTO usage_scan_state (session_id, message_epoch, last_seq)
                VALUES ('session-1', 1, 42);
                PRAGMA user_version = 19;
            `)
            db.close()

            store = new Store(dbPath)
            const internalDb = (store as unknown as { db: Database }).db
            const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
            const scanRows = internalDb.prepare('SELECT COUNT(*) AS count FROM usage_scan_state').get() as { count: number }
            const usageRows = internalDb.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }

            expect(version.user_version).toBe(SCHEMA_VERSION)
            expect(scanRows.count).toBe(0)
            expect(usageRows.count).toBe(0)
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
