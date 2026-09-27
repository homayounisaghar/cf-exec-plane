#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate="c0cadee962c2059ba939c40c6bb9adf1bc99edfe"
root="/var/lib/capability-fabric/onshape-research-phase0"
db="$root/fabric-state/execution.sqlite3"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"

python3 - "$control" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_RECENTDIAG_BOUNDARY=pass")
PY

python3 - "$db" <<'PY'
import json,sqlite3,sys
db=sys.argv[1]
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True); con.row_factory=sqlite3.Row
for t in ["invocations","operations","attempts"]:
    cols=[r["name"] for r in con.execute(f"pragma table_info({t})")]
    print("CF_PHASE0_RECENTDIAG_SCHEMA_"+t.upper()+"="+json.dumps(cols))
rows=con.execute("""
SELECT a.rowid ar,i.rowid ir,o.rowid orow,
       i.payload ip,o.payload op,o.state os,o.outcome_payload out,
       a.payload ap,a.state ast,a.observation_payload ob
FROM attempts a
JOIN operations o ON o.operation_id=a.operation_id
JOIN invocations i ON i.invocation_id=o.invocation_id
ORDER BY a.rowid DESC LIMIT 20
""").fetchall()
out=[]
for r in rows:
    inv=json.loads(r["ip"]); op=json.loads(r["op"]); att=json.loads(r["ap"])
    obs=json.loads(r["ob"]) if r["ob"] else None
    oc=json.loads(r["out"]) if r["out"] else None
    args=inv.get("arguments") or {}
    out.append({
      "attempt_id":att.get("attempt_id"),"operation_id":op.get("operation_id"),
      "requirement_id":inv.get("requirement_id"),"action":args.get("action"),
      "steps":args.get("steps"),"operation_state":r["os"],"attempt_state":r["ast"],
      "ack_state":(obs or {}).get("ack_state"),"detail":(obs or {}).get("detail"),
      "evidence":(obs or {}).get("evidence"),"outcome":oc
    })
print("CF_PHASE0_RECENTDIAG_ROWS="+json.dumps(out,separators=(",",":"),sort_keys=True))
inputs=[]
for x in out:
    if x.get("requirement_id")=="requirement:onshape.ui.input":
        ev=x.get("evidence") or {}
        inputs.append({
          "attempt_id":x.get("attempt_id"),
          "operation_id":x.get("operation_id"),
          "operation_state":x.get("operation_state"),
          "attempt_state":x.get("attempt_state"),
          "ack_state":x.get("ack_state"),
          "detail":x.get("detail"),
          "steps":x.get("steps"),
          "sequenceCompleted":ev.get("sequenceCompleted"),
          "completedSteps":ev.get("completedSteps"),
          "effectSent":ev.get("effectSent"),
          "finalUrl":ev.get("finalUrl"),
          "outcome_state":(x.get("outcome") or {}).get("state")
        })
print("CF_PHASE0_RECENTDIAG_INPUT_ROWS="+json.dumps(inputs,separators=(",",":"),sort_keys=True))
con.close()
PY
research=capability-fabric-onshape-phase0-research
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
[[ "$(docker inspect -f '{{.State.Running}}' "$research" 2>/dev/null || echo false)" == true ]]
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$research")" == healthy ]]
env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$research")"
actual_candidate="$(awk -F= '$1=="CF_RESEARCH_SOURCE_COMMIT"{print $2}' <<<"$env_dump" | tail -1)"
[[ -n "$actual_candidate" ]]
echo CF_PHASE0_RECENTDIAG_SESSION_CANDIDATE="$actual_candidate"
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$env_dump"
echo CF_PHASE0_RECENTDIAG_SESSION_BINDING=pass

docker exec -i "$research" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-phase0-recentdiag-session",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8898/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
try {
  const status=parse(await c.callTool({name:"onshape_session_status",arguments:{}},undefined,{timeout:180000}));
  console.log("CF_PHASE0_RECENTDIAG_SESSION_STATUS="+JSON.stringify({
    build_id:status?.build_id??null,
    auth:status?.auth??null,
    url:status?.url??status?.session?.url??null
  }));
} finally {await c.close().catch(()=>{});}
NODE

echo CF_PHASE0_RECENTDIAG=pass
