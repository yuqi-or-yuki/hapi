import type { SessionSummary } from '@/types/api'
import { newToReview, workerState } from './worker'

/** The office is a grid of 16 px tiles. Everything below is in tile coordinates. */
export const TILE = 16
export const GRID = { cols: 40, rows: 24 }

export type RoomId = 'desks' | 'lounge' | 'review' | 'repair'
export type Tile = { x: number; y: number }
export type Room = { id: RoomId; x: number; y: number; w: number; h: number }

/**
 * The rooms mean something, so a glance at who is where is a status report:
 * busy workers are at the desks, workers between runs are in the lounge,
 * workers waiting on you are in the review room, and broken ones are in repair.
 */
export const ROOMS: readonly Room[] = [
    { id: 'desks', x: 1, y: 1, w: 18, h: 22 },
    { id: 'lounge', x: 20, y: 1, w: 19, h: 10 },
    { id: 'review', x: 20, y: 12, w: 10, h: 11 },
    { id: 'repair', x: 31, y: 12, w: 8, h: 11 }
]

/** Gaps in the walls. Every room is reachable from every other through these. */
export const DOORS: readonly Tile[] = [
    { x: 19, y: 6 }, { x: 19, y: 17 }, { x: 25, y: 11 }, { x: 34, y: 11 }, { x: 30, y: 17 }
]

/** A piece of furniture: where it stands, and which tiles of the art sheet draw it. */
export type Furniture = {
    x: number
    y: number
    /** Columns and rows on the indoor sheet, one entry per tile, row by row. */
    tiles: readonly (readonly [col: number, row: number])[][]
    /** Rugs and wall art can be walked over. */
    walkable?: boolean
}

const table = (x: number, y: number): Furniture => ({ x, y, tiles: [[[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1]]] })
const chair = (x: number, y: number): Furniture => ({ x, y, tiles: [[[1, 4]]], walkable: true })
const plant = (x: number, y: number, kind = 16): Furniture => ({ x, y, tiles: [[[kind, 0]]] })

/** Where a busy worker sits: the chair in front of each desk. */
export const SEATS: readonly Tile[] = [
    { x: 4, y: 6 }, { x: 12, y: 6 }, { x: 4, y: 12 }, { x: 12, y: 12 }, { x: 4, y: 18 }, { x: 12, y: 18 }
]

export const FURNITURE: readonly Furniture[] = [
    // Desks: six desks, each with a chair.
    ...SEATS.flatMap((seat) => [table(seat.x - 1, seat.y - 2), chair(seat.x, seat.y)]),
    plant(1, 1), plant(18, 22, 17), plant(18, 1, 17),
    // Lounge: a coffee counter, a round table on a rug, a piano, plants.
    { x: 21, y: 1, tiles: [[[4, 12], [5, 12], [6, 12], [7, 12]]] },
    { x: 26, y: 5, tiles: [[[23, 0], [24, 0], [25, 0]], [[23, 1], [24, 1], [25, 1]], [[23, 2], [24, 2], [25, 2]]], walkable: true },
    { x: 27, y: 6, tiles: [[[7, 0]]] },
    { x: 35, y: 1, tiles: [[[23, 8], [24, 8]], [[23, 9], [24, 9]]] },
    plant(38, 1), plant(20, 10, 17), plant(38, 10),
    // Review room: a meeting table with chairs, pictures on the wall.
    table(23, 16), chair(24, 18), chair(23, 18), chair(25, 18),
    plant(20, 22), plant(29, 12, 17),
    // Repair: a workbench and shelves.
    { x: 32, y: 12, tiles: [[[0, 12], [1, 12], [2, 12]]] },
    { x: 36, y: 12, tiles: [[[19, 17], [20, 17]]] },
    plant(38, 22, 17)
]

const key = (tile: Tile) => tile.y * GRID.cols + tile.x

function buildBlocked(): Set<number> {
    const open = new Set<number>()
    for (const room of ROOMS) {
        for (let y = room.y; y < room.y + room.h; y += 1) {
            for (let x = room.x; x < room.x + room.w; x += 1) open.add(key({ x, y }))
        }
    }
    for (const door of DOORS) open.add(key(door))
    for (const item of FURNITURE) {
        if (item.walkable) continue
        item.tiles.forEach((row, dy) => row.forEach((_, dx) => open.delete(key({ x: item.x + dx, y: item.y + dy }))))
    }
    const blocked = new Set<number>()
    for (let y = 0; y < GRID.rows; y += 1) {
        for (let x = 0; x < GRID.cols; x += 1) if (!open.has(key({ x, y }))) blocked.add(key({ x, y }))
    }
    return blocked
}

