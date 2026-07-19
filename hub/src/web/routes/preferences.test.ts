import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEvent } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createPreferencesRoutes } from './preferences'

function createApp(events: SyncEvent[] = []) {
    const values = new Map<string, unknown>()
    const store = {
        preferences: {
            get: (namespace: string, key: string) => values.get(`${namespace}:${key}`) ?? null,
            set: (namespace: string, key: string, value: unknown) => {
                values.set(`${namespace}:${key}`, value)
            }
        }
    }
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'alpha')
        await next()
    })
    app.route('/', createPreferencesRoutes(store as never, () => ({
        broadcast: (event: SyncEvent) => {
            events.push(event)
        }
    } as never)))
    return { app, values }
}

describe('preferences routes', () => {
    it('broadcasts preference updates to SSE subscribers', async () => {
        const events: SyncEvent[] = []
        const { app, values } = createApp(events)

        const res = await app.request('/preferences/sessionGroups', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: [{ id: 'g1', name: 'Group 1' }] })
        })

        expect(res.status).toBe(200)
        expect(values.get('alpha:sessionGroups')).toEqual([{ id: 'g1', name: 'Group 1' }])
        expect(events).toEqual([{
            type: 'preference-updated',
            namespace: 'alpha',
            key: 'sessionGroups',
            value: [{ id: 'g1', name: 'Group 1' }]
        }])
    })
})
