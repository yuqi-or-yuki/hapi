import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logger } from '@/ui/logger'
import { query } from '@/claude/sdk'
import type { SDKResultMessage } from '@/claude/sdk'

export interface LoopJudgment {
    success: boolean
    reason: string
    suggestions: string
}

const EVALUATOR_SYSTEM_PROMPT =
    'You are an evaluator for an agentic coding loop. ' +
    'Check whether the success condition is met by running necessary commands, reading files, or running tests. ' +
    'Be strict but fair. Respond ONLY with a JSON object — no prose, no markdown fences.'

const DEFAULT_MAX_ITERATIONS = 10

export interface LoopConfig {
    maxIterations: number
}

function readLoopConfig(cwd: string): LoopConfig {
    const configPath = join(cwd, '.hapi', 'loop.json')
    if (existsSync(configPath)) {
        try {
            const data = JSON.parse(readFileSync(configPath, 'utf-8'))
            return { maxIterations: typeof data.maxIterations === 'number' ? data.maxIterations : DEFAULT_MAX_ITERATIONS }
        } catch {}
    }
    return { maxIterations: DEFAULT_MAX_ITERATIONS }
}

export class LoopEvaluator {
    private iteration = 0
    private readonly cwd: string
    private readonly _maxIterations: number
    private readonly successConditionPath: string
    private readonly planPath: string

    constructor(cwd: string, maxIterations = DEFAULT_MAX_ITERATIONS) {
        this.cwd = cwd
        this._maxIterations = maxIterations
        this.successConditionPath = join(cwd, 'SUCCESS_CONDITION.md')
        this.planPath = join(cwd, 'PLAN.md')
    }

    static isLoopMode(cwd: string): boolean {
        // If the claudeloop dispatcher (/hapi-loop) owns the loop in this directory,
        // the native evaluator must NOT also activate. Otherwise every session
        // running here gets hijacked into a duplicate loop just because the
        // dispatcher left SUCCESS_CONDITION.md in the project root.
        if (existsSync(join(cwd, '.loop-logs'))) return false
        return existsSync(join(cwd, 'SUCCESS_CONDITION.md'))
    }

    static readConfig(cwd: string): LoopConfig {
        return readLoopConfig(cwd)
    }

    /**
     * Try to claim exclusive loop ownership for this process.
     * Returns true if the lock was acquired (this session should run the loop).
     * Returns false if another live process already owns the lock.
     * Stale locks (dead PID) are automatically reclaimed.
     */
    static acquireLock(cwd: string, hapiSessionId?: string): boolean {
        const lockPath = join(cwd, '.hapi', 'loop-lock')
        if (existsSync(lockPath)) {
            try {
                const data = JSON.parse(readFileSync(lockPath, 'utf-8'))
                const ownerPid: number = data.pid
                if (ownerPid !== process.pid) {
                    try {
                        // Signal 0 checks existence without sending a signal
                        process.kill(ownerPid, 0)
                        // Owner process is alive — don't steal the lock
                        logger.debug(`[loop] lock held by PID ${ownerPid}, skipping loop mode`)
                        return false
                    } catch {
                        // Owner process is dead — stale lock, fall through to reclaim
                        logger.debug(`[loop] stale lock from PID ${ownerPid}, reclaiming`)
                    }
                } else {
                    // We already own this lock (e.g. session resumed)
                    return true
                }
            } catch {
                // Malformed lock file — reclaim
            }
        }
        try {
            mkdirSync(join(cwd, '.hapi'), { recursive: true })
            writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired: new Date().toISOString(), hapiSessionId }))
            logger.debug(`[loop] lock acquired by PID ${process.pid}`)
            return true
        } catch {
            return false
        }
    }

    /** Release the lock if this process owns it. Removing the lock clears the UI badge. */
    static releaseLock(cwd: string): void {
        const lockPath = join(cwd, '.hapi', 'loop-lock')
        if (!existsSync(lockPath)) return
        try {
            const data = JSON.parse(readFileSync(lockPath, 'utf-8'))
            if (data.pid === process.pid) {
                unlinkSync(lockPath)
                logger.debug('[loop] lock released')
            }
        } catch {}
    }

    get currentIteration(): number {
        return this.iteration
    }

    get maxIterations(): number {
        return this._maxIterations
    }

    async evaluate(): Promise<LoopJudgment> {
        this.iteration++
        logger.debug(`[loop] evaluating iteration ${this.iteration}/${this._maxIterations}`)

        if (this.iteration > this._maxIterations) {
            return { success: false, reason: 'Max iterations reached', suggestions: '' }
        }

        const successCondition = readFileSync(this.successConditionPath, 'utf-8')
        const plan = existsSync(this.planPath) ? readFileSync(this.planPath, 'utf-8') : '(No plan yet)'

        const prompt = [
            '## Task',
            'Evaluate whether the success condition below is fully met.',
            'Run any necessary shell commands, read files, or run tests to verify.',
            '',
            '## Success Condition',
            successCondition.trim(),
            '',
            '## Current Plan / State',
            plan.trim(),
            '',
            '## Response Format',
            'Respond ONLY with this JSON object (no markdown, no extra text):',
            '{"success": <true|false>, "reason": "<brief explanation>", "suggestions": "<specific next steps if not done, or empty string if done>"}',
        ].join('\n')

        let result = ''
        try {
            const q = query({
                prompt,
                options: {
                    cwd: this.cwd,
                    permissionMode: 'acceptEdits',
                    maxTurns: 5,
                    customSystemPrompt: EVALUATOR_SYSTEM_PROMPT,
                },
            })
            for await (const msg of q) {
                if (msg.type === 'result') {
                    result = (msg as SDKResultMessage).result ?? ''
                }
            }
        } catch (e) {
            logger.debug('[loop] evaluator query failed', e)
            return {
                success: false,
                reason: `Evaluator error: ${e instanceof Error ? e.message : String(e)}`,
                suggestions: 'Check logs and retry.',
            }
        }

        const judgment = this.parseResult(result)
        if (!judgment.success && judgment.suggestions) {
            this.appendFeedback(judgment.suggestions)
        }
        logger.debug(`[loop] judgment: success=${judgment.success}, reason=${judgment.reason}`)
        return judgment
    }

    private parseResult(text: string): LoopJudgment {
        try {
            const match = text.match(/\{[\s\S]*?\}/)
            if (match) {
                const d = JSON.parse(match[0])
                if (typeof d.success === 'boolean') {
                    return {
                        success: d.success,
                        reason: d.reason ?? '',
                        suggestions: d.suggestions ?? '',
                    }
                }
            }
        } catch {}
        // Fallback heuristic
        const lower = text.toLowerCase()
        const success = lower.includes('"success":true') || lower.includes('"success": true')
        return {
            success,
            reason: text.slice(0, 400),
            suggestions: success ? '' : 'Could not parse evaluator output. Retry.',
        }
    }

    private appendFeedback(suggestions: string): void {
        const current = existsSync(this.planPath) ? readFileSync(this.planPath, 'utf-8') : ''
        writeFileSync(
            this.planPath,
            `${current}\n\n## Evaluator Feedback (Iteration ${this.iteration})\n${suggestions}\n`
        )
    }
}
