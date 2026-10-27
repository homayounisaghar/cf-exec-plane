#!/bin/sh
# Immutable, scope-limited Dexa Stage5 evidence collector release.
set -eu
umask 077
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
ID=$(printenv RELEASE_ID 2>/dev/null || true)
[ "$ID" = dexa-evidence-20261027-v1 ] || { echo INVALID_RELEASE_ID >&2;exit 61; }
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
BACKUP="$HOME/.local/share/dexa/evidence-rollback/$ID"
FILES="dexa_web_evidence_v1.mjs dexa_catalog_registry.mjs dexa_text_writer_v1.mjs dexa_writer_source_provenance_v1.mjs dexa_tool_plan_executor_v3.mjs dexa_general_plan_cycle_v2.mjs"
OLD_FILES="dexa_catalog_registry.mjs dexa_text_writer_v1.mjs dexa_writer_source_provenance_v1.mjs dexa_tool_plan_executor_v3.mjs dexa_general_plan_cycle_v2.mjs"
[ ! -e "$BACKUP" ] && [ ! -e "$FLAG" ] || { echo DEPLOYMENT_ALREADY_ACTIVE >&2; exit 62; }
for service in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
 [ "$(systemctl --user is-active "$service")" = active ] ||
 { echo SERVICE_NOT_READY >&2;exit 63; }
done
for file in $FILES;do
 [ -f "$ROOT/files/$file" ] && [ ! -L "$ROOT/files/$file" ] ||
 { echo SNAPSHOT_FILE_INVALID >&2; exit 64; }
 node --check "$ROOT/files/$file" >/dev/null
done
for file in $OLD_FILES;do
 [ -f "$BASE/$file" ] && [ ! -L "$BASE/$file" ] ||
 { echo LIVE_FILE_INVALID >&2;exit 65; }
done
[ ! -e "$BASE/dexa_web_evidence_v1.mjs" ] ||
 { echo EVIDENCE_VERSION_ALREADY_PRESENT >&2;exit 66; }
(cd "$ROOT/files" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo PROPOSED_SHA_INVALID >&2; exit 67; }
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo LIVE_BASELINE_SHA_MISMATCH >&2;exit 68; }
check_owner_keys_and_brave_disabled(){
 pid=$(systemctl --user show dexa-main.service -p MainPID --value)
 node - "$pid" "$ROOT/files/dexa_web_read_v1.mjs" <<'JS'
const fs=require("fs");
const p=Number(process.argv[2]);
if(!Number.isInteger(p)||p<=0)process.exit(6);
const env=fs.readFileSync("/proc/"+p+"/environ","utf8").split("\0");
if(env.includes("DEXA_BRAVE_SEARCH_BACKUP_ENABLED=1"))process.exit(7);
JS
 [ ! -f "$HOME/.local/share/dexa-core-service-20261023/brave-search-api.env" ] ||
 { echo BRAVE_KEY_NOT_EXPECTED >&2;return 1; }
 node --input-type=module - "$BASE/dexa_web_read_v1.mjs" <<'JS'
const file=process.argv[2];
const m=await import("file://"+file);
const slots=m.readSerperKeySlots();
if(slots.length!==2||slots[0].key===slots[1].key)process.exit(8);
JS
}
check_owner_keys_and_brave_disabled ||
 { echo PROVIDER_BASELINE_UNSAFE >&2;exit 69; }
mkdir -p "$(dirname "$FLAG")" "$(dirname "$BACKUP")"
if ! (set -C;printf 'DX005 evidence collector %s\n' "$(date -u +%FT%TZ)" > "$FLAG") 2>/dev/null;then
 echo DRAIN_ACQUIRE_FAILED >&2;exit 70
fi
modified=0
done=0
baseline=0
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$modified" = 1 ] && [ "$done" = 0 ];then
  echo EVIDENCE_ROLLBACK_BEGIN >&2
  for file in $OLD_FILES;do
   cp -p "$BACKUP/$file" "$BASE/$file" || :
  done
  rm -f "$BASE/dexa_web_evidence_v1.mjs"
  systemctl --user restart dexa-main.service || :
  echo EVIDENCE_ROLLBACK_ATTEMPTED >&2
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
while [ "$idle" -lt 3 ];do
 if row="$(health)";then
  set -- $row
  [ "$3" = draining ] || { echo DRAIN_NOT_EFFECTIVE >&2;exit 71; }
  baseline=$2
  if [ "$1" -eq 0 ];then idle=$((idle+1));else idle=0;fi
 else idle=0;fi
 attempt=$((attempt+1))
 [ "$attempt" -le 120 ] || { echo ACTIVE_MISSIONS_NOT_IDLE >&2;exit 72; }
 sleep 1
done
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo SEARCH_LIVE_CAS_CHANGED >&2;exit 73; }
[ ! -e "$BASE/dexa_web_evidence_v1.mjs" ] ||
 { echo EVIDENCE_LIVE_CAS_CHANGED >&2;exit 74; }
mkdir -m 700 "$BACKUP"
for file in $OLD_FILES;do cp -p "$BASE/$file" "$BACKUP/$file";done
(cd "$BACKUP" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo ROLLBACK_SHA_INVALID >&2;exit 75; }
modified=1
for file in $FILES;do cp -p "$ROOT/files/$file" "$BASE/$file";done
(cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo INSTALL_SHA_MISMATCH >&2;exit 76; }
systemctl --user restart dexa-main.service
attempt=0
while [ "$attempt" -lt 90 ];do
 if row="$(health)";then
  set -- $row
  if [ "$1" -eq 0 ] && [ "$2" -ge "$baseline" ] &&
   [ "$3" = draining ] && [ "$4" = ready ];then
   all=1
   for service in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
    [ "$(systemctl --user is-active "$service")" = active ] || all=0
   done
   if [ "$all" = 1 ];then
    (cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
    { echo POST_SHA_MISMATCH >&2;exit 77; }
    check_owner_keys_and_brave_disabled ||
    { echo BRAVE_DISABLED_OR_KEYS_GATE_FAILED >&2;exit 78; }
    (cd "$BASE" && node --input-type=module - <<'JS'
import {catalogCounts,catalogRoute} from "./dexa_catalog_registry.mjs";
const x=catalogCounts();
if(x.catalog!==291||x.internalCapabilities!==4||x.cfMapped!==187||
   catalogRoute("web.evidence")?.internalExecutor!=="bounded_public_web")
 process.exit(10);
JS
    ) || { echo CATALOG_CONTRACT_INVALID >&2;exit 79; }
    done=1
    rm -f "$FLAG"
    printf 'DEXA_EVIDENCE_V1_LIVE_VERIFIED missions=%s release=%s\n' "$2" "$ID"
    exit 0
   fi
  fi
 fi
 attempt=$((attempt+1));sleep 1
done
echo EVIDENCE_POSTRESTART_HEALTH_FAILED >&2
exit 80
