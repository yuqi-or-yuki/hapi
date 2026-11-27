import { describe, expect, it } from 'vitest'
import { buildPipelines, linksInto, trainOrder } from './pipeline'

const id = (worker: string) => worker
const link = (from: string, to: string, pending = 0) => ({ from, to, pending, handled: 0 })

describe('buildPipelines', () => {
    it('lays linked workers out in the order work flows and leaves the rest alone', () => {
        const { pipelines, alone } = buildPipelines(['outreach', 'cleaner', 'intake', 'followup'], [link('intake', 'outreach', 4), link('outreach', 'followup')], id)
        expect(alone).toEqual(['cleaner'])
        expect(pipelines).toHaveLength(1)
        expect(pipelines[0].stages).toEqual([['intake'], ['outreach'], ['followup']])
        expect(linksInto(pipelines[0], 1, id)).toEqual([link('intake', 'outreach', 4)])
    })

    it('lines a pipeline up as a train: each worker follows the one before it', () => {
        const follows = trainOrder(['outreach', 'cleaner', 'intake', 'followup'], [link('intake', 'outreach'), link('outreach', 'followup')], id)
        expect([...follows]).toEqual([['outreach', 'intake'], ['followup', 'outreach']])
    })

    it('puts two workers fed by the same one in the same stage, and ignores links to retired workers', () => {
        const { pipelines, alone } = buildPipelines(['intake', 'email', 'linkedin', 'solo'], [link('intake', 'email'), link('intake', 'linkedin'), link('solo', 'gone')], id)
        expect(pipelines[0].stages).toEqual([['intake'], ['email', 'linkedin']])
        expect(alone).toEqual(['solo'])
    })
})
