import fs from "node:fs";
import crypto from "node:crypto";

const BASE_URL = "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/qualification/onshape-fast-r12/482e02726adf3a6a69687a4b165515c0596854ae/server.js";
const BASE_SHA256 = "2d7050513c39e75eccb01cd60afc942421dcf5ecccd215eb8c6aef247b2e88ff";
const REQUIRED_BASE_MARKERS = [
  'agent.executeIntent(args)',
  'execution_path: "mcp->semantic-contract->onshape-agent->browser-session->onshape"',
  'server.registerTool("onshape_operation_execute"',
  'voice_conversion: await voiceRuntimeStatus()',
  'RVC_WORKER_STATUS_URL',
];

const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error("BASE_SERVER_FETCH_FAILED_" + response.status);
const source = await response.text();
const digest = crypto.createHash("sha256").update(source).digest("hex");
if (digest !== BASE_SHA256) throw new Error("BASE_SERVER_DIGEST_MISMATCH");
for (const marker of REQUIRED_BASE_MARKERS) {
  if (!source.includes(marker)) throw new Error("BASE_SERVER_MARKER_MISSING");
}
const target = "/tmp/app/server.base.mjs";
fs.writeFileSync(target, source, { mode: 0o600 });
await import("./server.base.mjs");