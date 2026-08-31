#!/usr/bin/env node
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

function slugify(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'debate';
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function localStamp(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

const startedAt = new Date();
const slug = slugify(topic);
const runId = `${slug}-${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
const runDir = join(repoRoot, '.hapi-debates', runId);
const noteDir = join(vaultRoot, noteFolder);
const notePath = join(noteDir, `${localStamp(startedAt)} - hapi-debate - ${slug}.md`);
const statePath = join(runDir, 'state.json');

const state = {
    runId,
    topic,
    repoRoot,
    notePath,
    runDir,
    status: 'starting',
    phase: 'setup',
    orchestratorPid: process.pid,
    startedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    blue: { status: 'pending' },
    red: { status: 'pending' },
    synthesis: { status: 'pending' },
};

async function saveState(patch = {}) {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function append(markdown) {
    await appendFile(notePath, markdown);
}

function commandLine(command, commandArgs) {
    return [command, ...commandArgs.map((part) => JSON.stringify(part))].join(' ');
}

async function runAgent({ phase, command, commandArgs, promptPath, outputPath, input, timeoutMs = 300_000 }) {
    await append(`\n---\n\n## ${phase.heading}\n\n\`\`\`bash\n${commandLine(command, commandArgs)}\n\`\`\`\n\n`);
    await saveState({ phase: phase.key });

    return await new Promise((resolvePromise) => {
        const child = spawn(command, commandArgs, {
            cwd: repoRoot,
            env: process.env,
            stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });

        phase.onStart(child.pid);
        if (input && child.stdin) {
            child.stdin.write(input);
            child.stdin.end();
        }
        const timeout = setTimeout(() => {
            stderr += `\nTimed out after ${timeoutMs}ms; killing process ${child.pid}.`;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        }, timeoutMs);
        timeout.unref();
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', async (error) => {
            clearTimeout(timeout);
            await writeFile(outputPath, stdout);
            await append(`\nCommand failed to start: ${error.message}\n`);
            resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${error.message}` });
        });

        child.on('close', async (code) => {
            clearTimeout(timeout);
            await writeFile(outputPath, stdout);
            await append(`\nExit code: ${code ?? 'unknown'}\n\n`);
            if (stderr.trim()) {
                await append(`### stderr\n\n\`\`\`text\n${stderr.trim().slice(-8000)}\n\`\`\`\n\n`);
            }
            resolvePromise({ code: code ?? 1, stdout, stderr });
        });
    });
}

const bluePrompt = `You are Blue Team (Claude Code) in a HAPI planning debate.

Task/topic:
${topic}

Draft the strongest pragmatic Blue Team response. Be concrete and concise.

If the topic is a code/product task, include:
- Problem framing
- Proposed architecture or workflow
- Files likely touched
- Step-by-step implementation plan
- Tests / verification
- Risks and mitigations
- What not to do

If the topic is a factual/math question, answer directly, state assumptions, and do not force a repo implementation plan.

Optimize for HAPI repo conventions when relevant: TypeScript strict, Bun workspaces, pragmatism, no backward-compat requirement, necessary tests only.
Do not modify files. Do not use tools. Keep the response under 800 words.`;

await mkdir(runDir, { recursive: true });
await mkdir(noteDir, { recursive: true });
await writeFile(notePath, `# HAPI Debate: ${topic}\n\n- **Started:** ${startedAt.toISOString()}\n- **Topic:** ${topic}\n- **Blue Team:** Claude Code\n- **Red Team:** Codex\n- **Run dir:** ${runDir}\n- **State:** ${statePath}\n- **Status:** running\n\n---\n\n## 1. User prompt\n\n${topic}\n`);
await saveState({ status: 'running' });

const bluePromptPath = join(runDir, 'blue-prompt.md');
const blueOutputPath = join(runDir, 'blue-output.md');
await writeFile(bluePromptPath, bluePrompt);
await append(`\n---\n\n## 2. Blue Team prompt sent to Claude Code\n\n\`\`\`text\n${bluePrompt}\n\`\`\`\n`);

const blueResult = await runAgent({
    phase: {
        key: 'blue-running',
        heading: 'Blue Team process (Claude Code)',
        onStart: async (pid) => {
            state.blue = { status: 'running', pid, startedAt: new Date().toISOString(), promptPath: bluePromptPath, outputPath: blueOutputPath };
            await saveState();
        },
    },
    command: 'claude',
    commandArgs: ['--print', '--no-session-persistence', '--permission-mode', 'plan', '--tools', '', '-'],
    promptPath: bluePromptPath,
    outputPath: blueOutputPath,
    input: bluePrompt,
});

state.blue = { ...state.blue, status: blueResult.code === 0 ? 'complete' : 'failed', exitCode: blueResult.code, completedAt: new Date().toISOString() };
await saveState({ phase: 'blue-complete' });
await append(`## 3. Blue Team plan (Claude Code)\n\n${blueResult.stdout.trim() || '_No stdout from Claude Code._'}\n`);

