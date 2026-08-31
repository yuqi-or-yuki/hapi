import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { execFileSyncMock, existsSyncMock, readdirSyncMock, homedirMock, loggerDebugMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    readdirSyncMock: vi.fn(),
    homedirMock: vi.fn(() => '/Users/tester'),
    loggerDebugMock: vi.fn()
}));

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        execFileSync: execFileSyncMock
    };
});

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: existsSyncMock,
        readdirSync: readdirSyncMock
    };
});

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
        ...actual,
        homedir: homedirMock
    };
});

vi.mock('@/ui/logger', () => ({
    logger: { debug: loggerDebugMock }
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalEnv = process.env.HAPI_CODEX_APP_SERVER_BIN;

function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    });
}

function nvmCodex(version: string): string {
    return path.join('/Users/tester', '.nvm', 'versions', 'node', version, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

describe('resolveCodexAppServerCommand', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime');
        }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        delete process.env.HAPI_CODEX_APP_SERVER_BIN;
        setPlatform('darwin');
        existsSyncMock.mockReturnValue(false);
        readdirSyncMock.mockReturnValue([]);
        execFileSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'which' && args.join(' ') === '-a codex') {
                return '/opt/homebrew/bin/codex\n';
            }
            if (command === '/opt/homebrew/bin/codex' && args[0] === '--version') {
                return 'codex-cli 0.142.5';
            }
            if (command === 'npm' && args.join(' ') === 'root -g') {
                return '/Users/tester/.local/lib/node_modules\n';
            }
            throw new Error('not found');
        });
    });

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
        if (originalEnv === undefined) {
            delete process.env.HAPI_CODEX_APP_SERVER_BIN;
        } else {
            process.env.HAPI_CODEX_APP_SERVER_BIN = originalEnv;
        }
    });

    it('prefers a newer nvm-installed Codex over an older PATH shim', async () => {
        const newest = nvmCodex('v24.14.1');
        readdirSyncMock.mockReturnValue([{ name: 'v24.14.1', isDirectory: () => true }]);
        existsSyncMock.mockImplementation((candidate: string) => candidate === newest);
        execFileSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'which' && args.join(' ') === '-a codex') {
                return '/opt/homebrew/bin/codex\n';
            }
            if (command === '/opt/homebrew/bin/codex' && args[0] === '--version') {
                return 'codex-cli 0.142.5';
            }
            if (command === newest && args[0] === '--version') {
                return 'codex-cli 0.144.1';
            }
            if (command === 'npm' && args.join(' ') === 'root -g') {
                return '/Users/tester/.local/lib/node_modules\n';
            }
            throw new Error('not found');
        });

        const { resolveCodexAppServerCommand } = await import('./codexAppServerClient');

        expect(resolveCodexAppServerCommand()).toBe(newest);
    });

    it('honors HAPI_CODEX_APP_SERVER_BIN as an explicit override', async () => {
        process.env.HAPI_CODEX_APP_SERVER_BIN = '/custom/codex';
        const { resolveCodexAppServerCommand } = await import('./codexAppServerClient');

        expect(resolveCodexAppServerCommand()).toBe('/custom/codex');
    });
});
