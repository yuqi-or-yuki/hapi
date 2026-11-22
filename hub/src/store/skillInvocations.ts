import type { Database } from 'bun:sqlite'
import { isObject } from '@hapi/protocol'
import { decodeMessageContent } from './contentCodec'

export type SkillInvocation = {
    /** Times this name was invoked, counting both `/name` and `$name`. */
    calls: number
    lastUsedAt: number
}

export type SkillInvocationCounts = Record<string, SkillInvocation>

/**
 * A skill name as typed. Deliberately narrow: this runs over free-form prompt
 * text, so anything that is not plainly a command token is ignored rather than
 * counted as a skill.
 */
const SKILL_NAME = /^[a-z0-9][a-z0-9:_-]*$/

/** The leading `/name` or `$name` of a prompt, lowercased, or null. */
export function invokedSkillName(text: unknown): string | null {
    if (typeof text !== 'string') return null
    const trimmed = text.trimStart()
    const sigil = trimmed[0]
    if (sigil !== '/' && sigil !== '$') return null
    const name = trimmed.slice(1).split(/[\s\n]/, 1)[0]?.toLowerCase()
    return name && SKILL_NAME.test(name) ? name : null
}

function promptText(content: unknown): unknown {
    if (!isObject(content) || content.role !== 'user') return null
    const body = content.content
    if (!isObject(body) || body.type !== 'text') return null
    return body.text
}

/**
 * How often each skill has been invoked, counted from the prompts you have
 * sent.
 *
 * Counts are derived rather than recorded: every invocation is already in the
 * message history, so there is no write path to keep in step and the numbers
 * are retroactive. `local_id` is set only on prompts the operator sent, which
 * narrows a million-row table to a few thousand.
 *
 * Scanning is incremental — each pass reads only messages newer than the last
 * one — because decoding a prompt means decompressing it, and the whole point
 * of this is to stay cheap enough to call whenever the page is opened.
 */
/** Rows read per query. Kept small because each row means a blob decompress
 *  plus a JSON parse, and the hub has one thread to share. */
const SCAN_BATCH = 100

/** Yield at least this often, so no single tick holds the thread long enough
 *  to stall a keepalive or an SSE write. Measured: 500 rows in one tick spiked
 *  /health to ~900ms; a 25ms slice keeps it in the normal range. */
const SCAN_SLICE_MS = 25

export class SkillInvocationStore {
    private readonly db: Database
    private counts: SkillInvocationCounts = {}
    /** Highest message rowid already counted. */
    private watermark = 0
    private scanning: Promise<void> | null = null
    private complete = false

    constructor(db: Database) {
        this.db = db
    }

    /**
     * Counts so far, plus whether the first pass has finished.
     *
     * Deliberately non-blocking. The first pass has to decode every prompt
     * ever sent -- ~12k of them, many zstd-compressed -- which measured at
     * eight seconds on a real database. The hub runs SQLite synchronously on
     * one thread, so doing that inside a request would freeze every session,
     * every keepalive and every SSE stream for those eight seconds. Instead it
     * runs a batch per tick in the background and the endpoint answers
     * immediately with what has been counted.
     *
     * Once the first pass lands, later passes seek by rowid and see only
     * messages written since, which costs nothing.
     */
    snapshot(): { counts: SkillInvocationCounts; complete: boolean } {
        void this.ensureScanning()
        return { counts: this.counts, complete: this.complete }
    }

    /** Scans to completion. For tests and callers that can afford to wait. */
    async all(): Promise<SkillInvocationCounts> {
        await this.ensureScanning()
        return this.counts
    }

    private ensureScanning(): Promise<void> {
        if (!this.scanning) {
            this.scanning = this.scan().finally(() => { this.scanning = null })
        }
        return this.scanning
    }

    private async scan(): Promise<void> {
        const query = this.db.query<
            { rowid: number; content: string | Uint8Array | null; created_at: number },
            [number, number]
        >(
            'SELECT rowid, content, created_at FROM messages WHERE rowid > ? AND local_id IS NOT NULL ORDER BY rowid LIMIT ?'
        )

        let sliceStartedAt = Date.now()
        for (;;) {
            const rows = query.all(this.watermark, SCAN_BATCH)
            if (rows.length === 0) break

            for (const row of rows) {
                this.watermark = row.rowid
                const name = invokedSkillName(promptText(decodeMessageContent(row.content)))
                if (!name) continue
                const existing = this.counts[name]
                if (existing) {
                    existing.calls += 1
                    if (row.created_at > existing.lastUsedAt) existing.lastUsedAt = row.created_at
                } else {
                    this.counts[name] = { calls: 1, lastUsedAt: row.created_at }
                }
            }

            if (rows.length < SCAN_BATCH) break
            if (Date.now() - sliceStartedAt >= SCAN_SLICE_MS) {
                // Hand the thread back so sessions, keepalives and SSE keep flowing.
                await new Promise<void>((resolve) => setImmediate(resolve))
                sliceStartedAt = Date.now()
            }
        }
        this.complete = true
    }
}
