import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useShowActiveSessionsOnly } from './useShowActiveSessionsOnly'

afterEach(() => {
    cleanup()
    localStorage.clear()
})

it('keeps mounted controls in sync and persists changes across remounts', () => {
    const list = renderHook(() => useShowActiveSessionsOnly())
    const settings = renderHook(() => useShowActiveSessionsOnly())

    act(() => list.result.current.setShowActiveSessionsOnly(true))
    expect(settings.result.current.showActiveSessionsOnly).toBe(true)

    const remounted = renderHook(() => useShowActiveSessionsOnly())
    expect(remounted.result.current.showActiveSessionsOnly).toBe(true)

    act(() => settings.result.current.setShowActiveSessionsOnly(false))
    expect(list.result.current.showActiveSessionsOnly).toBe(false)
    expect(remounted.result.current.showActiveSessionsOnly).toBe(false)
    expect(localStorage.getItem('hapi-show-active-sessions-only')).toBeNull()
})
