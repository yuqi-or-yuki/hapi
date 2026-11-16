import { describe, expect, it } from 'bun:test'
import { SSEWriter, SSE_MAX_PENDING_BYTES, SSE_MAX_PENDING_EVENTS } from './sseWriter'

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
}

describe('SSE client backpressure', () => {
    it('bounds retained bytes and aborts the transport when a client stops reading', async () => {
        let sends = 0
        let closed = 0
        const blocked = deferred()
        const writer = new SSEWriter(() => { sends += 1; return blocked.promise }, () => { closed += 1 })
        const writes = Array.from({ length: 1000 }, () => writer.write('x'.repeat(64 * 1024)).catch(() => {}))
        await Promise.all(writes)
        expect(sends).toBe(SSE_MAX_PENDING_BYTES / (64 * 1024))
        expect(closed).toBe(1)
        blocked.resolve()
    })

    it('bounds tiny queued events too', async () => {
        const blocked = deferred()
        let sends = 0
        const writer = new SSEWriter(() => { sends += 1; return blocked.promise }, () => {})
        await Promise.all(Array.from({ length: 1000 }, () => writer.write('x').catch(() => {})))
        expect(sends).toBe(SSE_MAX_PENDING_EVENTS)
        blocked.resolve()
    })

    it('measures UTF-8 bytes rather than string length', async () => {
        const blocked = deferred()
        let sends = 0
        const writer = new SSEWriter(() => { sends += 1; return blocked.promise }, () => {})
        const writes = Array.from({ length: 40 }, () => writer.write('界'.repeat(32 * 1024)).catch(() => {}))
        await Promise.all(writes)
        expect(sends).toBe(Math.floor(SSE_MAX_PENDING_BYTES / (3 * 32 * 1024)))
        blocked.resolve()
    })

    it('releases the budget after successful writes and preserves event ids', async () => {
        const received: Array<[string, string | undefined]> = []
        let closed = false
        const writer = new SSEWriter(async (data, id) => { received.push([data, id]) }, () => { closed = true })
        for (let i = 0; i < 300; i++) await writer.write('x'.repeat(16 * 1024), String(i))
        expect(received).toHaveLength(300)
        expect(received.at(-1)?.[1]).toBe('299')
        expect(closed).toBe(false)
        writer.close()
    })

    it('allows one large event without accumulating additional writes', async () => {
        const blocked = deferred()
        const writer = new SSEWriter(() => blocked.promise, () => {})
        const first = writer.write('x'.repeat(SSE_MAX_PENDING_BYTES + 1)).catch(() => {})
        await expect(writer.write('next')).rejects.toThrow()
        await first
        blocked.resolve()
    })

    it('times out a single stuck write without waiting for more traffic', async () => {
        const blocked = deferred()
        let closed = false
        const writer = new SSEWriter(() => blocked.promise, () => { closed = true }, 10)
        await expect(writer.write('handshake')).rejects.toThrow('SSE stream closed')
        expect(closed).toBe(true)
        blocked.resolve()
    })

    it('handles synchronous transport failures and closes once', async () => {
        let closed = 0
        const writer = new SSEWriter(() => { throw new Error('disconnected') }, () => { closed += 1 })
        await expect(writer.write('event')).rejects.toThrow('disconnected')
        writer.close()
        expect(closed).toBe(1)
    })
})
