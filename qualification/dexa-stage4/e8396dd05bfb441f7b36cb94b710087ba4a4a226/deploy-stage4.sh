#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
SRC="$ROOT/files"
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
HEALTH=http://127.0.0.1:9471/healthz
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
RID="$(printenv RELEASE_ID 2>/dev/null || true)"
case "$RID" in dexa-stage4-20261026-[a-z0-9]*) ;; *) echo RELEASE_ID_INVALID >&2;exit 64;;esac
BACKUP="$HOME/.local/share/dexa/stage4-rollback/$RID"
[ ! -e "$BACKUP" ] || { echo BACKUP_EXISTS >&2; exit 63; }
for u in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
 [ "$(systemctl --user is-active "$u")" = active ] || { echo "SERVICE_INACTIVE $u" >&2;exit 63; }
done
(cd "$SRC" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) || exit 63
for f in server.mjs rana.mjs dexa_tool_plan_executor_v3.mjs dexa_workflow_kernel.mjs dexa_mission_control_contract_v1.mjs dexa_mission_control_future_v1.mjs dexa_provider_cancel_v1.mjs;do
 node --check "$SRC/$f" >/dev/null || exit 63
done
node - "$SRC/index.html" <<'JS'
const fs=require('fs'),src=fs.readFileSync(process.argv[2],'utf8');
for(const s of src.match(/<script[^>]*>([\s\S]*?)<\/script>/g)||[])
 new Function(s.replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''));
JS
mkdir -p "$(dirname "$FLAG")" "$(dirname "$BACKUP")"
if ! (set -C; printf 'Stage4 %s\n' "$(date -u +%FT%TZ)" > "$FLAG") 2>/dev/null;then
 echo DEPLOYMENT_ALREADY_DRAINING >&2;exit 65
fi
modified=0;committed=0;baseline=0
cleanup(){
 rc=$?; trap - EXIT
 if [ "$modified" = 1 ] && [ "$committed" = 0 ];then
  echo STAGE4_ROLLBACK_START >&2
  for f in server.mjs rana.mjs dexa_tool_plan_executor_v3.mjs dexa_workflow_kernel.mjs index.html;do
   cp -p "$BACKUP/$f" "$BASE/$f" || :
  done
  for f in dexa_mission_control_contract_v1.mjs dexa_mission_control_future_v1.mjs dexa_provider_cancel_v1.mjs;do
   rm -f "$BASE/$f" || :
  done
  systemctl --user restart dexa-main.service || :
  echo STAGE4_ROLLBACK_ATTEMPTED >&2
 fi
 rm -f "$FLAG";exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
health(){
 curl -fsS --max-time 4 "$HEALTH" |
 node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const x=JSON.parse(s);if(x.ok!==true||!Number.isSafeInteger(x.activeMissions)||!Number.isSafeInteger(x.storedMissions))process.exit(1);console.log([x.activeMissions,x.storedMissions,x.deploymentDrain?.active===true?"draining":"open",x.missionControl?.schema||"NONE",x.plannerHotSlot?.ready===true?"ready":"notready"].join(" "))}catch{process.exit(2)}})'
}
stable=0;attempt=0
while [ "$stable" -lt 3 ];do
 if row="$(health)";then
  set -- $row
  [ "$3" = draining ] || { echo DRAIN_FLAG_NOT_OBSERVED >&2;exit 66; }
  baseline=$2
  if [ "$1" -eq 0 ];then stable=$((stable+1));else stable=0;fi
 else stable=0;fi
 attempt=$((attempt+1))
 [ "$attempt" -le 120 ] || { echo IDLE_DRAIN_TIMEOUT >&2;exit 75; }
 sleep 1
done
(cd "$BASE" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) ||
 { echo LIVE_SOURCE_CHANGED >&2;exit 76; }
for f in dexa_mission_control_contract_v1.mjs dexa_mission_control_future_v1.mjs dexa_provider_cancel_v1.mjs;do
 [ ! -e "$BASE/$f" ] || { echo "NEW_FILE_EXISTS $f" >&2;exit 77; }
done
mkdir -m 700 "$BACKUP"
for f in server.mjs rana.mjs dexa_tool_plan_executor_v3.mjs dexa_workflow_kernel.mjs index.html;do
 cp -p "$BASE/$f" "$BACKUP/$f"
done
(cd "$BACKUP" && sha256sum -c "$ROOT/baseline.sha256" >/dev/null) || exit 78
modified=1
for f in server.mjs rana.mjs dexa_tool_plan_executor_v3.mjs dexa_workflow_kernel.mjs index.html dexa_mission_control_contract_v1.mjs dexa_mission_control_future_v1.mjs dexa_provider_cancel_v1.mjs;do
 cp -p "$SRC/$f" "$BASE/$f"
done
(cd "$BASE" && sha256sum -c "$ROOT/proposed.sha256" >/dev/null) ||
 { echo COPIED_SOURCE_HASH_MISMATCH >&2;exit 79; }
systemctl --user restart dexa-main.service
attempt=0
while [ "$attempt" -lt 90 ];do
 if row="$(health)";then
  set -- $row
  if [ "$1" -eq 0 ] && [ "$2" -ge "$baseline" ] && [ "$3" = draining ] &&
   [ "$4" = dexa.mission-control.v1 ] && [ "$5" = ready ];then
   all=1
   for u in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
    [ "$(systemctl --user is-active "$u")" = active ] || all=0
   done
   if [ "$all" = 1 ];then
    committed=1; rm -f "$FLAG"
    echo "STAGE4_DEPLOY_SUCCESS release=$RID missions=$2"
    exit 0
   fi
  fi
 fi
 attempt=$((attempt+1));sleep 1
done
echo HEALTH_AFTER_DEPLOY_NOT_VERIFIED >&2;exit 80
