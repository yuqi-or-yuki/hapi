import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSidebarCollapse } from './useSidebarCollapse'

describe('useSidebarCollapse', () => {
    beforeEach(() => localStorage.clear())

    it('starts unfolded and persists the folded state', () => {
        const { result } = renderHook(() => useSidebarCollapse())
        expect(result.current.collapsed).toBe(false)

        act(() => result.current.toggle())
        expect(result.current.collapsed).toBe(true)
        expect(localStorage.getItem('hapi-sidebar-collapsed')).toBe('1')

        const reopened = renderHook(() => useSidebarCollapse())
        expect(reopened.result.current.collapsed).toBe(true)
    })

    it('toggles on Cmd/Ctrl+B', () => {
        const { result } = renderHook(() => useSidebarCollapse())

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
        })
        expect(result.current.collapsed).toBe(true)

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
        })
        expect(result.current.collapsed).toBe(false)
    })

    it('leaves a plain "b" and a typed Cmd+B alone', () => {
        const { result } = renderHook(() => useSidebarCollapse())

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
        })
        expect(result.current.collapsed).toBe(false)

        const input = document.createElement('input')
        document.body.appendChild(input)
        input.focus()
        act(() => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))
        })
        expect(result.current.collapsed).toBe(false)
        input.remove()
    })
})
