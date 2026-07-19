import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-hide-archived-sessions'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try { return localStorage.getItem(key) } catch { return null }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try { localStorage.setItem(key, value) } catch { /* ignore */ }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try { localStorage.removeItem(key) } catch { /* ignore */ }
}

export function getInitialHideArchivedSessions(): boolean {
    return safeGetItem(STORAGE_KEY) === 'true'
}

export function useHideArchivedSessions(): {
    hideArchivedSessions: boolean
    setHideArchivedSessions: (value: boolean) => void
} {
    const [hideArchivedSessions, setHideArchivedSessionsState] = useState<boolean>(getInitialHideArchivedSessions)

    useEffect(() => {
        if (!isBrowser()) return
        const onStorage = (event: StorageEvent) => {
            if (event.key !== STORAGE_KEY) return
            setHideArchivedSessionsState(event.newValue === 'true')
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setHideArchivedSessions = useCallback((value: boolean) => {
        setHideArchivedSessionsState(value)
        if (value) {
            safeSetItem(STORAGE_KEY, 'true')
        } else {
            safeRemoveItem(STORAGE_KEY)
        }
    }, [])

    return { hideArchivedSessions, setHideArchivedSessions }
}