if (blueResult.code !== 0) {
    await append(`\n---\n\n- **Completed:** ${new Date().toISOString()}\n- **Status:** failed during Blue Team\n`);
    await saveState({ status: 'failed', phase: 'failed-blue' });
    process.exit(blueResult.code);
}

const redPrompt = `You are Red Team (Codex) in a HAPI planning debate.

Topic:
${topic}

Blue Team plan:
${blueResult.stdout.trim()}

Critique the plan extremely critically. Focus on:
- Incorrect assumptions
- Overengineering
- Missing repo constraints
- Race conditions / data loss / security risk
- UX failures in HAPI remote sessions
- Testing gaps
- Simpler alternatives
- Concrete changes required before implementation

Return:
1. Verdict: accept / accept with changes / reject
2. Highest-risk flaws
3. Required plan changes
4. Minimal safer plan
5. Open questions for the user, if any

Do not modify files. This is critique only.`;

const redPromptPath = join(runDir, 'red-prompt.md');
const redOutputPath = join(runDir, 'red-output.md');
await writeFile(redPromptPath, redPrompt);
await append(`\n---\n\n## 4. Red Team prompt sent to Codex\n\n\`\`\`text\n${redPrompt}\n\`\`\`\n`);

const redResult = await runAgent({
    phase: {
        key: 'red-running',
        heading: 'Red Team process (Codex) — launched immediately after Blue completed',
        onStart: async (pid) => {
            state.red = { status: 'running', pid, startedAt: new Date().toISOString(), promptPath: redPromptPath, outputPath: redOutputPath };
            await saveState();
        },
    },
    command: 'codex',
    commandArgs: ['exec', '--cd', repoRoot, '--sandbox', 'read-only', '-'],
    promptPath: redPromptPath,
    outputPath: redOutputPath,
    input: redPrompt,
});

state.red = { ...state.red, status: redResult.code === 0 ? 'complete' : 'failed', exitCode: redResult.code, completedAt: new Date().toISOString() };
await saveState({ phase: 'red-complete' });
await append(`## 5. Red Team critique (Codex)\n\n${redResult.stdout.trim() || '_No stdout from Codex._'}\n`);

if (redResult.code !== 0) {
    await append(`\n---\n\n- **Completed:** ${new Date().toISOString()}\n- **Status:** failed during Red Team\n`);
    await saveState({ status: 'failed', phase: 'failed-red' });
    process.exit(redResult.code);
}

const synthesisPrompt = `You are the moderator for a HAPI Blue/Red planning debate.

Topic:
${topic}

Blue Team plan:
${blueResult.stdout.trim()}

Red Team critique:
${redResult.stdout.trim()}

Produce a concise final synthesis:
- Final recommendation
- Blue points retained
- Red objections accepted
- Remaining disagreements
- Concrete next steps
- Whether implementation should proceed now

Do not modify files.`;

const synthesisPromptPath = join(runDir, 'synthesis-prompt.md');
const synthesisOutputPath = join(runDir, 'synthesis-output.md');
await writeFile(synthesisPromptPath, synthesisPrompt);
await append(`\n---\n\n## 6. Synthesis prompt\n\n\`\`\`text\n${synthesisPrompt}\n\`\`\`\n`);

const synthesisResult = await runAgent({
    phase: {
        key: 'synthesis-running',
        heading: 'Synthesis process (Codex moderator)',
        onStart: async (pid) => {
            state.synthesis = { status: 'running', pid, startedAt: new Date().toISOString(), promptPath: synthesisPromptPath, outputPath: synthesisOutputPath };
            await saveState();
        },
    },
    command: 'codex',
    commandArgs: ['exec', '--cd', repoRoot, '--sandbox', 'read-only', '-'],
    promptPath: synthesisPromptPath,
    outputPath: synthesisOutputPath,
    input: synthesisPrompt,
});

state.synthesis = { ...state.synthesis, status: synthesisResult.code === 0 ? 'complete' : 'failed', exitCode: synthesisResult.code, completedAt: new Date().toISOString() };
await append(`## 7. Synthesis / recommendation\n\n${synthesisResult.stdout.trim() || '_No stdout from synthesis._'}\n\n---\n\n- **Completed:** ${new Date().toISOString()}\n- **Status:** ${synthesisResult.code === 0 ? 'complete' : 'failed during synthesis'}\n`);
await saveState({ status: synthesisResult.code === 0 ? 'complete' : 'failed', phase: synthesisResult.code === 0 ? 'complete' : 'failed-synthesis', completedAt: new Date().toISOString() });

if (!existsSync(notePath)) {
    console.error(`Expected note missing: ${notePath}`);
    process.exit(1);
}

console.log(JSON.stringify({ statePath, notePath, runDir }, null, 2));
