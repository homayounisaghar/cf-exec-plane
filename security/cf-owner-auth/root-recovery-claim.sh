#!/usr/bin/env bash
set -euo pipefail

: "${RECOVERY_TOOL:?RECOVERY_TOOL is required}"

container="capability-fabric-onshape-server"
state_dir="/agent-state/owner-auth"
open_script='import { createOwnerAuthGate } from "/tmp/app/owner-auth.mjs"; const gate=createOwnerAuthGate({stateDir:"/agent-state/owner-auth",buildId:"root-recovery"}); const state=gate.readState(); const result=await gate.adminBootstrap({ownerFingerprints:state.owners.map((x)=>x.subject_fingerprint),organizationFingerprints:state.organization_fingerprints,mode:"observe"}); console.log(JSON.stringify(result));'
close_script='import { createOwnerAuthGate } from "/tmp/app/owner-auth.mjs"; const gate=createOwnerAuthGate({stateDir:"/agent-state/owner-auth",buildId:"root-recovery"}); const state=gate.readState(); const result=await gate.adminBootstrap({ownerFingerprints:state.owners.map((x)=>x.subject_fingerprint),organizationFingerprints:state.organization_fingerprints,mode:"enforce"}); console.log(JSON.stringify(result));'
claim_script='import { createOwnerAuthGate } from "/tmp/app/owner-auth.mjs"; const gate=createOwnerAuthGate({stateDir:"/agent-state/owner-auth",buildId:"root-recovery"}); const state=gate.readState(); const fp=process.env.CF_RECOVERY_FP; const owners=[...new Set([...state.owners.map((x)=>x.subject_fingerprint),fp])]; const result=await gate.adminBootstrap({ownerFingerprints:owners,organizationFingerprints:state.organization_fingerprints,mode:"enforce"}); console.log(JSON.stringify({mode:result.mode,owner_count:result.owner_count,organization_pin_count:result.organization_pin_count,recovery_added:true}));'

docker exec -e CF_OWNER_AUTH_STATE_DIR="$state_dir" "$container" node --input-type=module -e "$open_script"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
claimed=0

cleanup() {
  if [[ "$claimed" != "1" ]]; then
    docker exec -e CF_OWNER_AUTH_STATE_DIR="$state_dir" "$container" node --input-type=module -e "$close_script" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  fp="$(docker logs "$container" --since "$since" 2>&1 | grep '"event":"cf_owner_auth_observe"' | grep -F "\"tool\":\"${RECOVERY_TOOL}\"" | grep -oE 'cfsub_[0-9a-f]{64}' | tail -1 || true)"
  if [[ "$fp" =~ ^cfsub_[0-9a-f]{64}$ ]]; then
    docker exec -e CF_OWNER_AUTH_STATE_DIR="$state_dir" -e CF_RECOVERY_FP="$fp" "$container" node --input-type=module -e "$claim_script"
    claimed=1
    exit 0
  fi
  sleep 2
done

exit 42
