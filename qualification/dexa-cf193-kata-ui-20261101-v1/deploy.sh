#!/bin/sh
# One-owner Dexa CF r271 catalog-consumer repair. Never executes a provider action.
set -eu
if [ "$(id -un)" = root ]; then
  exec /usr/sbin/runuser -u cfserver -- /usr/bin/env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/sh "$0"
fi
[ "$(id -un)" = cfserver ] || { echo DEXA_SERVICE_USER_REQUIRED >&2; exit 41; }
export HOME=/home/cfserver
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
BASE=/var/lib/capability-fabric/paa-remote/dexa-mvp
RANK=/home/cfserver/connector-call-generator-prototype-v01/persian-catalog-search-v1
MOBILE=/home/cfserver/.local/share/dexa-mobile-gateway-20261023/mobile-catalog-ui.js
BACKUP="$HOME/.local/share/dexa/cf193-kata-ui-20261101-v1"
DRAIN="$HOME/.local/share/dexa/deployment-drain.flag"
[ ! -e "$DRAIN" ] || { echo DEXA_ALREADY_DRAINING >&2; exit 42; }
systemctl --user is-active --quiet dexa-main.service || exit 43
systemctl --user is-active --quiet dexa-mobile-gateway.service || exit 44
systemctl --user is-active --quiet dexa-catalog-gateway.service || exit 45
install -d -m 0700 "$BACKUP" "$BACKUP/ranker"
# Prepare exact-scope candidates and safe rollback before touching live files.
python3 - "$BASE" "$RANK" "$MOBILE" "$BACKUP" <<'PY'
from pathlib import Path
import json,hashlib,sys,shutil
base,rank,mobile,bak=map(Path,sys.argv[1:])
pins={
 base/'kata_rank.py':'119eaa5fd2772277cb9707e2cc6e033ea5b319f624dc2d4e5788efd9076a3475',
 base/'rana_capability_catalog.json':'42ae440a8060729807754fb34e185c7620e701334f9ee187cdbc11e213cb2b39',
 base/'rana_cf_tool_schemas.json':'377a627e9310778b8b6f5e0f493f26c435a1d76ba9998ca2d0cb697773cf61cd',
 rank/'catalog_fa.json':'6fcafa453758397c31934e5d7cc2157eb91d09902ea4b29fbcc9ff0ff799f332',
 mobile:'82b04ac7e1a4913f278d17441e8a276d209cba302aacbe43dc5ab732d0f0b305'
}
for f,sha in pins.items():
 assert hashlib.sha256(f.read_bytes()).hexdigest()==sha,('CHANGED_BASELINE',f)
cards=json.loads((base/'rana_capability_catalog.json').read_text())
cf=json.loads((base/'rana_cf_tool_schemas.json').read_text())['cf']
assert len(cards)==297 and len(cf)==193
assert 'wechat_file_send' in cf and 'wechat_file_upload' in cf and 'wechat_file_upload_chunk' in cf
assert len({c['capability_id'] for c in cards})==297
assert {k for k in cf}=={r[3:] for c in cards for r in c['physical_tool_ids'] if r.startswith('CF.')}
for name,file in [('kata_rank.py',base/'kata_rank.py'),('catalog_fa.json',rank/'catalog_fa.json'),('mobile-catalog-ui.js',mobile)]:
 (bak/('original-'+name)).write_bytes(file.read_bytes())
shutil.copyfile(base/'rana_capability_catalog.json',bak/'rana_capability_catalog.json')
shutil.copyfile(base/'rana_cf_tool_schemas.json',bak/'rana_cf_tool_schemas.json')
for name in ['rank_hybrid.py','rank_v2.py']:
 shutil.copyfile(rank/name,bak/'ranker'/name)
shutil.copyfile(base/'rana_capability_catalog.json',bak/'ranker'/'catalog_fa.json')
for name in ['typed_tool_wrapper_v3.txt','frozen_instant_wrapper_v2.txt']:
 shutil.copyfile(base/name,bak/name)
