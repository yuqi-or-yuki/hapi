import { describe, expect, it } from 'vitest'
import { mergeSkillsByName } from './useMachineSkills'

describe('mergeSkillsByName', () => {
    it('lists a skill once with every agent that can run it', () => {
        const merged = mergeSkillsByName([
            { flavor: 'claude', skills: [{ name: 'pp', description: 'Open a PR' }, { name: 'obsidian' }] },
            { flavor: 'codex', skills: [{ name: 'pp', description: 'Open a PR' }, { name: 'tenera' }] }
        ])

        expect(merged.map(s => ({ name: s.name, flavors: s.flavors }))).toEqual([
            { name: 'obsidian', flavors: ['claude'] },
            { name: 'pp', flavors: ['claude', 'codex'] },
            { name: 'tenera', flavors: ['codex'] }
        ])
    })

    it('keeps the first description and fills one in from a later agent', () => {
        const merged = mergeSkillsByName([
            { flavor: 'claude', skills: [{ name: 'pp' }] },
            { flavor: 'codex', skills: [{ name: 'pp', description: 'Open a PR' }] }
        ])

        expect(merged[0].description).toBe('Open a PR')
    })

    it('does not repeat an agent that reports the same skill twice', () => {
        const merged = mergeSkillsByName([
            { flavor: 'claude', skills: [{ name: 'pp' }, { name: 'pp' }] }
        ])

        expect(merged).toHaveLength(1)
        expect(merged[0].flavors).toEqual(['claude'])
    })
})
