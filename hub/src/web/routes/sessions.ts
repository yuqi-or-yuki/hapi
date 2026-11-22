import {
    CursorMigrateToAcpRequestSchema,
    DeleteUploadRequestSchema,
    ForkConversationRequestSchema,
    getPermissionModesForFlavor,
    isPermissionModeAllowedForFlavor,
    RenameSessionRequestSchema,
    SetSessionPinnedRequestSchema,
    SetSessionSwarmRequestSchema,
    UpsertWorkerRecordsRequestSchema,
    ResumeSessionRequestSchema,
    RewindConversationRequestSchema,
    SCRATCHLIST_MAX_ENTRIES,
    ScratchlistEntryCreateRequestSchema,
    ScratchlistEntryUpdateRequestSchema,
    SessionCollaborationModeRequestSchema,
    SessionCopilotAgentModeRequestSchema,
    SessionEffortRequestSchema,
    SessionModelReasoningEffortRequestSchema,
    SessionServiceTierRequestSchema,
    SessionModelRequestSchema,
    SessionPermissionModeRequestSchema,
    UpdateSessionSummaryRequestSchema,
    supportsModelChange,
    supportsEffort,
    toSessionSummary,
    UploadFileRequestSchema
} from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { SlashCommand, SwarmScheduleRequest } from '@hapi/protocol/apiTypes'
import type { SwarmMembership, WorkerRun, WorkerRunEvent } from '@hapi/protocol'
import type { ScheduledMessageHistoryRow, WorkerRecord } from '../../store'
import { isTalentBoard, unfilledCards } from '@hapi/protocol/workerReview'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { loadScratchlistAttachmentLimitsFromEnv } from '../../config/scratchlistAttachmentLimits'
import { validateScratchlistAttachmentsForWrite, scratchlistSessionBytesBeforeForPut } from '../../scratchlistAttachments/validate'
import { TitleSuggestionError } from '../../sync/titleSuggestion'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const reviewSchema = z.object({
    readyForReview: z.boolean()
})

const archiveSessionSchema = z.object({
    confirmed: z.literal(true)
})

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

function commandsFromMetadataSlashCommands(names: readonly string[] | undefined): SlashCommand[] {
    if (!names?.length) {
        return []
    }

    return names
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => ({
            name,
            source: 'builtin'
        }))
}

function mergeSlashCommands(
    primary: readonly SlashCommand[],
    fallback: readonly SlashCommand[]
): SlashCommand[] {
    const commandMap = new Map<string, SlashCommand>()
    for (const command of [...fallback, ...primary]) {
        commandMap.set(command.name, command)
    }
    return Array.from(commandMap.values())
}

function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

type WorkerBrief = Pick<SwarmMembership, 'job' | 'playbook' | 'review' | 'board'>

/**
 * What a worker is told on each scheduled run. Rebuilt whenever the worker is
 * edited, so the next run always carries the current job, playbook and review
 * state instead of whatever was true when the schedule was created.
 */
export function workerPrompt(worker: WorkerBrief): string {
    const parts = [`Scheduled run of your standing job: ${worker.job}`]
    if (worker.playbook) {
        parts.push(`Current playbook (this is how the job is done now; it replaces any earlier instructions in this conversation):\n${worker.playbook}`)
    }
    parts.push('Do this run now. Put every result on your board with `hapi worker record` (one row per item, a stable --key so reruns update rows instead of duplicating them; `hapi worker rows` shows what is already there).')
    if (worker.board?.columns?.includes('suggestedDecision') && worker.board.columns.includes('suggestedReason')) {
        parts.push('Item approval is enabled. Every card awaiting review must be prefilled: a name, suggestedDecision (yes or no) and an evidence-based suggestedReason (and bestFitRole on a talent board). The board rejects a write that leaves any such card unfilled, and the review stays closed while one is. Suggestion hit rate is measured per category, so set the item\'s category (the role on a talent board, a `category` field elsewhere). These are predictions, not user decisions or authorization to act. Read saved approvalReviews (or linkedinReviews on a talent board), process unhandled feedback without inventing preferences, and preserve all history. The dashboard tracks agreement only where the original prediction was captured.')
    }
    if (worker.review) {
        parts.push(`REVIEW PERIOD (${worker.review.runsLeft} more approved run${worker.review.runsLeft === 1 ? '' : 's'} before you run free): do the work and record the rows, but do not take any action that reaches outside this machine or cannot be undone (sending email or messages, posting, purchasing, deleting, pushing). Prepare those as drafts, list exactly what you would have done, and stop for review.`)
    }
    parts.push('Then report in a few lines what changed and anything that needs my attention.')
    return parts.join('\n\n')
}

/**
 * Create, re-time or remove the scheduled message behind a worker.
 * Returns the id the swarm record should point at.
 */
