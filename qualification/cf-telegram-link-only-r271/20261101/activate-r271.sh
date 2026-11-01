#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo ROOT_REQUIRED; exit 10; }
exec 9>/run/cf-telegram-r271.lock
flock -n 9 || exit 11
old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r270-wechat-stream-1g-20261031
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r271-telegram-link-only-20261101
active=/opt/capability-fabric/current
backup="$old/telegram-ingress.mjs.bak-no-inline"
marker=/home/cfserver/.local/share/dexa/deployment-drain.flag
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"]; print(d["activeMissions"],d["storedMissions"],int((d["deploymentDrain"] or {}).get("active",False)))'; }
[[ "$(readlink -f "$active")" == "$old" && -d "$old" && -f "$backup" && ! -e "$new" && ! -e "$marker" ]] || { echo BASELINE_NOT_ADMITTED; exit 12; }
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8788/)" == 'cf-onshape-single ok' ]] || exit 13
read -r before_active before_stored before_drain <<< "$(health)"
[[ "$before_active" == 0 && "$before_drain" == 0 ]] || { echo BUSY_OR_DRAINED; exit 14; }
python3 - "$old" <<'PY'
import hashlib,json,sys
from pathlib import Path
r=Path(sys.argv[1]); m=json.loads((r/'manifest.json').read_text()); c=json.loads((r/'release-closure.json').read_text())
assert m['sequence']==270 and m['release_id']==r.name and c['build_id']==r.name
assert 'telegram-ingress.mjs' in m['files'] and set(m['files'])==set(c['files'])
def sha(b): return hashlib.sha256(b).hexdigest()
original=(r/'telegram-ingress.mjs.bak-no-inline').read_bytes()
patched=(r/'telegram-ingress.mjs').read_bytes()
for name,digest in m['files'].items():
    payload=original if name=='telegram-ingress.mjs' else (r/name).read_bytes()
    assert sha(payload)==digest, 'BASELINE_SHA_MISMATCH:'+name
anchor=original.index(b'server.registerTool("telegram_attachment_get"')
a=original.index(b'const content = [{ type: "text", text: JSON.stringify(metadata, null, 1) }];',anchor)
b=original.index(b'return { structuredContent: metadata, content };',a)
old_block=original[a:b]
assert 100<len(old_block)<2500 and old_block.count(b'blob:')==2 and b'previewStaged' in old_block and b'resource_link' in old_block
new_block=b'const content = [{ type: "text", text: JSON.stringify(metadata, null, 1) }, { type: "resource_link", uri: "https://cf-onshape.duckdns.org" + staged.download_path, name: staged.filename, mimeType: staged.mime_type, size: staged.size_bytes, description: "Original Telegram attachment; expiring download." }];\n      '
assert patched==original[:a]+new_block+original[b:], 'HOTFIX_NOT_EXACT_EXPECTED_CHANGE'
assert patched[a:b].count(b'blob:')==0
print('R271_SOURCE_PATCH_EXACT_VERIFIED',sha(patched))
PY
stage=$(mktemp -d /var/lib/capability-fabric/releases/.r271-telegram.XXXXXXXX)
marked=0; restarted=0; committed=0; installed=0
cleanup(){ rc=$?; trap - EXIT; if (( rc!=0 && restarted==1 && committed==0 )); then docker compose -p capability-fabric -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true; echo R271_BACKEND_ROLLBACK_ATTEMPTED; fi; if (( marked==1 )); then rm -f "$marker"; fi; if [[ -d "$stage" ]]; then rm -rf -- "$stage"; fi; if (( rc!=0 && installed==1 && committed==0 )); then rm -rf -- "$new"; fi; exit "$rc"; }
trap cleanup EXIT
cp -a "$old"/. "$stage"/
rm -f "$stage/telegram-ingress.mjs.bak-no-inline"
python3 - "$stage" "$(basename "$new")" <<'PY'
import hashlib,json,sys
from pathlib import Path
r=Path(sys.argv[1]); release=sys.argv[2]; m=json.loads((r/'manifest.json').read_text()); c=json.loads((r/'release-closure.json').read_text())
assert m['sequence']==270 and set(m['files'])==set(c['files'])
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
c['build_id']=release
(r/'release-closure.json').write_text(json.dumps(c,indent=2)+'\n')
m['sequence']=271; m['release_id']=release
m['files']['telegram-ingress.mjs']=sha(r/'telegram-ingress.mjs')
m['files']['release-closure.json']=sha(r/'release-closure.json')
(r/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
for name,digest in m['files'].items(): assert sha(r/name)==digest,name
assert b'blob:' not in (r/'telegram-ingress.mjs').read_bytes().split(b'const content = [{ type: "text", text: JSON.stringify(metadata, null, 1) }, { type: "resource_link"',1)[-1].split(b'return { structuredContent: metadata, content };',1)[0]
print('R271_RELEASE_HASHES_OK')
PY
node --check "$stage/telegram-ingress.mjs"
docker compose -p capability-fabric -f "$stage/compose.yaml" config --quiet
( set -C; printf 'Telegram link-only r271\n' > "$marker" )
marked=1
chown cfserver:cfserver "$marker"
stable=0
for ((i=0;i<75;i++)); do
  if x="$(health 2>/dev/null)"; then read -r a n d <<< "$x"; if [[ "$a" == 0 && "$d" == 1 ]]; then stable=$((stable+1)); else stable=0; fi; (( stable>=3 )) && break; else stable=0; fi
  sleep 1
done
(( stable>=3 )) || { echo DRAIN_NOT_STABLE; exit 20; }
[[ "$(readlink -f "$active")" == "$old" ]] || exit 21
chown -R root:root "$stage"
chmod -R go-w,a+rX "$stage"
mv "$stage" "$new"
installed=1
gateway_id=$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)
restarted=1
docker compose -p capability-fabric -f "$new/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server
ready=0
for ((i=0;i<180;i++)); do
  st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' capability-fabric-onshape-server 2>/dev/null || true)
  if [[ "$st" == healthy && "$(curl -fsS --max-time 4 http://127.0.0.1:8788/ 2>/dev/null || true)" == 'cf-onshape-single ok' ]]; then ready=1; break; fi
  sleep 1
done
(( ready==1 )) || { echo NEW_SERVICE_NOT_HEALTHY; exit 22; }
[[ "$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)" == "$gateway_id" ]] || exit 23
[[ "$(docker exec capability-fabric-onshape-server sha256sum /tmp/app/telegram-ingress.mjs | awk '{print $1}')" == "$(sha256sum "$new/telegram-ingress.mjs" | awk '{print $1}')" ]] || { echo RUNTIME_SOURCE_MISMATCH; exit 24; }
read -r a n d <<< "$(health)"
[[ "$a" == 0 && "$n" -ge "$before_stored" && "$d" == 1 ]] || exit 25
ln -s "$new" "$active.r271.$$"
mv -Tf "$active.r271.$$" "$active"
committed=1
printf 'CF_TELEGRAM_R271_LINK_ONLY_LIVE_HEALTHY\n'
