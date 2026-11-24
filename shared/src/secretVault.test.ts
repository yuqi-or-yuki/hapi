import { mkdtempSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteSecret, readSecret, secretStorage, writeSecret } from './secretVault'

// The file store is what a Linux server uses; run it here regardless of the host.
function onLinux(): string {
    const home = mkdtempSync(join(tmpdir(), 'hapi-vault-'))
    vi.stubEnv('HAPI_HOME', home)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    return home
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('secret vault on Linux', () => {
    it('stores a secret encrypted in owner-only files and reads it back', () => {
        const home = onLinux()
        expect(secretStorage()).toBe('file')
        writeSecret('default', 'github', { password: 'hunter2-s3cret', username: 'me' })

        expect(readSecret('default', 'github')).toEqual({ password: 'hunter2-s3cret', username: 'me' })
        const file = join(home, 'secrets/default/github.enc')
        expect(readFileSync(file).includes('hunter2-s3cret')).toBe(false)
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(statSync(join(home, 'secrets/.key')).mode & 0o777).toBe(0o600)
        expect(statSync(join(home, 'secrets')).mode & 0o777).toBe(0o700)
    })

    it('replaces, deletes, and refuses a file moved under another name', () => {
        const home = onLinux()
        writeSecret('default', 'a', { password: 'one' })
        writeSecret('default', 'a', { password: 'two' })
        expect(readSecret('default', 'a')?.password).toBe('two')
        expect(readdirSync(join(home, 'secrets/default'))).toEqual(['a.enc'])

        renameSync(join(home, 'secrets/default/a.enc'), join(home, 'secrets/default/b.enc'))
        expect(readSecret('default', 'b')).toBeNull()
        expect(readSecret('default', 'a')).toBeNull()
        expect(deleteSecret('default', 'b')).toBe(true)
        expect(deleteSecret('default', 'b')).toBe(false)
        expect(() => writeSecret('default', '../escape', { password: 'x' })).toThrow()
    })
})
