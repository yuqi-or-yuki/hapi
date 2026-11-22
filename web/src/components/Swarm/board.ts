import type { WorkerRecord } from '@/api/client'

export type BoardColumn = { key: string; label: string; numeric: boolean }
export type BoardSort = { key: string; descending: boolean }

/** `whyGoodFit` / `why_good_fit` → "Why good fit". Workers name fields for code, people read labels. */
export function columnLabel(key: string): string {
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase()
    return words ? words[0].toUpperCase() + words.slice(1) : key
}

/**
 * The board's columns: the order the worker asked for, then every other field
 * in the order it first appears, so a field the worker starts reporting later
 * shows up without anyone reconfiguring the board.
 */
export function boardColumns(records: readonly WorkerRecord[], preferred: readonly string[] = []): BoardColumn[] {
    const keys = [...preferred]
    const seen = new Set(keys)
    // Oldest rows first, so the first row a worker ever wrote sets the natural order.
    for (let index = records.length - 1; index >= 0; index -= 1) {
        for (const key of Object.keys(records[index].data)) {
            if (!seen.has(key)) {
                seen.add(key)
                keys.push(key)
            }
        }
    }
    return keys.map((key) => {
        const values = records.map((record) => record.data[key]).filter((value) => value !== undefined && value !== null && value !== '')
        return { key, label: columnLabel(key), numeric: values.length > 0 && values.every((value) => typeof value === 'number') }
    })
}

export type BoardCell =
    | { kind: 'empty' }
    | { kind: 'flag'; value: boolean }
    | { kind: 'number'; value: number }
    | { kind: 'link'; href: string; label: string }
    | { kind: 'gallery'; images: string[] }
    | { kind: 'text'; value: string }

const URL_PATTERN = /^(https?:\/\/|www\.)\S+$/i
const BARE_DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** A link that points at a picture: judged by extension, which is the only
 *  thing we can tell without fetching it. Query strings are ignored so signed
 *  URLs still count. */
const IMAGE_PATTERN = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i

function imageUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (!URL_PATTERN.test(text) && !BARE_DOMAIN_PATTERN.test(text)) return null
    if (!IMAGE_PATTERN.test(text)) return null
    return /^https?:\/\//i.test(text) ? text : `https://${text}`
}

/**
 * Pictures a row carries: one URL, or a list of them.
 *
 * A worker that looks at places rather than people -- offices, listings,
 * products -- produces rows whose most useful field is what the thing looks
 * like. As plain text a list of image URLs is unreadable, so it gets its own
 * cell and is shown rather than linked.
 */
export function galleryImages(value: unknown): string[] | null {
    if (Array.isArray(value)) {
        const images = value.map(imageUrl).filter((url): url is string => url !== null)
        return images.length > 0 && images.length === value.length ? images : null
    }
    const single = imageUrl(value)
    return single ? [single] : null
}

/** Host plus the last path segment: enough to recognise a profile link without the full URL. */
function linkLabel(href: string): string {
    try {
        const url = new URL(href)
        const host = url.hostname.replace(/^www\./, '')
        if (host === 'mail.google.com' && url.hash) return 'Open email'
        const segments = url.pathname.split('/').filter(Boolean)
        if (segments.length === 0) return host
        return `${host}/${segments.length > 1 ? '…/' : ''}${segments[segments.length - 1]}`
    } catch {
        return href
    }
}

/**
 * Every picture on a row, across whichever fields hold them.
 *
 * The review card cannot know which field a worker chose -- `photos`,
 * `images`, `headshot` -- so it asks for all of them in column order and shows
 * what comes back.
 */
export function recordImages(data: Record<string, unknown>): string[] {
    const seen = new Set<string>()
    for (const value of Object.values(data)) {
        for (const image of galleryImages(value) ?? []) seen.add(image)
    }
    return [...seen]
}

export function boardCell(value: unknown): BoardCell {
    if (value === undefined || value === null || value === '') return { kind: 'empty' }
    if (typeof value === 'boolean') return { kind: 'flag', value }
    if (typeof value === 'number') return { kind: 'number', value }
    const images = galleryImages(value)
    if (images) return { kind: 'gallery', images }
    if (Array.isArray(value)) return { kind: 'text', value: value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ') }
    if (typeof value === 'object') return { kind: 'text', value: JSON.stringify(value) }
    const text = String(value).trim()
    if (EMAIL_PATTERN.test(text)) return { kind: 'link', href: `mailto:${text}`, label: text }
    if (URL_PATTERN.test(text) || BARE_DOMAIN_PATTERN.test(text)) {
        const href = /^https?:\/\//i.test(text) ? text : `https://${text}`
        return { kind: 'link', href, label: linkLabel(href) }
    }
    return { kind: 'text', value: text }
}

function searchable(value: unknown): string {
    return (typeof value === 'string' ? value : JSON.stringify(value) ?? '').toLowerCase()
}

export function filterRecords(records: readonly WorkerRecord[], query: string): WorkerRecord[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return [...records]
    return records.filter((record) => Object.values(record.data).some((value) => searchable(value).includes(needle)))
}

/** Empty cells sort last in both directions: a missing value is not "smallest". */
export function sortRecords(records: readonly WorkerRecord[], sort: BoardSort | null): WorkerRecord[] {
    if (!sort) return [...records]
    const direction = sort.descending ? -1 : 1
    return [...records].sort((a, b) => {
        const left = a.data[sort.key]
        const right = b.data[sort.key]
        const leftEmpty = left === undefined || left === null || left === ''
        const rightEmpty = right === undefined || right === null || right === ''
        if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction
        return searchable(left).localeCompare(searchable(right), undefined, { numeric: true }) * direction
    })
}

function csvField(value: unknown): string {
    const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(records: readonly WorkerRecord[], columns: readonly BoardColumn[]): string {
    const lines = [columns.map((column) => csvField(column.label)).join(',')]
    for (const record of records) {
        lines.push(columns.map((column) => csvField(record.data[column.key])).join(','))
    }
    return lines.join('\n')
}
