#!/usr/bin/env bash
set -euo pipefail
umask 077
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
echo "CF_R9_DIAG_ACTIVE=$(basename "$(readlink -f "$ACTIVE" 2>/dev/null || true)")"
echo "CF_R9_DIAG_PREVIOUS=$(basename "$(readlink -f "$PREVIOUS" 2>/dev/null || true)")"
for f in last-good-sequence last-good-release last-failed-commit; do
  echo "CF_R9_DIAG_${f//-/_}=$(cat "$STATE/$f" 2>/dev/null || true)"
done
echo "CF_R9_DIAG_GATE=$(cat "$GATE" 2>/dev/null || echo absent)"
echo "CF_R9_DIAG_TIMER=$(systemctl is-active capability-fabric-pull.timer 2>/dev/null || true)"
echo "CF_R9_DIAG_SERVICE=$(systemctl is-active capability-fabric-pull.service 2>/dev/null || true)"
echo "CF_R9_DIAG_CONTROL_BLOB=$(git hash-object "$CONTROL" 2>/dev/null || true)"
python3 - "$CONTROL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("CF_R9_DIAG_CONTROL="+json.dumps({
 "controlRevision":d.get("controlRevision"),
 "epoch":d.get("authority",{}).get("productionEpoch"),
 "mode":d.get("authority",{}).get("mode"),
 "materialAuthority":d.get("authority",{}).get("materialAuthority"),
 "vps":d.get("authority",{}).get("planes",{}).get("vps-fabric"),
 "guard":d.get("authority",{}).get("productionGuard"),
 "lease":d.get("lease",{}).get("state"),
},separators=(",",":"),sort_keys=True))
PY
for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  if docker inspect "$c" >/dev/null 2>&1; then
    echo "CF_R9_DIAG_CONTAINER_${c}=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c")"
  else
    echo "CF_R9_DIAG_CONTAINER_${c}=absent"
  fi
done
active="$(readlink -f "$ACTIVE" 2>/dev/null || true)"
if [[ -n "$active" && -s "$active/manifest.json" ]]; then
  echo "CF_R9_DIAG_ACTIVE_MANIFEST_SHA=$(sha256sum "$active/manifest.json"|awk '{print $1}')"
  python3 - "$active/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
print("CF_R9_DIAG_ACTIVE_MANIFEST="+json.dumps({"sequence":m.get("sequence"),"release_id":m.get("release_id")},separators=(",",":")))
PY
fi
if [[ "$(docker inspect -f '{{.State.Running}}' capability-fabric-onshape-server 2>/dev/null || echo false)" == true ]]; then
docker exec -i capability-fabric-onshape-server sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r9-diag",version:"1.0"});
try{
 await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
 const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
 const p=parse(await c.callTool({name:"onshape_pool_status",arguments:{}},undefined,{timeout:180000}));
 console.log("CF_R9_DIAG_POOL="+JSON.stringify(p));
} catch(e){ console.log("CF_R9_DIAG_POOL_ERROR="+String(e?.message||e)); }
finally{ await c.close().catch(()=>{}); }
NODE
fi
echo CF_R9_DIAG_DONE
