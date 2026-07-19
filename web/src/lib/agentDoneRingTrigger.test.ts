import { describe, expect, it } from 'vitest'
import { getAgentDoneRingDecision } from './agentDoneRingTrigger'
import type { SessionSummary, SyncEvent } from '@/types/api'

function session(overrides: Partial<SessionSummary>): SessionSummary {
    return {
        id: 's1',
        updatedAt: 1,
        active: false,
        activeAt: 1,
        thinking: false,
        metadata: null,
        model: null,
        effort: null,
        pendingRequestsCount: 0,
        todoProgress: null,
        loopActive: false,
        debateActive: false,
        scheduledDueAts: [],
        ...overrides
    }
}

describe('getAgentDoneRingDecision', () => {
    it('rings for a normal reply completion when the sidebar row was running', () => {
        const event: SyncEvent = {
            type: 'session-updated',
            sessionId: 's1',
            data: { active: false, thinking: false }
        }

        expect(getAgentDoneRingDecision(event, [
            session({ id: 's1', active: true, thinking: true }),
            session({ id: 's2', active: true, thinking: true })
        ])).toEqual({ type: 'agent-done', key: 's1', sessionId: 's1' })
    })

    it('uses all-clear ring when the idle update leaves zero active sessions', () => {
        const event: SyncEvent = {
            type: 'session-updated',
            sessionId: 's1',
            data: { active: false, thinking: false }
        }

        expect(getAgentDoneRingDecision(event, [session({ id: 's1', active: true, thinking: true })]))
            .toEqual({ type: 'all-clear', key: 'all-clear:s1', sessionId: 's1' })
    })

    it('rings for completed session-ended events', () => {
        const event: SyncEvent = {
            type: 'session-ended',
            sessionId: 's1',
            reason: 'completed'
        }

        expect(getAgentDoneRingDecision(event, [session({ id: 's1', active: true, thinking: true })]))
            .toEqual({ type: 'all-clear', key: 'all-clear:s1', sessionId: 's1' })
    })

    it('does not ring for stale idle updates when the sidebar row was not running', () => {
        expect(getAgentDoneRingDecision({
            type: 'session-updated',
            sessionId: 's1',
            data: { active: false, thinking: false }
        }, [session({ id: 's1', active: false, thinking: false })])).toEqual({ type: 'none' })
    })

    it('does not ring for busy updates or non-completed endings', () => {
        expect(getAgentDoneRingDecision({
            type: 'session-updated',
            sessionId: 's1',
            data: { active: true, thinking: true }
        }, [session({ id: 's1', active: true, thinking: true })])).toEqual({ type: 'none' })

        expect(getAgentDoneRingDecision({
            type: 'session-ended',
            sessionId: 's1',
            reason: 'terminated'
        }, [session({ id: 's1' })])).toEqual({ type: 'none' })
    })
})
