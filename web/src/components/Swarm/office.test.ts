import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { DOORS, FURNITURE, ROOMS, SEATS, findPath, isWalkable, pickSpot, restMs, roomAt, roomFor } from './office'

function worker(overrides: Partial<SessionSummary>): SessionSummary {
    return {
        id: 'w', active: false, thinking: false, activeAt: 0, updatedAt: 0,
        metadata: { path: '/r', swarm: { job: 'Job', promotedAt: 1 } },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
        ...overrides
    } as SessionSummary
}
const run = { nextRunAt: 9e15, intervalMs: 3_600_000, paused: false, lastRunAt: null, lastError: null, recent: [] }
const random = (seed: number) => () => (seed = (seed * 9301 + 49297) % 233280) / 233280

describe('roomFor', () => {
    it('puts each worker in the room that matches its state', () => {
        expect(roomFor(worker({ active: true, thinking: true }))).toBe('desks')
        expect(roomFor(worker({ workerRun: run }))).toBe('lounge')
        expect(roomFor(worker({ workerRun: { ...run, lastError: 'runner offline' } }))).toBe('repair')
        expect(roomFor(worker({ metadata: { path: '/r', swarm: { job: 'Job', promotedAt: 1, board: { columns: ['name', 'suggestedDecision', 'suggestedReason'] } } }, workerBoard: { count: 2, updatedAt: 1, unreviewed: 2, newestUnreviewedAt: Date.now() } }))).toBe('review')
    })
})

describe('the floor plan', () => {
    it('keeps walls and furniture solid, and doors, seats and rugs open', () => {
        expect(isWalkable({ x: 0, y: 0 })).toBe(false)
        expect(isWalkable({ x: 19, y: 3 })).toBe(false)
        for (const door of DOORS) expect(isWalkable(door)).toBe(true)
        for (const seat of SEATS) expect(isWalkable(seat)).toBe(true)
        const desk = FURNITURE[0]
        expect(isWalkable({ x: desk.x, y: desk.y })).toBe(false)
    })

    it('connects every room to every other', () => {
        const spots = ROOMS.map((room) => pickSpot(room.id, [], random(7)))
        for (const from of spots) {
            for (const to of spots) {
                if (from !== to) expect(findPath(from, to).length).toBeGreaterThan(0)
            }
        }
    })

    it('walks only through open tiles, one step at a time, and ends at the target', () => {
        const from = SEATS[0]
        const to = pickSpot('repair', [], random(3))
        const path = findPath(from, to)
        let previous = from
        for (const step of path) {
            expect(isWalkable(step)).toBe(true)
            expect(Math.abs(step.x - previous.x) + Math.abs(step.y - previous.y)).toBe(1)
            previous = step
        }
        expect(previous).toEqual(to)
    })
})

describe('pickSpot', () => {
    it('always lands on an open tile of the right room', () => {
        for (const room of ROOMS) {
            const next = random(room.x * 31 + 1)
            for (let i = 0; i < 40; i += 1) {
                const spot = pickSpot(room.id, [], next)
                expect(isWalkable(spot)).toBe(true)
                expect(roomAt(spot)).toBe(room.id)
            }
        }
    })

    it('seats busy workers at free desks before anywhere else', () => {
        const taken = SEATS.slice(1)
        expect(pickSpot('desks', taken, random(5))).toEqual(SEATS[0])
        expect(SEATS).not.toContainEqual(pickSpot('lounge', [], random(5)))
    })

    it('lets only lounging workers wander; busy, waiting and broken ones stand still', () => {
        const wander = restMs('lounge', () => 1)
        for (const room of ['desks', 'review', 'repair'] as const) expect(restMs(room, () => 0)).toBeGreaterThan(wander * 10)
    })
})
