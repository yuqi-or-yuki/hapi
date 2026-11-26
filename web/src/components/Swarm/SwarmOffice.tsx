import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { GRID, ROOMS, roomFor } from './office'
import type { OfficeGame, OfficeWorker } from './officeGame'
import { trainOrder } from './pipeline'
import { useSwarmLinks } from './SwarmPipelines'
import { newToReview, workerName, workerSeed, workerState } from './worker'
import type { Worker } from './SwarmView'

type Hover = { id: string; x: number; y: number }

/**
 * What a worker holds up over its head, so its state can be read across the
 * room without hovering: a board asking for review (with how many cards), a
 * call for help, or a thought bubble while it works. Resting workers hold nothing.
 */
function Sign(props: { worker: Worker }) {
    const { t } = useTranslation()
    const { session } = props.worker
    const state = workerState(session)
    const board = 'rounded-sm border-2 px-1.5 text-[10px] font-bold leading-4 shadow-md'
    // A board on a stick reads as "held up" even at this size.
    const stick = <span className="mx-auto block h-1.5 w-0.5 bg-amber-900" />

    if (state === 'failing') {
        return <><span className={`${board} border-red-900 bg-red-500 text-white`}>{t('swarm.office.sign.failing')}</span>{stick}</>
    }
    const toReview = newToReview(session)
    if (toReview > 0) {
        return (
            <>
                <span className={`${board} border-amber-900 bg-amber-300 text-amber-950`}>{t('swarm.office.sign.reviewCount', { n: toReview })}</span>
                {stick}
            </>
        )
    }
    if (state === 'working') {
        return (
            <span className="flex items-center gap-0.5 rounded-full bg-white px-1.5 py-1 shadow-md" title={t('swarm.state.working')}>
                {[0, 1, 2].map((dot) => (
                    <span key={dot} className="h-1 w-1 animate-bounce rounded-full bg-emerald-600" style={{ animationDelay: `${dot * 150}ms` }} />
                ))}
            </span>
        )
    }
    return null
}

/**
 * The swarm as a small pixel-art office. Each worker is a figure that walks
 * around the room its state puts it in, and hovering one shows its card.
 *
 * The game engine is loaded only when this view is opened, and the game is
 * torn down when it closes, so the list view and every other page pay nothing.
 */
