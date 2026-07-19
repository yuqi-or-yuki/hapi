import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

import { BlobStore } from './blobStore'
import { MachineStore } from './machineStore'
import { MessageStore } from './messageStore'
import { PreferencesStore } from './preferencesStore'
import { PushStore } from './pushStore'
import { SessionStore } from './sessionStore'
import { ScheduledMessageStore } from './scheduledMessageStore'
import { SkillUsageStore } from './skillUsageStore'
import { UserStore } from './userStore'

export type {
    StoredMachine,
    StoredMessage,
    StoredPushSubscription,
    StoredSession,
    StoredUser,
    VersionedUpdateResult
} from './types'
export type { CancelQueuedMessageResult, LookupQueuedMessageResult } from './messages'
export { BlobStore } from './blobStore'
export { MachineStore } from './machineStore'
export { MessageStore } from './messageStore'
export { PreferencesStore } from './preferencesStore'
export { PushStore } from './pushStore'
export { SessionStore } from './sessionStore'
export { ScheduledMessageStore } from './scheduledMessageStore'
export type { ScheduledMessageHistoryRow, ScheduledMessageRow, ScheduledMessageStatus } from './scheduledMessageStore'
export { SkillUsageStore } from './skillUsageStore'
export type { SkillUsageRow } from './skillUsageStore'
export { UserStore } from './userStore'

const SCHEMA_VERSION: number = 12
const REQUIRED_TABLES = [
    'sessions',
    'machines',
    'messages',
    'users',
    'push_subscriptions',
    'blobs',
    'scheduled_messages',
    'scheduled_message_history',
    'skill_usage'
] as const

export class Store {
    private db: Database
    private readonly dbPath: string

    readonly sessions: SessionStore
    readonly machines: MachineStore
    readonly messages: MessageStore
    readonly users: UserStore
    readonly push: PushStore
    readonly blobs: BlobStore
    readonly preferences: PreferencesStore
    readonly scheduledMessages: ScheduledMessageStore
    readonly skillUsage: SkillUsageStore

