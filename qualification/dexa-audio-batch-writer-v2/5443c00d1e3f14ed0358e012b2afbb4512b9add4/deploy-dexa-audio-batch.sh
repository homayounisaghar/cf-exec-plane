#!/bin/sh
set -eu
umask 077
ID=dexa-audio-batch-writer-20261028-v2
[ "${RELEASE_ID:-}" = "$ID" ] || { echo INVALID_RELEASE_ID; exit 60; }
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
BACKUP="$HOME/.local/share/dexa/audio-batch-plan-rollback/$ID"
FILES="dexa_text_writer_v1.mjs"
[ "$(id -un)" = cfserver ] || { echo OWNER_RUNTIME_REQUIRED;exit 61; }
[ ! -e "$BACKUP" ] && [ ! -e "$FLAG" ] || { echo ROLLBACK_OR_DEPLOYMENT_ALREADY_PRESENT;exit 62; }
for svc in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
 [ "$(systemctl --user is-active "$svc")" = active ] || { echo SERVICE_NOT_ACTIVE;exit 63; }
done
for f in $FILES;do
 [ -f "$BASE/$f" ] && [ ! -L "$BASE/$f" ] &&
 [ -f "$ROOT/files/$f" ] && [ ! -L "$ROOT/files/$f" ] ||
 { echo INPUT_NOT_REGULAR; exit 64; }
done
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo BASELINE_SHA_CHANGED;exit 65; }
(cd "$ROOT/files" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo PROPOSED_SHA_INVALID;exit 66; }
for f in $FILES;do node --check "$ROOT/files/$f";done
CF_BEFORE=$(readlink /opt/capability-fabric/current)
PCG_BEFORE=$(readlink /opt/capability-fabric/channels/pcg/current)
GATEWAY_PID=$(systemctl --user show dexa-catalog-gateway.service -p MainPID --value)
MOBILE_PID=$(systemctl --user show dexa-mobile-gateway.service -p MainPID --value)
[ -n "$CF_BEFORE" ] && [ -n "$PCG_BEFORE" ] || { echo BASELINE_SERVICE_LINKS_MISSING;exit 67; }
mkdir -p "$(dirname "$FLAG")" "$(dirname "$BACKUP")"
if ! (set -C; printf 'Dexa batch plan deployment %s\n' "$(date -u '+%FT%TZ')" > "$FLAG") 2>/dev/null;then
 echo DRAIN_BUSY;exit 68
fi
modified=0
done=0
cleanup() {
 rc=$?
 trap - EXIT
 if [ "$modified" -eq 1 ] && [ "$done" -eq 0 ];then
  echo DEXA_AUDIO_BATCH_AUTOROLLBACK_START
  for f in $FILES;do cp -p "$BACKUP/$f" "$BASE/$f" || :;done
  systemctl --user restart dexa-main.service || :
  echo DEXA_AUDIO_BATCH_AUTOROLLBACK_ATTEMPTED
 fi
 rm -f "$FLAG"
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
health() {
 curl -fsS --max-time 5 http://127.0.0.1:9471/healthz |
 node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{try{const x=JSON.parse(s);if(x.ok!==true||!Number.isSafeInteger(x.activeMissions)||!Number.isSafeInteger(x.storedMissions))process.exit(3);console.log([x.activeMissions,x.storedMissions,x.deploymentDrain?.active===true?"draining":"open",x.plannerHotSlot?.ready===true?"ready":"notready"].join(" "))}catch{process.exit(3)}})'
}
stable=0
attempt=0
baseline_count=0
while [ "$stable" -lt 3 ];do
 if row=$(health);then
  set -- $row
  [ "$3" = draining ] || { echo DRAIN_NOT_EFFECTIVE;exit 69; }
  baseline_count=$2
  if [ "$1" -eq 0 ];then stable=$((stable+1));else stable=0;fi
 else stable=0;fi
 attempt=$((attempt+1))
 [ "$attempt" -lt 105 ] || { echo DEXA_MISSION_NOT_IDLE;exit 70; }
 sleep 1
