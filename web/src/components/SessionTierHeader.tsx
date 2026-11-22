import { cn } from '@/lib/utils'
import { SwarmRailIcon } from '@/components/AppRail'
import { useTranslation } from '@/lib/use-translation'

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(props.className, 'transition-transform duration-200', props.collapsed ? '' : 'rotate-90')}
            aria-hidden="true"
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function SessionsTierIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    )
}

/**
 * Top level of the session list: the swarm's standing workers, kept apart from
 * the sessions you drive yourself. Rendered only when both kinds exist — one
 * lone header over the whole list would be a level of nesting that says nothing.
 */
export function SessionTierHeader(props: {
    tier: 'swarm' | 'plain'
    sessionCount: number
    collapsed: boolean
    onToggle: () => void
}) {
    const { t } = useTranslation()
    const isSwarm = props.tier === 'swarm'

    return (
        <button
            type="button"
            onClick={props.onToggle}
            aria-expanded={!props.collapsed}
            className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1.5 text-left select-none',
                'transition-colors hover:bg-[var(--app-subtle-bg)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
            )}
        >
            <ChevronIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" collapsed={props.collapsed} />
            {isSwarm
                ? <SwarmRailIcon className="h-4 w-4 shrink-0 text-[var(--app-link)]" />
                : <SessionsTierIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />}
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {t(isSwarm ? 'sessions.tier.swarm' : 'sessions.tier.plain')}
            </span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                ({props.sessionCount})
            </span>
        </button>
    )
}
