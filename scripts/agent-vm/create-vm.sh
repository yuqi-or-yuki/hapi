#!/bin/bash
# Create a HAPI agent VM on GCP. It boots, joins the tailnet and appears in
# HAPI as a machine a few minutes later (see startup.sh).
#   scripts/agent-vm/create-vm.sh <name> [machine-type]
# To ship a new HAPI build to the VMs: upload-binary.sh, then reboot them.
set -euo pipefail
NAME=${1:?usage: create-vm.sh <name> [machine-type]}
TYPE=${2:-e2-standard-4}
PROJECT=${HAPI_VM_PROJECT:-tenera-hapi-agents}
ZONE=${HAPI_VM_ZONE:-us-west1-b}
HUB_URL=${HAPI_VM_HUB_URL:-http://yuqis-mac-mini.tail7998ba.ts.net:3006}
HERE=$(cd "$(dirname "$0")" && pwd)

gcloud compute instances create "$NAME" \
    --project "$PROJECT" --zone "$ZONE" --machine-type "$TYPE" \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 100GB --boot-disk-type pd-balanced \
    --service-account "hapi-agent-vm@$PROJECT.iam.gserviceaccount.com" \
    --scopes cloud-platform \
    --metadata "hapi-api-url=$HUB_URL,hapi-binary=gs://$PROJECT-artifacts/hapi-linux-x64" \
    --metadata-from-file "startup-script=$HERE/startup.sh"

echo "Follow the boot: gcloud compute ssh $NAME --project $PROJECT --zone $ZONE --tunnel-through-iap -- sudo tail -f /var/log/hapi-agent-startup.log"
