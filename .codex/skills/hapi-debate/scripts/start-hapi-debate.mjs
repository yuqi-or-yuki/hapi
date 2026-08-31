#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function arg(name, fallback = '') {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1]) return args[index + 1];
    return fallback;
}

const topic = arg('--topic').trim();
const repoRoot = resolve(arg('--repo-root', process.cwd()));
const vaultRoot = resolve(arg('--vault-root', '/Users/yuqili/Documents/obsidian/yuqi-obsidian'));
const noteFolder = arg('--note-folder', 'Projects/HAPI/Debates');

if (!topic) {
    console.error('Missing required --topic');
    process.exit(2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const orchestrator = join(scriptDir, 'run-hapi-debate.mjs');
const debatesRoot = join(repoRoot, '.hapi-debates');
await mkdir(debatesRoot, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const stdoutPath = join(debatesRoot, `launch-${stamp}.out.log`);
const stderrPath = join(debatesRoot, `launch-${stamp}.err.log`);
const stdout = await import('node:fs').then(fs => fs.openSync(stdoutPath, 'a'));
const stderr = await import('node:fs').then(fs => fs.openSync(stderrPath, 'a'));

const child = spawn(process.execPath, [
    orchestrator,
    '--topic', topic,
    '--repo-root', repoRoot,
    '--vault-root', vaultRoot,
    '--note-folder', noteFolder,
], {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: ['ignore', stdout, stderr],
});

child.unref();

const launch = {
    pid: child.pid,
    topic,
    repoRoot,
    debatesRoot,
    stdoutPath,
    stderrPath,
    startedAt: new Date().toISOString(),
};

await writeFile(join(debatesRoot, 'last-launch.pid'), `${child.pid}\n`);
await writeFile(join(debatesRoot, 'last-launch.json'), `${JSON.stringify(launch, null, 2)}\n`);
console.log(JSON.stringify(launch, null, 2));
