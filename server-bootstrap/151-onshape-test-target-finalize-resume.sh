#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

STATE=/var/lib/capability-fabric/state
ACTIVE=/opt/capability-fabric/current
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
expected_control=499a1372a0416d5f8d0bbcecbef39cee20373f5b
expected_manifest=f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9
closed_budget_id=epoch7-post-test-closed
closed_budget_key="$(printf '%s' "3:$closed_budget_id" | sha256sum | awk '{print $1}')"
closed_budget_dir="$AGENT_DIR/mutation-budgets/$closed_budget_key"

[[ "$(readlink -f "$ACTIVE")" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r4 ]]
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$expected_manifest" ]]
[[ "$(git hash-object "$CONTROL")" == "$expected_control" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$expected_control" ]]
[[ -f "$GATE" ]]
grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]
assert x["controlRevision"]==536 and a["productionEpoch"]==7
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED" and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["planes"]["vps-fabric"]["ingress"]=="ADMITTED" and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is True
assert a["planes"]["vps-fabric"]["releaseSequence"]==67
assert x["lease"]["state"]=="FREE"
assert g["generation"]==3 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"epoch7-post-test-closed","maxMutations":0}
print("CF_TARGET_RESUME_AUTHORITY=rev536-epoch7-closed")
PY

python3 - "$DB" <<'PY'
import json,sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True); c.row_factory=sqlite3.Row
matches=[]
for r in c.execute("select rowid, invocation_id, phase, payload, dispatch_payload from invocations order by rowid desc limit 40"):
    try: p=json.loads(r["payload"])
    except Exception: continue
    args=p.get("arguments") if isinstance(p,dict) else None
    if not isinstance(args,dict): continue
    if args.get("operationId")!="updateDocumentAttributes": continue
    pp=args.get("pathParams"); body=args.get("body")
    if not isinstance(pp,dict) or pp.get("did")!="881affea8ea63c33ae4e6c78": continue
    if not isinstance(body,dict) or body.get("name")!="CF-R4-TARGET-CLOSED-MUST-NOT-APPLY": continue
    matches.append(r)
assert len(matches)==1, len(matches)
r=matches[0]
assert r["phase"]=="ROUTED", r["phase"]
assert r["dispatch_payload"] is None
print("CF_TARGET_RESUME_CLOSED_NEGATIVE_INVOCATION="+r["invocation_id"])
print("CF_TARGET_RESUME_CLOSED_NEGATIVE_PHASE=ROUTED")
print("CF_TARGET_RESUME_CLOSED_NEGATIVE_NO_DISPATCH=pass")
assert c.execute("pragma integrity_check").fetchone()[0]=="ok"
print("CF_TARGET_RESUME_SQLITE_INTEGRITY=ok")
c.close()
PY

if [[ -d "$closed_budget_dir" ]]; then
  n="$(find "$closed_budget_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
else
  n=0
fi
[[ "$n" == 0 ]]
echo CF_TARGET_RESUME_CLOSED_BUDGET_RESERVATIONS=0

exec 9>"$LOCK"
flock -w 30 9 || exit 21
echo CF_TARGET_RESUME_PULL_LOCK=held

finalized=no
window_open=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finalized" != yes ]]; then
    if [[ "$window_open" == yes || ! -f "$GATE" ]]; then
      tmp="$GATE.tmp.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
    fi
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    echo CF_TARGET_RESUME_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"; window_open=yes
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 22; fi
echo CF_TARGET_RESUME_LOCAL_WINDOW=open

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-target-final-resume",version:"1"});
const tr=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(tr);
const parse=(res)=>JSON.parse((res.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const pool=parse(await client.callTool({name:"onshape_pool_status",arguments:{}}));
if(pool.pool_enabled!==true||pool.size!==3||pool.active_count!==0||pool.queued_count!==0||pool.document_lock_count!==0) throw new Error("pool not idle");
for(const s of pool.sessions||[]) if(s?.auth?.state!=="PROVEN") throw new Error("session not proven");
console.log("CF_TARGET_RESUME_POOL=3-of-3-PROVEN-idle");
const x=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
 capability_id:"onshape.documented.operation",
 arguments:{operationId:"getDocument",pathParams:{did:"881affea8ea63c33ae4e6c78"},query:{}}
}}));
const r=x.result,e=r.observation.evidence,b=e.body;
if(r.outcome.state!=="ACHIEVED"||e.effectSent!==false||b.name!=="CF-R4-TARGET-TEST-B"||b.defaultWorkspace.id!=="7b1e64a5ce7f95e660a9a5f2") throw new Error("final readback mismatch");
console.log("CF_TARGET_RESUME_FINAL_NAME="+b.name);
console.log("CF_TARGET_RESUME_READ_EFFECT_SENT=false");
await client.close();
NODE
)"
printf '%s\n' "$node_out"

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR=true'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_PONR_COUNT=4'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_TARGET_RESUME_SAFETY=pass

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]
[[ ! -e "$GATE" ]]
finalized=yes
window_open=no
trap - EXIT
echo CF_TARGET_RESUME_RELEASE_GATE=clear
echo CF_TARGET_RESUME_PULL_TIMER=active
echo CF_TARGET_RESUME_GATEWAY=running
echo CF_TARGET_RESUME=pass
