import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import charactersUrl from '@/assets/office/characters.png'
import { CHARACTER_SHEET, characterParts } from './character'
import { hashSeed } from './worker'

/**
 * A worker's portrait: the same pixel character that walks around the office,
 * on a tile whose colour also comes from the seed. Nothing is stored or
 * uploaded; the same seed renders the same person on every device.
 */
export function WorkerAvatar(props: {
    seed: string
    /** Rendered box, in px. */
    size?: number
    /** The agent behind the worker: it decides the kind of character, and is shown as a corner badge. */
    flavor?: string | null
    /** Set false where the badge would crowd the picture. Small avatars drop it on their own. */
    badge?: boolean
    className?: string
}) {
    const size = props.size ?? 40
    const hue = hashSeed(props.seed) % 360
    const badge = Math.max(14, Math.round(size * 0.4))
    // A whole number of screen pixels per art pixel keeps the figure crisp; the tile takes up the slack.
    const figure = Math.floor(size / CHARACTER_SHEET.tile) * CHARACTER_SHEET.tile || size
    const scale = figure / CHARACTER_SHEET.tile
    // Stacked backgrounds, top layer first: hair, shirt, trousers, body.
    const layers = [...characterParts(props.seed, props.flavor)].reverse()
    const showBadge = Boolean(props.flavor) && (props.badge ?? size >= 40)

    return (
        <span
            className={`relative inline-flex shrink-0 ${props.className ?? ''}`}
            style={{ width: size, height: size }}
            aria-hidden="true"
        >
            <span
                className="flex h-full w-full items-end justify-center overflow-hidden"
                style={{ borderRadius: size * 0.3, background: `hsl(${hue} 60% 82%)` }}
            >
                <span
                    style={{
                        width: figure,
                        height: figure,
                        imageRendering: 'pixelated',
                        backgroundImage: layers.map(() => `url(${charactersUrl})`).join(', '),
                        backgroundRepeat: 'no-repeat',
                        backgroundSize: `${CHARACTER_SHEET.width * scale}px ${CHARACTER_SHEET.height * scale}px`,
                        backgroundPosition: layers.map(([col, row]) => `${-col * CHARACTER_SHEET.pitch * scale}px ${-row * CHARACTER_SHEET.pitch * scale}px`).join(', ')
                    }}
                />
            </span>
            {showBadge ? (
                <span
                    className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-[var(--app-bg)] ring-1 ring-[var(--app-border)]"
                    style={{ width: badge, height: badge }}
                >
                    <AgentFlavorIcon flavor={props.flavor} className="h-[62%] w-[62%]" />
                </span>
            ) : null}
        </span>
    )
}
