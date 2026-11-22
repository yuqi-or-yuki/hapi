import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { invokedSkillName } from './skillInvocations'

describe('invokedSkillName', () => {
    it('reads the leading command token of a prompt', () => {
        expect(invokedSkillName('/ppd ship it')).toBe('ppd')
        expect(invokedSkillName('$hapi-worker')).toBe('hapi-worker')
        expect(invokedSkillName('  /Short')).toBe('short')
        expect(invokedSkillName('/vercel:deploy now')).toBe('vercel:deploy')
    })

    it('ignores prose, mid-text slashes and junk tokens', () => {
        expect(invokedSkillName('look in src/lib for it')).toBeNull()
        expect(invokedSkillName('cost is $40 today')).toBeNull()
        expect(invokedSkillName('/')).toBeNull()
        // A pasted path is not a skill call.
        expect(invokedSkillName('/Users/someone/notes')).toBeNull()
        expect(invokedSkillName(undefined)).toBeNull()
    })
})

describe('SkillInvocationStore', () => {
    function seed() {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('s1', { path: '/tmp', host: 'h' }, null, 'default')
        return { store, sessionId: session.id }
    }

    it('counts invocations and tracks when each was last used', async () => {
        const { store, sessionId } = seed()
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: '/ppd go' } }, 'a')
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: '$ppd again' } }, 'b')
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: '/cfwt' } }, 'c')
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: 'just a question' } }, 'd')

        const counts = await store.skillInvocations.all()
        expect(counts.ppd.calls).toBe(2)
        expect(counts.cfwt.calls).toBe(1)
        expect(counts['just']).toBeUndefined()
        expect(counts.ppd.lastUsedAt).toBeGreaterThan(0)
    })

    it('ignores agent output, counting only prompts the operator sent', async () => {
        const { store, sessionId } = seed()
        // Agent messages carry no localId; only a sent prompt does.
        store.messages.addMessage(sessionId, { role: 'agent', content: { type: 'text', text: '/ppd' } }, undefined)
        expect((await store.skillInvocations.all()).ppd).toBeUndefined()
    })

    it('picks up new prompts on a later pass without recounting old ones', async () => {
        const { store, sessionId } = seed()
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: '/ppd' } }, 'a')
        expect((await store.skillInvocations.all()).ppd.calls).toBe(1)

        // Written in the same millisecond as the first: counted by rowid, so
        // the tie that an exclusive timestamp watermark used to drop is safe.
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: '/ppd' } }, 'b')
        expect((await store.skillInvocations.all()).ppd.calls).toBe(2)
        // A pass with nothing new must not double-count what it already saw.
        expect((await store.skillInvocations.all()).ppd.calls).toBe(2)
    })

    it('counts a prompt long enough to be stored compressed', async () => {
        const { store, sessionId } = seed()
        const text = '/ppd ' + 'x'.repeat(2000)
        store.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text } }, 'a')
        expect((await store.skillInvocations.all()).ppd.calls).toBe(1)
    })
})
