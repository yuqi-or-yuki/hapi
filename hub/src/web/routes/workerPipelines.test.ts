import { describe, expect, it } from 'bun:test'
import { Store } from '../../store'
import type { Session } from '../../sync/syncEngine'
import { handOffApprovedRows, resolveWorker } from './workerPipelines'

function worker(id: string, name: string): Session {
    return { id, namespace: 'default', metadata: { path: '/', host: 'h', swarm: { job: `${name} job`, name, promotedAt: 1 } } } as unknown as Session
}

const pendingWakes = (store: Store, sessionId: string) =>
    store.scheduledMessages.list('default', { status: 'pending' }).filter((row) => row.sourceSessionId === sessionId)

const review = (decision: 'yes' | 'no', at: string) => ({ id: at, at, decision, reason: 'because' })

describe('worker pipelines', () => {
    it('hands an approved row to the downstream worker once, and wakes it once for a burst', () => {
        const store = new Store(':memory:')
        const intake = worker('intake-000001', 'Talent Intake')
        const outreach = worker('outreach-00001', 'Outreach')
        const sessions = [intake, outreach]
        store.workerPipelines.link('default', intake.id, outreach.id)

        store.workerRecords.upsert('default', intake.id, [
            { key: 'ann', data: { name: 'Ann', approvalReviews: [review('yes', '2026-01-01')] } },
            { key: 'bo', data: { name: 'Bo', approvalReviews: [review('no', '2026-01-01')] } },
            { key: 'cy', data: { name: 'Cy' } }
        ])
        handOffApprovedRows(store, 'default', intake, ['ann', 'bo', 'cy'], sessions)
        handOffApprovedRows(store, 'default', intake, ['ann'], sessions)

        expect(store.workerPipelines.inbox('default', outreach.id).map((item) => item.key)).toEqual(['ann'])
        const wakes = pendingWakes(store, outreach.id)
        expect(wakes).toHaveLength(1)
        expect(wakes[0].text).toContain('handed over from Talent Intake')

        store.workerRecords.upsert('default', intake.id, [{ key: 'cy', data: { approvalReviews: [review('yes', '2026-01-02')] } }])
        handOffApprovedRows(store, 'default', intake, ['cy'], sessions)
        expect(pendingWakes(store, outreach.id)).toHaveLength(1)
        expect(store.workerPipelines.links('default')[0]).toMatchObject({ pending: 2, handled: 0 })
    })

    it('takes back an approval reversed before it was handled, and keeps handled items handled', () => {
        const store = new Store(':memory:')
        const intake = worker('intake-000001', 'Talent Intake')
        const outreach = worker('outreach-00001', 'Outreach')
        store.workerPipelines.link('default', intake.id, outreach.id)
        store.workerRecords.upsert('default', intake.id, [
            { key: 'ann', data: { name: 'Ann', approvalReviews: [review('yes', '2026-01-01')] } },
            { key: 'bo', data: { name: 'Bo', approvalReviews: [review('yes', '2026-01-01')] } }
        ])
        handOffApprovedRows(store, 'default', intake, ['ann', 'bo'], [intake, outreach])
        expect(store.workerPipelines.markHandled('default', outreach.id, ['bo'])).toBe(1)

        for (const key of ['ann', 'bo']) {
            store.workerRecords.upsert('default', intake.id, [{ key, data: { approvalReviews: [review('yes', '2026-01-01'), review('no', '2026-01-03')] } }])
        }
        handOffApprovedRows(store, 'default', intake, ['ann', 'bo'], [intake, outreach])

        expect(store.workerPipelines.inbox('default', outreach.id)).toEqual([])
        expect(store.workerPipelines.links('default')[0]).toMatchObject({ pending: 0, handled: 1 })
    })

    it('refuses loops and finds workers by name', () => {
        const store = new Store(':memory:')
        store.workerPipelines.link('default', 'a', 'b')
        store.workerPipelines.link('default', 'b', 'c')
        expect(() => store.workerPipelines.link('default', 'c', 'a')).toThrow('loop')
        expect(() => store.workerPipelines.link('default', 'a', 'a')).toThrow('itself')

        const sessions = [worker('intake-000001', 'Talent Intake'), worker('outreach-00001', 'Outreach')]
        expect(resolveWorker(sessions, 'talent intake').id).toBe('intake-000001')
        expect(() => resolveWorker(sessions, 'nobody')).toThrow('No worker called')
    })
})

