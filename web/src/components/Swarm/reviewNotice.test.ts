import { describe, expect, it } from 'vitest'
import { reviewSavedMessage } from './reviewNotice'

describe('reviewSavedMessage', () => {
    it('names the one card to re-score and rules out the card the reviewer opens next', () => {
        const message = reviewSavedMessage('candidate-after-next')
        expect(message).toContain('candidate-after-next')
        expect(message).toContain('Never re-score the next card')
    })

    it('tells the worker to leave the queue alone when nothing is far enough ahead', () => {
        expect(reviewSavedMessage(null)).toContain('leave the remaining cards as they are')
    })
})