export function SwarmOffice(props: {
    workers: readonly Worker[]
    renderCard: (worker: Worker) => React.ReactNode
    onOpenWorker: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const stageRef = useRef<HTMLDivElement>(null)
    const gameRef = useRef<OfficeGame | null>(null)
    const clearTimer = useRef<number | undefined>(undefined)
    const tags = useRef(new Map<string, HTMLSpanElement>())
    const [hover, setHover] = useState<Hover | null>(null)
    const [failed, setFailed] = useState(false)
    const onOpen = useRef(props.onOpenWorker)
    onOpen.current = props.onOpenWorker

    const links = useSwarmLinks()
    const follows = useMemo(() => trainOrder(props.workers, links, (worker) => worker.session.id), [props.workers, links])
    const officeWorkers = useMemo<OfficeWorker[]>(() => props.workers.map((worker) => ({
        id: worker.session.id,
        seed: workerSeed(worker.session),
        flavor: worker.session.metadata?.flavor ?? null,
        room: roomFor(worker.session),
        follows: follows.get(worker.session.id)
    })), [props.workers, follows])
    const latest = useRef(officeWorkers)
    latest.current = officeWorkers

    useEffect(() => {
        let cancelled = false
        void import('./officeGame').then(({ createOfficeGame }) => {
            if (cancelled || !stageRef.current) return
            gameRef.current = createOfficeGame(stageRef.current, {
                onHover: (id, at) => {
                    window.clearTimeout(clearTimer.current)
                    if (id && at) setHover({ id, x: at.x, y: at.y })
                    // A short grace period lets the pointer cross the gap from a worker to its card.
                    else clearTimer.current = window.setTimeout(() => setHover(null), 250)
                },
                onOpen: (id) => onOpen.current(id),
                // Written straight to the elements: a walk must not re-render React 30 times a second.
                onPlaced: (places) => {
                    for (const place of places) {
                        const tag = tags.current.get(place.id)
                        if (!tag) continue
                        tag.style.left = `${place.x * 100}%`
                        tag.style.top = `${place.y * 100}%`
                        tag.style.visibility = 'visible'
                    }
                }
            })
            gameRef.current.setWorkers(latest.current)
        }).catch(() => setFailed(true))
        return () => {
            cancelled = true
            window.clearTimeout(clearTimer.current)
            gameRef.current?.destroy()
            gameRef.current = null
        }
    }, [])

    useEffect(() => { gameRef.current?.setWorkers(officeWorkers) }, [officeWorkers])
    useEffect(() => { gameRef.current?.setHeld(hover?.id ?? null) }, [hover?.id])

    const hovered = hover ? props.workers.find((worker) => worker.session.id === hover.id) : undefined

    return (
        <div
            className="relative mx-auto overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[#3b3f52]"
            style={{
                aspectRatio: `${GRID.cols} / ${GRID.rows}`,
                // As large as the page allows in both directions: full width, unless that would push the
                // floor below the fold, in which case the height left under the header and toggle decides.
                width: `min(100%, calc((100dvh - 10.5rem) * ${GRID.cols} / ${GRID.rows}))`,
                containerType: 'size'
            }}
            onMouseLeave={() => setHover(null)}
        >
            <div ref={stageRef} className="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full" />
            {failed ? <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80">{t('swarm.office.failed')}</p> : null}
            {ROOMS.map((room) => (
                <span
                    key={room.id}
                    className="pointer-events-none absolute rounded bg-black/35 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/90"
                    style={{ left: `${((room.x + 1.2) / GRID.cols) * 100}%`, top: `${((room.y + room.h - 1.1) / GRID.rows) * 100}%` }}
                >
                    {t(`swarm.office.room.${room.id}`)}
                </span>
            ))}
            {props.workers.map((worker) => (
                // A zero-size anchor at the worker's feet: the sign hangs above the head, the name below.
                <span
                    key={worker.session.id}
                    ref={(element) => {
                        if (element) tags.current.set(worker.session.id, element)
                        else tags.current.delete(worker.session.id)
                    }}
                    aria-hidden="true"
                    className="pointer-events-none invisible absolute"
                >
                    {/* One tile is 100/24 of the floor's height; the figure is about a tile and a quarter tall. */}
                    <span className="absolute left-0 flex -translate-x-1/2 flex-col items-center whitespace-nowrap" style={{ bottom: '5.2cqh' }}>
                        <Sign worker={worker} />
                    </span>
                    <span className="absolute left-0 top-0.5 -translate-x-1/2 whitespace-nowrap rounded bg-black/55 px-1 text-[10px] font-medium leading-4 text-white">
                        {workerName(worker.session)}
                    </span>
                </span>
            ))}
            {/* For screen readers and keyboards the office is a plain list of the same workers. */}
            <ul className="sr-only">
                {props.workers.map((worker) => (
                    <li key={worker.session.id}>
                        <button type="button" onClick={() => props.onOpenWorker(worker.session.id)}>
                            {workerName(worker.session)}: {t(`swarm.office.room.${roomFor(worker.session)}`)}
                        </button>
                    </li>
                ))}
            </ul>
            {hover && hovered ? (
                <div
                    className="absolute z-10 w-80 max-w-[80%]"
                    style={{
                        // The card opens toward the middle of the floor so it never leaves it.
                        ...(hover.x < 0.5 ? { left: `${hover.x * 100}%` } : { right: `${(1 - hover.x) * 100}%` }),
                        ...(hover.y < 0.5 ? { top: `calc(${hover.y * 100}% + 2.5rem)` } : { bottom: `calc(${(1 - hover.y) * 100}% + 0.5rem)` })
                    }}
                    onMouseEnter={() => window.clearTimeout(clearTimer.current)}
                >
                    {/* The card's own background is translucent; over the game it needs a solid one behind it. */}
                    <div className="rounded-2xl bg-[var(--app-bg)] shadow-2xl">{props.renderCard(hovered)}</div>
                </div>
            ) : null}
        </div>
    )
}
