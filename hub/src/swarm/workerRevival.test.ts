import { describe, expect, it } from 'bun:test'
import type { Session, SyncEngine } from '../sync/syncEngine'
import { WorkerRevivalService, workersToRevive } from './workerRevival'

function session(id: string, overrides: { active?: boolean; swarm?: boolean; lifecycleState?: string; machineId?: string } = {}): Session {
    return {
        id,
        namespace: 'default',
        active: overrides.active ?? false,
        metadata: {
            path: '/repo',
            host: 'h',
            machineId: overrides.machineId ?? 'm1',
            lifecycleState: overrides.lifecycleState ?? 'running',
            swarm: overrides.swarm === false ? undefined : { job: 'Job', promotedAt: 1, name: id }
        }
    } as unknown as Session
}

const dead = () => false

describe('workersToRevive', () => {
    it('picks workers that were cut off, and nothing else', () => {
        const picked = workersToRevive([
            session('down'),
            session('running', { active: true }),
            session('archived', { lifecycleState: 'archived' }),
            session('plain', { swarm: false })
        ], dead)
        expect(picked.map((item) => item.id)).toEqual(['down'])
    })

    it('leaves a worker alone when its process is still there, as after a hub-only restart', () => {
        expect(workersToRevive([session('reconnecting')], () => true)).toEqual([])
    })
})

describe('WorkerRevivalService', () => {
    function setup(machineOnline: boolean) {
        const sessions = [session('a'), session('b')]
        const resumed: string[] = []
        const engine = {
            getSessions: () => sessions,
            getMachine: () => ({ active: machineOnline }),
            resumeSession: async (id: string) => {
                resumed.push(id)
                sessions.find((item) => item.id === id)!.active = true
                return { type: 'success', sessionId: id }
            }
        } as unknown as SyncEngine
        // Timers are effectively disabled; the test drives each step itself.
        const service = new WorkerRevivalService(() => engine, { isAlive: dead, staggerMs: 3_600_000, retryMs: 3_600_000, log: () => {} })
        return { service, resumed }
    }

    it('resumes one worker per step, so a fresh boot is not hit with every agent at once', async () => {
        const { service, resumed } = setup(true)
        await service.reviveNext()
        expect(resumed).toEqual(['a'])
        await service.reviveNext()
        expect(resumed).toEqual(['a', 'b'])
        await service.reviveNext()
        expect(resumed).toEqual(['a', 'b'])
        service.stop()
    })

    it('waits while the runner is still offline', async () => {
        const { service, resumed } = setup(false)
        await service.reviveNext()
        expect(resumed).toEqual([])
        service.stop()
    })
})
