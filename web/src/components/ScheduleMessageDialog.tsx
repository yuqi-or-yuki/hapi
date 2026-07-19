import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ScheduledMessage } from '@/types/api'

function toDatetimeLocal(ms: number): string {
    const date = new Date(ms)
    const offset = date.getTimezoneOffset() * 60_000
    return new Date(ms - offset).toISOString().slice(0, 16)
}

function fromDatetimeLocal(value: string): number {
    return new Date(value).getTime()
}

function formatDueAt(ms: number): string {
    return new Date(ms).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    })
}

export function ScheduleMessageDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessionId: string
    sessionName: string
    api: ApiClient | null
}) {
    const [text, setText] = useState('')
    const [dueAtInput, setDueAtInput] = useState(() => toDatetimeLocal(Date.now() + 60 * 60_000))
    const [cloneBeforeSend, setCloneBeforeSend] = useState(false)
    const [repeatMinutes, setRepeatMinutes] = useState('')
    const [repeatLimit, setRepeatLimit] = useState('10')
    const [repeatForever, setRepeatForever] = useState(false)
    const [pending, setPending] = useState<ScheduledMessage[]>([])
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const dueAt = useMemo(() => fromDatetimeLocal(dueAtInput), [dueAtInput])
    const valid = text.trim().length > 0 && Number.isFinite(dueAt) && dueAt > Date.now() + 5_000

    useEffect(() => {
        if (!props.isOpen || !props.api) return
        setError(null)
        props.api.getScheduledMessages(props.sessionId)
            .then(result => setPending(result.scheduledMessages))
            .catch(error => setError(error instanceof Error ? error.message : 'Failed to load scheduled messages'))
    }, [props.api, props.isOpen, props.sessionId])

    if (!props.isOpen) return null

    const handleSchedule = async () => {
        if (!props.api || !valid || isSubmitting) return
        setIsSubmitting(true)
        setError(null)
        try {
            const isRepeating = repeatMinutes.trim().length > 0
            const result = await props.api.scheduleMessage(props.sessionId, {
                text: text.trim(),
                dueAt,
                cloneBeforeSend,
                intervalMs: isRepeating ? Math.max(1, Number(repeatMinutes)) * 60_000 : null,
                maxOccurrences: isRepeating ? (repeatForever ? null : Math.max(1, Number(repeatLimit) || 10)) : undefined
            })
            setPending(prev => [...prev, result.scheduledMessage].sort((a, b) => a.dueAt - b.dueAt))
            setText('')
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Failed to schedule message')
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleCancel = async (id: string) => {
        if (!props.api) return
        try {
            await props.api.cancelScheduledMessage(id)
            setPending(prev => prev.filter(item => item.id !== id))
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Failed to cancel scheduled message')
        }
    }

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={props.onClose}>
            <div
                className="w-full max-w-lg rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                        <h2 className="text-base font-semibold text-[var(--app-fg)]">Schedule message</h2>
                        <p className="text-xs text-[var(--app-hint)]">{props.sessionName}</p>
                    </div>
                    <button
                        type="button"
                        onClick={props.onClose}
                        className="rounded-full px-2 py-1 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                    >
                        Close
                    </button>
                </div>

                <div className="space-y-3">
                    <label className="block">
                        <span className="mb-1 block text-xs font-medium text-[var(--app-fg)]">Message</span>
                        <textarea
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            rows={4}
                            className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                            placeholder="What should HAPI send later?"
                        />
                    </label>

                    <label className="block">
                        <span className="mb-1 block text-xs font-medium text-[var(--app-fg)]">Send at</span>
                        <input
                            type="datetime-local"
                            value={dueAtInput}
                            onChange={(event) => setDueAtInput(event.target.value)}
                            className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                        />
                    </label>

                    <label className="flex items-start gap-2 rounded-xl border border-[var(--app-border)] p-3">
                        <input
                            type="checkbox"
                            checked={cloneBeforeSend}
                            onChange={(event) => setCloneBeforeSend(event.target.checked)}
                            className="mt-0.5 h-4 w-4 accent-[var(--app-link)]"
                        />
                        <span>
                            <span className="block text-sm font-medium text-[var(--app-fg)]">Clone session before sending</span>
                            <span className="block text-xs text-[var(--app-hint)]">Backend will deterministically clone/resume, then send this message to the clone.</span>
                        </span>
                    </label>

                    <label className="block">
                        <span className="mb-1 block text-xs font-medium text-[var(--app-fg)]">Repeat every minutes (optional)</span>
                        <input
                            type="number"
                            min="1"
                            value={repeatMinutes}
                            onChange={(event) => setRepeatMinutes(event.target.value)}
                            className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                            placeholder="5"
                        />
                    </label>

                    {repeatMinutes.trim() ? (
                        <label className="block">
                            <span className="mb-1 block text-xs font-medium text-[var(--app-fg)]">Stop after this many sends</span>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min="1"
                                    value={repeatLimit}
                                    disabled={repeatForever}
                                    onChange={(event) => setRepeatLimit(event.target.value)}
                                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)] disabled:opacity-50"
                                    placeholder="10"
                                />
                                <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--app-fg)]">
                                    <input
                                        type="checkbox"
                                        checked={repeatForever}
                                        onChange={(event) => setRepeatForever(event.target.checked)}
                                        className="h-4 w-4 accent-[var(--app-link)]"
                                    />
                                    Forever
                                </label>
                            </div>
                        </label>
                    ) : null}

                    {error ? <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-600">{error}</div> : null}

                    <button
                        type="button"
                        disabled={!valid || isSubmitting || !props.api}
                        onClick={() => void handleSchedule()}
                        className="w-full rounded-xl bg-[var(--app-link)] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {isSubmitting ? 'Scheduling…' : 'Schedule message'}
                    </button>
                </div>

                <div className="mt-4 border-t border-[var(--app-border)] pt-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">Pending</div>
                    {pending.length === 0 ? (
                        <div className="text-sm text-[var(--app-hint)]">No scheduled messages.</div>
                    ) : (
                        <div className="space-y-2">
                            {pending.map(item => (
                                <div key={item.id} className="rounded-xl border border-[var(--app-border)] p-2">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="text-xs text-[var(--app-hint)]">
                                                {formatDueAt(item.dueAt)} · {item.cloneBeforeSend ? 'clone first' : 'same session'}{item.intervalMs ? ` · every ${Math.round(item.intervalMs / 60_000)}m` : ''}{item.intervalMs ? ` · ${item.occurrenceCount}/${item.maxOccurrences ?? '∞'} sent` : ''}
                                            </div>
                                            <div className="mt-1 line-clamp-2 text-sm text-[var(--app-fg)]">{item.text}</div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => void handleCancel(item.id)}
                                            className="shrink-0 rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-500/10"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
