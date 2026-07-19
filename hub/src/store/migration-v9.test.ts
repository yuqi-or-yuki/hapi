import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

/**
 * Tests for V8→V9 schema migration: adding blobs table.
 */
describe('Store V8→V9 migration: blobs table', () => {
    it('fresh DB has blobs table', () => {
        const store = new Store(':memory:')
        const db: Database = (store as any).db
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
        expect(tables).toContain('blobs')
    })

    it('V8 DB migrates to V9: blobs table created', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-test-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            db.exec('PRAGMA user_version = 8')
            db.close()

            const store = new Store(dbPath)
            const db2: Database = (store as any).db
            const tables = (db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
            expect(tables).toContain('blobs')

            const version = (db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
            expect(version).toBe(9)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V8 blobs table has correct schema', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-schema-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            db.exec('PRAGMA user_version = 8')
            db.close()

            const store = new Store(dbPath)
            const db2: Database = (store as any).db
            const cols = (db2.prepare('PRAGMA table_info(blobs)').all() as Array<{ name: string }>).map(r => r.name)
            expect(cols).toContain('id')
            expect(cols).toContain('session_id')
            expect(cols).toContain('mime_type')
            expect(cols).toContain('data')
            expect(cols).toContain('created_at')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V8 DB migration: blobs index created', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-index-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            db.exec('PRAGMA user_version = 8')
            db.close()

            const store = new Store(dbPath)
            const db2: Database = (store as any).db
            const rows = (db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_blobs_session'").all() as Array<{ name: string }>)
            expect(rows).toHaveLength(1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('V9 DB reopen is idempotent', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-idempotent-'))
        const dbPath = join(dir, 'test.db')
        try {
            const store1 = new Store(dbPath)
            const db1: Database = (store1 as any).db
            const tables1 = (db1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
            expect(tables1).toContain('blobs')

            const store2 = new Store(dbPath)
            const db2: Database = (store2 as any).db
            const tables2 = (db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
            expect(tables2).toEqual(tables1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('blobs store and retrieve work after migration', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v9-rw-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV8Schema(db)
            db.exec(`INSERT INTO sessions (id, namespace, created_at, updated_at, seq) VALUES ('s1', 'default', 1000, 1000, 0)`)
            db.exec('PRAGMA user_version = 8')
            db.close()

            const store = new Store(dbPath)
            const blobId = store.blobs.storeBlob('s1', 'image/png', 'abc123data')
            expect(typeof blobId).toBe('string')
            expect(blobId.length).toBeGreaterThan(0)

            const retrieved = store.blobs.getBlob('s1', blobId)
            expect(retrieved).not.toBeNull()
            expect(retrieved!.mimeType).toBe('image/png')
            expect(retrieved!.data).toBe('abc123data')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

/** V8 schema: same as V7 but with invoked_at in messages */
function createV8Schema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            tag TEXT,
            namespace TEXT NOT NULL DEFAULT 'default',
            machine_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            agent_state TEXT,
            agent_state_version INTEGER DEFAULT 1,
            model TEXT,
            model_reasoning_effort TEXT,
            effort TEXT,
            todos TEXT,
            todos_updated_at INTEGER,
            team_state TEXT,
            team_state_updated_at INTEGER,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
        CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            runner_state TEXT,
            runner_state_version INTEGER DEFAULT 1,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT,
            invoked_at INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_session_position
            ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
        CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);
    `)
}
