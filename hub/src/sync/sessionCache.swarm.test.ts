import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createCache() {
    const events: SyncEvent[] = []
    const store = new Store(':memory:')
    const cache = new SessionCache(store, {
        emit: (event: SyncEvent) => { events.push(event) }
    } as unknown as EventPublisher)
    const session = cache.getOrCreateSession('swarm-1', { path: '/repo', host: 'localhost' }, null, 'default')
    return { cache, session, events }
}

describe('setSessionSwarm', () => {
    it('promotes a session to a worker and retires it again', async () => {
        const { cache, session } = createCache()

        await cache.setSessionSwarm(session.id, { job: 'QA production three times a day' })
        expect(cache.getSession(session.id)?.metadata?.swarm?.job).toBe('QA production three times a day')

        await cache.setSessionSwarm(session.id, null)
        expect(cache.getSession(session.id)?.metadata?.swarm).toBeUndefined()
    })

    it('keeps the original promotion time when only the job is rewritten', async () => {
        const { cache, session } = createCache()

        await cache.setSessionSwarm(session.id, { job: 'First job' })
        const promotedAt = cache.getSession(session.id)?.metadata?.swarm?.promotedAt
        expect(promotedAt).toBeGreaterThan(0)

        await cache.setSessionSwarm(session.id, { job: 'Second job' })
        const after = cache.getSession(session.id)?.metadata?.swarm
        expect(after?.job).toBe('Second job')
        expect(after?.promotedAt).toBe(promotedAt!)
    })

    it('stores the worker identity and drops it when cleared', async () => {
        const { cache, session } = createCache()

        await cache.setSessionSwarm(session.id, { job: 'Job', name: 'Juno', avatarSeed: 'seed-1', scheduleId: 'sched-1' })
        expect(cache.getSession(session.id)?.metadata?.swarm).toMatchObject({ name: 'Juno', avatarSeed: 'seed-1', scheduleId: 'sched-1' })

        await cache.setSessionSwarm(session.id, { job: 'Job' })
        const after = cache.getSession(session.id)?.metadata?.swarm
        expect(after?.name).toBeUndefined()
        expect(after?.scheduleId).toBeUndefined()
    })

    it('replaces the playbook when the worker is edited', async () => {
        const { cache, session } = createCache()

        await cache.setSessionSwarm(session.id, { job: 'Source talent', playbook: 'From NeurIPS authors' })
        await cache.setSessionSwarm(session.id, { job: 'Source talent', playbook: 'From ICLR authors' })

        expect(cache.getSession(session.id)?.metadata?.swarm?.playbook).toBe('From ICLR authors')
    })

    it('leaves the rest of the metadata untouched', async () => {
        const { cache, session } = createCache()

        await cache.setSessionSwarm(session.id, { job: 'Watch the inbox' })
        const metadata = cache.getSession(session.id)?.metadata
        expect(metadata?.path).toBe('/repo')
        expect(metadata?.host).toBe('localhost')
    })

    it('rejects an unknown session instead of creating one', async () => {
        const { cache } = createCache()
        await expect(cache.setSessionSwarm('missing', { job: 'Anything' })).rejects.toThrow('Session not found')
    })
})
