import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import type { Session, SyncEngine } from '../sync/syncEngine'

/** Long enough for sessions that survived a hub-only restart to reconnect on a loaded machine. */
const GRACE_MS = 2 * 60_000
/** One worker at a time: a dozen agents starting at once is what stalls a machine that has just booted. */
const STAGGER_MS = 15_000
const RETRY_MS = 30_000
/** Keep trying for this long while the runner is still coming up. */
const GIVE_UP_MS = 15 * 60_000

type Options = {
    graceMs?: number
    staggerMs?: number
    retryMs?: number
    giveUpMs?: number
    /** Whether the process that was running a session is still alive. Injected for tests. */
    isAlive?: (session: Session) => boolean
    log?: (message: string) => void
}

/**
 * Whether the agent process recorded for a session still exists. This is what
 * tells a reboot from a hub restart: after a hub restart the process is still
 * there and will reconnect by itself, and starting a second one beside it
 * would put two agents in one session. A process on another machine cannot be
 * checked from here, so it is assumed alive and left to reconnect.
 */
export function agentProcessAlive(session: Session): boolean {
    const pid = session.metadata?.hostPid
    if (!pid) return false
    if (session.metadata?.host !== hostname()) return true
    // The pid alone is not proof after a reboot, when it may belong to something else.
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return result.status === 0 && /hapi/i.test(result.stdout)
}

/**
 * The workers to bring back: on the swarm, not running, and not archived. A
 * worker that was retired or archived stays down; one that was simply cut off
 * by a reboot is expected back, whether or not it has a schedule.
 */
export function workersToRevive(sessions: readonly Session[], isAlive: (session: Session) => boolean): Session[] {
    return sessions.filter((session) =>
        Boolean(session.metadata?.swarm)
        && !session.active
        && session.metadata?.lifecycleState !== 'archived'
        && !isAlive(session))
}

/**
 * Brings swarm workers back after the machine restarts.
 *
 * A schedule already wakes a worker for its next run, but a reboot left
 * every worker down until then, and a worker with no schedule down for good.
 * Once after the hub starts, each worker that was cut off is resumed, one at
 * a time, as soon as its machine's runner is back.
 */
export class WorkerRevivalService {
    private timer: ReturnType<typeof setTimeout> | null = null
    private stopped = false
    private readonly startedAt = Date.now()
    private readonly attempted = new Set<string>()
    private readonly options: Required<Options>

    constructor(private readonly getSyncEngine: () => SyncEngine | null, options: Options = {}) {
        this.options = {
            graceMs: options.graceMs ?? GRACE_MS,
            staggerMs: options.staggerMs ?? STAGGER_MS,
            retryMs: options.retryMs ?? RETRY_MS,
            giveUpMs: options.giveUpMs ?? GIVE_UP_MS,
            isAlive: options.isAlive ?? agentProcessAlive,
            log: options.log ?? ((message) => console.log(`[swarm] ${message}`))
        }
    }

    start(): void {
        this.schedule(this.options.graceMs)
    }

    stop(): void {
        this.stopped = true
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
    }

    private schedule(delayMs: number): void {
        if (this.stopped) return
        this.timer = setTimeout(() => void this.reviveNext(), delayMs)
    }

    /** Resumes one worker, then schedules the next look. Public so a test can drive it without timers. */
    async reviveNext(): Promise<void> {
        const engine = this.getSyncEngine()
        if (!engine || this.stopped) return
        const pending = workersToRevive(engine.getSessions(), this.options.isAlive).filter((session) => !this.attempted.has(session.id))
        if (pending.length === 0) return

        const ready = pending.find((session) => {
            const machineId = session.metadata?.machineId
            return machineId ? engine.getMachine(machineId)?.active === true : false
        })
        if (!ready) {
            // The runner is not back yet. Keep looking for a while, then stop: a
            // schedule still wakes each worker for its next run.
            if (Date.now() - this.startedAt < this.options.giveUpMs) this.schedule(this.options.retryMs)
            else this.options.log(`gave up reviving ${pending.length} worker(s): no runner came online`)
            return
        }

        // Each worker gets one attempt. One that will not start must not hold up the rest.
        this.attempted.add(ready.id)
        const name = ready.metadata?.swarm?.name ?? ready.id
        try {
            const result = await engine.resumeSession(ready.id, ready.namespace)
            this.options.log(result.type === 'success' ? `revived worker ${name}` : `could not revive worker ${name}: ${result.message}`)
        } catch (error) {
            this.options.log(`could not revive worker ${name}: ${error instanceof Error ? error.message : 'unknown error'}`)
        }
        if (Date.now() - this.startedAt < this.options.giveUpMs) this.schedule(this.options.staggerMs)
    }
}