source=(base/'kata_rank.py').read_text()
anchor='CF_TOOL_SCHEMAS = json.loads(Path(__file__).with_name("rana_cf_tool_schemas.json").read_text())["cf"]'
old='if len(current_scores) != rank_hybrid.N or rank_hybrid.N != 291:'
assert source.count(anchor)==1 and source.count(old)==1
integrity='''
LIVE_CARDS = json.loads(Path(__file__).with_name("rana_capability_catalog.json").read_text())
if rank_hybrid.CATALOG != LIVE_CARDS:
    raise SystemExit("KATA_CATALOG_CORPUS_DRIFT")
EXPECTED_NATIVE_CF = {route[3:] for card in LIVE_CARDS for route in card["physical_tool_ids"] if route.startswith("CF.")}
if set(CF_TOOL_SCHEMAS) != EXPECTED_NATIVE_CF:
    raise SystemExit("KATA_CF_SCHEMA_CORPUS_DRIFT")
'''
patched=source.replace(anchor,anchor+'\n'+integrity).replace(old,'if len(current_scores) != rank_hybrid.N or rank_hybrid.N != len(LIVE_CARDS):')
(bak/'kata_rank.py').write_text(patched)
ui=mobile.read_text()
heading='<summary><strong>کاتالوگ دکسا · ۲۹۲ قابلیت</strong>'
assert ui.count(heading)==1
ui=ui.replace(heading,'<summary><strong id="dexaCatalogHeading">کاتالوگ دکسا</strong>')
rows=ui.splitlines()
matched=[i for i,s in enumerate(rows) if "counts.textContent='۲۹۲ قابلیت" in s]
assert len(matched)==1
rows[matched[0]]="""  const faNum=x=>Number(x||0).toLocaleString('fa-IR');
  $('dexaCatalogHeading').textContent='کاتالوگ دکسا · '+faNum(n.catalog)+' قابلیت';
  counts.textContent=faNum(n.catalog)+' قابلیت · '+faNum(n.cfMapped)+' مسیر CF · '+faNum(n.cfSafeReadReadyAfterOauth)+' خواندنی قابل اتصال · '+faNum(n.cfSensitiveReadGated)+' خواندن حساس · '+faNum(n.cfWriteOrSensitive)+' ابزار نوشتنی یا اثرگذار · '+faNum(n.noCfRoute)+' مسیر دیگر';"""
ui='\n'.join(rows)+'\n'
assert '۲۹۲ قابلیت' not in ui and '۱۸۸ مسیر CF' not in ui
(bak/'mobile-catalog-ui.js').write_text(ui)
print('DEXA_CF193_KATA_CANDIDATE_BUILT')
PY
python3 -m py_compile "$BACKUP/kata_rank.py"
node --check "$BACKUP/mobile-catalog-ui.js"
# Test the real 297-card scoring index and current provider names in isolation.
printf '%s\n' '{"text":"آخرین فایل ویدیویی پیام های ذخیره شده تلگرام من را به گفتگوی File Transfer در وی چت ارسال کن"}' |
 DEXA_KATA_CATALOG_ROOT="$BACKUP/ranker" DEXA_TOOL_PLAN_V3=1 python3 "$BACKUP/kata_rank.py" > "$BACKUP/score-canary.json"
python3 - "$BACKUP/score-canary.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
ids=set(r['capability_ids'])
required={'tool.cf.wechat_file_send','tool.cf.wechat_file_upload',
          'tool.cf.wechat_file_upload_chunk','tool.cf.telegram_attachment_get'}
assert r['catalog_count']==297 and required.issubset(ids),(r['catalog_count'],sorted(required-ids))
assert r['selected_count']<=297
print('DEXA_CF193_SHADOW_RANKING_CANARY_PASS',r['selected_count'])
PY
# Gate new admissions before restart; preserve all existing journals.
( set -C; printf 'Dexa CF193 Kata catalog-consumer guarded refresh\n' > "$DRAIN" ) || exit 46
cleanup(){ rm -f "$DRAIN"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stable=0
elapsed=0
while [ "$elapsed" -lt 180 ]; do
 if curl -fsS --max-time 4 http://127.0.0.1:9471/healthz 2>/dev/null |
 node -e 'let x="";process.stdin.on("data",b=>x+=b).on("end",()=>{try{const d=JSON.parse(x);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:1)}catch{process.exit(1)}})'; then
  stable=$((stable+1))
 else stable=0
 fi
 [ "$stable" -ge 3 ] && break
 elapsed=$((elapsed+1))
 sleep 1
done
[ "$stable" -ge 3 ] || { echo DEXA_MISSION_DRAIN_TIMEOUT >&2; exit 47; }
prev="$(curl -fsS --max-time 4 http://127.0.0.1:9471/healthz |
 node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).storedMissions))')"
