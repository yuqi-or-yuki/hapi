import { describe, expect, it } from 'vitest'
import { CHARACTER_SHEET, characterClass, characterParts } from './character'

describe('characters', () => {
    it('gives Claude, Codex and other agents different kinds of character', () => {
        expect(characterClass('claude')).toBe('wizard')
        expect(characterClass(' Codex ')).toBe('knight')
        expect(characterClass('gemini')).toBe('townsperson')
        expect(characterClass(undefined)).toBe('townsperson')
    })

    it('dresses each class in its own headgear: hats in row 8, helmets in rows 0-1', () => {
        const hat = characterParts('worker-1', 'claude').at(-1)!
        const helmet = characterParts('worker-1', 'codex').at(-1)!
        expect(hat[1]).toBe(8)
        expect(helmet[1]).toBeLessThanOrEqual(1)
        expect(helmet[0]).toBeGreaterThanOrEqual(28)
        expect(characterParts('worker-1', 'gemini')).toHaveLength(4)
    })

    it('is the same person every time, and stays on the sheet', () => {
        expect(characterParts('worker-1', 'claude')).toEqual(characterParts('worker-1', 'claude'))
        for (const flavor of ['claude', 'codex', 'cursor']) {
            for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
                for (const [col, row] of characterParts(seed, flavor)) {
                    expect(col).toBeLessThan(CHARACTER_SHEET.cols)
                    expect(row).toBeLessThan(12)
                }
            }
        }
    })
})
