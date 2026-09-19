#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
container=capability-fabric-onshape-server
docker inspect "$container" >/dev/null 2>&1 || { echo "Onshape server container missing" >&2; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || { echo "Onshape server container not running" >&2; exit 20; }

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
const client = new Client({ name: "cf-local-qualification", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8787/mcp/${token}`));
await client.connect(transport);
try {
  const start = await client.callTool({
    name: "onshape_documents_create_in_folder",
    arguments: { name: "server test doc", folder_name: "View top" },
  });
  const text = start?.content?.find?.((x) => x?.type === "text")?.text;
  const payload = JSON.parse(text || "{}");
  if (!payload.operation_id) throw new Error("create tool returned no operation id");
  let terminal = null;
  for (let i = 0; i < 40; i++) {
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
  if (!terminal) throw new Error("document create operation did not reach terminal state");
  console.log("CF_ONSHAPE_TEST_DOC_RESULT=" + JSON.stringify(terminal));
  if (terminal.status !== "SUCCEEDED") process.exit(31);
} finally {
  await client.close().catch(() => {});
}
NODE
