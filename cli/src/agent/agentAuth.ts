import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentAuthAgent, AgentAuthLogin, AgentAuthRequest, AgentAuthState } from '@hapi/protocol'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'
import { resolveCodexCommand } from '@/codex/utils/codexExecutable'

/**
 * Sign an agent CLI in (or switch its account) on this machine, driven from
 * the web app. We run the agent's own login command, pass its sign-in link
 * back, and for Claude feed the code the person pastes in. The agent stores
 * the resulting credential itself; HAPI never sees it.
 */

type Command = { command: string; args: string[] }
type Flow = { proc: ChildProcess; output: string; login: AgentAuthLogin; timer: ReturnType<typeof setTimeout> }

const LOGIN_TIMEOUT_MS = 20 * 60_000
const LINK_WAIT_MS = 20_000
const flows = new Map<AgentAuthAgent, Flow>()

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g

function resolveCommand(agent: AgentAuthAgent): Command | null {
    try {
        return agent === 'claude' ? { command: getDefaultClaudeCodePath(), args: [] } : resolveCodexCommand()
    } catch {
        return null
    }
}

function run(cmd: Command, args: string[]): Promise<string> {
    return new Promise((resolve) => {
        execFile(cmd.command, [...cmd.args, ...args], { timeout: 15_000 }, (_error, stdout, stderr) => {
            resolve(`${stdout ?? ''}\n${stderr ?? ''}`)
        })
    })
}

/** Exported for tests: what a login command has printed so far. */
export function parseLoginOutput(agent: AgentAuthAgent, raw: string): { url?: string; userCode?: string } {
    const text = raw.replace(ANSI, '')
    const url = text.match(/https:\/\/[^\s]+/)?.[0]
    const userCode = agent === 'codex' ? text.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)?.[0] : undefined
    return { url, userCode }
}

function codexAccount(): { account?: string; plan?: string } {
    try {
        const home = process.env.CODEX_HOME || join(homedir(), '.codex')
        const auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))
        const idToken: unknown = auth?.tokens?.id_token
        if (typeof idToken !== 'string') return auth?.OPENAI_API_KEY ? { account: 'API key' } : {}
        const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
        const plan = claims?.['https://api.openai.com/auth']?.chatgpt_plan_type
        return {
            account: typeof claims?.email === 'string' ? claims.email : undefined,
            plan: typeof plan === 'string' ? plan : undefined
        }
    } catch {
        return {}
    }
}

async function readStatus(agent: AgentAuthAgent): Promise<AgentAuthState> {
    const cmd = resolveCommand(agent)
    const login = flows.get(agent)?.login
    if (!cmd) return { agent, installed: false, loggedIn: false, login }

    if (agent === 'claude') {
        const out = await run(cmd, ['auth', 'status'])
        try {
            const info = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
            return {
                agent,
                installed: true,
                loggedIn: info.loggedIn === true,
                account: typeof info.email === 'string' ? info.email : undefined,
                plan: typeof info.subscriptionType === 'string' ? info.subscriptionType : undefined,
                login
            }
        } catch {
            return { agent, installed: true, loggedIn: false, login }
        }
    }

    const out = await run(cmd, ['login', 'status'])
    const loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out)
    return { agent, installed: true, loggedIn, ...(loggedIn ? codexAccount() : {}), login }
}

function stopFlow(agent: AgentAuthAgent): void {
    const flow = flows.get(agent)
    if (!flow) return
    clearTimeout(flow.timer)
    if (flow.proc.exitCode === null) flow.proc.kill()
    flows.delete(agent)
}

async function startFlow(agent: AgentAuthAgent): Promise<void> {
    stopFlow(agent)
    const cmd = resolveCommand(agent)
    if (!cmd) return

    const args = agent === 'claude' ? ['auth', 'login'] : ['login', '--device-auth']
    const proc = spawn(cmd.command, [...cmd.args, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const flow: Flow = {
        proc,
        output: '',
        login: { status: 'waiting', needsCode: agent === 'claude' },
        timer: setTimeout(() => proc.kill(), LOGIN_TIMEOUT_MS)
    }
    flows.set(agent, flow)

    let linkReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => { linkReady = resolve })
    const onData = (chunk: Buffer) => {
        flow.output = (flow.output + chunk.toString('utf8')).slice(-8000)
        const parsed = parseLoginOutput(agent, flow.output)
        flow.login = { ...flow.login, ...parsed }
        if (parsed.url && (agent === 'claude' || parsed.userCode)) linkReady()
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    const finish = (ok: boolean, error?: string) => {
        clearTimeout(flow.timer)
        const lastLines = flow.output.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ')
        flow.login = ok
            ? { ...flow.login, status: 'done' }
            : { ...flow.login, status: 'failed', error: (error ?? lastLines).slice(0, 300) || 'Sign-in did not finish' }
        linkReady()
    }
    proc.on('error', (error) => finish(false, error.message))
    proc.on('exit', (code) => finish(code === 0))

    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, LINK_WAIT_MS))])
}

export async function handleAgentAuth(request: AgentAuthRequest): Promise<AgentAuthState> {
    const { agent, action } = request
    if (action === 'start') {
        await startFlow(agent)
    } else if (action === 'submit') {
        const flow = flows.get(agent)
        if (flow && flow.login.status === 'waiting' && request.code) {
            flow.proc.stdin?.write(`${request.code.trim()}\n`)
            // Give the CLI a moment to exchange the code so the reply already says done/failed.
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 8_000)
                flow.proc.once('exit', () => { clearTimeout(timer); resolve(undefined) })
            })
        }
    } else if (action === 'cancel') {
        stopFlow(agent)
    } else if (action === 'logout') {
        stopFlow(agent)
        const cmd = resolveCommand(agent)
        if (cmd) await run(cmd, agent === 'claude' ? ['auth', 'logout'] : ['logout'])
    }
    return await readStatus(agent)
}
