import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'

function normalizeServer(server: string): string {
    return server.replace(/\/+$/, '')
}

function buildSessionUrl(baseUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, baseUrl).toString()
    } catch {
        const normalized = baseUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

export class NtfyChannel implements NotificationChannel {
    constructor(
        private readonly server: string,
        private readonly topic: string,
        private readonly publicUrl: string
    ) {}

    async sendReady(_session: Session): Promise<void> {}

    async sendPermissionRequest(_session: Session): Promise<void> {}

    async sendTaskNotification(_session: Session, _notification: TaskNotification): Promise<void> {}

    async sendSessionCompletion(session: Session): Promise<void> {
        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send({
            title: 'HAPI done',
            body: `${agentName} finished: ${name}\n${url}`,
            tags: 'white_check_mark'
        })
    }

    async sendAllClear(session: Session): Promise<void> {
        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send({
            title: 'HAPI all clear',
            body: `All running sessions are finished.\n\nLast finished: ${agentName} · ${name}\n\n${url}`,
            tags: 'white_check_mark,bell'
        })
    }

    private async send(payload: { title: string; body: string; tags?: string; priority?: 'min' | 'low' | 'default' | 'high' | 'urgent' }): Promise<void> {
        const response = await fetch(`${normalizeServer(this.server)}/${encodeURIComponent(this.topic)}`, {
            method: 'POST',
            headers: {
                title: payload.title,
                tags: payload.tags ?? '',
                priority: payload.priority ?? 'default'
            },
            body: payload.body
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`ntfy send failed: HTTP ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`)
        }
    }
}
