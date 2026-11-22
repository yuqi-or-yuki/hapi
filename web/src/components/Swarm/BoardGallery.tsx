import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'

const THUMBNAILS = 4

/**
 * The pictures on a board row, shown rather than linked.
 *
 * A worker that reports on places or things — offices, listings, products —
 * is judged mostly on what they look like, so the images belong in the row
 * itself. Thumbnails stay small enough not to blow the row height up; tapping
 * one opens the full picture in a new tab, which works everywhere without
 * dragging a lightbox into a table cell.
 */
export function BoardGallery(props: { images: readonly string[]; alt?: string; size?: 'sm' | 'lg' }) {
    const { t } = useTranslation()
    const [broken, setBroken] = useState<Set<string>>(() => new Set())

    const usable = props.images.filter((src) => !broken.has(src))
    if (usable.length === 0) {
        return <span className="text-[var(--app-hint)]">{t('swarm.board.gallery.unavailable')}</span>
    }

    const large = props.size === 'lg'
    const shown = usable.slice(0, large ? 8 : THUMBNAILS)
    const extra = usable.length - shown.length

    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {shown.map((src, index) => (
                <a
                    key={src}
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    className="block overflow-hidden rounded-md border border-[var(--app-border)] transition-opacity hover:opacity-80"
                    title={t('swarm.board.gallery.open')}
                >
                    <img
                        src={src}
                        alt={props.alt ? `${props.alt} ${index + 1}` : t('swarm.board.gallery.alt', { n: index + 1 })}
                        // Not `loading="lazy"`: inside the board's scrolling
                        // container Chrome never fires the lazy load, so every
                        // thumbnail stayed blank. Measured on a real board --
                        // flipping one image to eager loaded it immediately
                        // while its lazy siblings stayed at naturalWidth 0.
                        // These are 48px; there is nothing to save.
                        decoding="async"
                        // A board can hold hundreds of rows; never let one
                        // oversized picture stretch the column.
                        className={large ? 'h-28 w-28 object-cover' : 'h-12 w-12 object-cover'}
                        onError={() => setBroken((previous) => new Set(previous).add(src))}
                    />
                </a>
            ))}
            {extra > 0 ? (
                <span className="text-[11px] tabular-nums text-[var(--app-hint)]">+{extra}</span>
            ) : null}
        </span>
    )
}
