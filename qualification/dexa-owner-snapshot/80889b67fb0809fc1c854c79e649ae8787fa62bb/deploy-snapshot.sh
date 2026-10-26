#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")" && pwd)"
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
HEALTH=http://127.0.0.1:9471/healthz
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
BACKUP="$HOME/.local/share/dexa/owner-snapshot-rollback/dexa-kata-owner-snapshot-20261026-v1"
[[ "$(id -un)" == cfserver ]] || { echo DEXA_DEPLOY_USER_INVALID >&2; exit 60; }
mkdir -p "$HOME/.local/share/dexa"
exec 9>"$HOME/.local/share/dexa/owner-snapshot-deploy.lock"
flock -n 9 || { echo DEPLOY_LOCK_BUSY >&2; exit 61; }
[[ ! -e "$BACKUP" ]] || { echo BACKUP_ALREADY_EXISTS >&2; exit 62; }
for service in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
 [[ "$(systemctl --user is-active "$service")" == active ]] || { echo "SERVICE_INACTIVE $service" >&2; exit 63; }
done
verify_sha(){
 python3 - "$ROOT/manifest.json" "$2" "$1" <<'PY'
import json,hashlib,pathlib,sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text())
base=pathlib.Path(sys.argv[2]);mode=sys.argv[3]
assert m["schema"]=="dexa.owner-snapshot-fix.secret-free.v1"
assert m["release_id"]=="dexa-kata-owner-snapshot-20261026-v1"
assert (m["expected_kata"],m["expected_cf"])==(291,187)
for n,h in m["payload_sha"].items():
 assert hashlib.sha256((pathlib.Path(sys.argv[1]).parent/n).read_bytes()).hexdigest()==h,n
files=m["old_sha"] if mode=="old" else m["new_sha"]
for n,h in files.items():
 assert (base/n).is_file()
 assert hashlib.sha256((base/n).read_bytes()).hexdigest()==h,("SOURCE_CHANGED",n)
print("OWNER_SNAPSHOT_HASH_PASS",mode,len(files))
PY
}
verify_sha old "$BASE"
WORK="$(mktemp -d "$HOME/dexa-snapshot-stage.XXXXXXXX")"
cp -a "$BASE" "$WORK/candidate"
patch --batch --fuzz=0 -p1 -d "$WORK/candidate" < "$ROOT/snapshot.patch"
cp -p "$ROOT/test_dexa_catalog_snapshot_refresh_20261026.mjs" "$WORK/candidate/"
verify_sha new "$WORK/candidate"
node --check "$WORK/candidate/dexa_general_catalog_planner_v1.mjs"
(
 cd "$WORK/candidate"
 node --test test_dexa_catalog_snapshot_refresh_20261026.mjs \
  test_dexa_owner_root_reliability_v1.mjs test_dexa_global_entity_resolver_v1.mjs \
  test_dexa_catalog_broker_admission.mjs test_dexa_kata_asr_refresh_20261026.mjs \
  test_dexa_stage2_owner_effects_v1.mjs test_dexa_tool_plan_v3_systemic.mjs \
  > "$WORK/test-results.log" 2>&1
)
echo "OWNER_SNAPSHOT_59_OFFLINE_TESTS_PASS"
if [[ "${DEXA_QUALIFY_ONLY:-0}" == 1 ]];then rm -rf "$WORK"; echo OWNER_SNAPSHOT_QUALIFY_ONLY_OK;exit 0;fi

mkdir -p "$(dirname "$FLAG")" "$(dirname "$BACKUP")"
if ! (set -C; printf 'Dexa owner snapshot %s\n' "$(date -u +%FT%TZ)" > "$FLAG") 2>/dev/null;then
 echo DEPLOYMENT_ALREADY_DRAINING >&2; exit 65
