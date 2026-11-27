import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkerRecord } from '@/api/client'
import { boardCell, recordImages } from './board'
import { BoardGallery } from './BoardGallery'
import { randomId } from '@/lib/randomId'
import { reviewQueue } from '@hapi/protocol/workerReview'

const roles = [
    'Deployment Strategist', 'Forward Deployment', 'Research Scientist, Evaluations',
    'Research Scientist, Modeling', 'Research Scientist, Behavior Modeling', 'Product Designer'
]

type Review = { id: string; at: string; role?: string; category?: string; decision: 'yes' | 'no'; reason: string; predictedDecision?: 'yes' | 'no'; predictedReason?: string; predictionRole?: string; decisionUnchanged?: boolean; reasonUnchanged?: boolean; suggestionAccepted?: boolean; draftShown?: string; draftFinal?: string; subjectShown?: string; subjectFinal?: string; draftEdited?: boolean }
function reviews(record: WorkerRecord, talent: boolean): Review[] {
    const history = talent ? record.data.linkedinReviews : record.data.approvalReviews
    return Array.isArray(history) ? history as Review[] : []
}
function linkedinUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) ? url.href : null
    } catch { return null }
}

function secureUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null
    try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null } catch { return null }
}

export function TalentReview({ records, onRecord, onClose, talent = true }: { records: readonly WorkerRecord[]; onRecord: (key: string, fields: Record<string, unknown>, rescoreKey: string | null) => Promise<boolean>; onClose: () => void; talent?: boolean }) {
    const [skipped, setSkipped] = useState<string[]>([])
    const [revisit, setRevisit] = useState(false)
    const [role, setRole] = useState('')
    const [decision, setDecision] = useState<'yes' | 'no' | null>(null)
    const [reason, setReason] = useState('')
    // A card can carry a message the worker wants to send (`draft`, with a `subject` for email); the reviewer may rewrite it.
    const [draft, setDraft] = useState('')
    const [subject, setSubject] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const startX = useRef<number | null>(null)
    const initializedKey = useRef<string | null>(null)
    const userEdited = useRef(false)
    const shownSuggestion = useRef<{ decision: 'yes' | 'no' | null; reason: string; role: string } | null>(null)
    // The order itself is shared with the hub and the CLI, so a worker told to
    // re-score "the card after next" counts the same cards the reviewer sees.
    // Skipping and revisiting are this reviewer's own state and stay local.
    const queue = useMemo(() => {
        const board = talent ? { title: 'Talent intake' } : { columns: ['suggestedDecision', 'suggestedReason'] }
        const pending = revisit ? [...records] : reviewQueue(records, board)
        return pending.filter((r) => !skipped.includes(r.key) && (talent || r.data.channel !== 'hold'))
    }, [records, skipped, revisit, talent])
    const candidate = queue[0]
    const suggested = typeof candidate?.data.bestFitRole === 'string' && roles.includes(candidate.data.bestFitRole) ? candidate.data.bestFitRole : ''
    const selectedRole = role || suggested
    const listing = boardCell(candidate?.data.url)
    const profile = talent ? linkedinUrl(candidate?.data.profileUrl) : secureUrl(candidate?.data.profileUrl)
    const talentPoolUrl = secureUrl(candidate?.data.talentPoolUrl) ?? (talent && typeof candidate?.data.name === 'string' && candidate.data.name.trim() ? `https://tenera-talent-pool.vercel.app/pool?q=${encodeURIComponent(candidate.data.name.trim())}` : null)
    const candidateWebsiteUrl = secureUrl(candidate?.data.candidateWebsiteUrl)
    const suggestion = candidate?.data.suggestedDecision === 'yes' || candidate?.data.suggestedDecision === 'no' ? candidate.data.suggestedDecision : null
    const suggestedReason = typeof candidate?.data.suggestedReason === 'string' ? candidate.data.suggestedReason : ''
    const previous = candidate ? reviews(candidate, talent).at(-1) : undefined
    const shownDraft = !talent && typeof candidate?.data.draft === 'string' ? candidate.data.draft : ''
    const shownSubject = !talent && typeof candidate?.data.subject === 'string' ? candidate.data.subject : ''
    const hasDraft = shownDraft.trim().length > 0
    useEffect(() => {
        const key = candidate?.key ?? null
        if (initializedKey.current !== key) { initializedKey.current = key; userEdited.current = false }
        if (userEdited.current) return
        shownSuggestion.current = { decision: suggestion, reason: suggestedReason, role: suggested }
        setRole(previous?.role || suggested)
        setDecision(previous?.decision ?? suggestion)
        setReason(previous?.reason ?? suggestedReason)
        setDraft(shownDraft)
        setSubject(shownSubject)
        setError('')
    }, [candidate?.key, previous?.id, suggestion, suggestedReason, suggested, shownDraft, shownSubject])
    function choose(value: 'yes' | 'no') {
        userEdited.current = true
        if (value !== decision && (reason === shownSuggestion.current?.reason || reason === previous?.reason)) setReason('')
        setDecision(value)
    }
    const reset = () => { setRole(''); setDecision(null); setReason(''); setError('') }
    async function save(reviewDecision: 'yes' | 'no' | null) {
        if (!candidate || (talent && !selectedRole) || !reviewDecision || (!hasDraft && !reason.trim()) || (hasDraft && reviewDecision === 'yes' && !draft.trim())) return
        const shown = shownSuggestion.current
        const comparable = !previous && !!shown?.decision && !!shown.reason && (!talent || selectedRole === shown.role)
        const draftEdited = hasDraft && (draft.trim() !== shownDraft.trim() || subject.trim() !== shownSubject.trim())
        const message = hasDraft ? { draftShown: shownDraft, draftFinal: draft.trim(), ...(shownSubject || subject.trim() ? { subjectShown: shownSubject, subjectFinal: subject.trim() } : {}), draftEdited } : {}
        const review: Review = { id: randomId(), at: new Date().toISOString(), ...message, ...(talent ? { role: selectedRole } : typeof candidate.data.category === 'string' && candidate.data.category.trim() ? { category: candidate.data.category.trim() } : {}), decision: reviewDecision, reason: hasDraft ? previous?.reason ?? '' : reason.trim(), ...(comparable ? { predictedDecision: shown.decision!, predictedReason: shown.reason, ...(talent ? { predictionRole: shown.role } : {}), decisionUnchanged: reviewDecision === shown.decision, ...(hasDraft ? {} : { reasonUnchanged: reason === shown.reason, suggestionAccepted: reviewDecision === shown.decision && reason === shown.reason }) } : {}) }
        setSaving(true); setError('')
        try {
            const fields = talent ? { linkedinReviews: [...reviews(candidate, true), review], linkedinDecision: reviewDecision === 'yes' ? 'Would connect' : 'Would not connect', reviewRole: selectedRole, reviewReason: review.reason } : { approvalReviews: [...reviews(candidate, false), review], approvalDecision: reviewDecision, reviewReason: review.reason, ...(hasDraft && draftEdited ? { draft: draft.trim(), ...(shownSubject || subject.trim() ? { subject: subject.trim() } : {}), draftOriginal: typeof candidate.data.draftOriginal === 'string' ? candidate.data.draftOriginal : shownDraft } : {}) }
            // The card after the one the reviewer opens next: re-scoring that one
            // keeps the worker a step ahead, while re-scoring the next card would
            // leave the reviewer waiting on it.
            const triggered = await onRecord(candidate.key, fields, queue[2]?.key ?? null)
            setNotice(triggered ? 'Saved. The worker was notified to review the scorecard.' : 'Saved, but the worker could not be notified. It will process the feedback on its next scheduled run.')
            setSkipped((keys) => [...keys, candidate.key])
        } catch (e) { setError(e instanceof Error ? e.message : 'Could not save review') } finally { setSaving(false) }
    }
    const value = (v: unknown) => typeof v === 'string' ? v : ''
    const gallery = candidate ? recordImages(candidate.data) : []
    const control = 'w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm text-[var(--app-fg)]'
    return <section className="mt-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 sm:p-6" aria-label="Candidate review">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{talent ? 'Would you connect?' : 'Review suggestions'}</h2>{!hasDraft && <p className="mt-1 text-xs text-[var(--app-hint)]">Suggestions are predictions you can edit. Only saved reviews count as your feedback; no external action is taken.</p>}</div><button type="button" onClick={onClose} className="text-xs underline">Back to table</button></div>
        {notice && <p role="status" className="mt-3 text-sm text-[var(--app-hint)]">{notice}</p>}
        {!candidate ? <div className="py-8 text-sm"><p>No more candidates to review.</p><button type="button" className="mt-3 underline" onClick={() => { setSkipped([]); setRevisit(true); reset() }}>Review again</button></div> :
        <div className="mx-auto mt-5 max-w-xl rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 sm:p-6 space-y-4" onTouchStart={(e) => { const target = e.target as HTMLElement; startX.current = hasDraft || target.closest('button,a,textarea,select') ? null : e.touches[0]?.clientX ?? null }} onTouchEnd={(e) => { if (startX.current === null) return; const delta = (e.changedTouches[0]?.clientX ?? startX.current) - startX.current; if (Math.abs(delta) > 90) choose(delta > 0 ? 'yes' : 'no'); startX.current = null }}>
            <div className="flex justify-between gap-3"><div><h3 className="text-lg font-semibold">{value(candidate.data.name) || value(candidate.data.title) || candidate.key}</h3><p className="mt-1 text-sm text-[var(--app-hint)]">{value(candidate.data.currentRole) || value(candidate.data.description)}</p></div><span className="text-xs text-[var(--app-hint)]">{queue.length} remaining</span></div>
            {gallery.length > 0 && <BoardGallery images={gallery} size="lg" alt={value(candidate.data.name) || candidate.key} />}
            {!talent && listing.kind === 'link' && /^https?:/.test(listing.href) && <a className="text-sm text-[var(--app-link)] underline" href={listing.href} target="_blank" rel="noopener noreferrer">View listing ↗</a>}
            {(talent || profile) && <div className="flex flex-wrap gap-x-4 gap-y-2">
                {talentPoolUrl && <a className="text-sm text-[var(--app-link)] underline" href={talentPoolUrl} target="_blank" rel="noopener noreferrer">Find in talent pool ↗</a>}
                {profile && <a className="text-sm text-[var(--app-link)] underline" href={profile} target="_blank" rel="noopener noreferrer">{talent ? 'View LinkedIn profile ↗' : 'View profile ↗'}</a>}
                {candidateWebsiteUrl && (talent || candidateWebsiteUrl !== profile) && <a className="text-sm text-[var(--app-link)] underline" href={candidateWebsiteUrl} target="_blank" rel="noopener noreferrer">View candidate website ↗</a>}
            </div>}
            {!hasDraft && (talent || value(candidate.data.fitRationale)) && <p className="text-sm text-[var(--app-hint)]">{value(candidate.data.fitRationale) || 'No assessment rationale available yet.'}</p>}
            {typeof candidate.data.bestFitScore === 'number' && <p className="text-sm">Preliminary score: {candidate.data.bestFitScore}/100</p>}
            {talent && <label className="block text-sm font-medium">Review for role<select value={selectedRole} onChange={(e) => { userEdited.current = true; const next = e.target.value; setRole(next); if (next !== shownSuggestion.current?.role) { setDecision(null); setReason('') } }} className={`${control} mt-2`}><option value="">Choose a role</option>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>}
            {hasDraft && <div className="space-y-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                <p className="text-xs text-[var(--app-hint)]">{[value(candidate.data.channel), value(candidate.data.email)].filter(Boolean).join(' · ') || 'Draft'}</p>
                {(shownSubject || value(candidate.data.channel).toLowerCase() === 'email') && <label className="block text-xs font-medium">Subject<input value={subject} onChange={(e) => { userEdited.current = true; setSubject(e.target.value) }} maxLength={300} className={`${control} mt-1 font-normal`} /></label>}
                <label className="block text-xs font-medium">Message<textarea value={draft} onChange={(e) => { userEdited.current = true; setDraft(e.target.value) }} maxLength={value(candidate.data.channel).toLowerCase() === 'linkedin' ? 300 : 8000} className={`${control} mt-1 min-h-40 font-normal`} /></label>
                {(draft.trim() !== shownDraft.trim() || subject.trim() !== shownSubject.trim()) && <p className="text-xs text-amber-700 dark:text-amber-300"><button type="button" className="underline" onClick={() => { setDraft(shownDraft); setSubject(shownSubject) }}>Undo edits</button></p>}
            </div>}
            {!hasDraft && <div><p className="text-sm font-medium">{talent ? 'Would you send a LinkedIn request?' : value(candidate.data.approvalQuestion) || 'Do you approve?'}</p><p className="mt-1 text-xs text-[var(--app-hint)]">{previous ? 'Your previous review is shown; you can change it.' : suggestion ? 'Suggested choice and reason are pre-filled. Change either before saving.' : 'Choose an answer, or swipe left for no or right for yes.'}</p><div className="mt-2 grid grid-cols-2 gap-3">{(['no', 'yes'] as const).map((v) => <button type="button" key={v} aria-pressed={decision === v} onClick={() => choose(v)} className={`rounded-xl border p-4 text-sm font-medium ${decision === v ? 'border-teal-600 bg-teal-500/15' : 'border-[var(--app-border)] bg-[var(--app-bg)]'}`}>{v === 'yes' ? 'Yes' : 'No'}</button>)}</div></div>}
            {!hasDraft && <label className="block text-sm font-medium">Why?<textarea value={reason} onChange={(e) => { userEdited.current = true; setReason(e.target.value) }} maxLength={4000} className={`${control} mt-2 min-h-24 font-normal`} placeholder="What influenced your decision?" /></label>}
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="flex items-center justify-end gap-3">{!hasDraft && <button type="button" onClick={() => { setSkipped((keys) => [...keys, candidate.key]); reset() }} className="mr-auto text-sm underline">Skip for now</button>}<button type="button" disabled={saving || (hasDraft ? !draft.trim() : (talent && !selectedRole) || !decision || !reason.trim())} onClick={() => void save(hasDraft ? 'yes' : decision)} className="rounded-xl bg-teal-700 px-4 py-3 text-sm font-medium text-white disabled:opacity-50">{saving ? 'Saving…' : hasDraft ? 'Approve to send' : 'Save and next'}</button></div>
        </div>}
    </section>
}
