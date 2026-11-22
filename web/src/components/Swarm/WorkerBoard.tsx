import { useMemo, useState } from 'react'
import type { WorkerRecord } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'
import { boardCell, boardColumns, filterRecords, sortRecords, toCsv, type BoardSort } from './board'
import { workerName } from './worker'
import { TalentReview } from './TalentReview'
import { ApprovalAgreement } from './ApprovalAgreement'
import { CategoryHitRates } from './CategoryHitRates'
import { invalidReviewCards, UnfilledCardsNotice } from './UnfilledCardsNotice'
import { BoardGallery } from './BoardGallery'

function Cell(props: { value: unknown }) {
    const cell = boardCell(props.value)
    switch (cell.kind) {
        case 'empty':
            return <span className="text-[var(--app-hint)]">—</span>
        case 'flag':
            return cell.value
                ? <span className="font-medium text-emerald-600 dark:text-emerald-400">✓</span>
                : <span className="text-[var(--app-hint)]">—</span>
        case 'number':
            return <span className="tabular-nums">{cell.value.toLocaleString()}</span>
        case 'gallery':
            return <BoardGallery images={cell.images} />
        case 'link':
            return (
                <a href={cell.href} target="_blank" rel="noreferrer" className="break-all text-[var(--app-link)] hover:underline">
                    {cell.label}
                </a>
            )
        default:
            return <span className="line-clamp-3 whitespace-pre-wrap break-words" title={cell.value}>{cell.value}</span>
    }
}

function downloadCsv(name: string, csv: string): void {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${name}.csv`
    link.click()
    URL.revokeObjectURL(url)
}

/**
 * A worker's output as a table. The worker decides the fields; this view only
 * has to make any set of fields readable, searchable and sortable, so one
 * dashboard serves every kind of job.
 */
export function WorkerBoard(props: {
    session: SessionSummary
    records: readonly WorkerRecord[]
    reviewHistory?: readonly WorkerRecord[]
    isLoading: boolean
    error: string | null
    onRecord: (key: string, fields: Record<string, unknown>) => Promise<boolean>
}) {
    const { t } = useTranslation()
    const { session, records } = props
    const swarm = session.metadata?.swarm
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState<BoardSort | null>(null)
    const [reviewMode, setReviewMode] = useState(false)
    const talent = swarm?.board?.title === 'Talent intake'
    const itemApproval = swarm?.board?.columns ? Boolean(swarm.board.columns.includes('suggestedDecision') && swarm.board.columns.includes('suggestedReason')) : talent
    const invalidCards = useMemo(() => invalidReviewCards(records, swarm?.board), [records, swarm?.board])

    const columns = useMemo(() => boardColumns(records, swarm?.board?.columns).filter((column) => column.key !== 'linkedinReviews' && column.key !== 'approvalReviews'), [records, swarm?.board?.columns])
    const visible = useMemo(() => sortRecords(filterRecords(records, query), sort), [records, query, sort])
    const name = workerName(session)
    const updatedAt = records.reduce((latest, record) => Math.max(latest, record.updatedAt), 0)
    const updated = updatedAt ? formatRelativeTime(updatedAt, t) : null

    const toggleSort = (key: string) => {
        setSort((current) => {
            if (current?.key !== key) return { key, descending: false }
            return current.descending ? null : { key, descending: true }
        })
    }

    return (
        <div className="mx-auto w-full max-w-[1400px] px-3 py-4 sm:px-4 sm:py-5">
            <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-[var(--app-fg)]">
                        {swarm?.board?.title ?? t('swarm.board.title', { name })}
                    </div>
                    <div className="truncate text-xs text-[var(--app-hint)]">
                        {t('swarm.board.count', { n: records.length })}
                        {updated ? ` · ${t('swarm.board.updated', { time: updated })}` : ''}
                    </div>
                </div>
                {itemApproval && records.length > 0 && <button type="button" disabled={invalidCards.length > 0} title={invalidCards.length > 0 ? t('swarm.unfilled.title', { n: invalidCards.length }) : undefined} onClick={() => setReviewMode((value) => !value)} className="rounded-full border border-[var(--app-border)] px-4 py-2 text-xs font-medium hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40">{reviewMode ? 'Show table' : talent ? 'Review candidates' : 'Review suggestions'}</button>}
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('swarm.board.search')}
                    aria-label={t('swarm.board.search')}
                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] sm:w-64"
                />
                <button
                    type="button"
                    disabled={records.length === 0}
                    onClick={() => downloadCsv(name, toCsv(visible, columns))}
                    className="rounded-full border border-[var(--app-border)] px-4 py-2 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-40"
                >
                    {t('swarm.board.export')}
                </button>
            </div>

            {props.error ? (
                <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">{props.error}</div>
            ) : null}

            {records.length === 0 && !props.error ? (
                <div className="mt-4 rounded-2xl border border-dashed border-[var(--app-border)] px-5 py-10 text-center">
                    <p className="text-sm font-medium text-[var(--app-fg)]">
                        {props.isLoading ? t('swarm.board.loading') : t('swarm.board.empty.title')}
                    </p>
                    {props.isLoading ? null : (
                        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--app-hint)]">{t('swarm.board.empty.body', { name })}</p>
                    )}
                </div>
            ) : null}

            {/* One unfilled card invalidates the review: it stays closed until every card is prefilled. */}
            <UnfilledCardsNotice cards={invalidCards} />
            {itemApproval && <CategoryHitRates records={props.reviewHistory ?? records} talent={talent} />}
            {itemApproval && <ApprovalAgreement records={props.reviewHistory ?? records} roleRecords={records} talent={talent} />}
            {reviewMode && invalidCards.length === 0 && <TalentReview records={visible} talent={talent} onRecord={props.onRecord} onClose={() => setReviewMode(false)} />}
            {records.length > 0 && !(reviewMode && invalidCards.length === 0) ? (
                <div className="mt-4 overflow-x-auto rounded-2xl border border-[var(--app-border)]">
                    <table className="w-full min-w-max border-collapse text-left text-sm">
                        <thead className="bg-[var(--app-subtle-bg)] text-xs text-[var(--app-hint)]">
                            <tr>
                                {columns.map((column) => {
                                    const active = sort?.key === column.key
                                    return (
                                        <th
                                            key={column.key}
                                            scope="col"
                                            aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                                            className={`whitespace-nowrap px-3 py-2 font-medium ${column.numeric ? 'text-right' : ''}`}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => toggleSort(column.key)}
                                                className={`inline-flex items-center gap-1 hover:text-[var(--app-fg)] ${active ? 'text-[var(--app-fg)]' : ''}`}
                                            >
                                                {column.label}
                                                <span aria-hidden="true" className="w-2 text-[10px]">{active ? (sort.descending ? '▼' : '▲') : ''}</span>
                                            </button>
                                        </th>
                                    )
                                })}
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((record) => (
                                <tr key={record.key} className="border-t border-[var(--app-border)] align-top text-[var(--app-fg)]">
                                    {columns.map((column, index) => (
                                        <td
                                            key={column.key}
                                            className={`max-w-[22rem] px-3 py-2.5 ${column.numeric ? 'text-right' : ''} ${index === 0 ? 'font-medium' : ''}`}
                                        >
                                            <Cell value={record.data[column.key]} />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {visible.length === 0 ? (
                        <p className="border-t border-[var(--app-border)] px-3 py-6 text-center text-sm text-[var(--app-hint)]">
                            {t('swarm.board.noMatch', { query })}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}