    constructor(dbPath: string) {
        this.dbPath = dbPath
        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            const dir = dirname(dbPath)
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            try {
                chmodSync(dir, 0o700)
            } catch {
            }

            if (!existsSync(dbPath)) {
                try {
                    const fd = openSync(dbPath, 'a', 0o600)
                    closeSync(fd)
                } catch {
                }
            }
        }

        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        this.db.exec('PRAGMA foreign_keys = ON')
        this.db.exec('PRAGMA busy_timeout = 5000')
        this.initSchema()

        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                try {
                    chmodSync(path, 0o600)
                } catch {
                }
            }
        }

        this.sessions = new SessionStore(this.db)
        this.machines = new MachineStore(this.db)
        this.messages = new MessageStore(this.db)
        this.users = new UserStore(this.db)
        this.push = new PushStore(this.db)
        this.blobs = new BlobStore(this.db)
        this.preferences = new PreferencesStore(this.db)
        this.scheduledMessages = new ScheduledMessageStore(this.db)
        this.skillUsage = new SkillUsageStore(this.db)
    }

    private initSchema(): void {
        const currentVersion = this.getUserVersion()
        // V1/V2/V3 entries cover legacy DBs that pre-date our migration ladder.
        // Each step is idempotent (column-existence guards inside) so we can
        // safely run the full V1→V8 chain in the legacy branch where the DB
        // shape is unknown.
        const buildStepMigrations = (legacy: boolean): Record<number, () => void> => ({
            1: () => this.migrateFromV1ToV2(legacy),
            2: () => this.migrateFromV2ToV3(),
            3: () => this.migrateFromV3ToV4(),
            4: () => this.migrateFromV4ToV5(),
            5: () => this.migrateFromV5ToV6(),
            6: () => this.migrateFromV6ToV7(),
            7: () => this.migrateFromV7ToV8(),
            8: () => this.migrateFromV8ToV9(),
            9: () => this.migrateFromV9ToV10(),
            10: () => this.migrateFromV10ToV11(),
            11: () => this.migrateFromV11ToV12(),
        })

        if (currentVersion === 0) {
            if (this.hasAnyUserTables()) {
                this.migrateLegacySchemaIfNeeded()
                // Run the full step ladder BEFORE createSchema so legacy tables
                // pick up every later-version column (e.g. invoked_at) via ALTER
                // TABLE.  Without this, createSchema below would try to build
                // idx_messages_session_position over a column that does not
                // exist yet, and CREATE TABLE IF NOT EXISTS would not add the
                // missing column to the existing table.
                const legacySteps = buildStepMigrations(true)
                for (let v = 1; v < SCHEMA_VERSION; v++) {
                    legacySteps[v]?.()
                }
                // Backfill any *missing* tables (sessions, machines, ...) that
                // a partially-built legacy DB may not have yet.
                this.createSchema()
                this.setUserVersion(SCHEMA_VERSION)
                return
            }

            this.createSchema()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        const stepMigrations = buildStepMigrations(false)
        if (currentVersion < SCHEMA_VERSION && stepMigrations[currentVersion]) {
            for (let v = currentVersion; v < SCHEMA_VERSION; v++) {
                const step = stepMigrations[v]
                if (!step) throw this.buildSchemaMismatchError(currentVersion)
                step()
            }
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion !== SCHEMA_VERSION) {
            throw this.buildSchemaMismatchError(currentVersion)
        }

        this.ensureScheduledMessagesSchema()
        this.ensureSkillUsageSchema()
        this.assertRequiredTablesPresent()
    }

    private createSchema(): void {
        this.db.exec(`
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

            CREATE TABLE IF NOT EXISTS blobs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_blobs_session ON blobs(session_id);

            CREATE TABLE IF NOT EXISTS preferences (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, key)
            );

            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                source_session_id TEXT NOT NULL,
                target_session_id TEXT,
                text TEXT NOT NULL,
                due_at INTEGER NOT NULL,
                clone_before_send INTEGER NOT NULL DEFAULT 0,
                interval_ms INTEGER,
                max_occurrences INTEGER,
                occurrence_count INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sent_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(status, due_at);
            CREATE INDEX IF NOT EXISTS idx_scheduled_messages_source ON scheduled_messages(namespace, source_session_id);

            CREATE TABLE IF NOT EXISTS scheduled_message_history (
                id TEXT PRIMARY KEY,
                scheduled_message_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                event TEXT NOT NULL,
                source_session_id TEXT NOT NULL DEFAULT '',
                target_session_id TEXT,
                text TEXT NOT NULL,
                due_at INTEGER NOT NULL,
                clone_before_send INTEGER NOT NULL DEFAULT 0,
                interval_ms INTEGER,
                max_occurrences INTEGER,
                occurrence_count INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL,
                error TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (scheduled_message_id) REFERENCES scheduled_messages(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_message_history_job ON scheduled_message_history(scheduled_message_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS skill_usage (
                namespace TEXT NOT NULL DEFAULT 'default',
                skill_name TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                last_used_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, skill_name)
            );
            CREATE INDEX IF NOT EXISTS idx_skill_usage_namespace ON skill_usage(namespace, count DESC);
        `)
    }

    private migrateLegacySchemaIfNeeded(): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            return
        }

        const hasDaemon = columns.has('daemon_state') || columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') || columns.has('runner_state_version')

        if (hasDaemon && hasRunner) {
            throw new Error('SQLite schema has both daemon_state and runner_state columns in machines; manual cleanup required.')
        }

        if (hasDaemon && !hasRunner) {
            this.migrateFromV1ToV2()
        }
    }

    private migrateFromV1ToV2(legacy: boolean = false): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            // In the legacy branch the table may not exist yet — createSchema
            // will build the up-to-date one.  When invoked from the regular
            // upgrade path (user_version >= 1), missing the machines table is
            // still an error.
            if (legacy) return
            throw new Error('SQLite schema missing machines table for v1 to v2 migration.')
        }

        const hasDaemon = columns.has('daemon_state') && columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') && columns.has('runner_state_version')

        if (hasRunner && !hasDaemon) {
            return
        }

        if (!hasDaemon) {
            if (legacy) return
            throw new Error('SQLite schema missing daemon_state columns for v1 to v2 migration.')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state TO runner_state')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state_version TO runner_state_version')
            this.db.exec('COMMIT')
            return
        } catch (error) {
            this.db.exec('ROLLBACK')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec(`
                CREATE TABLE machines_new (
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
            `)
            this.db.exec(`
                INSERT INTO machines_new (
                    id, namespace, created_at, updated_at,
                    metadata, metadata_version,
                    runner_state, runner_state_version,
                    active, active_at, seq
                )
                SELECT id, namespace, created_at, updated_at,
                       metadata, metadata_version,
                       daemon_state, daemon_state_version,
                       active, active_at, seq
                FROM machines;
            `)
            this.db.exec('DROP TABLE machines')
            this.db.exec('ALTER TABLE machines_new RENAME TO machines')
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace)')
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`SQLite schema migration v1->v2 failed: ${message}`)
        }
    }

    private migrateFromV2ToV3(): void {
        return
    }

    private migrateFromV3ToV4(): void {
        const columns = this.getSessionColumnNames()
        // When the legacy branch invokes the full step ladder, an upstream-only
        // DB may not have the sessions table yet — createSchema runs after the
        // ladder.  Skip ALTERs in that case; createSchema will build the table
        // with the up-to-date columns.
        if (columns.size === 0) return
        if (!columns.has('team_state')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state TEXT')
        }
        if (!columns.has('team_state_updated_at')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state_updated_at INTEGER')
        }
    }

    private migrateFromV4ToV5(): void {
        const columns = this.getSessionColumnNames()
        if (columns.size === 0) return
        if (!columns.has('model')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN model TEXT')
        }
    }

    private migrateFromV5ToV6(): void {
        const columns = this.getSessionColumnNames()
        if (columns.size === 0) return
        if (!columns.has('effort')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN effort TEXT')
        }
    }

    private migrateFromV6ToV7(): void {
        const columns = this.getSessionColumnNames()
        if (columns.size === 0) return
        if (!columns.has('model_reasoning_effort')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN model_reasoning_effort TEXT')
        }
    }

    private migrateFromV7ToV8(): void {
        const columns = this.getMessageColumnNames()
        if (columns.size === 0) {
            // No messages table yet — createSchema will build the up-to-date one.
            return
        }
        if (!columns.has('invoked_at')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN invoked_at INTEGER')
        }
        // Idempotent (WHERE invoked_at IS NULL); safe to re-run if a previous attempt
        // crashed between ALTER and UPDATE before user_version was bumped.
        this.db.exec('UPDATE messages SET invoked_at = created_at WHERE invoked_at IS NULL')
        // Position index for byPosition pagination — idempotent via IF NOT EXISTS.
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_session_position
                ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC)
        `)
    }

    private migrateFromV8ToV9(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS blobs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_blobs_session ON blobs(session_id);
        `)
    }

    private migrateFromV9ToV10(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS preferences (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, key)
            );
        `)
        this.ensureScheduledMessagesSchema()
    }

    private migrateFromV10ToV11(): void {
        this.ensureSkillUsageSchema()
    }

    private migrateFromV11ToV12(): void {
        this.ensureScheduledMessagesSchema()
    }

    private ensureSkillUsageSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS skill_usage (
                namespace TEXT NOT NULL DEFAULT 'default',
                skill_name TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                last_used_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, skill_name)
            );
            CREATE INDEX IF NOT EXISTS idx_skill_usage_namespace ON skill_usage(namespace, count DESC);
        `)
    }

    private ensureScheduledMessagesSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                source_session_id TEXT NOT NULL,
                target_session_id TEXT,
                text TEXT NOT NULL,
                due_at INTEGER NOT NULL,
                clone_before_send INTEGER NOT NULL DEFAULT 0,
                interval_ms INTEGER,
                max_occurrences INTEGER,
                occurrence_count INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sent_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(status, due_at);
            CREATE INDEX IF NOT EXISTS idx_scheduled_messages_source ON scheduled_messages(namespace, source_session_id);

            CREATE TABLE IF NOT EXISTS scheduled_message_history (
                id TEXT PRIMARY KEY,
                scheduled_message_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                event TEXT NOT NULL,
                source_session_id TEXT NOT NULL DEFAULT '',
                target_session_id TEXT,
                text TEXT NOT NULL,
                due_at INTEGER NOT NULL,
                clone_before_send INTEGER NOT NULL DEFAULT 0,
                interval_ms INTEGER,
                max_occurrences INTEGER,
                occurrence_count INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL,
                error TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (scheduled_message_id) REFERENCES scheduled_messages(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_message_history_job ON scheduled_message_history(scheduled_message_id, created_at DESC);
        `)
        const columns = this.getScheduledMessageColumnNames()
        if (!columns.has('interval_ms')) {
            this.db.exec('ALTER TABLE scheduled_messages ADD COLUMN interval_ms INTEGER')
        }
        if (!columns.has('enabled')) {
            this.db.exec('ALTER TABLE scheduled_messages ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
        }
        if (!columns.has('max_occurrences')) {
            // NULL (not the 10-send default) for existing rows — this migration must not
            // retroactively cap schedules that were already repeating forever.
            this.db.exec('ALTER TABLE scheduled_messages ADD COLUMN max_occurrences INTEGER')
        }
        if (!columns.has('occurrence_count')) {
            this.db.exec('ALTER TABLE scheduled_messages ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 0')
        }
        const historyColumns = this.getScheduledMessageHistoryColumnNames()
        if (!historyColumns.has('source_session_id')) {
            this.db.exec("ALTER TABLE scheduled_message_history ADD COLUMN source_session_id TEXT NOT NULL DEFAULT ''")
        }
        if (!historyColumns.has('enabled')) {
            this.db.exec('ALTER TABLE scheduled_message_history ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
        }
        if (!historyColumns.has('max_occurrences')) {
            this.db.exec('ALTER TABLE scheduled_message_history ADD COLUMN max_occurrences INTEGER')
        }
        if (!historyColumns.has('occurrence_count')) {
            this.db.exec('ALTER TABLE scheduled_message_history ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 0')
        }
    }

    private getSessionColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getMachineColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getMessageColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getScheduledMessageColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(scheduled_messages)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getScheduledMessageHistoryColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(scheduled_message_history)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getUserVersion(): number {
        const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
        return row?.user_version ?? 0
    }

    private setUserVersion(version: number): void {
        this.db.exec(`PRAGMA user_version = ${version}`)
    }

    private hasAnyUserTables(): boolean {
        const row = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
        ).get() as { name?: string } | undefined
        return Boolean(row?.name)
    }

    private assertRequiredTablesPresent(): void {
        const placeholders = REQUIRED_TABLES.map(() => '?').join(', ')
        const rows = this.db.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
        ).all(...REQUIRED_TABLES) as Array<{ name: string }>
        const existing = new Set(rows.map((row) => row.name))
        const missing = REQUIRED_TABLES.filter((table) => !existing.has(table))

        if (missing.length > 0) {
            throw new Error(
                `SQLite schema is missing required tables (${missing.join(', ')}). ` +
                'Back up and rebuild the database, or run an offline migration to the expected schema version.'
            )
        }
    }

    private buildSchemaMismatchError(currentVersion: number): Error {
        const location = (this.dbPath === ':memory:' || this.dbPath.startsWith('file::memory:'))
            ? 'in-memory database'
            : this.dbPath
        return new Error(
            `SQLite schema version mismatch for ${location}. ` +
            `Expected ${SCHEMA_VERSION}, found ${currentVersion}. ` +
            'This build does not run compatibility migrations. ' +
            'Back up and rebuild the database, or run an offline migration to the expected schema version.'
        )
    }
}
