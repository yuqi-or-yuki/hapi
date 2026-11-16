import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeGain() {
    return {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
    }
}

class FakeAudioContext {
    static instances: FakeAudioContext[] = []
    state: AudioContextState = 'suspended'
    currentTime = 0
    destination = {}
    nodes: Array<ReturnType<typeof makeGain>> = []
    resume = vi.fn(async () => { this.state = 'running' })
    suspend = vi.fn(async () => { this.state = 'suspended' })
    close = vi.fn(async () => { this.state = 'closed' })

    constructor() { FakeAudioContext.instances.push(this) }

    createGain() {
        const node = makeGain()
        this.nodes.push(node)
        return node
    }

    createOscillator() {
        return {
            ...this.createGain(),
            frequency: { setValueAtTime: vi.fn() },
            start: vi.fn(),
            stop: vi.fn(),
            type: 'sine',
        }
    }
}

describe('agent done audio resources', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.useFakeTimers()
        FakeAudioContext.instances = []
        vi.stubGlobal('AudioContext', FakeAudioContext)
    })

    afterEach(() => {
        window.dispatchEvent(new Event('pagehide'))
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('bounds contexts and connected nodes when background timers do not run', async () => {
        const { playAgentDoneRing } = await import('./agentDoneSound')
        playAgentDoneRing('coin')
        const ctx = FakeAudioContext.instances[0]
        const firstNodes = [...ctx.nodes]
        for (let i = 0; i < 100; i++) playAgentDoneRing('chime')
        expect(FakeAudioContext.instances).toHaveLength(1)
        expect(firstNodes.every(node => node.disconnect.mock.calls.length === 1)).toBe(true)
        expect(vi.getTimerCount()).toBe(1)
        await vi.runAllTimersAsync()
        expect(ctx.nodes.every(node => node.disconnect.mock.calls.length === 1)).toBe(true)
        expect(ctx.suspend).toHaveBeenCalledOnce()
    })

    it('resumes the same context after idle and closes it on navigation', async () => {
        const { playAgentDoneRing } = await import('./agentDoneSound')
        playAgentDoneRing('soft')
        const ctx = FakeAudioContext.instances[0]
        await vi.runAllTimersAsync()
        expect(ctx.state).toBe('suspended')
        playAgentDoneRing('alarm')
        expect(ctx.state).toBe('running')
        expect(FakeAudioContext.instances).toHaveLength(1)
        window.dispatchEvent(new Event('pagehide'))
        expect(ctx.close).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
        // A page restored from the back-forward cache can play again.
        playAgentDoneRing('microwave')
        expect(FakeAudioContext.instances).toHaveLength(2)
    })

    it('handles browsers without Web Audio', async () => {
        vi.stubGlobal('AudioContext', undefined)
        const { playAgentDoneRing } = await import('./agentDoneSound')
        expect(() => playAgentDoneRing('coin')).not.toThrow()
        expect(vi.getTimerCount()).toBe(0)
    })
})
