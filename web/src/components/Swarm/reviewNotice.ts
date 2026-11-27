/**
 * What a worker is told the moment the reviewer saves a card.
 *
 * Feedback is only worth anything if the next cards reflect it, but re-scoring
 * the card the reviewer opens next would make them wait on the run. So the
 * worker is pointed at exactly one card — the one after next — which keeps it a
 * step ahead of the reviewer and never in their way. Naming the card here is
 * what makes that automatic: otherwise the reviewer has to hunt it down and ask
 * by hand after every single comment.
 */
export function reviewSavedMessage(rescoreKey: string | null): string {
    const base = 'An item review was just saved on the worker board. Follow the playbook: process all unprocessed review feedback and update the relevant criteria where the evidence supports it.'
    if (!rescoreKey) {
        return `${base} No card is far enough ahead in the review queue to re-score, so leave the remaining cards as they are rather than re-scoring the card the reviewer opens next.`
    }
    return `${base} Then re-score exactly one card with the updated criteria: ${rescoreKey}. That is the card after the one the reviewer opens next. Never re-score the next card in the queue — the reviewer is about to open it and would be left waiting on your run.`
}
