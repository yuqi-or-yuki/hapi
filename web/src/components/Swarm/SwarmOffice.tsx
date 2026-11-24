import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { GRID, ROOMS, roomFor } from './office'
import type { OfficeGame, OfficeMarker, OfficeWorker } from './officeGame'
import { newToReview, workerName, workerSeed, workerState } from './worker'
import type { Worker } from './SwarmView'

type Hover = { id: string; x: number; y: number }

function markerFor(worker: Worker): OfficeMarker {
    const state = workerState(worker.session)
    if (state === 'failing') return 'failing'
    if (newToReview(worker.session) > 0) return 'review'
    return state === 'working' ? 'working' : null
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
    const [hover, setHover] = useState<Hover | null>(null)
    const [failed, setFailed] = useState(false)
    const onOpen = useRef(props.onOpenWorker)
    onOpen.current = props.onOpenWorker

    const officeWorkers = useMemo<OfficeWorker[]>(() => props.workers.map((worker) => ({
        id: worker.session.id,
        seed: workerSeed(worker.session),
        name: workerName(worker.session),
        room: roomFor(worker.session),
        marker: markerFor(worker)
    })), [props.workers])
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
                onOpen: (id) => onOpen.current(id)
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
            className="relative w-full overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[#3b3f52]"
            style={{ aspectRatio: `${GRID.cols} / ${GRID.rows}` }}
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
                    <div className="rounded-2xl shadow-2xl">{props.renderCard(hovered)}</div>
                </div>
            ) : null}
        </div>
    )
}
