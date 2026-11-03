#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BASE=/home/cfserver/dexa-adaptive-observation-20261103
BACKUP="$BASE/original-deploy-snapshot"
mkdir -p "$BASE"
exec 9>"$BASE/release.lock"
flock -n 9 || { echo RELEASE_ALREADY_RUNNING; exit 20; }
test "$(id -un)" = cfserver
export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
test "$(git hash-object "$DIR/change.patch")" = de069396dde8bedfce3372f3ab8600abb09c3c35
test "$(git hash-object "$DIR/test_dexa_adaptive_observation_workflow_v1.mjs")" = c2bd73bc92017f25ba1cd2514492a0d87eda4e8a
test ! -e "$BACKUP"
test ! -e "$LIVE/dexa_verified_observed_navigation_v1.mjs"
test ! -e "$LIVE/dexa_bounded_observation_resume_v1.mjs"
test "$(sha256sum "$LIVE/server.mjs" | cut -d ' ' -f1)" = ba0d8220029e5c134824ddc5114148c1c0a348351b3036f2ab4b9e1be2e27998
test "$(sha256sum "$LIVE/dexa_general_plan_contract_v1.mjs" | cut -d ' ' -f1)" = fee6db91d33236914d831497c91bce358e391db2f1c97467c08cf40baafdea14
test "$(sha256sum "$LIVE/dexa_general_plan_cycle_v2.mjs" | cut -d ' ' -f1)" = c4e7eed6baf06dabbd028eec83a6c97890a2c873a096fc1b19febaafa38ed318
test "$(sha256sum "$LIVE/dexa_tool_plan_executor_v3.mjs" | cut -d ' ' -f1)" = ae8a4644c5b06b2f831cf7f564b018278d85eb3164d7c0d56fb552d811ad20b0
test "$(sha256sum "$LIVE/dexa_universal_mission_context_v1.mjs" | cut -d ' ' -f1)" = 9880c615a7ba597a889545f204f6c3df720e3f6e1a04319a028c79c424a339c7
curl -fsS --max-time 5 http://127.0.0.1:9471/healthz >"$BASE/pre-health.json"
node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(9)' "$BASE/pre-health.json"
STAGE="$(mktemp -d "$BASE/stage-XXXXXXXX")"
chmod 700 "$STAGE"
for file in "$LIVE"/*.mjs "$LIVE"/*.json; do cp -p "$file" "$STAGE/"; done
cp -p "$DIR/test_dexa_adaptive_observation_workflow_v1.mjs" "$STAGE/"
(cd "$STAGE" && git apply --check "$DIR/change.patch" && git apply "$DIR/change.patch")
for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs dexa_verified_observed_navigation_v1.mjs dexa_bounded_observation_resume_v1.mjs; do node --check "$STAGE/$f"; done
(cd "$STAGE" && node --test test_dexa_adaptive_observation_workflow_v1.mjs test_dexa_general_plan_cycle_20261025.mjs test_dexa_wechat_navigation_identity_v1.mjs test_dexa_read_identity_dependency_closure_v1.mjs test_dexa_identity_closure_v1.mjs test_dexa_universal_unread_contract_v1.mjs test_dexa_verified_typed_paths_v1.mjs test_dexa_durable_rana_runtime.mjs > "$STAGE/tests.log" 2>&1)
tail -n 8 "$STAGE/tests.log"
test "$(sha256sum "$STAGE/server.mjs" | cut -d ' ' -f1)" = d1a76fe7ddcbd41e3baf75de74c21b0fb9f35912b1985aa0b2e22e20d4a3cc76
test "$(sha256sum "$STAGE/dexa_general_plan_contract_v1.mjs" | cut -d ' ' -f1)" = 1bb1677594ddf148f6383a15cc34f8c1ad556e59e73bbcc6e4236ead9a9ba487
test "$(sha256sum "$STAGE/dexa_general_plan_cycle_v2.mjs" | cut -d ' ' -f1)" = d2d6a716725cab7aa945e66b2f681a3b0f1b31275d8dd1c4d34bd92944092081
test "$(sha256sum "$STAGE/dexa_tool_plan_executor_v3.mjs" | cut -d ' ' -f1)" = 3ad700942e5df74c77df701d9e2c4670c5c4827285112e83f6982a191e3afc30
test "$(sha256sum "$STAGE/dexa_universal_mission_context_v1.mjs" | cut -d ' ' -f1)" = f986d9181221a835e35fb9a8e60c25ee6511f99d30cb52110752336c6b565ea0
test "$(sha256sum "$STAGE/dexa_verified_observed_navigation_v1.mjs" | cut -d ' ' -f1)" = e2f14f13a3fcc6e725fe73de2d6cc8cca6f347458de17f7270bdb0cb6341d41b
test "$(sha256sum "$STAGE/dexa_bounded_observation_resume_v1.mjs" | cut -d ' ' -f1)" = d34301a201a0355d3ce7b6debe321b095f72a953d396c9b339cad35d9c12529d
curl -fsS --max-time 5 http://127.0.0.1:9471/healthz >"$STAGE/health-current.json"
node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(9)' "$STAGE/health-current.json"
(cd "$LIVE" && git apply --check "$DIR/change.patch")
mkdir -m 700 "$BACKUP"
for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs; do cp -p "$LIVE/$f" "$BACKUP/$f"; done
printf '%s\n' de069396dde8bedfce3372f3ab8600abb09c3c35 > "$BACKUP/patch-git-blob"
RESTORE=1
restore(){
 if [ "$RESTORE" = 1 ]; then
  for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs; do cp -p "$BACKUP/$f" "$LIVE/$f"; done
  rm -f "$LIVE/dexa_verified_observed_navigation_v1.mjs" "$LIVE/dexa_bounded_observation_resume_v1.mjs"
  systemctl --user restart dexa-main.service || true
  echo DEXA_ADAPTIVE_INSTALL_ROLLED_BACK
 fi
}
trap restore EXIT
(cd "$LIVE" && git apply "$DIR/change.patch")
systemctl --user restart dexa-main.service
HEALTH_OK=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
 if curl -fsS --max-time 5 http://127.0.0.1:9471/healthz > "$BASE/post-health.json" 2>/dev/null &&
 node -e 'const a=require(process.argv[1]),b=require(process.argv[2]);if(a.ok!==true||a.activeMissions!==0||a.deploymentDrain?.active===true||a.storedMissions<b.storedMissions)process.exit(8)' "$BASE/post-health.json" "$BASE/pre-health.json"; then HEALTH_OK=1;break; fi
 sleep 2
done
test "$HEALTH_OK" = 1
for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs dexa_verified_observed_navigation_v1.mjs dexa_bounded_observation_resume_v1.mjs; do cmp -s "$STAGE/$f" "$LIVE/$f"; done
RESTORE=0
trap - EXIT
echo ADAPTIVE_OBSERVATION_LIVE_HEALTH_OK
