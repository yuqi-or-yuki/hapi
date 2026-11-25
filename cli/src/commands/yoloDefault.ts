import { readSettings } from '@/persistence'

/**
 * Whether a session should start with permissions bypassed even though no
 * permission flag was given.
 *
 * Off unless the machine's settings.json says `"yoloByDefault": true`, because
 * bypassing permissions must be something the machine's owner chose. It only
 * applies to sessions a person starts from a terminal: a session the runner
 * starts was configured in the app, and that choice (including "ask first")
 * arrives as explicit flags or not at all and must not be overridden here.
 */
export function shouldDefaultToYolo(input: {
    hasPermissionMode: boolean
    startedBy: 'runner' | 'terminal' | undefined
    setting: unknown
}): boolean {
    return input.setting === true && !input.hasPermissionMode && input.startedBy !== 'runner'
}

export async function yoloByDefault(options: { permissionMode?: unknown; startedBy?: 'runner' | 'terminal' }): Promise<boolean> {
    return shouldDefaultToYolo({
        hasPermissionMode: options.permissionMode !== undefined,
        startedBy: options.startedBy,
        setting: (await readSettings()).yoloByDefault
    })
}
