#!/bin/sh
set -eu
cd /var/lib/capability-fabric/paa-remote/dexa-mvp
DELTA=/tmp/dexa-cf-r271-catalog-delta-20261101.json
BACKUP="$HOME/.local/share/dexa/catalog-r271-rollback-20261101"
DRAIN="$HOME/.local/share/dexa/deployment-drain.flag"
test ! -e "$DRAIN" || { echo DEPLOYMENT_ALREADY_DRAINING; exit 10; }
install -d -m 700 "$BACKUP" "$(dirname "$DRAIN")"
python3 - "$DELTA" "$BACKUP" <<'PY'
import json,hashlib,pathlib,sys,os
p=pathlib.Path('/var/lib/capability-fabric/paa-remote/dexa-mvp')
d=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert d['schema']=='dexa.cf-catalog-r271-delta.v1'
a=p/'rana_capability_catalog.json'; b=p/'rana_cf_tool_schemas.json'
for name,f,sha in [('capability',a,d['base']['capability_sha256']),('schema',b,d['base']['schema_sha256'])]:
 assert hashlib.sha256(f.read_bytes()).hexdigest()==sha,(name,'BASELINE_CHANGED')
c=json.loads(a.read_text()); s=json.loads(b.read_text()); assert len(c)==291 and len(s['cf'])==187
for row in d['new_tools']:
 n=row['name'];assert n not in s['cf'] and all(x['capability_id']!=row['card']['capability_id'] for x in c)
 assert row['card']['fa_description'] and row['card']['en_description'] and row['card']['physical_tool_ids']==['CF.'+n]
 s['cf'][n]={'readOnly':row['readOnly'],'description':row['description'],'inputSchema':row['inputSchema']}
 c.append(row['card'])
for x in c:
 if x['capability_id']=='tool.cf.telegram_attachment_get':
  x['fa_description']=d['telegram_fa'];x['en_description']=d['telegram_description']
  s['cf']['telegram_attachment_get']['description']=d['telegram_description']
assert len(c)==297 and len(s['cf'])==193
assert len({x['capability_id'] for x in c})==297
assert {k for k in s['cf']}=={r[3:] for x in c for r in x['physical_tool_ids'] if r.startswith('CF.')}
for x in c: assert isinstance(x['fa_description'],str) and x['fa_description'].strip()
dest=pathlib.Path(sys.argv[2])
for f in [a,b]: (dest/f.name).write_bytes(f.read_bytes())
(dest/'candidate-catalog.json').write_text(json.dumps(c,ensure_ascii=False,separators=(',',':'))+'\n')
(dest/'candidate-schemas.json').write_text(json.dumps(s,ensure_ascii=False,separators=(',',':'))+'\n')
print('DEXA_CATALOG_CANDIDATE_297_CF193_VERIFIED')
PY
node --input-type=module -e "import fs from 'node:fs';for(const f of ['candidate-catalog.json','candidate-schemas.json']){JSON.parse(fs.readFileSync('$BACKUP/'+f,'utf8'))};console.log('DEXA_CANDIDATE_JSON_PASS')"
( set -C; printf 'Guarded r271 catalog refresh\n' > "$DRAIN" ) || exit 11
cleanup(){ rm -f "$DRAIN"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
i=0
while [ "$i" -lt 120 ]; do
 if curl -fsS --max-time 4 http://127.0.0.1:9471/healthz | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);process.exit(d.ok&&d.activeMissions===0&&d.deploymentDrain?.active===true?0:1)})'; then break; fi
 i=$((i+1)); sleep 2
done
[ "$i" -lt 120 ] || { echo DEXA_DRAIN_TIMEOUT; exit 12; }
prev="$(curl -fsS --max-time 5 http://127.0.0.1:9471/healthz | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).storedMissions))')"
cp "$BACKUP/candidate-catalog.json" rana_capability_catalog.json
cp "$BACKUP/candidate-schemas.json" rana_cf_tool_schemas.json
chmod 600 rana_capability_catalog.json rana_cf_tool_schemas.json
if ! ( systemctl --user restart dexa-catalog-gateway.service && systemctl --user restart dexa-main.service && node --input-type=module -e "import {catalogCounts} from './dexa_catalog_registry.mjs';let c=catalogCounts();if(c.catalog!==297||c.cfMapped!==193||c.internalCapabilities!==4)process.exit(2);console.log('CATALOG_ACTIVE',JSON.stringify(c))" && curl -fsS --max-time 6 http://127.0.0.1:9471/healthz | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let d=JSON.parse(s);if(!d.ok||d.activeMissions||d.storedMissions<Number(process.argv[1])||!d.deploymentDrain?.active)process.exit(2);console.log("DEXA_HEALTH_OK",d.storedMissions)})' "$prev" ); then
 cp "$BACKUP/rana_capability_catalog.json" rana_capability_catalog.json
 cp "$BACKUP/rana_cf_tool_schemas.json" rana_cf_tool_schemas.json
 systemctl --user restart dexa-catalog-gateway.service dexa-main.service || true
 echo DEPLOY_FAILED_ROLLED_BACK
 exit 13
fi
echo DEXA_CF_R271_CATALOG_LIVE_VERIFIED
