import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TalentReview } from './TalentReview'

describe('TalentReview', () => {
    it('shows the candidate pool link and website without inventing a LinkedIn profile', () => {
        const records = [{ key: 'p', createdAt: 1, updatedAt: 1, data: { name: 'Researcher', bestFitRole: 'Research Scientist, Modeling', suggestedDecision: 'no', suggestedReason: 'Check evidence', talentPoolUrl: 'https://tenera-talent-pool.vercel.app/pool?q=Researcher', candidateWebsiteUrl: 'https://researcher.example/' } }]
        render(<TalentReview records={records} onRecord={vi.fn()} onClose={() => {}} />)
        expect(screen.getByRole('link', { name: /Find in talent pool/ })).toHaveAttribute('href', 'https://tenera-talent-pool.vercel.app/pool?q=Researcher')
        expect(screen.getByRole('link', { name: /View candidate website/ })).toHaveAttribute('href', 'https://researcher.example/')
        expect(screen.queryByRole('link', { name: /LinkedIn/ })).not.toBeInTheDocument()
    })
    it('prioritizes research candidates while retaining their relative order', () => {
        const records = [
            { key: 'd', createdAt: 1, updatedAt: 1, data: { name: 'Designer', bestFitRole: 'Product Designer', suggestedDecision: 'no', suggestedReason: 'Design' } },
            { key: 'r1', createdAt: 1, updatedAt: 1, data: { name: 'Research one', bestFitRole: 'Research Scientist, Modeling', suggestedDecision: 'yes', suggestedReason: 'Research one' } },
            { key: 'r2', createdAt: 1, updatedAt: 1, data: { name: 'Research two', bestFitRole: 'Research Scientist, Evaluations', suggestedDecision: 'yes', suggestedReason: 'Research two' } },
        ]
        render(<TalentReview records={records} onRecord={vi.fn()} onClose={() => {}} />)
        expect(screen.getByRole('heading', { name: 'Research one' })).toBeInTheDocument()
        fireEvent.click(screen.getByText('Skip for now'))
        expect(screen.getByRole('heading', { name: 'Research two' })).toBeInTheDocument()
    })
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
    it('shows the message a worker wants to send, and saves the edited version next to the original', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        render(<TalentReview talent={false} records={[{ key: 'ann', createdAt: 1, updatedAt: 1, data: { name: 'Ann', channel: 'email', email: 'ann@example.com', subject: 'Your ChatBench paper', draft: 'Hi Ann, long pitch.', approvalQuestion: 'Send this email to ann@example.com?', suggestedDecision: 'yes', suggestedReason: 'Fits Evaluations.' } }]} onRecord={onRecord} onClose={() => {}} />)
        expect(screen.queryByText('Send this email to ann@example.com?')).not.toBeInTheDocument()
        for (const name of ['Yes', 'No', 'Skip for now']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hi Ann, long pitch.')
        fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hi Ann, short note.' } })
        expect(screen.queryByRole('textbox', { name: 'Why?' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Approve to send' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        const fields = onRecord.mock.calls[0][1]
        expect(fields).toMatchObject({ draft: 'Hi Ann, short note.', draftOriginal: 'Hi Ann, long pitch.', subject: 'Your ChatBench paper', approvalDecision: 'yes' })
        expect(fields.approvalReviews[0]).toMatchObject({ decision: 'yes', draftShown: 'Hi Ann, long pitch.', draftFinal: 'Hi Ann, short note.', draftEdited: true, subjectFinal: 'Your ChatBench paper' })
    })
    it('records an approved message as unedited and leaves the row text alone', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        render(<TalentReview talent={false} records={[{ key: 'held', createdAt: 1, updatedAt: 1, data: { name: 'Held', channel: 'hold' } }, { key: 'bo', createdAt: 1, updatedAt: 1, data: { name: 'Bo', channel: 'LinkedIn', draft: 'Hi Bo.', suggestedDecision: 'no', suggestedReason: 'Good fit.' } }]} onRecord={onRecord} onClose={() => {}} />)
        expect(screen.queryByRole('textbox', { name: 'Subject' })).not.toBeInTheDocument()
        expect(screen.getByText('1 remaining')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Approve to send' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        const fields = onRecord.mock.calls[0][1]
        expect(fields.draft).toBeUndefined()
        expect(fields.approvalDecision).toBe('yes')
        expect(fields.approvalReviews[0]).toMatchObject({ draftShown: 'Hi Bo.', draftFinal: 'Hi Bo.', draftEdited: false })
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

    it('hands the worker the card after next, never the card the reviewer opens next', async () => {
        const onRecord = vi.fn().mockResolvedValue(true)
        const card = (key: string, name: string) => ({ key, createdAt: 1, updatedAt: 1, data: { name, bestFitRole: 'Forward Deployment', suggestedDecision: 'yes', suggestedReason: `${name} reason` } })
        const records = [card('current', 'Current'), card('next', 'Next'), card('after-next', 'After next'), card('later', 'Later')]
        const { rerender } = render(<TalentReview records={records} onRecord={onRecord} onClose={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1))
        expect(onRecord.mock.calls[0][0]).toBe('current')
        expect(onRecord.mock.calls[0][2]).toBe('after-next')

        // With only the reviewer's next card left, there is nothing safe to re-score.
        rerender(<TalentReview records={[card('solo', 'Solo')]} onRecord={onRecord} onClose={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
        await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(2))
        expect(onRecord.mock.calls[1][2]).toBeNull()
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
