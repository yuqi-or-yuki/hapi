import { spawnSync } from 'node:child_process'

/**
 * Stored logins, kept in the macOS login Keychain.
 *
 * The Keychain is the store on purpose: values are encrypted at rest, locked
 * with the user's login, and never written to the hub database, its logs or
 * its backups. Node-only; do not import from web code.
 */
export type SecretFields = {
    password: string
    username?: string
    url?: string
    note?: string
}

/** Names double as Keychain account names and CLI arguments, so they stay boring. */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/

export function isSecretVaultSupported(): boolean {
    return process.platform === 'darwin'
}

function serviceFor(namespace: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new Error('Invalid namespace')
    return `ai.hapi.secrets.${namespace}`
}

function assertName(name: string): void {
    if (!SECRET_NAME_PATTERN.test(name)) {
        throw new Error('Secret names use lowercase letters, digits, dots, dashes and underscores')
    }
}

function assertSupported(): void {
    if (!isSecretVaultSupported()) throw new Error('Stored secrets need the macOS Keychain and are not available on this machine')
}

export function writeSecret(namespace: string, name: string, fields: SecretFields): void {
    assertSupported()
    assertName(name)
    // The command goes to `security -i` on stdin, not argv, so the value never
    // shows up in the process list. Base64 keeps it to characters that need no
    // quoting, and name/namespace are validated above.
    const value = Buffer.from(JSON.stringify(fields), 'utf8').toString('base64')
    const result = spawnSync('/usr/bin/security', ['-i'], {
        input: `add-generic-password -a ${name} -s ${serviceFor(namespace)} -U -w ${value}\n`,
        encoding: 'utf8'
    })
    if (result.status !== 0) throw new Error(`Keychain write failed: ${result.stderr.trim() || 'unknown error'}`)
}

export function readSecret(namespace: string, name: string): SecretFields | null {
    assertSupported()
    assertName(name)
    const result = spawnSync('/usr/bin/security', ['find-generic-password', '-a', name, '-s', serviceFor(namespace), '-w'], { encoding: 'utf8' })
    if (result.status !== 0) return null
    try {
        const parsed: unknown = JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'))
        if (parsed && typeof parsed === 'object' && typeof (parsed as SecretFields).password === 'string') return parsed as SecretFields
    } catch {
        // Not something this vault wrote.
    }
    return null
}

export function deleteSecret(namespace: string, name: string): boolean {
    assertSupported()
    assertName(name)
    return spawnSync('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', serviceFor(namespace)]).status === 0
}
