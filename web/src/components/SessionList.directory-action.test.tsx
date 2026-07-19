import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionList } from './SessionList'

afterEach(() => cleanup())

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        model: null,
        effort: null,
        loopActive: false,
        debateActive: false,
        scheduledDueAts: [],
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        }
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                {children}
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SessionList directory action', () => {
    it('starts a new session with the project machine and directory', () => {
        const onNewSessionInDirectory = vi.fn()
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: 'Greeting',
                flavor: 'codex',
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={onNewSessionInDirectory}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))

        expect(onNewSessionInDirectory).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/home/ubuntu',
        })
    })

    it('hides the directory action for sessions without path metadata', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({ id: 'session-without-path' })]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        expect(screen.queryByRole('button', { name: 'New session in this directory' })).toBeNull()
    })
})

describe('SessionList keyboard safety', () => {
    it('prevents Cmd+Delete on a focused session item from bubbling into destructive shortcuts', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({
                    id: 'session-1',
                    active: true,
                    updatedAt: Date.now(),
                    metadata: {
                        path: '/home/ubuntu',
                        machineId: 'machine-1',
                        name: 'Focused session',
                        flavor: 'codex',
                    }
                })]}
                selectedSessionId="session-1"
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        const sessionButton = screen.getByText('Focused session').closest('button')
        expect(sessionButton).not.toBeNull()

        expect(fireEvent.keyDown(sessionButton!, { key: 'Backspace', metaKey: true })).toBe(false)
        expect(fireEvent.keyDown(sessionButton!, { key: 'Delete', metaKey: true })).toBe(false)
    })

    it('keeps Cmd+Delete usable inside the session search field', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({
                    id: 'session-1',
                    active: true,
                    updatedAt: Date.now(),
                    metadata: {
                        path: '/home/ubuntu',
                        machineId: 'machine-1',
                        name: 'Searchable session',
                        flavor: 'codex',
                    }
                })]}
                selectedSessionId="session-1"
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        const search = screen.getByPlaceholderText('Search sessions…')
        expect(fireEvent.keyDown(search, { key: 'Backspace', metaKey: true })).toBe(true)
    })
})

    it('opens archive confirmation with the browser-friendly E shortcut on a focused active session', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({
                    id: 'session-archive-shortcut',
                    active: true,
                    updatedAt: Date.now(),
                    metadata: {
                        path: '/home/ubuntu',
                        machineId: 'machine-1',
                        name: 'Archive shortcut session',
                        flavor: 'codex',
                    }
                })]}
                selectedSessionId="session-archive-shortcut"
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        const sessionButton = screen.getByText('Archive shortcut session').closest('button')
        expect(sessionButton).not.toBeNull()

        expect(fireEvent.keyDown(sessionButton!, { key: 'e' })).toBe(false)
        expect(screen.getByText('Archive Session')).toBeTruthy()
    })
