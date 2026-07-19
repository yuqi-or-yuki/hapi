import axios from 'axios'
import chalk from 'chalk'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { initializeToken } from '@/ui/tokenInit'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import type { CommandDefinition } from './types'

type ScheduledMessage = {
    id: string
    sourceSessionId: string
    targetSessionId: string | null
    text: string
    dueAt: number
    cloneBeforeSend: boolean
    intervalMs: number | null
    enabled: boolean
    status: string
    error: string | null
}

function getFlag(args: string[], name: string): string | undefined {
    const eq = args.find(arg => arg.startsWith(`--${name}=`))
    if (eq) return eq.slice(name.length + 3)
    const idx = args.indexOf(`--${name}`)
    if (idx !== -1) return args[idx + 1]
    return undefined
}

function hasFlag(args: string[], name: string): boolean {
    return args.includes(`--${name}`)
}

function parseDueAt(value: string | undefined): number {
    if (!value) throw new Error('Missing --at')
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new Error(`Invalid --at value: ${value}`)
    return parsed
}

function parseIntervalMs(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const trimmed = value.trim().toLowerCase()
    const match = trimmed.match(/^(\d+)(ms|s|m|h|d)?$/)
    if (!match) throw new Error(`Invalid --every value: ${value}`)
    const amount = Number(match[1])
    const unit = match[2] ?? 'm'
    const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    const intervalMs = amount * multiplier
    if (intervalMs < 60_000) throw new Error('--every must be at least 1m')
    return intervalMs
}

async function getWebAuthToken(): Promise<string> {
    const response = await axios.post<{ token: string }>(
        `${configuration.apiUrl}/api/auth`,
        { accessToken: getAuthToken() },
        {
            headers: buildHubRequestHeaders({
                'Content-Type': 'application/json'
            }),
            timeout: 60_000
        }
    )
    return response.data.token
}

function printJobs(jobs: ScheduledMessage[]): void {
    if (jobs.length === 0) {
        console.log(chalk.gray('No scheduled messages.'))
        return
    }
    for (const job of jobs) {
        const repeat = job.intervalMs ? ` ${chalk.magenta(`every ${Math.round(job.intervalMs / 60_000)}m`)}` : ''
        const enabled = job.enabled ? chalk.green('on') : chalk.gray('off')
        console.log(`${chalk.cyan(job.id)} ${chalk.gray(job.status)} ${enabled} ${new Date(job.dueAt).toLocaleString()} ${job.cloneBeforeSend ? chalk.yellow('clone') : chalk.gray('same')}${repeat}`)
        console.log(`  source ${job.sourceSessionId}${job.targetSessionId ? ` -> target ${job.targetSessionId}` : ''}`)
        console.log(`  ${job.text.replace(/\n/g, '\n  ')}`)
        if (job.error) console.log(chalk.red(`  error: ${job.error}`))
    }
}

async function request<T>(method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: unknown): Promise<T> {
    const token = await getWebAuthToken()
    const response = await axios.request<T>({
        method,
        url: `${configuration.apiUrl}${path}`,
        headers: buildHubRequestHeaders({
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        }),
        data: body,
        timeout: 60_000
    })
    return response.data
}

async function handleScheduleCommand(args: string[]): Promise<void> {
    await initializeToken()
    const sub = args[0] ?? 'list'
    if (sub === 'help' || sub === '--help' || sub === '-h') {
        showHelp(); return
    }
    if (sub === 'list') {
        const status = getFlag(args, 'status') ?? 'pending'
        const data = await request<{ scheduledMessages: ScheduledMessage[] }>('get', `/api/scheduled-messages?status=${encodeURIComponent(status)}`)
        printJobs(data.scheduledMessages)
        return
    }
    if (sub === 'create') {
        const sessionId = getFlag(args, 'session')
        const text = getFlag(args, 'text')
        if (!sessionId) throw new Error('Missing --session')
        if (!text) throw new Error('Missing --text')
        const dueAt = parseDueAt(getFlag(args, 'at'))
        const data = await request<{ scheduledMessage: ScheduledMessage }>('post', `/api/sessions/${encodeURIComponent(sessionId)}/scheduled-messages`, {
            text,
            dueAt,
            cloneBeforeSend: hasFlag(args, 'clone'),
            intervalMs: parseIntervalMs(getFlag(args, 'every')) ?? null,
            enabled: !hasFlag(args, 'disabled')
        })
        console.log(chalk.green('Scheduled:'), data.scheduledMessage.id)
        return
    }
    if (sub === 'update') {
        const id = args[1] ?? getFlag(args, 'id')
        if (!id) throw new Error('Missing job id')
        const patch: { sourceSessionId?: string; text?: string; dueAt?: number; cloneBeforeSend?: boolean; intervalMs?: number | null; enabled?: boolean } = {}
        const sessionId = getFlag(args, 'session')
        const text = getFlag(args, 'text')
        const at = getFlag(args, 'at')
        if (sessionId !== undefined) patch.sourceSessionId = sessionId
        if (text !== undefined) patch.text = text
        if (at !== undefined) patch.dueAt = parseDueAt(at)
        if (hasFlag(args, 'clone')) patch.cloneBeforeSend = true
        if (hasFlag(args, 'no-clone')) patch.cloneBeforeSend = false
        if (getFlag(args, 'every') !== undefined) patch.intervalMs = parseIntervalMs(getFlag(args, 'every'))
        if (hasFlag(args, 'no-repeat')) patch.intervalMs = null
        if (hasFlag(args, 'enable')) patch.enabled = true
        if (hasFlag(args, 'disable')) patch.enabled = false
        const data = await request<{ scheduledMessage: ScheduledMessage }>('patch', `/api/scheduled-messages/${encodeURIComponent(id)}`, patch)
        console.log(chalk.green('Updated:'), data.scheduledMessage.id)
        return
    }
    if (sub === 'delete' || sub === 'cancel') {
        const id = args[1] ?? getFlag(args, 'id')
        if (!id) throw new Error('Missing job id')
        await request('delete', `/api/scheduled-messages/${encodeURIComponent(id)}`)
        console.log(chalk.green('Deleted:'), id)
        return
    }
    throw new Error(`Unknown schedule subcommand: ${sub}`)
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi schedule')} - Scheduled HAPI message jobs

${chalk.bold('Usage:')}
  hapi schedule list [--status pending|all|sent|failed|cancelled]
  hapi schedule create --session <id> --at <time> --text <message> [--clone] [--every 5m] [--disabled]
  hapi schedule update <job-id> [--session <id>] [--at <time>] [--text <message>] [--clone|--no-clone] [--every 5m|--no-repeat] [--enable|--disable]
  hapi schedule delete <job-id>

${chalk.bold('Examples:')}
  hapi schedule create --session abc123 --at "2026-07-06 15:00" --text "continue" --clone
  hapi schedule update abc123 --every 5m --text "keep going"
  hapi schedule list --status all
`)
}

export const scheduleCommand: CommandDefinition = {
    name: 'schedule',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleScheduleCommand(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}
