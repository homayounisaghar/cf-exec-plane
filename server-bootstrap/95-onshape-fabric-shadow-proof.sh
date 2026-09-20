#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
container=capability-fabric-onshape-server
sidecar=capability-fabric-onshape-fabric
docker inspect "$container" >/dev/null 2>&1
docker inspect "$sidecar" >/dev/null 2>&1
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$sidecar")" == true ]]

tmp="$(mktemp -d /var/lib/capability-fabric/.fabric-shadow-proof.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/node.out"

set +e
docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' >"$out" <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("invalid MCP token");
const endpoint = new URL("http://127.0.0.1:8787/mcp/" + token);
const client = new Client({ name: "cf-fabric-shadow-proof", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function payload(result) {
  const item = result?.content?.find((x) => x?.type === "text");
  assert(item && typeof item.text === "string", "missing MCP text result");
  const value = JSON.parse(item.text);
  if (value?.status === "FAILED") {
    throw new Error("tool failed: " + String(value?.error?.code || value?.error?.message || "unknown"));
  }
  return value;
}
async function call(name, args = {}) {
  return payload(await client.callTool({ name, arguments: args }));
}
async function pollOperation(operationId, limit = 180) {
  for (let i = 0; i < limit; i++) {
    const state = await call("onshape_operation_status", { operation_id: operationId });
    if (state.status === "SUCCEEDED") return state.result;
    if (state.status === "FAILED") throw new Error("operation failed: " + String(state?.error?.code || "unknown"));
    if (state.status === "AWAITING_INPUT") throw new Error("unexpected interactive input");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("operation timeout");
}
function resultOf(wrapper) {
  assert(wrapper?.public_surface === "shadow", "semantic tool is not on shadow surface");
  assert(wrapper?.qualification_only === true || wrapper?.result, "semantic wrapper malformed");
  return wrapper.result;
}
function idsOf(result) {
  for (const key of ["invocationId", "operationId", "attemptId"]) {
    assert(typeof result?.[key] === "string" && result[key].length > 8, "missing provenance " + key);
  }
  return {
    invocationId: result.invocationId,
    operationId: result.operationId,
    attemptId: result.attemptId,
  };
}
function agentRecordPath(attemptId) {
  const name = crypto.createHash("sha256").update(attemptId).digest("hex") + ".json";
  return "/agent-state/" + name;
}
function fileHash(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}
async function rawGetDocument(did) {
  const r = await call("onshape_request", { method: "GET", path: "/api/documents/" + did });
  assert(r.ok === true && r.http >= 200 && r.http < 300, "raw verification read failed");
  return r.body;
}

let did = null;
let cleanupOk = true;
const proof = {};
try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = new Set((listed?.tools || []).map((x) => x.name));
  for (const required of [
    "onshape_fabric_capabilities",
    "onshape_fabric_invoke",
    "onshape_fabric_reconcile",
    "onshape_documents_create",
    "onshape_operation_status",
    "onshape_request",
  ]) assert(names.has(required), "missing shadow tool " + required);
  console.log("CF_FABRIC_SHADOW_TOOL_CATALOG=pass");

  let session = await call("onshape_session_status");
  if (session?.auth?.state !== "PROVEN") {
    const login = await call("onshape_login_start");
    await pollOperation(login.operation_id, 240);
    session = await call("onshape_session_status");
  }
  assert(session?.auth?.state === "PROVEN" && session?.auth?.http_status === 200, "server session not PROVEN");
  console.log("CF_FABRIC_SHADOW_AUTH=pass");

  const caps = await call("onshape_fabric_capabilities");
  assert(caps.public_surface === "shadow" && caps.qualification_only === true, "capability surface not shadow");
  const capIds = new Set((caps.capabilities || []).map((x) => x.id));
  for (const id of ["onshape.session.status", "onshape.openapi.lookup", "onshape.documented.operation"]) {
    assert(capIds.has(id), "missing semantic capability " + id);
  }
  console.log("CF_FABRIC_SHADOW_CAPABILITIES=pass");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const created = await call("onshape_documents_create", {
    name: "CF Fabric shadow proof " + stamp,
    owner_scope: "personal",
  });
  const createdResult = await pollOperation(created.operation_id);
  did = createdResult?.documentId || null;
  assert(/^[0-9a-f]{24}$/i.test(did || ""), "fixture document id missing");
  console.log("CF_FABRIC_SHADOW_FIXTURE=pass");

  const readWrap = await call("onshape_fabric_invoke", {
    capability_id: "onshape.documented.operation",
    arguments: { operationId: "getDocument", pathParams: { did } },
  });
  const readResult = resultOf(readWrap);
  proof.read = idsOf(readResult);
  assert(readResult.outcome?.state === "ACHIEVED", "semantic read outcome not ACHIEVED");
  assert(readResult.observation?.ackState === "ACKNOWLEDGED", "semantic read not acknowledged");
  assert(readResult.observation?.evidence?.httpStatus >= 200 && readResult.observation?.evidence?.httpStatus < 300, "semantic read HTTP not successful");
  assert(readResult.observation?.evidence?.body?.id === did, "semantic read returned wrong document");
  assert(readResult.realization?.id === "onshape.session_bridge.vps.v45", "unexpected semantic realization");
  console.log("CF_FABRIC_SHADOW_READ_ONLY=pass");
  console.log("CF_FABRIC_SHADOW_PROVENANCE_IDS=pass");

  const verifiedName = "CF Fabric verified " + stamp;
  const mutationWrap = await call("onshape_fabric_invoke", {
    capability_id: "onshape.documented.operation",
    arguments: {
      operationId: "updateDocumentAttributes",
      pathParams: { did },
      body: { name: verifiedName },
      verification: { kind: "document_name_equals", value: verifiedName },
    },
  });
  const mutationResult = resultOf(mutationWrap);
  proof.mutation = idsOf(mutationResult);
  assert(mutationResult.outcome?.state === "ACHIEVED", "verified mutation outcome not ACHIEVED");
  assert(mutationResult.observation?.ackState === "ACKNOWLEDGED", "verified mutation not acknowledged");
  assert(mutationResult.observation?.evidence?.postconditionVerified === true, "independent mutation readback missing");
  const afterMutation = await rawGetDocument(did);
  assert(afterMutation?.name === verifiedName, "independent raw readback name mismatch");
  console.log("CF_FABRIC_SHADOW_GUARDED_MUTATION=pass");
  console.log("CF_FABRIC_SHADOW_INDEPENDENT_READBACK=pass");

  const ackLossName = "CF Fabric ack loss " + stamp;
  const ackResponse = await fetch("http://127.0.0.1:8791/v1/qualification/invoke-ack-loss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capabilityId: "onshape.documented.operation",
      arguments: {
        operationId: "updateDocumentAttributes",
        pathParams: { did },
        body: { name: ackLossName },
        verification: { kind: "document_name_equals", value: ackLossName },
      },
    }),
  });
  const ackEnvelope = await ackResponse.json();
  assert(ackResponse.ok && ackEnvelope?.ok === true, "ack-loss qualification endpoint failed");
  const lost = ackEnvelope.result;
  proof.ackloss = idsOf(lost);
  assert(lost.outcome?.state === "IN_DOUBT", "ack-loss did not produce IN_DOUBT");
  assert(lost.observation?.ackState === "UNKNOWN", "ack-loss did not hide acknowledgement");
  const recordPath = agentRecordPath(lost.attemptId);
  assert(fs.existsSync(recordPath), "agent Attempt record missing");
  const beforeHash = fileHash(recordPath);

  const reconcileWrap = await call("onshape_fabric_reconcile", { attempt_id: lost.attemptId });
  const reconciled = reconcileWrap.result;
  assert(reconcileWrap.public_surface === "shadow", "reconcile not on shadow surface");
  assert(reconciled?.attemptId === lost.attemptId, "reconcile changed Attempt identity");
  assert(reconciled?.sameAttempt === true && reconciled?.reexecuted === false, "reconcile replayed or changed Attempt");
  assert(reconciled?.outcome?.state === "ACHIEVED", "same-Attempt reconcile did not close ACHIEVED");
  const afterHash = fileHash(recordPath);
  assert(beforeHash === afterHash, "agent Attempt record changed during reconcile; possible replay");
  const afterAckLoss = await rawGetDocument(did);
  assert(afterAckLoss?.name === ackLossName, "ack-loss mutation postcondition absent after reconcile");
  console.log("CF_FABRIC_SHADOW_ACK_LOSS_IN_DOUBT=pass");
  console.log("CF_FABRIC_SHADOW_SAME_ATTEMPT_RECONCILE=pass");
  console.log("CF_FABRIC_SHADOW_NO_REPLAY=pass");

  console.log("CF_FABRIC_PROOF_IDS=" + Buffer.from(JSON.stringify(proof)).toString("base64url"));
} finally {
  if (did) {
    try {
      const removed = await call("onshape_request", {
        method: "DELETE",
        path: "/api/documents/" + did,
        query: { forever: true },
      });
      cleanupOk = !!(removed?.ok && removed?.http >= 200 && removed?.http < 300);
    } catch {
      cleanupOk = false;
    }
  }
  try { await client.close(); } catch {}
  console.log("CF_FABRIC_SHADOW_CLEANUP=" + (cleanupOk ? "pass" : "fail"));
}
assert(cleanupOk, "disposable document cleanup failed");
NODE
node_rc=$?
set -e

