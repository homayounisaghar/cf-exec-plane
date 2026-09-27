#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
LOCK=/run/lock/capability-fabric-pull.lock
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
FABRIC=capability-fabric-onshape-fabric
RESEARCH=capability-fabric-onshape-phase0-research
RESEARCH_FABRIC=capability-fabric-onshape-phase0-fabric
PROD_DB=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
RESEARCH_ROOT=/var/lib/capability-fabric/onshape-research-phase0
QUARANTINE=/var/lib/capability-fabric/onshape/fabric-state/quarantine/D-018-attempt-f6d80f46.json
ROLLBACK_GUARD=/usr/local/libexec/capability-fabric-onshape-rollback-contract

EXPECTED_CONTROL=1b9c248d8b57385a86c5c157bf99ef4f1f6928ce
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c
FIXTURE=a19e0fa5152af9f7ce106b6e:e5e7d0173fd1f1d0307a2cb6:e0929361aadb6135b5cecffa

release="$(readlink -f "$ACTIVE")"
[[ "$release" == /var/lib/capability-fabric/releases/onshape-vps-hardened-production-r8 ]]
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]]
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]]
[[ ! -s "$STATE/last-failed-commit" ]]
[[ "$(sha256sum "$release/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]]
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$EXPECTED_CONTROL" ]]
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null || echo false)" == false ]]

for c in "$SERVER" "$FABRIC" "$RESEARCH" "$RESEARCH_FABRIC"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]]
  h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c")"
  [[ "$h" == healthy ]]
done

python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==556 and a["productionEpoch"]==27
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==73 and v["releaseId"]=="onshape-vps-hardened-production-r8"
assert v["manifestSha256"]=="08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c"
assert a["planes"]["android-v1"]["ingress"]=="CLOSED"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is False
assert a["reconciliationHold"]["active"] is False
assert x["lease"]["state"]=="FREE"
assert g["generation"]==11 and g["killSwitch"]=="ENGAGED"
assert g["allowedDocumentIds"]==[]
assert g["mutationBudget"]=={"budgetId":"e9-mate-durability-complete-closed","maxMutations":0}
print("CF_INGRESS_RESTORE_AUTHORITY=rev556-epoch27-seq73-r8")
print("CF_INGRESS_RESTORE_GUARD=engaged-empty-zero")
PY

research_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$RESEARCH")"
research_candidate="$(awk -F= '$1=="CF_RESEARCH_SOURCE_COMMIT"{print $2}' <<<"$research_env" | tail -1)"
[[ "$research_candidate" =~ ^[0-9a-f]{40}$ ]]
grep -Fxq "CF_RESEARCH_FIXTURE_TARGET=$FIXTURE" <<<"$research_env"
research_release="$RESEARCH_ROOT/releases/$research_candidate"
[[ -d "$research_release" ]]
PYTHONPATH="$research_release/server-deploy/current/fabric-src" python3 - <<'PY'
from capability_fabric.persistence import SqliteExecutionStateStore
p="/var/lib/capability-fabric/onshape-research-phase0/fabric-state/execution.sqlite3"
with SqliteExecutionStateStore(p) as s:
    assert not s.recoverable()
print("CF_INGRESS_RESTORE_RESEARCH_RECOVERABLE=zero")
PY
echo "CF_INGRESS_RESTORE_RESEARCH_CANDIDATE=$research_candidate"
echo CF_INGRESS_RESTORE_RESEARCH_BINDING=pass

ponr="$("$ROLLBACK_GUARD" decide --db "$PROD_DB" --control "$CONTROL" --quarantine "$QUARANTINE")"
printf '%s\n' "$ponr"
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_UNRESOLVED_BLOCKING=0'
printf '%s\n' "$ponr" | grep -Fxq 'CF_A4_ZERO_UNRESOLVED=pass'

exec 9>"$LOCK"
flock -w 30 9 || exit 21

finalized=no
cleanup(){
  rc=$?
  set +e
  if [[ "$finalized" != yes ]]; then
    if [[ ! -e "$GATE" ]]; then
      tmp="$GATE.tmp.ingress.$$"
      printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
      chmod 0600 "$tmp"
      chown root:root "$tmp"
      mv -f "$tmp" "$GATE"
    fi
    systemctl stop "$TIMER" >/dev/null 2>&1 || true
    docker stop "$GATEWAY" >/dev/null 2>&1 || true
    echo CF_INGRESS_RESTORE_FAIL_CLOSED=retained
  fi
  exit "$rc"
}
trap cleanup EXIT

