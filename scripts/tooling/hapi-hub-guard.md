# Hub degradation guard (macOS)

`hapi-hub-guard.py` runs once per minute as `ai.hapi.hub-guard`.
It supplements the existing watchdog without changing its agent cleanup policy.

Recovery conditions, after five minutes observing the current hub PID:

- Physical footprint at least 4 GiB for three consecutive checks.
- Health request over two seconds, invalid, or unavailable for two consecutive checks.

A gap over 150 seconds resets strikes. Successful checks reset the relevant
counter. A PID change resets strikes and startup grace. Restarts have a
15-minute cooldown. Database mappings can contribute to physical footprint;
the threshold is an operational recovery budget, not a memory-leak diagnosis.

Before recovery, the guard captures a one-second process sample, retaining five
samples. It calls only `launchctl kickstart -k gui/<uid>/ai.hapi.hub`.
The runner and agents are never restarted. Web/SSE connections briefly reconnect.
No history is deleted or database files rewritten.

Installed script: `~/.hapi/bin/hapi-hub-guard.py`.
LaunchAgent: `~/Library/LaunchAgents/ai.hapi.hub-guard.plist`, using the absolute
Python interpreter path and script path, `StartInterval=60`, `RunAtLoad=true`.
After changing the source, copy it to the installed script. The job executes a
fresh script on each tick. State: `~/.hapi/hub-guard-state.json`.
Logs/samples: `~/Library/Logs/hapi/hub-guard*`.

Check without writes/restarts:

```sh
python3 scripts/tooling/hapi-hub-guard.py --dry-run
python3 -m unittest discover -s scripts/tooling -p 'test_hapi_hub_guard.py'
```

Disable:

```sh
launchctl bootout gui/$(id -u)/ai.hapi.hub-guard
```

The hub independently bounds SSE writes and replay queues, closing stalled clients
before their backlogs can grow without limit. This guard remains a last-resort
recovery mechanism for other sustained failures; samples support further diagnosis.
