import { useState } from 'react'
import type { ChatBlock } from '@/chat/types'

// Zeroshot runs a pipeline of specialized agents; each AGENT_LIFECYCLE event
// carries a `role` that maps onto one of three user-facing stages. (The badge
// mapping in the CLI is coarser; this is the authoritative role→stage map for
// the read-the-flow view.)
export type ZeroshotStageKey = 'plan' | 'implement' | 'verify'

function roleToStage(role: string | undefined): ZeroshotStageKey {
    if (role === 'conductor') return 'plan'
    if (role === 'validator' || role === 'orchestrator') return 'verify'
    // 'implementation' (the worker/executor) and anything unrecognized.
    return 'implement'
}

export type ZeroshotAgentEvent = {
    id: string
    role?: string
    agent?: string
    model?: string
    event?: string
    iteration?: number
    createdAt: number
}

export type ZeroshotVerdict = {
    id: string
    approved: boolean
    errorCount: number
    summary?: string
    createdAt: number
}

export type ZeroshotStageData = {
    key: ZeroshotStageKey
    events: ZeroshotAgentEvent[]
    verdicts: ZeroshotVerdict[]
}

export type ZeroshotTimelineData = {
    stages: Record<ZeroshotStageKey, ZeroshotStageData>
    order: ZeroshotStageKey[]
    totalEvents: number
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function asStr(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}
function asNum(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Pure: fold a Zeroshot session's chat blocks into three stage buckets
 * (plan / implement / verify) so the lifecycle reads as a pipeline instead of
 * a flat card stream. Reads only `ZeroshotAgent` / `ZeroshotVerdict` tool-call
 * blocks; everything else is ignored (narration/verdict summaries render in the
 * thread below).
 */
export function buildZeroshotTimeline(blocks: ChatBlock[]): ZeroshotTimelineData {
    const stages: Record<ZeroshotStageKey, ZeroshotStageData> = {
        plan: { key: 'plan', events: [], verdicts: [] },
        implement: { key: 'implement', events: [], verdicts: [] },
        verify: { key: 'verify', events: [], verdicts: [] }
    }

    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        const name = block.tool.name
        if (name === 'ZeroshotAgent') {
            const input = asRecord(block.tool.input)
            const role = asStr(input.role)
            stages[roleToStage(role)].events.push({
                id: block.id,
                role,
                agent: asStr(input.agent),
                model: asStr(input.model),
                event: asStr(input.event),
                iteration: asNum(input.iteration),
                createdAt: block.createdAt
            })
        } else if (name === 'ZeroshotVerdict') {
            const input = asRecord(block.tool.input)
            const errors = input.errors
            stages.verify.verdicts.push({
                id: block.id,
                approved: input.approved === true,
                errorCount: Array.isArray(errors) ? errors.length : 0,
                summary: asStr(input.summary),
                createdAt: block.createdAt
            })
        }
    }

    const totalEvents = stages.plan.events.length + stages.implement.events.length + stages.verify.events.length
        + stages.verify.verdicts.length
    return { stages, order: ['plan', 'implement', 'verify'], totalEvents }
}

// ── presentation ────────────────────────────────────────────────────────────

const STAGE_META: Record<ZeroshotStageKey, { icon: string; label: string; blurb: string; accent: string }> = {
    plan: { icon: '🗺', label: 'Plan', blurb: 'Classify the task & choose a workflow', accent: 'text-amber-500' },
    implement: { icon: '🔨', label: 'Implement', blurb: 'An executor agent writes the change', accent: 'text-blue-500' },
    verify: { icon: '🔍', label: 'Verify', blurb: 'An independent verifier checks it', accent: 'text-purple-500' }
}

const STAGE_INDEX: Record<string, number> = { plan: 0, implement: 1, verify: 2, done: 3, failed: 3 }

type StageStatus = 'pending' | 'running' | 'done' | 'failed'

function computeStageStatus(key: ZeroshotStageKey, overallStage: string | undefined, hasEvents: boolean): StageStatus {
    const overallIdx = overallStage !== undefined ? (STAGE_INDEX[overallStage] ?? -1) : -1
    const stageIdx = STAGE_INDEX[key]
    if (overallIdx < 0) {
        // No overall signal yet — infer from events alone.
        return hasEvents ? 'running' : 'pending'
    }
    if (overallStage === 'failed' && overallIdx === stageIdx) return 'failed'
    if (overallIdx > stageIdx) return 'done'
    if (overallIdx === stageIdx) return overallStage === 'done' ? 'done' : 'running'
    return 'pending'
}

function DetailsChevron({ open }: { open: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`shrink-0 text-[var(--app-hint)] transition-transform ${open ? 'rotate-90' : ''}`}
        >
            <path d="m9 18 6-6-6-6" />
        </svg>
    )
}

