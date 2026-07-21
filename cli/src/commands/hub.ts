import chalk from 'chalk'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { checkIfRunnerRunningAndCleanupStaleState } from '@/runner/controlClient'
import { logger } from '@/ui/logger'
import type { CommandDefinition, CommandContext } from './types'

function parseHubArgs(args: string[]): { host?: string; port?: string } {
    const result: { host?: string; port?: string } = {}

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--host' && i + 1 < args.length) {
            result.host = args[++i]
        } else if (arg === '--port' && i + 1 < args.length) {
            result.port = args[++i]
        } else if (arg.startsWith('--host=')) {
            result.host = arg.slice('--host='.length)
        } else if (arg.startsWith('--port=')) {
            result.port = arg.slice('--port='.length)
        }
    }

    return result
}

async function autoStartRunner(port?: string): Promise<void> {
    const actualPort = port || process.env.WEBAPP_PORT || '3006'
    const url = `http://localhost:${actualPort}`

    // Wait for hub to be healthy
    let healthy = false
    for (let i = 0; i < 50; i++) {
        try {
            const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
            if (res.ok) {
                healthy = true
                break
            }
        } catch { /* hub not ready yet */ }
        await new Promise(resolve => setTimeout(resolve, 200))
    }

    if (!healthy) {
        logger.debug('[HUB] Hub did not become healthy, skipping runner auto-start')
        return
    }

    // Check if runner is already running
    try {
        const running = await checkIfRunnerRunningAndCleanupStaleState()
        if (running) {
            logger.debug('[HUB] Runner already running, skipping auto-start')
            return
        }
    } catch { /* no runner running */ }

    // Start runner in background
    console.log('[Hub] Auto-starting runner...')
    const child = spawnHappyCLI(['runner', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
    })
    child.unref()

    // Verify runner started
    let started = false
    for (let i = 0; i < 50; i++) {
        try {
            if (await checkIfRunnerRunningAndCleanupStaleState()) {
                started = true
                break
            }
        } catch { /* not ready yet */ }
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    if (started) {
        console.log('[Hub] Runner started successfully')
    } else {
        console.log(chalk.yellow('[Hub] Warning: Runner may not have started. Run `hapi runner start` manually.'))
    }
}

export const hubCommand: CommandDefinition = {
    name: 'hub',
    requiresRuntimeAssets: true,
    run: async (context: CommandContext) => {
        try {
            const { host, port } = parseHubArgs(context.commandArgs)

            if (host) {
                process.env.HAPI_LISTEN_HOST = host
            }
            if (port) {
                process.env.HAPI_LISTEN_PORT = port
            }
            const { startHub } = await import('hapi-hub/startHub')

            // Start runner auto-start in background (polls until hub is healthy)
            void autoStartRunner(port)

            const hub = await startHub({ args: context.commandArgs })
            let shuttingDown = false
            const shutdown = async () => {
                if (shuttingDown) {
                    return
                }
                shuttingDown = true
                process.off('SIGINT', shutdown)
                process.off('SIGTERM', shutdown)
                console.log('\nShutting down...')
                await hub.stop()
                process.exit(0)
            }
            process.on('SIGINT', shutdown)
            process.on('SIGTERM', shutdown)
            await new Promise(() => {})
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
