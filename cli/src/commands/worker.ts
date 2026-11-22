import { readFileSync } from 'node:fs'
import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { nextDailyRun } from '@hapi/protocol/workerSchedule'
import { getFlag, hasFlag, parseIntervalMs, request } from './schedule'
import type { CommandDefinition } from './types'

type Row = { key: string; data: Record<string, unknown>; updatedAt: number }
type Swarm = {
    job: string
    name?: string
    playbook?: string
    review?: { runsLeft: number }
    activeWindow?: { weekdaysOnly?: boolean; startHour?: number; endHour?: number }
    board?: { title?: string; columns?: string[] }
}

const DAY_MS = 86_400_000

function sessionPath(args: string[]): string {
    const sessionId = getFlag(args, 'session') ?? process.env[HAPI_SESSION_ID_ENV]
    if (!sessionId) throw new Error(`No session: pass --session <id> (or run inside a HAPI session, which sets ${HAPI_SESSION_ID_ENV})`)
    return `/api/sessions/${encodeURIComponent(sessionId)}`
}

function parseSchedule(args: string[], now: number): { intervalMs: number; firstRunAt: number } | null | undefined {
    if (hasFlag(args, 'on-demand')) return null
    const daily = getFlag(args, 'daily')
    if (daily !== undefined) return { intervalMs: DAY_MS, firstRunAt: nextDailyRun(daily, now) }
    const intervalMs = parseIntervalMs(getFlag(args, 'every'))
    if (intervalMs !== undefined) return { intervalMs, firstRunAt: now + intervalMs }
    return undefined
}

/** `--weekdays`, `--hours 9-17`, or `--any-time` to lift both. Undefined leaves the window as it is. */
export function parseActiveWindow(args: string[]): { weekdaysOnly?: boolean; startHour?: number; endHour?: number } | null | undefined {
    if (hasFlag(args, 'any-time')) return null
    const hours = getFlag(args, 'hours')
    const weekdaysOnly = hasFlag(args, 'weekdays')
    if (hours === undefined) return weekdaysOnly ? { weekdaysOnly } : undefined
    const match = hours.match(/^(\d{1,2})-(\d{1,2})$/)
    const [startHour, endHour] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN]
    if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) {
        throw new Error(`Invalid --hours value: ${hours} (expected start-end on a 24h clock, e.g. 9-17)`)
    }
    return { weekdaysOnly: weekdaysOnly || undefined, startHour, endHour }
}

function parsePlaybook(args: string[]): string | undefined {
    const file = getFlag(args, 'playbook-file')
    return file ? readFileSync(file, 'utf8') : getFlag(args, 'playbook')
}

function parseReviewRuns(args: string[]): number | undefined {
    if (hasFlag(args, 'no-review')) return 0
    const value = getFlag(args, 'review')
    if (value === undefined) return undefined
    const runs = Number(value)
    if (!Number.isInteger(runs) || runs < 0 || runs > 50) throw new Error(`Invalid --review value: ${value} (expected a number of runs, 0-50)`)
    return runs
}

function parseList(value: string | undefined): string[] | undefined {
    const items = value?.split(',').map((item) => item.trim()).filter(Boolean)
    return items?.length ? items : undefined
}

