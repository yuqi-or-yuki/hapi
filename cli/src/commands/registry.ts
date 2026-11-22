import chalk from 'chalk'
import { agyCommand } from './agy'
import { authCommand } from './auth'
import { claudeCommand } from './claude'
import { codexCommand } from './codex'
import { dshCommand } from './dsh'
import { cursorCommand } from './cursor'
import { connectCommand } from './connect'
import { runnerCommand } from './runner'
import { resumeCommand } from './resume'
import { doctorCommand } from './doctor'
import { kimiCommand } from './kimi'
import { copilotCommand } from './copilot'
import { grokCommand } from './grok'
import { opencodeCommand } from './opencode'
import { piCommand } from './pi'
import { zeroshotCommand } from './zeroshot'
import { hookForwarderCommand } from './hookForwarder'
import { mcpCommand } from './mcp'
import { notifyCommand } from './notify'
import { scheduleCommand } from './schedule'
import { workerCommand } from './worker'
import { hubCommand } from './hub'
import type { CommandContext, CommandDefinition } from './types'

// Gemini CLI was sunset (Google stopped serving the consumer Gemini CLI on
// 2026-06-18) so the agent is no longer launchable. Keep an explicit tombstone
// command so `hapi gemini` reports a clear error instead of falling through to
// the default Claude command with "gemini" as a forwarded argument.
const removedGeminiCommand: CommandDefinition = {
    name: 'gemini',
    requiresRuntimeAssets: false,
    run: async () => {
        console.error(
            chalk.red('Error:'),
            'Gemini CLI is no longer supported and cannot be launched (Google sunset the consumer Gemini CLI on 2026-06-18). Existing Gemini sessions remain viewable in the web UI.'
        )
        process.exit(1)
    }
}

const COMMANDS: CommandDefinition[] = [
    agyCommand,
    authCommand,
    connectCommand,
    codexCommand,
    dshCommand,
    cursorCommand,
    removedGeminiCommand,
    grokCommand,
    kimiCommand,
    copilotCommand,
    opencodeCommand,
    piCommand,
    zeroshotCommand,
    mcpCommand,
    hubCommand,
    { ...hubCommand, name: 'server' },
    hookForwarderCommand,
    doctorCommand,
    resumeCommand,
    runnerCommand,
    notifyCommand,
    scheduleCommand,
    workerCommand
]

const commandMap = new Map<string, CommandDefinition>()
for (const command of COMMANDS) {
    commandMap.set(command.name, command)
}

/**
 * Words that are not registered commands but must still fall through to the
 * default command with their arguments untouched.
 *
 * `claude` is how the runner launches every Claude session
 * (`hapi claude --hapi-starting-mode remote …`, see runner/run.ts
 * buildCliArgs): the default command is registered under the name `default`,
 * so `claude` only ever worked by falling through. Treating it as an unknown
 * subcommand would stop Claude sessions spawning at all.
 */
const FALLTHROUGH_WORDS = new Set(['claude'])

/**
 * A bare lowercase word with no spaces, e.g. `worker` — the shape of a
 * subcommand, not of a prompt. Anything a person would actually type as a
 * prompt has a space, a capital, or punctuation in it.
 */
function looksLikeSubcommand(arg: string): boolean {
    return !FALLTHROUGH_WORDS.has(arg) && /^[a-z][a-z0-9-]*$/.test(arg)
}

/** Levenshtein distance, capped: we only care about near-misses. */
function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
        const current = [i]
        for (let j = 1; j <= b.length; j++) {
            current[j] = a[i - 1] === b[j - 1]
                ? previous[j - 1]
                : Math.min(previous[j - 1], previous[j], current[j - 1]) + 1
        }
        previous = current
    }
    return previous[b.length]
}

export function suggestCommand(subcommand: string, names: readonly string[] = [...commandMap.keys()]): string | null {
    let best: { name: string; distance: number } | null = null
    for (const name of names) {
        const distance = editDistance(subcommand, name)
        if (distance <= Math.max(2, Math.floor(name.length / 3)) && (!best || distance < best.distance)) {
            best = { name, distance }
        }
    }
    return best?.name ?? null
}

/**
 * Reports an unrecognised subcommand instead of silently treating it as a
 * prompt.
 *
 * The fall-through to `claudeCommand` is deliberate for real prompts, but a
 * bare word that is *meant* to be a subcommand used to start a whole agent
 * session that then sat waiting for input forever — which is what happened
 * when a skill called `hapi worker status` against a build that predated the
 * `worker` command: two orphan sessions, no error, no output.
 */
const unknownCommand: CommandDefinition = {
    name: 'unknown',
    requiresRuntimeAssets: false,
    run: async (context) => {
        const subcommand = context.subcommand ?? ''
        const suggestion = suggestCommand(subcommand)
        console.error(chalk.red('Error:'), `Unknown command "${subcommand}".`)
        if (suggestion) {
            console.error(`Did you mean ${chalk.cyan(`hapi ${suggestion}`)}?`)
        }
        console.error(`Run ${chalk.cyan('hapi --help')} for the command list,`)
        console.error(`or quote it to send as a prompt: ${chalk.cyan(`hapi "${context.args.join(' ')}"`)}`)
        process.exit(1)
    }
}

export function resolveCommand(args: string[]): { command: CommandDefinition; context: CommandContext } {
    const subcommand = args[0]
    const command = subcommand ? commandMap.get(subcommand) : undefined
    // No args, a flag, or anything prompt-shaped still starts a session.
    const resolvedCommand = command
        ?? (subcommand && looksLikeSubcommand(subcommand) ? unknownCommand : claudeCommand)
    const commandArgs = command ? args.slice(1) : args

    return {
        command: resolvedCommand,
        context: {
            args,
            subcommand,
            commandArgs
        }
    }
}
