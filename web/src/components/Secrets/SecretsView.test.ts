import { describe, expect, it } from 'vitest'
import { secretNameFrom } from './SecretsView'

describe('secretNameFrom', () => {
    it('turns a label into a name an agent can type', () => {
        expect(secretNameFrom('Work Email')).toBe('work-email')
        expect(secretNameFrom('  LinkedIn (recruiting) ')).toBe('linkedin-recruiting')
        expect(secretNameFrom('gmail.y@tenera')).toBe('gmail.y-tenera')
        expect(secretNameFrom('!!!')).toBe('')
    })
})
