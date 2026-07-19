import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { SSEManager } from '../../sse/sseManager'

const putBodySchema = z.object({
    value: z.unknown()
})

export function createPreferencesRoutes(
    store: Store,
    getSseManager?: () => SSEManager | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/preferences/:key', (c) => {
        const namespace = c.get('namespace')
        const key = c.req.param('key')
        const value = store.preferences.get(namespace, key)
        return c.json({ value: value ?? null })
    })

    app.put('/preferences/:key', async (c) => {
        const namespace = c.get('namespace')
        const key = c.req.param('key')
        const body = await c.req.json()
        const parsed = putBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const value = parsed.data.value
        store.preferences.set(namespace, key, value)
        getSseManager?.()?.broadcast({
            type: 'preference-updated',
            namespace,
            key,
            value
        })
        return c.json({ value })
    })

    return app
}