function StatusPill({ status, verdict }: { status: StageStatus; verdict?: ZeroshotVerdict }) {
    if (verdict) {
        return verdict.approved
            ? <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]">✓ approved</span>
            : <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-500/10 text-red-500">✗ rejected{verdict.errorCount ? ` · ${verdict.errorCount}` : ''}</span>
    }
    const map: Record<StageStatus, { label: string; cls: string }> = {
        pending: { label: 'pending', cls: 'bg-[var(--app-secondary-bg)] text-[var(--app-hint)]' },
        running: { label: 'running', cls: 'bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]' },
        done: { label: 'done', cls: 'bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]' },
        failed: { label: 'failed', cls: 'bg-red-500/10 text-red-500' }
    }
    const m = map[status]
    return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${m.cls}`}>{m.label}</span>
}

function humanizeEvent(event: string | undefined): string {
    if (!event) return 'event'
    return event.split('_').map((p) => p.charAt(0) + p.slice(1).toLowerCase()).join(' ')
}

function StageSection({ stage, status, defaultOpen }: {
    stage: ZeroshotStageData
    status: StageStatus
    defaultOpen: boolean
}) {
    const [open, setOpen] = useState(defaultOpen)
    const meta = STAGE_META[stage.key]
    const verdict = stage.verdicts[stage.verdicts.length - 1]
    const lastEvent = stage.events[stage.events.length - 1]

    // One-line summary of who ran this stage.
    const agents = Array.from(new Set(stage.events.map((e) => e.agent).filter(Boolean))) as string[]
    const models = Array.from(new Set(stage.events.map((e) => e.model).filter(Boolean))) as string[]
    const summary = agents.length
        ? `${agents.join(', ')}${models.length ? ` · ${models.join('/')}` : ''}`
        : status === 'pending' ? meta.blurb : '—'

    return (
        <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
            >
                <span aria-hidden className="text-sm">{meta.icon}</span>
                <span className={`text-sm font-semibold ${status === 'pending' ? 'text-[var(--app-hint)]' : 'text-[var(--app-fg)]'}`}>
                    {meta.label}
                </span>
                <StatusPill status={status} verdict={verdict} />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">{summary}</span>
                {stage.events.length > 0 ? <DetailsChevron open={open} /> : null}
            </button>

            {open && stage.events.length > 0 ? (
                <div className="border-t border-[var(--app-border)] px-2.5 py-1.5">
                    <ul className="space-y-0.5">
                        {stage.events.map((e) => (
                            <li key={e.id} className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                                <span className="text-[var(--app-fg)]/70">{humanizeEvent(e.event)}</span>
                                {e.agent ? <span className="text-[var(--app-hint)]">· {e.agent}</span> : null}
                                {e.iteration ? <span className="text-[var(--app-hint)]">· iter {e.iteration}</span> : null}
                            </li>
                        ))}
                    </ul>
                    {verdict?.summary ? (
                        <div className="mt-1.5 rounded bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-fg)]/80">
                            {verdict.summary}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

export function ZeroshotTimeline({ timeline, overallStage }: {
    timeline: ZeroshotTimelineData
    overallStage: string | undefined
}) {
    if (timeline.totalEvents === 0) {
        return null
    }

    return (
        <div className="mx-auto w-full max-w-content px-3 pt-3">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40 p-2.5">
                <div className="mb-2 flex items-center gap-1.5 px-0.5">
                    <span className="text-xs font-semibold text-[var(--app-fg)]">Zeroshot run</span>
                    <span className="text-[10px] text-[var(--app-hint)]">executor → verifier pipeline</span>
                </div>
                <div className="space-y-1.5">
                    {timeline.order.map((key, i) => {
                        const stage = timeline.stages[key]
                        const status = computeStageStatus(key, overallStage, stage.events.length > 0)
                        return (
                            <div key={key}>
                                <StageSection
                                    stage={stage}
                                    status={status}
                                    defaultOpen={status === 'running' || status === 'failed'}
                                />
                                {i < timeline.order.length - 1 ? (
                                    <div aria-hidden className="flex justify-center py-0.5 text-[var(--app-hint)]">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>
                                    </div>
                                ) : null}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