cat "$out"
if (( node_rc != 0 )); then
  echo CF_FABRIC_SHADOW_NODE_RC="$node_rc"
  echo CF_FABRIC_SHADOW_SIDECAR_LOG_BEGIN
  docker logs --tail 160 "$sidecar" 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
  echo CF_FABRIC_SHADOW_SIDECAR_LOG_END
  exit "$node_rc"
fi
encoded="$(sed -n 's/^CF_FABRIC_PROOF_IDS=//p' "$out" | tail -n1)"
[[ -n "$encoded" ]] || { echo "missing proof provenance ids" >&2; exit 40; }

docker exec -i "$sidecar" python - "$encoded" <<'PY'
import base64, json, sqlite3, sys
s=sys.argv[1]
s += "=" * ((4 - len(s) % 4) % 4)
proof=json.loads(base64.urlsafe_b64decode(s.encode()).decode())
db=sqlite3.connect("/fabric-state/execution.sqlite3")
db.row_factory=sqlite3.Row

for label, ids in proof.items():
    inv=db.execute(
        "SELECT phase,admission_payload,route_payload,dispatch_payload FROM invocations WHERE invocation_id=?",
        (ids["invocationId"],),
    ).fetchone()
    op=db.execute(
        "SELECT invocation_id,state,outcome_payload FROM operations WHERE operation_id=?",
        (ids["operationId"],),
    ).fetchone()
    att=db.execute(
        "SELECT operation_id,state,observation_payload FROM attempts WHERE attempt_id=?",
        (ids["attemptId"],),
    ).fetchone()
    assert inv is not None, (label,"invocation missing")
    assert op is not None and op["invocation_id"] == ids["invocationId"], (label,"operation link")
    assert att is not None and att["operation_id"] == ids["operationId"], (label,"attempt link")
    assert inv["admission_payload"] is not None and inv["route_payload"] is not None and inv["dispatch_payload"] is not None, (label,"provenance payload missing")
    assert att["observation_payload"] is not None, (label,"observation not durable")
    assert op["outcome_payload"] is not None, (label,"terminal outcome not durable")
    kinds={r["kind"] for r in db.execute(
        "SELECT kind FROM events WHERE entity_id IN (?,?,?)",
        (ids["invocationId"],ids["operationId"],ids["attemptId"]),
    )}
    assert "state.dispatch_intent.persisted" in kinds, (label,"dispatch intent event missing")
    assert "state.operation.reconciled" in kinds, (label,"reconciliation event missing")
print("CF_FABRIC_SHADOW_DURABLE_PROVENANCE=pass")
print("CF_FABRIC_SHADOW_SQLITE_LINKAGE=pass")
PY

echo CF_FABRIC_SHADOW_PROOF=pass
