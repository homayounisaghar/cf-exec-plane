#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$(id -un)" == root ]];then
 exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver \
  XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/bash "$0"
fi
[[ "$(id -un)" == cfserver ]] || exit 10
export HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
SRC=/tmp/dexa-unified-messenger-v1-20261101
WORK=/home/cfserver/.local/share/dexa/dexa-unified-messenger-v1-release-20261101
DEXA=/var/lib/capability-fabric/paa-remote/dexa-mvp
RANKER=/home/cfserver/connector-call-generator-prototype-v01/persian-catalog-search-v1
DRAIN=/home/cfserver/.local/share/dexa/deployment-drain.flag
CF_RELEASE="$(readlink /opt/capability-fabric/current)"
GUI="$(pgrep -u 1000 -x wechat | head -n1)"
[[ "$CF_RELEASE" == */onshape-vps-fast-r100-direct-orbit1-paa-storage-r273-wechat-message-list-20261101 ]] || { echo CF_R273_NOT_LIVE; exit 11; }
[[ -n "$GUI" && -d "$SRC/dexa" && ! -e "$WORK" && ! -e "$DRAIN" ]] || exit 12
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do
 systemctl --user is-active --quiet "$unit" || exit 13
done
health(){ curl -fsS --max-time 5 http://127.0.0.1:9471/healthz; }
before="$(health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<425)process.exit(2);console.log(d.storedMissions)})')"
mkdir -m 700 -p "$WORK" "$WORK/backup" "$WORK/candidate" "$WORK/tests" "$WORK/ranker"
cp "$SRC/manifest.json" "$WORK/manifest.json"
python3 - "$SRC" "$WORK" "$DEXA" "$RANKER" <<'PY'
from pathlib import Path
import hashlib,json,shutil,sys
src,work,dexa,ranker=map(Path,sys.argv[1:])
m=json.loads((src/'manifest.json').read_text())
patch=json.loads((src/'delta.json').read_text())
assert m['schema']=='dexa.unified-messenger-wechat-xhigh.release.v1'
assert patch['schema']=='dexa.catalog-exposure-delta.v1'
assert m['source_commit']==patch['source_commit']=='5042d059ebb59fb581a2309965b314f4d68b00b9'
assert len(m['files'])==7 and len(m['catalog'])==4
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert __import__('subprocess').check_output(['git','hash-object',str(src/'delta.json')],text=True).strip()==m['delta_git_blob']
for rel,v in m['files'].items():
 assert rel.startswith('dexa/') and len(Path(rel).parts)==2
 source=src/rel; dest=dexa/Path(rel).name
 assert source.is_file() and sha(source)==v['candidate'],('CODE_SOURCE_SHA',rel)
 assert (not dest.exists()) if v['baseline'] is None else (sha(dest)==v['baseline']),('CODE_BASE_SHA',rel)
 shutil.copy2(source,work/'candidate'/Path(rel).name)
 if v['baseline'] is not None:shutil.copy2(dest,work/'backup'/Path(rel).name)
existing={
 'rana_capability_catalog':dexa/'rana_capability_catalog.json',
 'rana_cf_tool_schemas':dexa/'rana_cf_tool_schemas.json',
 'dexa_catalog_output_shapes':dexa/'dexa_catalog_output_shapes_v1.json',
 'ranker_catalog':ranker/'catalog_fa.json',
}
for key,source in existing.items():
 assert sha(source)==m['catalog'][key]['baseline'],('CATALOG_BASE_SHA',key)
 shutil.copy2(source,work/'backup'/source.name)
cards=json.loads(existing['rana_capability_catalog'].read_text())
schemas=json.loads(existing['rana_cf_tool_schemas'].read_text())
shapes=json.loads(existing['dexa_catalog_output_shapes'].read_text())
assert len(cards)==297 and len(schemas['cf'])==193
assert cards==json.loads(existing['ranker_catalog'].read_text())
assert not any(x['capability_id']==patch['new_card']['capability_id'] for x in cards)
assert 'wechat_message_list' not in schemas['cf'] and 'wechat_message_list' not in shapes['adapters']
cards.append(patch['new_card'])
schemas['cf']['wechat_message_list']=patch['new_tool_schema']
shapes['adapters']['wechat_message_list']=patch['new_output_shape']
generated={
 'rana_capability_catalog.json':cards,
 'rana_cf_tool_schemas.json':schemas,
 'dexa_catalog_output_shapes_v1.json':shapes,
 'catalog_fa.json':cards,
}
keymap={ 'rana_capability_catalog.json':'rana_capability_catalog',
 'rana_cf_tool_schemas.json':'rana_cf_tool_schemas',
 'dexa_catalog_output_shapes_v1.json':'dexa_catalog_output_shapes',
 'catalog_fa.json':'ranker_catalog' }
for filename,body in generated.items():
 target=(work/'ranker'/filename) if filename=='catalog_fa.json' else (work/'candidate'/filename)
 target.write_text(json.dumps(body,ensure_ascii=False,indent=2)+'\n')
 assert sha(target)==m['catalog'][keymap[filename]]['candidate'],('CATALOG_GENERATED_SHA',filename,sha(target))
print('DEXA_UNIFIED_CANDIDATE_HASHES_11_VERIFIED')
PY
for f in "$WORK/candidate/"*.mjs;do node --check "$f";done
cp "$DEXA/"*.mjs "$WORK/tests/"
cp "$DEXA/"*.json "$WORK/tests/"
cp "$DEXA/frozen_instant_wrapper_v2.txt" "$DEXA/typed_tool_wrapper_v3.txt" "$WORK/tests/"
cp "$WORK/candidate/"* "$WORK/tests/"
cp "$RANKER/rank_v2.py" "$WORK/ranker/"
cp "$RANKER/rank_hybrid.py" "$WORK/ranker/"
QA="test_dexa_wechat_message_list_v1.mjs test_dexa_universal_unread_contract_v1.mjs test_dexa_cerebras_api_planner_v1.mjs test_dexa_messaging_record_contract_v1.mjs test_dexa_chat_semantic_planner_v1.mjs test_dexa_unread_output_contract_v2.mjs test_dexa_tool_plan_v3.mjs test_dexa_root_plan_answer_contract_v1.mjs"
(cd "$WORK/tests";node --test $QA)> "$WORK/pre-js.log" 2>&1
grep -q '^# tests 46$' "$WORK/pre-js.log"
grep -q '^# pass 46$' "$WORK/pre-js.log"
grep -q '^# fail 0$' "$WORK/pre-js.log"
cp "$WORK/candidate/kata_rank.py" "$WORK/tests/"
(cd "$WORK/tests"; DEXA_KATA_CATALOG_ROOT="$WORK/ranker" PYTHONPATH="$WORK/tests" python3 -m unittest -q test_dexa_unified_provider_scope_v1.py) > "$WORK/pre-py.log" 2>&1
grep -q 'Ran 3 tests' "$WORK/pre-py.log" && grep -q '^OK$' "$WORK/pre-py.log"
echo DEXA_UNIFIED_STAGE_46_NODE_3_PY_PASS
marked=0; changed=0; committed=0
restore(){
 python3 - "$WORK" "$DEXA" "$RANKER" <<'PY'
import os,json,sys
from pathlib import Path
work,dexa,ranker=map(Path,sys.argv[1:])
m=json.loads((work/'manifest.json').read_text())
for rel,v in m['files'].items():
 dst=dexa/Path(rel).name
 if v['baseline'] is None:dst.unlink(missing_ok=True)
 else:
  data=(work/'backup'/Path(rel).name).read_bytes()
  tmp=dst.with_name(dst.name+'.unified-rollback')
  tmp.write_bytes(data);tmp.chmod(0o600);os.replace(tmp,dst)
for name in ('rana_capability_catalog.json','rana_cf_tool_schemas.json','dexa_catalog_output_shapes_v1.json'):
 dst=dexa/name;tmp=dst.with_name(dst.name+'.unified-rollback')
 tmp.write_bytes((work/'backup'/name).read_bytes());tmp.chmod(0o600);os.replace(tmp,dst)
dst=ranker/'catalog_fa.json';tmp=dst.with_name(dst.name+'.unified-rollback')
tmp.write_bytes((work/'backup'/'catalog_fa.json').read_bytes());tmp.chmod(0o600);os.replace(tmp,dst)
PY
}
cleanup(){
 rc=$?
 trap - EXIT
 if ((rc!=0 && changed==1 && committed==0));then
  echo DEXA_UNIFIED_ROLLBACK
  restore || true
  systemctl --user restart dexa-catalog-gateway.service || true
  systemctl --user restart dexa-main.service || true
 fi
 if ((marked==1));then rm -f "$DRAIN";fi
 exit "$rc"
}
trap cleanup EXIT
( set -C; printf '%s\n' 'Dexa unified messenger 298/194 catalog and Qwen xhigh deploy' > "$DRAIN" )
marked=1
stable=0
for ((i=0;i<65;i++));do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:2)})';then
  stable=$((stable+1))
 else stable=0;fi
 ((stable>=3)) && break
 sleep 1
