import type { WorkerRecord } from '@/api/client'

type Event = { at?: unknown; decision?: unknown; reason?: unknown; predictedDecision?: unknown; predictedReason?: unknown; predictionRole?: unknown; role?: unknown; decisionUnchanged?: unknown; reasonUnchanged?: unknown; suggestionAccepted?: unknown; legacyTalent?: boolean }
export type Agreement = { eligible: number; unavailable: number; choiceMatches: number; reasonMatches: number; bothMatches: number; trend: { at: string; count: number; percent: number }[] }

/** Only saved snapshots can be compared: never reconstruct an old prediction from the current row. */
export function approvalAgreement(records: readonly WorkerRecord[], role?: string): Agreement {
    const events: Event[] = records.flatMap((record) => {
        const data = record.data
        const histories = [[data.linkedinReviews, true], [data.approvalReviews, false]] as const
        return histories.flatMap(([history, legacyTalent]) => Array.isArray(history) ? history.filter((item): item is Event => !!item && typeof item === 'object' && !Array.isArray(item)).map((item) => ({ ...item, legacyTalent })) : [])
    })
    const scoped = role === undefined ? events : events.filter((event) => event.role === role)
    const out: Agreement = { eligible: 0, unavailable: 0, choiceMatches: 0, reasonMatches: 0, bothMatches: 0, trend: [] }
    for (const event of scoped.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))) {
        // The original talent UI only set this flag true when both visible
        // suggestions were confirmed unchanged. False is ambiguous there.
        const legacyConfirmed = event.legacyTalent && event.suggestionAccepted === true && event.predictedDecision === undefined && event.predictedReason === undefined
        const snapshot = (event.predictedDecision === 'yes' || event.predictedDecision === 'no') && typeof event.predictedReason === 'string' && event.predictedReason.length > 0 && (event.predictionRole === undefined || event.predictionRole === event.role)
        const valid = (snapshot || legacyConfirmed) && (event.decision === 'yes' || event.decision === 'no') && typeof event.reason === 'string' && typeof event.at === 'string'
        if (!valid) { out.unavailable++; continue }
        // Explicit flags preserve exact user edits even when final saved text is trimmed.
        const choice = legacyConfirmed ? true : typeof event.decisionUnchanged === 'boolean' ? event.decisionUnchanged : event.decision === event.predictedDecision
        const reason = legacyConfirmed ? true : typeof event.reasonUnchanged === 'boolean' ? event.reasonUnchanged : event.reason === event.predictedReason
        out.eligible++
        if (choice) out.choiceMatches++
        if (reason) out.reasonMatches++
        if (choice && reason) out.bothMatches++
        out.trend.push({ at: event.at as string, count: out.eligible, percent: out.bothMatches * 100 / out.eligible })
    }
    return out
}
