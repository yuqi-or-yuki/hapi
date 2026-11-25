import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { Store } from '../store'
import type { Session, SyncEngine } from '../sync/syncEngine'
import { ScheduledMessageService } from './scheduledMessageService'

const HOUR = 60 * 60_000
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0)

function setup(sessionOverrides: Partial<Session> = {}) {
    const store = new Store(':memory:')
    const session = { id: 's1', namespace: 'default', active: true, thinking: false, ...sessionOverrides } as Session
    const sent: string[] = []
    const alerts: string[] = []
    let failSend = false
    const engine = {
        getSession: (id: string) => (id === session.id ? session : undefined),
        resumeSession: async () => ({ type: 'success', sessionId: session.id }),
        sendMessage: async (_id: string, payload: { text: string }) => {
            if (failSend) throw new Error('runner offline')
            sent.push(payload.text)
        }
    } as unknown as SyncEngine
    const service = new ScheduledMessageService(store, () => engine, (_session, summary) => { alerts.push(summary) })
    const job = store.scheduledMessages.create({
        namespace: 'default',
        sourceSessionId: session.id,
        text: 'run',
        dueAt: T0,
        cloneBeforeSend: false,
        intervalMs: HOUR,
        maxOccurrences: null
    })
    const row = () => store.scheduledMessages.getById(job.id)!
    return { service, session, sent, alerts, row, setFailSend: (value: boolean) => { failSend = value } }
}

describe('ScheduledMessageService repeating jobs', () => {
    beforeEach(() => setSystemTime(new Date(T0)))
    afterEach(() => setSystemTime())

    it('keeps a failing job pending, retries with backoff, and alerts once', async () => {
        const { service, sent, alerts, row, setFailSend } = setup()
        setFailSend(true)

        await service.tick()
        expect(row().status).toBe('pending')
        expect(row().error).toBe('runner offline')
        expect(row().dueAt).toBe(T0)

        // Inside the backoff window nothing is attempted.
        setSystemTime(new Date(T0 + 30_000))
        await service.tick()
        expect(alerts).toHaveLength(0)

        setSystemTime(new Date(T0 + 61_000))
        await service.tick()
        setSystemTime(new Date(T0 + 4 * 60_000))
        await service.tick()
        expect(alerts).toHaveLength(1)

        setFailSend(false)
        setSystemTime(new Date(T0 + 10 * 60_000))
        await service.tick()
        expect(sent).toEqual(['run'])
        expect(row().error).toBeNull()
        // Late run, but the next one is still on the hour.
        expect(row().dueAt).toBe(T0 + HOUR)
    })

    it('retries a busy session within minutes instead of skipping the interval', async () => {
        const { service, session, sent, row } = setup({ thinking: true })

        await service.tick()
        expect(sent).toHaveLength(0)
        expect(row().dueAt).toBe(T0)

        session.thinking = false
        setSystemTime(new Date(T0 + 60_000))
        await service.tick()
        expect(sent).toHaveLength(0)

        setSystemTime(new Date(T0 + 2 * 60_000 + 1))
        await service.tick()
        expect(sent).toEqual(['run'])
        expect(row().dueAt).toBe(T0 + HOUR)
    })

    it('records a missed run when the session stays busy for a whole interval, then runs the current slot', async () => {
        const { service, session, sent, alerts, row } = setup({ thinking: true })

        await service.tick()
        setSystemTime(new Date(T0 + HOUR + 1000))
        await service.tick()
        expect(alerts).toHaveLength(1)
        expect(row().dueAt).toBe(T0 + HOUR)
        expect(row().error).toContain('Missed a run')

        session.thinking = false
        setSystemTime(new Date(T0 + HOUR + 3 * 60_000))
        await service.tick()
        expect(sent).toEqual(['run'])
        expect(row().dueAt).toBe(T0 + 2 * HOUR)
    })

    it('does not wake a worker for a slot outside its active window, and counts no miss', async () => {
        const { service, session, sent, alerts, row } = setup()
        // T0 is 09:00 UTC on a Thursday; a window that excludes that local hour either way.
        const hour = new Date(T0).getHours()
        const startHour = (hour + 2) % 24 === 23 ? 0 : Math.min(22, (hour + 2) % 24)
        const window = { startHour, endHour: startHour + 1 }
        session.metadata = { path: '/repo', host: 'h', swarm: { job: 'Job', promotedAt: 1, scheduleId: row().id, activeWindow: window } }

        await service.tick()
        expect(sent).toHaveLength(0)
        expect(alerts).toHaveLength(0)
        expect(row().error).toBeNull()
        expect(new Date(row().dueAt).getHours()).toBe(startHour)
        expect(row().dueAt).toBeGreaterThan(T0)
    })

    it('ends the schedule of a deleted session instead of retrying it forever', async () => {
        const { service, row } = setup()
        const store = new Store(':memory:')
        const engine = { getSession: () => undefined } as unknown as SyncEngine
        const orphanService = new ScheduledMessageService(store, () => engine)
        const orphan = store.scheduledMessages.create({
            namespace: 'default',
            sourceSessionId: 'deleted-session',
            text: 'run',
            dueAt: T0,
            cloneBeforeSend: false,
            intervalMs: HOUR,
            maxOccurrences: null
        })

        await orphanService.tick()
        expect(store.scheduledMessages.getById(orphan.id)!.status).toBe('failed')

        // Terminal: no longer due, so later polls do no work at all.
        setSystemTime(new Date(T0 + 10 * HOUR))
        expect(store.scheduledMessages.due(Date.now()).map((job) => job.id)).toEqual([])
        // A live worker's schedule is untouched.
        expect(row().status).toBe('pending')
    })
})
