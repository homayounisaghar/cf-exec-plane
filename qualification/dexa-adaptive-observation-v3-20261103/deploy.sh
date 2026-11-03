#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BASE=/home/cfserver/dexa-adaptive-observation-20261103
SNAP="$BASE/original-deploy-snapshot"
PREVIOUS="$BASE/v3-previous-two-modules"
mkdir -p "$BASE"
exec 9>"$BASE/release.lock"
flock -n 9 || { echo RELEASE_LOCKED; exit 20; }
test "$(id -un)" = cfserver
export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
test -f "$SNAP/patch-git-blob"
test "$(cat "$SNAP/patch-git-blob")" = de069396dde8bedfce3372f3ab8600abb09c3c35
test ! -e "$PREVIOUS"
test "$(git hash-object "$DIR/followup.patch")" = 40bfe79b13ecdd6440217767c5f36c660e611178
test "$(sha256sum "$LIVE/dexa_verified_observed_navigation_v1.mjs" | cut -d ' ' -f1)" = e2f14f13a3fcc6e725fe73de2d6cc8cca6f347458de17f7270bdb0cb6341d41b
test "$(sha256sum "$LIVE/dexa_bounded_observation_resume_v1.mjs" | cut -d ' ' -f1)" = d34301a201a0355d3ce7b6debe321b095f72a953d396c9b339cad35d9c12529d
test "$(sha256sum "$LIVE/dexa_general_plan_contract_v1.mjs" | cut -d ' ' -f1)" = 1bb1677594ddf148f6383a15cc34f8c1ad556e59e73bbcc6e4236ead9a9ba487
test "$(sha256sum "$LIVE/server.mjs" | cut -d ' ' -f1)" = d1a76fe7ddcbd41e3baf75de74c21b0fb9f35912b1985aa0b2e22e20d4a3cc76
test "$(git hash-object "$BASE/test_dexa_adaptive_canonical_followup_hotfix_v1.mjs")" = 38fbae2ab93fc8be30016e9aef2e7dd0b61f1278
curl -fsS --max-time 5 http://127.0.0.1:9471/healthz > "$BASE/v3-health-before.json"
node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(6)' "$BASE/v3-health-before.json"
TESTDIR="$(mktemp -d "$BASE/stage-v3-XXXXXXXX")"
for f in "$LIVE"/*.mjs "$LIVE"/*.json; do cp -p "$f" "$TESTDIR/"; done
cp -p "$BASE/test_dexa_adaptive_canonical_followup_hotfix_v1.mjs" "$TESTDIR/"
cp -p "$BASE/test_dexa_adaptive_observation_workflow_v1.mjs" "$TESTDIR/"
(cd "$TESTDIR" && git apply --check "$DIR/followup.patch" && git apply "$DIR/followup.patch")
test "$(sha256sum "$TESTDIR/dexa_verified_observed_navigation_v1.mjs" | cut -d ' ' -f1)" = 0582081d217a3bbc468d12b1d91b3d2661fdaf18531c3ac7ef9f40b355537a20
test "$(sha256sum "$TESTDIR/dexa_bounded_observation_resume_v1.mjs" | cut -d ' ' -f1)" = d47550a8ca4559a8a0301d9f1e3e64e2c7e0c0bea637dbcee607680ba82ad77b
node --check "$TESTDIR/dexa_verified_observed_navigation_v1.mjs"
node --check "$TESTDIR/dexa_bounded_observation_resume_v1.mjs"
(cd "$TESTDIR" && node --test test_dexa_adaptive_canonical_followup_hotfix_v1.mjs test_dexa_adaptive_observation_workflow_v1.mjs test_dexa_general_plan_cycle_20261025.mjs test_dexa_wechat_navigation_identity_v1.mjs test_dexa_read_identity_dependency_closure_v1.mjs test_dexa_identity_closure_v1.mjs test_dexa_universal_unread_contract_v1.mjs test_dexa_verified_typed_paths_v1.mjs test_dexa_durable_rana_runtime.mjs > "$TESTDIR/tests.log" 2>&1)
tail -n 8 "$TESTDIR/tests.log"
(cd "$LIVE" && git apply --check "$DIR/followup.patch")
mkdir -m 700 "$PREVIOUS"
cp -p "$LIVE/dexa_verified_observed_navigation_v1.mjs" "$LIVE/dexa_bounded_observation_resume_v1.mjs" "$PREVIOUS/"
RECOVER=1
recover(){
 if test "$RECOVER" = 1; then
  cp -p "$PREVIOUS/dexa_verified_observed_navigation_v1.mjs" "$PREVIOUS/dexa_bounded_observation_resume_v1.mjs" "$LIVE/"
  systemctl --user restart dexa-main.service || true
  echo V3_UPDATE_ROLLED_BACK_TO_V2
 fi
}
trap recover EXIT
(cd "$LIVE" && git apply "$DIR/followup.patch")
systemctl --user restart dexa-main.service
GOOD=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
 if curl -fsS --max-time 5 http://127.0.0.1:9471/healthz > "$BASE/v3-health-after.json" 2>/dev/null &&
 node -e 'const a=require(process.argv[1]),b=require(process.argv[2]);if(a.ok!==true||a.activeMissions!==0||a.deploymentDrain?.active===true||a.storedMissions<b.storedMissions)process.exit(7)' "$BASE/v3-health-after.json" "$BASE/v3-health-before.json"; then GOOD=1; break; fi
 sleep 2
done
test "$GOOD" = 1
cmp -s "$TESTDIR/dexa_verified_observed_navigation_v1.mjs" "$LIVE/dexa_verified_observed_navigation_v1.mjs"
cmp -s "$TESTDIR/dexa_bounded_observation_resume_v1.mjs" "$LIVE/dexa_bounded_observation_resume_v1.mjs"
RECOVER=0
trap - EXIT
echo DEXA_ADAPTIVE_V3_LIVE_HEALTH_OK
