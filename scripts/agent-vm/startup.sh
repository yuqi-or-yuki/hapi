#!/bin/bash
# GCE startup script for a HAPI agent VM (Ubuntu 24.04). Runs as root on every
# boot and is idempotent. It installs Claude Code, Codex, Tailscale and Docker,
# joins the tailnet, and runs HAPI as user `agent`.
#
# By default the VM is a complete HAPI of its own: hub + runner, opened from
# any device on the tailnet at http://<vm-name>:3006 with the access token.
# Sign the agents in from Settings > Machines in that web app.
# With instance metadata `hapi-api-url` set, it runs only a runner that joins
# that existing hub instead.
#
# Secrets come from Secret Manager in the VM's own project:
#   hapi-cli-token      required  access token for the hub (web login + runner)
#   tailscale-authkey   required  reusable Tailscale auth key
#   claude-oauth-token  optional  output of `claude setup-token`
#   codex-auth-json     optional  ~/.codex/auth.json after `codex login`
#
# Instance metadata: hapi-binary (gs:// path), hapi-api-url (optional).
set -uo pipefail
exec > >(tee -a /var/log/hapi-agent-startup.log) 2>&1
echo "== hapi agent startup $(date -Is)"

AGENT=agent
AGENT_HOME=/home/$AGENT
export DEBIAN_FRONTEND=noninteractive

meta() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null; }
secret() { gcloud secrets versions access latest --secret "$1" 2>/dev/null; }
as_agent() { sudo -u "$AGENT" -H bash -lc "$1"; }

HAPI_API_URL=$(meta hapi-api-url)
RUN_HUB=0
if [ -z "$HAPI_API_URL" ]; then
    RUN_HUB=1
    HAPI_API_URL=http://127.0.0.1:3006
fi
HAPI_BINARY=$(meta hapi-binary)

if ! id "$AGENT" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$AGENT"
    echo "$AGENT ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-agent
fi

if [ ! -f /var/lib/hapi-agent-packages ]; then
    apt-get update -y
    apt-get install -y git curl jq unzip build-essential ripgrep docker.io
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    npm install -g @openai/codex
    curl -fsSL https://tailscale.com/install.sh | sh
    usermod -aG docker "$AGENT"
    as_agent 'curl -fsSL https://claude.ai/install.sh | bash'
    as_agent 'curl -fsSL https://bun.sh/install | bash'
    command -v codex && command -v tailscale && [ -x "$AGENT_HOME/.local/bin/claude" ] && touch /var/lib/hapi-agent-packages
fi

# Tailscale: the hub is only reachable over the tailnet.
if ! tailscale status >/dev/null 2>&1; then
    TS_KEY=$(secret tailscale-authkey)
    if [ -n "$TS_KEY" ]; then
        tailscale up --authkey "$TS_KEY" --hostname "$(hostname -s)" --ssh \
            || echo "!! tailscale-authkey was rejected (single-use or expired?): store a reusable key"
    else
        echo "!! no tailscale-authkey secret: run 'sudo tailscale up --ssh' on the VM"
    fi
fi

