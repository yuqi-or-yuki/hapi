import { describe, expect, it } from 'vitest'
import { buildZeroshotTimeline } from './ZeroshotTimeline'
import type { ChatBlock, ChatToolCall } from '@/chat/types'

function toolBlock(id: string, name: string, input: unknown, createdAt = 0): ChatBlock {
    const tool: ChatToolCall = {
        id, name, state: 'completed', input, createdAt,
        startedAt: null, completedAt: null, execStartedAt: null, execCompletedAt: null,
        description: null
    }
    return { kind: 'tool-call', id, localId: null, createdAt, tool, children: [] }
}

function agentEvent(id: string, role: string, event: string, extra: Record<string, unknown> = {}): ChatBlock {
    return toolBlock(id, 'ZeroshotAgent', { role, event, ...extra })
}

describe('buildZeroshotTimeline', () => {
    it('buckets events by role into plan/implement/verify', () => {
        const blocks: ChatBlock[] = [
            agentEvent('1', 'conductor', 'TASK_STARTED', { agent: 'junior-conductor', model: 'sonnet' }),
            agentEvent('2', 'conductor', 'TASK_COMPLETED', { agent: 'junior-conductor' }),
            agentEvent('3', 'implementation', 'TASK_STARTED', { agent: 'worker', model: 'sonnet', iteration: 1 }),
            agentEvent('4', 'validator', 'TASK_STARTED', { agent: 'validator', model: 'sonnet' }),
            toolBlock('5', 'ZeroshotVerdict', { approved: true, errors: [] })
        ]
        const t = buildZeroshotTimeline(blocks)
        expect(t.stages.plan.events).toHaveLength(2)
        expect(t.stages.implement.events).toHaveLength(1)
        expect(t.stages.verify.events).toHaveLength(1)
        expect(t.stages.verify.verdicts).toHaveLength(1)
        expect(t.stages.verify.verdicts[0].approved).toBe(true)
        expect(t.totalEvents).toBe(5)
    })

    it('maps orchestrator (completion-detector) into verify', () => {
        const t = buildZeroshotTimeline([agentEvent('1', 'orchestrator', 'STARTED', { agent: 'completion-detector' })])
        expect(t.stages.verify.events).toHaveLength(1)
    })

    it('treats an unknown/implementation role as implement and counts verdict errors', () => {
        const t = buildZeroshotTimeline([
            agentEvent('1', 'implementation', 'TASK_STARTED'),
            toolBlock('2', 'ZeroshotVerdict', { approved: false, errors: ['a', 'b'] })
        ])
        expect(t.stages.implement.events).toHaveLength(1)
        expect(t.stages.verify.verdicts[0].approved).toBe(false)
        expect(t.stages.verify.verdicts[0].errorCount).toBe(2)
    })

    it('ignores non-zeroshot blocks entirely', () => {
        const t = buildZeroshotTimeline([
            toolBlock('1', 'Bash', { command: 'ls' }),
            { kind: 'agent-text', id: '2', localId: null, createdAt: 0, text: 'hello' }
        ])
        expect(t.totalEvents).toBe(0)
    })
})
