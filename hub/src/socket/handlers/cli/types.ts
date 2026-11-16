export type AccessErrorReason = 'namespace-missing' | 'access-denied' | 'not-found'

/** What per-event handlers need from a session access check. */
export type SessionAccess = { id: string; namespace: string }

export type AccessResult<T> =
    | { ok: true; value: T }
    | { ok: false; reason: AccessErrorReason }
