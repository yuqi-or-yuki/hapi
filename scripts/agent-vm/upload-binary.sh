#!/bin/bash
# Build the Linux HAPI binary from this checkout and publish it for the agent
# VMs, which install it within two minutes. CI does the same on push to main
# (.github/workflows/deploy-gcp.yml); use this to ship a build by hand.
set -euo pipefail
PROJECT=${HAPI_VM_PROJECT:-tenera-hapi-agents}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
(cd "$ROOT/cli" && bun run scripts/build-executable.ts --target bun-linux-x64-baseline --with-web-assets)
gcloud storage cp "$ROOT/cli/dist-exe/bun-linux-x64-baseline/hapi" "gs://$PROJECT-artifacts/hapi-linux-x64"