# HAPI binary: installed now and re-checked every two minutes, so publishing a
# new build (CI on push to main, or upload-binary.sh) is a deploy. The updater
# swaps the binary and restarts only the hub; the runner notices the new binary
# and hands itself over, which keeps running sessions alive.
install -d -o "$AGENT" -g "$AGENT" "$AGENT_HOME/.hapi" "$AGENT_HOME/.hapi/bin" "$AGENT_HOME/work"
cat > /usr/local/bin/hapi-update <<'UPDATER'
#!/bin/bash
# usage: hapi-update gs://bucket/object
set -euo pipefail
SRC=$1
DEST=/home/agent/.hapi/bin/hapi
STAMP=/var/lib/hapi-agent-binary-generation
GEN=$(gcloud storage objects describe "$SRC" --format='value(generation)')
[ -n "$GEN" ] || exit 1
[ -x "$DEST" ] && [ "$GEN" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0
gcloud storage cp "$SRC" "$DEST.new" >/dev/null 2>&1
chmod 755 "$DEST.new"
chown agent:agent "$DEST.new"
# Never install a build that does not even start.
sudo -u agent -H "$DEST.new" --version >/dev/null
mv "$DEST.new" "$DEST"
echo "$GEN" > "$STAMP"
systemctl try-restart hapi-hub || true
echo "installed HAPI build generation $GEN"
UPDATER
chmod 755 /usr/local/bin/hapi-update
/usr/local/bin/hapi-update "$HAPI_BINARY" || echo "!! could not install the HAPI binary from $HAPI_BINARY"

cat > /etc/systemd/system/hapi-update.service <<EOF
[Unit]
Description=Install the latest published HAPI build

[Service]
Type=oneshot
ExecStart=/usr/local/bin/hapi-update $HAPI_BINARY
EOF
cat > /etc/systemd/system/hapi-update.timer <<EOF
[Unit]
Description=Check for a new HAPI build every two minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now hapi-update.timer

# Runner environment, also sourced by the agent's login shell.
install -d -m 750 -g "$AGENT" /etc/hapi
{
    echo "HAPI_API_URL=$HAPI_API_URL"
    echo "CLI_API_TOKEN=$(secret hapi-cli-token)"
    echo "HAPI_HOME=$AGENT_HOME/.hapi"
    echo "HAPI_RUNNER_SUPERVISED=1"
    echo "HAPI_LISTEN_HOST=0.0.0.0"
    echo "PATH=$AGENT_HOME/.hapi/bin:$AGENT_HOME/.local/bin:$AGENT_HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    CLAUDE_TOKEN=$(secret claude-oauth-token)
    [ -n "$CLAUDE_TOKEN" ] && echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_TOKEN"
} > /etc/hapi/agent.env
chown root:"$AGENT" /etc/hapi/agent.env
chmod 640 /etc/hapi/agent.env
grep -q hapi/agent.env "$AGENT_HOME/.profile" || echo 'set -a; . /etc/hapi/agent.env; set +a' >> "$AGENT_HOME/.profile"

# Saved logins, only where the VM has none of its own yet.
if [ ! -f "$AGENT_HOME/.codex/auth.json" ]; then
    CODEX_AUTH=$(secret codex-auth-json)
    if [ -n "$CODEX_AUTH" ]; then
        install -d -o "$AGENT" -g "$AGENT" -m 700 "$AGENT_HOME/.codex"
        printf '%s' "$CODEX_AUTH" > "$AGENT_HOME/.codex/auth.json"
        chown "$AGENT:$AGENT" "$AGENT_HOME/.codex/auth.json"
        chmod 600 "$AGENT_HOME/.codex/auth.json"
    fi
fi
# Skip Claude Code's first-run wizard; it cannot be answered from HAPI.
if [ ! -f "$AGENT_HOME/.claude.json" ]; then
    echo '{"hasCompletedOnboarding":true}' > "$AGENT_HOME/.claude.json"
    chown "$AGENT:$AGENT" "$AGENT_HOME/.claude.json"
fi

# Default Claude Code to the newest model unless this VM already chose one.
if [ ! -f "$AGENT_HOME/.claude/settings.json" ]; then
    install -d -o "$AGENT" -g "$AGENT" "$AGENT_HOME/.claude"
    echo '{"model":"fable"}' > "$AGENT_HOME/.claude/settings.json"
    chown "$AGENT:$AGENT" "$AGENT_HOME/.claude/settings.json"
fi

if [ "$RUN_HUB" = 1 ]; then
    cat > /etc/systemd/system/hapi-hub.service <<EOF
[Unit]
Description=HAPI hub
After=network-online.target
Wants=network-online.target

[Service]
User=$AGENT
WorkingDirectory=$AGENT_HOME/.hapi
EnvironmentFile=/etc/hapi/agent.env
ExecStart=$AGENT_HOME/.hapi/bin/hapi server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable hapi-hub
    systemctl restart hapi-hub
    for _ in $(seq 1 30); do curl -fsS -m 2 http://127.0.0.1:3006/health >/dev/null 2>&1 && break; sleep 1; done
fi

cat > /etc/systemd/system/hapi-runner.service <<EOF
[Unit]
Description=HAPI runner
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=$AGENT
WorkingDirectory=$AGENT_HOME/work
EnvironmentFile=/etc/hapi/agent.env
ExecStart=$AGENT_HOME/.hapi/bin/hapi runner start-sync
# Sessions are children of the runner: stop only the runner itself, so a runner
# restart (new build, crash) leaves running sessions alive.
KillMode=process
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable hapi-runner
systemctl is-active --quiet hapi-runner || systemctl start hapi-runner
echo "== hapi agent startup done $(date -Is)"
