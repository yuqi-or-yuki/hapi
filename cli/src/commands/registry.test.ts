import { describe, expect, it } from 'vitest'
import { resolveCommand, suggestCommand } from './registry'

describe('resolveCommand', () => {
    it('still starts a session for no args, flags and prompt-shaped text', () => {
        expect(resolveCommand([]).command.name).toBe('default')
        expect(resolveCommand(['--yolo']).command.name).toBe('default')
        expect(resolveCommand(['fix the failing test']).command.name).toBe('default')
        expect(resolveCommand(['Review this']).command.name).toBe('default')
        expect(resolveCommand(['refactor_me']).command.name).toBe('default')
    })

    it('keeps launching Claude sessions the way the runner spawns them', () => {
        // runner/run.ts buildCliArgs emits `hapi claude --hapi-starting-mode …`.
        // `claude` is not a registered command name (the default command is
        // registered as `default`), so it must keep falling through with its
        // arguments intact or no Claude session can start.
        const spawn = ['claude', '--hapi-starting-mode', 'remote', '--started-by', 'runner', '--yolo']
        const resolved = resolveCommand(spawn)
        expect(resolved.command.name).toBe('default')
        expect(resolved.context.commandArgs).toEqual(spawn)
    })

    it('routes known subcommands as before', () => {
        expect(resolveCommand(['worker', 'status']).command.name).toBe('worker')
        expect(resolveCommand(['worker', 'status']).context.commandArgs).toEqual(['status'])
        expect(resolveCommand(['doctor']).command.name).toBe('doctor')
    })

    it('reports an unknown bare word instead of starting a session', () => {
        // The regression: `hapi worker status` on a build without the worker
        // command used to boot an agent session that hung forever.
        expect(resolveCommand(['wrker', 'status']).command.name).toBe('unknown')
        expect(resolveCommand(['nonsensecmd']).command.name).toBe('unknown')
    })
})

describe('suggestCommand', () => {
    it('points at the nearest command for a typo', () => {
        expect(suggestCommand('wrker', ['worker', 'runner', 'doctor'])).toBe('worker')
        expect(suggestCommand('docter', ['worker', 'runner', 'doctor'])).toBe('doctor')
    })

    it('stays silent when nothing is close', () => {
        expect(suggestCommand('zzzzzzzz', ['worker', 'runner', 'doctor'])).toBeNull()
    })
})