done
((stable>=3)) || exit 14
python3 - "$WORK" "$DEXA" "$RANKER" <<'PY'
from pathlib import Path
import json,hashlib,sys
w,d,r=map(Path,sys.argv[1:]);m=json.loads((w/'manifest.json').read_text())
for rel,v in m['files'].items():
 p=d/Path(rel).name
 assert (not p.exists()) if v['baseline'] is None else hashlib.sha256(p.read_bytes()).hexdigest()==v['baseline'],rel
for key,p in {'rana_capability_catalog':d/'rana_capability_catalog.json','rana_cf_tool_schemas':d/'rana_cf_tool_schemas.json','dexa_catalog_output_shapes':d/'dexa_catalog_output_shapes_v1.json','ranker_catalog':r/'catalog_fa.json'}.items():
 assert hashlib.sha256(p.read_bytes()).hexdigest()==m['catalog'][key]['baseline'],key
print('DEXA_UNIFIED_PRECOMMIT_GATES_VERIFIED')
PY
changed=1
for srcpath in "$WORK/candidate/"*;do
 file="$(basename "$srcpath")"
 dest="$DEXA/$file";temp="$DEXA/.$file.unified-new"
 cp "$srcpath" "$temp";chmod 600 "$temp";mv -f "$temp" "$dest"
