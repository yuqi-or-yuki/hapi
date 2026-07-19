import { Hono } from 'hono'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

export function createSkillUsageRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/skills/usage', (c) => {
        const namespace = c.get('namespace')
        return c.json({ skills: store.skillUsage.list(namespace) })
    })

    return app
}
