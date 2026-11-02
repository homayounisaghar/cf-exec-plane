#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BASE=/home/cfserver/dexa-multilingual-release-20261102
FILES="dexa_messaging_record_contract_v1.mjs dexa_catalog_registry.mjs dexa_catalog_output_shapes_v1.json dexa_text_writer_v1.mjs dexa_writer_source_provenance_v1.mjs dexa_tool_plan_executor_v3.mjs rana.mjs server.mjs dexa_general_plan_cycle_v2.mjs"
NEW="dexa_memory_read_v1.mjs dexa_outgoing_language_policy_v1.mjs"
mkdir -p "$BASE"
exec 9>"$BASE/release.lock"
flock -n 9 || { echo RELEASE_LOCKED; exit 20; }
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
(cd "$LIVE" && sha256sum -c "$DIR/baseline.sha256")
for f in $NEW; do test ! -e "$LIVE/$f" || { echo NEW_FILE_ALREADY_EXISTS; exit 21; }; done
curl -fsS --max-time 5 http://127.0.0.1:9471/healthz >"$BASE/health-before.json"
node -e 'let x=require(process.argv[1]);if(x.ok!==true||x.activeMissions!==0||x.deploymentDrain?.active===true)process.exit(5);console.log("PRE_HEALTH_OK",x.storedMissions)' "$BASE/health-before.json"
STAGE="$(mktemp -d "$BASE/stage-XXXXXXXX")"
chmod 700 "$STAGE"
for f in "$LIVE"/*.mjs "$LIVE"/*.json; do cp -p "$f" "$STAGE/"; done
(cd "$STAGE" && git apply --check "$DIR/changes.patch" && git apply "$DIR/changes.patch")
for f in $NEW test_dexa_memory_to_writer_translation_v1.mjs test_dexa_outgoing_language_policy_v1.mjs; do cp "$DIR/$f" "$STAGE/$f"; done
for f in $FILES $NEW; do
 case "$f" in
  *.mjs) node --check "$STAGE/$f" >/dev/null ;;
  *.json) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$STAGE/$f" ;;
 esac
done
(
 cd "$STAGE"
 node --test test_dexa_memory_to_writer_translation_v1.mjs test_dexa_outgoing_language_policy_v1.mjs test_dexa_wechat_ignored_chat_v1.mjs test_dexa_wechat_message_list_v1.mjs test_dexa_wechat_navigation_identity_v1.mjs test_dexa_wechat_newest_chronology_v1.mjs test_dexa_wechat_previous_first_navigation_v1.mjs test_dexa_native_visible_body_answer_v1.mjs test_dexa_general_plan_cycle_20261025.mjs test_dexa_verified_typed_paths_v1.mjs test_dexa_rolling_memory_v1.mjs test_dexa_dual_memory_v1.mjs test_dexa_exact_prior_answer_passthrough_v1.mjs test_dexa_root_plan_answer_contract_v1.mjs >"$STAGE/tests.log" 2>&1
)
tail -n 8 "$STAGE/tests.log"
BACKUP="$(mktemp -d "$BASE/backup-XXXXXXXX")"
chmod 700 "$BACKUP"
for f in $FILES; do cp -p "$LIVE/$f" "$BACKUP/$f"; done
RESTORE=1
restore(){
 if test "$RESTORE" = 1; then
  echo RELEASE_FAILED_ROLLBACK
  for f in $FILES; do cp -p "$BACKUP/$f" "$LIVE/$f"; done
  for f in $NEW; do rm -f "$LIVE/$f"; done
  systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
 fi
}
trap restore EXIT
for f in $FILES $NEW; do cp -p "$STAGE/$f" "$LIVE/$f"; done
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service
for i in 1 2 3 4 5 6 7 8 9 10; do
 if curl -fsS --max-time 4 http://127.0.0.1:9471/healthz >"$STAGE/health.json" 2>/dev/null &&
 node -e 'let x=require(process.argv[1]);if(x.ok!==true||x.activeMissions!==0||x.deploymentDrain?.active===true)process.exit(2)' "$STAGE/health.json"; then break; fi
 sleep 2
done
node -e 'let x=require(process.argv[1]);if(x.ok!==true||x.activeMissions!==0||x.deploymentDrain?.active===true)process.exit(2);console.log("DEXA_MULTILINGUAL_LIVE_OK",x.storedMissions)' "$STAGE/health.json"
for f in $FILES $NEW; do cmp -s "$STAGE/$f" "$LIVE/$f" || exit 33; done
RESTORE=0
trap - EXIT
echo MULTILINGUAL_RELEASE_INSTALLED
