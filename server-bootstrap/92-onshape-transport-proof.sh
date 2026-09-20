#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

container=capability-fabric-onshape-server
docker inspect "$container" >/dev/null 2>&1
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == "true" ]]

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("invalid MCP token material");

const endpoint = new URL("http://127.0.0.1:8787/mcp/" + token);
const client = new Client({ name: "cf-onshape-transport-proof", version: "1.0.0" });
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

async function pollOperation(operationId) {
  for (let i = 0; i < 30; i++) {
    const state = await call("onshape_operation_status", { operation_id: operationId });
    if (state.status === "SUCCEEDED") return state.result;
    if (state.status === "FAILED") throw new Error("operation failed: " + String(state?.error?.code || "unknown"));
    if (state.status === "AWAITING_INPUT") throw new Error("unexpected interactive login requirement");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("operation timeout");
}

let documentId = null;
let workspaceId = null;
let uploadArtifactId = null;
let downloadArtifactId = null;
let cleanupDocumentOk = false;

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = new Set((listed?.tools || []).map((tool) => tool.name));
  for (const required of ["onshape_request", "onshape_openapi_coverage", "onshape_artifact", "onshape_documents_create", "onshape_operation_status"]) {
    assert(toolNames.has(required), "missing tool " + required);
  }

  const coverage = await call("onshape_openapi_coverage");
  assert(coverage.build_id === "onshape-single-session-v44-full-openapi-transport", "unexpected build id");
  assert(coverage.status === "FULL", "OpenAPI coverage is not FULL");
  assert(coverage.total_operations === 302 && coverage.supported_operations === 302 && coverage.gap_count === 0, "coverage counts mismatch");
  assert(coverage.multipart_operations === 6, "multipart operation count mismatch");
  assert(coverage.binary_response_operations === 13, "binary response count mismatch");

  const created = await call("onshape_documents_create", {
    name: "CF v44 transport proof " + new Date().toISOString().replace(/[:.]/g, "-"),
    owner_scope: "personal"
  });
  const document = await pollOperation(created.operation_id);
  documentId = document?.documentId || null;
  workspaceId = document?.defaultWorkspaceId || null;
  assert(/^[0-9a-f]{24}$/i.test(documentId || ""), "proof document id missing");
  assert(/^[0-9a-f]{24}$/i.test(workspaceId || ""), "proof workspace id missing");

  const bytes = Buffer.from([0x00,0xff,0x01,0xfe,0x02,0xfd,0x03,0xfc,0x10,0x80,0x20,0x81,0x30,0x82,0x40,0x83,0x50,0x84,0x60,0x85,0x70,0x86,0x7f,0x87,0xaa,0x55,0xde,0xad,0xbe,0xef,0x00,0x7f]);
  const expectedSha = crypto.createHash("sha256").update(bytes).digest("hex");

  const staged = await call("onshape_artifact", {
    action: "write",
    offset: 0,
    data_base64: bytes.toString("base64"),
    filename: "cf-v44-proof.bin",
    content_type: "application/octet-stream"
  });
  uploadArtifactId = staged.artifact_id;
  assert(/^[0-9a-f]{32}$/.test(uploadArtifactId || ""), "upload artifact id missing");

  const upload = await call("onshape_request", {
    method: "POST",
    path: "/api/blobelements/d/" + documentId + "/w/" + workspaceId,
    multipart: {
      fields: {
        translate: false,
        encodedFilename: "cf-v44-proof.bin"
      },
      files: [{
        field: "file",
        artifact_id: uploadArtifactId,
        filename: "cf-v44-proof.bin",
        content_type: "application/octet-stream"
      }]
    }
  });
  assert(upload.ok === true && upload.http >= 200 && upload.http < 300, "multipart upload HTTP failure");
  const elementId = upload?.body?.id || upload?.body?.elementId || upload?.body?.element?.id || null;
  assert(/^[0-9a-f]{24}$/i.test(elementId || ""), "uploaded blob element id missing");

  const download = await call("onshape_request", {
    method: "GET",
    path: "/api/blobelements/d/" + documentId + "/w/" + workspaceId + "/e/" + elementId,
    headers: { Accept: "application/octet-stream" }
  });
  assert(download.ok === true && download.http === 200, "binary download HTTP failure");
  assert(download.bodyKind === "binary", "download was not classified as binary");
  downloadArtifactId = download?.artifact?.artifact_id || null;
  assert(/^[0-9a-f]{32}$/.test(downloadArtifactId || ""), "download artifact id missing");
  assert(download?.artifact?.sha256 === expectedSha, "download SHA-256 mismatch");
  assert(download?.artifact?.size === bytes.length, "download size mismatch");

  const readback = await call("onshape_artifact", {
    action: "read",
    artifact_id: downloadArtifactId,
    offset: 0,
    length: 393216
  });
  const actual = Buffer.from(readback.data_base64 || "", "base64");
  assert(actual.equals(bytes), "artifact byte round-trip mismatch");
  assert(readback.eof === true, "artifact readback did not reach EOF");

  console.log("CF_ONSHAPE_V44_TOOL_CATALOG=pass");
  console.log("CF_ONSHAPE_V44_OPENAPI_COVERAGE=pass");
  console.log("CF_ONSHAPE_V44_MULTIPART_UPLOAD=pass");
  console.log("CF_ONSHAPE_V44_BINARY_DOWNLOAD=pass");
  console.log("CF_ONSHAPE_V44_ARTIFACT_ROUNDTRIP=pass");
  console.log("CF_ONSHAPE_V44_HEADER_PASSTHROUGH=pass");
} finally {
  if (uploadArtifactId) {
    try { await call("onshape_artifact", { action: "delete", artifact_id: uploadArtifactId }); } catch {}
  }
  if (downloadArtifactId) {
    try { await call("onshape_artifact", { action: "delete", artifact_id: downloadArtifactId }); } catch {}
  }
  if (documentId) {
    try {
      const removed = await call("onshape_request", {
        method: "DELETE",
        path: "/api/documents/" + documentId,
        query: { forever: true }
      });
      cleanupDocumentOk = removed.ok === true && removed.http >= 200 && removed.http < 300;
    } catch {}
  }
  try { await client.close(); } catch {}
  console.log("CF_ONSHAPE_V44_CLEANUP=" + (cleanupDocumentOk ? "pass" : "fail"));
}

assert(cleanupDocumentOk, "temporary proof document cleanup failed");
NODE
