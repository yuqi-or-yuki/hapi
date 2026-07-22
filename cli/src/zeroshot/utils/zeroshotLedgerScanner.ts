import { Database } from 'bun:sqlite';
import { getZeroshotDbPath } from './zeroshotRegistry';

export type ZeroshotLedgerRow = {
    id: string;
    timestamp: number;
    topic: string;
    sender: string;
    receiver: string;
    content_text: string | null;
    content_data: string | null;
    metadata: string | null;
    cluster_id: string;
};

/**
 * Read-only cross-process reader for a Zeroshot cluster's SQLite ledger
 * (`~/.zeroshot/<clusterId>.db`). Mirrors the cursor scheme Zeroshot's own
 * `Ledger.pollForMessages` uses: message ids are random hex (not sequential),
 * so a plain `timestamp > cursor` query can miss same-millisecond writes —
 * query with a 1s look-back buffer and dedup already-seen ids instead.
 */
export class ZeroshotLedgerReader {
    private db: Database | null = null;
    private readonly seenIds = new Set<string>();
    private readonly dbPath: string;

    constructor(private readonly clusterId: string) {
        this.dbPath = getZeroshotDbPath(clusterId);
    }

    private ensureOpen(): Database | null {
        if (this.db) {
            return this.db;
        }
        try {
            this.db = new Database(this.dbPath, { readonly: true });
            return this.db;
        } catch {
            // Ledger file doesn't exist yet (daemon still in early setup) — caller retries next tick.
            return null;
        }
    }

    /** Returns new rows since `sinceTimestamp` (exclusive of already-seen ids) plus the advanced cursor. */
    pollNewRows(sinceTimestamp: number): { rows: ZeroshotLedgerRow[]; nextTimestamp: number } {
        const db = this.ensureOpen();
        if (!db) {
            return { rows: [], nextTimestamp: sinceTimestamp };
        }

        const lookback = Math.max(0, sinceTimestamp - 1000);
        let rows: ZeroshotLedgerRow[];
        try {
            rows = db.query(
                `SELECT * FROM messages WHERE cluster_id = ? AND timestamp >= ? ORDER BY timestamp ASC`
            ).all(this.clusterId, lookback) as ZeroshotLedgerRow[];
        } catch {
            // WAL readers can transiently fail mid-checkpoint; treat as "nothing new yet".
            return { rows: [], nextTimestamp: sinceTimestamp };
        }

        const fresh: ZeroshotLedgerRow[] = [];
        let maxTimestamp = sinceTimestamp;
        for (const row of rows) {
            if (this.seenIds.has(row.id)) {
                continue;
            }
            this.seenIds.add(row.id);
            fresh.push(row);
            if (row.timestamp > maxTimestamp) {
                maxTimestamp = row.timestamp;
            }
        }

        // Bound memory for very long-running clusters — ids older than the
        // lookback window can never legitimately reappear.
        if (this.seenIds.size > 5000) {
            this.seenIds.clear();
        }

        return { rows: fresh, nextTimestamp: maxTimestamp };
    }

    close(): void {
        this.db?.close();
        this.db = null;
    }
}
