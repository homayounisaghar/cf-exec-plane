#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")" && pwd)"
RELEASE="dexa-kata-cf187-20261026-v1"
CAP=/home/cfserver/connector-call-generator-prototype-v01/capability-router-v1
KATA=/home/cfserver/connector-call-generator-prototype-v01/persian-catalog-search-v1
DEXA=/var/lib/capability-fabric/paa-remote/dexa-mvp
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
BACKUP="$HOME/.local/share/dexa/kata-catalog-rollback/$RELEASE"
HEALTH=http://127.0.0.1:9471/healthz
[[ "$(id -un)" == cfserver ]] || { echo DEXA_KATA_OWNER_REQUIRED >&2;exit 60; }
exec 9>"$HOME/.local/share/dexa/kata-release.lock"
flock -n 9 || { echo DEXA_KATA_RELEASE_LOCK_BUSY >&2;exit 61; }
[[ ! -e "$BACKUP" ]] || { echo DEXA_KATA_RELEASE_ID_USED >&2;exit 62; }
for u in dexa-main.service dexa-catalog-gateway.service dexa-mobile-gateway.service;do
 [[ "$(systemctl --user is-active "$u")" == active ]] || { echo "SERVICE_INACTIVE $u" >&2;exit 63; }
done
prod_path(){
 case "$1" in
 capability-router-v1/*) echo "$CAP/${1#capability-router-v1/}" ;;
 persian-catalog-search-v1/*) echo "$KATA/${1#persian-catalog-search-v1/}" ;;
 dexa-mvp/*) echo "$DEXA/${1#dexa-mvp/}" ;;
 *) echo PATH_NOT_ADMITTED >&2;return 66 ;;
 esac
}
verify_integrity(){
 python3 - "$ROOT/manifest.json" "$ROOT" "$CAP" "$KATA" "$DEXA" "$1" <<'PY'
import json,hashlib,pathlib,sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text());r=pathlib.Path(sys.argv[2])
roots={"capability-router-v1":pathlib.Path(sys.argv[3]),
"persian-catalog-search-v1":pathlib.Path(sys.argv[4]),
"dexa-mvp":pathlib.Path(sys.argv[5])}
assert m["schema"]=="dexa.kata-refresh.secret-free.v1"
assert m["release_id"]=="dexa-kata-cf187-20261026-v1"
assert (m["current_cf_tools"],m["old_catalog"],m["new_catalog"],m["old_cf_schemas"],m["new_cf_schemas"])==(187,292,291,188,187)
for name,h in m["patch_sha"].items():
 assert "/" not in name and hashlib.sha256((r/name).read_bytes()).hexdigest()==h,name
which=m["old_sha"] if sys.argv[6]=="old" else m["new_sha"]
for rel,h in which.items():
 group,name=rel.split("/",1);p=roots[group]/name
 assert p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==h,("SOURCE_CHANGED",rel)
print("DEXA_KATA_INTEGRITY_OK",sys.argv[6],len(which))
PY
}
verify_integrity old
WORK="$(mktemp -d "$HOME/dexa-kata-refresh-stage.XXXXXXXX")"
STAGE="$WORK/candidate"
mkdir -p "$STAGE/capability-router-v1" "$STAGE/persian-catalog-search-v1"
cp -a "$DEXA" "$STAGE/dexa-mvp"
cp -p "$CAP/capabilities.json" "$STAGE/capability-router-v1/capabilities.json"
for f in build_catalog.py manual_fa_labels_by_id.tsv catalog_fa.json rank_hybrid.py rank_v2.py;do
 cp -p "$KATA/$f" "$STAGE/persian-catalog-search-v1/$f"
done
patch --batch --fuzz=0 -p1 -d "$STAGE/capability-router-v1" < "$ROOT/capabilities.patch"
patch --batch --fuzz=0 -p1 -d "$STAGE/persian-catalog-search-v1" < "$ROOT/translations.patch"
patch --batch --fuzz=0 -p1 -d "$STAGE/dexa-mvp" < "$ROOT/runtime.patch"
patch --batch --fuzz=0 -p1 -d "$STAGE/dexa-mvp" < "$ROOT/tests.patch"
python3 "$ROOT/apply_schema_delta.py" "$STAGE/dexa-mvp/rana_cf_tool_schemas.json" "$ROOT/schema_delta.json"
python3 "$STAGE/persian-catalog-search-v1/build_catalog.py" > "$WORK/build-result.json"
cp -p "$STAGE/persian-catalog-search-v1/catalog_fa.json" "$STAGE/dexa-mvp/rana_capability_catalog.json"
cp -p "$ROOT/test_dexa_kata_asr_refresh_20261026.mjs" "$STAGE/dexa-mvp/test_dexa_kata_asr_refresh_20261026.mjs"
python3 - "$ROOT/manifest.json" "$STAGE" <<'PY'
import json,pathlib,hashlib,sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text());r=pathlib.Path(sys.argv[2])
for rel,h in m["new_sha"].items():
 p=r/rel
 assert p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==h,rel
assert (r/"dexa-mvp/rana_capability_catalog.json").read_bytes()==(r/"persian-catalog-search-v1/catalog_fa.json").read_bytes()
print("DEXA_KATA_CANDIDATE_VERIFIED",len(m["new_sha"]))
PY
for f in rana_catalog.mjs dexa_catalog_registry.mjs server.mjs;do node --check "$STAGE/dexa-mvp/$f";done
python3 -m py_compile "$STAGE/dexa-mvp/kata_rank.py"
(
 cd "$STAGE/dexa-mvp"
 DEXA_KATA_CATALOG_ROOT="$STAGE/persian-catalog-search-v1" DEXA_TOOL_PLAN_V3=1 \
 python3 -m unittest -q test_dexa_kata_persian_three_fixes_20261024 test_dexa_kata_telegram_mvp test_dexa_kata_previous_context > "$WORK/python-tests.log" 2>&1
 node --test test_dexa_catalog_broker_admission.mjs test_dexa_rana_catalog_oauth_read.mjs test_dexa_kata_asr_refresh_20261026.mjs > "$WORK/node-tests.log" 2>&1
 DEXA_KATA_CATALOG_ROOT="$STAGE/persian-catalog-search-v1" DEXA_TOOL_PLAN_V3=1 \
 python3 -c 'import kata_rank; r=kata_rank.make("تبدیل همزمان ۱۱ ویس پیام صوتی تلگرام به متن");assert r["catalog_count"]==291 and "tool.cf.audio_transcribe" in r["capability_ids"] and "tool.cf.telegram_transcribe" not in r["capability_ids"]'
)
echo DEXA_KATA_OFFLINE_QUALIFICATION_OK
if [[ "$(printenv DEXA_KATA_QUALIFY_ONLY || true)" == 1 ]];then rm -rf "$WORK";exit 0;fi
mkdir -p "$(dirname "$FLAG")" "$(dirname "$BACKUP")"
if ! (set -C; printf 'Dexa Kata %s\n' "$(date -u +%FT%TZ)" > "$FLAG") 2>/dev/null;then
 echo ALREADY_DRAINING >&2;exit 65
fi
modified=0; complete=0; stored_before=0
cleanup(){
 rc=$?;trap - EXIT
 if (( modified == 0 )) && [[ -d "$BACKUP" ]];then rmdir "$BACKUP" 2>/dev/null || true;fi
 if (( modified == 1 && complete == 0 ));then
  echo DEXA_KATA_ROLLBACK_START >&2
  while IFS= read -r rel;do cp -p "$BACKUP/$rel" "$(prod_path "$rel")" || true;done < "$WORK/existing-files.list"
  rm -f "$DEXA/test_dexa_kata_asr_refresh_20261026.mjs"
  systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
  echo DEXA_KATA_ROLLBACK_ATTEMPTED >&2
 fi
 rm -f "$FLAG";rm -rf "$WORK";exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
read_health(){
 curl -fsS --max-time 5 "$HEALTH" |
 python3 -c 'import json,sys;d=json.load(sys.stdin);assert d.get("ok") is True and type(d.get("activeMissions")) is int and type(d.get("storedMissions")) is int;print(d["activeMissions"],d["storedMissions"],"draining" if d.get("deploymentDrain",{}).get("active") else "unguarded","ready" if d.get("plannerHotSlot",{}).get("ready") else "notready")'
}
stable=0
for attempt in $(seq 1 130);do
 if row="$(read_health)";then
  read -r active stored guard planner <<< "$row"
  [[ "$guard" == draining ]] || { echo DRAIN_NOT_EFFECTIVE >&2;exit 67; }
  stored_before="$stored"
  if [[ "$active" == 0 ]];then stable=$((stable+1));else stable=0;fi
  (( stable >= 3 )) && break
 else stable=0
 fi
 sleep 1
done
(( stable >= 3 )) || { echo DRAIN_TIMEOUT >&2;exit 75; }
verify_integrity old
python3 - "$ROOT/manifest.json" > "$WORK/existing-files.list" <<'PY'
import json,sys
print("\n".join(json.load(open(sys.argv[1]))["old_sha"]))
PY
[[ ! -e "$DEXA/test_dexa_kata_asr_refresh_20261026.mjs" ]] || { echo FILE_COLLISION >&2;exit 77; }
mkdir -m 0700 "$BACKUP"
while IFS= read -r rel;do
 dest="$BACKUP/$rel";mkdir -p "$(dirname "$dest")";cp -p "$(prod_path "$rel")" "$dest"
done < "$WORK/existing-files.list"
modified=1
python3 - "$ROOT/manifest.json" > "$WORK/target-files.list" <<'PY'
import json,sys
print("\n".join(json.load(open(sys.argv[1]))["new_sha"]))
PY
while IFS= read -r rel;do
 dst="$(prod_path "$rel")";tmp="$dst.next-kata-$$"
 cp -p "$STAGE/$rel" "$tmp";mv -f "$tmp" "$dst"
done < "$WORK/target-files.list"
verify_integrity new
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service
verified=0
for attempt in $(seq 1 100);do
 if row="$(read_health)";then
  read -r active stored guard planner <<< "$row"
  if [[ "$active" == 0 && "$stored" -ge "$stored_before" && "$guard" == draining && "$planner" == ready ]] &&
     [[ "$(systemctl --user is-active dexa-main.service)" == active ]] &&
     [[ "$(systemctl --user is-active dexa-catalog-gateway.service)" == active ]] &&
     [[ "$(systemctl --user is-active dexa-mobile-gateway.service)" == active ]];then
    if node --input-type=module -e "import('file://$DEXA/dexa_catalog_registry.mjs').then(x=>{const c=x.catalogCounts();if(c.catalog!==291||c.cfMapped!==187)process.exit(7);console.log('DEXA_KATA_LIVE_COUNTS',c.catalog,c.cfMapped)})";then verified=1;break;fi
  fi
 fi
 sleep 1
done
(( verified == 1 )) || { echo POST_RESTART_NOT_VERIFIED >&2;exit 80; }
complete=1
rm -f "$FLAG"
echo "DEXA_KATA_RELEASE_SUCCESS release=$RELEASE preserved_missions=$stored_before"
