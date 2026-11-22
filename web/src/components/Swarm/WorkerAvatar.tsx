import { useId } from 'react'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { hashSeed } from './worker'

const INK = '#231f33'

function Eyes(props: { variant: number }) {
    switch (props.variant) {
        case 1:
            return (
                <>
                    <rect x="12.5" y="14" width="3" height="6" rx="1.5" fill={INK} />
                    <rect x="24.5" y="14" width="3" height="6" rx="1.5" fill={INK} />
                </>
            )
        case 2:
            return (
                <g fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round">
                    <path d="M11.5 18 Q14 14.5 16.5 18" />
                    <path d="M23.5 18 Q26 14.5 28.5 18" />
                </g>
            )
        case 3:
            return (
                <>
                    <circle cx="14" cy="17" r="2.2" fill={INK} />
                    <path d="M23.5 17.5 H28.5" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
                </>
            )
        default:
            return (
                <>
                    <circle cx="14" cy="17" r="2.2" fill={INK} />
                    <circle cx="26" cy="17" r="2.2" fill={INK} />
                </>
            )
    }
}

function Mouth(props: { variant: number }) {
    switch (props.variant) {
        case 1:
            return <path d="M15 24 Q20 31 25 24 Z" fill={INK} />
        case 2:
            return <path d="M16.5 26 H23.5" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
        case 3:
            return <circle cx="20" cy="26" r="2" fill={INK} />
        default:
            return <path d="M15 24.5 Q20 29 25 24.5" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
    }
}

/**
 * A worker's face, drawn from its seed. Nothing is stored or uploaded: the same
 * seed renders the same face on every device, and its colours carry their own
 * contrast so it reads on light and dark surfaces alike.
 */
export function WorkerAvatar(props: {
    seed: string
    /** Rendered box, in px. */
    size?: number
    /** Shows which agent runs the worker, as a corner badge. Omit at small sizes. */
    flavor?: string | null
    className?: string
}) {
    const clipId = useId()
    const size = props.size ?? 40
    const hash = hashSeed(props.seed)
    const hue = hash % 360
    const accentHue = (hue + 40 + ((hash >>> 9) % 60)) % 360
    const blobX = 6 + ((hash >>> 3) % 28)
    const blobY = 30 + ((hash >>> 6) % 12)
    const tilt = ((hash >>> 12) % 17) - 8
    const shiftX = ((hash >>> 16) % 5) - 2
    const shiftY = ((hash >>> 19) % 3) - 1
    const badge = Math.max(14, Math.round(size * 0.4))

    return (
        <span
            className={`relative inline-flex shrink-0 ${props.className ?? ''}`}
            style={{ width: size, height: size }}
            aria-hidden="true"
        >
            <svg viewBox="0 0 40 40" width={size} height={size}>
                <clipPath id={clipId}>
                    <rect width="40" height="40" rx="13" />
                </clipPath>
                <g clipPath={`url(#${clipId})`}>
                    <rect width="40" height="40" fill={`hsl(${hue} 85% 76%)`} />
                    <circle cx={blobX} cy={blobY} r="19" fill={`hsl(${accentHue} 88% 66%)`} />
                    <g transform={`translate(${shiftX} ${shiftY}) rotate(${tilt} 20 20)`}>
                        <Eyes variant={(hash >>> 22) % 4} />
                        <Mouth variant={(hash >>> 25) % 4} />
                    </g>
                </g>
            </svg>
            {props.flavor ? (
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
