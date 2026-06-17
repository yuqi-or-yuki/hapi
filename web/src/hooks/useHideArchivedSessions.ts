import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-hide-archived-sessions'
const CHANGED_EVENT = 'hapi-hide-archived-sessions-changed'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function readStorage(): boolean {
    if (!isBrowser()) return false
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

function writeStorage(value: boolean): void {
    if (!isBrowser()) return
    try {
        if (value) {
            localStorage.setItem(STORAGE_KEY, 'true')
        } else {
            localStorage.removeItem(STORAGE_KEY)
        }
    } catch {
        // ignore
    }
}

export function useHideArchivedSessions(): {
    hideArchivedSessions: boolean
    setHideArchivedSessions: (value: boolean) => void
} {
    const [hideArchivedSessions, setHideArchivedSessionsState] = useState<boolean>(readStorage)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== STORAGE_KEY) return
            setHideArchivedSessionsState(event.newValue === 'true')
        }

        const onLocalChange = (event: Event) => {
            if (event instanceof CustomEvent && typeof event.detail === 'boolean') {
                setHideArchivedSessionsState(event.detail)
            }
        }

        window.addEventListener('storage', onStorage)
        window.addEventListener(CHANGED_EVENT, onLocalChange)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(CHANGED_EVENT, onLocalChange)
        }
    }, [])

    const setHideArchivedSessions = useCallback((value: boolean) => {
        setHideArchivedSessionsState(value)
        writeStorage(value)
        if (isBrowser()) {
            window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: value }))
        }
    }, [])

    return { hideArchivedSessions, setHideArchivedSessions }
}
