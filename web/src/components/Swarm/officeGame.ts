import Phaser from 'phaser'
import indoorUrl from '@/assets/office/indoor.png'
import charactersUrl from '@/assets/office/characters.png'
import { FURNITURE, GRID, ROOMS, TILE, findPath, isFloor, pickSpot, restMs, roomAt, type RoomId, type Tile } from './office'
import { hashSeed } from './worker'

const WIDTH = GRID.cols * TILE
const HEIGHT = GRID.rows * TILE
const INDOOR_COLS = 27
const CHARACTER_COLS = 54
/** Pixels per second. A stroll, not a sprint. */
const SPEED = 30

export type OfficeMarker = 'review' | 'working' | 'failing' | null
export type OfficeWorker = { id: string; seed: string; name: string; room: RoomId; marker: OfficeMarker }

export type OfficeGame = {
    setWorkers: (workers: readonly OfficeWorker[]) => void
    /** The worker under the pointer stands still so its card can be read. */
    setHeld: (id: string | null) => void
    destroy: () => void
}

type Callbacks = {
    /** `at` is the worker's head, as a fraction of the floor's width and height. */
    onHover: (id: string | null, at: { x: number; y: number } | null) => void
    onOpen: (id: string) => void
}

const FLOORS: Record<RoomId, { base: number; line: number }> = {
    desks: { base: 0xc9a777, line: 0xb8935f },
    lounge: { base: 0x8fb7c9, line: 0x7da6b9 },
    review: { base: 0x9bc48c, line: 0x89b47a },
    repair: { base: 0xb9b6ae, line: 0xa6a39b }
}
const DOOR_FLOOR = { base: 0xb39a78, line: 0xa0876a }

// Character parts on the sheet, as [col, row]. One of each is picked per worker from its seed.
const BODIES = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]] as const
const PANTS = [[3, 0], [3, 1], [3, 5], [3, 6], [3, 7]] as const
const SHIRTS = [[6, 0], [10, 0], [14, 0], [6, 5], [10, 5], [14, 5], [8, 1], [12, 1], [16, 1], [8, 6]] as const
const HAIR = [[19, 0], [21, 0], [22, 1], [23, 0], [25, 0], [26, 1], [19, 4], [21, 4], [22, 5], [23, 4], [25, 4], [26, 5], [19, 8], [21, 8]] as const

const frame = (cols: number, [col, row]: readonly [number, number] | readonly number[]) => row * cols + col
const centre = (tile: Tile) => ({ x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 2 })

type Actor = {
    worker: OfficeWorker
    body: Phaser.GameObjects.Container
    figure: Phaser.GameObjects.Container
    marker: Phaser.GameObjects.Arc
    tile: Tile
    path: Tile[]
    /** Wall-clock time of the next wander, so it survives the loop being asleep. */
    moveAt: number
}

class OfficeScene extends Phaser.Scene {
    private actors = new Map<string, Actor>()
    private pending: readonly OfficeWorker[] = []
    private held: string | null = null
    private ready = false
    private wakeTimer: number | undefined

    constructor(private readonly callbacks: Callbacks) {
        super('office')
    }

    preload(): void {
        this.load.spritesheet('indoor', indoorUrl, { frameWidth: TILE, frameHeight: TILE, spacing: 1 })
        this.load.spritesheet('characters', charactersUrl, { frameWidth: TILE, frameHeight: TILE, spacing: 1 })
    }

    create(): void {
        this.bakeFloor()
        this.ready = true
        this.setWorkers(this.pending)

        const canvas = this.game.canvas
        canvas.addEventListener('pointermove', this.onPointerMove)
        canvas.addEventListener('pointerdown', this.onPointerDown)
        this.events.once(Phaser.Scenes.Events.DESTROY, () => {
            canvas.removeEventListener('pointermove', this.onPointerMove)
            canvas.removeEventListener('pointerdown', this.onPointerDown)
            window.clearTimeout(this.wakeTimer)
        })
    }