const BLOCKED = buildBlocked()

export function isWalkable(tile: Tile): boolean {
    return tile.x >= 0 && tile.y >= 0 && tile.x < GRID.cols && tile.y < GRID.rows && !BLOCKED.has(key(tile))
}

/** Whether a tile is floor or a doorway, as opposed to wall. Furniture stands on floor. */
export function isFloor(tile: Tile): boolean {
    return DOORS.some((door) => door.x === tile.x && door.y === tile.y)
        || ROOMS.some((room) => tile.x >= room.x && tile.x < room.x + room.w && tile.y >= room.y && tile.y < room.y + room.h)
}

export function roomAt(tile: Tile): RoomId | null {
    return ROOMS.find((room) => tile.x >= room.x && tile.x < room.x + room.w && tile.y >= room.y && tile.y < room.y + room.h)?.id ?? null
}

export function roomFor(session: SessionSummary): RoomId {
    const state = workerState(session)
    if (state === 'failing') return 'repair'
    if (state === 'working') return 'desks'
    if (session.metadata?.swarm?.review || newToReview(session) > 0) return 'review'
    return 'lounge'
}

/**
 * A tile to walk to inside a room. A busy worker takes a free desk; anyone
 * else gets the candidate farthest from the others, which keeps workers from
 * stacking up without any collision handling.
 */
export function pickSpot(roomId: RoomId, taken: readonly Tile[], random: () => number = Math.random): Tile {
    if (roomId === 'desks') {
        const free = SEATS.filter((seat) => !taken.some((other) => other.x === seat.x && other.y === seat.y))
        if (free.length > 0) return free[Math.floor(random() * free.length)]
    }
    const room = ROOMS.find((candidate) => candidate.id === roomId)!
    let best: Tile = { x: room.x, y: room.y }
    let bestGap = -1
    for (let attempt = 0; attempt < 12; attempt += 1) {
        // The bottom row is left free: it holds the room's sign, and a name tag below it would leave the floor.
        const candidate = { x: room.x + Math.floor(random() * room.w), y: room.y + Math.floor(random() * (room.h - 1)) }
        if (!isWalkable(candidate)) continue
        const gap = taken.reduce((nearest, other) => Math.min(nearest, Math.abs(candidate.x - other.x) + Math.abs(candidate.y - other.y)), 99)
        if (gap > bestGap) {
            best = candidate
            bestGap = gap
        }
    }
    return bestGap >= 0 ? best : firstWalkable(room)
}

function firstWalkable(room: Room): Tile {
    for (let y = room.y; y < room.y + room.h; y += 1) {
        for (let x = room.x; x < room.x + room.w; x += 1) if (isWalkable({ x, y })) return { x, y }
    }
    return { x: room.x, y: room.y }
}

const STEPS: readonly Tile[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]

/**
 * The shortest walk from one tile to another around walls and furniture,
 * as the tiles to step through (excluding the start). Breadth-first over a
 * 40 x 24 grid: at most 960 cells, run once per walk, never per frame.
 */
export function findPath(from: Tile, to: Tile): Tile[] {
    if (!isWalkable(to) || (from.x === to.x && from.y === to.y)) return []
    const cameFrom = new Map<number, number>([[key(from), -1]])
    const queue: Tile[] = [from]
    for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head]
        if (current.x === to.x && current.y === to.y) break
        for (const step of STEPS) {
            const next = { x: current.x + step.x, y: current.y + step.y }
            if (!isWalkable(next) || cameFrom.has(key(next))) continue
            cameFrom.set(key(next), key(current))
            queue.push(next)
        }
    }
    if (!cameFrom.has(key(to))) return []
    const path: Tile[] = []
    for (let cursor = key(to); cursor !== key(from); cursor = cameFrom.get(cursor)!) {
        path.push({ x: cursor % GRID.cols, y: Math.floor(cursor / GRID.cols) })
    }
    return path.reverse()
}

/**
 * How long a worker stays put before moving again. Only the lounge is for
 * wandering: a busy worker stays at its desk, and one that is waiting on you
 * or broken stands where it is, holding its sign, so it is easy to find.
 */
export function restMs(room: RoomId, random: () => number = Math.random): number {
    const [min, max] = room === 'lounge' ? [4_000, 11_000] : [5 * 60_000, 10 * 60_000]
    return Math.round(min + random() * (max - min))
}
