#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo CF_R272_ROOT_REQUIRED; exit 10; }
exec 9>/run/cf-wechat-chat-attrs-r272.lock
flock -n 9 || exit 11
old=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r271-telegram-link-only-20261101
new=/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r272-wechat-chat-attrs-20261101
active=/opt/capability-fabric/current
pkg=/tmp/cf-wechat-chat-r272-payload
marker=/home/cfserver/.local/share/dexa/deployment-drain.flag
sha(){ sha256sum "$1" | awk '{print $1}'; }
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["ok"];print(d["activeMissions"],d["storedMissions"],int((d["deploymentDrain"] or {}).get("active",False)))'; }
[[ "$(readlink -f "$active")" == "$old" && -d "$old" && ! -e "$new" && ! -e "$marker" ]] || { echo CF_R272_BASELINE_NOT_ADMITTED; exit 12; }
[[ "$(curl -fsS --max-time 5 http://127.0.0.1:8788/)" == 'cf-onshape-single ok' ]] || exit 13
[[ "$(sha "$pkg/projection.json")" == "b5532cad83f46004a6cf07732596fa7dd96cfa6de3331ec306e6efea2dab424b" ]] || exit 14
[[ "$(sha "$pkg/test_cf_chat_attrs.mjs")" == "2fe40334f11d2c2652df1a4c570a9ed538f63bb36292c8fd9bef72b7f780b946" ]] || exit 15
read -r before_active before_stored before_drain <<< "$(health)"
[[ "$before_active" == 0 && "$before_drain" == 0 && "$before_stored" -ge 416 ]] || exit 16
wechat_pid="$(pgrep -u 1000 -x wechat | head -n1)"
[[ -n "$wechat_pid" ]] || exit 17
python3 - "$old" "$pkg/projection.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
r=Path(sys.argv[1]);p=json.loads(Path(sys.argv[2]).read_text())
m=json.loads((r/'manifest.json').read_text());c=json.loads((r/'release-closure.json').read_text())
assert m['sequence']==271 and m['release_id']==r.name and c['build_id']==r.name
assert 'wechat-ingress.mjs' in m['files'] and set(m['files'])==set(c['files'])
assert p['schema']=='cf.wechat.conversation-attributes-projection.v1'
assert p['target_file']=='wechat-ingress.mjs' and p['semantics']['tool_schema_changed'] is False
def sha(b):return hashlib.sha256(b).hexdigest()
for name,digest in m['files'].items():
    assert sha((r/name).read_bytes())==digest, 'BASELINE_SHA:'+name
old=(r/'wechat-ingress.mjs').read_text()
assert old.count(p['baseline_fragment'])==1,'EXPECTED_SINGLE_NATIVE_MAPPING'
assert p['candidate_fragment'] not in old
assert old.index('function normalizeConversation(item)')<old.index(p['baseline_fragment'])<old.index('async function currentConversations(')
print('CF_R272_R271_BASELINE_VERIFIED')
PY
stage="$(mktemp -d /var/lib/capability-fabric/releases/.r272-chat-attrs.XXXXXXXX)"
marked=0;restarted=0;committed=0;installed=0
cleanup(){
 rc=$?
 trap - EXIT
 if (( rc!=0 && restarted==1 && committed==0 ));then
   docker compose -p capability-fabric -f "$old/compose.yaml" up -d --no-deps --no-build --pull never --force-recreate onshape_server || true
   echo CF_R272_BACKEND_ROLLBACK_ATTEMPTED
 fi
 if (( marked==1 ));then rm -f "$marker";fi
 if [[ -d "$stage" ]];then rm -rf -- "$stage";fi
 if (( rc!=0 && installed==1 && committed==0 ));then rm -rf -- "$new";fi
 exit "$rc"
}
trap cleanup EXIT
cp -a "$old"/. "$stage"/
python3 - "$stage" "$pkg/projection.json" "$(basename "$new")" <<'PY'
import hashlib,json,sys
from pathlib import Path
r=Path(sys.argv[1]);p=json.loads(Path(sys.argv[2]).read_text());release=sys.argv[3]
m=json.loads((r/'manifest.json').read_text());c=json.loads((r/'release-closure.json').read_text())
assert m['sequence']==271 and set(m['files'])==set(c['files'])
f=r/p['target_file'];original=f.read_text()
assert original.count(p['baseline_fragment'])==1
updated=original.replace(p['baseline_fragment'],p['candidate_fragment'])
assert updated!=original and updated.count(p['candidate_fragment'])==1
f.write_text(updated)
c['build_id']=release
(r/'release-closure.json').write_text(json.dumps(c,indent=2)+'\n')
m['sequence']=272;m['release_id']=release
m['files'][p['target_file']]=hashlib.sha256(f.read_bytes()).hexdigest()
m['files']['release-closure.json']=hashlib.sha256((r/'release-closure.json').read_bytes()).hexdigest()
(r/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
for name,digest in m['files'].items():
    assert hashlib.sha256((r/name).read_bytes()).hexdigest()==digest,name
print('CF_R272_RELEASE_HASHES_OK')
PY
node --check "$stage/wechat-ingress.mjs"
CF_WECHAT_INGRESS_BASELINE="$old/wechat-ingress.mjs" CF_CHAT_ATTRIBUTE_PATCH="$pkg/projection.json" node --test "$pkg/test_cf_chat_attrs.mjs" > "$pkg/qa.log" 2>&1
grep -q '^# pass 4$' "$pkg/qa.log" && grep -q '^# fail 0$' "$pkg/qa.log"
docker compose -p capability-fabric -f "$stage/compose.yaml" config --quiet
( set -C; printf 'Native WeChat chat attribute projection r272\n' > "$marker" )
marked=1
chown cfserver:cfserver "$marker"
stable=0
for ((i=0;i<75;i++));do
 if x="$(health 2>/dev/null)";then
   read -r a n d <<< "$x"
   if [[ "$a" == 0 && "$d" == 1 ]];then stable=$((stable+1));else stable=0;fi
   (( stable>=3 )) && break
 else stable=0;fi
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
for ((i=0;i<180;i++));do
 st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' capability-fabric-onshape-server 2>/dev/null || true)"
 if [[ "$st" == healthy && "$(curl -fsS --max-time 4 http://127.0.0.1:8788/ 2>/dev/null || true)" == 'cf-onshape-single ok' ]];then ready=1;break;fi
 sleep 1
done
(( ready==1 )) || { echo CF_R272_NOT_HEALTHY;exit 22; }
[[ "$(docker inspect -f '{{.Id}}' capability-fabric-onshape-gateway)" == "$gateway_id" ]] || exit 23
[[ "$(docker exec capability-fabric-onshape-server sha256sum /tmp/app/wechat-ingress.mjs | awk '{print $1}')" == "$(sha "$new/wechat-ingress.mjs")" ]] || exit 24
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$wechat_pid" ]] || exit 25
read -r a n d <<< "$(health)"
[[ "$a" == 0 && "$n" -ge "$before_stored" && "$d" == 1 ]] || exit 26
ln -s "$new" "$active.r272.$$"
mv -Tf "$active.r272.$$" "$active"
committed=1
printf 'CF_WECHAT_CHAT_ATTRIBUTES_R272_LIVE_HEALTHY\n'