    /** Floors, walls and furniture never change, so they are drawn once into a single texture. */
    private bakeFloor(): void {
        const floor = this.add.renderTexture(0, 0, WIDTH, HEIGHT).setOrigin(0).setDepth(-1)
        const brush = this.make.graphics({}, false)
        brush.fillStyle(0x3b3f52).fillRect(0, 0, WIDTH, HEIGHT)
        for (let y = 0; y < GRID.rows; y += 1) {
            for (let x = 0; x < GRID.cols; x += 1) {
                const px = x * TILE
                const py = y * TILE
                if (!isFloor({ x, y })) {
                    // A wall with a lit top edge, so rooms read as enclosed.
                    brush.fillStyle(0x4a4f66).fillRect(px, py, TILE, TILE)
                    brush.fillStyle(0x5d6380).fillRect(px, py, TILE, 3)
                    continue
                }
                const room = roomAt({ x, y })
                const colours = room ? FLOORS[room] : DOOR_FLOOR
                brush.fillStyle(colours.base).fillRect(px, py, TILE, TILE)
                brush.fillStyle(colours.line).fillRect(px, py + TILE - 1, TILE, 1)
                // Staggered plank ends give the floor a little texture.
                brush.fillRect(px + ((x + y * 3) % 2 === 0 ? 7 : 15), py, 1, TILE)
            }
        }
        floor.draw(brush)
        brush.destroy()
        for (const item of FURNITURE) {
            item.tiles.forEach((row, dy) => row.forEach((cell, dx) => {
                floor.drawFrame('indoor', frame(INDOOR_COLS, cell), (item.x + dx) * TILE, (item.y + dy) * TILE)
            }))
        }
    }

    setWorkers(workers: readonly OfficeWorker[]): void {
        this.pending = workers
        if (!this.ready) return
        const seen = new Set<string>()
        for (const worker of workers) {
            seen.add(worker.id)
            const actor = this.actors.get(worker.id)
            if (!actor) {
                this.actors.set(worker.id, this.spawn(worker))
                continue
            }
            const moved = actor.worker.room !== worker.room
            if (actor.worker.name !== worker.name) (actor.body.getByName('label') as Phaser.GameObjects.Text).setText(worker.name)
            actor.worker = worker
            this.paintMarker(actor)
            // A change of state sends the worker to its new room straight away.
            if (moved) actor.moveAt = 0
        }
        for (const [id, actor] of this.actors) {
            if (seen.has(id)) continue
            actor.body.destroy()
            this.actors.delete(id)
        }
        this.wake()
    }

    setHeld(id: string | null): void {
        this.held = id
        this.wake()
    }

    private spawn(worker: OfficeWorker): Actor {
        const hash = hashSeed(worker.seed)
        const tile = pickSpot(worker.room, this.takenTiles(null))
        const at = centre(tile)
        const part = (options: readonly (readonly number[])[], shift: number) =>
            this.add.image(0, 0, 'characters', frame(CHARACTER_COLS, options[(hash >>> shift) % options.length])).setOrigin(0.5, 1)
        const figure = this.add.container(0, 0, [part(BODIES, 0), part(PANTS, 5), part(SHIRTS, 9), part(HAIR, 15)])
        const marker = this.add.circle(6, -17, 2.5, 0xffffff).setStrokeStyle(1, 0xffffff)
        const label = this.add.text(0, 1, worker.name, { fontFamily: 'system-ui, sans-serif', fontSize: '6px', color: '#ffffff', backgroundColor: '#1f2333cc', padding: { x: 2, y: 0 }, resolution: 6 })
            .setOrigin(0.5, 0).setName('label')
        label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
        const body = this.add.container(at.x, at.y, [figure, marker, label]).setDepth(at.y)
        const actor: Actor = { worker, body, figure, marker, tile, path: [], moveAt: Date.now() + restMs(worker.room) * Math.random() }
        this.paintMarker(actor)
        return actor
    }

    private paintMarker(actor: Actor): void {
        const colour = { review: 0xef4444, failing: 0xef4444, working: 0x10b981 }[actor.worker.marker ?? 'working']
        actor.marker.setVisible(actor.worker.marker !== null).setFillStyle(colour)
    }

    private takenTiles(except: string | null): Tile[] {
        return [...this.actors.values()].filter((actor) => actor.worker.id !== except).map((actor) => actor.path.at(-1) ?? actor.tile)
    }

