import { trimIdent } from '@/utils/trimIdent'

/** Tells an agent that stored logins exist and how to treat them. Shared by every flavor's system prompt. */
export const HAPI_SECRETS_PROMPT = trimIdent(`
    When a task needs you to sign in somewhere, the user may have stored the login for you: run "hapi secret list" to see the stored names, usernames and sites, and "hapi secret get <name>" to read one.
    Use a stored secret only for the site it was stored for. Never repeat a password in your replies, files, commits or logs.
    If no stored secret fits, ask the user to add it under Secrets in HAPI rather than asking them to paste a password into the chat.
`)