done
cp "$WORK/ranker/catalog_fa.json" "$RANKER/.catalog_fa.json.unified-new"
chmod 600 "$RANKER/.catalog_fa.json.unified-new"
mv -f "$RANKER/.catalog_fa.json.unified-new" "$RANKER/catalog_fa.json"
systemctl --user restart dexa-catalog-gateway.service
systemctl --user restart dexa-main.service
ready=0
for ((i=0;i<80;i++));do
 if health 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true&&d.storedMissions>=Number(process.argv[1])?0:2)})' "$before";then
  ready=1;break
 fi
 sleep 1
done
((ready==1)) || exit 15
[[ "$(readlink /opt/capability-fabric/current)" == "$CF_RELEASE" ]] || exit 16
[[ "$(pgrep -u 1000 -x wechat | head -n1)" == "$GUI" ]] || exit 17
for unit in dexa-main.service dexa-catalog-gateway.service capability-fabric-pcg-wechat-semantic-manual.service;do
 systemctl --user is-active --quiet "$unit" || exit 18
done
python3 - "$WORK" "$DEXA" "$RANKER" <<'PY'
from pathlib import Path
import json,hashlib,sys
w,d,r=map(Path,sys.argv[1:]);m=json.loads((w/'manifest.json').read_text())
for rel,v in m['files'].items():
 assert hashlib.sha256((d/Path(rel).name).read_bytes()).hexdigest()==v['candidate'],rel
for key,p in {'rana_capability_catalog':d/'rana_capability_catalog.json','rana_cf_tool_schemas':d/'rana_cf_tool_schemas.json','dexa_catalog_output_shapes':d/'dexa_catalog_output_shapes_v1.json','ranker_catalog':r/'catalog_fa.json'}.items():
 assert hashlib.sha256(p.read_bytes()).hexdigest()==m['catalog'][key]['candidate'],key
assert len(json.loads((d/'rana_capability_catalog.json').read_text()))==298
assert len(json.loads((d/'rana_cf_tool_schemas.json').read_text())['cf'])==194
assert 'reasoning_effort:"xhigh"' in (d/'cerebras_api_planner.mjs').read_text()
print('DEXA_UNIFIED_LIVE_11_HASHES_298_CARDS_194_CF_TOOLS_XHIGH')
PY
(cd "$DEXA";node --test $QA)> "$WORK/post-js.log" 2>&1
grep -q '^# tests 46$' "$WORK/post-js.log" && grep -q '^# pass 46$' "$WORK/post-js.log" && grep -q '^# fail 0$' "$WORK/post-js.log"
(cd "$DEXA"; DEXA_KATA_CATALOG_ROOT="$RANKER" PYTHONPATH="$DEXA" python3 -m unittest -q test_dexa_unified_provider_scope_v1.py) > "$WORK/post-py.log" 2>&1
grep -q 'Ran 3 tests' "$WORK/post-py.log" && grep -q '^OK$' "$WORK/post-py.log"
rm -f "$DRAIN";marked=0
health | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions!==0||d.deploymentDrain?.active||d.storedMissions<Number(process.argv[1]))process.exit(2);console.log("DEXA_UNIFIED_LIVE_HEALTH",d.storedMissions,d.activeMissions)})' "$before"
committed=1
echo DEXA_UNIFIED_MESSENGER_XHIGH_V1_LIVE_VERIFIED
