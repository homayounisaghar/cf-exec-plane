#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

container=capability-fabric-onshape-server
docker inspect "$container" >/dev/null 2>&1
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == "true" ]]

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("invalid MCP token material");

const endpoint = new URL("http://127.0.0.1:8787/mcp/" + token);
const client = new Client({ name: "cf-onshape-pool-proof", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function payload(result) {
  const item = result?.content?.find((x) => x?.type === "text");
  assert(item && typeof item.text === "string", "missing MCP text result");
  const value = JSON.parse(item.text);
  if (value?.status === "FAILED") {
    const code = value?.error?.code || "unknown";
    const message = value?.error?.message || "tool failed";
    throw new Error("tool failed: " + code + ": " + message);
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
    if (state.status === "FAILED") {
      throw new Error("operation failed: " + String(state?.error?.code || state?.error?.message || "unknown"));
    }
    if (state.status === "AWAITING_INPUT") {
      throw new Error("unexpected interactive input: " + String(state.input_required || "unknown"));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("operation timeout");
}

function parseTime(value) {
  const n = Date.parse(String(value || ""));
  assert(Number.isFinite(n), "invalid execution timestamp");
  return n;
}

function assertNonOverlapping(intervals) {
  const sorted = [...intervals].sort((a, b) => parseTime(a.started_at) - parseTime(b.started_at));
  for (let i = 1; i < sorted.length; i++) {
    const previousEnd = parseTime(sorted[i - 1].finished_at);
    const currentStart = parseTime(sorted[i].started_at);
    assert(currentStart >= previousEnd, "same-document mutation intervals overlapped");
  }
  return sorted;
}

let documents = [];
let artifacts = [];
let cleanupOk = true;

async function createDocument(name) {
  const started = await call("onshape_documents_create", {
    name,
    owner_scope: "personal"
  });
  const result = await pollOperation(started.operation_id);
  const did = result?.documentId || null;
  const wid = result?.defaultWorkspaceId || null;
  assert(/^[0-9a-f]{24}$/i.test(did || ""), "created document id missing");
  assert(/^[0-9a-f]{24}$/i.test(wid || ""), "created workspace id missing");
  documents.push(did);
  return { did, wid };
}

async function elements(did, wid) {
  const result = await call("onshape_request", {
    method: "GET",
    path: "/api/documents/d/" + did + "/w/" + wid + "/elements"
  });
  assert(result.ok === true && result.http >= 200 && result.http < 300, "elements read failed");
  assert(Array.isArray(result.body), "elements body is not an array");
  const partStudio = result.body.find((item) => String(item?.elementType || "").toUpperCase().includes("PARTSTUDIO"));
  assert(partStudio && /^[0-9a-f]{24}$/i.test(partStudio.id || ""), "default Part Studio missing");
  return { eid: partStudio.id, execution: result.pool_execution };
}

async function stageBinary(label) {
  const bytes = Buffer.from([
    0x00,0xff,0x01,0xfe,0x02,0xfd,0x03,0xfc,
    label.charCodeAt(0) & 0xff,0x80,0x10,0x81,0x20,0x82,0x30,0x83,
    0xaa,0x55,0xde,0xad,0xbe,0xef,0x00,0x7f
  ]);
  const staged = await call("onshape_artifact", {
    action: "write",
    offset: 0,
    data_base64: bytes.toString("base64"),
    filename: "cf-pool-" + label + ".bin",
    content_type: "application/octet-stream"
  });
  assert(/^[0-9a-f]{32}$/.test(staged.artifact_id || ""), "staged artifact id missing");
  artifacts.push(staged.artifact_id);
  return staged.artifact_id;
}

async function uploadBlob(did, wid, artifactId, label) {
  const result = await call("onshape_request", {
    method: "POST",
    path: "/api/blobelements/d/" + did + "/w/" + wid,
    multipart: {
      fields: {
        translate: false,
        encodedFilename: "cf-pool-" + label + ".bin"
      },
      files: [{
        field: "file",
        artifact_id: artifactId,
        filename: "cf-pool-" + label + ".bin",
        content_type: "application/octet-stream"
      }]
    }
  });
  assert(result.ok === true && result.http >= 200 && result.http < 300, "blob upload failed");
  assert(result?.pool_execution?.write_serialized === true, "blob write was not marked serialized");
  return result.pool_execution;
}

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = new Set((listed?.tools || []).map((tool) => tool.name));
  for (const required of [
    "onshape_pool_status",
    "onshape_pool_warmup",
    "onshape_request",
    "onshape_artifact",
    "onshape_documents_create",
    "onshape_operation_status"
  ]) {
    assert(toolNames.has(required), "missing v45 tool " + required);
  }
  console.log("CF_ONSHAPE_V45_TOOL_CATALOG=pass");

  const before = await call("onshape_pool_status");
  assert(before.build_id === "onshape-three-session-v45-pool", "unexpected v45 build id");
  assert(before.size === 3, "pool size is not three");

  const warmStart = await call("onshape_pool_warmup");
  const warm = await pollOperation(warmStart.operation_id, 360);
  assert(warm.pool_enabled === true, "warmup did not enable pool");
  assert(warm.size === 3 && warm.proven_sessions === 3, "warmup did not prove three sessions");
  assert(warm.final_reprobe_passed === true, "warmup final reprobe missing");
  assert(warm.session_fingerprints_distinct === true, "session fingerprints are not distinct");
  assert(Array.isArray(warm.sessions) && warm.sessions.length === 3, "warmup session list mismatch");
  assert(warm.sessions.every((s) => s.auth_state === "PROVEN" && s.http_status === 200), "one or more pool sessions are not PROVEN");
  console.log("CF_ONSHAPE_V45_POOL_WARMUP=pass");
  console.log("CF_ONSHAPE_V45_SESSION_ISOLATION=pass");

  const poolStatus = await call("onshape_pool_status");
  assert(poolStatus.pool_enabled === true, "pool disabled after warmup");
  assert(poolStatus.size === 3, "post-warmup pool size mismatch");
  assert(poolStatus.sessions.every((s) => s.auth?.state === "PROVEN" && s.auth?.http_status === 200), "post-warmup auth reprobe failed");
  console.log("CF_ONSHAPE_V45_FINAL_REPROBE=pass");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const docs = [];
  for (let i = 1; i <= 3; i++) docs.push(await createDocument("CF v45 pool proof " + stamp + " " + i));

  // Resolve the default Part Studio in each temporary document.
  const elementInfo = [];
  for (const doc of docs) elementInfo.push(await elements(doc.did, doc.wid));

  // Launch three safe feature reads concurrently. Distinct session ids prove
  // that the scheduler actually used all three independent browser sessions.
  const reads = await Promise.all(docs.map((doc, i) =>
    call("onshape_request", {
      method: "GET",
      path: "/api/v9/partstudios/d/" + doc.did + "/w/" + doc.wid + "/e/" + elementInfo[i].eid + "/features",
      query: { includeGeometryIds: false }
    })
  ));

  for (const read of reads) {
    assert(read.ok === true && read.http >= 200 && read.http < 300, "concurrent feature read failed");
    assert(read?.pool_execution?.pool_enabled === true, "concurrent read did not use enabled pool");
  }
  const readSessions = new Set(reads.map((read) => read.pool_execution.session_id));
  assert(readSessions.size === 3, "three concurrent reads did not use three distinct pool sessions");

  const starts = reads.map((read) => parseTime(read.pool_execution.started_at));
  const ends = reads.map((read) => parseTime(read.pool_execution.finished_at));
  const overlapStart = Math.max(...starts);
  const overlapEnd = Math.min(...ends);
  assert(overlapStart < overlapEnd, "three concurrent reads did not have a common overlap interval");
  console.log("CF_ONSHAPE_V45_DIFFERENT_DOCUMENT_CONCURRENCY=pass");

  // Two real mutations against one temporary document are issued concurrently.
  // The per-document mutex must make their execution intervals non-overlapping.
  const artifactA = await stageBinary("A");
  const artifactB = await stageBinary("B");
  const writes = await Promise.all([
    uploadBlob(docs[0].did, docs[0].wid, artifactA, "A"),
    uploadBlob(docs[0].did, docs[0].wid, artifactB, "B")
  ]);
  const orderedWrites = assertNonOverlapping(writes);
  assert(writes.every((w) => w.document_id === docs[0].did), "write document metadata mismatch");
  assert(writes.some((w) => Number(w.document_lock_wait_ms || 0) > 0), "second same-document write did not observe lock wait");
  console.log("CF_ONSHAPE_V45_SAME_DOCUMENT_SERIALIZATION=pass");

  const after = await call("onshape_pool_status");
  assert(after.pool_enabled === true, "pool disabled during proof");
  assert(after.sessions.every((s) => s.auth?.state === "PROVEN"), "a pool session lost authentication during proof");
  assert(after.document_lock_count === 0, "document lock leaked after writes");
  console.log("CF_ONSHAPE_V45_POST_PROOF_HEALTH=pass");
} finally {
  for (const artifactId of artifacts) {
    try { await call("onshape_artifact", { action: "delete", artifact_id: artifactId }); }
    catch { cleanupOk = false; }
  }
  for (const did of documents) {
    try {
      const removed = await call("onshape_request", {
        method: "DELETE",
        path: "/api/documents/" + did,
        query: { forever: true }
      });
      if (!(removed.ok === true && removed.http >= 200 && removed.http < 300)) cleanupOk = false;
    } catch {
      cleanupOk = false;
    }
  }
  try { await client.close(); } catch {}
  console.log("CF_ONSHAPE_V45_CLEANUP=" + (cleanupOk ? "pass" : "fail"));
}

assert(cleanupOk, "temporary pool-proof cleanup failed");
NODE
