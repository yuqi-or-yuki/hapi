import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Stored logins, kept on the machine and never in the hub database, its logs
 * or its backups. Node-only; do not import from web code.
 *
 * - macOS: the login Keychain. Encrypted at rest and locked with the user's login.
 * - Linux: one AES-256-GCM encrypted file per secret under `$HAPI_HOME/secrets`,
 *   readable only by the account HAPI runs as. A headless server has no
 *   keyring, and the key lives beside the files, so this protects against a
 *   secret leaking through a database, log, backup or stray copy of one file;
 *   it does not protect against someone who can already read that account's
 *   home, the same as the agents' own login files.
 */
export type SecretFields = {
    password: string
    username?: string
    url?: string
    note?: string
}

/** Names double as Keychain account names, file names and CLI arguments, so they stay boring. */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/

export type SecretStorage = 'keychain' | 'file'

/** Where secrets live on this machine, or null when it has no supported store. */
export function secretStorage(): SecretStorage | null {
    if (process.platform === 'darwin') return 'keychain'
    if (process.platform === 'linux') return 'file'
    return null
}

export function isSecretVaultSupported(): boolean {
    return secretStorage() !== null
}

function assertNamespace(namespace: string): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new Error('Invalid namespace')
}

function assertName(name: string): void {
    if (!SECRET_NAME_PATTERN.test(name)) {
        throw new Error('Secret names use lowercase letters, digits, dots, dashes and underscores')
    }
}

function assertSupported(): SecretStorage {
    const storage = secretStorage()
    if (!storage) throw new Error('Stored secrets are not available on this machine')
    return storage
}

function parseFields(json: string): SecretFields | null {
    try {
        const parsed: unknown = JSON.parse(json)
        if (parsed && typeof parsed === 'object' && typeof (parsed as SecretFields).password === 'string') return parsed as SecretFields
    } catch {
        // Not something this vault wrote.
    }
    return null
}

// ---- macOS Keychain ----

function serviceFor(namespace: string): string {
    return `ai.hapi.secrets.${namespace}`
}

// ---- Linux encrypted files ----

function vaultDir(): string {
    return join(process.env.HAPI_HOME || join(homedir(), '.hapi'), 'secrets')
}

function vaultKey(): Buffer {
    const dir = vaultDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const path = join(dir, '.key')
    if (!existsSync(path)) {
        // `wx` so two processes starting at once cannot each write a different key.
        try {
            writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
    }
    const key = readFileSync(path)
    if (key.length !== 32) throw new Error('The secrets key file is damaged')
    return key
}

function fileFor(namespace: string, name: string): string {
    return join(vaultDir(), namespace, `${name}.enc`)
}

function writeFileSecret(namespace: string, name: string, fields: SecretFields): void {
    const key = vaultKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    // The name is bound in as authenticated data, so a file renamed to another secret's name does not decrypt.
    cipher.setAAD(Buffer.from(`${namespace}/${name}`, 'utf8'))
    const body = Buffer.concat([cipher.update(JSON.stringify(fields), 'utf8'), cipher.final()])
    const path = fileFor(namespace, name)
    mkdirSync(join(vaultDir(), namespace), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 })
    renameSync(tmp, path)
}

function readFileSecret(namespace: string, name: string): SecretFields | null {
    const path = fileFor(namespace, name)
    if (!existsSync(path)) return null
    try {
        const raw = readFileSync(path)
        const decipher = createDecipheriv('aes-256-gcm', vaultKey(), raw.subarray(0, 12))
        decipher.setAAD(Buffer.from(`${namespace}/${name}`, 'utf8'))
        decipher.setAuthTag(raw.subarray(12, 28))
        return parseFields(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'))
    } catch {
        return null
    }
}

// ---- Public API ----

export function writeSecret(namespace: string, name: string, fields: SecretFields): void {
    const storage = assertSupported()
    assertNamespace(namespace)
    assertName(name)
    if (storage === 'file') return writeFileSecret(namespace, name, fields)
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
    const storage = assertSupported()
    assertNamespace(namespace)
    assertName(name)
    if (storage === 'file') return readFileSecret(namespace, name)
    const result = spawnSync('/usr/bin/security', ['find-generic-password', '-a', name, '-s', serviceFor(namespace), '-w'], { encoding: 'utf8' })
    if (result.status !== 0) return null
    return parseFields(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'))
}

export function deleteSecret(namespace: string, name: string): boolean {
    const storage = assertSupported()
    assertNamespace(namespace)
    assertName(name)
    if (storage === 'file') {
        const path = fileFor(namespace, name)
        if (!existsSync(path)) return false
        rmSync(path)
        return true
    }
    return spawnSync('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', serviceFor(namespace)]).status === 0
}
