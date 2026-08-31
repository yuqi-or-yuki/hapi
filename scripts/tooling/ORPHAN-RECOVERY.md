# HAPI orphan / reconnect recovery

## Policy (current)
- launchd tick: every **15 minutes** (health + singleton only)
- heavy orphan/pressure reap: every **30 minutes**
- **same calendar day sessions are never killed** (America/Los_Angeles)
- only dead-parent orphans and **pre-today** over-budget leftovers are reaped

## Commands
```bash
~/.hapi/bin/hapi-watchdog --status
~/.hapi/bin/hapi-watchdog --dry-run
tail -50 ~/Library/Logs/hapi/watchdog.log
```

Env knobs (also in LaunchAgent):
- `HAPI_PROTECT_SAME_DAY=1`
- `HAPI_AGENT_IDLE_TTL_SEC=86400`  # 24h floor
- `HAPI_REAP_EVERY_SEC=1800`       # heavy reap cadence
- `HAPI_MAX_AGENT_WORKERS=12`
- `HAPI_MAX_CHROME_MCP_PROCS=200`
