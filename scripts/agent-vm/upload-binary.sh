#!/bin/bash
# Build the Linux HAPI binary and publish it for the agent VMs, which fetch it
# on boot. Reboot a VM (or rerun its startup script) to pick it up.
set -euo pipefail
PROJECT=${HAPI_VM_PROJECT:-tenera-hapi-agents}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
(cd "$ROOT/cli" && bun run scripts/build-executable.ts --target bun-linux-x64-baseline --with-web-assets)
gcloud storage cp "$ROOT/cli/dist-exe/bun-linux-x64-baseline/hapi" "gs://$PROJECT-artifacts/hapi-linux-x64"
