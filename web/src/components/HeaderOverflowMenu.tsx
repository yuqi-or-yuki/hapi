import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'

export type HeaderOverflowMenuItem = {
    key: string
    icon: ReactNode
    label: string
    onClick: () => void
}

type HeaderOverflowMenuProps = {
    isOpen: boolean
    onClose: () => void
    triggerRef: RefObject<HTMLElement | null>
    items: HeaderOverflowMenuItem[]
}

type MenuPosition = {
    top: number
    right: number
}

/**
 * Right-aligned dropdown anchored under a trigger button — same positioning/
 * accessibility approach as SessionActionMenu (clamp to viewport, click-outside
 * and Escape to close, focus the first item on open), simplified for a fixed
 * icon+label action list rather than session-specific conditional items.
 */
export function HeaderOverflowMenu(props: HeaderOverflowMenuProps) {
    const { isOpen, onClose, triggerRef, items } = props
    const menuRef = useRef<HTMLDivElement | null>(null)
    const [position, setPosition] = useState<MenuPosition | null>(null)

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current
        const menuEl = menuRef.current
        if (!trigger || !menuEl) return

        const triggerRect = trigger.getBoundingClientRect()
        const menuRect = menuEl.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const padding = 8
        const gap = 6

        const spaceBelow = viewportHeight - triggerRect.bottom
        const openAbove = spaceBelow < menuRect.height + gap && triggerRect.top > spaceBelow

        const top = openAbove
            ? triggerRect.top - menuRect.height - gap
            : triggerRect.bottom + gap
        const right = viewportWidth - triggerRect.right

        setPosition({
            top: Math.min(Math.max(top, padding), viewportHeight - menuRect.height - padding),
            right: Math.min(Math.max(right, padding), viewportWidth - menuRect.width - padding)
        })
    }, [triggerRef])

    useLayoutEffect(() => {
        if (!isOpen) return
        updatePosition()
    }, [isOpen, updatePosition])

    useEffect(() => {
        if (!isOpen) {
            setPosition(null)
            return
        }

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (menuRef.current?.contains(target)) return
            if (triggerRef.current?.contains(target)) return
            onClose()
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose()
            }
        }

        const handleReflow = () => updatePosition()

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', handleReflow)
        window.addEventListener('scroll', handleReflow, true)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', handleReflow)
            window.removeEventListener('scroll', handleReflow, true)
        }
    }, [isOpen, onClose, triggerRef, updatePosition])

    useEffect(() => {
        if (!isOpen) return
        const frame = window.requestAnimationFrame(() => {
            const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
            firstItem?.focus()
        })
        return () => window.cancelAnimationFrame(frame)
    }, [isOpen])

    if (!isOpen) return null

    const menuStyle: CSSProperties | undefined = position
        ? { top: position.top, right: position.right }
        : { top: -9999, right: -9999 }

    return (
        <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 min-w-[180px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            {items.map((item) => (
                <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    onClick={() => {
                        onClose()
                        item.onClick()
                    }}
                >
                    <span className="text-[var(--app-hint)]">{item.icon}</span>
                    {item.label}
                </button>
            ))}
        </div>
    )
}