cp "$BACKUP/kata_rank.py" "$BASE/kata_rank.py"
cp "$BACKUP/ranker/catalog_fa.json" "$RANK/catalog_fa.json"
cp "$BACKUP/mobile-catalog-ui.js" "$MOBILE"
chmod 600 "$BASE/kata_rank.py" "$RANK/catalog_fa.json" "$MOBILE"
verify(){
 systemctl --user restart dexa-main.service || return 1
 systemctl --user restart dexa-mobile-gateway.service || return 1
 attempt=0
 while [ "$attempt" -lt 35 ]; do
  if curl -fsS --max-time 4 http://127.0.0.1:9471/healthz 2>/dev/null |
   node -e 'let x="";process.stdin.on("data",b=>x+=b).on("end",()=>{try{const d=JSON.parse(x);process.exit(d.ok&&d.storedMissions>=Number(process.argv[1])&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:1)}catch{process.exit(1)}})' "$prev"; then
   break
  fi
  attempt=$((attempt+1))
  sleep 1
 done
 [ "$attempt" -lt 35 ] || return 1
 systemctl --user is-active --quiet dexa-mobile-gateway.service || return 1
 systemctl --user is-active --quiet dexa-catalog-gateway.service || return 1
 python3 - "$BASE" "$RANK" "$MOBILE" <<'PY'
import sys,json,hashlib
from pathlib import Path
base,rank,mobile=map(Path,sys.argv[1:])
c=json.loads((base/'rana_capability_catalog.json').read_text())
r=json.loads((rank/'catalog_fa.json').read_text())
assert c==r and len(c)==297
assert "KATA_CATALOG_CORPUS_DRIFT" in (base/'kata_rank.py').read_text()
ui=mobile.read_text()
assert "faNum(n.catalog)" in ui and "faNum(n.cfMapped)" in ui and "۲۹۲ قابلیت" not in ui
print('DEXA_CF193_CONSUMER_FILES_VERIFIED')
PY
 printf '%s\n' '{"text":"آخرین فایل ویدیویی پیام های ذخیره شده تلگرام من را به گفتگوی File Transfer در وی چت ارسال کن"}' |
 DEXA_TOOL_PLAN_V3=1 python3 "$BASE/kata_rank.py" > "$BACKUP/live-score-canary.json" || return 1
 python3 - "$BACKUP/live-score-canary.json" <<'PY'
import sys,json
r=json.load(open(sys.argv[1]))
names=set(r['capability_ids'])
assert r['catalog_count']==297 and {'tool.cf.wechat_file_send','tool.cf.wechat_file_upload','tool.cf.wechat_file_upload_chunk'}.issubset(names)
print('DEXA_CF193_LIVE_KATA_READONLY_CANARY_PASS')
PY
}
if ! verify; then
 cp "$BACKUP/original-kata_rank.py" "$BASE/kata_rank.py"
 cp "$BACKUP/original-catalog_fa.json" "$RANK/catalog_fa.json"
 cp "$BACKUP/original-mobile-catalog-ui.js" "$MOBILE"
 chmod 600 "$BASE/kata_rank.py" "$RANK/catalog_fa.json" "$MOBILE"
 systemctl --user restart dexa-main.service dexa-mobile-gateway.service || true
 echo DEXA_CF193_KATA_UI_DEPLOY_FAILED_ROLLED_BACK >&2
 exit 48
fi
echo DEXA_CF193_KATA_AND_MOBILE_UI_LIVE_VERIFIED
