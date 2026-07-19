import { describe, expect, it } from 'vitest'
import { computeCanCancel, STALE_OPTIMISTIC_MS } from './QueuedMessagesBar'

/**
 * Unit tests for computeCanCancel — the race guard that prevents sending
 * DELETE before the hub has a row to delete (pre-server-echo scenario).
 *
 * Key invariant: useSendMessage.onMutate creates an optimistic message with
 *   { id: localId, localId }
 * so id === localId until the server echo (message-received SSE) arrives and
 * message-window-store replaces the row with the server-assigned UUID id.
 * After that replace, id !== localId.
 *
 * Stale fallback: after STALE_OPTIMISTIC_MS without a server echo the POST
 * is guaranteed done; cancel is enabled regardless so stuck messages can
 * always be removed.
 *
 * canCancel = (hasServerEcho || isStale) && !isPending
 */
describe('computeCanCancel', () => {
    describe('hasServerEcho detection', () => {
        it('is false when id === localId (purely optimistic, no server echo)', () => {
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: false })).toBe(false)
        })

        it('is true when id !== localId (server echo replaced id with server UUID)', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })

        it('is true when localId is undefined/null (server-only row, no local tracking)', () => {
            // Rows from server-loaded history have no localId — treat as already echoed.
            expect(computeCanCancel({ id: 'server-uuid-789', localId: undefined, isPending: false })).toBe(true)
            expect(computeCanCancel({ id: 'server-uuid-789', localId: null, isPending: false })).toBe(true)
        })
    })

    describe('isPending guard', () => {
        it('is false when a cancel mutation is already in-flight, even with server echo', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: true })).toBe(false)
        })

        it('is false when purely optimistic AND isPending', () => {
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: true })).toBe(false)
        })
    })

    describe('combined conditions', () => {
        it('is true only when server echo received AND no in-flight cancel', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            // The normal case: user can click ✕ or ✎
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })
    })

    describe('stale optimistic fallback', () => {
        const localId = 'local-abc-123'
        const base = 1_000_000

        it('is false when optimistic and not yet stale', () => {
            expect(computeCanCancel({
                id: localId, localId, isPending: false,
                createdAt: base, now: base + STALE_OPTIMISTIC_MS - 1
            })).toBe(false)
        })

        it('is true when optimistic but stale (echo permanently lost)', () => {
            expect(computeCanCancel({
                id: localId, localId, isPending: false,
                createdAt: base, now: base + STALE_OPTIMISTIC_MS
            })).toBe(true)
        })

        it('is false when stale but isPending', () => {
            expect(computeCanCancel({
                id: localId, localId, isPending: true,
                createdAt: base, now: base + STALE_OPTIMISTIC_MS + 1000
            })).toBe(false)
        })

        it('is false when optimistic, stale, but no createdAt provided', () => {
            // Without createdAt we cannot determine staleness — stay disabled.
            expect(computeCanCancel({
                id: localId, localId, isPending: false,
                createdAt: undefined, now: base + STALE_OPTIMISTIC_MS + 1000
            })).toBe(false)
        })
    })
})
