import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SecretsRailIcon } from '@/components/AppRail'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'
import type { SecretEntry, SecretInput } from '@/api/client'

const INPUT_CLASS = 'mt-1.5 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]'
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** "Work Email" → "work-email": people type labels, agents type names. */
export function secretNameFrom(label: string): string {
    return label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 63)
}

/** Details an agent already gathered, so the user only has to type the password. */
export type SecretDraft = { name: string; username?: string; url?: string; note?: string }

function SecretDialog(props: {
    /** The secret being edited, or null to add one. */
    secret: SecretEntry | null
    draft?: SecretDraft
    onClose: () => void
    onSave: (name: string, input: SecretInput) => Promise<void>
}) {
    const { t } = useTranslation()
    const editing = props.secret
    const initial = editing ?? props.draft
    const [name, setName] = useState(initial?.name ?? '')
    const [username, setUsername] = useState(initial?.username ?? '')
    const [password, setPassword] = useState('')
    const [url, setUrl] = useState(initial?.url ?? '')
    const [note, setNote] = useState(initial?.note ?? '')
    const [error, setError] = useState<string | null>(null)
    const [isPending, setIsPending] = useState(false)
    const finalName = editing?.name ?? secretNameFrom(name)
    const canSave = NAME_PATTERN.test(finalName) && (Boolean(editing) || password.length > 0)

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        if (!canSave) return
        setError(null)
        setIsPending(true)
        try {
            // An empty password on edit means "keep the stored one".
            await props.onSave(finalName, { username, url, note, password: password || undefined })
            props.onClose()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : t('dialog.error.default'))
        } finally {
            setIsPending(false)
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-h-[92vh] max-w-md overflow-y-auto">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {editing ? t('secrets.dialog.editTitle', { name: editing.name }) : t('secrets.dialog.addTitle')}
                    </DialogTitle>
                </DialogHeader>
                {/* autoComplete off throughout: these are logins for agents, not for this page. */}
                <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-4" autoComplete="off">
                    {editing ? null : (
                        <label className="block text-sm font-medium text-[var(--app-fg)]">
                            {t('secrets.field.name')}
                            <input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder={t('secrets.field.namePlaceholder')}
                                className={INPUT_CLASS}
                                disabled={isPending}
                                autoFocus={!props.draft}
                            />
                            <span className="mt-1.5 block text-xs font-normal text-[var(--app-hint)]">
                                {finalName ? t('secrets.field.nameHint', { name: finalName }) : t('secrets.field.nameEmptyHint')}
                            </span>
                        </label>
                    )}
                    <label className="block text-sm font-medium text-[var(--app-fg)]">
                        {t('secrets.field.username')}
                        <input value={username} onChange={(event) => setUsername(event.target.value)} className={INPUT_CLASS} disabled={isPending} autoComplete="off" />
                    </label>
                    <label className="block text-sm font-medium text-[var(--app-fg)]">
                        {t('secrets.field.password')}
                        <input
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder={editing ? t('secrets.field.passwordKeep') : ''}
                            className={INPUT_CLASS}
                            disabled={isPending}
                            autoComplete="new-password"
                            autoFocus={Boolean(editing || props.draft)}
                        />
                    </label>
                    <label className="block text-sm font-medium text-[var(--app-fg)]">
                        {t('secrets.field.url')}
                        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" className={INPUT_CLASS} disabled={isPending} />
                    </label>
                    <label className="block text-sm font-medium text-[var(--app-fg)]">
                        {t('secrets.field.note')}
                        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('secrets.field.notePlaceholder')} className={INPUT_CLASS} disabled={isPending} />
                    </label>

                    {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">{error}</div> : null}

                    <div className="flex items-center justify-between gap-2">
                        <Button type="button" variant="secondary" onClick={props.onClose} disabled={isPending}>{t('button.cancel')}</Button>
                        <Button type="submit" disabled={isPending || !canSave}>{t('secrets.dialog.save')}</Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}

/**
 * The logins agents may use. This page can add, replace and remove a secret
 * but never shows a stored password: there is nothing on the server that
 * would return one.
 */