describe('worker pipeline routes', () => {
    it('runs a pipeline end to end over HTTP: link, approve, inbox, done, and a note back', async () => {
        const { Hono } = await import('hono')
        const { createSessionsRoutes } = await import('./sessions')
        const { createWorkerPipelineRoutes } = await import('./workerPipelines')
        const store = new Store(':memory:')
        const intake = worker('intake-000001', 'Talent Intake')
        const outreach = worker('outreach-00001', 'Outreach')
        const loner = worker('loner-0000001', 'Laptop Cleaner')
        const sessions = [intake, outreach, loner]
        const engine = {
            getSessionsByNamespace: () => sessions,
            resolveSessionAccess: (id: string) => {
                const session = sessions.find((candidate) => candidate.id === id)
                return session ? { ok: true as const, sessionId: id, session } : { ok: false as const, reason: 'not-found' as const }
            }
        } as never
        const app = new Hono<{ Variables: { namespace: string } }>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createSessionsRoutes(() => engine, store) as never)
        app.route('/api', createWorkerPipelineRoutes(() => engine, store) as never)
        const call = async (method: string, path: string, body?: unknown) => {
            const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
            return { status: res.status, json: await res.json() as Record<string, any> }
        }

        expect((await call('PUT', `/sessions/${outreach.id}/worker-links`, { from: 'talent intake' })).json).toMatchObject({ ok: true, from: 'Talent Intake', to: 'Outreach' })
        expect((await call('PUT', `/sessions/${intake.id}/worker-links`, { from: 'Outreach' })).status).toBe(400)

        // The worker records a card; nothing moves until the operator's "yes".
        await call('POST', `/sessions/${intake.id}/worker-records`, { records: [{ key: 'ann', data: { name: 'Ann', email: 'ann@example.com' } }] })
        expect((await call('GET', `/sessions/${outreach.id}/worker-inbox`)).json.items).toEqual([])
        await call('POST', `/sessions/${intake.id}/worker-records`, { records: [{ key: 'ann', data: { approvalReviews: [review('yes', '2026-01-01')] } }] })

        const inbox = (await call('GET', `/sessions/${outreach.id}/worker-inbox`)).json.items
        expect(inbox).toHaveLength(1)
        expect(inbox[0]).toMatchObject({ key: 'ann', from: 'Talent Intake', approvedReason: 'because', data: { name: 'Ann', email: 'ann@example.com' } })
        expect(inbox[0].data.approvalReviews).toBeUndefined()
        expect((await call('GET', '/swarm/links')).json.links[0]).toMatchObject({ pending: 1, handled: 0 })

        expect((await call('POST', `/sessions/${outreach.id}/worker-inbox/handled`, { keys: ['ann'] })).json.count).toBe(1)
        expect((await call('GET', `/sessions/${outreach.id}/worker-inbox`)).json.items).toEqual([])
        expect((await call('GET', `/sessions/${intake.id}/worker-links`)).json.downstream[0]).toMatchObject({ name: 'Outreach', pending: 0, handled: 1 })

        // Linked workers can message each other; unlinked ones cannot.
        expect((await call('POST', `/sessions/${outreach.id}/worker-tell`, { to: 'Talent Intake', text: 'Three bounced.' })).status).toBe(200)
        expect(pendingWakes(store, intake.id).at(-1)?.text).toContain('Message from Outreach')
        expect((await call('POST', `/sessions/${loner.id}/worker-tell`, { to: 'Talent Intake', text: 'hi' })).status).toBe(403)
    })
})
