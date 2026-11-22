import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-sidebar-collapsed'

function loadCollapsed(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        // Private windows and blocked site data throw on access; an unfolded
        // sidebar is the safe default because the rail can always refold it.
        return false
    }
}

/**
 * Folded state of the session sidebar on the split (desktop/tablet) layout.
 *
 * Only meaningful at the `split` breakpoint and up: below it the sidebar *is*
 * the page, so folding it would leave nothing behind. Persisted per browser.
 */
export function useSidebarCollapse() {
    const [collapsed, setCollapsed] = useState(loadCollapsed)

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
        } catch {
            // Non-persisting browsers still get the in-memory state.
        }
    }, [collapsed])

    const toggle = useCallback(() => setCollapsed((value) => !value), [])

    // Cmd/Ctrl+B is the near-universal "toggle sidebar" binding (VS Code,
    // Linear, Slack). Ignored while typing so it can't eat a bold shortcut
    // or a literal "b" in the composer.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'b' && event.key !== 'B') return
            if (!event.metaKey && !event.ctrlKey) return
            if (event.altKey) return
            const target = event.target as HTMLElement | null
            if (target?.isContentEditable) return
            const tag = target?.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
            event.preventDefault()
            setCollapsed((value) => !value)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])

    return { collapsed, toggle, setCollapsed }
}
