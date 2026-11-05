#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo CF_AUDIO_R274_ROOT_REQUIRED; exit 10; }
exec 9>/run/cf-audio-schema-r274.lock
flock -n 9 || exit 11

old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r273-wechat-message-list-20261101
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r274-audio-schema-20261105
active=/opt/capability-fabric/current
pkg=/tmp/cf-audio-schema-r274-payload
marker=/home/cfserver/.local/share/dexa/deployment-drain.flag
sha(){ sha256sum "$1" | awk '{print $1}'; }
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["ok"];print(d["activeMissions"],d["storedMissions"],int((d["deploymentDrain"] or {}).get("active",False)))'; }

[[ "$(readlink -f "$active")" == "$old" && -d "$old" && ! -e "$new" && ! -e "$marker" ]] || { echo CF_AUDIO_R274_BASELINE_NOT_ADMITTED; exit 12; }
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8788/)" == 'cf-onshape-single ok' ]] || exit 13
[[ -f "$pkg/patch_audio_schema.py" && -f "$pkg/test_audio_schema_r274.mjs" ]] || exit 14
read -r before_active before_stored before_drain <<< "$(health)"
[[ "$before_active" == 0 && "$before_drain" == 0 ]] || { echo CF_AUDIO_R274_DEXA_BUSY; exit 15; }

python3 - "$old" <<'PY'
import json,hashlib,sys
from pathlib import Path
r=Path(sys.argv[1]); m=json.loads((r/'manifest.json').read_text()); c=json.loads((r/'release-closure.json').read_text())
assert m['sequence']==273 and m['release_id']==r.name and c['build_id']==r.name
assert set(m['files'])==set(c['files'])
for name,digest in m['files'].items():
 assert hashlib.sha256((r/name).read_bytes()).hexdigest()==digest,('BASELINE_SHA',name)
src=(r/'telegram-ingress.mjs').read_text()
assert src.count('  server.registerTool("audio_transcribe", {')==1
assert src.count('    _meta: {"openai/fileParams":["files"]},')==1
assert src.count('  server.registerTool("audio_transcribe_batch", {')==0
assert src.count('  server.registerTool("telegram_transcribe", {')==0
print('CF_AUDIO_R274_R273_FULL_BASELINE_VERIFIED')
PY

stage="$(mktemp -d /var/lib/capability-fabric/releases/.r274-audio-schema.XXXXXXXX)"
marked=0; restarted=0; committed=0; installed=0
cleanup(){
 rc=$?
 trap - EXIT
 if (( rc!=0 && restarted==1 && committed==0 )); then
   docker compose -p capability-fabric -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
   echo CF_AUDIO_R274_BACKEND_ROLLBACK_ATTEMPTED
 fi
 if (( marked==1 )); then rm -f "$marker"; fi
 if [[ -d "$stage" ]]; then rm -rf -- "$stage"; fi
 if (( rc!=0 && installed==1 && committed==0 )); then rm -rf -- "$new"; fi
 exit "$rc"
}
trap cleanup EXIT

cp -a "$old"/. "$stage"/
python3 "$pkg/patch_audio_schema.py" "$stage/telegram-ingress.mjs"
python3 - "$old" "$stage" "$(basename "$new")" <<'PY'
import json,hashlib,sys
from pathlib import Path
a=Path(sys.argv[1]); b=Path(sys.argv[2]); release=sys.argv[3]
o=(a/'telegram-ingress.mjs').read_bytes(); n=(b/'telegram-ingress.mjs').read_bytes()
delta=b'    _meta: {"openai/fileParams":["files"]},\n'
assert o.count(delta)==1 and n==o.replace(delta,b'',1),'ONE_LINE_ONLY_GUARD'
m=json.loads((b/'manifest.json').read_text()); c=json.loads((b/'release-closure.json').read_text())
assert m['sequence']==273 and set(m['files'])==set(c['files'])
m['sequence']=274; m['release_id']=release; c['build_id']=release
(b/'release-closure.json').write_text(json.dumps(c,indent=2)+'\n')
m['files']['telegram-ingress.mjs']=hashlib.sha256(n).hexdigest()
m['files']['release-closure.json']=hashlib.sha256((b/'release-closure.json').read_bytes()).hexdigest()
(b/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
for name,digest in m['files'].items():
 assert hashlib.sha256((b/name).read_bytes()).hexdigest()==digest,('CANDIDATE_SHA',name)
print('CF_AUDIO_R274_RELEASE_HASHES_OK')
PY

node --check "$stage/telegram-ingress.mjs"
CF_AUDIO_R274_CANDIDATE="$stage/telegram-ingress.mjs" node --test "$pkg/test_audio_schema_r274.mjs" > "$pkg/qa.log" 2>&1
grep -q '^# pass 3$' "$pkg/qa.log"
grep -q '^# fail 0$' "$pkg/qa.log"
docker compose -p capability-fabric -f "$stage/compose.yaml" config --quiet

( set -C; printf 'Audio tool input schema parity r274\n' > "$marker" )
marked=1
chown cfserver:cfserver "$marker"
stable=0
for ((i=0;i<75;i++)); do
 if x="$(health 2>/dev/null)"; then
  read -r a n d <<< "$x"
  if [[ "$a" == 0 && "$d" == 1 ]]; then stable=$((stable+1)); else stable=0; fi
  (( stable>=3 )) && break
 else stable=0; fi
 sleep 1
done
(( stable>=3 )) || exit 20
[[ "$(readlink -f "$active")" == "$old" ]] || exit 21

chown -R root:root "$stage"
chmod -R go-w,a+rX "$stage"
mv "$stage" "$new"
installed=1
gateway_id="$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)"
restarted=1
docker compose -p capability-fabric -f "$new/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server
ready=0
for ((i=0;i<180;i++)); do
 st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' capability-fabric-onshape-server 2>/dev/null || true)"
 if [[ "$st" == healthy && "$(curl -fsS --max-time 4 http://127.0.0.1:8788/ 2>/dev/null || true)" == 'cf-onshape-single ok' ]]; then ready=1; break; fi
 sleep 1
done
(( ready==1 )) || { echo CF_AUDIO_R274_NOT_HEALTHY; exit 22; }
[[ "$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)" == "$gateway_id" ]] || exit 23
[[ "$(docker exec capability-fabric-onshape-server sha256sum /tmp/app/telegram-ingress.mjs | awk '{print $1}')" == "$(sha "$new/telegram-ingress.mjs")" ]] || exit 24
read -r a n d <<< "$(health)"
[[ "$a" == 0 && "$n" -ge "$before_stored" && "$d" == 1 ]] || exit 25
ln -s "$new" "$active.r274.$$"
mv -Tf "$active.r274.$$" "$active"
committed=1
echo CF_AUDIO_R274_LIVE_HEALTHY
echo CF_AUDIO_R274_SOURCE_SHA256="$(sha "$new/telegram-ingress.mjs")"
