const SLASH_COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** User-typed slash command, e.g. { role: 'user', content: { type: 'text', text: '/pp fix the bug' } }. */
function extractTypedSlashCommand(content: unknown): string | null {
    if (!isRecord(content) || content.role !== 'user') return null
    const body = content.content
    if (!isRecord(body) || body.type !== 'text' || typeof body.text !== 'string') return null
    const match = body.text.trim().match(SLASH_COMMAND_PATTERN)
    return match ? match[1]! : null
}

/** Agent-triggered Skill tool call, e.g. { type: 'tool_use', name: 'Skill', input: { skill: 'foo' } },
 *  nested arbitrarily deep inside provider-specific message envelopes. */
function collectSkillToolUses(node: unknown, found: Set<string>, depth = 0): void {
    if (depth > 12 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
        for (const item of node) collectSkillToolUses(item, found, depth + 1)
        return
    }
    const record = node as Record<string, unknown>
    if (record.type === 'tool_use' && record.name === 'Skill' && isRecord(record.input) && typeof record.input.skill === 'string') {
        const skill = record.input.skill.trim()
        if (skill) found.add(skill)
    }
    for (const value of Object.values(record)) {
        collectSkillToolUses(value, found, depth + 1)
    }
}

/** Extract skill/slash-command names invoked by this message, both user-typed and agent-triggered.
 *  `json` is the already-serialized content (callers have it on hand for the DB write) — used as a
 *  cheap pre-check so the recursive walk only runs on messages that could plausibly contain a Skill
 *  tool call, instead of on every message write. */
export function extractSkillInvocations(content: unknown, json: string): string[] {
    const found = new Set<string>()

    const typed = extractTypedSlashCommand(content)
    if (typed) found.add(typed)

    if (json.includes('"name":"Skill"')) {
        collectSkillToolUses(content, found)
    }

    return [...found]
}
