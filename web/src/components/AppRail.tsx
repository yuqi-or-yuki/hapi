import { useId, type ReactNode } from 'react'
import { HoverTooltip } from '@/components/HoverTooltip'
import { useTranslation } from '@/lib/use-translation'

type IconProps = { className?: string }

function stroke(props: IconProps, children: ReactNode) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            {children}
        </svg>
    )
}

export function SessionsRailIcon(props: IconProps) {
    return stroke(props, (
        <>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </>
    ))
}

/**
 * Swarm mark: one lead node with workers orbiting it. Deliberately not a bee
 * or a robot — the rail reads at 20px, where silhouettes beat illustration.
 */
export function SwarmRailIcon(props: IconProps) {
    return stroke(props, (
        <>
            <circle cx="12" cy="12" r="2.5" />
            <circle cx="5" cy="6" r="2" />
            <circle cx="19" cy="6" r="2" />
            <circle cx="5" cy="18" r="2" />
            <circle cx="19" cy="18" r="2" />
            <path d="m6.6 7.4 3.2 3.2M17.4 7.4l-3.2 3.2M6.6 16.6l3.2-3.2M17.4 16.6l-3.2-3.2" />
        </>
    ))
}

/** Skills mark: a book/manual the agent can open. */
export function SkillsRailIcon(props: IconProps) {
    return stroke(props, (
        <>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <path d="M9 7h7M9 11h5" />
        </>
    ))
}

export function BrowseRailIcon(props: IconProps) {
    return stroke(props, <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />)
}

export function SettingsRailIcon(props: IconProps) {
    return stroke(props, (
        <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>
    ))
}

export function SidebarFoldIcon(props: IconProps & { folded?: boolean }) {
    return stroke(props, (
        <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
            {props.folded ? <path d="m13 10 2 2-2 2" /> : <path d="m17 10-2 2 2 2" />}
        </>
    ))
}

type RailItem = {
    key: string
    label: string
    icon: ReactNode
    active: boolean
    badge?: number
    onClick: () => void
}

function RailTooltip(props: { label: string; hint?: string; children: ReactNode }) {
    const id = useId()
    return (
        <HoverTooltip
            id={id}
            side="right"
            revealOnFocusWithin
            tooltipClassName="whitespace-nowrap"
            target={props.children}
        >
            <span className="font-medium">{props.label}</span>
            {props.hint ? <span className="ml-1.5 text-[var(--app-hint)]">{props.hint}</span> : null}
        </HoverTooltip>
    )
}

function RailButton(props: { item: RailItem }) {
    const { item } = props
    return (
        <RailTooltip label={item.label}>
            <button
                type="button"
                onClick={item.onClick}
                aria-label={item.label}
                aria-current={item.active ? 'page' : undefined}
                className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                    item.active
                        ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
                        : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                }`}
            >
                {item.icon}
                {item.badge && item.badge > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-[var(--app-link)] px-1 text-[10px] font-semibold leading-4 text-white">
                        {item.badge > 99 ? '99+' : item.badge}
                    </span>
                ) : null}
            </button>
        </RailTooltip>
    )
}

/**
 * Fixed icon rail at the left edge: the app's top-level places, plus the
 * control that folds the session sidebar away.
 *
 * Shown only on the split layout. Below it every destination is already a
 * full-width page reachable from the sessions header's overflow menu, and a
 * permanent rail would eat scarce phone width.
 */
export function AppRail(props: {
    active: 'sessions' | 'swarm' | 'skills' | 'browse' | 'settings' | null
    workerCount?: number
    canBrowse?: boolean
    sidebarFolded: boolean
    onToggleSidebar: () => void
    onNavigate: (to: 'sessions' | 'swarm' | 'skills' | 'browse' | 'settings') => void
}) {
    const { t } = useTranslation()
    // Mac reports "MacIntel"/"Mac" here; everywhere else Ctrl is the modifier.
    const shortcutHint = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '')
        ? '⌘B'
        : 'Ctrl+B'

    const items: RailItem[] = [
        {
            key: 'sessions',
            label: t('rail.sessions'),
            icon: <SessionsRailIcon className="h-5 w-5" />,
            active: props.active === 'sessions',
            onClick: () => props.onNavigate('sessions')
        },
        {
            key: 'swarm',
            label: t('rail.swarm'),
            icon: <SwarmRailIcon className="h-5 w-5" />,
            active: props.active === 'swarm',
            badge: props.workerCount,
            onClick: () => props.onNavigate('swarm')
        },
        {
            key: 'skills',
            label: t('rail.skills'),
            icon: <SkillsRailIcon className="h-5 w-5" />,
            active: props.active === 'skills',
            onClick: () => props.onNavigate('skills')
        }
    ]

    if (props.canBrowse) {
        items.push({
            key: 'browse',
            label: t('browse.nav'),
            icon: <BrowseRailIcon className="h-5 w-5" />,
            active: props.active === 'browse',
            onClick: () => props.onNavigate('browse')
        })
    }

    return (
        <nav
            aria-label={t('rail.label')}
            className="hidden split:flex w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--app-border)] bg-[var(--app-bg)] px-2 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]"
        >
            <RailTooltip
                label={props.sidebarFolded ? t('rail.unfold') : t('rail.fold')}
                hint={shortcutHint}
            >
                <button
                    type="button"
                    onClick={props.onToggleSidebar}
                    aria-label={props.sidebarFolded ? t('rail.unfold') : t('rail.fold')}
                    aria-expanded={!props.sidebarFolded}
                    className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                >
                    <SidebarFoldIcon className="h-5 w-5" folded={props.sidebarFolded} />
                </button>
            </RailTooltip>

            <div className="my-1 h-px w-6 shrink-0 bg-[var(--app-border)]" />

            {items.map((item) => <RailButton key={item.key} item={item} />)}

            <div className="flex-1" />

            <RailButton
                item={{
                    key: 'settings',
                    label: t('settings.title'),
                    icon: <SettingsRailIcon className="h-5 w-5" />,
                    active: props.active === 'settings',
                    onClick: () => props.onNavigate('settings')
                }}
            />
        </nav>
    )
}