/** Accepts `{ key, ...fields }`, `{ key, data }`, or an array of either. */
export function parseRows(input: unknown): { key: string; data: Record<string, unknown> }[] {
    const items = Array.isArray(input) ? input : [input]
    return items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Row ${index + 1} is not an object`)
        const { key, data, ...fields } = item as Record<string, unknown>
        if (typeof key !== 'string' && typeof key !== 'number') throw new Error(`Row ${index + 1} has no "key"`)
        const nested = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
        return { key: String(key), data: nested ?? fields }
    })
}

async function currentSwarm(path: string): Promise<Swarm | null> {
    const data = await request<{ session?: { metadata?: { swarm?: Swarm } | null } }>('get', path)
    return data.session?.metadata?.swarm ?? null
}

async function handleWorkerCommand(args: string[]): Promise<void> {
    await initializeToken()
    const sub = args[0] ?? 'status'
    if (sub === 'help' || sub === '--help' || sub === '-h') {
        showHelp(); return
    }
    const path = sessionPath(args)

    if (sub === 'status') {
        const swarm = await currentSwarm(path)
        if (!swarm) {
            console.log(chalk.gray('This session is not a swarm worker.'))
            return
        }
        console.log(`${chalk.green('Worker')}${swarm.name ? ` ${chalk.bold(swarm.name)}` : ''}: ${swarm.job}`)
        console.log(swarm.review
            ? chalk.yellow(`  review period: ${swarm.review.runsLeft} more approved run(s) before running free - draft outward-facing actions, do not take them`)
            : '  running free (no review period)')
        if (swarm.activeWindow) {
            const { weekdaysOnly, startHour, endHour } = swarm.activeWindow
            console.log(`  scheduled runs only: ${[weekdaysOnly ? 'weekdays' : '', startHour !== undefined ? `${startHour}:00-${endHour}:00` : ''].filter(Boolean).join(', ')} (hub local time)`)
        }
        if (swarm.board?.columns) console.log(`  board columns: ${swarm.board.columns.join(', ')}`)
        if (swarm.playbook) console.log(`  playbook:\n${swarm.playbook.replace(/^/gm, '    ')}`)
        return
    }

    if (sub === 'promote') {
        const job = getFlag(args, 'job') ?? (await currentSwarm(path))?.job
        if (!job) throw new Error('Missing --job')
        const columns = parseList(getFlag(args, 'columns'))
        const title = getFlag(args, 'board-title')
        await request('put', `${path}/swarm`, {
            job,
            name: getFlag(args, 'name'),
            schedule: parseSchedule(args, Date.now()),
            activeWindow: parseActiveWindow(args),
            playbook: parsePlaybook(args),
            reviewRuns: parseReviewRuns(args),
            board: columns || title ? { title, columns } : undefined
        })
        console.log(chalk.green('Worker set:'), job)
        return
    }

    if (sub === 'approve') {
        const swarm = await currentSwarm(path)
        if (!swarm) throw new Error('This session is not a swarm worker')
        if (!swarm.review) {
            console.log(chalk.gray('No review period: this worker already runs free.'))
            return
        }
        const runsLeft = hasFlag(args, 'all') ? 0 : swarm.review.runsLeft - 1
        await request('put', `${path}/swarm`, { job: swarm.job, reviewRuns: runsLeft })
        console.log(chalk.green('Approved.'), runsLeft > 0 ? `${runsLeft} more run(s) to review.` : 'Review period over: the worker now runs free.')
        return
    }

    if (sub === 'retire') {
        await request('put', `${path}/swarm`, { job: null })
        console.log(chalk.green('Retired from the swarm.'))
        return
    }

    if (sub === 'record') {
        const file = getFlag(args, 'file')
        const inline = getFlag(args, 'data')
        if (!file && !inline) throw new Error('Missing --data <json> or --file <path>')
        const parsed: unknown = JSON.parse(file ? readFileSync(file, 'utf8') : inline!)
        const key = getFlag(args, 'key')
        const rows = parseRows(key !== undefined && !Array.isArray(parsed) ? { key, data: parsed } : parsed)
        for (let offset = 0; offset < rows.length; offset += 500) {
            await request('post', `${path}/worker-records`, { records: rows.slice(offset, offset + 500) })
        }
        console.log(chalk.green('Recorded:'), `${rows.length} row${rows.length === 1 ? '' : 's'}`)
        return
    }

    if (sub === 'rows') {
        const { records } = await request<{ records: Row[] }>('get', `${path}/worker-records`)
        console.log(JSON.stringify(records.map((row) => ({ key: row.key, ...row.data })), null, 2))
        return
    }

    if (sub === 'remove') {
        const key = getFlag(args, 'key') ?? args[1]
        if (!key) throw new Error('Missing --key')
        await request('delete', `${path}/worker-records/${encodeURIComponent(key)}`)
        console.log(chalk.green('Removed:'), key)
        return
    }

    throw new Error(`Unknown worker subcommand: ${sub}`)
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi worker')} - Swarm workers: a session with a standing job, a clock and a board

Targets the current HAPI session (${HAPI_SESSION_ID_ENV}); pass --session <id> for another.

${chalk.bold('Usage:')}
  hapi worker status
  hapi worker promote [--job <text>] [--name <name>] [--every 6h | --daily 09:00 | --on-demand]
                      [--weekdays] [--hours 9-17] [--any-time]
                      [--playbook <text> | --playbook-file <path>] [--review <runs> | --no-review]
                      [--columns a,b,c] [--board-title <text>]
                      Only the flags you pass change; the schedule keeps running through edits.
  hapi worker approve [--all]                              approve the last run (or end the review period)
  hapi worker retire
  hapi worker record --key <id> --data '<json object>'     add a board row, or patch that row's fields
  hapi worker record --file rows.json                      many rows: [{ "key": "...", "field": ... }]
  hapi worker rows                                         print the board as JSON
  hapi worker remove --key <id>

${chalk.bold('Board rows:')}
  One row per item the job produces. --key must be stable for the item (a URL or email works),
  so a rerun updates the row instead of adding a duplicate. Fields merge: recording
  {"emailSent": true} for an existing key changes only that field; null removes a field.
  URLs, emails, numbers and true/false get their own cell style on the board.
  A field holding an image URL, or a list of them, is shown as pictures rather
  than links — use it when what the item looks like is the point (a listing,
  an office, a product, a headshot).

${chalk.bold('Working hours:')}
  --weekdays and --hours 9-17 (24h, the hub's local time) limit when the schedule fires.
  Slots outside are skipped without waking the worker and are not counted as missed.
  --any-time removes the limit. Messages from the user still reach the worker at any time.

${chalk.bold('Playbook:')}
  How the job is done right now. It is sent with every scheduled run, so when the approach
  changes, rewrite the playbook and the next run follows it. The schedule is untouched.

${chalk.bold('Review period:')}
  --review 3 means the next 3 runs are reviewed: the worker records its rows but drafts
  outward-facing actions (email, posts, deletes) instead of taking them. Each approval counts
  one run down; at 0 it runs free.

${chalk.bold('Examples:')}
  hapi worker promote --job "Keep the researcher pipeline topped up" --name Scout --daily 09:00 \\
      --columns name,linkedin,citations,whyGoodFit,industryExperience,emailSent
  hapi worker record --key "linkedin.com/in/jane" --data '{"name":"Jane Doe","citations":4120,"emailSent":false}'
  hapi worker record --key "linkedin.com/in/jane" --data '{"emailSent":true}'
  hapi worker record --key "listing/42" --data '{"rent":4200,"photos":["https://…/1.jpg","https://…/2.jpg"]}'
`)
}

export const workerCommand: CommandDefinition = {
    name: 'worker',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleWorkerCommand(commandArgs)
        } catch (error) {
            const response = (error as { response?: { data?: { error?: string } } }).response
            console.error(chalk.red('Error:'), response?.data?.error ?? (error instanceof Error ? error.message : 'Unknown error'))
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}
