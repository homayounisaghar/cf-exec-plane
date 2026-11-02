#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BASE=/home/cfserver/dexa-list-title-memory-20261102
mkdir -p "$BASE"
exec 9>"$BASE/release.lock"
flock -n 9 || { echo RELEASE_LOCKED; exit 20; }
test "$(id -un)" = cfserver
export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
test "$(sha256sum "$LIVE/dexa_dual_memory_v1.mjs" | cut -d ' ' -f1)" = b1994a211521072bdba1fefbe181f2298c6b40beddf24a56618c143d4547672b
curl -fsS --max-time 5 http://127.0.0.1:9471/healthz > "$BASE/health-before.json"
node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(5)' "$BASE/health-before.json"
STAGE="$(mktemp -d "$BASE/stage-XXXXXXXX")"
chmod 700 "$STAGE"
for file in "$LIVE"/*.mjs "$LIVE"/*.json; do cp -p "$file" "$STAGE/"; done
cp "$DIR/test_dexa_dual_memory_visible_list_scope_v1.mjs" "$STAGE/"
(cd "$STAGE" && git apply --check "$DIR/change.patch" && git apply "$DIR/change.patch")
test "$(sha256sum "$STAGE/dexa_dual_memory_v1.mjs" | cut -d ' ' -f1)" = 386cd971c2b31f20d20e5a58c10fef51b107f60c623519ad45d1e4b70caaca23
node --check "$STAGE/dexa_dual_memory_v1.mjs"
(cd "$STAGE" && node --test test_dexa_dual_memory_visible_list_scope_v1.mjs test_dexa_dual_memory_v1.mjs test_dexa_memory_to_writer_translation_v1.mjs test_dexa_wechat_navigation_identity_v1.mjs test_dexa_wechat_message_list_v1.mjs test_dexa_general_plan_cycle_20261025.mjs >"$STAGE/tests.log" 2>&1)
tail -n 8 "$STAGE/tests.log"
BACKUP="$BASE/dexa_dual_memory_v1.mjs.original"
cp -p "$LIVE/dexa_dual_memory_v1.mjs" "$BACKUP"
RESTORE=1
restore() {
 if [ "$RESTORE" = 1 ]; then
  cp -p "$BACKUP" "$LIVE/dexa_dual_memory_v1.mjs"
  systemctl --user restart dexa-main.service || true
  echo DEXA_LIST_TITLE_ROLLBACK
 fi
}
trap restore EXIT
cp -p "$STAGE/dexa_dual_memory_v1.mjs" "$LIVE/dexa_dual_memory_v1.mjs"
systemctl --user restart dexa-main.service
for i in 1 2 3 4 5 6 7 8 9 10; do
 if curl -fsS --max-time 5 http://127.0.0.1:9471/healthz >"$STAGE/health-after.json" 2>/dev/null &&
 node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(5)' "$STAGE/health-after.json"; then break; fi
 sleep 2
done
node -e 'const a=require(process.argv[1]),b=require(process.argv[2]);if(a.ok!==true||a.activeMissions!==0||a.deploymentDrain?.active===true||a.storedMissions<b.storedMissions)process.exit(5);console.log("LIST_MEMORY_LIVE_HEALTH_OK",a.storedMissions)' "$STAGE/health-after.json" "$BASE/health-before.json"
cmp -s "$STAGE/dexa_dual_memory_v1.mjs" "$LIVE/dexa_dual_memory_v1.mjs"
RESTORE=0
trap - EXIT
echo DEXA_VERIFIED_LIST_TITLES_INSTALLED