fi
modified=0; complete=0; preserved=0
cleanup(){
 rc=$?
 trap - EXIT
 if (( modified == 1 && complete == 0 ));then
  echo OWNER_SNAPSHOT_ROLLBACK_START >&2
  for f in dexa_general_catalog_planner_v1.mjs test_dexa_stage2_owner_effects_v1.mjs test_dexa_tool_plan_v3_systemic.mjs;do
   cp -p "$BACKUP/$f" "$BASE/$f" || true
  done
  rm -f "$BASE/test_dexa_catalog_snapshot_refresh_20261026.mjs"
  systemctl --user restart dexa-main.service || true
  echo OWNER_SNAPSHOT_ROLLBACK_ATTEMPTED >&2
 fi
 if (( modified == 0 )) && [[ -d "$BACKUP" ]];then rmdir "$BACKUP" 2>/dev/null || true;fi
 rm -f "$FLAG"
 rm -rf "$WORK"
 exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
read_health(){
 curl -fsS --max-time 5 "$HEALTH" |
 python3 -c 'import json,sys;x=json.load(sys.stdin);assert x.get("ok") is True and type(x.get("activeMissions")) is int and type(x.get("storedMissions")) is int;print(x["activeMissions"],x["storedMissions"],"draining" if x.get("deploymentDrain",{}).get("active") else "unguarded","ready" if x.get("plannerHotSlot",{}).get("ready") else "notready")'
}
stable=0
for i in $(seq 1 120);do
 if row="$(read_health)";then
  read -r active stored draining planner <<< "$row"
  [[ "$draining" == draining ]] || { echo DRAIN_NOT_EFFECTIVE >&2; exit 66; }
  preserved="$stored"
  if [[ "$active" == 0 ]];then stable=$((stable+1));else stable=0;fi
  if (( stable >= 3 ));then break;fi
 else stable=0
 fi
 sleep 1
done
(( stable >= 3 )) || { echo DRAIN_TIMEOUT >&2; exit 75; }
verify_sha old "$BASE"
[[ ! -e "$BASE/test_dexa_catalog_snapshot_refresh_20261026.mjs" ]] || { echo NEW_TEST_FILE_COLLISION >&2; exit 76; }
mkdir -m 0700 "$BACKUP"
for f in dexa_general_catalog_planner_v1.mjs test_dexa_stage2_owner_effects_v1.mjs test_dexa_tool_plan_v3_systemic.mjs;do
 cp -p "$BASE/$f" "$BACKUP/$f"
done
modified=1
for f in dexa_general_catalog_planner_v1.mjs test_dexa_stage2_owner_effects_v1.mjs test_dexa_tool_plan_v3_systemic.mjs test_dexa_catalog_snapshot_refresh_20261026.mjs;do
 cp -p "$WORK/candidate/$f" "$BASE/$f.next-snapshot-$$"
 mv -f "$BASE/$f.next-snapshot-$$" "$BASE/$f"
done
verify_sha new "$BASE"
systemctl --user restart dexa-main.service
verified=0
for i in $(seq 1 90);do
 if row="$(read_health)";then
  read -r active stored draining planner <<< "$row"
  if [[ "$active" == 0 && "$stored" -ge "$preserved" &&
        "$draining" == draining && "$planner" == ready ]] &&
        [[ "$(systemctl --user is-active dexa-main.service)" == active ]] &&
        [[ "$(systemctl --user is-active dexa-catalog-gateway.service)" == active ]] &&
        [[ "$(systemctl --user is-active dexa-mobile-gateway.service)" == active ]];then
   if (cd "$BASE" && node --input-type=module -e 'import("./dexa_general_catalog_planner_v1.mjs").then(x=>{if(x.ownerCatalogSnapshot().length!==292)process.exit(7);const a=x.buildGeneralCapabilitySelectionPrompt({goal:"رونویسی پیام صوتی تلگرام"});if(!a.allowed.includes("tool.cf.audio_transcribe"))process.exit(8);console.log("DEXA_OWNER_SNAPSHOT_LIVE_OK")})');then verified=1;break;fi
  fi
 fi
 sleep 1
done
(( verified == 1 )) || { echo DEPLOYED_SNAPSHOT_HEALTH_NOT_VERIFIED >&2; exit 80; }
complete=1
rm -f "$FLAG"
echo "DEXA_OWNER_SNAPSHOT_FIX_LIVE_OK release=dexa-kata-owner-snapshot-20261026-v1 preserved_missions=$preserved"
