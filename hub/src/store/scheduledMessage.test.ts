import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

describe('scheduled message occurrence limits', () => {
    it('defaults a repeating schedule to 10 max occurrences when unspecified', () => {
        const store = makeStore()
        const job = store.scheduledMessages.create({
            namespace: 'default',
            sourceSessionId: 'session-1',
            text: 'hi',
            dueAt: Date.now() + 60_000,
            cloneBeforeSend: false,
            intervalMs: 60_000
        })
        expect(job.maxOccurrences).toBe(10)
        expect(job.occurrenceCount).toBe(0)
    })

    it('repeats forever when maxOccurrences is explicitly null', () => {
        const store = makeStore()
        const job = store.scheduledMessages.create({
            namespace: 'default',
            sourceSessionId: 'session-1',
            text: 'hi',
            dueAt: Date.now() + 60_000,
            cloneBeforeSend: false,
            intervalMs: 60_000,
            maxOccurrences: null
        })
        expect(job.maxOccurrences).toBeNull()

        for (let i = 0; i < 25; i++) {
            store.scheduledMessages.markSent(job.id, 'session-1')
        }

        const list = store.scheduledMessages.list('default', { status: 'pending' })
        expect(list).toHaveLength(1)
        expect(list[0]!.occurrenceCount).toBe(25)
        expect(list[0]!.status).toBe('pending')
    })

    it('stops repeating and settles to sent once the occurrence cap is reached', () => {
        const store = makeStore()
        const job = store.scheduledMessages.create({
            namespace: 'default',
            sourceSessionId: 'session-1',
            text: 'hi',
            dueAt: Date.now() + 60_000,
            cloneBeforeSend: false,
            intervalMs: 60_000,
            maxOccurrences: 3
        })

        store.scheduledMessages.markSent(job.id, 'session-1')
        let pending = store.scheduledMessages.list('default', { status: 'pending' })
        expect(pending).toHaveLength(1)
        expect(pending[0]!.occurrenceCount).toBe(1)

        store.scheduledMessages.markSent(job.id, 'session-1')
        pending = store.scheduledMessages.list('default', { status: 'pending' })
        expect(pending).toHaveLength(1)
        expect(pending[0]!.occurrenceCount).toBe(2)

        store.scheduledMessages.markSent(job.id, 'session-1')
        pending = store.scheduledMessages.list('default', { status: 'pending' })
        expect(pending).toHaveLength(0)

        const sent = store.scheduledMessages.list('default', { status: 'sent' })
        expect(sent).toHaveLength(1)
        expect(sent[0]!.occurrenceCount).toBe(3)
    })

    it('ignores maxOccurrences for one-shot (non-repeating) schedules', () => {
        const store = makeStore()
        const job = store.scheduledMessages.create({
            namespace: 'default',
            sourceSessionId: 'session-1',
            text: 'hi',
            dueAt: Date.now() + 60_000,
            cloneBeforeSend: false,
            intervalMs: null,
            maxOccurrences: 5
        })
        expect(job.maxOccurrences).toBeNull()

        store.scheduledMessages.markSent(job.id, 'session-1')
        const sent = store.scheduledMessages.list('default', { status: 'sent' })
        expect(sent).toHaveLength(1)
        expect(sent[0]!.occurrenceCount).toBe(1)
    })

    it('allows updating the occurrence cap on a pending repeating schedule', () => {
        const store = makeStore()
        const job = store.scheduledMessages.create({
            namespace: 'default',
            sourceSessionId: 'session-1',
            text: 'hi',
            dueAt: Date.now() + 60_000,
            cloneBeforeSend: false,
            intervalMs: 60_000
        })
        expect(job.maxOccurrences).toBe(10)

        const updated = store.scheduledMessages.update('default', job.id, { maxOccurrences: null })
        expect(updated?.maxOccurrences).toBeNull()

        const updatedAgain = store.scheduledMessages.update('default', job.id, { maxOccurrences: 2 })
        expect(updatedAgain?.maxOccurrences).toBe(2)
    })

    it('clears maxOccurrences when a schedule is edited from repeating to one-shot', () => {
        const store = makeStore()
        const job = store.scheduledMessages.create({
            namespace: 'default',
            sourceSessionId: 'session-1',
            text: 'hi',
            dueAt: Date.now() + 60_000,
            cloneBeforeSend: false,
            intervalMs: 60_000
        })
        expect(job.maxOccurrences).toBe(10)

        const updated = store.scheduledMessages.update('default', job.id, { intervalMs: null })
        expect(updated?.intervalMs).toBeNull()
        expect(updated?.maxOccurrences).toBeNull()
    })
})
