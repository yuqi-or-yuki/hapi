/** Bound retained writes when a phone/tab stops consuming its SSE stream. */
export const SSE_MAX_PENDING_BYTES = 2 * 1024 * 1024
export const SSE_MAX_PENDING_EVENTS = 256
export const SSE_WRITE_TIMEOUT_MS = 15_000

export class SSEWriter {
    private pendingBytes = 0
    private pendingCount = 0
    private closed = false
    private readonly pending = new Map<symbol, { reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

    constructor(
        private readonly send: (data: string, id?: string) => Promise<unknown>,
        private readonly onClose: () => void,
        private readonly timeoutMs = SSE_WRITE_TIMEOUT_MS
    ) {}

    write(data: string, id?: string): Promise<void> {
        if (this.closed) return Promise.reject(new Error('SSE stream closed'))
        const bytes = Buffer.byteLength(data, 'utf8')
        // A single large event is allowed; additional writes must fit the
        // budget. Otherwise a legitimate large prompt could never be sent.
        if (this.pendingCount >= SSE_MAX_PENDING_EVENTS
            || (this.pendingCount > 0 && this.pendingBytes + bytes > SSE_MAX_PENDING_BYTES)) {
            this.close()
            return Promise.reject(new Error('SSE client backlog exceeded'))
        }
        this.pendingCount += 1
        this.pendingBytes += bytes
        const key = Symbol()
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => this.close(), this.timeoutMs)
            timer.unref?.()
            this.pending.set(key, { reject, timer })
            const writer = this
            // Attach rejection handling even when abort rejects the underlying
            // transport after our own promise has already been rejected.
            try {
                void this.send(data, id).then(() => finish(), (error: unknown) => finish(error))
            } catch (error) {
                finish(error)
            }
            function finish(error?: unknown): void {
                const entry = writer.pending.get(key)
                if (!entry) return
                writer.pending.delete(key)
                clearTimeout(entry.timer)
                writer.pendingCount -= 1
                writer.pendingBytes -= bytes
                if (error !== undefined) {
                    reject(error)
                    writer.close()
                } else {
                    resolve()
                }
            }
        })
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer)
            reject(new Error('SSE stream closed'))
        }
        this.pending.clear()
        this.pendingBytes = this.pendingCount = 0
        this.onClose()
    }
}
