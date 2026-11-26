import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { PromoteToWorkerDialog } from './PromoteToWorkerDialog'

describe('worker item approval configuration', () => {
    it('enables item approvals from the promote dialog', async () => {
        const onPromote = vi.fn().mockResolvedValue(undefined)
        render(<PromoteToWorkerDialog isOpen onClose={() => {}} sessionTitle="test" worker={{ id: 'session-1' }} onPromote={onPromote} />)
        fireEvent.change(screen.getByLabelText('swarm.promote.label'), { target: { value: 'Review leads' } })
        fireEvent.click(screen.getByRole('checkbox', { name: 'Item approval and prediction tracking' }))
        fireEvent.click(screen.getByRole('button', { name: 'swarm.promote.confirm' }))
        await waitFor(() => expect(onPromote).toHaveBeenCalledTimes(1))
        expect(onPromote.mock.calls[0][0]).toMatchObject({ job: 'Review leads', board: { columns: ['name', 'suggestedDecision', 'suggestedReason'] } })
    })
})
