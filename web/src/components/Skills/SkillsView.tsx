import { useMemo, useState } from 'react'
import type { Machine, SessionSummary } from '@/types/api'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { SKILL_FLAVORS, type SkillFlavor, type UnifiedSkill } from '@/hooks/queries/useMachineSkills'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'

/** What you type to run a skill in any agent. */
export function skillInvocation(name: string): string {
    return `/${name}`
}

/** Case-insensitive match over a skill's name and description. */
export function filterSkills(skills: readonly UnifiedSkill[], query: string): UnifiedSkill[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return [...skills]
    return skills.filter((skill) =>
        skill.name.toLowerCase().includes(needle)
        || (skill.description ?? '').toLowerCase().includes(needle))
}

/**
 * A skill every agent on the machine can see. These live in a shared root
 * (`~/.agents/skills`); anything narrower is a copy one harness owns.
 */
export function isSharedSkill(skill: UnifiedSkill, knownFlavors: readonly SkillFlavor[]): boolean {
    return knownFlavors.length > 1 && knownFlavors.every((flavor) => skill.flavors.includes(flavor))
}

function SkillCard(props: {
    skill: UnifiedSkill
    knownFlavors: readonly SkillFlavor[]
    onCopy: (skill: UnifiedSkill) => void
    onUse: (skill: UnifiedSkill) => void
    canUse: boolean
}) {
    const { t } = useTranslation()
    const shared = isSharedSkill(props.skill, props.knownFlavors)

    return (
        <div className="flex min-w-0 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2.5">
            <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-[var(--app-fg)]" title={props.skill.name}>
                    {props.skill.name}
                </p>
                {shared ? (
                    <span
                        className="shrink-0 rounded-full border border-emerald-500/40 px-1.5 text-[10px] font-medium leading-4 text-emerald-600 dark:text-emerald-400"
                        title={t('skills.shared.hint')}
                    >
                        {t('skills.shared')}
                    </span>
                ) : (
                    <span className="flex shrink-0 items-center gap-0.5" title={props.skill.flavors.join(', ')}>
                        {props.skill.flavors.map((flavor) => (
                            <AgentFlavorIcon key={flavor} flavor={flavor} className="h-3.5 w-3.5" />
                        ))}
                    </span>
                )}
            </div>

            {props.skill.description ? (
                <p className="mt-1 line-clamp-3 flex-1 text-xs leading-snug text-[var(--app-hint)]">
                    {props.skill.description}
                </p>
            ) : null}

            <div className="mt-2.5 flex items-center gap-1.5">
                {props.canUse ? (
                    <button
                        type="button"
                        onClick={() => props.onUse(props.skill)}
                        className="min-h-8 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-[11px] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('skills.use')}
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={() => props.onCopy(props.skill)}
                    className="min-h-8 rounded-full px-2.5 font-mono text-[11px] text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                    title={t('skills.copy')}
                >
                    {skillInvocation(props.skill.name)}
                </button>
            </div>
        </div>
    )
}

export function SkillsView(props: {
    machines: Machine[]
    machineLabelsById: Record<string, string>
    machineId: string | null
    onMachineChange: (machineId: string) => void
    skills: UnifiedSkill[]
    isLoading: boolean
    failedFlavors: SkillFlavor[]
    error: string | null
    onRetry: () => void
    sessions: SessionSummary[]
    onCopy: (skill: UnifiedSkill) => void
    onUse: (skill: UnifiedSkill, sessionId: string) => void
}) {
    const { t } = useTranslation()
    const [query, setQuery] = useState('')
    const [agentFilter, setAgentFilter] = useState<SkillFlavor | 'all'>('all')
    const [pendingSkill, setPendingSkill] = useState<UnifiedSkill | null>(null)

    const knownFlavors = useMemo(
        () => SKILL_FLAVORS.filter((flavor) => !props.failedFlavors.includes(flavor)),
        [props.failedFlavors]
    )
    const visible = useMemo(() => {
        const byAgent = agentFilter === 'all'
            ? props.skills
            : props.skills.filter((skill) => skill.flavors.includes(agentFilter))
        return filterSkills(byAgent, query)
    }, [props.skills, agentFilter, query])

    // Sessions the skill can be dropped into: the ones on this machine, most
    // recent first, so the picker leads with where you were just working.
    const targets = useMemo(
        () => props.sessions
            .filter((session) => !props.machineId || session.metadata?.machineId === props.machineId)
            .sort((a, b) => (Number(b.active) - Number(a.active)) || (b.updatedAt - a.updatedAt))
            .slice(0, 12),
        [props.sessions, props.machineId]
    )

    return (
        <div className="mx-auto w-full max-w-content px-3 py-4 sm:px-4 sm:py-5">
            <div className="flex flex-wrap items-center gap-2">
                {props.machines.length > 1 ? (
                    <select
                        value={props.machineId ?? ''}
                        onChange={(event) => props.onMachineChange(event.target.value)}
                        aria-label={t('skills.machine')}
                        className="min-h-9 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)]"
                    >
                        {props.machines.map((machine) => (
                            <option key={machine.id} value={machine.id}>
                                {props.machineLabelsById[machine.id] ?? machine.id}
                            </option>
                        ))}
                    </select>
                ) : null}

                <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={t('skills.agent')}>
                    {(['all', ...knownFlavors] as const).map((flavor) => (
                        <button
                            key={flavor}
                            type="button"
                            role="tab"
                            aria-selected={agentFilter === flavor}
                            onClick={() => setAgentFilter(flavor)}
                            className={`flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
                                agentFilter === flavor
                                    ? 'border-[var(--app-link)] text-[var(--app-link)]'
                                    : 'border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                            }`}
                        >
                            {flavor === 'all' ? null : <AgentFlavorIcon flavor={flavor} className="h-3.5 w-3.5" />}
                            {flavor === 'all' ? t('skills.filter.all') : flavor}
                        </button>
                    ))}
                </div>

                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('skills.search')}
                    aria-label={t('skills.search')}
                    className="min-h-9 w-full min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] sm:w-auto"
                />
            </div>

            <p className="mt-3 flex items-center gap-2 text-xs text-[var(--app-hint)]">
                {props.isLoading
                    ? t('skills.loading')
                    : t('skills.count', { n: visible.length, total: props.skills.length })}
                {/* Each listing is an RPC per agent that walks directories on the
                    machine, so the catalog is cached for the session rather than
                    refetched. A skill added since then needs this button. */}
                <button
                    type="button"
                    onClick={props.onRetry}
                    disabled={props.isLoading}
                    className="rounded-full px-2 py-0.5 text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                >
                    {t('skills.refresh')}
                </button>
                {!props.isLoading && props.failedFlavors.length > 0 && !props.error
                    ? ` · ${t('skills.partial', { agents: props.failedFlavors.join(', ') })}`
                    : ''}
            </p>

            {props.error ? (
                <div className="mt-4 rounded-xl border border-[var(--app-border)] px-4 py-6 text-center">
                    <p className="text-sm text-[var(--app-fg)]">{props.error}</p>
                    <button
                        type="button"
                        onClick={props.onRetry}
                        className="mt-3 min-h-9 rounded-full border border-[var(--app-border)] px-4 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('skills.retry')}
                    </button>
                </div>
            ) : null}

            {!props.error && !props.isLoading && props.skills.length === 0 ? (
                <div className="mt-4 rounded-xl border border-dashed border-[var(--app-border)] px-4 py-10 text-center">
                    <p className="text-sm font-medium text-[var(--app-fg)]">{t('skills.empty.title')}</p>
                    <p className="mx-auto mt-2 max-w-md text-sm text-[var(--app-hint)]">{t('skills.empty.body')}</p>
                </div>
            ) : null}

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((skill) => (
                    <SkillCard
                        key={skill.name}
                        skill={skill}
                        knownFlavors={knownFlavors}
                        onCopy={props.onCopy}
                        onUse={setPendingSkill}
                        canUse={targets.length > 0}
                    />
                ))}
            </div>

            {pendingSkill ? (
                <div
                    className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-3 sm:items-center"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('skills.use.title', { name: pendingSkill.name })}
                    onClick={() => setPendingSkill(null)}
                >
                    <div
                        className="w-full max-w-sm rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-xl"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <p className="text-sm font-semibold text-[var(--app-fg)]">
                            {t('skills.use.title', { name: pendingSkill.name })}
                        </p>
                        <p className="mt-1 text-xs text-[var(--app-hint)]">{t('skills.use.body')}</p>
                        <div className="app-scroll-y mt-3 max-h-72 flex flex-col gap-1">
                            {targets.map((session) => (
                                <button
                                    key={session.id}
                                    type="button"
                                    onClick={() => {
                                        props.onUse(pendingSkill, session.id)
                                        setPendingSkill(null)
                                    }}
                                    className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                                >
                                    <AgentFlavorIcon flavor={session.metadata?.flavor} className="h-4 w-4 shrink-0" />
                                    <span className="min-w-0 flex-1 truncate">{getSessionTitle(session)}</span>
                                    {session.active ? (
                                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                                    ) : null}
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={() => setPendingSkill(null)}
                            className="mt-3 min-h-9 w-full rounded-full border border-[var(--app-border)] text-xs font-medium text-[var(--app-fg)]"
                        >
                            {t('button.cancel')}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    )
}
