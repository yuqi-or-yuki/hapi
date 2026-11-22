import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TalentReview } from './TalentReview'

describe('TalentReview', () => {
    it('keeps the next suggestion when the board advances before save finishes', async () => {
        const first = { key: 'first', createdAt: 1, updatedAt: 1, data: { name: 'First', bestFitRole: 'Forward Deployment', suggestedDecision: 'yes', suggestedReason: 'First reason' } }
        const second = { key: 'second', createdAt: 1, updatedAt: 1, data: { name: 'Second', bestFitRole: 'Product Designer', suggestedDecision: 'no', suggestedReason: 'Second reason' } }
        let finish!: (value: boolean) => void
        const onRecord = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
        const view = render(<TalentReview records={[first, second]} onRecord={onRecord} onClose={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        view.rerender(<TalentReview records={[second]} onRecord={onRecord} onClose={() => {}} />)
        expect(screen.getByRole('textbox', { name: 'Why?' })).toHaveValue('Second reason')
        finish(true)
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved.'))
        expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('textbox', { name: 'Why?' })).toHaveValue('Second reason')
    })

    it('keeps edits and the shown prediction if the board updates during review', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        const make = (decision: string, reason: string, role = 'Forward Deployment') => [{ key: 'item-race', createdAt: 1, updatedAt: 1, data: { name: 'Item', bestFitRole: role, suggestedDecision: decision, suggestedReason: reason } }]
        const { rerender } = render(<TalentReview records={make('no', 'Original reason')} onRecord={onRecord} onClose={() => {}} />)
        fireEvent.change(screen.getByRole('textbox', { name: 'Why?' }), { target: { value: 'My own reason' } })
        rerender(<TalentReview records={make('yes', 'Updated reason', 'Product Designer')} onRecord={onRecord} onClose={() => {}} />)
        expect(screen.getByRole('textbox', { name: 'Why?' })).toHaveValue('My own reason')
        expect(screen.getByRole('combobox', { name: 'Review for role' })).toHaveValue('Forward Deployment')
        expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        expect(onRecord.mock.calls[0][1].linkedinReviews[0]).toMatchObject({ predictedDecision: 'no', predictedReason: 'Original reason', decisionUnchanged: true, reasonUnchanged: false })
    })
    it('supports a general worker and saves the original prediction and exact agreement', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        render(<TalentReview talent={false} records={[{ key: 'item', createdAt: 1, updatedAt: 1, data: { title: 'Example item', url: 'https://example.com/office', suggestedDecision: 'yes', suggestedReason: 'Relevant to the job.' } }]} onRecord={onRecord} onClose={() => {}} />)
        expect(screen.getByRole('link', { name: /View listing/ })).toHaveAttribute('href', 'https://example.com/office')
        expect(screen.getByText('Do you approve?')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        expect(onRecord.mock.calls[0][1].approvalReviews[0]).toMatchObject({ decision: 'yes', reason: 'Relevant to the job.', predictedDecision: 'yes', predictedReason: 'Relevant to the job.', decisionUnchanged: true, reasonUnchanged: true })
    })
    it('prefills an editable suggestion without recording it until saved', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        render(<TalentReview records={[{ key: 'candidate-suggestion', createdAt: 1, updatedAt: 1, data: { name: 'Example Candidate', bestFitRole: 'Forward Deployment', suggestedDecision: 'no', suggestedReason: 'PM background is unverified.' } }]} onRecord={onRecord} onClose={() => {}} />)
        expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('textbox', { name: 'Why?' })).toHaveValue('PM background is unverified.')
        expect(onRecord).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
        expect(screen.getByRole('textbox', { name: 'Why?' })).toHaveValue('')
        expect(screen.getByRole('button', { name: 'Save and next' })).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox', { name: 'Why?' }), { target: { value: 'Founder judgment differs.' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        expect(onRecord.mock.calls[0][1].linkedinReviews[0]).toMatchObject({ decision: 'yes', reason: 'Founder judgment differs.', suggestionAccepted: false })
    })
    it('records when the user confirms the unedited suggestion', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        render(<TalentReview records={[{ key: 'candidate-confirmed', createdAt: 1, updatedAt: 1, data: { name: 'Candidate', bestFitRole: 'Forward Deployment', suggestedDecision: 'no', suggestedReason: 'PM experience unverified.' } }]} onRecord={onRecord} onClose={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        expect(onRecord.mock.calls[0][1].linkedinReviews[0]).toMatchObject({ decision: 'no', reason: 'PM experience unverified.', suggestionAccepted: true })
    })
    it('requires a decision and reason, then records feedback without sending outreach', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        render(<TalentReview records={[{ key: 'candidate-1', createdAt: 1, updatedAt: 1, data: { name: 'Example Candidate', bestFitRole: 'Forward Deployment' } }]} onRecord={onRecord} onClose={() => {}} />)
        const save = screen.getByRole('button', { name: 'Save and next' })
        expect(save).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Why?' }), { target: { value: 'Strong customer ownership' } })
        fireEvent.click(save)
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        const [key, fields] = onRecord.mock.calls[0]
        expect(key).toBe('candidate-1')
        expect(fields.linkedinDecision).toBe('Would connect')
        expect(fields.linkedinReviews).toEqual([expect.objectContaining({ role: 'Forward Deployment', decision: 'yes', reason: 'Strong customer ownership', id: expect.any(String), at: expect.any(String) })])
    })

    it('keeps a saved review when the worker notification fails', async () => {
        const onRecord = vi.fn().mockResolvedValue(false)
        render(<TalentReview records={[{ key: 'candidate-2', createdAt: 1, updatedAt: 1, data: { name: 'Example Candidate', bestFitRole: 'Forward Deployment' } }]} onRecord={onRecord} onClose={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'No' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Why?' }), { target: { value: 'Missing customer evidence' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        expect(await screen.findByRole('status')).toHaveTextContent('Saved, but the worker could not be notified')
        expect(onRecord).toHaveBeenCalledTimes(1)
    })
})
