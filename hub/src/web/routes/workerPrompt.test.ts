import { describe, expect, it } from 'bun:test'
import { workerPrompt } from './sessions'

describe('workerPrompt', () => {
    it('carries the current playbook so a changed approach reaches the next run', () => {
        const prompt = workerPrompt({ job: 'Source talent', playbook: 'Only ICLR authors with 500+ citations' })
        expect(prompt).toContain('Source talent')
        expect(prompt).toContain('Only ICLR authors with 500+ citations')
        expect(prompt).not.toContain('REVIEW PERIOD')
    })

    it('tells a worker in review to draft outside actions instead of taking them', () => {
        const prompt = workerPrompt({ job: 'Email candidates', review: { runsLeft: 2 } })
        expect(prompt).toContain('REVIEW PERIOD (2 more approved runs')
        expect(prompt).toContain('Prepare those as drafts')
    })
    it('describes item approval separately from the run-level review period', () => {
        const prompt = workerPrompt({ job: 'Review leads', board: { columns: ['name', 'suggestedDecision', 'suggestedReason'] } })
        expect(prompt).toContain('Item approval is enabled')
        expect(prompt).toContain('not user decisions or authorization to act')
        expect(prompt).not.toContain('REVIEW PERIOD')
    })
})
