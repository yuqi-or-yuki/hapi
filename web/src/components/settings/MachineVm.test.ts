import { describe, expect, it } from 'vitest'
import { estimateVmMonthlyUsd, suggestVmName } from './MachineVm'

describe('VM helpers', () => {
    it('estimates an always-on E2 VM with its disk, and declines families it has no prices for', () => {
        expect(estimateVmMonthlyUsd({ machineType: 'e2-standard-4', vcpus: 4, memoryGb: 16, diskGb: 100 })).toBe(108)
        expect(estimateVmMonthlyUsd({ machineType: 'n2-standard-4', vcpus: 4, memoryGb: 16, diskGb: 100 })).toBeNull()
    })

    it('suggests the next free numbered name', () => {
        expect(suggestVmName(['hapi-agent-1', 'hapi-agent-2'])).toBe('hapi-agent-3')
        expect(suggestVmName([])).toBe('hapi-agent-1')
    })
})
