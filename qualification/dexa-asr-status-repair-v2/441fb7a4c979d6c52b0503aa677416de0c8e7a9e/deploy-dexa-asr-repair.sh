#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
ID=$(printenv RELEASE_ID 2>/dev/null || true)
[ "$ID" = dexa-asr-status-repair-20261027-v2 ] || { echo INVALID_RELEASE_ID >&2; exit 61; }
FILES="dexa_tool_plan_executor_v3.mjs dexa_text_writer_v1.mjs dexa_writer_source_provenance_v1.mjs"
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
BACKUP="$HOME/.local/share/dexa/asr-poll-repair-rollback/$ID"
[ ! -e "$BACKUP" ] && [ ! -e "$FLAG" ] || { echo DEPLOYMENT_ALREADY_ACTIVE >&2; exit 62; }
for service in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service; do
 [ "$(systemctl --user is-active "$service")" = active ] || { echo SERVICE_NOT_READY_$service >&2; exit 63; }
done
for f in $FILES; do
 [ -f "$ROOT/files/$f" ] && [ -f "$BASE/$f" ] &&
 [ ! -L "$ROOT/files/$f" ] && [ ! -L "$BASE/$f" ] ||
 { echo MISSING_REGULAR_SOURCE_$f >&2; exit 64; }
done
(cd "$ROOT/files" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo PROPOSED_HASH_INVALID >&2; exit 65; }
for f in $FILES; do
 case "$f" in *.mjs) node --check "$ROOT/files/$f" >/dev/null ;; esac
done
mkdir -p "$(dirname "$FLAG")" "$(dirname "$BACKUP")"
if ! (set -C; printf 'Dexa ASR polling repair %s\n' "$(date -u +%FT%TZ)" > "$FLAG") 2>/dev/null; then
 echo DRAIN_ACQUIRE_FAILED >&2; exit 66
fi
modified=0
done=0
baseline=0
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$modified" = 1 ] && [ "$done" = 0 ]; then
  echo DEXA_ASR_POLL_REPAIR_ROLLBACK_START >&2
  for f in $FILES; do cp -p "$BACKUP/$f" "$BASE/$f" || :; done
  systemctl --user restart dexa-main.service || :
  echo DEXA_ASR_POLL_REPAIR_ROLLBACK_ATTEMPTED >&2
 fi
 rm -f "$FLAG"
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
health(){
 curl -fsS --max-time 5 http://127.0.0.1:9471/healthz |
 node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const d=JSON.parse(s);if(d.ok!==true||!Number.isSafeInteger(d.activeMissions)||!Number.isSafeInteger(d.storedMissions))process.exit(1);console.log([d.activeMissions,d.storedMissions,d.deploymentDrain?.active===true?"draining":"open",d.plannerHotSlot?.ready===true?"ready":"notready"].join(" "))}catch{process.exit(2)}})'
}
idle=0
attempt=0
while [ "$idle" -lt 3 ]; do
 if row="$(health)"; then
  set -- $row
  [ "$3" = draining ] || { echo DRAIN_NOT_EFFECTIVE >&2; exit 67; }
  baseline=$2
  if [ "$1" -eq 0 ]; then idle=$((idle+1)); else idle=0; fi
 else idle=0; fi
 attempt=$((attempt+1))
 [ "$attempt" -le 100 ] || { echo ACTIVE_MISSIONS_NOT_IDLE >&2; exit 68; }
 sleep 1
done
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo SOURCE_CAS_CHANGED >&2; exit 69; }
mkdir -m 700 "$BACKUP"
for f in $FILES; do cp -p "$BASE/$f" "$BACKUP/$f"; done
(cd "$BACKUP" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo ROLLBACK_HASH_MISMATCH >&2; exit 70; }
modified=1
for f in $FILES; do cp -p "$ROOT/files/$f" "$BASE/$f"; done
(cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo INSTALL_SHA_MISMATCH >&2; exit 71; }
systemctl --user restart dexa-main.service
attempt=0
while [ "$attempt" -lt 90 ]; do
 if row="$(health)"; then
  set -- $row
  if [ "$1" -eq 0 ] && [ "$2" -ge "$baseline" ] &&
     [ "$3" = draining ] && [ "$4" = ready ]; then
   all=1
   for service in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service; do
    [ "$(systemctl --user is-active "$service")" = active ] || all=0
   done
   if [ "$all" = 1 ]; then
    (cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
     { echo POSTRESTART_SHA_MISMATCH >&2; exit 72; }
    (cd "$BASE" && node --input-type=module -e 'import {adapterForCapability} from "./dexa_async_receipt_protocol.mjs"; import {catalogKnownOutputShape} from "./dexa_catalog_output_adapters_v1.mjs"; if(adapterForCapability("tool.cf.audio_transcribe")?.statusCapabilityId!=="tool.cf.audio_transcribe"||!catalogKnownOutputShape("tool.cf.audio_transcribe")?.arrays?.files?.fields?.includes("transcript"))process.exit(5);') ||
      { echo LIVE_IMPORT_CONTRACT_FAILED >&2; exit 74; }
    (cd "$BASE" && node --input-type=module - <<'JS'
import {adapterForCapability} from "./dexa_async_receipt_protocol.mjs";
import {admitCatalogCall,catalogRoute} from "./dexa_catalog_registry.mjs";
import {writerEvidencePacket} from "./dexa_text_writer_v1.mjs";
const batchId="e".repeat(64), adapter=adapterForCapability("tool.cf.audio_transcribe");
if(adapter?.buildStatusArgs(batchId)?.batch_id!==batchId)process.exit(21);
const call=admitCatalogCall({capabilityId:"tool.cf.audio_transcribe",
 args:adapter.buildStatusArgs(batchId)});
if(call.tool!=="audio_transcribe"||Object.hasOwn(call.args,"request_id"))process.exit(22);
if(catalogRoute("web.evidence")?.internalExecutor!=="bounded_public_web")process.exit(23);
const rows=writerEvidencePacket("a".repeat(938));
if(rows.limitedCoverage!==false||rows.records.length<2)process.exit(24);
console.log("DEXA_ASR_STATUS_AND_WEB_EVIDENCE_POSTRESTART_OK");
JS
    ) || { echo DEXA_ASR_POSTRESTART_STATUS_CONTRACT_FAIL >&2; exit 75; }
    done=1
    rm -f "$FLAG"
    printf 'DEXA_ASR_POLL_REPAIR_LIVE_OK preserved=%s release=%s\n' "$2" "$ID"
    exit 0
   fi
  fi
 fi
 attempt=$((attempt+1))
 sleep 1
done
echo DEXA_ASR_POLL_REPAIR_POSTRESTART_HEALTH_FAILED >&2
exit 73
