import { Hono } from 'hono'
import { z } from 'zod'
import { deleteSecret, isSecretVaultSupported, readSecret, secretStorage, SECRET_NAME_PATTERN, writeSecret } from '@hapi/protocol/secretVault'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

/** What the hub knows about a secret. The password itself is only ever in the machine's vault (see secretVault). */
export type SecretEntry = {
    name: string
    username?: string
    url?: string
    note?: string
    updatedAt: number
    lastUsedAt?: number
    /** The session that last read it, so an unexpected read can be traced. */
    lastUsedBy?: string
}

const INDEX_KEY = 'secrets.index'

const putBodySchema = z.object({
    /** Omit when editing to keep the stored password. */
    password: z.string().min(1).max(4096).optional(),
    username: z.string().trim().max(200).optional(),
    url: z.string().trim().max(500).optional(),
    note: z.string().trim().max(500).optional()
})

const usedBodySchema = z.object({ sessionId: z.string().max(100).optional() })

/**
 * Stored logins for agents. Deliberately has no route that returns a password:
 * the web can add, replace and remove secrets, and agents read them from the
 * vault on the machine itself (`hapi secret get`), so a value never travels
 * back out over HTTP.
 */
export function createSecretsRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const loadIndex = (namespace: string): SecretEntry[] => {
        const value = store.preferences.get(namespace, INDEX_KEY)
        return Array.isArray(value) ? value as SecretEntry[] : []
    }
    const saveIndex = (namespace: string, entries: SecretEntry[]): void => {
        store.preferences.set(namespace, INDEX_KEY, [...entries].sort((a, b) => a.name.localeCompare(b.name)))
    }

    app.get('/secrets', (c) => {
        return c.json({ supported: isSecretVaultSupported(), storage: secretStorage(), secrets: loadIndex(c.get('namespace')) })
    })

    app.put('/secrets/:name', async (c) => {
        const namespace = c.get('namespace')
        const name = c.req.param('name')
        if (!SECRET_NAME_PATTERN.test(name)) {
            return c.json({ error: 'Names use lowercase letters, digits, dots, dashes and underscores' }, 400)
        }
        const parsed = putBodySchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid secret' }, 400)

        try {
            const password = parsed.data.password ?? readSecret(namespace, name)?.password
            if (!password) return c.json({ error: 'A password is required' }, 400)
            const { username, url, note } = parsed.data
            writeSecret(namespace, name, { password, username: username || undefined, url: url || undefined, note: note || undefined })

            const index = loadIndex(namespace)
            const previous = index.find((entry) => entry.name === name)
            const entry: SecretEntry = {
                name,
                username: username || undefined,
                url: url || undefined,
                note: note || undefined,
                updatedAt: Date.now(),
                lastUsedAt: previous?.lastUsedAt,
                lastUsedBy: previous?.lastUsedBy
            }
            saveIndex(namespace, [...index.filter((item) => item.name !== name), entry])
            return c.json({ secret: entry })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to store the secret' }, 500)
        }
    })

    /** Reported by `hapi secret get`, so the Secrets page can show who read what, and when. */
    app.post('/secrets/:name/used', async (c) => {
        const namespace = c.get('namespace')
        const name = c.req.param('name')
        const parsed = usedBodySchema.safeParse(await c.req.json().catch(() => ({})))
        const index = loadIndex(namespace)
        const entry = index.find((item) => item.name === name)
        if (!entry) return c.json({ error: 'Secret not found' }, 404)
        entry.lastUsedAt = Date.now()
        entry.lastUsedBy = parsed.success ? parsed.data.sessionId : undefined
        saveIndex(namespace, index)
        return c.json({ ok: true })
    })

    app.delete('/secrets/:name', (c) => {
        const namespace = c.get('namespace')
        const name = c.req.param('name')
        if (!SECRET_NAME_PATTERN.test(name)) return c.json({ error: 'Secret not found' }, 404)
        try {
            deleteSecret(namespace, name)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to remove the secret' }, 500)
        }
        saveIndex(namespace, loadIndex(namespace).filter((entry) => entry.name !== name))
        return c.json({ ok: true })
    })

    return app
}
