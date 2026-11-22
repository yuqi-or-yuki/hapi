import { describe, expect, it } from 'vitest'
import type { WorkerRecord } from '@/api/client'
import { boardCell, boardColumns, columnLabel, filterRecords, galleryImages, sortRecords, toCsv } from './board'

function row(key: string, data: Record<string, unknown>): WorkerRecord {
    return { key, data, createdAt: 0, updatedAt: 0 }
}

// Newest first, as the hub returns them.
const records = [
    row('b', { name: 'Bo', citations: 90, emailSent: true, note: 'has, comma' }),
    row('a', { name: 'Ann', linkedin: 'linkedin.com/in/ann', citations: 4120 })
]

describe('boardColumns', () => {
    it('puts requested columns first, then fields in the order workers first reported them', () => {
        const columns = boardColumns(records, ['citations'])
        expect(columns.map((column) => column.key)).toEqual(['citations', 'name', 'linkedin', 'emailSent', 'note'])
        expect(columns[0].numeric).toBe(true)
        expect(columns[1].numeric).toBe(false)
    })

    it('turns field names into labels', () => {
        expect(columnLabel('whyGoodFit')).toBe('Why good fit')
        expect(columnLabel('email_sent')).toBe('Email sent')
    })
})

describe('boardCell', () => {
    it('recognises links, emails, flags and numbers', () => {
        expect(boardCell('linkedin.com/in/ann')).toEqual({ kind: 'link', href: 'https://linkedin.com/in/ann', label: 'linkedin.com/…/ann' })
        expect(boardCell('https://mail.google.com/mail/u/?authuser=test%40example.com#all/123')).toEqual({ kind: 'link', href: 'https://mail.google.com/mail/u/?authuser=test%40example.com#all/123', label: 'Open email' })
        expect(boardCell('ann@lab.edu')).toMatchObject({ kind: 'link', href: 'mailto:ann@lab.edu' })
        expect(boardCell(false)).toEqual({ kind: 'flag', value: false })
        expect(boardCell(12)).toEqual({ kind: 'number', value: 12 })
        expect(boardCell('Led a robotics team.')).toEqual({ kind: 'text', value: 'Led a robotics team.' })
        expect(boardCell(null)).toEqual({ kind: 'empty' })
    })
})

describe('filter, sort and export', () => {
    it('searches every field', () => {
        expect(filterRecords(records, 'linkedin').map((record) => record.key)).toEqual(['a'])
    })

    it('sorts numbers numerically and keeps empty cells last either way', () => {
        expect(sortRecords(records, { key: 'citations', descending: true }).map((record) => record.key)).toEqual(['a', 'b'])
        expect(sortRecords(records, { key: 'linkedin', descending: false }).map((record) => record.key)).toEqual(['a', 'b'])
        expect(sortRecords(records, { key: 'linkedin', descending: true }).map((record) => record.key)).toEqual(['a', 'b'])
    })

    it('quotes CSV fields that need it', () => {
        const csv = toCsv(records, boardColumns(records, ['name', 'note']).slice(0, 2))
        expect(csv).toBe('Name,Note\nBo,"has, comma"\nAnn,')
    })
})

describe('galleryImages', () => {
    it('reads a list of picture links as a gallery', () => {
        expect(galleryImages([
            'https://cdn.example.com/office-1.jpg',
            'https://cdn.example.com/office-2.png'
        ])).toEqual(['https://cdn.example.com/office-1.jpg', 'https://cdn.example.com/office-2.png'])
    })

    it('reads a single picture link as a gallery of one', () => {
        expect(galleryImages('https://cdn.example.com/office.webp')).toEqual(['https://cdn.example.com/office.webp'])
    })

    it('keeps signed urls, where the extension is followed by a query', () => {
        expect(galleryImages('https://cdn.example.com/a.jpg?sig=abc123')).toEqual(['https://cdn.example.com/a.jpg?sig=abc123'])
    })

    it('leaves ordinary links and prose alone', () => {
        expect(galleryImages('https://linkedin.com/in/jane')).toBeNull()
        expect(galleryImages('Head of Data @ LaunchGood')).toBeNull()
        expect(galleryImages(42)).toBeNull()
        expect(galleryImages(null)).toBeNull()
    })

    it('refuses a mixed list rather than silently dropping the non-pictures', () => {
        // Showing 1 of 2 values would hide data the worker recorded.
        expect(galleryImages(['https://cdn.example.com/a.jpg', 'see the listing'])).toBeNull()
    })
})

describe('boardCell for pictures', () => {
    it('gives pictures their own cell instead of a comma-joined string', () => {
        const cell = boardCell(['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'])
        expect(cell.kind).toBe('gallery')
        expect(cell.kind === 'gallery' && cell.images).toHaveLength(2)
    })

    it('still links a profile url rather than treating it as a picture', () => {
        expect(boardCell('https://linkedin.com/in/jane').kind).toBe('link')
    })
})
