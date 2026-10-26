#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
FILES="$ROOT/files"
MAIN=/var/lib/capability-fabric/paa-remote/dexa-mvp
MOBILE=/home/cfserver/.local/share/dexa-mobile-gateway-20261023
HEALTH=http://127.0.0.1:9471/healthz
MOBILE_HEALTH=http://127.0.0.1:9482/_local-health
DRAIN="$HOME/.local/share/dexa/deployment-drain.flag"
RELEASE=$(printenv RELEASE_ID 2>/dev/null || true)
[ "$RELEASE" = "dexa-stage4-pause-20261026-v3" ] || { echo INVALID_RELEASE_ID >&2;exit 61; }
BACKUP="$HOME/.local/share/dexa/stage4-pause-rollback/$RELEASE"
[ ! -e "$BACKUP" ] || { echo FRESH_ROLLBACK_REQUIRED >&2;exit 62; }
[ ! -e "$DRAIN" ] || { echo OTHER_DEPLOYMENT_DRAIN_ACTIVE >&2;exit 62; }
for f in server.mjs index.html dexa_mission_control_contract_v1.mjs;do
 [ -f "$FILES/$f" ] && [ ! -L "$FILES/$f" ] &&
 [ -f "$MAIN/$f" ] && [ ! -L "$MAIN/$f" ] ||
 { echo "FILE_NOT_REGULAR $f" >&2;exit 63; }
done
[ -f "$MOBILE/mobile-gateway.mjs" ] && [ ! -L "$MOBILE/mobile-gateway.mjs" ] ||
 { echo MOBILE_SOURCE_INVALID >&2;exit 63; }
for unit in dexa-main.service dexa-mobile-gateway.service dexa-catalog-gateway.service;do
 [ "$(systemctl --user is-active "$unit")" = active ] ||
 { echo "SERVICE_UNHEALTHY $unit" >&2;exit 64; }
done
(cd "$FILES" && sha256sum -c "$ROOT/proposed-main.sha256" >/dev/null) ||
 { echo PROPOSED_HASH_NOT_MATCHING >&2;exit 65; }
node --check "$FILES/server.mjs" >/dev/null
node --check "$FILES/dexa_mission_control_contract_v1.mjs" >/dev/null
node - "$FILES/index.html" <<'JS'
const fs=require('fs');
const html=fs.readFileSync(process.argv[2],'utf8');
for(const tag of html.match(/<script[^>]*>([\s\S]*?)<\/script>/g)||[])
 new Function(tag.replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''));
JS
[ -f "$ROOT/apply-mobile-stage4.py" ] || exit 65
[ -f "$ROOT/baseline-mobile.sha256" ] && [ -f "$ROOT/proposed-mobile.sha256" ] || exit 65
[ -f "$ROOT/baseline-main.sha256" ] || exit 65
[ -f "$ROOT/approved-old-index-sha256.txt" ] || exit 65
INDEX_BEFORE=$(sha256sum "$MAIN/index.html" | cut -d ' ' -f1)
grep -Fxq "$INDEX_BEFORE" "$ROOT/approved-old-index-sha256.txt" ||
 { echo UNRECOGNIZED_CONCURRENT_INDEX_VERSION >&2;exit 66; }
TEMP="$(mktemp -d "$HOME/.local/share/dexa/stage4-pause-preflight.XXXXXXXX")"
trap 'rm -rf "$TEMP"' EXIT
python3 "$ROOT/apply-mobile-stage4.py" "$MOBILE/mobile-gateway.mjs" "$TEMP/mobile-gateway.mjs"
(cd "$TEMP" && sha256sum -c "$ROOT/proposed-mobile.sha256" >/dev/null) ||
 { echo PRIVATE_MOBILE_PATCH_NOT_VERIFIED >&2;exit 66; }
node --check "$TEMP/mobile-gateway.mjs"
mkdir -p "$(dirname "$BACKUP")"
if ! (set -C; printf 'Stage4 owner pause release %s\n' "$(date -u +%FT%TZ)" > "$DRAIN") 2>/dev/null;then
 echo DRAIN_ACQUIRE_FAILED >&2;exit 66
