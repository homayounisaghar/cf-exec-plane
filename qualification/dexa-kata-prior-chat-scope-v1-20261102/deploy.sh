#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BASE=/home/cfserver/dexa-kata-prior-chat-scope-20261102
mkdir -p "$BASE"
exec 9>"$BASE/release.lock"
flock -n 9 || { echo RELEASE_LOCKED; exit 20; }
test "$(id -un)" = cfserver
test "$(sha256sum "$LIVE/kata_rank.py" | cut -d ' ' -f1)" = 7c5d31f33f15db519b0968c4c4659b0b6b91082e3c2b4960569819598a1821d4
curl -fsS --max-time 6 http://127.0.0.1:9471/healthz > "$BASE/health-before.json"
node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(6)' "$BASE/health-before.json"
STAGE="$(mktemp -d "$BASE/stage-XXXXXXXX")"
chmod 700 "$STAGE"
for f in kata_rank.py typed_tool_wrapper_v3.txt frozen_instant_wrapper_v2.txt rana_cf_tool_schemas.json rana_capability_catalog.json test_dexa_kata_previous_context.py; do
 cp -p "$LIVE/$f" "$STAGE/$f"
done
cp -p "$DIR/test_dexa_kata_verified_list_scope_v1.py" "$STAGE/"
(cd "$STAGE" && git apply --check "$DIR/kata_scope.patch" && git apply "$DIR/kata_scope.patch")
test "$(sha256sum "$STAGE/kata_rank.py" | cut -d ' ' -f1)" = 7527d9a8437341d06d39530bf4c7883de6e595c86f0576fa237b32e7217ebdcc
python3 -m py_compile "$STAGE/kata_rank.py"
(cd "$STAGE" && DEXA_TOOL_PLAN_V3=1 python3 -m unittest -v test_dexa_kata_verified_list_scope_v1.py test_dexa_kata_previous_context.py > "$STAGE/tests.log" 2>&1)
tail -n 8 "$STAGE/tests.log"
BACKUP="$(mktemp "$BASE/kata_rank_original-XXXXXXXX.py")"
cp -p "$LIVE/kata_rank.py" "$BACKUP"
RESTORE=1
restore(){
 if [ "$RESTORE" = 1 ]; then
  cp -p "$BACKUP" "$LIVE/kata_rank.py.rollbacktmp"
  mv -f "$LIVE/kata_rank.py.rollbacktmp" "$LIVE/kata_rank.py"
  echo KATA_SCOPE_ROLLBACK
 fi
}
trap restore EXIT
cp -p "$STAGE/kata_rank.py" "$LIVE/kata_rank.py.newtmp"
mv -f "$LIVE/kata_rank.py.newtmp" "$LIVE/kata_rank.py"
test "$(sha256sum "$LIVE/kata_rank.py" | cut -d ' ' -f1)" = 7527d9a8437341d06d39530bf4c7883de6e595c86f0576fa237b32e7217ebdcc
(cd "$LIVE" && DEXA_TOOL_PLAN_V3=1 python3 -m unittest -v test_dexa_kata_previous_context.py > "$STAGE/live-tests.log" 2>&1)
tail -n 6 "$STAGE/live-tests.log"
curl -fsS --max-time 6 http://127.0.0.1:9471/healthz > "$STAGE/health-after.json"
node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(6);console.log("DEXA_LIVE_HEALTH_OK",h.storedMissions)' "$STAGE/health-after.json"
RESTORE=0
trap - EXIT
echo KATA_NAMED_CHAT_SCOPE_INSTALLED_NO_RESTART
