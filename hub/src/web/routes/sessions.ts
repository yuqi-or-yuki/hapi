import { getPermissionModesForFlavor, isPermissionModeAllowedForFlavor, supportsModelChange, toSessionSummary } from '@hapi/protocol'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { CodexCollaborationModeSchema, PermissionModeSchema } from '@hapi/protocol/schemas'
import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const permissionModeSchema = z.object({
    mode: PermissionModeSchema
})

const resumeBodySchema = z.object({
    permissionMode: PermissionModeSchema.optional()
})

const collaborationModeSchema = z.object({
    mode: CodexCollaborationModeSchema
})

const modelSchema = z.object({
    model: z.string().trim().min(1).nullable()
})

const modelReasoningEffortSchema = z.object({
    modelReasoningEffort: z.string().trim().min(1).nullable()
})

const effortSchema = z.object({
    effort: z.string().trim().min(1).nullable()
})

const renameSessionSchema = z.object({
    name: z.string().min(1).max(255)
})

const reviewSchema = z.object({
    readyForReview: z.boolean()
})

const uploadSchema = z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    mimeType: z.string().min(1).max(255)
})

const uploadDeleteSchema = z.object({
    path: z.string().min(1)
})

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024


type SlashCommand = {
    name: string
    description?: string
    source: 'builtin' | 'user' | 'plugin' | 'project'
    content?: string
    pluginName?: string
}

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

function isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
}

function isNativeLoopActive(sessionPath: string, hapiSessionId?: string): boolean {
    // Badge shows only while the loop is actively running (lock held + PID alive).
    // When the loop finishes, releaseLock removes the lock and the badge clears.
    const lockPath = join(sessionPath, '.hapi', 'loop-lock')
    if (!existsSync(lockPath)) return false
    try {
        const data = JSON.parse(readFileSync(lockPath, 'utf-8'))
        if (hapiSessionId && data.hapiSessionId && data.hapiSessionId !== hapiSessionId) return false
        return isPidAlive(data.pid)
    } catch {
        return false
    }
}

function readDispatcherSessionId(sessionPath: string): string | null {
    const sidPath = join(sessionPath, '.loop-logs', 'hapi-session-id')
    if (!existsSync(sidPath)) return null
    try {
        return readFileSync(sidPath, 'utf-8').trim() || null
    } catch {
        return null
    }
}

function isDispatcherLoopAlive(sessionPath: string): boolean {
    const pidPath = join(sessionPath, '.loop-logs', 'pid')
    if (!existsSync(pidPath)) return false
    try {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
        return !isNaN(pid) && isPidAlive(pid)
    } catch {
        return false
    }
}

/**
 * /hapi-loop runs the loop in a dedicated worktree under <repo>/.claude/worktrees/loop-*.
 * The owning session's reported path is the repo root, so without this scan the badge
 * would never be found. Returns session IDs of worktree loops that are still RUNNING
 * (badge clears once the loop finishes).
 */
function collectWorktreeLoopOwners(basePath: string): string[] {
    const owners: string[] = []
    const worktreesDir = join(basePath, '.claude', 'worktrees')
    if (!existsSync(worktreesDir)) return owners
    let entries: string[]
    try {
        entries = readdirSync(worktreesDir)
    } catch {
        return owners
    }
    for (const name of entries) {
        if (!name.startsWith('loop-')) continue
        const wt = join(worktreesDir, name)
        // Dispatcher claim — only counts while the loop is still alive
        if (isDispatcherLoopAlive(wt)) {
            const claimed = readDispatcherSessionId(wt)
            if (claimed) owners.push(claimed)
        }
        // HAPI-native lock carrying a session id — only while alive
        const lock = join(wt, '.hapi', 'loop-lock')
        if (existsSync(lock)) {
            try {
                const data = JSON.parse(readFileSync(lock, 'utf-8'))
                if (data.hapiSessionId && isPidAlive(data.pid)) owners.push(data.hapiSessionId)
            } catch {}
        }
    }
    return owners
}


function readSessionIdFile(path: string): string | null {
    if (!existsSync(path)) return null
    try {
        return readFileSync(path, 'utf-8').trim() || null
    } catch {
        return null
    }
}

function readDebateSessionId(runDir: string): string | null {
    return readSessionIdFile(join(runDir, 'hapi-session-id'))
}

function isDebateRunActive(runDir: string): boolean {
    const statePath = join(runDir, 'state.json')
    if (!existsSync(statePath)) return false
    try {
        const data = JSON.parse(readFileSync(statePath, 'utf-8')) as {
            status?: string
            orchestratorPid?: number
            blue?: { pid?: number; status?: string }
            red?: { pid?: number; status?: string }
            synthesis?: { pid?: number; status?: string }
        }
        if (data.status !== 'running') return false
        const pids = [
            data.orchestratorPid,
            data.blue?.pid,
            data.red?.pid,
            data.synthesis?.pid,
        ].filter((pid): pid is number => typeof pid === 'number' && Number.isFinite(pid))
        return pids.some(isPidAlive)
    } catch {
        return false
    }
}

