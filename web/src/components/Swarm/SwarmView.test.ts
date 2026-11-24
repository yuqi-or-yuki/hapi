import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { selectWorkers } from './SwarmView'
import { draftFromRun, draftToRequest, markReviewSeen, newToReview, runMark, trustLevel, workerName, workerState } from './worker'

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    } as SessionSummary
}

function worker(id: string, job: string, promotedAt: number): SessionSummary {
    return session({ id, metadata: { path: '/repo', swarm: { job, promotedAt } } })
}

describe('selectWorkers', () => {
    it('keeps only promoted sessions, newest post first', () => {
        const sessions = [
            worker('old', 'Triage inbound leads', 100),
            session({ id: 'plain', metadata: { path: '/repo' } }),
            worker('new', 'QA production', 300)
        ]

        expect(selectWorkers(sessions).map((entry) => entry.session.id)).toEqual(['new', 'old'])
        expect(selectWorkers(sessions)[0].job).toBe('QA production')
    })

    it('ignores a swarm record with no job rather than listing a nameless worker', () => {
        const broken = session({ id: 'broken', metadata: { path: '/repo', swarm: { job: '', promotedAt: 1 } } })
        expect(selectWorkers([broken])).toEqual([])
    })
})

describe('trustLevel', () => {
    it('reads the session permission mode so the badge cannot overstate freedom', () => {
        expect(trustLevel(session({ id: 'a', permissionMode: 'bypassPermissions' }))).toBe('free')
        expect(trustLevel(session({ id: 'b', permissionMode: 'acceptEdits' }))).toBe('guarded')
        expect(trustLevel(session({ id: 'c', permissionMode: 'default' }))).toBe('asks')
        expect(trustLevel(session({ id: 'd', permissionMode: 'plan' }))).toBe('asks')
    })

    it('classifies the non-Claude free-run modes as free', () => {
        // A `yolo` Codex worker labelled "asks first" would be the worst kind
        // of wrong: it reads as supervised while it is not.
        expect(trustLevel(session({ id: 'e', permissionMode: 'yolo' }))).toBe('free')
        expect(trustLevel(session({ id: 'f', permissionMode: 'always-proceed' }))).toBe('free')
        expect(trustLevel(session({ id: 'g', permissionMode: 'safe-yolo' }))).toBe('guarded')
    })

    it('says unknown rather than guessing when no mode is reported', () => {
        expect(trustLevel(session({ id: 'h' }))).toBe('unknown')
        expect(trustLevel(session({ id: 'i', permissionMode: 'mode-from-a-newer-cli' }))).toBe('unknown')
    })
})

describe('workerState', () => {
    const run = { nextRunAt: 2_000, intervalMs: 3_600_000, paused: false, lastRunAt: null, lastError: null, recent: [] }

    it('does not treat an idle process as a problem when a schedule will wake it', () => {
        expect(workerState(session({ id: 'a', workerRun: run }))).toBe('scheduled')
        expect(workerState(session({ id: 'a' }))).toBe('onDemand')
    })

    it('puts work in progress first, then a failing schedule', () => {
        const failed = { ...run, lastError: 'runner offline' }
        expect(workerState(session({ id: 'a', workerRun: failed }))).toBe('failing')
        expect(workerState(session({ id: 'a', workerRun: failed, active: true, thinking: true }))).toBe('working')
        expect(workerState(session({ id: 'a', workerRun: { ...run, paused: true } }))).toBe('paused')
    })
})

describe('schedule drafts', () => {
    it('starts a daily schedule at the next time the clock reads that time', () => {
        const now = new Date(2026, 0, 1, 10, 0).getTime()
        const request = draftToRequest({ mode: 'daily', time: '09:00' }, now)
        expect(request).toEqual({ intervalMs: 86_400_000, firstRunAt: new Date(2026, 0, 2, 9, 0).getTime() })
    })

    it('round-trips through the worker clock', () => {
        const nextRunAt = new Date(2026, 0, 2, 9, 30).getTime()
        expect(draftFromRun({ nextRunAt, intervalMs: 86_400_000, paused: false, lastRunAt: null, lastError: null, recent: [] }))
            .toEqual({ mode: 'daily', time: '09:30' })
        expect(draftFromRun({ nextRunAt, intervalMs: 7_200_000, paused: false, lastRunAt: null, lastError: null, recent: [] }))
            .toEqual({ mode: 'every', every: 2, unit: 'hours' })
        expect(draftToRequest({ mode: 'none' }, 0)).toBeNull()
    })
})

describe('runMark', () => {
    it('separates on-time, late and missed runs', () => {
        expect(runMark({ at: 1, outcome: 'ran', lateMs: 40_000 })).toBe('onTime')
        expect(runMark({ at: 1, outcome: 'ran', lateMs: 20 * 60_000 })).toBe('late')
        expect(runMark({ at: 1, outcome: 'missed', lateMs: 0 })).toBe('missed')
    })
})

describe('newToReview', () => {
    const approval = { path: '/repo', swarm: { job: 'Review leads', promotedAt: 1, board: { columns: ['name', 'suggestedDecision', 'suggestedReason'] } } }
    const board = { count: 5, updatedAt: 10, unreviewed: 3, newestUnreviewedAt: Date.now() - 1000 }

    it('flags cards added since the worker page was last opened, and clears once it is opened', () => {
        localStorage.clear()
        const worker = session({ id: 'w1', metadata: approval, workerBoard: board })
        expect(newToReview(worker)).toBe(3)
        markReviewSeen('w1')
        expect(newToReview(worker)).toBe(0)
        // A card added after the visit raises it again.
        expect(newToReview(session({ id: 'w1', metadata: approval, workerBoard: { ...board, newestUnreviewedAt: Date.now() + 60_000 } }))).toBe(3)
    })

    it('stays quiet for boards that are not reviewed item by item, and when nothing is waiting', () => {
        localStorage.clear()
        expect(newToReview(session({ id: 'w2', metadata: { path: '/repo', swarm: { job: 'Log', promotedAt: 1 } }, workerBoard: board }))).toBe(0)
        expect(newToReview(session({ id: 'w3', metadata: approval, workerBoard: { ...board, unreviewed: 0, newestUnreviewedAt: 0 } }))).toBe(0)
    })
})

describe('workerName', () => {
    it('uses the functional name, then the session title, then the start of the job, never an invented name', () => {
        const swarm = { job: 'Check Mac disk usage every two hours', promotedAt: 1 }
        expect(workerName(session({ id: 'a', metadata: { path: '/r', name: 'Disk check', swarm: { ...swarm, name: 'Laptop Cleaner' } } }))).toBe('Laptop Cleaner')
        expect(workerName(session({ id: 'a', metadata: { path: '/r', summary: { text: 'Check laptop disk space' }, swarm } }))).toBe('Check laptop disk space')
        expect(workerName(session({ id: 'a', metadata: { path: '/r', swarm } }))).toBe('Check Mac disk')
    })
})