done
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo SOURCE_CAS_CHANGED;exit 71; }
mkdir -m 700 "$BACKUP"
for f in $FILES;do cp -p "$BASE/$f" "$BACKUP/$f";done
(cd "$BACKUP" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo ROLLBACK_HASH_INVALID;exit 72; }
modified=1
for f in $FILES;do cp "$ROOT/files/$f" "$BASE/$f";done
(cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo INSTALL_HASH_INVALID;exit 73; }
systemctl --user restart dexa-main.service
attempt=0
while [ "$attempt" -lt 90 ];do
 if row=$(health);then
  set -- $row
  if [ "$1" -eq 0 ] && [ "$2" -ge "$baseline_count" ] && [ "$3" = draining ] && [ "$4" = ready ];then
   all=1
   for svc in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
    [ "$(systemctl --user is-active "$svc")" = active ] || all=0
   done
   [ "$(systemctl --user show dexa-catalog-gateway.service -p MainPID --value)" = "$GATEWAY_PID" ] || all=0
   [ "$(systemctl --user show dexa-mobile-gateway.service -p MainPID --value)" = "$MOBILE_PID" ] || all=0
   [ "$(readlink /opt/capability-fabric/current)" = "$CF_BEFORE" ] || all=0
   [ "$(readlink /opt/capability-fabric/channels/pcg/current)" = "$PCG_BEFORE" ] || all=0
   if [ "$all" -eq 1 ];then
    (cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
      { echo POSTRESTART_HASH_MISMATCH;exit 74; }
    (cd "$BASE" && node --input-type=module - <<'JS'
import {buildTypedPlannerPrompt} from "./dexa_typed_planner_prompt_v3.mjs";
import {writerEvidencePacket,prepareTextWriter,verifyTextWriterReply,DEXA_TEXT_WRITER_SCHEMA} from "./dexa_text_writer_v1.mjs";
import {inputSchemaFor} from "./dexa_catalog_registry.mjs";
const id="tool.cf.audio_transcribe";
if(inputSchemaFor(id)?.properties?.files?.maxItems!==20)process.exit(21);
const p=buildTypedPlannerPrompt({goal:"summarize audio batch",
cards:[{id,description:"audio transcription",routes:[]}]});
if(!p.includes("MANDATORY AUDIO BATCH CONTRACT"))process.exit(22);
const row={state:"SUCCEEDED",transcript_available:true,
 source_sha256:"a".repeat(64),transcript:"x".repeat(1400)};
const pkt=writerEvidencePacket([row]);
if(pkt.records.length!==2||pkt.limitedCoverage!==false||
 pkt.records.map(x=>x.text).join("").length!==1400)process.exit(23);
const audio=Array.from({length:11},(_,i)=>({state:"SUCCEEDED",transcript_available:true,
 source_sha256:"a".repeat(64),transcript:"source "+i}));
const prep=prepareTextWriter({args:{operation:"summarize",source:audio},ownerGoal:"Summarize 11 recordings"});
const modelReply=JSON.stringify({schema:DEXA_TEXT_WRITER_SCHEMA,status:"COMPLETE",
 text:"Synthetic multi-file summary verified.",evidence_indices:Array.from({length:11},(_,i)=>i)});
if(verifyTextWriterReply(modelReply,{prepared:prep}).evidence_indices.length!==11)process.exit(24);
console.log("DEXA_AUDIO_BATCH_WRITER_V2_LIVE_IMPORTS_VERIFIED");
JS
    ) || { echo LIVE_IMPORT_VERIFICATION_FAILED;exit 75; }
    done=1
    rm -f "$FLAG"
    echo "DEXA_AUDIO_BATCH_RELEASE_LIVE_OK missions_preserved=$2 release=$ID"
    exit 0
   fi
  fi
 fi
 attempt=$((attempt+1))
 sleep 1
done
echo DEXA_AUDIO_BATCH_POSTRESTART_HEALTH_NOT_CONFIRMED
exit 76
