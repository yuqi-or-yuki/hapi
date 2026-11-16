import type { AgentState } from '@/api/types';

type CompletedRequests = NonNullable<AgentState['completedRequests']>;

export const MAX_COMPLETED_REQUESTS = 50;

/**
 * Keep only the most recent completed permission requests.
 *
 * The whole agentState is re-sent, re-stored and broadcast by the hub on every
 * update, so an ever-growing completedRequests map makes each update more
 * expensive. Entries are ordered by completedAt; an entry without one keeps
 * its insertion position relative to its predecessor.
 */
export function capCompletedRequests(
    completedRequests: CompletedRequests,
    max: number = MAX_COMPLETED_REQUESTS
): CompletedRequests {
    const entries = Object.entries(completedRequests);
    if (entries.length <= max) {
        return completedRequests;
    }

    let lastSeen = Number.NEGATIVE_INFINITY;
    const ranked = entries.map(([id, request], index) => {
        if (typeof request.completedAt === 'number') {
            lastSeen = request.completedAt;
        }
        return { id, request, at: lastSeen, index };
    });
    ranked.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1));

    return Object.fromEntries(ranked.slice(-max).map(({ id, request }) => [id, request]));
}