function applyWorkerSchedule(
    store: Store,
    namespace: string,
    sessionId: string,
    currentId: string | undefined,
    schedule: SwarmScheduleRequest | null,
    text: string
): string | undefined {
    if (schedule === null) {
        if (currentId) store.scheduledMessages.cancel(namespace, currentId)
        return undefined
    }
    const patch = { text, dueAt: schedule.firstRunAt, intervalMs: schedule.intervalMs, maxOccurrences: null, enabled: true }
    if (currentId && store.scheduledMessages.update(namespace, currentId, patch)) return currentId
    return store.scheduledMessages.create({ namespace, sourceSessionId: sessionId, cloneBeforeSend: false, ...patch }).id
}

/**
 * The review cards this write would leave unfilled. Rows are merged exactly as
 * the store merges them (a null field removes it), so the check judges the row
 * as it would be stored. Only the rows being written are judged: a write
 * cannot be blamed for some other row, and fixing one card is never blocked.
 */
export function unfilledAfterWrite(
    existing: readonly WorkerRecord[],
    writes: readonly { key: string; data: Record<string, unknown> }[],
    board: SwarmMembership['board']
): { key: string; missing: string[] }[] {
    const stored = new Map(existing.map((row) => [row.key, row.data]))
    const merged = new Map<string, Record<string, unknown>>()
    for (const write of writes) {
        const row = { ...(merged.get(write.key) ?? stored.get(write.key) ?? {}) }
        for (const [field, value] of Object.entries(write.data)) {
            if (value === null) delete row[field]
            else row[field] = value
        }
        merged.set(write.key, row)
    }
    return unfilledCards([...merged].map(([key, data]) => ({ key, data })), board)
}

/** The delivered and missed runs in a schedule's history, newest first. */
function recentRuns(history: readonly ScheduledMessageHistoryRow[]): WorkerRunEvent[] {
    return history
        .filter((entry) => entry.event === 'sent' || (entry.event === 'skipped' && entry.error?.startsWith('Missed')))
        .slice(0, 14)
        .map((entry) => entry.event === 'sent'
            ? { at: entry.createdAt, outcome: 'ran' as const, lateMs: Math.max(0, entry.createdAt - entry.dueAt) }
            : { at: entry.createdAt, outcome: 'missed' as const, lateMs: 0 })
}