fi
modified=0;success=0;baseline=0
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$modified" = 1 ] && [ "$success" = 0 ];then
  echo STAGE4_PAUSE_ROLLBACK_START >&2
  for f in server.mjs index.html dexa_mission_control_contract_v1.mjs;do
   cp -p "$BACKUP/main/$f" "$MAIN/$f" || :
  done
  cp -p "$BACKUP/mobile/mobile-gateway.mjs" "$MOBILE/mobile-gateway.mjs" || :
  systemctl --user restart dexa-main.service || :
  systemctl --user restart dexa-mobile-gateway.service || :
  echo STAGE4_PAUSE_ROLLBACK_ATTEMPTED >&2
 fi
 rm -f "$DRAIN"
 rm -rf "$TEMP"
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
health(){
 curl -fsS --max-time 4 "$HEALTH" |
 node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const d=JSON.parse(s);if(d.ok!==true||!Number.isSafeInteger(d.storedMissions)||!Number.isSafeInteger(d.activeMissions))process.exit(1);console.log([d.activeMissions,d.storedMissions,d.deploymentDrain?.active===true?"draining":"open",d.missionControl?.schema||"none",d.plannerHotSlot?.ready===true?"ready":"notready"].join(" "))}catch{process.exit(2)}})'
}
stable=0;attempt=0
while [ "$stable" -lt 3 ];do
 if line="$(health)";then
  set -- $line
  [ "$3" = draining ] || { echo DEPLOYMENT_DRAIN_NOT_OBSERVED >&2;exit 67; }
  baseline=$2
  if [ "$1" -eq 0 ];then stable=$((stable+1));else stable=0;fi
 else stable=0;fi
 attempt=$((attempt+1))
 [ "$attempt" -le 120 ] || { echo ACTIVE_MISSIONS_DID_NOT_DRAIN >&2;exit 68; }
 sleep 1
done
(cd "$MAIN" && sha256sum -c "$ROOT/baseline-main.sha256" >/dev/null) ||
 { echo MAIN_SOURCE_CHANGED_SINCE_SNAPSHOT >&2;exit 69; }
[ "$(sha256sum "$MAIN/index.html" | cut -d ' ' -f1)" = "$INDEX_BEFORE" ] ||
 { echo CONCURRENT_INDEX_CHANGED_DURING_DRAIN >&2;exit 69; }
(cd "$MOBILE" && sha256sum -c "$ROOT/baseline-mobile.sha256" >/dev/null) ||
 { echo MOBILE_SOURCE_CHANGED_SINCE_SNAPSHOT >&2;exit 69; }
mkdir -m 700 "$BACKUP"
mkdir -m 700 "$BACKUP/main" "$BACKUP/mobile"
for f in server.mjs index.html dexa_mission_control_contract_v1.mjs;do
 cp -p "$MAIN/$f" "$BACKUP/main/$f"
done
cp -p "$MOBILE/mobile-gateway.mjs" "$BACKUP/mobile/mobile-gateway.mjs"
(cd "$BACKUP/main" && sha256sum -c "$ROOT/baseline-main.sha256" >/dev/null) ||
 { echo MAIN_ROLLBACK_BACKUP_INVALID >&2;exit 70; }
[ "$(sha256sum "$BACKUP/main/index.html" | cut -d ' ' -f1)" = "$INDEX_BEFORE" ] ||
 { echo CONCURRENT_INDEX_ROLLBACK_BACKUP_INVALID >&2;exit 70; }
(cd "$BACKUP/mobile" && sha256sum -c "$ROOT/baseline-mobile.sha256" >/dev/null) ||
 { echo MOBILE_ROLLBACK_BACKUP_INVALID >&2;exit 70; }
modified=1
for f in server.mjs index.html dexa_mission_control_contract_v1.mjs;do
 cp -p "$FILES/$f" "$MAIN/$f"
done
cp -p "$TEMP/mobile-gateway.mjs" "$MOBILE/mobile-gateway.mjs"
(cd "$MAIN" && sha256sum -c "$ROOT/proposed-main.sha256" >/dev/null) ||
 { echo MAIN_COPIED_HASH_MISMATCH >&2;exit 71; }
(cd "$MOBILE" && sha256sum -c "$ROOT/proposed-mobile.sha256" >/dev/null) ||
 { echo MOBILE_COPIED_HASH_MISMATCH >&2;exit 71; }
systemctl --user restart dexa-main.service
systemctl --user restart dexa-mobile-gateway.service
attempt=0
while [ "$attempt" -lt 90 ];do
 if line="$(health)";then
  set -- $line
  if [ "$1" -eq 0 ] && [ "$2" -ge "$baseline" ] && [ "$3" = draining ] &&
   [ "$4" = dexa.mission-control.v1 ] && [ "$5" = ready ];then
   triad=1
   for unit in dexa-main.service dexa-mobile-gateway.service dexa-catalog-gateway.service;do
    [ "$(systemctl --user is-active "$unit")" = active ] || triad=0
   done
   if [ "$triad" = 1 ] && { curl -fsS --max-time 5 "$MOBILE_HEALTH" | grep -q '"ok":true'; };then
    (cd "$MAIN" && sha256sum -c "$ROOT/proposed-main.sha256" >/dev/null) ||
    { echo MAIN_POSTRESTART_SHA_CHANGED >&2;exit 72; }
    (cd "$MOBILE" && sha256sum -c "$ROOT/proposed-mobile.sha256" >/dev/null) ||
    { echo MOBILE_POSTRESTART_SHA_CHANGED >&2;exit 72; }
    printf 'STAGE4_PAUSE_DEPLOYED release=%s missions_preserved=%s\n' "$RELEASE" "$2"
    success=1;rm -f "$DRAIN"
    exit 0
   fi
  fi
 fi
 attempt=$((attempt+1));sleep 1
done
echo STAGE4_PAUSE_POSTRESTART_HEALTH_NOT_VERIFIED >&2
exit 73
