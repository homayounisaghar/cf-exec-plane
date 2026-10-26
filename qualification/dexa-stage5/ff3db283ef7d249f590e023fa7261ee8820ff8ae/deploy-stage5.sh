#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
SRC="$ROOT/files"
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
DRAIN="$HOME/.local/share/dexa/deployment-drain.flag"
RELEASE=$(printenv RELEASE_ID 2>/dev/null || true)
[ "$RELEASE" = dexa-stage5-20261027-v1 ] || { echo INVALID_RELEASE >&2;exit 61; }
BACKUP="$HOME/.local/share/dexa/stage5-rollback/$RELEASE"
[ ! -e "$BACKUP" ] || { echo BACKUP_MUST_BE_FRESH >&2;exit 62; }
[ ! -e "$DRAIN" ] || { echo OTHER_DEPLOYMENT_ACTIVE >&2;exit 63; }
OLD="server.mjs dexa_text_writer_v1.mjs dexa_catalog_registry.mjs dexa_effect_contract_v1.mjs dexa_general_catalog_planner_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_catalog_output_shapes_v1.json dexa_catalog_output_adapters_v1.mjs dexa_tool_plan_executor_v3.mjs"
NEW="dexa_writer_source_provenance_v1.mjs dexa_web_read_v1.mjs"
ALL="$OLD $NEW"
for f in $ALL;do
 [ -f "$SRC/$f" ] && [ ! -L "$SRC/$f" ] || { echo SOURCE_INVALID >&2;exit 64; }
done
for f in $OLD;do
 [ -f "$BASE/$f" ] && [ ! -L "$BASE/$f" ] || { echo LIVE_FILE_INVALID >&2;exit 64; }
done
for unit in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
 [ "$(systemctl --user is-active "$unit")" = active ] || { echo UNIT_NOT_ACTIVE >&2;exit 64; }
done
(cd "$SRC" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo PROPOSED_SNAPSHOT_INVALID >&2;exit 65; }
for f in $ALL;do
 case "$f" in *.mjs)node --check "$SRC/$f" >/dev/null;;esac
done
node -e 'const d=require(process.argv[1]);if(d.schema!=="dexa.catalog-output-shapes.v1")process.exit(7)' "$SRC/dexa_catalog_output_shapes_v1.json"
mkdir -p "$(dirname "$DRAIN")" "$(dirname "$BACKUP")"
if ! (set -C;printf 'DX005 controlled release %s\n' "$(date -u +%FT%TZ)" > "$DRAIN") 2>/dev/null;then
 echo DRAIN_ACQUIRE_FAILED >&2;exit 66
fi
modified=0;success=0;baseline=0
cleanup(){
 rc=$?
 trap - EXIT
 if [ "$modified" = 1 ] && [ "$success" = 0 ];then
  echo DX005_ROLLBACK_START >&2
  for f in $OLD;do cp -p "$BACKUP/$f" "$BASE/$f" || :;done
  for f in $NEW;do rm -f "$BASE/$f" || :;done
  systemctl --user restart dexa-main.service || :
  echo DX005_ROLLBACK_ATTEMPTED >&2
 fi
 rm -f "$DRAIN"
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
health(){
 curl -fsS --max-time 4 http://127.0.0.1:9471/healthz |
 node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const d=JSON.parse(s);if(d.ok!==true||!Number.isSafeInteger(d.activeMissions)||!Number.isSafeInteger(d.storedMissions))process.exit(1);console.log([d.activeMissions,d.storedMissions,d.deploymentDrain?.active===true?"draining":"open",d.plannerHotSlot?.ready===true?"ready":"notready"].join(" "))}catch{process.exit(2)}})'
}
stable=0;attempt=0
while [ "$stable" -lt 3 ];do
 if row="$(health)";then
  set -- $row
  [ "$3" = draining ] || { echo DRAIN_NOT_VISIBLE >&2;exit 67; }
  baseline=$2
  if [ "$1" -eq 0 ];then stable=$((stable+1));else stable=0;fi
 else stable=0;fi
 attempt=$((attempt+1))
 [ "$attempt" -le 120 ] || { echo DRAIN_TIMEOUT >&2;exit 68; }
 sleep 1
done
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo LIVE_CAS_MISMATCH >&2;exit 69; }
for f in $NEW;do
 [ ! -e "$BASE/$f" ] || { echo NEW_FILE_ALREADY_EXISTS >&2;exit 69; }
done
mkdir -m 700 "$BACKUP"
for f in $OLD;do cp -p "$BASE/$f" "$BACKUP/$f";done
(cd "$BACKUP" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo ROLLBACK_BACKUP_SHA_MISMATCH >&2;exit 70; }
modified=1
for f in $ALL;do cp -p "$SRC/$f" "$BASE/$f";done
(cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo LIVE_COPY_SHA_MISMATCH >&2;exit 71; }
systemctl --user restart dexa-main.service
attempt=0
while [ "$attempt" -lt 90 ];do
 if row="$(health)";then
  set -- $row
  if [ "$1" -eq 0 ] && [ "$2" -ge "$baseline" ] &&
   [ "$3" = draining ] && [ "$4" = ready ];then
   good=1
   for unit in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
    [ "$(systemctl --user is-active "$unit")" = active ] || good=0
   done
   if [ "$good" = 1 ];then
    (cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
      { echo POST_RESTART_CAS_MISMATCH >&2;exit 72; }
    success=1;rm -f "$DRAIN"
    echo "DX005_DEPLOY_LIVE_OK release=$RELEASE preserved=$2"
    exit 0
   fi
  fi
 fi
 attempt=$((attempt+1));sleep 1
done
echo DX005_HEALTH_NOT_VERIFIED >&2
exit 73
