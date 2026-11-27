import { describe, expect, it } from 'bun:test'
import { workerPrompt } from './sessions'

describe('workerPrompt', () => {
    it('carries the current playbook so a changed approach reaches the next run', () => {
        const prompt = workerPrompt({ job: 'Source talent', playbook: 'Only ICLR authors with 500+ citations' })
        expect(prompt).toContain('Source talent')
        expect(prompt).toContain('Only ICLR authors with 500+ citations')
    })

    it('tells a worker on an item-approval board to prefill its suggestions', () => {
        const prompt = workerPrompt({ job: 'Review leads', board: { columns: ['name', 'suggestedDecision', 'suggestedReason'] } })
        expect(prompt).toContain('Item approval is enabled')
        expect(prompt).toContain('not user decisions or authorization to act')
    })

    it('names the one card a scheduled run may re-score, and the one it must not touch', () => {
        const prompt = workerPrompt({ job: 'Review leads', board: { columns: ['name', 'suggestedDecision', 'suggestedReason'] } })
        expect(prompt).toContain('reviewAfterNext')
        expect(prompt).toContain('Never re-score the card marked `reviewNext`')
    })
})
