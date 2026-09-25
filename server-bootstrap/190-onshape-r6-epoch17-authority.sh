#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
MIRROR_BLOB=/var/lib/capability-fabric/onshape/runtime-control/git-blob-sha
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
PREV_CONTROL=022eef1b4e6234e525c25964487e282f2d3530df
TARGET_CONTROL=ca5c6d0562ea29e9ab26897a6b7fb137bfd1649d
EXPECTED_MANIFEST=e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "71" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(sha256sum "$(readlink -f "$ACTIVE")/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$PREV_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$PREV_CONTROL" ]]
[[ -f "$GATE" ]]
systemctl stop "$TIMER" || true
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_RUNTIME_CONTROL_MIRROR=updated'
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_NO_CHANGE'

[[ "$(git hash-object "$CONTROL")" == "$TARGET_CONTROL" ]]
[[ "$(tr -d '\r\n' < "$MIRROR_BLOB")" == "$TARGET_CONTROL" ]]
python3 - "$CONTROL" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); a=x["authority"]; g=a["productionGuard"]; v=a["planes"]["vps-fabric"]
assert x["controlRevision"]==546
assert a["productionEpoch"]==17 and a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert v["ingress"]=="ADMITTED" and v["materialEffectsAllowed"] is True
assert v["releaseSequence"]==71 and v["releaseId"]=="onshape-vps-hardened-production-r6"
assert v["manifestSha256"]=="e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f"
assert g["killSwitch"]=="ENGAGED" and g["allowedDocumentIds"]==[] and g["mutationBudget"]["maxMutations"]==0
assert x["lease"]["state"]=="FREE"
print("CF_R6_AUTH_AUTHORITY=epoch17-seq71-r6")
print("CF_R6_AUTH_GUARD=engaged-empty-zero")
PY

restore=yes
cleanup(){
 rc=$?
 set +e
 if [[ "$restore" == yes && ! -e "$GATE" ]]; then
  tmp="$GATE.tmp.r6auth.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
 fi
 exit "$rc"
}
trap cleanup EXIT
rm -f "$GATE"

docker exec -i "$SERVER" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token=fs.readFileSync("/run/secrets/mcp-token","utf8").trim();
const c=new Client({name:"cf-r6-auth-proof",version:"1.0.0"});
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8788/mcp/"+token)));
const parse=r=>JSON.parse((r?.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join("\n"));
const caps=parse(await c.callTool({name:"onshape_fabric_capabilities",arguments:{}}));
const pool=parse(await c.callTool({name:"onshape_pool_status",arguments:{}}));
console.log("CF_R6_AUTH_BUILD="+String(caps?.build_id));
console.log("CF_R6_AUTH_POOL="+JSON.stringify(pool));
await c.close();
NODE

tmp="$GATE.tmp.r6auth.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
restore=no
trap - EXIT
echo CF_R6_AUTH_GATE=active
echo CF_R6_AUTH=pass
