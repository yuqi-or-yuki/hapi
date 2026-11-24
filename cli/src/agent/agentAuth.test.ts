import { describe, expect, it } from 'vitest'
import { parseLoginOutput } from './agentAuth'

describe('parseLoginOutput', () => {
    it('reads the Claude sign-in link out of terminal hyperlink escapes', () => {
        const raw = 'If the browser didn\'t open, visit:\n\x1b]8;;https://claude.ai/oauth/authorize?abc_DEF-1\x07\x1b[38;5;246mhttps://claude.ai/oauth/authorize?abc_DEF-1\x1b[39m\x1b]8;;\x07\nPaste code here if prompted > '
        expect(parseLoginOutput('claude', raw)).toEqual({ url: 'https://claude.ai/oauth/authorize?abc_DEF-1', userCode: undefined })
    })

    it('reads the Codex device link and one-time code', () => {
        const raw = 'Welcome to Codex [v\x1b[90m0.172.0\x1b[0m]\n1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-12345\x1b[0m\n'
        expect(parseLoginOutput('codex', raw)).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' })
    })
})
