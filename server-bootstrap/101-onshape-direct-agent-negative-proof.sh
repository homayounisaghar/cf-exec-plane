#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_DIRECT_AGENT_PROOF_REQUIRES_ROOT" >&2; exit 2; }

token_file=/etc/capability-fabric/secrets/mcp-token
[[ -s "$token_file" ]] || { echo "CF_DIRECT_AGENT_TOKEN_MISSING" >&2; exit 20; }
token="$(tr -d '\r\n' < "$token_file")"
[[ "$token" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { echo "CF_DIRECT_AGENT_TOKEN_INVALID" >&2; exit 20; }

internal_key="$(python3 - "$token" <<'PY'
import hashlib,sys
print(hashlib.sha256(("fabric-agent:"+sys.argv[1]).encode()).hexdigest())
PY
)"
attempt_id=attempt:direct-agent-no-persisted-dispatch-v1
operation_id=operation:direct-agent-no-persisted-dispatch-v1
digest=sha256:direct-agent-no-persisted-dispatch-v1

payload="$(python3 - "$attempt_id" "$operation_id" "$digest" <<'PY'
import json,sys
attempt_id,operation_id,digest=sys.argv[1:]
dispatch={
  "invocationId":"invocation:direct-agent-no-persisted-dispatch-v1",
  "operationId":operation_id,
  "attemptId":attempt_id,
  "dispatchSnapshotDigest":digest,
  "realizationId":"onshape.session_bridge.vps.v45",
  "realizationRevision":"v45-pool",
  "deploymentId":"deployment:vps",
  "connectionId":"connection:vps",
  "effect":"onshape.documented.operation.mutation",
  "targetId":"onshape:document:0123456789abcdef01234567",
  "payload":{
    "operation":"onshape.documented.operation",
    "agentEffect":"MUTATION",
    "args":{
      "operationId":"updateDocumentAttributes",
      "method":"POST",
      "pathTemplate":"/documents/{did}",
      "pathParams":{"did":"0123456789abcdef01234567"},
      "query":{},
      "headers":{},
      "body":{"name":"MUST-NOT-EXECUTE-DIRECT-AGENT-PROOF"}
    },
    "preconditions":{}
  }
}
print(json.dumps({"action":"execute","dispatch":dispatch},separators=(",",":")))
PY
)"

response="$(curl -fsS --max-time 10   -H 'content-type: application/json'   --data-binary "$payload"   "http://127.0.0.1:8789/internal/fabric/$internal_key")"

python3 - "$response" "$attempt_id" <<'PY'
import json,sys
value=json.loads(sys.argv[1])
attempt=sys.argv[2]
if value.get("ok") is not True:
    raise SystemExit("internal adapter did not return ok")
result=value.get("result") or {}
if result.get("attemptId") != attempt:
    raise SystemExit("attempt identity mismatch")
if result.get("state") != "REJECTED":
    raise SystemExit("fabricated direct agent dispatch was not rejected")
evidence=result.get("evidence") or {}
if evidence.get("effectSent") is not False:
    raise SystemExit("direct agent proof did not establish effectSent=false")
detail=str(result.get("detail") or "")
if "FABRIC_DISPATCH_NOT_ATTESTED" not in detail:
    raise SystemExit("rejection was not caused by missing persisted Fabric Dispatch attestation")
print("CF_DIRECT_AGENT_NO_PERSISTED_DISPATCH=pass")
print("CF_DIRECT_AGENT_EFFECT_SENT=false")
print("CF_DIRECT_AGENT_REJECTION=FABRIC_DISPATCH_NOT_ATTESTED")
print("CF_DIRECT_AGENT_ATTEMPT="+attempt)
PY
