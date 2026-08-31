import { createContext, useContext, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { AgentDoneRing } from '@/lib/agentDoneSound'

type AppContextValue = {
    api: ApiClient
    token: string
    baseUrl: string
    agentDoneSoundMuted: boolean
    setAgentDoneSoundMuted: (muted: boolean) => void
    agentDoneRing: AgentDoneRing
    setAgentDoneRing: (ring: AgentDoneRing) => void
    allDoneRing: AgentDoneRing
    setAllDoneRing: (ring: AgentDoneRing) => void
    previewAgentDoneRing: (ring?: AgentDoneRing) => void
    unreadDoneOrders: Record<string, number>
    clearUnreadDone: (sessionId: string) => void
    titleSuggestionAvailable?: boolean
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppContextProvider(props: {
    value: AppContextValue
    children: ReactNode
}) {
    return (
        <AppContext.Provider value={props.value}>
            {props.children}
        </AppContext.Provider>
    )
}

export function useAppContext(): AppContextValue {
    const context = useContext(AppContext)
    if (!context) {
        throw new Error('AppContext is not available')
    }
    return context
}
