#!/usr/bin/env bash
set -euo pipefail
LIVE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BASE=/home/cfserver/dexa-adaptive-observation-20261103
BACKUP="$BASE/original-deploy-snapshot"
exec 9>"$BASE/release.lock"
flock -n 9 || { echo RELEASE_ALREADY_RUNNING; exit 20; }
test "$(id -un)" = cfserver
export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
test -f "$BACKUP/patch-git-blob"
test "$(cat "$BACKUP/patch-git-blob")" = de069396dde8bedfce3372f3ab8600abb09c3c35
test "$(sha256sum "$LIVE/server.mjs" | cut -d ' ' -f1)" = d1a76fe7ddcbd41e3baf75de74c21b0fb9f35912b1985aa0b2e22e20d4a3cc76
test "$(sha256sum "$LIVE/dexa_general_plan_contract_v1.mjs" | cut -d ' ' -f1)" = 1bb1677594ddf148f6383a15cc34f8c1ad556e59e73bbcc6e4236ead9a9ba487
test "$(sha256sum "$LIVE/dexa_general_plan_cycle_v2.mjs" | cut -d ' ' -f1)" = d2d6a716725cab7aa945e66b2f681a3b0f1b31275d8dd1c4d34bd92944092081
test "$(sha256sum "$LIVE/dexa_tool_plan_executor_v3.mjs" | cut -d ' ' -f1)" = 3ad700942e5df74c77df701d9e2c4670c5c4827285112e83f6982a191e3afc30
test "$(sha256sum "$LIVE/dexa_universal_mission_context_v1.mjs" | cut -d ' ' -f1)" = f986d9181221a835e35fb9a8e60c25ee6511f99d30cb52110752336c6b565ea0
test "$(sha256sum "$LIVE/dexa_verified_observed_navigation_v1.mjs" | cut -d ' ' -f1)" = e2f14f13a3fcc6e725fe73de2d6cc8cca6f347458de17f7270bdb0cb6341d41b
test "$(sha256sum "$LIVE/dexa_bounded_observation_resume_v1.mjs" | cut -d ' ' -f1)" = d34301a201a0355d3ce7b6debe321b095f72a953d396c9b339cad35d9c12529d
test "$(sha256sum "$BACKUP/server.mjs" | cut -d ' ' -f1)" = ba0d8220029e5c134824ddc5114148c1c0a348351b3036f2ab4b9e1be2e27998
test "$(sha256sum "$BACKUP/dexa_general_plan_contract_v1.mjs" | cut -d ' ' -f1)" = fee6db91d33236914d831497c91bce358e391db2f1c97467c08cf40baafdea14
test "$(sha256sum "$BACKUP/dexa_general_plan_cycle_v2.mjs" | cut -d ' ' -f1)" = c4e7eed6baf06dabbd028eec83a6c97890a2c873a096fc1b19febaafa38ed318
test "$(sha256sum "$BACKUP/dexa_tool_plan_executor_v3.mjs" | cut -d ' ' -f1)" = ae8a4644c5b06b2f831cf7f564b018278d85eb3164d7c0d56fb552d811ad20b0
test "$(sha256sum "$BACKUP/dexa_universal_mission_context_v1.mjs" | cut -d ' ' -f1)" = 9880c615a7ba597a889545f204f6c3df720e3f6e1a04319a028c79c424a339c7
curl -fsS --max-time 5 http://127.0.0.1:9471/healthz > "$BASE/rollback-before.json"
node -e 'const h=require(process.argv[1]);if(h.ok!==true||h.activeMissions!==0||h.deploymentDrain?.active===true)process.exit(6)' "$BASE/rollback-before.json"
PATCHED="$(mktemp -d "$BASE/rollback-safety-XXXXXXXX")"
for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs dexa_verified_observed_navigation_v1.mjs dexa_bounded_observation_resume_v1.mjs; do cp -p "$LIVE/$f" "$PATCHED/$f"; done
RECOVER=1
recover(){
 if [ "$RECOVER" = 1 ]; then
  for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs dexa_verified_observed_navigation_v1.mjs dexa_bounded_observation_resume_v1.mjs; do cp -p "$PATCHED/$f" "$LIVE/$f"; done
  systemctl --user restart dexa-main.service || true
  echo ROLLBACK_INCOMPLETE_RESTORED_PATCHED_VERSION
 fi
}
trap recover EXIT
for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs; do cp -p "$BACKUP/$f" "$LIVE/$f"; done
rm -f "$LIVE/dexa_verified_observed_navigation_v1.mjs" "$LIVE/dexa_bounded_observation_resume_v1.mjs"
systemctl --user restart dexa-main.service
OK=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
 if curl -fsS --max-time 5 http://127.0.0.1:9471/healthz > "$BASE/rollback-after.json" 2>/dev/null &&
 node -e 'const a=require(process.argv[1]),b=require(process.argv[2]);if(a.ok!==true||a.activeMissions!==0||a.deploymentDrain?.active===true||a.storedMissions<b.storedMissions)process.exit(7)' "$BASE/rollback-after.json" "$BASE/rollback-before.json"; then OK=1; break; fi
 sleep 2
done
test "$OK" = 1
for f in server.mjs dexa_general_plan_contract_v1.mjs dexa_general_plan_cycle_v2.mjs dexa_tool_plan_executor_v3.mjs dexa_universal_mission_context_v1.mjs; do cmp -s "$BACKUP/$f" "$LIVE/$f"; done
test ! -e "$LIVE/dexa_verified_observed_navigation_v1.mjs"
test ! -e "$LIVE/dexa_bounded_observation_resume_v1.mjs"
RECOVER=0
trap - EXIT
echo DEXA_EXACT_PREVIOUS_VERSION_RESTORED
