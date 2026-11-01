#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$(id -un)" == root ]];then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/bash "$0"
fi
[[ "$(id -un)" == cfserver ]] || exit 10
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-contextual-kata-v1-20261101
D=/var/lib/capability-fabric/paa-remote/dexa-mvp
WORK=/home/cfserver/.local/share/dexa/dexa-contextual-kata-v1-20261101-release
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
manifest="$SRC/manifest.json"
hash_file(){ sha256sum "$1" | awk '{print $1}'; }
python3 - "$SRC" "$D" <<'PY'
import json,sys,hashlib
from pathlib import Path
src,live=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
assert m['schema']=='dexa.contextual-kata.v1'
assert m['source_commit']=='fb6940e1301ee32041d695ebe755829c9c49b43e'
assert len(m['files'])==2 and m['no_catalog_change'] and m['no_cf_change'] and m['no_service_restart']
for path,entry in m['files'].items():
 assert path.startswith('dexa/') and len(Path(path).parts)==2,path
 candidate=src/path
 original=live/Path(path).name
 assert candidate.is_file() and original.is_file() and not original.is_symlink()
 sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 assert sha(candidate)==entry['candidate'],path+' candidate'
 assert sha(original)==entry['baseline'],path+' live drift'
print('DEXA_KATA_SOURCE_BASELINE_VERIFIED')
PY
[[ ! -e "$WORK" && ! -e "$DRAIN" ]] || exit 11
WECHAT_GUI="$(pgrep -u 1000 -x wechat | head -n1)"
CF_RELEASE="$(readlink /opt/capability-fabric/current)"
[[ -n "$WECHAT_GUI" && -n "$CF_RELEASE" ]] || exit 12
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do
 systemctl --user is-active --quiet "$unit" || exit 13
done
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
BEFORE="$(health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and not x["deploymentDrain"]["active"];print(x["storedMissions"])')"
mkdir -p -m 700 "$WORK/stage" "$WORK/backup"
for file in kata_rank.py test_dexa_unified_provider_scope_v1.py;do
 cp -p "$D/$file" "$WORK/backup/$file"
 cp -p "$SRC/dexa/$file" "$WORK/stage/$file"
done
cp "$D/rana_capability_catalog.json" "$D/rana_cf_tool_schemas.json" "$D/typed_tool_wrapper_v3.txt" "$WORK/stage/"
python3 -m py_compile "$WORK/stage/kata_rank.py"
(cd "$WORK/stage"; DEXA_TOOL_PLAN_V3=1 python3 -m unittest test_dexa_unified_provider_scope_v1 -v) > "$WORK/pre.log" 2>&1
grep -q '^Ran 6 tests' "$WORK/pre.log"
grep -q '^OK$' "$WORK/pre.log"
marked=0;installed=0;committed=0
cleanup(){
 rc=$?
 trap - EXIT
 if ((rc!=0 && installed==1 && committed==0));then
  echo DEXA_KATA_ROLLBACK
  for file in kata_rank.py test_dexa_unified_provider_scope_v1.py;do
   cp -p "$WORK/backup/$file" "$D/.$file.rollback"
   mv -f "$D/.$file.rollback" "$D/$file"
  done
 fi
 if ((marked==1));then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
( set -C;printf '%s\n' 'Dexa contextual Kata change, no service restart' > "$DRAIN" )
marked=1
stable=0
for i in $(seq 1 30);do
 if health 2>/dev/null | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"]' 2>/dev/null;then
  stable=$((stable+1))
 else stable=0;fi
 ((stable>=3)) && break
 sleep 1
done
((stable>=3)) || exit 15
python3 - "$SRC" "$D" <<'PY'
import json,sys,hashlib
from pathlib import Path
src,live=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
for rel,v in m['files'].items():
 assert hashlib.sha256((live/Path(rel).name).read_bytes()).hexdigest()==v['baseline']
PY
installed=1
for file in kata_rank.py test_dexa_unified_provider_scope_v1.py;do
 cp "$WORK/stage/$file" "$D/.$file.new"
 chmod 600 "$D/.$file.new"
 mv -f "$D/.$file.new" "$D/$file"
done
python3 - "$manifest" "$D" <<'PY'
import json,sys,hashlib
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());live=Path(sys.argv[2])
for rel,v in m['files'].items():
 assert hashlib.sha256((live/Path(rel).name).read_bytes()).hexdigest()==v['candidate']
print('DEXA_KATA_LIVE_SOURCE_HASHES_VERIFIED')
PY
(cd "$D"; DEXA_TOOL_PLAN_V3=1 python3 -m unittest test_dexa_unified_provider_scope_v1 -v) > "$WORK/post.log" 2>&1
grep -q '^Ran 6 tests' "$WORK/post.log"
grep -q '^OK$' "$WORK/post.log"
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$WECHAT_GUI" ]] || exit 18
[[ "$(readlink /opt/capability-fabric/current)" == "$CF_RELEASE" ]] || exit 19
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do
 systemctl --user is-active --quiet "$unit" || exit 20
done
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and x["activeMissions"]==0 and x["deploymentDrain"]["active"] and x["storedMissions"]>=int(sys.argv[1])' "$BEFORE"
committed=1
rm -f "$DRAIN";marked=0
health | python3 -c 'import json,sys;x=json.load(sys.stdin);assert x["ok"] and not x["deploymentDrain"]["active"];print("DEXA_CONTEXTUAL_KATA_LIVE_VERIFIED",x["storedMissions"],x["activeMissions"])'
echo DEXA_CONTEXTUAL_KATA_NO_SERVICE_RESTART
