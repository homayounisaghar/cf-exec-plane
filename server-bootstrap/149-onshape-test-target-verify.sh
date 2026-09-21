#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE=/var/lib/capability-fabric/state/release-in-progress
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
AGENT_DIR=/var/lib/capability-fabric/onshape/fabric-agent
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract
expected_blob=56fa3abbcfffaa7451f32a0707a569f865ab49bb
budget_id=epoch6-test-881affea-budget2
budget_key="$(printf '%s' "2:$budget_id" | sha256sum | awk '{print $1}')"
budget_dir="$AGENT_DIR/mutation-budgets/$budget_key"

[[ "$(git hash-object "$CONTROL")" == "$expected_blob" ]]
[[ -f "$GATE" ]]
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

python3 - "$budget_dir" "$DB" "$expected_blob" <<'PY'
import json,pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1]); db=sys.argv[2]; blob=sys.argv[3]
rows=[json.loads(p.read_text()) for p in root.glob("*.json")]
assert len(rows)==2, rows
rows.sort(key=lambda x:x["slot"])
assert [x["slot"] for x in rows]==[1,2]
for x in rows:
    assert x["schema"]=="capability-fabric.onshape-mutation-budget-reservation.v1"
    assert x["budgetId"]=="epoch6-test-881affea-budget2"
    assert x["guardGeneration"]==2 and x["maxMutations"]==2
    assert x["documentId"]=="881affea8ea63c33ae4e6c78"
    assert x["productionEpoch"]==6 and x["controlBlobSha"]==blob
print("CF_TARGET_VERIFY_BUDGET_RESERVATIONS=2")
print("CF_TARGET_VERIFY_BUDGET_SLOTS=1,2")
c=sqlite3.connect(f"file:{db}?mode=ro",uri=True); c.row_factory=sqlite3.Row
for x in rows:
    r=c.execute("""
      select i.invocation_id,i.phase,o.operation_id,o.state,o.outcome_payload,
             a.attempt_id,a.state,a.observation_payload
      from attempts a join operations o on o.operation_id=a.operation_id
      join invocations i on i.invocation_id=o.invocation_id
      where a.attempt_id=?
    """,(x["attemptId"],)).fetchone()
    assert r is not None
    outcome=json.loads(r["outcome_payload"]) if r["outcome_payload"] else {}
    obs=json.loads(r["observation_payload"]) if r["observation_payload"] else {}
    assert r["operation_id"]==x["operationId"]
    assert outcome.get("state")=="ACHIEVED", outcome
    assert obs.get("ack_state")=="ACKNOWLEDGED", obs
    ev=obs.get("evidence") or {}
    assert ev.get("effectSent") is True
    assert ev.get("postconditionVerified") is True
    print("CF_TARGET_VERIFY_EFFECT="+json.dumps({
      "slot":x["slot"],"invocationId":r["invocation_id"],"operationId":r["operation_id"],
      "attemptId":r["attempt_id"],"outcome":outcome.get("state"),
      "ack":obs.get("ack_state"),"effectSent":ev.get("effectSent"),
      "postconditionVerified":ev.get("postconditionVerified"),
      "mutationSessionId":ev.get("mutationSessionId")
    },separators=(",",":")))

r=c.execute("""
  select i.invocation_id,i.phase,o.operation_id,o.state,o.outcome_payload,
         a.attempt_id,a.state,a.observation_payload
  from attempts a join operations o on o.operation_id=a.operation_id
  join invocations i on i.invocation_id=o.invocation_id
  where a.attempt_id=?
""",("attempt:12842e1f-5ecc-411f-80c4-ce30fd01f8c9",)).fetchone()
assert r is not None
outcome=json.loads(r["outcome_payload"]) if r["outcome_payload"] else {}
obs=json.loads(r["observation_payload"]) if r["observation_payload"] else {}
ev=obs.get("evidence") or {}
assert outcome.get("state")=="ABSENT", outcome
assert obs.get("ack_state")=="REJECTED", obs
assert ev.get("effectSent") is False
assert "FABRIC_GUARD_BUDGET_EXHAUSTED" in str(obs.get("detail") or "")
print("CF_TARGET_VERIFY_M3="+json.dumps({
 "invocationId":r["invocation_id"],"operationId":r["operation_id"],"attemptId":r["attempt_id"],
 "outcome":outcome.get("state"),"ack":obs.get("ack_state"),"effectSent":ev.get("effectSent"),
 "detail":obs.get("detail")
},separators=(",",":")))
assert c.execute("pragma integrity_check").fetchone()[0]=="ok"
print("CF_TARGET_VERIFY_SQLITE_INTEGRITY=ok")
c.close()
PY

exec 9>"$LOCK"
flock -w 30 9 || exit 21
window_open=no
cleanup(){
  rc=$?
  set +e
  if [[ "$window_open" == yes ]]; then
    tmp="$GATE.tmp.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
  fi
  docker stop "$GATEWAY" >/dev/null 2>&1 || true
  systemctl stop "$TIMER" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
rm -f "$GATE"; window_open=yes
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

node_out="$(docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const client=new Client({name:"cf-target-posteffect-verify",version:"1"});
const tr=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token));
await client.connect(tr);
const parse=(res)=>JSON.parse((res.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n"));
const x=parse(await client.callTool({name:"onshape_fabric_invoke",arguments:{
 capability_id:"onshape.documented.operation",
 arguments:{operationId:"getDocument",pathParams:{did:"881affea8ea63c33ae4e6c78"},query:{}}
}}));
const r=x.result,e=r.observation.evidence,b=e.body;
if(r.outcome.state!=="ACHIEVED"||e.effectSent!==false||b.name!=="CF-R4-TARGET-TEST-B"||b.defaultWorkspace.id!=="7b1e64a5ce7f95e660a9a5f2") throw new Error("post-effect readback mismatch");
console.log("CF_TARGET_VERIFY_FINAL_NAME="+b.name);
console.log("CF_TARGET_VERIFY_READ_EFFECT_SENT=false");
await client.close();
NODE
)"
printf '%s\n' "$node_out"

tmp="$GATE.tmp.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
window_open=no

ponr="$("$ROLLBACK_GUARD" decide --db "$DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'
echo CF_TARGET_VERIFY_SAFETY=pass
echo CF_TARGET_VERIFY_GATE=active
echo CF_TARGET_VERIFY_TIMER=stopped
echo CF_TARGET_VERIFY_GATEWAY=stopped
echo CF_TARGET_VERIFY=pass
