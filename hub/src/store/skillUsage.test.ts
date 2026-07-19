import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string, namespace: string = 'default') {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, namespace)
}

describe('skill usage tracking', () => {
    it('records a typed slash command from a user message', () => {
        const store = makeStore()
        const session = makeSession(store, 'typed-skill')

        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/pp fix the bug' } })

        expect(store.skillUsage.list('default')).toEqual([
            expect.objectContaining({ skillName: 'pp', count: 1 })
        ])
    })

    it('records an agent-triggered Skill tool_use nested in a provider envelope', () => {
        const store = makeStore()
        const session = makeSession(store, 'agent-skill')

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    message: {
                        role: 'assistant',
                        content: [
                            { type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'react-best-practices' } }
                        ]
                    }
                }
            }
        })

        expect(store.skillUsage.list('default')).toEqual([
            expect.objectContaining({ skillName: 'react-best-practices', count: 1 })
        ])
    })

    it('accumulates counts across repeated invocations of the same skill', () => {
        const store = makeStore()
        const session = makeSession(store, 'repeat-skill')

        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/ld' } })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/ld done' } })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/ld again' } })

        expect(store.skillUsage.list('default')).toEqual([
            expect.objectContaining({ skillName: 'ld', count: 3 })
        ])
    })

    it('ignores plain-text messages with no leading slash', () => {
        const store = makeStore()
        const session = makeSession(store, 'no-skill')

        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'just a normal message' } })

        expect(store.skillUsage.list('default')).toEqual([])
    })

    it('sorts by count descending, then most-recently-used', () => {
        const store = makeStore()
        const session = makeSession(store, 'sort-skill')

        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/pp one' } })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/ld one' } })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/ld two' } })

        expect(store.skillUsage.list('default').map(s => s.skillName)).toEqual(['ld', 'pp'])
    })

    it('scopes usage counts by namespace', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'ns-a', 'ns-a')
        const sessionB = makeSession(store, 'ns-b', 'ns-b')

        store.messages.addMessage(sessionA.id, { role: 'user', content: { type: 'text', text: '/pp' } })
        store.messages.addMessage(sessionB.id, { role: 'user', content: { type: 'text', text: '/ld' } })

        expect(store.skillUsage.list('ns-a')).toEqual([
            expect.objectContaining({ skillName: 'pp', count: 1 })
        ])
        expect(store.skillUsage.list('ns-b')).toEqual([
            expect.objectContaining({ skillName: 'ld', count: 1 })
        ])
    })
})
