import { describe, expect, it } from 'vitest'
import type { WorkerRecord } from '@/api/client'
import { boardCell, boardColumns, columnLabel, filterRecords, sortRecords, toCsv } from './board'

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
