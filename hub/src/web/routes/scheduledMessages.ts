import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession, requireSessionFromParam, requireSyncEngine } from './guards'

const scheduleBodySchema = z.object({
    text: z.string().trim().min(1),
    dueAt: z.number().int().min(0),
    cloneBeforeSend: z.boolean().optional().default(false),
    intervalMs: z.number().int().min(60_000).nullable().optional(),
    // Omit for the default cap of 10 sends on a repeating schedule; pass null explicitly for forever.
    maxOccurrences: z.number().int().min(1).nullable().optional(),
    enabled: z.boolean().optional().default(true)
})

const statusSchema = z.enum(['pending', 'sent', 'failed', 'cancelled', 'all']).optional().default('pending')

const updateBodySchema = z.object({
    sourceSessionId: z.string().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    dueAt: z.number().int().min(0).optional(),
    cloneBeforeSend: z.boolean().optional(),
    intervalMs: z.number().int().min(60_000).nullable().optional(),
    maxOccurrences: z.number().int().min(1).nullable().optional(),
    enabled: z.boolean().optional()
})

export function createScheduledMessagesRoutes(
    store: Store,
    getSyncEngine: () => SyncEngine | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/scheduled-messages', (c) => {
        const namespace = c.get('namespace')
        const status = statusSchema.parse(c.req.query('status') ?? 'pending')
        return c.json({ scheduledMessages: store.scheduledMessages.list(namespace, { status }) })
    })

    app.get('/sessions/:id/scheduled-messages', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const namespace = c.get('namespace')
        return c.json({ scheduledMessages: store.scheduledMessages.listForSession(namespace, sessionResult.sessionId) })
    })

    app.post('/sessions/:id/scheduled-messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const body = await c.req.json().catch(() => null)
        const parsed = scheduleBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid schedule body' }, 400)
        }
        if (parsed.data.dueAt <= Date.now() + 5_000) {
            return c.json({ error: 'Schedule time must be at least 5 seconds in the future' }, 400)
        }

        const namespace = c.get('namespace')
        const scheduledMessage = store.scheduledMessages.create({
            namespace,
            sourceSessionId: sessionResult.sessionId,
            text: parsed.data.text,
            dueAt: parsed.data.dueAt,
            cloneBeforeSend: parsed.data.cloneBeforeSend,
            intervalMs: parsed.data.intervalMs ?? null,
            maxOccurrences: parsed.data.maxOccurrences,
            enabled: parsed.data.enabled
        })
        return c.json({ scheduledMessage })
    })

    app.patch('/scheduled-messages/:id', async (c) => {
        const namespace = c.get('namespace')
        const body = await c.req.json().catch(() => null)
        const parsed = updateBodySchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid update body' }, 400)
        if (parsed.data.dueAt !== undefined && parsed.data.dueAt <= Date.now() + 5_000) {
            return c.json({ error: 'Schedule time must be at least 5 seconds in the future' }, 400)
        }
        if (parsed.data.sourceSessionId !== undefined) {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const sessionResult = requireSession(c, engine, parsed.data.sourceSessionId)
            if (sessionResult instanceof Response) return sessionResult
            parsed.data.sourceSessionId = sessionResult.sessionId
        }
        const scheduledMessage = store.scheduledMessages.update(namespace, c.req.param('id'), parsed.data)
        if (!scheduledMessage) return c.json({ error: 'Pending scheduled message not found' }, 404)
        return c.json({ scheduledMessage })
    })

    app.delete('/scheduled-messages/:id', (c) => {
        const namespace = c.get('namespace')
        const scheduledMessage = store.scheduledMessages.cancel(namespace, c.req.param('id'))
        if (!scheduledMessage) return c.json({ error: 'Scheduled message not found' }, 404)
        return c.json({ scheduledMessage })
    })

    return app
}
