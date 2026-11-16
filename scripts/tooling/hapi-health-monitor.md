# hapi-health-monitor

End-to-end health check for a local HAPI install. Runs every 60s from launchd
(`ai.hapi.health-monitor`), never restarts anything (that is `hapi-hub-guard`'s job).

What it checks each run:

| Check | What it proves |
|---|---|
| `health`, `auth`, `sessions`, `machines`, `session`, `messages` | the same REST calls the web app makes answer, and fast |
| `sse` | `/api/events` opens and the hub sends its handshake (what "Reconnecting" is waiting for) |
| `web` | the PWA bundle is served |
| `traffic` | real `/api` + `/cli` requests in `hub.log` since the last run: 5xx count, requests over 2s, worst routes |
| `process` | hub/runner scheduling priority (PRI 4 = launchd `ProcessType=Background` clamp) and load average |

Outputs:

- `~/.hapi/health-monitor-status.json` — latest result
- `~/Library/Logs/hapi/health-monitor.log` — one JSON line per run
- macOS notification when the overall state changes (after two consecutive runs)

Usage:

```bash
~/.hapi/bin/hapi-health-monitor.py --report   # latest status, exit 0 ok / 2 not ok
~/.hapi/bin/hapi-health-monitor.py --print    # run now and print
```

Install / update: copy the script to `~/.hapi/bin/` and (re)load
`~/Library/LaunchAgents/ai.hapi.health-monitor.plist`. Tests:
`python3 -m unittest scripts/tooling/test_hapi_health_monitor.py`.