export function createSessionsRoutes(getSyncEngine: () => SyncEngine | null, store?: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const getPendingCount = (s: Session) => s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0

        const namespace = c.get('namespace')
        const limitRaw = c.req.query('limit')
        const parsedLimit = limitRaw === undefined ? null : Number(limitRaw)
        const limit = parsedLimit !== null && Number.isFinite(parsedLimit)
            ? Math.min(500, Math.max(1, Math.floor(parsedLimit)))
            : null
        const order = c.req.query('order')

        let sessionRecords = engine.getSessionsByNamespace(namespace)
            .sort((a, b) => {
                // Peer discovery wants newest activity first before limit truncation.
                if (order === 'updatedAt') {
                    return b.updatedAt - a.updatedAt
                }
                if (Boolean(a.globalPinned) !== Boolean(b.globalPinned)) {
                    return a.globalPinned ? -1 : 1
                }
                if (Boolean(a.pinned) !== Boolean(b.pinned)) {
                    return a.pinned ? -1 : 1
                }
                // Active sessions first (web session list)
                if (a.active !== b.active) {
                    return a.active ? -1 : 1
                }
                // Within active sessions, sort by pending requests count
                const aPending = getPendingCount(a)
                const bPending = getPendingCount(b)
                if (a.active && aPending !== bPending) {
                    return bPending - aPending
                }
                // Then by updatedAt
                return b.updatedAt - a.updatedAt
            })
        if (limit !== null) {
            sessionRecords = sessionRecords.slice(0, limit)
        }

        const scheduledDueAtsBySessionId = new Map<string, number[]>()
        const workerRunByScheduleId = new Map<string, WorkerRun>()
        for (const m of store?.scheduledMessages.list(namespace, { status: 'pending' }) ?? []) {
            if (m.intervalMs) {
                workerRunByScheduleId.set(m.id, {
                    nextRunAt: m.dueAt,
                    intervalMs: m.intervalMs,
                    paused: !m.enabled,
                    lastRunAt: m.sentAt,
                    lastError: m.error,
                    recent: recentRuns(m.history)
                })
            }
            if (!m.enabled) continue
            const dueAts = scheduledDueAtsBySessionId.get(m.sourceSessionId)
            if (dueAts) {
                dueAts.push(m.dueAt)
            } else {
                scheduledDueAtsBySessionId.set(m.sourceSessionId, [m.dueAt])
            }
        }
        for (const dueAts of scheduledDueAtsBySessionId.values()) {
            dueAts.sort((a, b) => a - b)
        }

        const boardStats = store?.workerRecords.stats(namespace)
        const sessionIds = sessionRecords.map((session) => session.id)
        const scheduledCounts = engine.getFutureScheduledMessageCounts(sessionIds)
        const nextScheduledAt = engine.getNextScheduledAtBySessionIds(sessionIds)
        const sessions = sessionRecords.map((session) => ({
            ...toSessionSummary(session),
            scheduledDueAts: scheduledDueAtsBySessionId.get(session.id) ?? [],
            futureScheduledMessageCount: scheduledCounts.get(session.id) ?? 0,
            nextScheduledAt: nextScheduledAt.get(session.id) ?? null,
            workerBoard: boardStats?.get(session.id),
            workerRun: workerRunByScheduleId.get(session.metadata?.swarm?.scheduleId ?? '')
        }))

        return c.json({ sessions })
    })

    app.get('/sessions/:id/export', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const force = c.req.query('force') === 'true'
        const result = engine.getSessionExport(
            sessionResult.sessionId,
            sessionResult.session,
            { force }
        )
        if (result.type === 'too-large') {
            return c.json({
                type: 'too-large',
                error: 'Session export exceeds the resource limit',
                code: 'session_export_too_large',
                count: result.count,
                estimatedBytes: result.estimatedBytes,
                maxBytes: result.maxBytes
            }, 413)
        }
        if (result.type === 'warning') {
            return c.json(result)
        }

        return c.json(result.payload)
    })

    app.get('/sessions/:id', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        return c.json({ session: sessionResult.session })
    })

    app.get('/sessions/:id/cursor-chat-store', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const result = await engine.getCursorChatStoreStatus(
            sessionResult.sessionId,
            c.get('namespace')
        )
        if (result.type === 'error') {
            const status = result.code === 'session_not_found' ? 404
                : result.code === 'access_denied' ? 403
                    : result.code === 'resume_unavailable' ? 409
                        : result.code === 'no_machine_online' ? 503
                            : 502
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json(result.status)
    })

    app.post('/sessions/:id/resume', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = body ? ResumeSessionRequestSchema.safeParse(body) : { success: true as const, data: {} }
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const { permissionMode } = parsed.data
        if (permissionMode !== undefined) {
            const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
            if (!isPermissionModeAllowedForFlavor(permissionMode, flavor)) {
                return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
            }
        }

        const namespace = c.get('namespace')
        const result = await engine.resumeSession(
            sessionResult.sessionId,
            namespace,
            permissionMode !== undefined ? { permissionMode } : undefined
        )
        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : result.code === 'resume_unavailable' ? 409
                            : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.post('/sessions/:id/reopen', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: false })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const namespace = c.get('namespace')
        const result = await engine.reopenSession(sessionResult.sessionId, namespace)

        if (result.type === 'incomplete') {
            return c.json({ error: result.message, missing: result.missing }, 422)
        }

        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : result.code === 'resume_unavailable' ? 409
                            : result.code === 'metadata_conflict' ? 409
                                : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({
            ok: true,
            sessionId: result.sessionId,
            resumed: result.resumed,
            ...(result.cursorSessionProtocol ? { cursorSessionProtocol: result.cursorSessionProtocol } : {})
        })
    })

    app.post('/sessions/:id/upload', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = UploadFileRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const estimatedBytes = estimateBase64Bytes(parsed.data.content)
        if (estimatedBytes > MAX_UPLOAD_BYTES) {
            return c.json({ success: false, error: 'File too large (max 50MB)' }, 413)
        }

        try {
            const result = await engine.uploadFile(
                sessionResult.sessionId,
                parsed.data.filename,
                parsed.data.content,
                parsed.data.mimeType
            )
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to upload file'
            }, 500)
        }
    })

    app.post('/sessions/:id/upload/delete', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = DeleteUploadRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.deleteUploadFile(sessionResult.sessionId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete upload'
            }, 500)
        }
    })

    app.post('/sessions/:id/clone', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => ({})) as { model?: string | null }
        try {
            const namespace = c.get('namespace')
            const cloned = engine.cloneSession(sessionResult.sessionId, namespace, body.model ?? undefined)
            return c.json({ session: cloned })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Clone failed' }, 500)
        }
    })

    app.post('/sessions/:id/abort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.abortSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/fork', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const rawBody = await c.req.text()
        let body: unknown = {}
        if (rawBody.trim()) {
            try {
                body = JSON.parse(rawBody)
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400)
            }
        }
        const parsed = ForkConversationRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const result = await engine.forkConversation(
            sessionResult.sessionId,
            c.get('namespace'),
            parsed.data.messageLocalId
        )
        if (result.type === 'error') {
            return c.json({ error: result.message }, 409)
        }
        return c.json({ sessionId: result.sessionId })
    })

    app.post('/sessions/:id/rewind', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = RewindConversationRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const result = await engine.rewindConversation(
            sessionResult.sessionId,
            c.get('namespace'),
            parsed.data.messageLocalId
        )
        if (result.type === 'error') {
            return c.json({
                error: result.message,
                hydrateFailed: result.hydrateFailed === true
            }, result.hydrateFailed ? 500 : 409)
        }
        return c.json({ success: true as const })
    })

    app.post('/sessions/:id/archive', async (c) => {
        // tiann/hapi#916: relax the blanket `requireActive: true` guard so
        // the endpoint is idempotent for already-archived rows AND can clean
        // up split-brain rows after a hub-restart cascade (inactive in cache
        // but metadata.lifecycleState still 'running'). Normal inactive rows
        // that are not archived (completed stubs, UI Delete/Reopen targets)
        // keep the old 409 contract.
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const body = await c.req.json().catch(() => ({}))
        const parsed = archiveSessionSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Archive requires explicit confirmation' }, 400)
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const lifecycleState = sessionResult.session.metadata?.lifecycleState
        if (!sessionResult.session.active && lifecycleState === 'archived') {
            return c.json({ ok: true, alreadyArchived: true })
        }

        if (!sessionResult.session.active && lifecycleState !== 'running') {
            return c.json({ error: 'Session is inactive' }, 409)
        }

        await engine.archiveSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/migrate-to-acp', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Codex #34 P2 (round 13): `c.req.json().catch(() => ({}))` silently
        // converts malformed JSON into an empty object — which then passes
        // CursorMigrateToAcpRequestSchema (all fields optional) and runs
        // the migration with DESTRUCTIVE defaults (keepSource defaults to
        // remove-after-flip). An operator who intended `{"keepSource": true}`
        // but sent a truncated body would see the legacy store removed
        // anyway. Distinguish "no body at all" (defaults are fine) from
        // "malformed JSON" (reject with 400).
        const rawBody = await c.req.text()
        let body: unknown = {}
        if (rawBody.trim().length > 0) {
            try {
                body = JSON.parse(rawBody)
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400)
            }
        }
        const parsed = CursorMigrateToAcpRequestSchema.safeParse(body ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
        }

        const namespace = c.get('namespace')
        const outcome = await engine.migrateLegacyCursorSession(
            sessionResult.sessionId,
            namespace,
            parsed.data
        )
        const status = outcome.ok ? 200
            : outcome.reason === 'already_acp' || outcome.reason === 'not_cursor_session' || outcome.reason === 'no_cursor_session_id' ? 409
                : outcome.reason === 'running_refused' ? 409
                    : outcome.reason === 'target_already_exists' ? 409
                        : outcome.reason === 'no_legacy_store_on_disk' ? 404
                            : 500
        return c.json(outcome, status)
    })

    app.post('/sessions/:id/switch', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.switchSession(sessionResult.sessionId, 'remote')
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/permission-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionPermissionModeRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        const mode = parsed.data.mode

        const allowedModes = getPermissionModesForFlavor(flavor)
        if (allowedModes.length === 0) {
            return c.json({ error: 'Permission mode not supported for session flavor' }, 400)
        }

        if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
            return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
        }
        if (flavor === 'opencode' && mode === 'plan' && sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'OpenCode plan mode is only supported for remote sessions' }, 409)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { permissionMode: mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply permission mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/collaboration-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex') {
            return c.json({ error: 'Collaboration mode is only supported for Codex sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Collaboration mode can only be changed for remote Codex sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionCollaborationModeRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { collaborationMode: parsed.data.mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply collaboration mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/copilot-agent-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'copilot') {
            return c.json({ error: 'Copilot agent mode is only supported for Copilot sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Copilot agent mode can only be changed for remote Copilot sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionCopilotAgentModeRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { copilotAgentMode: parsed.data.mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply Copilot agent mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/model', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionModelRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!supportsModelChange(flavor)) {
            return c.json({ error: 'Model selection is not supported for this session' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            if (flavor === 'codex') {
                return c.json({ error: 'Model selection can only be changed for remote Codex sessions' }, 409)
            }
            if (flavor === 'cursor') {
                return c.json({ error: 'Model selection can only be changed for remote Cursor sessions' }, 409)
            }
            if (flavor === 'grok') {
                return c.json({ error: 'Model selection can only be changed for remote Grok sessions' }, 409)
            }
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { model: parsed.data.model })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply model'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/model-reasoning-effort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex' && flavor !== 'opencode') {
            return c.json({ error: 'Model reasoning effort is only supported for Codex and OpenCode sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Model reasoning effort can only be changed for remote sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionModelReasoningEffortRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, {
                modelReasoningEffort: parsed.data.modelReasoningEffort
            })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply model reasoning effort'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/effort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionEffortRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!supportsEffort(flavor)) {
            return c.json({ error: 'Effort selection is not supported for this session type' }, 400)
        }
        if (flavor === 'grok' && sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Effort can only be changed for remote Grok sessions' }, 409)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { effort: parsed.data.effort })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply effort'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/service-tier', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex') {
            return c.json({ error: 'Fast mode is only supported for Codex sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Fast mode can only be changed for remote sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionServiceTierRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, {
                serviceTier: parsed.data.serviceTier
            })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply service tier'
            return c.json({ error: message }, 409)
        }
    })

    app.patch('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = RenameSessionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: name is required' }, 400)
        }

        try {
            await engine.renameSession(sessionResult.sessionId, parsed.data.name)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to rename session'
            // Map concurrency/version errors to 409 conflict
            if (message.includes('concurrently') || message.includes('version')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.post('/sessions/:id/title-suggestion', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        try {
            const title = await engine.suggestSessionTitle(sessionResult.sessionId)
            return c.json({ title })
        } catch (error) {
            if (error instanceof TitleSuggestionError) {
                return c.json({ error: error.message }, error.status)
            }
            return c.json({ error: 'Failed to generate a session title' }, 502)
        }
    })

    app.patch('/sessions/:id/summary', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = UpdateSessionSummaryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: text is required' }, 400)
        }

        try {
            await engine.updateSessionSummary(sessionResult.sessionId, parsed.data.text)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update session summary'
            if (message.includes('concurrently') || message.includes('version')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.patch('/sessions/:id/review', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = reviewSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: readyForReview boolean is required' }, 400)
        }

        try {
            await engine.setSessionReadyForReview(sessionResult.sessionId, parsed.data.readyForReview)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update review state'
            return c.json({ error: message }, 500)
        }
    })

    app.put('/sessions/:id/swarm', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const body = await c.req.json().catch(() => null)
        const parsed = SetSessionSwarmRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: job must be a non-empty string, or null to retire the worker' }, 400)
        }

        try {
            const current = sessionResult.session.metadata?.swarm
            const { job, schedule } = parsed.data
            if (job === null) {
                if (current?.scheduleId) store?.scheduledMessages.cancel(c.get('namespace'), current.scheduleId)
                await engine.setSessionSwarm(sessionResult.sessionId, null)
                return c.json({ ok: true })
            }

            const { name, playbook, reviewRuns } = parsed.data
            const worker = {
                job,
                name: name === undefined ? current?.name : name || undefined,
                avatarSeed: parsed.data.avatarSeed ?? current?.avatarSeed,
                playbook: playbook === undefined ? current?.playbook : playbook || undefined,
                review: reviewRuns === undefined ? current?.review : reviewRuns > 0 ? { runsLeft: reviewRuns } : undefined,
                board: parsed.data.board ?? current?.board,
                activeWindow: parsed.data.activeWindow === undefined ? current?.activeWindow : parsed.data.activeWindow ?? undefined
            }
            const text = workerPrompt(worker)
            const namespace = c.get('namespace')

            let scheduleId = current?.scheduleId
            if (schedule !== undefined) {
                if (!store) return c.json({ error: 'Schedules are unavailable' }, 503)
                scheduleId = applyWorkerSchedule(store, namespace, sessionResult.sessionId, scheduleId, schedule, text)
            } else if (scheduleId) {
                // Editing the job, playbook or review state never touches the
                // clock: the same schedule keeps running with the new brief.
                store?.scheduledMessages.update(namespace, scheduleId, { text })
            }

            if (scheduleId && worker.activeWindow) store?.scheduledMessages.alignToWindow(scheduleId, worker.activeWindow)

            await engine.setSessionSwarm(sessionResult.sessionId, { ...worker, scheduleId })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update swarm membership'
            return c.json({ error: message }, 500)
        }
    })

    app.get('/sessions/:id/worker-records', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        return c.json({ records: store?.workerRecords.list(c.get('namespace'), sessionResult.sessionId) ?? [], reviewHistory: store?.workerRecords.reviewHistory(c.get('namespace'), sessionResult.sessionId) ?? [] })
    })

    app.post('/sessions/:id/worker-records', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult
        if (!store) return c.json({ error: 'Boards are unavailable' }, 503)
        if (!sessionResult.session.metadata?.swarm) {
            return c.json({ error: 'This session is not a swarm worker; promote it first' }, 409)
        }

        const parsed = UpsertWorkerRecordsRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: expected { records: [{ key, data: { field: value } }] }' }, 400)
        }
        const invalid = unfilledAfterWrite(
            store.workerRecords.list(c.get('namespace'), sessionResult.sessionId),
            parsed.data.records,
            sessionResult.session.metadata.swarm.board
        )
        if (invalid.length > 0) {
            // All or nothing: one unfilled card makes the batch invalid, so nothing is saved.
            const listed = invalid.slice(0, 10).map((card) => `${card.key} (${card.missing.join(', ')})`).join('; ')
            return c.json({
                error: `Rejected, nothing was saved: ${invalid.length} review card(s) are not prefilled. Every card awaiting review needs a name, suggestedDecision ("yes" or "no") and a suggestedReason${isTalentBoard(sessionResult.session.metadata.swarm.board) ? ', plus bestFitRole' : ''}. Missing: ${listed}${invalid.length > 10 ? '; …' : ''}`
            }, 400)
        }

        try {
            const count = store.workerRecords.upsert(c.get('namespace'), sessionResult.sessionId, parsed.data.records)
            return c.json({ ok: true, count })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to save rows' }, 400)
        }
    })

    app.delete('/sessions/:id/worker-records/:key', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const removed = store?.workerRecords.remove(c.get('namespace'), sessionResult.sessionId, c.req.param('key')) ?? false
        return removed ? c.json({ ok: true }) : c.json({ error: 'Row not found' }, 404)
    })

    app.put('/sessions/:id/pin', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const body = await c.req.json().catch(() => null)
        const parsed = SetSessionPinnedRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: mode must be none, project, or global' }, 400)
        }

        engine.setSessionPinMode(sessionResult.sessionId, parsed.data.mode)
        return c.json({ ok: true })
    })

    app.delete('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        if (sessionResult.session.active) {
            return c.json({ error: 'Cannot delete active session. Archive it first.' }, 409)
        }

        try {
            await engine.deleteSession(sessionResult.sessionId)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to delete session'
            // Map "active session" error to 409 conflict (race condition: session became active)
            if (message.includes('active')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    /*
     * Scratchlist v2 (tiann/hapi#893).
     *
     * Operator-private notes attached to a session. All four routes use
     * the existing `requireSessionFromParam` guard so the same auth /
     * namespace check applies as every other session-scoped route -
     * scratchlist contents must NOT leak across namespaces, and a 403 /
     * 404 is returned for sessions the caller cannot access.
     *
     * SSE: every successful mutation emits a `session-updated` patch
     * carrying `scratchlistUpdatedAt` (handled in `SyncEngine`). The web
     * client uses that as a cache-invalidation token to refetch GET.
     */

    app.get('/sessions/:id/scratchlist/limits', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        return c.json({ limits: loadScratchlistAttachmentLimitsFromEnv() })
    })

    app.post('/sessions/:id/scratchlist/upload', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = UploadFileRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const result = await engine.uploadScratchlistAttachment(
            sessionResult.sessionId,
            namespace,
            parsed.data.filename,
            parsed.data.content,
            parsed.data.mimeType
        )
        if (!result.success) {
            const status = result.code === 'scratchlist_attachment_too_large' ? 413 : 400
            return c.json({ success: false, error: result.error, code: result.code }, status)
        }
        return c.json({ success: true, attachment: result.attachment })
    })

    app.get('/sessions/:id/scratchlist/attachments/:attachmentId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const attachmentId = c.req.param('attachmentId')
        if (!attachmentId) {
            return c.json({ error: 'Missing attachmentId' }, 400)
        }

        const entries = engine.listScratchlistEntries(sessionResult.sessionId)
        const match = entries
            .flatMap((entry) => entry.attachments)
            .find((att) => att.id === attachmentId)
        if (!match) {
            return c.json({ error: 'Attachment not found' }, 404)
        }

        const file = await engine.readScratchlistAttachment(match.path)
        if (!file) {
            return c.json({ error: 'Attachment file missing' }, 404)
        }
        return new Response(file.buffer, {
            headers: {
                'Content-Type': match.mimeType,
                // Defense in depth: metadata may predate resolve-time canonicalize.
                'Content-Disposition': `inline; filename="${match.filename.replace(/[\r\n\0"\\]/g, '_')}"`,
            },
        })
    })

    app.get('/sessions/:id/scratchlist', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const entries = engine.listScratchlistEntries(sessionResult.sessionId)
        return c.json({ entries })
    })

    app.post('/sessions/:id/scratchlist', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = ScratchlistEntryCreateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
        }

        // Idempotent-retry short-circuit (HAPI Bot, PR #896 review):
        // when the caller supplies an explicit entryId AND that id
        // already exists, return the canonical row with 200 BEFORE the
        // cap check fires. Otherwise a session sitting at the
        // 200-entry cap would 409 a duplicate POST that should be a
        // no-op - which is exactly the path the localStorage migration
        // retry uses after a partial failure.
        if (parsed.data.entryId) {
            const existing = engine.getScratchlistEntry(
                sessionResult.sessionId,
                parsed.data.entryId
            )
            if (existing) {
                return c.json({ entry: existing }, 200)
            }
        }

        // Server-side cap enforcement. Mirrors the web-side cap so a
        // malicious / runaway client can't drive the table without
        // bound. Bypassing the optimistic add path on the web client
        // (e.g. direct REST call) hits this guard. Bumped only with the
        // shared SCRATCHLIST_MAX_ENTRIES constant.
        const currentCount = engine.countScratchlistEntries(sessionResult.sessionId)
        if (currentCount >= SCRATCHLIST_MAX_ENTRIES) {
            return c.json({
                error: `Scratchlist is at its ${SCRATCHLIST_MAX_ENTRIES}-entry cap`,
                code: 'scratchlist_at_cap'
            }, 409)
        }

        const limits = loadScratchlistAttachmentLimitsFromEnv()
        const namespace = c.get('namespace')
        const checked = await engine.resolveScratchlistAttachmentsForSession(
            sessionResult.sessionId,
            namespace,
            parsed.data.attachments
        )
        if (!checked.ok) {
            return c.json({ error: checked.error, code: 'scratchlist_attachment_invalid' }, 400)
        }
        const diskBytes = await engine.sumScratchlistAttachmentBytesOnDisk(sessionResult.sessionId, namespace)
        const entryBytes = checked.attachments.reduce((sum, att) => sum + att.size, 0)
        // Files are already on disk from upload; don't double-count them.
        const sessionBytesBefore = Math.max(0, diskBytes - entryBytes)
        const attachmentValidation = validateScratchlistAttachmentsForWrite(
            checked.attachments,
            limits,
            sessionBytesBefore
        )
        if (!attachmentValidation.ok) {
            return c.json({ error: attachmentValidation.error, code: attachmentValidation.code }, 400)
        }

        const result = engine.createScratchlistEntry(
            sessionResult.sessionId,
            parsed.data.text.trim(),
            {
                entryId: parsed.data.entryId,
                createdAt: parsed.data.createdAt,
                attachments: checked.attachments,
            }
        )
        if (result.outcome === 'session-not-found') {
            return c.json({ error: 'Session not found' }, 404)
        }
        // `duplicate` (same entryId already exists) returns 200 with the
        // canonical row so the migration path can retry idempotently.
        // The web client treats 200-with-existing as success either way.
        return c.json({ entry: result.entry }, result.outcome === 'created' ? 201 : 200)
    })

    app.put('/sessions/:id/scratchlist/:entryId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const entryId = c.req.param('entryId')
        if (!entryId) {
            return c.json({ error: 'Missing entryId' }, 400)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = ScratchlistEntryUpdateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
        }

        const existing = engine.getScratchlistEntry(sessionResult.sessionId, entryId)
        if (!existing) {
            return c.json({ error: 'Scratchlist entry not found' }, 404)
        }

        const nextText = parsed.data.text !== undefined ? parsed.data.text.trim() : existing.text
        const namespace = c.get('namespace')
        let nextAttachments = existing.attachments
        if (parsed.data.attachments !== undefined) {
            const checked = await engine.resolveScratchlistAttachmentsForSession(
                sessionResult.sessionId,
                namespace,
                parsed.data.attachments
            )
            if (!checked.ok) {
                return c.json({ error: checked.error, code: 'scratchlist_attachment_invalid' }, 400)
            }
            nextAttachments = checked.attachments
        }
        if (nextText.trim().length === 0 && nextAttachments.length === 0) {
            return c.json({
                error: 'Scratchlist entry requires text or attachments',
                code: 'scratchlist_entry_empty',
            }, 400)
        }
        const limits = loadScratchlistAttachmentLimitsFromEnv()
        const diskBytes = await engine.sumScratchlistAttachmentBytesOnDisk(sessionResult.sessionId, namespace)
        const removedAttachments = existing.attachments.filter(
            (old) => !nextAttachments.some((next) => next.id === old.id)
        )
        const sessionBytesBefore = scratchlistSessionBytesBeforeForPut(
            diskBytes,
            nextAttachments,
            removedAttachments,
        )
        const attachmentValidation = validateScratchlistAttachmentsForWrite(
            nextAttachments,
            limits,
            sessionBytesBefore
        )
        if (!attachmentValidation.ok) {
            return c.json({ error: attachmentValidation.error, code: attachmentValidation.code }, 400)
        }

        const updated = engine.updateScratchlistEntry(
            sessionResult.sessionId,
            entryId,
            {
                text: nextText,
                attachments: nextAttachments,
            }
        )
        if (!updated) {
            return c.json({ error: 'Scratchlist entry not found' }, 404)
        }
        if (removedAttachments.length > 0) {
            const remainingIds = new Set(
                engine
                    .listScratchlistEntries(sessionResult.sessionId)
                    .flatMap((entry) => entry.attachments.map((att) => att.id))
            )
            const orphaned = removedAttachments.filter((att) => !remainingIds.has(att.id))
            if (orphaned.length > 0) {
                void import('../../scratchlistAttachments/storage').then(({ deleteScratchlistAttachmentFiles, getHapiHomeDir }) =>
                    deleteScratchlistAttachmentFiles(getHapiHomeDir(), orphaned)
                )
            }
        }
        return c.json({ entry: updated })
    })

    app.delete('/sessions/:id/scratchlist/attachments/:attachmentId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const attachmentId = c.req.param('attachmentId')
        if (!attachmentId) {
            return c.json({ error: 'Missing attachmentId' }, 400)
        }

        const entries = engine.listScratchlistEntries(sessionResult.sessionId)
        const stillReferenced = entries.some((entry) =>
            entry.attachments.some((att) => att.id === attachmentId)
        )
        if (stillReferenced) {
            return c.json({
                error: 'Attachment is still referenced by a scratchlist entry',
                code: 'scratchlist_attachment_in_use',
            }, 409)
        }

        const removed = await engine.deleteScratchlistAttachmentById(
            sessionResult.sessionId,
            c.get('namespace'),
            attachmentId
        )
        if (!removed) {
            return c.json({ error: 'Attachment not found' }, 404)
        }
        return c.json({ ok: true })
    })

    app.delete('/sessions/:id/scratchlist/:entryId', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const entryId = c.req.param('entryId')
        if (!entryId) {
            return c.json({ error: 'Missing entryId' }, 400)
        }
        const removed = engine.deleteScratchlistEntry(sessionResult.sessionId, entryId)
        if (!removed) {
            return c.json({ error: 'Scratchlist entry not found' }, 404)
        }
        return c.json({ ok: true })
    })

    app.get('/sessions/:id/slash-commands', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Session must exist but doesn't need to be active
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Get agent type from session metadata, default to 'claude'
        const agent = sessionResult.session.metadata?.flavor ?? 'claude'

        const metadataCommands = commandsFromMetadataSlashCommands(
            sessionResult.session.metadata?.slashCommands
        )

        try {
            const result = await engine.listSlashCommands(sessionResult.sessionId, agent)
            if (result.success && result.commands) {
                return c.json({
                    ...result,
                    commands: mergeSlashCommands(result.commands, metadataCommands)
                })
            }

            if (metadataCommands.length > 0) {
                return c.json({ success: true, commands: metadataCommands })
            }

            return c.json(result)
        } catch (error) {
            if (metadataCommands.length > 0) {
                return c.json({ success: true, commands: metadataCommands })
            }

            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list slash commands'
            })
        }
    })

    app.get('/sessions/:id/skills', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Session must exist but doesn't need to be active
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        try {
            const result = await engine.listSkills(
                sessionResult.sessionId,
                sessionResult.session.metadata?.flavor ?? 'claude'
            )
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list skills'
            })
        }
    })

    app.get('/sessions/:id/codex-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex') {
            return c.json({
                success: false,
                error: 'Codex models are only available for Codex sessions'
            }, 400)
        }

        try {
            const result = await engine.listCodexModelsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex models'
            }, 500)
        }
    })

    app.get('/sessions/:id/claude-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'claude') {
            return c.json({
                success: false,
                error: 'Claude models are only available for Claude sessions'
            }, 400)
        }

        try {
            const result = await engine.listClaudeModelsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Claude models'
            }, 500)
        }
    })

    app.get('/sessions/:id/opencode-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'opencode') {
            return c.json({
                success: false,
                error: 'OpenCode models are only available for OpenCode sessions'
            }, 400)
        }

        try {
            const result = await engine.listOpencodeModelsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode models'
            }, 500)
        }
    })

    app.get('/sessions/:id/blobs/:blobId', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const blobId = c.req.param('blobId')
        const blob = engine.getSessionBlob(sessionResult.sessionId, blobId)
        if (!blob) {
            return c.json({ error: 'Not found' }, 404)
        }

        const buffer = Buffer.from(blob.data, 'base64')
        return new Response(buffer, {
            headers: {
                'Content-Type': blob.mimeType,
                'Cache-Control': 'public, max-age=31536000, immutable'
            }
        })
    })

    app.get('/sessions/:id/opencode-reasoning-effort-options', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'opencode') {
            return c.json({
                success: false,
                error: 'OpenCode reasoning effort options are only available for OpenCode sessions'
            }, 400)
        }

        try {
            const result = await engine.listOpencodeReasoningEffortOptionsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode reasoning effort options'
            }, 500)
        }
    })

    app.get('/sessions/:id/grok-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'grok') {
            return c.json({ success: false, error: 'Grok models are only available for Grok sessions' }, 400)
        }
        try {
            return c.json(await engine.listGrokModelsForSession(sessionResult.sessionId))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok models'
            }, 500)
        }
    })

    app.get('/sessions/:id/grok-reasoning-effort-options', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'grok') {
            return c.json({ success: false, error: 'Grok effort options are only available for Grok sessions' }, 400)
        }
        try {
            return c.json(await engine.listGrokReasoningEffortOptionsForSession(sessionResult.sessionId))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok effort options'
            }, 500)
        }
    })

    app.get('/sessions/:id/copilot-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'copilot') {
            return c.json({ success: false, error: 'Copilot models are only available for Copilot sessions' }, 400)
        }
        try {
            return c.json(await engine.listCopilotModelsForSession(sessionResult.sessionId))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Copilot models'
            }, 500)
        }
    })

    app.get('/sessions/:id/cursor-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'cursor') {
            return c.json({
                success: false,
                error: 'Cursor models are only available for Cursor sessions'
            }, 400)
        }

        try {
            const result = await engine.listCursorModelsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Cursor models'
            }, 500)
        }
    })

    // Helper: guard + flavor check + error handling for Pi session endpoints
    async function withPiSession(
        c: Context<WebAppEnv>,
        handler: (ctx: { sessionId: string; engine: SyncEngine }) => Promise<Response>
    ): Promise<Response> {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'pi') {
            return c.json({ success: false, error: 'Not a Pi session' }, 400)
        }

        try {
            return await handler({ sessionId: sessionResult.sessionId, engine })
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Internal error'
            }, 500)
        }
    }

    // --- Pi models ---
    app.get('/sessions/:id/pi-models', (c) =>
        withPiSession(c, async ({ sessionId, engine }) =>
            c.json(await engine.callPiRpc(sessionId, RPC_METHODS.ListPiModels, {}, 120_000))
        )
    )

    return app
}
