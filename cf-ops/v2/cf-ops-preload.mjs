import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCfOpsTools, callAgent } from "./cf-ops-tools.mjs";

// Hide owner root-approval codes from every tool result (Telegram readers above all),
// so an assistant cannot approve its own root request by reading Saved Messages.
// Image tools (screenshots) cannot be scrubbed; the code is a consent step, not a sandbox.
const CODE_RE = /CF\s*root\s*code\s*:?\s*\d(?:[\s.-]?\d){0,5}/gi;
const plain = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
export const scrub = (v) => typeof v === "string" ? v.replace(CODE_RE, "CF root code: (hidden)")
  : Array.isArray(v) ? v.map(scrub)
  : v && typeof v === "object" && plain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, (k === "data" || k === "blob") && typeof x === "string" && x.length > 1024 ? x : scrub(x)])) : v; // base64 media untouched
export function wrapToolResults(server) {
  const tools = server._registeredTools || {};
  for (const tool of Object.values(tools)) {
    if (typeof tool?.handler !== "function" || tool.__cfScrubbed) continue;
    const original = tool.handler;
    tool.handler = async (...args) => scrub(await original(...args));
    tool.__cfScrubbed = true;
  }
}

const previousConnect=McpServer.prototype.connect;
if(typeof previousConnect!=="function") throw new Error("McpServer.connect is unavailable");
McpServer.prototype.connect=async function(...args){
  if(!this.__cfOpsPreloadRegistered){
    registerCfOpsTools(this,z);
    Object.defineProperty(this,"__cfOpsPreloadRegistered",{value:true,enumerable:false,configurable:false});
  }
  wrapToolResults(this);
  const result = await previousConnect.apply(this,args);
  wrapToolResults(this); // tools registered by preloads that run after this hook
  return result;
};

// Capability download links: GET /mcp/cf-ops-file/<64 hex> (random, expiring).
const LINK_RE = /^\/mcp\/cf-ops-file\/([0-9a-f]{64})$/;
async function serveLink(token, req, res) {
  try {
    if (req.method !== "GET") { res.writeHead(405, { "content-type": "application/json" }); res.end('{"error":"Use GET"}'); return; }
    const o = await callAgent("_link_open", { token }, 15000, "download-link");
    if (!o?.ok) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: o?.error?.code || "NOT_FOUND" })); return; }
    const name = String(o.result.filename || "file").replace(/[^\w.\-]+/g, "_");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(o.result.size_bytes),
      "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
    let offset = 0;
    while (offset < o.result.size_bytes) {
      const c = await callAgent("_link_chunk", { token, offset }, 30000, "download-link");
      if (!c?.ok) throw new Error(c?.error?.code || "CHUNK_FAILED");
      const buf = Buffer.from(c.result.content, "base64");
      if (!buf.length) break;
      offset += buf.length;
      if (!res.write(buf)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"LINK_FAILED"}'); }
    else res.destroy();
  }
}
const previousEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res) {
  if (event === "request" && typeof req?.url === "string") {
    const m = LINK_RE.exec(req.url.split("?", 1)[0]);
    if (m) { serveLink(m[1], req, res); return true; }
  }
  return previousEmit.apply(this, arguments);
};
