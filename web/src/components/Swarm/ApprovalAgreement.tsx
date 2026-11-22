import { useMemo, useState } from 'react'
import type { WorkerRecord } from '@/api/client'
import { approvalAgreement } from './approvalMetrics'

export function ApprovalAgreement({ records, talent = false, roleRecords = records }: { records: readonly WorkerRecord[]; talent?: boolean; roleRecords?: readonly WorkerRecord[] }) {
    const [selectedRole, setSelectedRole] = useState('')
    const roles = useMemo(() => {
        const names = new Set<string>()
        for (const record of [...roleRecords, ...records]) {
            if (typeof record.data.bestFitRole === 'string' && record.data.bestFitRole.trim()) names.add(record.data.bestFitRole)
            if (Array.isArray(record.data.linkedinReviews)) for (const event of record.data.linkedinReviews) {
                if (event && typeof event === 'object' && typeof event.role === 'string' && event.role.trim()) names.add(event.role)
            }
        }
        return [...names].sort((a, b) => a.localeCompare(b))
    }, [records, roleRecords])
    if (talent && roles.length) {
        const role = roles.includes(selectedRole) ? selectedRole : roles[0]
        return <div><label className="mt-4 block text-xs text-[var(--app-hint)]">Prediction accuracy for role<select aria-label="Prediction accuracy for role" value={role} onChange={(event) => setSelectedRole(event.target.value)} className="ml-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm text-[var(--app-fg)]">{roles.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><AgreementCard records={records} role={role} /></div>
    }
    return <AgreementCard records={records} />
}

function AgreementCard({ records, role }: { records: readonly WorkerRecord[]; role?: string }) {
    const stats = useMemo(() => approvalAgreement(records, role), [records, role])
    const pct = (n: number) => stats.eligible ? `${Math.round(100 * n / stats.eligible)}%` : '—'
    const points = stats.trend.map((p, i) => `${stats.trend.length === 1 ? 50 : 8 + 84 * i / (stats.trend.length - 1)},${92 - p.percent * 0.84}`).join(' ')
    return <section className="mt-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 sm:p-5" aria-label={role ? `Prediction agreement: ${role}` : "Prediction agreement"}>
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold">{role ? `Prediction agreement · ${role}` : 'Prediction agreement'}</h2><span className="text-xs text-[var(--app-hint)]">{stats.eligible} comparable {stats.eligible === 1 ? 'review' : 'reviews'}</span></div>
        <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
            {[['Choice unchanged', stats.choiceMatches], ['Reason unchanged', stats.reasonMatches], ['Both unchanged', stats.bothMatches]].map(([label, n]) => <div key={label} className="min-w-0"><p className="text-xs text-[var(--app-hint)]">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{pct(n as number)}</p><p className="text-xs text-[var(--app-hint)]">{n} / {stats.eligible}</p></div>)}
        </div>
        {stats.eligible ? <div className="mt-4"><p className="text-xs font-medium">Both unchanged · cumulative over time</p><svg viewBox="0 0 100 100" preserveAspectRatio="none" className="mt-2 h-28 w-full" role="img" aria-label={`Cumulative agreement on choice and reason, ${pct(stats.bothMatches)} after ${stats.eligible} reviews`}><line x1="8" y1="8" x2="92" y2="8" stroke="currentColor" opacity=".12"/><line x1="8" y1="50" x2="92" y2="50" stroke="currentColor" opacity=".12"/><line x1="8" y1="92" x2="92" y2="92" stroke="currentColor" opacity=".12"/><polyline points={points} fill="none" stroke="#0d9488" strokeWidth="2" vectorEffect="non-scaling-stroke"/>{stats.trend.map((p, i) => <circle key={`${p.at}-${i}`} cx={stats.trend.length === 1 ? 50 : 8 + 84 * i / (stats.trend.length - 1)} cy={92 - p.percent * .84} r="1.5" fill="#0d9488"><title>{`${new Date(p.at).toLocaleString()}: ${Math.round(p.percent)}% after ${p.count} reviews`}</title></circle>)}</svg><div className="flex justify-between text-[10px] text-[var(--app-hint)]"><span>First comparable review</span><span>Latest</span></div></div> : <p className="mt-4 text-sm text-[var(--app-hint)]">No comparable reviews yet. The trend starts when a saved review includes its original suggestion.</p>}
        {stats.unavailable > 0 && <p className="mt-3 text-xs text-[var(--app-hint)]">{stats.unavailable} earlier {stats.unavailable === 1 ? 'review has' : 'reviews have'} no comparable prediction and {stats.unavailable === 1 ? 'is' : 'are'} excluded.</p>}
    </section>
}