function collectDebateOwners(basePath: string): string[] {
    const owners: string[] = []
    const debatesDir = join(basePath, '.hapi-debates')
    if (!existsSync(debatesDir)) return owners
    let entries: string[]
    try {
        entries = readdirSync(debatesDir)
    } catch {
        return owners
    }
    for (const name of entries) {
        const runDir = join(debatesDir, name)
        if (!isDebateRunActive(runDir)) continue
        const ownerId = readDebateSessionId(runDir)
        if (ownerId) owners.push(ownerId)
    }
    return owners
}

function computeDebateActiveIds(sessions: Session[]): Set<string> {
    const result = new Set<string>()
    const knownIds = new Set(sessions.map(s => s.id))
    const scannedBases = new Set<string>()
    for (const s of sessions) {
        const p = s.metadata?.path
        if (!p || scannedBases.has(p)) continue
        scannedBases.add(p)
        for (const ownerId of collectDebateOwners(p)) {
            if (knownIds.has(ownerId)) result.add(ownerId)
        }
    }
    return result
}

/**
 * Compute loopActive for each session. For the dispatcher pattern (.loop-logs/pid),
 * we have no session ID in the pid file, so we only mark the most-recently-updated
 * session per directory to avoid tagging every session in the project.
 */
function computeLoopActiveIds(sessions: Session[]): Set<string> {
    const result = new Set<string>()
    const knownIds = new Set(sessions.map(s => s.id))

    // HAPI-native lock: per-session match via hapiSessionId
    for (const s of sessions) {
        if (s.metadata?.path && isNativeLoopActive(s.metadata.path, s.id)) {
            result.add(s.id)
        }
    }

    // Dispatcher pattern: group by path. Badge shows only while the loop is still
    // running; it clears once the dispatcher process exits.
    const byPath = new Map<string, Session[]>()
    for (const s of sessions) {
        const p = s.metadata?.path
        if (!p) continue
        if (!byPath.has(p)) byPath.set(p, [])
        byPath.get(p)!.push(s)
    }
    for (const [path, group] of byPath) {
        if (!isDispatcherLoopAlive(path)) continue
        const claimedSessionId = readDispatcherSessionId(path)
        if (claimedSessionId) {
            // Tag the session that called claim_loop
            const owner = group.find(s => s.id === claimedSessionId)
            if (owner) result.add(owner.id)
        } else {
            // No claim file — fall back to most recently updated
            const mostRecent = group.reduce((a, b) => a.updatedAt >= b.updatedAt ? a : b)
            result.add(mostRecent.id)
        }
    }

    // Worktree loops (/hapi-loop): claim lives in the worktree, but the owning
    // session's path is the repo root — scan worktrees under each unique base path.
    const scannedBases = new Set<string>()
    for (const p of byPath.keys()) {
        if (scannedBases.has(p)) continue
        scannedBases.add(p)
        for (const ownerId of collectWorktreeLoopOwners(p)) {
            if (knownIds.has(ownerId)) result.add(ownerId)
        }
    }

    return result
}

export function createSessionsRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const getPendingCount = (s: Session) => s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0

        const namespace = c.get('namespace')
        const allSessions = engine.getSessionsByNamespace(namespace)
        const loopActiveIds = computeLoopActiveIds(allSessions)
        const debateActiveIds = computeDebateActiveIds(allSessions)
        const sessions = allSessions
            .sort((a, b) => {
                // Active sessions first
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
            .map(s => ({
                ...toSessionSummary(s),
                loopActive: loopActiveIds.has(s.id),
                debateActive: debateActiveIds.has(s.id)
            }))

        return c.json({ sessions })
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
        const parsed = body ? resumeBodySchema.safeParse(body) : { success: true as const, data: {} }
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
                        : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
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
        const parsed = uploadSchema.safeParse(body)
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
        const parsed = uploadDeleteSchema.safeParse(body)
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

    app.post('/sessions/:id/archive', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.archiveSession(sessionResult.sessionId)
        return c.json({ ok: true })
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
        const parsed = permissionModeSchema.safeParse(body)
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
        const parsed = collaborationModeSchema.safeParse(body)
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
        const parsed = modelSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!supportsModelChange(flavor)) {
            return c.json({ error: 'Model selection is not supported for this session' }, 400)
        }
        if (flavor === 'codex' && sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Model selection can only be changed for remote Codex sessions' }, 409)
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
        if (flavor !== 'codex') {
            return c.json({ error: 'Model reasoning effort is only supported for Codex sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Model reasoning effort can only be changed for remote Codex sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = modelReasoningEffortSchema.safeParse(body)
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
        const parsed = effortSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'claude') {
            return c.json({ error: 'Effort selection is only supported for Claude sessions' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { effort: parsed.data.effort })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply effort'
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
        const parsed = renameSessionSchema.safeParse(body)
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
            const result = await engine.listSkills(sessionResult.sessionId)
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

    return app
}
