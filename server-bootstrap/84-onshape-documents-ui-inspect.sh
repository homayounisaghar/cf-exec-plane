#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
container=capability-fabric-onshape-server
docker inspect "$container" >/dev/null 2>&1 || { echo "Onshape server container missing" >&2; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || { echo "Onshape server container not running" >&2; exit 20; }

if [[ -n "${CF_ONSHAPE_BROWSER_OPEN_DOCUMENT_ID:-}" || -n "${CF_ONSHAPE_BROWSER_OPEN_WORKSPACE_ID:-}" || -n "${CF_ONSHAPE_BROWSER_OPEN_ELEMENT_ID:-}" ]]; then
  [[ "${CF_ONSHAPE_BROWSER_OPEN_DOCUMENT_ID:-}" =~ ^[0-9a-fA-F]{24}$ ]] || { echo "bad document id" >&2; exit 21; }
  [[ "${CF_ONSHAPE_BROWSER_OPEN_WORKSPACE_ID:-}" =~ ^[0-9a-fA-F]{24}$ ]] || { echo "bad workspace id" >&2; exit 21; }
  [[ "${CF_ONSHAPE_BROWSER_OPEN_ELEMENT_ID:-}" =~ ^[0-9a-fA-F]{24}$ ]] || { echo "bad element id" >&2; exit 21; }
  docker exec -i     -e CF_OPEN_DID="$CF_ONSHAPE_BROWSER_OPEN_DOCUMENT_ID"     -e CF_OPEN_WID="$CF_ONSHAPE_BROWSER_OPEN_WORKSPACE_ID"     -e CF_OPEN_EID="$CF_ONSHAPE_BROWSER_OPEN_ELEMENT_ID"     "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
const client = new Client({ name: "cf-local-browser-open", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8787/mcp/${token}`));
await client.connect(transport);
try {
  const open = await client.callTool({
    name: "onshape_browser_open",
    arguments: {
      document_id: process.env.CF_OPEN_DID,
      workspace_id: process.env.CF_OPEN_WID,
      element_id: process.env.CF_OPEN_EID,
    },
  });
  const openText = open?.content?.find?.((x) => x?.type === "text")?.text || "{}";
  const status = await client.callTool({ name: "onshape_session_status", arguments: {} });
  const statusText = status?.content?.find?.((x) => x?.type === "text")?.text || "{}";
  console.log("CF_ONSHAPE_BROWSER_OPEN_RESULT=" + openText);
  console.log("CF_ONSHAPE_BROWSER_OPEN_STATUS=" + statusText);
  const parsed = JSON.parse(openText);
  if (parsed?.status === "FAILED" || parsed?.error) process.exit(31);
} finally {
  await client.close().catch(() => {});
}
NODE
  exit 0
fi

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
const client = new Client({ name: "cf-local-write-evidence", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8787/mcp/${token}`));
await client.connect(transport);
try {
  const start = await client.callTool({
    name: "onshape_write_path_evidence_capture",
    arguments: {},
  });
  const text = start?.content?.find?.((x) => x?.type === "text")?.text;
  const payload = JSON.parse(text || "{}");
  if (!payload.operation_id) throw new Error("evidence tool returned no operation id");
  let terminal = null;
  for (let i = 0; i < 120; i++) {
    const status = await client.callTool({
      name: "onshape_operation_status",
      arguments: { operation_id: payload.operation_id },
    });
    const statusText = status?.content?.find?.((x) => x?.type === "text")?.text;
    const state = JSON.parse(statusText || "{}");
    if (state.status === "SUCCEEDED" || state.status === "FAILED") {
      terminal = state;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!terminal) throw new Error("write-path evidence capture did not reach terminal state");
  const evidence = terminal?.result || {};
  console.log("CF_ONSHAPE_EVIDENCE_META=" + JSON.stringify({
    build_id: terminal?.build_id ?? null,
    operation_id: terminal?.operation_id ?? null,
    status: terminal?.status ?? null,
    capturedAt: evidence?.capturedAt ?? null,
    navigation: evidence?.navigation ?? null,
  }));
  console.log("CF_ONSHAPE_EVIDENCE_ITEM1=" + JSON.stringify(evidence?.item1_apiRequestsObserved ?? null));
  console.log("CF_ONSHAPE_EVIDENCE_ITEM2=" + JSON.stringify(evidence?.item2_antiForgeryCookie ?? null));
  console.log("CF_ONSHAPE_EVIDENCE_ITEM3=" + JSON.stringify(evidence?.item3_origin ?? null));
  console.log("CF_ONSHAPE_EVIDENCE_ITEM4=" + JSON.stringify(evidence?.item4_sampleReadReplay ?? null));
  const item5 = Array.isArray(evidence?.item5_treeRequestContract) ? evidence.item5_treeRequestContract : [];
  console.log("CF_ONSHAPE_EVIDENCE_ITEM5_COUNT=" + item5.length);
  item5.forEach((entry, i) => console.log("CF_ONSHAPE_EVIDENCE_ITEM5_" + i + "=" + JSON.stringify(entry)));
  const item6 = Array.isArray(evidence?.item6_writeRequestContract) ? evidence.item6_writeRequestContract : [];
  console.log("CF_ONSHAPE_EVIDENCE_ITEM6_COUNT=" + item6.length);
  item6.forEach((entry, i) => console.log("CF_ONSHAPE_EVIDENCE_ITEM6_" + i + "=" + JSON.stringify(entry)));
  if (terminal.status !== "SUCCEEDED") process.exit(31);
} finally {
  await client.close().catch(() => {});
}
NODE
