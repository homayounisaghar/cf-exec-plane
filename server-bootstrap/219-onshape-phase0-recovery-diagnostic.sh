#!/usr/bin/env bash
set -euo pipefail

candidate="ae9bc114d84cfd7991cbdd38489b18d33a2d34bf"
fixture="a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa"
db="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
control="/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json"

python3 - "$control" <<'PY'
import json,sys
p=sys.argv[1]
d=json.load(open(p,encoding="utf-8"))
a=d["authority"]; g=a["productionGuard"]
assert a["mode"]=="VPS_PRODUCTION"
assert a["materialAuthority"]=="vps-fabric"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]["maxMutations"]==0
print("CF_PHASE0_RECOVERY_PRODUCTION_FAILCLOSED=pass")
print("CF_PHASE0_RECOVERY_CONTROL_REVISION="+str(d["controlRevision"]))
print("CF_PHASE0_RECOVERY_EPOCH="+str(a["productionEpoch"]))
PY

for c in capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
  running="$(docker inspect -f '{{.State.Running}}' "$c")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c")"
  [[ "$running" == true && "$health" == healthy ]]
done
echo "CF_PHASE0_RECOVERY_STACK=healthy"

server_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' capability-fabric-onshape-phase0-research)"
grep -qx "CF_RESEARCH_SOURCE_COMMIT=$candidate" <<<"$server_env"
grep -qx "CF_RESEARCH_FIXTURE_TARGET=$fixture" <<<"$server_env"
grep -qx 'CF_PUBLIC_SURFACE=shadow' <<<"$server_env"
grep -qx 'CF_FABRIC_REQUIRE_PRODUCTION_AUTHORITY=0' <<<"$server_env"
echo "CF_PHASE0_RECOVERY_BINDING=pass"

[[ -r "$db" ]]
python3 - "$db" <<'PY'
import json,sqlite3,sys
db=sys.argv[1]
con=sqlite3.connect(f"file:{db}?mode=ro", uri=True)
con.row_factory=sqlite3.Row
rows=con.execute("""
SELECT i.phase,i.payload AS invocation_payload,i.dispatch_payload,
       o.payload AS operation_payload,o.state AS operation_state,o.outcome_payload,
       a.payload AS attempt_payload,a.state AS attempt_state,a.observation_payload
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
ORDER BY i.rowid
""").fetchall()
print("CF_PHASE0_RECOVERY_COUNT="+str(len(rows)))
for n,row in enumerate(rows,1):
    inv=json.loads(row["invocation_payload"])
    op=json.loads(row["operation_payload"]) if row["operation_payload"] else None
    att=json.loads(row["attempt_payload"]) if row["attempt_payload"] else None
    obs=json.loads(row["observation_payload"]) if row["observation_payload"] else None
    args=inv.get("arguments") if isinstance(inv.get("arguments"),dict) else {}
    safe={
      "index":n,
      "phase":row["phase"],
      "requirementId":inv.get("requirement_id"),
      "effect":inv.get("effect"),
      "targetId":inv.get("target_id"),
      "action":args.get("action"),
      "operationId":op.get("operation_id") if op else None,
      "operationState":row["operation_state"],
      "attemptId":att.get("attempt_id") if att else None,
      "attemptState":row["attempt_state"],
      "observationAck":obs.get("ack_state") if obs else None,
      "observationDetail":obs.get("detail") if obs else None,
      "observationEvidence":({k:obs.get("evidence",{}).get(k) for k in [
        "effectSent","nativeCompleted","nativeAction","buildId","finalUrl"
      ]} if obs and isinstance(obs.get("evidence"),dict) else None),
      "hasTerminalOutcome":row["outcome_payload"] is not None,
    }
    print("CF_PHASE0_RECOVERY_CASE="+json.dumps(safe,separators=(",",":"),sort_keys=True))
con.close()
PY

echo "CF_PHASE0_RECOVERY_DIAGNOSTIC=pass"
