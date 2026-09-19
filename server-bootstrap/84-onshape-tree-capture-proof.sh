#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

token_file="/etc/capability-fabric/secrets/mcp-token"
[[ "$(stat -c '%a %U:%G' "$token_file")" == "600 root:root" ]] || { echo "unsafe MCP token permissions" >&2; exit 20; }
token="$(tr -d '[:space:]' < "$token_file")"
[[ "$token" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { echo "invalid MCP token state" >&2; exit 20; }
endpoint="http://127.0.0.1:8787/mcp/$token"

tmp="$(mktemp -d /root/.cf-onshape-tree-proof.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

mcp_post() {
  local payload="$1"
  curl -sS --fail-with-body --max-time 35     -H 'Content-Type: application/json'     -H 'Accept: application/json, text/event-stream'     -H 'MCP-Protocol-Version: 2025-06-18'     --data "$payload"     "$endpoint"
}

normalize_mcp() {
  python3 -c '
import json,sys
s=sys.stdin.read().strip()
if not s:
    raise SystemExit("empty MCP response")
if s.startswith("event:") or "\ndata:" in s or s.startswith("data:"):
    vals=[line[5:].strip() for line in s.splitlines() if line.startswith("data:")]
    if not vals:
        raise SystemExit("SSE response had no data line")
    s=vals[-1]
d=json.loads(s)
if d.get("error"):
    print(json.dumps({"mcp_error":d["error"]},separators=(",",":")))
    raise SystemExit(2)
for item in d.get("result",{}).get("content",[]):
    if item.get("type")=="text":
        try:
            print(json.dumps(json.loads(item.get("text","")),separators=(",",":")))
            raise SystemExit(0)
        except json.JSONDecodeError:
            pass
raise SystemExit("MCP response had no JSON text result")
'
}

start_payload='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"onshape_documents_inspect_ui","arguments":{"query":"View:TOP"}}}'
start_raw="$(mcp_post "$start_payload")"
start_inner="$(printf '%s' "$start_raw" | normalize_mcp)"
operation_id="$(printf '%s' "$start_inner" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("operation_id",""))')"
[[ "$operation_id" =~ ^op_[A-Za-z0-9-]+$ ]] || { echo "diagnostic tool did not return operation id" >&2; exit 21; }

for _ in $(seq 1 35); do
  status_payload="$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"onshape_operation_status","arguments":{"operation_id":sys.argv[1]}}},separators=(",",":")))' "$operation_id")"
  status_raw="$(mcp_post "$status_payload")"
  status_inner="$(printf '%s' "$status_raw" | normalize_mcp)"
  state="$(printf '%s' "$status_inner" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')"
  case "$state" in
    SUCCEEDED)
      printf '%s' "$status_inner" | python3 -c '
import json,sys
d=json.load(sys.stdin)
r=d.get("result") or {}
out={
 "build_id":d.get("build_id"),
 "status":d.get("status"),
 "capture":r.get("capture"),
 "page_snapshot":r.get("page_snapshot"),
 "cookie_metadata_without_values":r.get("cookie_metadata_without_values"),
 "resource_response_count":r.get("resource_response_count"),
 "resource_responses":r.get("resource_responses"),
 "xhr_fetch_count":r.get("xhr_fetch_count"),
 "xhr_fetch_traffic":r.get("xhr_fetch_traffic"),
 "target_response_count":r.get("target_response_count"),
 "target_responses":r.get("target_responses"),
 "failed_requests":r.get("failed_requests"),
 "page_errors":r.get("page_errors"),
 "console_errors":r.get("console_errors"),
 "websockets":r.get("websockets"),
 "handcrafted_request":r.get("handcrafted_request"),
 "comparison":r.get("comparison"),
 "target_folder_name":r.get("target_folder_name"),
 "storage_probe":r.get("storage_probe"),
}
print("CF_ONSHAPE_TREE_CAPTURE="+json.dumps(out,separators=(",",":")))
'
      exit 0
      ;;
    FAILED)
      printf '%s' "$status_inner" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("CF_ONSHAPE_TREE_CAPTURE_FAILED="+json.dumps({"build_id":d.get("build_id"),"error":d.get("error")},separators=(",",":")))'
      exit 22
      ;;
  esac
  sleep 1
done

echo "tree capture operation did not reach terminal state" >&2
exit 23
