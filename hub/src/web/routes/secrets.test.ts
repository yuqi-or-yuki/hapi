import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

// An in-memory stand-in for the Keychain, so the test never touches the real one.
const vault = new Map<string, { password: string; username?: string }>()
mock.module('@hapi/protocol/secretVault', () => ({
    SECRET_NAME_PATTERN: /^[a-z0-9][a-z0-9._-]{0,62}$/,
    isSecretVaultSupported: () => true,
    writeSecret: (_namespace: string, name: string, fields: { password: string }) => { vault.set(name, fields) },
    readSecret: (_namespace: string, name: string) => vault.get(name) ?? null,
    deleteSecret: (_namespace: string, name: string) => vault.delete(name)
}))

const { Store } = await import('../../store')
const { createSecretsRoutes } = await import('./secrets')
type WebAppEnv = import('../middleware/auth').WebAppEnv

function createApp() {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSecretsRoutes(new Store(':memory:')))
    const send = (method: string, path: string, body?: unknown) => app.request(`/api${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { send }
}

describe('secrets routes', () => {
    it('stores a login and never returns its password', async () => {
        const { send } = createApp()
        const put = await send('PUT', '/secrets/work-email', { username: 'me@example.com', password: 'hunter2', url: 'https://mail.example.com' })
        expect(put.status).toBe(200)
        expect(vault.get('work-email')?.password).toBe('hunter2')

        const listed = await (await send('GET', '/secrets')).text()
        expect(listed).toContain('me@example.com')
        expect(listed).not.toContain('hunter2')
        expect(await put.text()).not.toContain('hunter2')
    })

    it('keeps the stored password when an edit omits it', async () => {
        const { send } = createApp()
        await send('PUT', '/secrets/bank', { username: 'old', password: 's3cret' })
        const edit = await send('PUT', '/secrets/bank', { username: 'new' })
        expect(edit.status).toBe(200)
        expect(vault.get('bank')).toMatchObject({ username: 'new', password: 's3cret' })
    })

    it('rejects a new secret with no password and unsafe names', async () => {
        const { send } = createApp()
        expect((await send('PUT', '/secrets/empty', { username: 'x' })).status).toBe(400)
        expect((await send('PUT', '/secrets/Bad%20Name', { password: 'x' })).status).toBe(400)
    })

    it('records who last read a secret and forgets it on delete', async () => {
        const { send } = createApp()
        await send('PUT', '/secrets/crm', { password: 'x' })
        await send('POST', '/secrets/crm/used', { sessionId: 'session-1' })
        const { secrets } = await (await send('GET', '/secrets')).json() as { secrets: Array<{ name: string; lastUsedBy?: string }> }
        expect(secrets.find((secret) => secret.name === 'crm')?.lastUsedBy).toBe('session-1')

        await send('DELETE', '/secrets/crm')
        expect(vault.has('crm')).toBe(false)
        expect((await (await send('GET', '/secrets')).json() as { secrets: unknown[] }).secrets).toHaveLength(0)
    })
})
