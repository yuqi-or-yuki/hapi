import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import type { AgentAuthAgent, AgentAuthRequest, AgentAuthState, Machine } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

const AGENTS: { agent: AgentAuthAgent; label: string }[] = [
    { agent: 'claude', label: 'Claude Code' },
    { agent: 'codex', label: 'Codex' },
]

const linkButton = 'text-xs font-medium text-[var(--app-link)] hover:underline disabled:opacity-50'

/**
 * Which account an agent CLI is signed in as on a machine, and a way to sign
 * in or switch: the machine produces the agent's own sign-in link, the person
 * finishes it in any browser.
 */
function AgentAccountRow(props: { api: ApiClient; machineId: string; agent: AgentAuthAgent; label: string }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [code, setCode] = useState('')
    const [copied, setCopied] = useState(false)
    const queryKey = queryKeys.machineAgentAuth(props.machineId, props.agent)

    const call = (action: AgentAuthRequest['action'], extra?: { code: string }) =>
        props.api.machineAgentAuth(props.machineId, { agent: props.agent, action, ...extra })

    const query = useQuery({
        queryKey,
        queryFn: () => call('status'),
        retry: false,
        // While a sign-in is open, watch for the agent finishing it.
        refetchInterval: (q) => (q.state.data?.login?.status === 'waiting' ? 2500 : false),
    })
    const action = useMutation({
        mutationFn: (args: { action: AgentAuthRequest['action']; code?: string }) =>
            call(args.action, args.code ? { code: args.code } : undefined),
        onSuccess: (state: AgentAuthState) => {
            setCode('')
            queryClient.setQueryData(queryKey, state)
        },
    })

    const state = query.data
    const login = state?.login
    const busy = action.isPending
    const failure = action.error ?? query.error
    const upgradeRequired = failure instanceof ApiError && failure.code === 'runner_upgrade_required'

    const summary = !state
        ? ''
        : !state.installed
            ? t('settings.machines.accounts.notInstalled')
            : state.loggedIn
                ? [state.account, state.plan].filter(Boolean).join(' · ') || '✓'
                : t('settings.machines.accounts.signedOut')

    return (
        <div className="text-xs">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 truncate text-[var(--app-hint)]">
                    <span className="font-medium text-[var(--app-fg)]">{props.label}</span>
                    {summary ? <span> · {summary}</span> : null}
                </div>
                {state?.installed && login?.status !== 'waiting' ? (
                    <div className="flex shrink-0 gap-3">
                        <button type="button" className={linkButton} disabled={busy} onClick={() => action.mutate({ action: 'start' })}>
                            {busy && action.variables?.action === 'start'
                                ? t('settings.machines.accounts.starting')
                                : state.loggedIn ? t('settings.machines.accounts.switch') : t('settings.machines.accounts.signIn')}
                        </button>
                        {state.loggedIn ? (
                            <button type="button" className={linkButton} disabled={busy} onClick={() => action.mutate({ action: 'logout' })}>
                                {t('settings.machines.accounts.signOut')}
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {login?.status === 'waiting' ? (
                <div className="mt-2 space-y-2 rounded-lg border border-[var(--app-border)] p-2">
                    <div className="text-[var(--app-hint)]">
                        {login.needsCode ? t('settings.machines.accounts.claudeHint') : t('settings.machines.accounts.codexHint')}
                        {login.userCode ? <span className="ml-1 select-all font-mono font-semibold text-[var(--app-fg)]">{login.userCode}</span> : null}
                    </div>
                    {login.url ? (
                        <div className="flex flex-wrap gap-3">
                            <a className={linkButton} href={login.url} target="_blank" rel="noopener noreferrer">
                                {t('settings.machines.accounts.openLink')} ↗
                            </a>
                            <button
                                type="button"
                                className={linkButton}
                                onClick={() => {
                                    void navigator.clipboard?.writeText(login.url ?? '').then(() => setCopied(true))
                                }}
                            >
                                {copied ? t('settings.machines.accounts.copied') : t('settings.machines.accounts.copyLink')}
                            </button>
                        </div>
                    ) : null}
                    <form
                        className="flex gap-2"
                        onSubmit={(event) => {
                            event.preventDefault()
                            if (code.trim()) action.mutate({ action: 'submit', code: code.trim() })
                        }}
                    >
                        {login.needsCode ? (
                            <>
                                <input
                                    value={code}
                                    onChange={(event) => setCode(event.target.value)}
                                    placeholder={t('settings.machines.accounts.codePlaceholder')}
                                    aria-label={t('settings.machines.accounts.codePlaceholder')}
                                    autoComplete="off"
                                    className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 font-mono text-xs text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                                />
                                <button type="submit" className={linkButton} disabled={busy || !code.trim()}>
                                    {t('settings.machines.accounts.submit')}
                                </button>
                            </>
                        ) : null}
                        <button type="button" className={linkButton} disabled={busy} onClick={() => action.mutate({ action: 'cancel' })}>
                            {t('settings.machines.accounts.cancel')}
                        </button>
                    </form>
                </div>
            ) : null}

            {login?.status === 'done' ? (
                <div className="mt-1 text-emerald-600 dark:text-emerald-400">{t('settings.machines.accounts.done')}</div>
            ) : null}
            {login?.status === 'failed' ? (
                <div role="alert" className="mt-1 text-red-600 dark:text-red-400">
                    {t('settings.machines.accounts.failed')} {login.error}
                </div>
            ) : null}
            {failure ? (
                <div role="alert" className="mt-1 text-red-600 dark:text-red-400">
                    {upgradeRequired ? t('settings.machines.accounts.upgrade') : t('settings.machines.accounts.error')}
                </div>
            ) : null}
        </div>
    )
}

export function MachineAgentAccounts(props: { api: ApiClient | null; machine: Machine }) {
    const { t } = useTranslation()
    if (!props.api) return null
    if (!props.machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentAuth)) {
        return <div className="mt-2 text-xs text-[var(--app-hint)]">{t('settings.machines.accounts.upgrade')}</div>
    }
    return (
        <div className="mt-2 space-y-2">
            {AGENTS.map((entry) => (
                <AgentAccountRow key={entry.agent} api={props.api!} machineId={props.machine.id} agent={entry.agent} label={entry.label} />
            ))}
        </div>
    )
}
