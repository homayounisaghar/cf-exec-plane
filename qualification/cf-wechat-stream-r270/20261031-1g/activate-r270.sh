#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || exit 10
exec 9>/run/cf-wechat-r270.lock; flock -n 9 || exit 11
old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r269-wechat-real-file-send-20261031
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r270-wechat-stream-1g-20261031
active=/opt/capability-fabric/current
helper=/home/cfserver/wechat-media-tools-candidate-20261030/wechat_semantic_helper_chooser_fixed_20261031.py
backup=/home/cfserver/wechat-media-tools-candidate-20261030/wechat_semantic_helper_chooser_fixed_20261031.py.r270-before
pkg=/tmp/cf-wechat-r270-payload
marker=/home/cfserver/.local/share/dexa/deployment-drain.flag
media_sha=d38e5d2064081a090b4a87c5867c4c683085b82270be61dfeb69265b5e10998f
helper_sha=f0ac97553d22b763c3ab01719de4858445e61d1ef2e9944ffa9c6b0052f37460
sha(){ sha256sum "$1" | awk '{print $1}'; }
userctl(){ runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"; }
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["ok"];print(d["activeMissions"],d["storedMissions"],int((d["deploymentDrain"] or {}).get("active",False)))'; }
[[ "$(readlink -f "$active")" == "$old" && -d "$old" && ! -e "$new" && ! -e "$backup" && ! -e "$marker" ]] || exit 12
[[ "$(sha "$pkg/wechat-media-tools.mjs")" == "$media_sha" && "$(sha "$pkg/wechat-semantic-helper.py")" == "$helper_sha" ]] || exit 13
[[ "$(sha "$old/wechat-media-tools.mjs")" == 32f96e63675f680d2d4ecef8367529f37dbf676b5b7442cb1ee9850d48768e73 ]] || exit 14
[[ "$(sha "$helper")" == 292b240048acafaf8f102019b8f2eb735ff478485d52422041b89a4123eaa355 ]] || exit 15
[[ "$(userctl is-active capability-fabric-pcg-wechat-semantic-manual.service)" == active ]] || exit 16
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8788/)" == "cf-onshape-single ok" ]] || exit 17
curl -fsS --max-time 5 http://127.0.0.1:9337/status | python3 -c 'import json,sys;assert json.load(sys.stdin)["authenticated"] is True'
read -r before_active before_stored before_drain <<< "$(health)"
[[ "$before_active" == 0 && "$before_drain" == 0 ]] || exit 18
wechat_pid="$(pgrep -u 1000 -x wechat | head -n1)"; [[ -n "$wechat_pid" ]] || exit 19
node --check "$pkg/wechat-media-tools.mjs"; python3 -m py_compile "$pkg/wechat-semantic-helper.py"
stage="$(mktemp -d /var/lib/capability-fabric/releases/.r270.XXXXXXXX)"
claimed=0; helper_changed=0; backend_changed=0; committed=0
rollback(){ rc=$?; trap - EXIT
 if (( rc != 0 && backend_changed == 1 && committed == 0 )); then
  docker compose -p capability-fabric -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
  echo R270_BACKEND_ROLLBACK_ATTEMPTED
 fi
 if (( rc != 0 && helper_changed == 1 )); then
  install -o cfserver -g cfserver -m 0600 "$backup" "$helper"
  userctl restart capability-fabric-pcg-wechat-semantic-manual.service || true
  echo R270_HELPER_ROLLBACK_ATTEMPTED
 fi
 ((claimed == 0)) || rm -f "$marker"
 rm -rf "$stage"; exit "$rc"
}
trap rollback EXIT
cp -a "$old"/. "$stage"/
install -o root -g root -m 0644 "$pkg/wechat-media-tools.mjs" "$stage/wechat-media-tools.mjs"
python3 - "$stage" "$media_sha" "$(basename "$new")" <<'PY'
import json,hashlib,sys
from pathlib import Path
root=Path(sys.argv[1]); h=sys.argv[2]; release=sys.argv[3]
m=json.loads((root/'manifest.json').read_text()); c=json.loads((root/'release-closure.json').read_text())
assert m['sequence']==269 and len(m['files'])==32
m['sequence']=270; m['release_id']=release; c['build_id']=release
(root/'release-closure.json').write_text(json.dumps(c,indent=2)+'\n')
m['files']['wechat-media-tools.mjs']=h
m['files']['release-closure.json']=hashlib.sha256((root/'release-closure.json').read_bytes()).hexdigest()
(root/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
assert set(m['files'])==set(c['files'])
for n,v in m['files'].items(): assert hashlib.sha256((root/n).read_bytes()).hexdigest()==v,n
print('R270_RELEASE_HASHES_OK')
PY
docker compose -p capability-fabric -f "$stage/compose.yaml" config --quiet
( set -C; printf 'WeChat stream r270\n' > "$marker" )
claimed=1; chown cfserver:cfserver "$marker"
stable=0
for ((i=0;i<75;i++)); do
 if x="$(health 2>/dev/null)"; then read -r a n d <<< "$x"
  if [[ "$a" == 0 && "$d" == 1 ]]; then stable=$((stable+1)); else stable=0; fi
  ((stable>=3)) && break
 else stable=0; fi
 sleep 1
done
((stable>=3)) || exit 20
[[ "$(readlink -f "$active")" == "$old" ]] || exit 21
cp -a "$helper" "$backup"
install -o cfserver -g cfserver -m 0600 "$pkg/wechat-semantic-helper.py" "$helper"
helper_changed=1
userctl restart capability-fabric-pcg-wechat-semantic-manual.service
ready=0
for ((i=0;i<40;i++)); do
 if [[ "$(userctl is-active capability-fabric-pcg-wechat-semantic-manual.service)" == active ]] && curl -fsS --max-time 3 http://127.0.0.1:9337/status 2>/dev/null | python3 -c 'import json,sys;assert json.load(sys.stdin)["authenticated"] is True' 2>/dev/null; then ready=1; break; fi
 sleep 1
done
((ready==1)) || exit 22
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$wechat_pid" ]] || exit 23
chown -R root:root "$stage"; chmod -R go-w,a+rX "$stage"
mv "$stage" "$new"
gateway_id="$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)"
backend_changed=1
docker compose -p capability-fabric -f "$new/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server
ready=0
for ((i=0;i<180;i++)); do
 st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' capability-fabric-onshape-server 2>/dev/null || true)"
 if [[ "$st" == healthy && "$(curl -fsS --max-time 4 http://127.0.0.1:8788/ 2>/dev/null || true)" == "cf-onshape-single ok" ]]; then ready=1; break; fi
 sleep 1
done
((ready==1)) || exit 24
[[ "$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)" == "$gateway_id" ]] || exit 25
[[ "$(docker exec capability-fabric-onshape-server sha256sum /tmp/app/wechat-media-tools.mjs | awk '{print $1}')" == "$media_sha" ]] || exit 26
[[ "$(sha "$helper")" == "$helper_sha" && "$(pgrep -u 1000 -x wechat | head -n1)" == "$wechat_pid" ]] || exit 27
read -r a n d <<< "$(health)"
[[ "$a" == 0 && "$n" -ge "$before_stored" && "$d" == 1 ]] || exit 28
ln -s "$new" "$active.r270.$$"; mv -Tf "$active.r270.$$" "$active"
committed=1
echo CF_WECHAT_R270_1G_STREAM_LIVE_HEALTHY
echo CF_WECHAT_R270_APP_UNCHANGED
