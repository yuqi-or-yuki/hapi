import { storageKey } from '@tanstack/router-core'

const STORAGE_KEY = storageKey

const TARGET_ENTRIES_AFTER_PRUNE = 20
const MAX_VALUE_CHARS = 100_000

const GUARD_MARKER = '__hapiScrollRestorationGuard'

interface GuardedStorage extends Storage {
    [GUARD_MARKER]?: true
}

function hardResetScrollRestorationPersistedState(storage: Storage): void {
    try {
        storage.removeItem(STORAGE_KEY)
    } catch {
        // ignore
    }
}

function pruneScrollValue(value: string): string | null {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>
        const keys = Object.keys(parsed)
        let keepKeys = keys.length > TARGET_ENTRIES_AFTER_PRUNE
            ? keys.slice(-TARGET_ENTRIES_AFTER_PRUNE)
            : keys

        // Keep shrinking until under size budget or nothing left.
        while (keepKeys.length > 0) {
            const next: Record<string, unknown> = {}
            for (const k of keepKeys) {
                next[k] = parsed[k]
            }
            const trimmed = JSON.stringify(next)
            if (trimmed.length <= MAX_VALUE_CHARS) {
                return trimmed
            }
            // Drop oldest half when still too large.
            keepKeys = keepKeys.slice(Math.ceil(keepKeys.length / 2))
        }
        return '{}'
    } catch {
        return null
    }
}

/**
 * Wrap storage.setItem so writes to the scroll restoration cache
 * survive quota exhaustion. The default throws synchronously during a React
 * commit, blocking the UI (see tiann/hapi#611). We prune oldest entries and
 * retry; if still failing, we drop the key so navigation can continue.
 *
 * Upstream >=1.145.6 also wraps setItem with try-catch, so this guard is an
 * additional safety net that proactively keeps the cache small.
 */
export function installScrollRestorationGuard(
    storage: Storage = typeof window !== 'undefined' ? window.sessionStorage : undefined as unknown as Storage,
): () => void {
    if (!storage) {
        return () => {}
    }
    const guarded = storage as GuardedStorage
    if (guarded[GUARD_MARKER]) {
        return () => {}
    }
    // Keep the raw reference for restoration (uninstall must hand back the
    // exact same function), and a bound copy for invoking it.
    const rawSetItem = storage.setItem
    const originalSetItem = rawSetItem.bind(storage)

    const wrappedSetItem = (key: string, value: string): void => {
        if (key === STORAGE_KEY) {
            // Proactively shrink before first write so we never hit quota.
            if (value.length > MAX_VALUE_CHARS) {
                const pruned = pruneScrollValue(value)
                if (pruned == null) {
                    hardResetScrollRestorationPersistedState(storage)
                    return
                }
                value = pruned
            }
            try {
                originalSetItem(key, value)
                return
            } catch {
                const pruned = pruneScrollValue(value)
                if (pruned && pruned !== value) {
                    try {
                        originalSetItem(key, pruned)
                        return
                    } catch {
                        // fall through
                    }
                }
                hardResetScrollRestorationPersistedState(storage)
                return
            }
        }

        try {
            originalSetItem(key, value)
        } catch (err) {
            // Last-ditch: free scroll cache and retry once for unrelated keys.
            hardResetScrollRestorationPersistedState(storage)
            try {
                originalSetItem(key, value)
            } catch {
                throw err
            }
        }
    }
    storage.setItem = wrappedSetItem
    guarded[GUARD_MARKER] = true
    return () => {
        if (storage.setItem === wrappedSetItem) {
            storage.setItem = rawSetItem
            delete guarded[GUARD_MARKER]
        }
    }
}
