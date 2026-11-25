import { describe, expect, it } from 'vitest'
import { shouldDefaultToYolo } from './yoloDefault'

describe('shouldDefaultToYolo', () => {
    it('applies to a terminal start with no permission flag, once the machine opts in', () => {
        expect(shouldDefaultToYolo({ hasPermissionMode: false, startedBy: undefined, setting: true })).toBe(true)
        expect(shouldDefaultToYolo({ hasPermissionMode: false, startedBy: 'terminal', setting: true })).toBe(true)
    })

    it('stays off without the setting, and never overrides an explicit mode or an app-started session', () => {
        expect(shouldDefaultToYolo({ hasPermissionMode: false, startedBy: 'terminal', setting: undefined })).toBe(false)
        expect(shouldDefaultToYolo({ hasPermissionMode: false, startedBy: 'terminal', setting: 'true' })).toBe(false)
        expect(shouldDefaultToYolo({ hasPermissionMode: true, startedBy: 'terminal', setting: true })).toBe(false)
        expect(shouldDefaultToYolo({ hasPermissionMode: false, startedBy: 'runner', setting: true })).toBe(false)
    })
})
