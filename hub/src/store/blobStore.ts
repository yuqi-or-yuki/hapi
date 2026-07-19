import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

export class BlobStore {
    constructor(private readonly db: Database) {}

    storeBlob(sessionId: string, mimeType: string, data: string): string {
        const id = randomUUID()
        this.db.prepare(
            'INSERT INTO blobs (id, session_id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(id, sessionId, mimeType, data, Date.now())
        return id
    }

    getBlob(sessionId: string, blobId: string): { mimeType: string; data: string } | null {
        const row = this.db.prepare(
            'SELECT mime_type, data FROM blobs WHERE id = ? AND session_id = ?'
        ).get(blobId, sessionId) as { mime_type: string; data: string } | undefined
        if (!row) return null
        return { mimeType: row.mime_type, data: row.data }
    }
}
