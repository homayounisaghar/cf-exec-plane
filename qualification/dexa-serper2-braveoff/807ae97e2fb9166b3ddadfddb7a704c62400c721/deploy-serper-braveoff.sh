#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
FILE=dexa_web_read_v1.mjs
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
ID=$(printenv RELEASE_ID 2>/dev/null || true)
[ "$ID" = dexa-serper2-braveoff-20261027-v1 ] || { echo INVALID_RELEASE_ID >&2;exit 61; }
BACKUP="$HOME/.local/share/dexa/serper-brave-rollback/$ID"
[ ! -e "$BACKUP" ] && [ ! -e "$FLAG" ] || { echo DEPLOYMENT_ALREADY_ACTIVE >&2;exit 62; }
for service in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
 [ "$(systemctl --user is-active "$service")" = active ] || { echo SERVICE_NOT_READY >&2;exit 63; }
done
[ -f "$ROOT/files/$FILE" ] && [ -f "$BASE/$FILE" ] &&
 [ ! -L "$ROOT/files/$FILE" ] && [ ! -L "$BASE/$FILE" ] ||
 { echo SEARCH_SOURCE_NOT_REGULAR >&2;exit 64; }
(cd "$ROOT/files" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo PROPOSED_HASH_INVALID >&2;exit 65; }
node --check "$ROOT/files/$FILE" >/dev/null
check_brave_disabled(){
 pid=$(systemctl --user show dexa-main.service -p MainPID --value)
 node - "$pid" <<'JS'
const fs=require('fs');const p=Number(process.argv[2]);
if(!Number.isInteger(p)||p<=0)process.exit(6);
const e=fs.readFileSync('/proc/'+p+'/environ','utf8').split('\0');
if(e.includes('DEXA_BRAVE_SEARCH_BACKUP_ENABLED=1'))process.exit(7);
JS
}
check_brave_disabled
node --input-type=module - "$ROOT/files/$FILE" <<'JS'
const m=await import('file://'+process.argv[2]);
const keys=m.readSerperKeySlots();
if(keys.length!==2||keys[0].key===keys[1].key)process.exit(8);
JS
mkdir -p "$(dirname "$FLAG")" "$(dirname "$BACKUP")"
if ! (set -C;printf 'DX005 Serper two-key round-robin and disabled Brave backup %s\n' "$(date -u +%FT%TZ)" > "$FLAG") 2>/dev/null;then
 echo DRAIN_ACQUIRE_FAILED >&2;exit 66
fi
modified=0;done=0;baseline=0
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$modified" = 1 ] && [ "$done" = 0 ];then
  echo DEXA_SERPER2_BRAVEOFF_V1_ROLLBACK_START >&2
  cp -p "$BACKUP/$FILE" "$BASE/$FILE" || :
  systemctl --user restart dexa-main.service || :
  echo DEXA_SERPER2_BRAVEOFF_V1_ROLLBACK_ATTEMPTED >&2
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
idle=0;attempt=0
while [ "$idle" -lt 3 ];do
 if row="$(health)";then
  set -- $row
  [ "$3" = draining ] || { echo DRAIN_NOT_EFFECTIVE >&2;exit 67; }
  baseline=$2
  if [ "$1" -eq 0 ];then idle=$((idle+1));else idle=0;fi
 else idle=0;fi
 attempt=$((attempt+1));[ "$attempt" -le 120 ] || { echo ACTIVE_MISSIONS_NOT_IDLE >&2;exit 68; }
 sleep 1
done
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo SEARCH_LIVE_CAS_MISMATCH >&2;exit 69; }
mkdir -m 700 "$BACKUP"
cp -p "$BASE/$FILE" "$BACKUP/$FILE"
(cd "$BACKUP" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo SEARCH_ROLLBACK_SHA_MISMATCH >&2;exit 70; }
modified=1
cp -p "$ROOT/files/$FILE" "$BASE/$FILE"
(cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo SEARCH_INSTALL_SHA_MISMATCH >&2;exit 71; }
systemctl --user restart dexa-main.service
attempt=0
while [ "$attempt" -lt 85 ];do
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
    { echo SEARCH_POSTRESTART_SHA_MISMATCH >&2;exit 72; }
    check_brave_disabled || { echo BRAVE_BACKUP_UNEXPECTEDLY_ENABLED >&2;exit 72; }
    done=1;rm -f "$FLAG"
    printf 'DEXA_SERPER2_BRAVEOFF_V1_LIVE_VERIFIED preserved=%s release=%s\n' "$2" "$ID"
    exit 0
   fi
  fi
 fi
 attempt=$((attempt+1));sleep 1
done
echo SEARCH_POSTRESTART_HEALTH_FAILED >&2
exit 73