    update(time: number, delta: number): void {
        const now = Date.now()
        let walking = false
        let nextMoveAt = Infinity
        for (const actor of this.actors.values()) {
            if (actor.worker.id === this.held) {
                actor.figure.y = 0
                continue
            }
            if (actor.path.length === 0 && now >= actor.moveAt) {
                actor.path = findPath(actor.tile, pickSpot(actor.worker.room, this.takenTiles(actor.worker.id)))
                // Nowhere to go (boxed in): try again later rather than every frame.
                if (actor.path.length === 0) actor.moveAt = now + restMs(actor.worker.room)
            }
            if (actor.path.length === 0) {
                actor.figure.y = 0
                nextMoveAt = Math.min(nextMoveAt, actor.moveAt)
                continue
            }
            walking = true
            const target = centre(actor.path[0])
            const dx = target.x - actor.body.x
            const dy = target.y - actor.body.y
            const distance = Math.hypot(dx, dy)
            const stride = (SPEED * delta) / 1000
            if (distance <= stride) {
                actor.body.setPosition(target.x, target.y)
                actor.tile = actor.path.shift()!
                if (actor.path.length === 0) actor.moveAt = now + restMs(actor.worker.room)
            } else {
                actor.body.setPosition(actor.body.x + (dx / distance) * stride, actor.body.y + (dy / distance) * stride)
                if (dx !== 0) actor.figure.setScale(dx < 0 ? -1 : 1, 1)
            }
            // A two-frame hop stands in for a walk cycle the art does not have.
            actor.figure.y = Math.floor(time / 140) % 2 === 0 ? 0 : -1
            actor.body.setDepth(actor.body.y)
        }
        if (!walking) this.sleepUntil(nextMoveAt)
    }

    /**
     * Nothing is moving, so stop the render loop entirely until the next
     * wander is due. An office of resting workers costs no frames at all.
     */
    private sleepUntil(at: number): void {
        this.game.loop.sleep()
        window.clearTimeout(this.wakeTimer)
        if (Number.isFinite(at)) this.wakeTimer = window.setTimeout(() => this.wake(), Math.max(50, at - Date.now()))
    }

    private wake(): void {
        window.clearTimeout(this.wakeTimer)
        if (this.ready) this.game.loop.wake()
    }

    /** Hit-testing is done on plain DOM events so it keeps working while the loop sleeps. */
    private actorAt(event: PointerEvent): Actor | null {
        const bounds = this.game.canvas.getBoundingClientRect()
        const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH
        const y = ((event.clientY - bounds.top) / bounds.height) * HEIGHT
        let hit: Actor | null = null
        for (const actor of this.actors.values()) {
            const inside = Math.abs(x - actor.body.x) <= 9 && y >= actor.body.y - 20 && y <= actor.body.y + 9
            if (inside && (!hit || actor.body.y > hit.body.y)) hit = actor
        }
        return hit
    }

    private onPointerMove = (event: PointerEvent): void => {
        const actor = this.actorAt(event)
        this.game.canvas.style.cursor = actor ? 'pointer' : 'default'
        this.callbacks.onHover(actor?.worker.id ?? null, actor ? { x: actor.body.x / WIDTH, y: (actor.body.y - TILE) / HEIGHT } : null)
    }

    private onPointerDown = (event: PointerEvent): void => {
        const actor = this.actorAt(event)
        if (!actor) return
        // Touch has no hover: the first tap shows the card, a tap on a shown card's worker opens it.
        if (event.pointerType !== 'mouse' && this.held !== actor.worker.id) this.onPointerMove(event)
        else this.callbacks.onOpen(actor.worker.id)
    }
}

/**
 * Starts the office in `parent`. Kept cheap on purpose: a capped frame rate,
 * a floor baked into one texture, a low-power GPU request, and a render loop
 * that sleeps whenever every worker is standing still.
 */
export function createOfficeGame(parent: HTMLElement, callbacks: Callbacks): OfficeGame {
    const scene = new OfficeScene(callbacks)
    const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent,
        width: WIDTH,
        height: HEIGHT,
        pixelArt: true,
        backgroundColor: '#3b3f52',
        banner: false,
        audio: { noAudio: true },
        input: { keyboard: false, mouse: false, touch: false, gamepad: false },
        fps: { target: 30, limit: 30 },
        render: { powerPreference: 'low-power', antialias: false },
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.NO_CENTER },
        scene
    })
    return {
        setWorkers: (workers) => scene.setWorkers(workers),
        setHeld: (id) => scene.setHeld(id),
        destroy: () => game.destroy(true)
    }
}

export const OFFICE_ASPECT = WIDTH / HEIGHT
