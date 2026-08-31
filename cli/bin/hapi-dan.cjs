#!/usr/bin/env node

// hapi-dan: shortcut for `hapi --dangerously-skip-permissions`
const { execFileSync } = require('child_process');
const path = require('path');

const { getBinaryPath, isSupportedPlatform, reportExecutionFailure, reportMissingPlatformPackage, reportUnsupportedPlatform } = require('./hapi.cjs');

function main() {
    if (!isSupportedPlatform()) {
        reportUnsupportedPlatform();
        process.exit(1);
    }

    const binPath = getBinaryPath();
    if (!binPath) {
        reportMissingPlatformPackage();
        process.exit(1);
    }

    const args = ['--dangerously-skip-permissions', ...process.argv.slice(2)];

    try {
        execFileSync(binPath, args, { stdio: 'inherit' });
    } catch (error) {
        const { status, signal } = reportExecutionFailure(error, binPath, args);

        if (status !== null) {
            process.exit(status);
        }

        if (signal) {
            try {
                process.kill(process.pid, signal);
            } catch {
                // ignore unsupported/invalid signal names on this platform
            }
        }

        process.exit(1);
    }
}

main();
