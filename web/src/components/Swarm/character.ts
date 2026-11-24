import { hashSeed } from './worker'

/** The character sheet: 16 px tiles with a 1 px gap, 54 columns by 12 rows. */
export const CHARACTER_SHEET = { cols: 54, tile: 16, pitch: 17, width: 918, height: 203 }

type Cell = readonly [col: number, row: number]

// Parts on the sheet, as [col, row]. One of each kind a class uses is picked per worker from its seed.
const BODIES: readonly Cell[] = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]]
const PANTS: readonly Cell[] = [[3, 0], [3, 1], [3, 5], [3, 6], [3, 7]]
const TUNICS: readonly Cell[] = [[6, 5], [10, 5], [14, 5], [8, 1], [12, 1], [16, 1], [8, 6], [10, 0]]
const HAIR: readonly Cell[] = [[19, 0], [21, 0], [22, 1], [23, 0], [25, 0], [26, 1], [19, 4], [21, 4], [22, 5], [23, 4], [25, 4], [26, 5], [19, 8], [21, 8]]
const ROBES: readonly Cell[] = [[14, 0], [16, 0], [14, 2], [6, 0], [6, 2]]
const WIZARD_HATS: readonly Cell[] = [[28, 8], [29, 8], [30, 8], [31, 8]]
const ARMOUR: readonly Cell[] = [[10, 4], [12, 4], [13, 4]]
const HELMETS: readonly Cell[] = [[28, 0], [29, 0], [30, 0], [31, 0], [28, 1], [29, 1], [30, 1], [31, 1]]

/**
 * Which kind of character an agent is. The agent behind a worker is the most
 * useful thing to tell apart at a glance, so each gets its own silhouette:
 * Claude workers are wizards in pointed hats, Codex workers are knights in
 * helmets, and every other agent is a townsperson.
 */
export type CharacterClass = 'wizard' | 'knight' | 'townsperson'

export function characterClass(flavor: string | null | undefined): CharacterClass {
    const agent = (flavor ?? '').trim().toLowerCase()
    if (agent === 'claude') return 'wizard'
    if (agent === 'codex') return 'knight'
    return 'townsperson'
}

/**
 * The parts that make up a worker's character, bottom layer first. This is the
 * one place a seed and an agent become a look, so the figure walking around
 * the office and the avatar on a card are always the same person.
 */
export function characterParts(seed: string, flavor?: string | null): Cell[] {
    const hash = hashSeed(seed)
    const pick = (options: readonly Cell[], shift: number) => options[(hash >>> shift) % options.length]
    const base = [pick(BODIES, 0), pick(PANTS, 5)]
    switch (characterClass(flavor)) {
        case 'wizard':
            return [...base, pick(ROBES, 9), pick(HAIR, 15), pick(WIZARD_HATS, 20)]
        case 'knight':
            // A full helmet covers the head, so a knight has no hair layer.
            return [...base, pick(ARMOUR, 9), pick(HELMETS, 20)]
        default:
            return [...base, pick(TUNICS, 9), pick(HAIR, 15)]
    }
}
