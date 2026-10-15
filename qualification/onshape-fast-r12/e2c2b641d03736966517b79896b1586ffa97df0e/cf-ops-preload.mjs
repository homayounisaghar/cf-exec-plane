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

// Tool gateway (r252): clients cache the tool list when they connect. These three fixed
// tools let a client with an older cached list discover and run tools added later.
// They run the target through the SDK's own tools/call handler with the same caller
// context, so input validation, owner checks inside tools, confirm=true fields and the
// Telegram root code all still apply. The HTTP owner gate already ran for the gateway call.
const GATEWAY_TOOLS = new Set(["cf_tool_list", "cf_tool_read", "cf_tool_call"]);
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const gwResult = (o, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o, ...(isError ? { isError: true } : {}) });
const gwError = (code, message) => gwResult({ state: "FAILED", tool: "gateway", error: { code, message } }, true);
function gwHandlers(server) {
  const m = server?.server?._requestHandlers;
  const list = m instanceof Map ? m.get("tools/list") : null;
  const call = m instanceof Map ? m.get("tools/call") : null;
  if (typeof list !== "function" || typeof call !== "function") throw Object.assign(new Error("tool gateway unavailable"), { code: "GATEWAY_UNAVAILABLE" });
  return { list, call };
}
async function gwListAll(server, extra) {
  const r = await gwHandlers(server).list({ method: "tools/list", params: {} }, extra);
  return (Array.isArray(r?.tools) ? r.tools : []).filter((t) => !GATEWAY_TOOLS.has(t.name));
}
const gwSummary = (d) => { const s = String(d || "").replace(/\s+/g, " ").trim(); const i = s.search(/[.!?](\s|$)/); const f = i > 0 && i < 140 ? s.slice(0, i + 1) : s.slice(0, 140); return f.length < s.length && !/[.!?]$/.test(f) ? f + "…" : f; };
const gwReadOnly = (t) => t?.annotations?.readOnlyHint === true;
async function gwInvoke(server, extra, tool, args, readOnlyOnly) {
  if (!TOOL_NAME_RE.test(tool)) return gwError("TOOL_NAME_INVALID", "tool must be an exact CF-server tool name");
  if (GATEWAY_TOOLS.has(tool)) return gwError("TOOL_IS_GATEWAY", "call the target tool directly, not another gateway tool");
  const regs = server._registeredTools || {};
  const reg = Object.hasOwn(regs, tool) ? regs[tool] : null;
  if (!reg || typeof reg.handler !== "function" || reg.enabled === false) return gwError("TOOL_NOT_FOUND", `no CF-server tool named ${tool}; call cf_tool_list to see current tools`);
  if (readOnlyOnly && reg.annotations?.readOnlyHint !== true) return gwError("TOOL_NOT_READ_ONLY", `${tool} can change things; use cf_tool_call for it`);
  const params = { name: tool, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} };
  if (extra?._meta && typeof extra._meta === "object") params._meta = extra._meta;
  try {
    return scrub(await gwHandlers(server).call({ method: "tools/call", params }, extra));
  } catch (e) {
    return gwError(e?.code === "GATEWAY_UNAVAILABLE" ? "GATEWAY_UNAVAILABLE" : "TOOL_CALL_FAILED", scrub(String(e?.message || e)).slice(0, 500));
  }
}
function registerGatewayTools(server, z) {
  if (server._registeredTools?.cf_tool_list) return;
  server.registerTool("cf_tool_list", {
    title: "List CF-server tools (gateway)",
    description: "List the CF-server tools that exist on the server right now, including tools newer than this connector's cached tool list. Without names: compact list (name, read_only, summary), optionally filtered by query (matches name or description) or prefix. With names (max 20): full description, annotations and input JSON schema for each. Use it before cf_tool_read / cf_tool_call.",
    inputSchema: { query: z.string().max(100).optional(), prefix: z.string().max(64).optional(), names: z.array(z.string().max(64)).max(20).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, prefix, names }, extra) => {
    try {
      const all = await gwListAll(server, extra);
      if (names?.length) {
        const by = new Map(all.map((t) => [t.name, t]));
        const tools = names.filter((n) => by.has(n)).map((n) => { const t = by.get(n); return { name: t.name, title: t.title, read_only: gwReadOnly(t), description: t.description, annotations: t.annotations, inputSchema: t.inputSchema }; });
        return gwResult({ state: "ACHIEVED", tool: "cf_tool_list", count: tools.length, tools, missing: names.filter((n) => !by.has(n)) });
      }
      const q = String(query || "").toLowerCase(), pre = String(prefix || "");
      const tools = all.filter((t) => (!pre || t.name.startsWith(pre)) && (!q || t.name.toLowerCase().includes(q) || String(t.description || "").toLowerCase().includes(q)))
        .map((t) => ({ name: t.name, read_only: gwReadOnly(t), summary: gwSummary(t.description) }));
      return gwResult({ state: "ACHIEVED", tool: "cf_tool_list", count: tools.length, total: all.length, tools, note: "Prefer a direct tool when you have it. Otherwise use cf_tool_read (read-only tools) or cf_tool_call (any tool) with the exact name and arguments from cf_tool_list names=[...]." });
    } catch (e) { return gwError(e?.code || "GATEWAY_FAILED", String(e?.message || e).slice(0, 300)); }
  });
  const callSchema = { tool: z.string().min(1).max(64).describe("exact CF-server tool name from cf_tool_list"), arguments: z.record(z.string(), z.any()).optional().describe("the target tool's input object, exactly as in its inputSchema") };
  server.registerTool("cf_tool_read", {
    title: "Run a read-only CF-server tool (gateway)",
    description: "Run one READ-ONLY CF-server tool by exact name with its arguments object, for tools that are not in your own tool list yet (the connector list is older than the server). If you have the tool directly, call it directly instead. Refuses tools that are not marked read-only; use cf_tool_call for those. Returns the target tool's own result.",
    inputSchema: callSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ tool, arguments: args }, extra) => gwInvoke(server, extra, tool, args, true));
  server.registerTool("cf_tool_call", {
    title: "Run any CF-server tool (gateway)",
    description: "Run one CF-server tool by exact name with its arguments object, for tools that are not in your own tool list yet (the connector list is older than the server). If you have the tool directly, call it directly instead; for read-only tools prefer cf_tool_read. The target tool's own rules still apply (input validation, confirm=true fields, owner checks, Telegram code for root commands). Ask the owner before risky actions exactly as you would for the direct tool. Returns the target tool's own result.",
    inputSchema: callSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ tool, arguments: args }, extra) => gwInvoke(server, extra, tool, args, false));
}

// r253: lets the OAuth pairing page ask the agent for a Telegram owner code.
Object.defineProperty(globalThis,"__cfOpsCallAgent",{value:callAgent,writable:false,enumerable:false,configurable:false});
const previousConnect=McpServer.prototype.connect;
if(typeof previousConnect!=="function") throw new Error("McpServer.connect is unavailable");
McpServer.prototype.connect=async function(...args){
  if(!this.__cfOpsPreloadRegistered){
    registerCfOpsTools(this,z);
    registerGatewayTools(this,z);
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