export function SecretsView(props: {
    secrets: readonly SecretEntry[]
    supported: boolean
    isLoading: boolean
    error: string | null
    sessionTitles: Record<string, string>
    /** Opens the dialog prefilled, from a link an agent handed the user. */
    draft?: SecretDraft
    onSave: (name: string, input: SecretInput) => Promise<void>
    onDelete: (name: string) => Promise<void>
}) {
    const { t } = useTranslation()
    // undefined: closed. null: adding. An entry: editing it.
    const [dialog, setDialog] = useState<SecretEntry | null | undefined>(props.draft ? null : undefined)
    const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

    return (
        <div className="mx-auto w-full max-w-content px-3 py-4 sm:px-4 sm:py-5">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-[var(--app-hint)]">{t('secrets.storedIn')}</p>
                <Button type="button" onClick={() => setDialog(null)} disabled={!props.supported}>{t('secrets.add')}</Button>
            </div>

            {props.error ? <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">{props.error}</div> : null}
            {!props.supported && !props.isLoading ? (
                <div className="mt-4 rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{t('secrets.unsupported')}</div>
            ) : null}

            {props.secrets.length === 0 && !props.isLoading && !props.error ? (
                <div className="mt-4 rounded-2xl border border-dashed border-[var(--app-border)] px-5 py-10 text-center">
                    <SecretsRailIcon className="mx-auto h-8 w-8 text-[var(--app-hint)]" />
                    <p className="mt-3 text-sm font-medium text-[var(--app-fg)]">{t('secrets.empty.title')}</p>
                    <p className="mx-auto mt-2 max-w-md text-sm text-[var(--app-hint)]">{t('secrets.empty.body')}</p>
                </div>
            ) : null}

            <ul className="mt-4 flex flex-col gap-2">
                {props.secrets.map((secret) => {
                    const lastUsed = secret.lastUsedAt ? formatRelativeTime(secret.lastUsedAt, t) : null
                    const usedBy = secret.lastUsedBy ? props.sessionTitles[secret.lastUsedBy] : undefined
                    return (
                        <li key={secret.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-x-2">
                                    <span className="font-mono text-sm font-semibold text-[var(--app-fg)]">{secret.name}</span>
                                    {secret.username ? <span className="truncate text-sm text-[var(--app-fg)]">{secret.username}</span> : null}
                                </div>
                                <p className="mt-0.5 truncate text-xs text-[var(--app-hint)]">
                                    {[secret.url, secret.note].filter(Boolean).join(' · ') || t('secrets.noDetails')}
                                </p>
                                <p className="mt-0.5 text-xs text-[var(--app-hint)]">
                                    {lastUsed
                                        ? (usedBy ? t('secrets.lastUsedBy', { time: lastUsed, session: usedBy }) : t('secrets.lastUsed', { time: lastUsed }))
                                        : t('secrets.neverUsed')}
                                </p>
                            </div>
                            {confirmingDelete === secret.name ? (
                                <div className="flex items-center gap-2 text-xs">
                                    <span className="text-[var(--app-hint)]">{t('secrets.deleteConfirm')}</span>
                                    <button
                                        type="button"
                                        onClick={() => void props.onDelete(secret.name).finally(() => setConfirmingDelete(null))}
                                        className="rounded-full bg-red-600 px-3 py-1.5 font-medium text-white hover:opacity-90"
                                    >
                                        {t('secrets.delete')}
                                    </button>
                                    <button type="button" onClick={() => setConfirmingDelete(null)} className="px-2 py-1.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]">
                                        {t('button.cancel')}
                                    </button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 text-xs">
                                    <button
                                        type="button"
                                        onClick={() => setDialog(secret)}
                                        className="rounded-full border border-[var(--app-border)] px-3 py-1.5 font-medium text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
                                    >
                                        {t('swarm.edit')}
                                    </button>
                                    <button type="button" onClick={() => setConfirmingDelete(secret.name)} className="px-2 py-1.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]">
                                        {t('secrets.delete')}
                                    </button>
                                </div>
                            )}
                        </li>
                    )
                })}
            </ul>

            {dialog !== undefined ? (
                <SecretDialog
                    // A draft for a name that already exists edits that secret rather than shadowing it.
                    secret={dialog ?? props.secrets.find((secret) => secret.name === props.draft?.name) ?? null}
                    draft={dialog === null ? props.draft : undefined}
                    onClose={() => setDialog(undefined)}
                    onSave={props.onSave}
                />
            ) : null}
        </div>
    )
}
