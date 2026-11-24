#!/bin/bash
# Copy the Codex login from a signed-in agent VM into Secret Manager, so VMs
# created afterwards start signed in. The login never touches this machine's
# disk or terminal: it is piped from the VM straight into the secret.
#   scripts/agent-vm/save-logins.sh <vm-name>
# (Claude Code's login is a token from `claude setup-token`, stored as the
# claude-oauth-token secret; it is not machine-specific.)
set -euo pipefail
NAME=${1:?usage: save-logins.sh <vm-name>}
PROJECT=${HAPI_VM_PROJECT:-tenera-hapi-agents}
ZONE=${HAPI_VM_ZONE:-us-west1-b}

gcloud secrets describe codex-auth-json --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud secrets create codex-auth-json --project "$PROJECT" --replication-policy automatic
gcloud compute ssh "$NAME" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap \
    --command 'sudo cat /home/agent/.codex/auth.json' \
    | gcloud secrets versions add codex-auth-json --project "$PROJECT" --data-file=-
