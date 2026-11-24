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
        tailscale up --authkey "$TS_KEY" --hostname "$(hostname -s)" --ssh
    else
        echo "!! no tailscale-authkey secret: run 'sudo tailscale up --ssh' on the VM"
    fi
fi

# HAPI binary: refreshed on every boot, so a new upload + reboot is a deploy.
install -d -o "$AGENT" -g "$AGENT" "$AGENT_HOME/.hapi" "$AGENT_HOME/.hapi/bin" "$AGENT_HOME/work"
if gcloud storage cp "$HAPI_BINARY" /tmp/hapi.new; then
    install -o "$AGENT" -g "$AGENT" -m 755 /tmp/hapi.new "$AGENT_HOME/.hapi/bin/hapi"
    rm -f /tmp/hapi.new
fi

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
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable hapi-runner
systemctl restart hapi-runner
echo "== hapi agent startup done $(date -Is)"
