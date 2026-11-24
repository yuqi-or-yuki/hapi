---
description: Turn the current HAPI session into a swarm worker (standing job + schedule + output board) or edit/retire it, from a plain-language request, with no UI clicks. Use when the user says /hapi-worker, "make this a worker", "promote this session to the swarm", "run this every day/hour as a worker", or asks a worker to change its schedule, job or board.
---

# HAPI Worker

Turn the current HAPI session into a swarm worker (or update the worker it already is) from a plain-language request. No buttons: everything goes through the `hapi worker` CLI, which targets the current session through `HAPI_SESSION_ID`.

## Usage

```
/hapi-worker <what the worker should do, and how often>
/hapi-worker                      # no arguments: infer the job from this conversation
/hapi-worker approve              # approve the last run of a worker in review
/hapi-worker retire               # back to an ordinary session
```

Examples: `/hapi-worker find new robotics researchers every morning at 9`, `/hapi-worker check prod every 6 hours`, `/hapi-worker run daily at 8 instead`.

## Steps

1. Run `hapi worker status` to see whether this session is already a worker. If it is, treat the request as an edit and change only what was asked.
2. Work out from the request (and the conversation, when the request is thin):
   - **job**: one sentence, the standing job in the user's words.
   - **schedule**: `--daily HH:MM` (24h, local time), `--every 30m|6h|2d`, or `--on-demand`. If the user gave no cadence and none is obvious from the job, use `--on-demand` and say so.
   - **working hours**: when the user limits when it should run ("weekdays", "during work hours", "not at night"), put that in the schedule with `--weekdays` and/or `--hours 9-17` (24h, the hub's local time), not only in the playbook. The hub then skips those slots without waking the worker. `--any-time` removes the limit.
   - **name**: always set one. It says what the worker does in two or three words, in Title Case, like a job title: `Talent Intake`, `Laptop Cleaner`, `Office Finder`, `Swarm Monitor`. Never a personal or invented name (no "Pico", "Hazel"), and not a sentence. Use the user's wording if they gave a name.
   - **playbook**: how the job is done, as concrete instructions (sources, criteria, limits, what to skip). Put anything here that a run needs and the one-line job does not say. It is sent with every run.
   - **review period**: how many runs the user checks before the worker acts on its own. Use `--review 3` when the job does anything outward-facing or hard to undo (sending email or messages, posting, purchasing, deleting, pushing code). Use `--no-review` when the job only reads and records, or when the user says to skip review. Use the user's number when they give one.
   - **board columns**: the fields worth seeing for each item the job produces, in display order, as camelCase names. Lead with what identifies the item. Skip this for jobs that produce no list of items.
   - **item approval mode**: if the user wants to review predicted decisions or refine preferences item by item, enable the board review mode by including `suggestedDecision` and `suggestedReason` in `--columns`. Keep this separate from the run-level review period; do not enable it for jobs that do not need item decisions.
3. Promote in one command:
   ```
   hapi worker promote --job "<job>" --name "<2-3 word function>" <schedule flag> [--weekdays] [--hours 9-17] [--review <runs> | --no-review] \
       [--playbook-file <path>] [--columns a,b,c] [--board-title "<title>"]
   ```
   Write the playbook to a temp file and pass `--playbook-file`; use `--playbook "<text>"` only for a single short line.
4. If earlier turns of this session already produced results, backfill the board now (see below) so it is not empty until the next run.
5. Reply in a few lines: the worker's job, when it next runs, whether it is in a review period (and what it will hold back until approved), and the board columns.

For `approve`: run `hapi worker approve` and report how many reviewed runs remain. For `retire`: run `hapi worker retire` and confirm in one line.

## When the task changes

The job is expected to change over time (new sources, new criteria, a different target). A change never stops the worker.

- When the user changes how the job should be done, in any message, rewrite the playbook to the full current version straight away: `hapi worker promote --playbook-file <path>`. Do not leave the change only in the conversation; a later run may not have it in context.
- Change `--job` only when the standing job itself is different, not for a change of method.
- Pass only the flags that change. The schedule, board and review state carry on untouched, and the next scheduled run uses the new playbook.
- Then carry on: answer the user, and if they asked for it, do a run now under the new playbook.

## Review period

`hapi worker status` says whether this worker is in review. While it is:

- Do the full job and record every row, but do not take any action that reaches outside this machine or cannot be undone. Prepare it instead (an email draft, a list of exactly what would be sent or deleted) and say where the draft is.
- End the run with a short review summary: what you found, what you would have done, and what you need a decision on.
- The user approves a run from the Swarm page, or by telling you ("looks good", "approved"); then run `hapi worker approve`. When they say to stop reviewing, run `hapi worker approve --all`.
- Never approve your own run and never shorten the review period on your own judgment.
- After the last approval the worker runs free: take the actions the drafts described going forward. Do not send the earlier drafts unless the user says to.

## Item approval and prediction calibration

When item approval mode is requested, include `suggestedDecision` and `suggestedReason` in the board columns and describe the review question, evidence, feedback processing, and any safeguards in the playbook. When editing an existing worker, retain its current board title and existing columns when passing `--board-title` and `--columns`. Record one row per item with a stable key, a display name, `suggestedDecision` (`yes` or `no`) and an evidence-grounded `suggestedReason`. Optionally record `approvalQuestion` for an item-specific question. A suggestion is a prediction, not the user's decision, and never authorizes outreach or other external action. The dashboard lets the user change both fields before explicitly saving. Process saved review events promptly and on later runs if notification fails; preserve event IDs and original user feedback. Apply generalizable feedback to the appropriate criteria, but do not invent rules from ambiguous or candidate-specific reasons.

### Every review card must be prefilled (enforced)

HAPI enforces this; it is not a guideline.

- **On write:** `hapi worker record` is rejected, and nothing is saved, if it would leave any card that is still awaiting review without a name, `suggestedDecision` (exactly `yes` or `no`) and a non-empty `suggestedReason`. Talent cards also need `bestFitRole`. The error lists each offending key and what it lacks. Fix every one and resend the whole batch.
- **On review:** if any card awaiting review is unfilled, the user's review screen stays closed and shows the list of unfilled cards. One unfilled card invalidates the whole review.

So always record a row complete, in one write, and before asking the user for approval in any form (a run summary, a reply, a notification) run `hapi worker rows` and confirm no card awaiting review is missing a field. Do not ask while any is.

Thin evidence is not a reason to leave a card empty. Make the call the evidence supports and say in the reason exactly what is missing or unverified. Never invent facts to fill a card, and never copy one generic reason across cards.

### Hit rate is measured per category

How often the user keeps a suggestion is counted separately for each category and never blended into one number, because suggestions are only comparable within a category.

- On a talent board the category is the role (`bestFitRole`, and the role the user reviews under).
- On any other approval board, set a `category` field on every row (for example the neighbourhood for office listings, or the lead type). Rows without one are counted under "Uncategorized", which makes the measure useless, so always set it.
- Use a small, stable set of category names; do not rename a category once reviews exist under it.
- When you report prediction accuracy, report it per category with its sample size. Do not quote a blended overall rate.

Each saved review must preserve the prediction shown at the time, final decision and final reason, and independent flags for whether the choice and the reason stayed unchanged. Report cumulative choice, reason and both-unchanged agreement with eligible sample size, plus a chronological trend. Exclude and separately count reviews with no reliable prediction comparison; never fabricate historical predictions or interpret a missing value as a mismatch. For legacy talent reviews, an explicit `suggestionAccepted: true` is reliable evidence that both fields were confirmed unchanged; a false value without a prediction snapshot is ambiguous and must be excluded. Agreement is descriptive, not permission to act or a guaranteed upward trajectory; never game the metric. Distinguish unedited, user-confirmed suggested reasoning from independently written feedback when updating criteria.

## Reporting to the board

The board is how the user monitors this worker without reading the transcript, so on every run, scheduled or prompted by hand:

- One row per item: `hapi worker record --key "<stable id>" --data '{"field": value, ...}'`. For many rows, write a JSON array of `{"key": "...", ...fields}` to a temp file and use `hapi worker record --file <path>`.
- The key must be stable for the item (profile URL, email, ticket id) so a rerun updates the row instead of duplicating it. Check `hapi worker rows` before adding.
- Fields merge. To mark progress later, send only what changed: `hapi worker record --key "<id>" --data '{"emailSent": true}'`.
- Use real types: numbers as numbers, yes/no as `true`/`false`, links as full URLs. Keep free-text fields to a sentence or two.
- When what the item looks like matters (a listing, an office, a product, a person), record the picture URLs in one field — a single URL or a list. The board and the review card show them as pictures instead of links.
- Record what actually happened. Do not write `emailSent: true` for a draft, and leave a field out when you do not know its value.

## Rules

- Every worker is named for what it does, in two or three Title Case words (`Talent Intake`, `Laptop Cleaner`, `Office Finder`). Always pass `--name` when promoting, and rename a worker whose name is a personal or invented name, a sentence, or no longer matches its job: `hapi worker promote --name "<2-3 word function>"`. Keep the name when only the method changes.
- Being messaged by the user does not end the standing job. Answer the message, and stay a worker; never retire unless asked.
- A message that changes the task is an edit to the playbook, not a new session: update it and keep running.
- Never ask for approval with an unfilled review card: every card needs a suggested decision and reason first (see "Every review card must be prefilled").
- Do not change the session's permission mode, machine or directory from here.
- If `hapi worker` reports an unknown command, the installed HAPI predates this feature: tell the user to update HAPI, and stop.
