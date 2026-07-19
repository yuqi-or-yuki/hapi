import type { SessionSummary, SyncEvent } from '@/types/api'

export type AgentDoneRingDecision =
    | { type: 'none' }
    | { type: 'agent-done'; key: string; sessionId: string }
    | { type: 'all-clear'; key: string; sessionId: string }

function sidebarShowsRunning(session: SessionSummary | undefined): boolean {
    return Boolean(session?.active && session.thinking)
}

function hasRunningSessionAfter(
    sessions: SessionSummary[],
    finishedSessionId: string
): boolean {
    return sessions.some(session => session.id !== finishedSessionId && sidebarShowsRunning(session))
}

function getNextSidebarRunning(previous: SessionSummary, data: unknown): boolean {
    if (!data || typeof data !== 'object') return false
    const record = data as { active?: unknown; thinking?: unknown }
    const nextActive = typeof record.active === 'boolean' ? record.active : previous.active
    const nextThinking = typeof record.thinking === 'boolean' ? record.thinking : previous.thinking
    return nextActive && nextThinking
}

export function getAgentDoneRingDecision(
    event: SyncEvent,
    previousSessions: SessionSummary[] | undefined
): AgentDoneRingDecision {
    if (!previousSessions) {
        return { type: 'none' }
    }

    if (event.type === 'session-ended' && event.reason === 'completed') {
        const previous = previousSessions.find(session => session.id === event.sessionId)
        if (!sidebarShowsRunning(previous)) {
            return { type: 'none' }
        }
        return hasRunningSessionAfter(previousSessions, event.sessionId)
            ? { type: 'agent-done', key: event.sessionId, sessionId: event.sessionId }
            : { type: 'all-clear', key: `all-clear:${event.sessionId}`, sessionId: event.sessionId }
    }

    if (event.type === 'session-updated') {
        const previous = previousSessions.find(session => session.id === event.sessionId)
        if (!previous || !sidebarShowsRunning(previous) || getNextSidebarRunning(previous, event.data)) {
            return { type: 'none' }
        }
        return hasRunningSessionAfter(previousSessions, event.sessionId)
            ? { type: 'agent-done', key: event.sessionId, sessionId: event.sessionId }
            : { type: 'all-clear', key: `all-clear:${event.sessionId}`, sessionId: event.sessionId }
    }

    return { type: 'none' }
}
