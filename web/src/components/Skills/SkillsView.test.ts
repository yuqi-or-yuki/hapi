import { describe, expect, it } from 'vitest'
import type { UnifiedSkill } from '@/hooks/queries/useMachineSkills'
import { SKILL_FLAVORS } from '@/hooks/queries/useMachineSkills'
import { filterSkills, isSharedSkill, skillInvocation, sortSkills } from './SkillsView'

const skills: UnifiedSkill[] = [
    { name: 'pp', description: 'Open a PR back to staging', flavors: ['claude', 'codex', 'grok', 'copilot'] },
    { name: 'tenera', description: 'Run Tenera user research', flavors: ['codex'] },
    { name: 'obsidian', flavors: ['claude'] }
]

describe('filterSkills', () => {
    it('matches on name and on description', () => {
        expect(filterSkills(skills, 'tenera').map(s => s.name)).toEqual(['tenera'])
        expect(filterSkills(skills, 'staging').map(s => s.name)).toEqual(['pp'])
    })

    it('ignores case and surrounding space, and returns everything for an empty query', () => {
        expect(filterSkills(skills, '  STAGING ').map(s => s.name)).toEqual(['pp'])
        expect(filterSkills(skills, '   ')).toHaveLength(skills.length)
    })

    it('survives a skill with no description', () => {
        expect(filterSkills(skills, 'obsidian').map(s => s.name)).toEqual(['obsidian'])
    })
})

describe('isSharedSkill', () => {
    it('is shared only when every known agent reports it', () => {
        expect(isSharedSkill(skills[0], SKILL_FLAVORS)).toBe(true)
        expect(isSharedSkill(skills[1], SKILL_FLAVORS)).toBe(false)
    })

    it('does not call a skill shared when only one agent could be read', () => {
        // A single agent answering is not evidence that a skill is shared —
        // the others were never asked.
        expect(isSharedSkill(skills[2], ['claude'])).toBe(false)
    })

    it('ignores agents that failed, so a silent agent does not hide sharing', () => {
        expect(isSharedSkill(skills[1], ['codex', 'claude'])).toBe(false)
        expect(isSharedSkill({ name: 'x', flavors: ['codex', 'claude'] }, ['codex', 'claude'])).toBe(true)
    })
})

describe('skillInvocation', () => {
    it('is what you type to run the skill', () => {
        expect(skillInvocation('pp')).toBe('/pp')
    })
})

describe('sortSkills', () => {
    const usage = { pp: { calls: 187, lastUsedAt: 3 }, obsidian: { calls: 2, lastUsedAt: 1 } }

    it('leads with the skills actually used, so the never-run tail sinks', () => {
        expect(sortSkills(skills, usage, 'used').map(s => s.name)).toEqual(['pp', 'obsidian', 'tenera'])
    })

    it('falls back to name order for ties and for the A-Z sort', () => {
        expect(sortSkills(skills, {}, 'used').map(s => s.name)).toEqual(['obsidian', 'pp', 'tenera'])
        expect(sortSkills(skills, usage, 'name').map(s => s.name)).toEqual(['obsidian', 'pp', 'tenera'])
    })

    it('does not mutate the list it was given', () => {
        const input = [...skills]
        sortSkills(input, usage, 'used')
        expect(input.map(s => s.name)).toEqual(skills.map(s => s.name))
    })
})
