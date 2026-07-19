export type SlashCommandSource = 'builtin' | 'user' | 'plugin' | 'project'

export interface BuiltinSlashCommand {
    name: string
    description?: string
    source: 'builtin'
}

export const BUILTIN_SLASH_COMMANDS = {
    claude: [
        { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
        { name: 'compact', description: 'Compact conversation context', source: 'builtin' },
        { name: 'context', description: 'Show context information', source: 'builtin' },
        { name: 'cost', description: 'Show the total cost and duration of the current session', source: 'builtin' },
        { name: 'doctor', description: 'Diagnose and verify your Claude Code installation and settings', source: 'builtin' },
        { name: 'plan', description: 'Toggle plan mode', source: 'builtin' },
        { name: 'stats', description: 'Show your Claude Code usage statistics and activity', source: 'builtin' },
        { name: 'status', description: 'Show Claude Code status including version, model, account, and API connectivity', source: 'builtin' },
        { name: 'usage', description: 'Show your Claude Code account usage and subscription status', source: 'builtin' },
    ],
    codex: [
        { name: 'clear', description: 'Clear current Codex thread context', source: 'builtin' },
        { name: 'compact', description: 'Compact current Codex thread context', source: 'builtin' },
        { name: 'goal', description: 'Set, view, pause, resume, or clear a persistent Codex goal', source: 'builtin' },
        { name: 'help', description: 'Show supported HAPI Codex slash commands', source: 'builtin' },
        { name: 'plan', description: 'Enable plan mode; use /plan off to return to default', source: 'builtin' },
        { name: 'default', description: 'Return Codex collaboration mode to default', source: 'builtin' },
        { name: 'execute', description: 'Return Codex collaboration mode to default', source: 'builtin' },
        { name: 'status', description: 'Show current Codex session config', source: 'builtin' },
        { name: 'model', description: 'Show or set Codex model, e.g. /model gpt-5.5', source: 'builtin' },
        { name: 'reasoning', description: 'Show or set reasoning effort', source: 'builtin' },
        { name: 'effort', description: 'Alias for /reasoning', source: 'builtin' },
        { name: 'permissions', description: 'Show or set permission mode', source: 'builtin' },
        { name: 'permission', description: 'Alias for /permissions', source: 'builtin' },
    ],
    gemini: [
        { name: 'about', description: 'About Gemini', source: 'builtin' },
        { name: 'clear', description: 'Clear conversation', source: 'builtin' },
        { name: 'compress', description: 'Compress context', source: 'builtin' },
    ],
    opencode: [],
} as const satisfies Record<string, readonly BuiltinSlashCommand[]>

export const UNSUPPORTED_CODEX_BUILTIN_SLASH_COMMANDS = [
    'compat',
    'diff',
    'init',
    'login',
    'logout',
    'mcp',
    'new',
    'prompts',
    'quit',
    'redo',
    'review',
    'undo',
] as const

export function getBuiltinSlashCommands(agent: string): BuiltinSlashCommand[] {
    const commands = BUILTIN_SLASH_COMMANDS[agent as keyof typeof BUILTIN_SLASH_COMMANDS] ?? []
    return commands.map(command => ({ ...command }))
}

export function isUnsupportedCodexBuiltinSlashCommand(command: string): boolean {
    return (UNSUPPORTED_CODEX_BUILTIN_SLASH_COMMANDS as readonly string[]).includes(command)
}
