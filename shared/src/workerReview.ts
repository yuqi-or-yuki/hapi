/**
 * The rules for item-approval boards, shared by the hub (which enforces them
 * on write) and the web (which refuses to open a review that breaks them), so
 * the two can never disagree about what a valid review card is.
 */
export type BoardConfig = { title?: string; columns?: readonly string[] } | undefined

type Row = Record<string, unknown>

export function isTalentBoard(board: BoardConfig): boolean {
    return board?.title === 'Talent intake'
}

/** A board whose rows are reviewed one by one, each with the worker's suggested decision. */
export function isItemApprovalBoard(board: BoardConfig): boolean {
    return board?.columns
        ? board.columns.includes('suggestedDecision') && board.columns.includes('suggestedReason')
        : isTalentBoard(board)
}

function filled(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function hasEvents(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0
}

/** A row the user has already reviewed is settled; only cards still awaiting review must be prefilled. */
export function hasSavedReview(row: Row): boolean {
    return hasEvents(row.linkedinReviews) || hasEvents(row.approvalReviews)
}

/**
 * What a card awaiting review is missing. An empty list means the card is
 * valid: it has someone to show, a suggested decision, and the reason for it.
 * A talent card also needs the role the suggestion is for, because a decision
 * is only meaningful, and only measurable, against a role.
 */
export function missingCardFields(row: Row, talent: boolean): string[] {
    const missing: string[] = []
    if (!filled(row.name) && !filled(row.title)) missing.push('name')
    if (row.suggestedDecision !== 'yes' && row.suggestedDecision !== 'no') missing.push('suggestedDecision')
    if (!filled(row.suggestedReason)) missing.push('suggestedReason')
    if (talent && !filled(row.bestFitRole)) missing.push('bestFitRole')
    return missing
}

/** Cards awaiting review that are not prefilled, with what each lacks. */
export function unfilledCards(rows: readonly { key: string; data: Row }[], board: BoardConfig): { key: string; missing: string[] }[] {
    if (!isItemApprovalBoard(board)) return []
    const talent = isTalentBoard(board)
    return rows
        .filter((row) => !hasSavedReview(row.data))
        .map((row) => ({ key: row.key, missing: missingCardFields(row.data, talent) }))
        .filter((card) => card.missing.length > 0)
}

/**
 * The operator's standing decision on a row: their latest saved review, or
 * null when nobody has reviewed it. A pipeline hands a row on only when this
 * is "yes" (see hub workerPipelines).
 */
export function finalDecision(row: Row): 'yes' | 'no' | null {
    const events = [row.approvalReviews, row.linkedinReviews]
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter((event): event is { decision: unknown; at?: unknown } => !!event && typeof event === 'object')
    if (events.length === 0) return null
    const latest = events.reduce((a, b) => (String(b.at ?? '') >= String(a.at ?? '') ? b : a))
    return latest.decision === 'yes' ? 'yes' : latest.decision === 'no' ? 'no' : null
}

export const UNCATEGORIZED = 'Uncategorized'

/**
 * The category a review counts under when measuring how often the worker's
 * suggestions hit: the role for talent, the row's `category` elsewhere.
 * Suggestions are only comparable within a category, so the hit rate is
 * always reported per category, never blended.
 */
export function reviewCategory(event: Row): string {
    if (filled(event.role)) return event.role.trim()
    if (filled(event.category)) return event.category.trim()
    return UNCATEGORIZED
}
