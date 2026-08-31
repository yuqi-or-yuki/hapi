---
name: hapi-schedule-messages
description: Manage HAPI scheduled message jobs. Use when the user asks to schedule, list, edit, update, delete, cancel, audit, or troubleshoot delayed HAPI messages, especially jobs that clone a session before sending a deterministic backend message. Applies to HAPI CLI `hapi schedule`, web `/scheduled-jobs`, and scheduled message API/storage.
---

# HAPI Scheduled Messages

Use this skill to manage scheduled HAPI message jobs.

## Primary interfaces

Prefer the safest interface for the request:

1. **CLI** for user-facing CRUD:
   - `hapi schedule list [--status pending|all|sent|failed|cancelled]`
   - `hapi schedule create --session <session-id> --at <time> --text <message> [--clone] [--every 5m]`
   - `hapi schedule update <job-id> [--session <session-id>] [--at <time>] [--text <message>] [--clone|--no-clone] [--every 5m|--no-repeat] [--enable|--disable]`
   - `hapi schedule delete <job-id>`
2. **Web UI** for visual management:
   - open `/scheduled-jobs`
   - edit pending job text/time/clone flag
   - delete pending jobs
3. **API** for code changes/tests:
   - `GET /api/scheduled-messages?status=pending|all|sent|failed|cancelled`
   - `GET /api/sessions/:id/scheduled-messages`
   - `POST /api/sessions/:id/scheduled-messages`
   - `PATCH /api/scheduled-messages/:id`
   - `DELETE /api/scheduled-messages/:id`

## Behavior model

- A scheduled job is persisted in SQLite table `scheduled_messages`.
- Per-job audit history is persisted in `scheduled_message_history` and returned with each scheduled job for the Jobs UI.
- `intervalMs` makes a pending job recurring; after each successful send, HAPI advances `dueAt` and keeps it pending.
- `enabled=false` pauses a pending job without deleting it; disabled jobs are not polled.
- Pending jobs are polled by `hub/src/scheduled/scheduledMessageService.ts`.
- At due time:
  - if the source/target session is currently busy (`active` and either `thinking`, pending tool requests, or background tasks), skip this occurrence, keep the job pending, advance `dueAt`, and record `skipped` history.
  - if `cloneBeforeSend` is true: clone source session, resume clone if inactive, send message to clone.
  - else: resume source session if inactive, send message to source.
- Only pending jobs are editable/deletable.
- Failed jobs retain `error` for diagnosis.
- Job history records `created`, `updated`, `sent`, `failed`, `cancelled`, `skipped`, `enabled`, and `disabled` snapshots.

## Common workflows

### List jobs

Run:

```bash
hapi schedule list --status pending
hapi schedule list --status all
```

If CLI auth fails, check `hapi auth status` and `HAPI_API_URL` / `CLI_API_TOKEN`.

### Create clone-followup job

Use when the user wants a deterministic backend follow-up in a cloned session:

```bash
hapi schedule create \
  --session <session-id> \
  --at "2026-07-06 15:00" \
  --text "Continue with the next planned step." \
  --clone
```

### Update a job

```bash
hapi schedule update <job-id> --at "2026-07-06 16:00"
hapi schedule update <job-id> --text "new message" --no-clone
hapi schedule update <job-id> --every 5m
hapi schedule update <job-id> --no-repeat
hapi schedule update <job-id> --session <session-id>
hapi schedule update <job-id> --disable
hapi schedule update <job-id> --enable
```

### Delete/cancel a job

```bash
hapi schedule delete <job-id>
```

## Code touchpoints

- Store: `hub/src/store/scheduledMessageStore.ts`
- History table: `scheduled_message_history` from `hub/src/store/index.ts`
- Routes: `hub/src/web/routes/scheduledMessages.ts`
- Worker: `hub/src/scheduled/scheduledMessageService.ts`
- Web dialog: `web/src/components/ScheduleMessageDialog.tsx`
- Web dashboard: `/scheduled-jobs` in `web/src/router.tsx`
- CLI command: `cli/src/commands/schedule.ts`

## Validation

After code changes, run at least:

```bash
bun typecheck
cd web && bun run test -- src/components/SessionList.directory-action.test.tsx src/lib/agentDoneRingTrigger.test.ts
bun run build:web
```

If backend scheduling changed, restart hub:

```bash
pm2 restart hapi-hub
```
