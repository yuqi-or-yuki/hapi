import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'

// Module-level opener — set when the component mounts, cleared on unmount.
// Call this from anywhere to open the lightbox.
export let openImageLightbox: (src: string, alt?: string) => void = () => {}

function touchDistance(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX
    const dy = t1.clientY - t2.clientY
    return Math.sqrt(dx * dx + dy * dy)
}

export function ImageLightbox() {
    const [src, setSrc] = useState<string | null>(null)
    const [alt, setAlt] = useState('')
    const [scale, setScale] = useState(1)
    const [tx, setTx] = useState(0)
    const [ty, setTy] = useState(0)

    // Refs track gesture state without stale-closure issues
    const scaleRef = useRef(1)
    const txRef = useRef(0)
    const tyRef = useRef(0)
    const pinchStartDistRef = useRef(0)
    const pinchStartScaleRef = useRef(1)
    const panStartPoRef = useRef({ x: 0, y: 0 })
    const panStartTRef = useRef({ x: 0, y: 0 })
    const lastTapTimeRef = useRef(0)
    const movedRef = useRef(false)
    const imgRef = useRef<HTMLImageElement>(null)

    const commit = (s: number, x: number, y: number) => {
        scaleRef.current = s; txRef.current = x; tyRef.current = y
        setScale(s); setTx(x); setTy(y)
    }

    const reset = () => commit(1, 0, 0)

    useEffect(() => {
        openImageLightbox = (newSrc, newAlt = '') => {
            reset()
            setSrc(newSrc)
            setAlt(newAlt)
        }
        return () => { openImageLightbox = () => {} }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const close = useCallback(() => setSrc(null), [])

    // Attach imperative non-passive touch listeners so preventDefault works on iOS
    useEffect(() => {
        const el = imgRef.current
        if (!el) return
        const opts = { passive: false }

        const onTouchStart = (e: TouchEvent) => {
            movedRef.current = false
            if (e.touches.length === 2) {
                pinchStartDistRef.current = touchDistance(e.touches[0], e.touches[1])
                pinchStartScaleRef.current = scaleRef.current
            } else if (e.touches.length === 1) {
                const now = Date.now()
                if (now - lastTapTimeRef.current < 280) {
                    // Double tap: toggle 1x ↔ 2.5x
                    lastTapTimeRef.current = 0
                    if (scaleRef.current > 1) { reset() } else { commit(2.5, 0, 0) }
                    return
                }
                lastTapTimeRef.current = now
                panStartPoRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
                panStartTRef.current = { x: txRef.current, y: tyRef.current }
            }
        }

        const onTouchMove = (e: TouchEvent) => {
            e.preventDefault()
            movedRef.current = true
            if (e.touches.length === 2) {
                const dist = touchDistance(e.touches[0], e.touches[1])
                const newScale = Math.min(8, Math.max(1, pinchStartScaleRef.current * (dist / pinchStartDistRef.current)))
                if (newScale <= 1) { commit(1, 0, 0) } else { commit(newScale, txRef.current, tyRef.current); setScale(newScale) }
            } else if (e.touches.length === 1 && scaleRef.current > 1) {
                const nx = panStartTRef.current.x + (e.touches[0].clientX - panStartPoRef.current.x)
                const ny = panStartTRef.current.y + (e.touches[0].clientY - panStartPoRef.current.y)
                txRef.current = nx; tyRef.current = ny
                setTx(nx); setTy(ny)
            }
        }

        const onTouchEnd = (e: TouchEvent) => {
            e.preventDefault()
            if (!movedRef.current && e.touches.length === 0 && scaleRef.current <= 1) {
                close()
            }
        }

        el.addEventListener('touchstart', onTouchStart, opts)
        el.addEventListener('touchmove', onTouchMove, opts)
        el.addEventListener('touchend', onTouchEnd, opts)
        return () => {
            el.removeEventListener('touchstart', onTouchStart)
            el.removeEventListener('touchmove', onTouchMove)
            el.removeEventListener('touchend', onTouchEnd)
        }
    }, [src, close]) // re-attach when src changes (new image opened)

    // Close on Escape
    useEffect(() => {
        if (!src) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [src, close])

    if (!src) return null

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] bg-black flex items-center justify-center overflow-hidden"
            style={{ touchAction: 'none' }}
            onClick={scale <= 1 ? close : undefined}
        >
            {/* Close button */}
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); close() }}
                className="absolute z-10 p-2.5 rounded-full bg-black/60 text-white"
                style={{ top: 'max(12px, env(safe-area-inset-top, 12px))', right: 12 }}
            >
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none">
                    <path d="M5 5l10 10M5 15L15 5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
            </button>

            {/* Hint */}
            <span
                className="absolute z-10 bottom-6 left-1/2 -translate-x-1/2 text-xs text-white/40 pointer-events-none select-none"
                style={{ bottom: 'max(24px, env(safe-area-inset-bottom, 24px))' }}
            >
                {scale > 1 ? 'Pinch or double-tap to zoom out' : 'Tap to close · Pinch or double-tap to zoom'}
            </span>

            <img
                ref={imgRef}
                src={src}
                alt={alt}
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                style={{
                    maxWidth: '100vw',
                    maxHeight: '100vh',
                    objectFit: 'contain',
                    transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                    transformOrigin: 'center center',
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    cursor: scale > 1 ? 'grab' : 'zoom-in',
                    willChange: 'transform',
                }}
            />
        </div>,
        document.body
    )
}
