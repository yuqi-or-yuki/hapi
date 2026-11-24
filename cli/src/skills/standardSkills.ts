import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Skills that come with HAPI. On runner start each one is written where the
 * agents look for it: a Claude Code command and a Codex skill. Sources live
 * in cli/skills/<name>.md, written as a Claude command file (a `description`
 * frontmatter block, then the instructions).
 *
 * A file we did not write is the user's own and is never touched; ours carry
 * a marker line and are replaced whenever HAPI ships a newer version.
 */

export const MANAGED_MARKER = '<!-- Installed by HAPI and replaced when HAPI updates. To customise, copy it under another name. -->'

export type StandardSkill = { name: string; source: string }

function splitFrontmatter(source: string): { description: string; body: string } {
    const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    const description = match?.[1].match(/^description:\s*(.*)$/m)?.[1].trim() ?? ''
    return { description, body: (match?.[2] ?? source).trim() }
}

function writeManaged(path: string, content: string): boolean {
    const next = `${content.trimEnd()}\n\n${MANAGED_MARKER}\n`
    if (existsSync(path)) {
        const current = readFileSync(path, 'utf8')
        if (!current.includes(MANAGED_MARKER) || current === next) return false
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, next)
    return true
}

/** Returns the paths written. */
export function installStandardSkills(
    skills: StandardSkill[],
    env: Record<string, string | undefined> = process.env,
    home: string = homedir(),
): string[] {
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
    const codexDir = env.CODEX_HOME || join(home, '.codex')
    const written: string[] = []
    for (const skill of skills) {
        const { description, body } = splitFrontmatter(skill.source)
        const claudePath = join(claudeDir, 'commands', `${skill.name}.md`)
        const codexPath = join(codexDir, 'skills', skill.name, 'SKILL.md')
        const codexSource = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`
        if (writeManaged(claudePath, skill.source)) written.push(claudePath)
        if (writeManaged(codexPath, codexSource)) written.push(codexPath)
    }
    return written
}
