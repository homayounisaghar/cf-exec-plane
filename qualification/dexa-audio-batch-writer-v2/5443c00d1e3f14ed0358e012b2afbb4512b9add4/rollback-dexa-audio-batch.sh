#!/bin/sh
set -eu
umask 077
ID=dexa-audio-batch-writer-20261028-v2
[ "$(id -un)" = cfserver ] || { echo OWNER_USER_REQUIRED;exit 61; }
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
BACKUP="$HOME/.local/share/dexa/audio-batch-plan-rollback/$ID"
FLAG="$HOME/.local/share/dexa/deployment-drain.flag"
FILES="dexa_text_writer_v1.mjs"
[ -d "$BACKUP" ] && [ ! -L "$BACKUP" ] && [ ! -e "$FLAG" ] || { echo ROLLBACK_UNAVAILABLE;exit 62; }
for f in $FILES;do [ -f "$BASE/$f" ] && [ -f "$BACKUP/$f" ] && [ ! -L "$BASE/$f" ] || exit 63;done
[ "$(sha256sum "$BASE/dexa_typed_planner_prompt_v3.mjs" | cut -d' ' -f1)" = 7e85289e160c9124b0151216e7ff803c8359222325effd2bd32334a007274684 ] || { echo CURRENT_NOT_R145_DXA_BATCH;exit 64; }
[ "$(sha256sum "$BASE/dexa_text_writer_v1.mjs" | cut -d' ' -f1)" = eb1165f35610cfe387bd944295889e2787c26774b4c4435f9642e920c2e2763a ] || { echo CURRENT_WRITER_CHANGED;exit 65; }
[ "$(sha256sum "$BACKUP/dexa_text_writer_v1.mjs" | cut -d' ' -f1)" = 117a322893a32ac3259776f8195d191ce7e2d53b6e95f2a4a728edef3961a652 ] || exit 67
if ! (set -C; echo "Dexa guarded audio-batch rollback" > "$FLAG") 2>/dev/null;then echo DRAIN_BUSY;exit 68;fi
trap 'rm -f "$FLAG"' EXIT
count=0
for i in $(seq 1 100);do
 state=$(curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | node -e 'let v="";process.stdin.on("data",x=>v+=x).on("end",()=>{try{const j=JSON.parse(v);if(!j.ok||j.deploymentDrain?.active!==true)process.exit(2);console.log(j.activeMissions)}catch{process.exit(2)}})') || { echo ROLLBACK_HEALTH_UNAVAILABLE;exit 69; }
 if [ "$state" = 0 ];then count=$((count+1));else count=0;fi
 if [ "$count" -ge 3 ];then break;fi
 sleep 1
done
[ "$count" -ge 3 ] || { echo ROLLBACK_MISSIONS_BUSY;exit 70; }
for f in $FILES;do cp "$BACKUP/$f" "$BASE/$f";done
systemctl --user restart dexa-main.service
for i in $(seq 1 90);do
 if curl -fsS --max-time 4 http://127.0.0.1:9471/healthz |
 node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.exit(1)};if(j.ok!==true||j.activeMissions!==0||j.plannerHotSlot?.ready!==true)process.exit(1)})';then
  [ "$(sha256sum "$BASE/dexa_typed_planner_prompt_v3.mjs" | cut -d' ' -f1)" = 7e85289e160c9124b0151216e7ff803c8359222325effd2bd32334a007274684 ] || exit 71
  [ "$(sha256sum "$BASE/dexa_text_writer_v1.mjs" | cut -d' ' -f1)" = 117a322893a32ac3259776f8195d191ce7e2d53b6e95f2a4a728edef3961a652 ] || exit 72
  echo DEXA_AUDIO_BATCH_ROLLBACK_HEALTHY
  exit 0
 fi
 sleep 1
done
echo DEXA_AUDIO_BATCH_ROLLBACK_NOT_VERIFIED
exit 73
