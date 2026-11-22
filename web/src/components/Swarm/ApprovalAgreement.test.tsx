import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApprovalAgreement } from './ApprovalAgreement'

describe('role agreement', () => {
    it('switches between independently calculated role metrics', () => {
        const records = [{ key: 'a', createdAt: 1, updatedAt: 1, data: { bestFitRole: 'Designer', linkedinReviews: [
            { at: '2026-01-01', role: 'Designer', decision: 'yes', reason: 'good', predictedDecision: 'yes', predictedReason: 'good' },
            { at: '2026-01-02', role: 'Researcher', decision: 'no', reason: 'changed', predictedDecision: 'yes', predictedReason: 'good' },
        ] } }]
        render(<ApprovalAgreement records={records} talent />)
        let card = screen.getByRole('region', { name: 'Prediction agreement: Designer' })
        expect(within(card).getAllByText('100%')).toHaveLength(3)
        fireEvent.change(screen.getByRole('combobox', { name: 'Prediction accuracy for role' }), { target: { value: 'Researcher' } })
        card = screen.getByRole('region', { name: 'Prediction agreement: Researcher' })
        expect(within(card).getAllByText('0%')).toHaveLength(3)
    })
})
