export type AgentDoneRing = 'microwave' | 'chime' | 'alarm' | 'coin' | 'soft'

export const AGENT_DONE_RING_OPTIONS: Array<{ value: AgentDoneRing; label: string }> = [
    { value: 'microwave', label: 'Microwave ding' },
    { value: 'chime', label: 'Bright chime' },
    { value: 'alarm', label: 'Urgent alarm' },
    { value: 'coin', label: 'Coin sparkle' },
    { value: 'soft', label: 'Soft bell' },
]

const RING_PATTERNS: Record<AgentDoneRing, Array<{ frequency: number; start: number; duration: number; volume?: number; type?: OscillatorType }>> = {
    microwave: [
        { frequency: 988, start: 0, duration: 0.22, volume: 0.9 },
        { frequency: 1319, start: 0.28, duration: 0.22, volume: 0.9 },
        { frequency: 988, start: 0.56, duration: 0.42, volume: 0.95 },
    ],
    chime: [
        { frequency: 784, start: 0, duration: 0.22, volume: 0.65 },
        { frequency: 1047, start: 0.14, duration: 0.34, volume: 0.72 },
        { frequency: 1568, start: 0.32, duration: 0.45, volume: 0.55 },
    ],
    alarm: [
        { frequency: 880, start: 0, duration: 0.16, volume: 0.95, type: 'square' },
        { frequency: 0, start: 0.17, duration: 0.04 },
        { frequency: 880, start: 0.22, duration: 0.16, volume: 0.95, type: 'square' },
        { frequency: 0, start: 0.39, duration: 0.04 },
        { frequency: 880, start: 0.44, duration: 0.26, volume: 1, type: 'square' },
    ],
    coin: [
        { frequency: 1319, start: 0, duration: 0.12, volume: 0.75 },
        { frequency: 1760, start: 0.09, duration: 0.16, volume: 0.75 },
        { frequency: 2349, start: 0.2, duration: 0.24, volume: 0.55 },
    ],
    soft: [
        { frequency: 523, start: 0, duration: 0.35, volume: 0.4 },
        { frequency: 659, start: 0.18, duration: 0.5, volume: 0.36 },
        { frequency: 784, start: 0.42, duration: 0.6, volume: 0.32 },
    ],
}

type WindowWithWebkitAudio = Window & typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
}

export function normalizeAgentDoneRing(value: unknown): AgentDoneRing {
    return AGENT_DONE_RING_OPTIONS.some(option => option.value === value)
        ? value as AgentDoneRing
        : 'microwave'
}

export function playAgentDoneRing(ring: AgentDoneRing): void {
    const AudioContextCtor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
    if (!AudioContextCtor) return

    const ctx = new AudioContextCtor()
    const master = ctx.createGain()
    const pattern = RING_PATTERNS[ring]
    const maxEnd = Math.max(...pattern.map(tone => tone.start + tone.duration), 0.8)

    master.gain.setValueAtTime(0.0001, ctx.currentTime)
    master.gain.exponentialRampToValueAtTime(ring === 'soft' ? 0.75 : 0.95, ctx.currentTime + 0.02)
    master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + maxEnd + 0.45)
    master.connect(ctx.destination)

    for (const tone of pattern) {
        if (tone.frequency <= 0) continue
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = tone.type ?? 'sine'
        osc.frequency.setValueAtTime(tone.frequency, ctx.currentTime + tone.start)
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + tone.start)
        gain.gain.exponentialRampToValueAtTime(tone.volume ?? 0.8, ctx.currentTime + tone.start + 0.015)
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + tone.start + tone.duration)
        osc.connect(gain)
        gain.connect(master)
        osc.start(ctx.currentTime + tone.start)
        osc.stop(ctx.currentTime + tone.start + tone.duration + 0.03)
    }

    window.setTimeout(() => {
        void ctx.close().catch(() => {})
    }, Math.ceil((maxEnd + 0.7) * 1000))
}
