import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = fs.readFileSync("/run/secrets/mcp-token", "utf8").trim();
const client = new Client({ name: "cf-r10-live-qualification", version: "1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8789/mcp/${token}`)));

function parse(result) {
  const raw = (result.content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n");
  const value = JSON.parse(raw);
  if (value.status === "FAILED") throw new Error(`${value.error?.code || "TOOL_FAILED"}: ${value.error?.message || "unknown"}`);
  return value;
}

async function call(name, args = {}, timeout = 360_000) {
  return parse(await client.callTool({ name, arguments: args }, undefined, { timeout }));
}

try {
  const started = await call("onshape_pool_warmup");
  let operation;
  for (let index = 0; index < 120; index += 1) {
    operation = await call("onshape_operation_status", { operation_id: started.operation_id });
    if (["SUCCEEDED", "FAILED", "AWAITING_INPUT"].includes(operation.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (operation?.status !== "SUCCEEDED") throw new Error(`warmup did not succeed: ${operation?.status || "timeout"}`);

  const before = await call("onshape_pool_status");
  if (before.build_id !== "onshape-vps-hardened-r10") throw new Error("wrong build");
  if (before.pool_enabled !== true || before.topology !== "ACTIVE_HOT_STANDBY" || before.size !== 2) throw new Error("wrong topology");
  if (before.session_fingerprints_distinct !== true) throw new Error("session fingerprints are not distinct");
  if (before.active_count !== 0 || before.workflow_lease_count !== 0 || before.ui_lease_count !== 0) throw new Error("runtime is not idle");
  if (before.api_scheduler?.minimum_interval_ms !== 1000 || before.api_scheduler?.maximum_concurrency !== 1) throw new Error("scheduler contract mismatch");
  if ((before.sessions || []).length !== 2 || before.sessions.some((item) => item?.auth?.state !== "PROVEN" || item?.auth?.http_status !== 200)) throw new Error("browser pair is not 2/2 PROVEN");
  if (new Set(before.sessions.map((item) => item?.auth?.account_id).filter(Boolean)).size !== 1) throw new Error("account mismatch");

  const burstStarted = Date.now();
  const reads = await Promise.all(Array.from({ length: 200 }, () =>
    call("onshape_request", { method: "GET", path: "/api/users/current" })
  ));
  const burstElapsedMs = Date.now() - burstStarted;
  if (reads.some((item) => item.ok !== true || item.http !== 200)) throw new Error("one or more documented reads failed");

  const afterReads = await call("onshape_pool_status");
  const dispatchDelta = afterReads.api_scheduler.dispatch_count - before.api_scheduler.dispatch_count;
  if (dispatchDelta !== 200) throw new Error(`scheduler dispatch delta was ${dispatchDelta}, expected 200`);
  if (afterReads.api_scheduler.maximum_observed_concurrency !== 1) throw new Error("API concurrency exceeded one");
  if (afterReads.api_scheduler.active !== 0 || afterReads.api_scheduler.queued !== 0) throw new Error("API queue did not drain");
  if (burstElapsedMs < 198_000) throw new Error(`200-request burst completed too quickly: ${burstElapsedMs}ms`);

  const target = {
    document_id: "a19e0fa5152af9f7ce106b6e",
    workspace_id: "e5e7d0173fd1f1d0307a2cb6",
    element_id: "e0929361aadb6135b5cecffa",
  };
  const leases = await Promise.all(Array.from({ length: 3 }, (_, index) => call("onshape_ui_lease_acquire", {
    work_item: `r10-ui-${index}`,
    attempt_id: `r10-ui-acquire-${index}`,
    ...target,
  })));
  if (new Set(leases.map((item) => item.ui_context_id)).size !== 3) throw new Error("UI lease ids are not distinct");

  await Promise.all(leases.map((lease, index) => call("onshape_ui_lease_marker", {
    ui_context_id: lease.ui_context_id,
    attempt_id: `r10-ui-write-${index}`,
    marker: `marker-${index}`,
  })));
  const readbacks = await Promise.all(leases.map((lease, index) => call("onshape_ui_lease_marker", {
    ui_context_id: lease.ui_context_id,
    attempt_id: `r10-ui-read-${index}`,
  })));
  if (readbacks.some((item, index) => item.marker !== `marker-${index}`)) throw new Error("UI page-local markers crossed leases");
  if (readbacks.some((item) => !String(item.url || "").startsWith("https://cad.onshape.com/"))) throw new Error("UI page origin mismatch");

  const withUi = await call("onshape_pool_status");
  if (withUi.ui_lease_count !== 3) throw new Error("expected three live UI leases");
  await Promise.all(leases.map((lease, index) => call("onshape_ui_lease_release", {
    ui_context_id: lease.ui_context_id,
    attempt_id: `r10-ui-release-${index}`,
  })));
  const final = await call("onshape_pool_status");
  if (final.ui_lease_count !== 0 || final.active_count !== 0) throw new Error("UI leases did not close cleanly");

  console.log(JSON.stringify({
    ok: true,
    build_id: final.build_id,
    topology: final.topology,
    proven_sessions: 2,
    documented_reads: 200,
    dispatch_delta: dispatchDelta,
    minimum_interval_ms: final.api_scheduler.minimum_interval_ms,
    maximum_observed_concurrency: final.api_scheduler.maximum_observed_concurrency,
    burst_elapsed_ms: burstElapsedMs,
    isolated_ui_pages: 3,
    final_ui_lease_count: final.ui_lease_count,
  }));
} finally {
  await client.close().catch(() => {});
}
