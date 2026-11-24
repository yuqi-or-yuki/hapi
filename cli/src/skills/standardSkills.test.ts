import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installStandardSkills, MANAGED_MARKER } from './standardSkills'

const source = '---\ndescription: Does a thing: "quoted"\n---\n\n# Thing\n\nSteps.\n'

describe('installStandardSkills', () => {
    it('installs a Claude command and a Codex skill, and replaces its own copies on update', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-skills-'))
        expect(installStandardSkills([{ name: 'thing', source }], {}, home)).toHaveLength(2)

        const claude = readFileSync(join(home, '.claude/commands/thing.md'), 'utf8')
        expect(claude.startsWith(source.trimEnd())).toBe(true)
        expect(claude).toContain(MANAGED_MARKER)
        const codex = readFileSync(join(home, '.codex/skills/thing/SKILL.md'), 'utf8')
        expect(codex).toContain('name: thing\ndescription: "Does a thing: \\"quoted\\""')
        expect(codex).toContain('# Thing')

        expect(installStandardSkills([{ name: 'thing', source }], {}, home)).toEqual([])
        expect(installStandardSkills([{ name: 'thing', source: source.replace('Steps.', 'New steps.') }], {}, home)).toHaveLength(2)
        expect(readFileSync(join(home, '.claude/commands/thing.md'), 'utf8')).toContain('New steps.')
    })

    it('never touches a file the user wrote themselves', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-skills-'))
        mkdirSync(join(home, '.claude/commands'), { recursive: true })
        writeFileSync(join(home, '.claude/commands/thing.md'), 'mine')

        expect(installStandardSkills([{ name: 'thing', source }], {}, home)).toEqual([join(home, '.codex/skills/thing/SKILL.md')])
        expect(readFileSync(join(home, '.claude/commands/thing.md'), 'utf8')).toBe('mine')
    })
})
