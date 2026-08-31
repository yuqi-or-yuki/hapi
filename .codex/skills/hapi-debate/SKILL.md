---
name: hapi-debate
description: "Run a Blue Team / Red Team planning debate: Claude Code drafts the plan, Codex critiques it, and every prompt/output is appended to one Obsidian Remote Vault note. Use when the user invokes /hapi-debate or asks for a Claude-vs-Codex debate on a plan."
---

# HAPI Debate

Run a structured planning debate. Blue Team is **Claude Code**. Red Team is **Codex**. The user supplies the debate topic after the slash command.

## Usage

```text
/hapi-debate <topic, task, proposal, or plan to debate>
```

Example:

```text
/hapi-debate should we add background sync retries to the HAPI runner, and what should the implementation plan be?
```

## Non-negotiables

- One debate = one markdown file in the Obsidian Remote Vault.
- Append every meaningful communication to that file: user prompt, Blue prompt, Blue output, Red critique, follow-up prompts, synthesis, final recommendation.
- Never scatter debate notes across multiple files.
- Red Team must be extremely critical: failure modes, hidden assumptions, product risk, engineering risk, testability, operational risk, simpler alternatives.
- Blue Team owns the initial constructive plan. Red Team owns adversarial review. Final synthesis should preserve disagreements instead of smoothing them away.
- If Claude Code CLI is unavailable, do not fake Claude output. Write a `Claude Code unavailable` section in the note and ask the user whether to proceed with a simulated Blue Team or stop.


## Background orchestration model

This skill is a dispatcher. Start the debate orchestrator in the background, then monitor it. Do **not** run Blue, Red, and synthesis synchronously in the foreground unless the user explicitly asks.

Key design:

- The background orchestrator owns fast handoff.
- The dispatcher owns user-facing progress reports every 2–3 minutes.
- The orchestrator polls process completion locally and launches the next agent immediately when the prior side exits. It must not wait for the next user-facing progress interval.

Default launch helper:

```bash
node .codex/skills/hapi-debate/scripts/start-hapi-debate.mjs \
  --topic "<topic>" \
  --repo-root "$REPO_ROOT"
```

The launcher starts the orchestrator as a detached child process (`detached: true`, `unref()`), which is more reliable than raw `nohup` in HAPI/Codex-managed shells. It writes:

- HAPI session owner claim: `<repo>/.hapi-debates/<slug-stamp>/hapi-session-id` (created by `claim_debate`)
- state: `<repo>/.hapi-debates/<slug-stamp>/state.json`
- prompts/outputs: `<repo>/.hapi-debates/<slug-stamp>/`
- note: `/Users/yuqili/Documents/obsidian/yuqi-obsidian/Projects/HAPI/Debates/YYYY-MM-DD HHmm - hapi-debate - <slug>.md`

The helper sequence is:

1. Create the Obsidian note and state file.
2. Launch Blue Team Claude Code in background.
3. As soon as Claude exits, append its output and immediately launch Red Team Codex with the Blue output.
4. As soon as Codex exits, append its critique and immediately launch a moderator synthesis pass.
5. Mark state `complete` or `failed`.

This immediate handoff is mandatory; a 2–3 minute HAPI progress cadence is only for the user, not for agent-to-agent notification.

## Obsidian note location

Vault root:

```text
/Users/yuqili/Documents/obsidian/yuqi-obsidian
```

Default folder:

```text
Projects/HAPI/Debates/
```

Note filename:

```text
YYYY-MM-DD HHmm - hapi-debate - <short-slug>.md
```

Create parent directories as needed. Append only; do not overwrite after the note is created.

## Phase 1 — Set up debate note

1. Parse the user topic from `/hapi-debate <topic>`.
2. Make a short kebab-case slug from the topic.
3. Create the note with this header:

```markdown
# HAPI Debate: <topic one-liner>

- **Started:** <ISO timestamp>
- **Topic:** <full user topic>
- **Blue Team:** Claude Code
- **Red Team:** Codex
- **Status:** running

---

## 1. User prompt

<verbatim user prompt>
```

4. Tell the user the exact note path before starting model work.

## Phase 2 — Launch background debate

Start the detached launch helper from the repo root. Example:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
TOPIC="<topic>"
node "$REPO_ROOT/.codex/skills/hapi-debate/scripts/start-hapi-debate.mjs" \
  --topic "$TOPIC" \
  --repo-root "$REPO_ROOT"
