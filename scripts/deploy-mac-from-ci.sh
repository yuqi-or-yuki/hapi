#!/bin/bash
# Deploy HAPI on this Mac from the build GitHub Actions made, instead of
# building locally (about a minute in CI against twenty on a loaded Mac).
#   scripts/deploy-mac-from-ci.sh [commit]     default: the pushed tip of main
# Waits for that commit's "Deploy to GCP agent VMs" run, downloads its macOS
# binary and hands it to ~/.hapi/bin/hapi-deploy, which signs it, swaps it in
# and restarts only the hub.
set -euo pipefail
REPO=${HAPI_CI_REPO:-yuqi-or-yuki/hapi}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SHA=${1:-$(git -C "$ROOT" ls-remote "https://github.com/$REPO.git" refs/heads/main | cut -f1)}
[ -n "$SHA" ] || { echo "could not resolve the commit to deploy" >&2; exit 1; }
echo "Deploying $SHA from $REPO"

RUN=""
for _ in $(seq 1 60); do
    RUN=$(gh run list -R "$REPO" --workflow deploy-gcp.yml --commit "$SHA" -L 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    [ -n "$RUN" ] && break
    sleep 5
done
[ -n "$RUN" ] || { echo "no CI run for $SHA yet: is it pushed to main?" >&2; exit 1; }
gh run watch "$RUN" -R "$REPO" --exit-status >/dev/null

DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
gh run download "$RUN" -R "$REPO" -n hapi-darwin-arm64 -D "$DIR"
chmod 755 "$DIR/hapi"
"$HOME/.hapi/bin/hapi-deploy" "$DIR/hapi"