rm -f "$GATE"
[[ ! -e "$GATE" ]]

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-ingress-restore-preflight",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
try {
  const names=(await c.listTools()).tools.map(x=>x.name).sort();
  const expected=["cf_echo","onshape_fabric_capabilities","onshape_fabric_invoke","onshape_fabric_reconcile","onshape_pool_status","onshape_pool_session_reauth","onshape_verification_submit","onshape_operation_status","telegram_conversation_list"].sort();
  for(const n of expected) if(!names.includes(n)) throw new Error("missing tool "+n);
  for(const n of ["onshape_ui_native","onshape_ui_input","onshape_request","onshape_artifact","onshape_documents_create"]) if(names.includes(n)) throw new Error("forbidden production tool "+n);

  const echo=parse(await c.callTool({name:"cf_echo",arguments:{text:"ingress-restore-preflight"}}));
  if(echo?.echo!=="ingress-restore-preflight"||echo?.public_surface!=="semantic-only") throw new Error("echo");

  const caps=parse(await c.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
  if(caps?.public_surface!=="semantic-only"||caps?.qualification_only!==false) throw new Error("caps surface");
  const ids=(caps?.capabilities||[]).map(x=>x?.id);
  if(ids.includes("onshape.ui.native")||ids.includes("onshape.ui.input.sequence")) throw new Error("research UI leaked");

  const pool=parse(await c.callTool({name:"onshape_pool_status",arguments:{}}));
  if(pool?.size!==3||pool?.active_count!==0||pool?.queued_count!==0||pool?.document_lock_count!==0) throw new Error("pool shape");
  const states=(pool?.sessions||[]).map(x=>({session_id:x.session_id,state:x?.auth?.state??null,http:x?.auth?.http_status??null}));
  console.log("CF_INGRESS_RESTORE_PROD_POOL="+JSON.stringify({enabled:pool.pool_enabled,states}));

  console.log("CF_INGRESS_RESTORE_LOCAL_ECHO=pass");
  console.log("CF_INGRESS_RESTORE_LOCAL_CAPS=semantic-only");
} finally { await c.close().catch(()=>{}); }
NODE

systemctl start "$TIMER"
systemctl is-active --quiet "$TIMER"
docker start "$GATEWAY" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == true ]]

for i in $(seq 1 30); do
  body="$(curl -fsS --max-time 2 http://127.0.0.1:8787/ 2>/dev/null || true)"
  [[ "$body" == "cf-onshape-single ok" ]] && break
  sleep 1
done
[[ "$(curl -fsS --max-time 2 http://127.0.0.1:8787/)" == "cf-onshape-single ok" ]]

docker exec -i "$GATEWAY" sh -lc 'cd /app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-ingress-restore-gateway",version:"1.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp/"+token)));
const parse=r=>JSON.parse((r.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
try {
  const echo=parse(await c.callTool({name:"cf_echo",arguments:{text:"ingress-restore-gateway"}}));
  if(echo?.echo!=="ingress-restore-gateway"||echo?.public_surface!=="semantic-only") throw new Error("gateway echo");
  console.log("CF_INGRESS_RESTORE_GATEWAY_ECHO=pass");
} finally { await c.close().catch(()=>{}); }
NODE

token="$(tr -d '\r\n' </etc/capability-fabric/secrets/mcp-token)"
code="$(curl -sS --max-time 10 --resolve cf-onshape.duckdns.org:443:127.0.0.1   -o /tmp/cf-ingress-caddy.out -w '%{http_code}'   -H 'content-type: application/json' -H 'accept: application/json, text/event-stream'   --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'   "https://cf-onshape.duckdns.org/mcp/$token" || true)"
[[ "$code" == 200 ]]
grep -Eq 'cf_echo|event: message|jsonrpc' /tmp/cf-ingress-caddy.out
rm -f /tmp/cf-ingress-caddy.out
echo CF_INGRESS_RESTORE_CADDY_MCP=pass

[[ ! -e "$GATE" ]]
finalized=yes
trap - EXIT
echo CF_INGRESS_RESTORE_RELEASE_GATE=clear
echo CF_INGRESS_RESTORE_PULL_TIMER=active
echo CF_INGRESS_RESTORE_GATEWAY=running
echo CF_INGRESS_RESTORE=pass