```

After launch, wait 2–3 seconds, verify PID alive, then find the newest state file:

```bash
sleep 3
P="$(cat "$REPO_ROOT/.hapi-debates/last-launch.pid")"
kill -0 "$P" 2>/dev/null && echo "debate alive pid=$P"
find "$REPO_ROOT/.hapi-debates" -name state.json -print0 | xargs -0 ls -t | head -1
```

Claim debate ownership for the current HAPI session as soon as the run dir is known:

- If `mcp__hapi__claim_debate` is available, call it with `{ "directory": "<runDir>" }`.
- If it is not available, write the limitation in the note and tell the user the HAPI debate badge may not appear until the CLI is updated.

Tell the user the PID, state path, run dir, Obsidian note path, and whether the HAPI debate badge was claimed.

The helper runs Claude Code non-interactively from the current repo. If manual fallback is needed, prefer a command that prints to stdout, for example:

```bash
claude --print --no-session-persistence --permission-mode plan --tools "" - < /tmp/hapi-debate-blue-prompt.txt
```

If the local Claude CLI uses a different non-interactive flag, inspect `claude --help` briefly and use the right one.

Blue prompt template:

```markdown
You are Blue Team (Claude Code) in a HAPI planning debate.

Task/topic:
<topic>

Draft the strongest pragmatic Blue Team response. Be concrete and concise. If the topic is code/product work, include:
- Problem framing
- Proposed architecture or workflow
- Files likely touched
- Step-by-step implementation plan
- Tests / verification
- Risks and mitigations
- What not to do

If relevant, optimize for HAPI repo conventions: TypeScript strict, Bun workspaces, pragmatism, no backward-compat requirement, necessary tests only. If the topic is factual/math, answer directly and state assumptions; do not force a repo implementation plan.
```

Append both the exact Blue prompt and Claude output:

```markdown
---

## 2. Blue Team prompt sent to Claude Code

```text
<blue prompt>
```

## 3. Blue Team plan (Claude Code)

<claude output>
```

## Phase 3 — Monitor and report progress

Report progress to the user every 2–3 minutes until terminal state. Prefer 150 seconds. If a wakeup/scheduler tool is available, schedule recurring checks with:

- delay: 150 seconds
- prompt: `monitor hapi-debate state <statePath>; report phase, alive process, latest note section, and reschedule unless complete`

On each check:

```bash
cat "<statePath>"
P="$(cat "$REPO_ROOT/.hapi-debates/last-launch.pid" 2>/dev/null)"
kill -0 "$P" 2>/dev/null && echo "orchestrator alive pid=$P" || echo "orchestrator not running"
tail -40 "<runDir>/"*.md 2>/dev/null
```

User report format:

```text
Debate status: <phase/status>
Badge: <claimed|not claimed>
Blue: <pending|running|complete|failed>
Red: <pending|running|complete|failed>
Synthesis: <pending|running|complete|failed>
Note: <notePath>
Next: <what is happening now>
```

Important: never wait until the next 2–3 minute report to start Red. The helper must start Red immediately after Blue exits. If manual fallback is used, poll Blue every 10–15 seconds locally and launch Red as soon as Blue output exists.

## Phase 4 — Red Team critique via Codex

In the default helper flow, Codex reads the Blue plan and critiques it adversarially immediately after Blue exits. Manual fallback prompt:

Red prompt template:

```markdown
You are Red Team (Codex) in a HAPI planning debate.

Topic:
<topic>

Blue Team plan:
<blue output>

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
```

Append both Red prompt and Red critique:

```markdown
---

## 4. Red Team prompt sent to Codex

```text
<red prompt>
```

## 5. Red Team critique (Codex)

<codex critique>
```

## Phase 5 — Synthesis

Produce a final synthesis for the user:

- Final recommendation
- Blue points retained
- Red objections accepted
- Remaining disagreements
- Concrete next steps
- Whether implementation should proceed now

Append it:

```markdown
---

## 6. Synthesis / recommendation

<synthesis>

---

- **Completed:** <ISO timestamp>
- **Status:** complete
```

Then answer the user with a concise summary and the note path.

## Phase 6 — Completion and stop controls

When `state.status` is `complete` or `failed`, stop rescheduling progress reports. Give the user:

- Final status
- Blue/Red/synthesis outcome
- Note path
- State path
- One-line recommendation from synthesis if available

Stop command:

```bash
kill "$(cat "$REPO_ROOT/.hapi-debates/last-launch.pid")" 2>/dev/null || true
```

Append a stopped/failure note entry if you stop manually.

## Safety and failure handling

- If Claude Code command fails, append the failed command, exit code, and stderr tail to the note.
- If Obsidian write fails, stop before running either team; ask the user for a writable note path. The debate must not proceed without the single shared note.
- If the user supplies an existing plan, keep it verbatim in the note before Blue Team responds.
- If the task concerns high-stakes or current external facts, browse or verify as needed before final synthesis, and cite sources in the note.
