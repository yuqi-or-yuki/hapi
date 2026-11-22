import { readFileSync } from 'node:fs'
import chalk from 'chalk'
import { readSecret } from '@hapi/protocol/secretVault'
import { initializeToken } from '@/ui/tokenInit'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { getFlag, hasFlag, request } from './schedule'
import type { CommandDefinition } from './types'

type SecretEntry = { name: string; username?: string; url?: string; note?: string; lastUsedAt?: number }

const NAMESPACE = 'default'

async function handleSecretCommand(args: string[]): Promise<void> {
    const sub = args[0] ?? 'list'
    if (sub === 'help' || sub === '--help' || sub === '-h') {
        showHelp(); return
    }
    await initializeToken()

    if (sub === 'list') {
        const { secrets } = await request<{ secrets: SecretEntry[] }>('get', '/api/secrets')
        if (secrets.length === 0) {
            console.log(chalk.gray('No stored secrets. The user adds them under Secrets in HAPI.'))
            return
        }
        for (const secret of secrets) {
            console.log([chalk.cyan(secret.name), secret.username, secret.url, secret.note && chalk.gray(secret.note)].filter(Boolean).join('  '))
        }
        return
    }

    if (sub === 'get') {
        const name = args[1]
        if (!name) throw new Error('Missing secret name')
        // Read straight from the Keychain on this machine: the hub has no route
        // that returns a password, so nothing sensitive crosses the network.
        const secret = readSecret(NAMESPACE, name)
        if (!secret) throw new Error(`No stored secret named "${name}" (see: hapi secret list)`)
        // Best effort: the read is what matters; the usage note is only for the user's overview.
        await request('post', `/api/secrets/${encodeURIComponent(name)}/used`, { sessionId: process.env[HAPI_SESSION_ID_ENV] }).catch(() => {})

        const field = getFlag(args, 'field')
        if (field) {
            const value = secret[field as keyof typeof secret]
            if (value === undefined) throw new Error(`Secret "${name}" has no ${field}`)
            process.stdout.write(`${value}\n`)
            return
        }
        console.log(JSON.stringify({ name, ...secret }, null, 2))
        return
    }

    if (sub === 'set') {
        const name = args[1]
        if (!name) throw new Error('Missing secret name')
        // The password comes on stdin only, never as an argument, so it stays
        // out of the process list and the shell history. Without it, an
        // existing secret keeps its password and only the details change.
        const password = hasFlag(args, 'password-stdin') ? readFileSync(0, 'utf8').replace(/\r?\n$/, '') : undefined
        if (password === '') throw new Error('Empty password on stdin')
        await request('put', `/api/secrets/${encodeURIComponent(name)}`, {
            password,
            username: getFlag(args, 'username'),
            url: getFlag(args, 'url'),
            note: getFlag(args, 'note')
        })
        console.log(chalk.green('Stored:'), name)
        return
    }

    throw new Error(`Unknown secret subcommand: ${sub}`)
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi secret')} - Logins the user has stored for agents (macOS Keychain)

${chalk.bold('Usage:')}
  hapi secret list                                   names, usernames and sites (never passwords)
  hapi secret get <name>                             the login as JSON: username, password, url
  hapi secret get <name> --field password|username|url
  hapi secret set <name> [--username <u>] [--url <site>] [--note <text>] [--password-stdin]
                                                     store or update a login; the password is read
                                                     from stdin only, and kept if not given

The user manages secrets under Secrets in HAPI. To add one without the password
ever entering the chat, give them a link that opens the form prefilled:
  /secrets?new=<name>&username=<u>&url=<site>&note=<text>
Use a secret only for the site it was stored for, and never repeat a password
in replies, files, commits or logs.
`)
}

export const secretCommand: CommandDefinition = {
    name: 'secret',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleSecretCommand(commandArgs)
        } catch (error) {
            const response = (error as { response?: { data?: { error?: string } } }).response
            console.error(chalk.red('Error:'), response?.data?.error ?? (error instanceof Error ? error.message : 'Unknown error'))
            process.exit(1)
        }
    }
}
