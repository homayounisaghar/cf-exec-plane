import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
// an earlier preload whose hook runs after ours and registers a tool late
const prev = McpServer.prototype.connect;
McpServer.prototype.connect = async function (...a) {
  this.registerTool("late_reader", { description: "Late tool. Reads.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "late CF root code: 112233" }] }));
  return prev.apply(this, a);
};
process.env.CF_OPS_SOCKET = "/nonexistent/cf-ops.sock";
await import("../cf-ops-preload.mjs");
const server = new McpServer({ name: "t", version: "1" });
let writes = 0;
server.registerTool("demo_read", { description: "Read a demo value. Second sentence here.", inputSchema: { n: z.number().int() }, annotations: { readOnlyHint: true } },
  async ({ n }, extra) => ({ content: [{ type: "text", text: "v" + n }], structuredContent: { v: n, meta: extra._meta ?? null } }));
server.registerTool("demo_write", { description: "Write a demo value.", inputSchema: { s: z.string(), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: true } },
  async ({ s }) => { writes++; return { content: [{ type: "text", text: "wrote " + s }] }; });
server.registerTool("telegram_message_list", { description: "x", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: "CF root code: 987654" }] }));
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "c", version: "1" }); await client.connect(b);
const listed = (await client.listTools()).tools;
const names = listed.map((t) => t.name);
for (const n of ["cf_tool_list", "cf_tool_read", "cf_tool_call", "server_admin_request", "server_file_link", "late_reader"]) assert.ok(names.includes(n), n);
const gw = Object.fromEntries(listed.filter((t) => t.name.startsWith("cf_tool_")).map((t) => [t.name, t.annotations]));
assert.equal(gw.cf_tool_list.readOnlyHint, true); assert.equal(gw.cf_tool_read.readOnlyHint, true); assert.equal(gw.cf_tool_call.readOnlyHint, false);
console.log("LIST ok", names.length, "tools; gateway annotations ok");
const call = (name, args, _meta) => client.callTool({ name, arguments: args, ...(_meta ? { _meta } : {}) });
// compact list
let r = await call("cf_tool_list", {});
assert.equal(r.structuredContent.state, "ACHIEVED"); assert.equal(r.structuredContent.total, names.length - 3);
assert.ok(!r.structuredContent.tools.some((t) => t.name.startsWith("cf_tool_")));
const dr = r.structuredContent.tools.find((t) => t.name === "demo_read"); assert.deepEqual(dr, { name: "demo_read", read_only: true, summary: "Read a demo value." });
console.log("COMPACT ok bytes", JSON.stringify(r.structuredContent).length);
r = await call("cf_tool_list", { prefix: "server_admin" }); assert.deepEqual(r.structuredContent.tools.map((t) => t.name).sort(), ["server_admin_approve", "server_admin_cancel", "server_admin_list", "server_admin_output", "server_admin_request"]);
r = await call("cf_tool_list", { query: "LATE TOOL" }); assert.deepEqual(r.structuredContent.tools.map((t) => t.name), ["late_reader"]);
// full schema equals the direct tools/list entry
r = await call("cf_tool_list", { names: ["demo_write", "server_admin_request", "nope", "cf_tool_call"] });
assert.deepEqual(r.structuredContent.missing, ["nope", "cf_tool_call"]);
for (const t of r.structuredContent.tools) { const d = listed.find((x) => x.name === t.name); assert.deepEqual(t.inputSchema, d.inputSchema); assert.equal(t.description, d.description); }
console.log("SCHEMA ok (identical to direct list)");
// read-only call equals direct call, _meta passes through
const meta = { "openai/subject": "subj-1" };
const direct = await call("demo_read", { n: 5 }, meta);
r = await call("cf_tool_read", { tool: "demo_read", arguments: { n: 5 } }, meta);
assert.deepEqual(r, direct); assert.deepEqual(r.structuredContent.meta, meta);
console.log("READ ok same as direct, _meta passed", JSON.stringify(r.structuredContent));
// read gateway refuses write tools and does not run them
r = await call("cf_tool_read", { tool: "demo_write", arguments: { s: "x", confirm: true } });
assert.equal(r.isError, true); assert.equal(r.structuredContent.error.code, "TOOL_NOT_READ_ONLY"); assert.equal(writes, 0);
r = await call("cf_tool_read", { tool: "server_exec", arguments: { command: "id" } }); assert.equal(r.structuredContent.error.code, "TOOL_NOT_READ_ONLY");
console.log("READ refuses write tools ok");
// call gateway: validation identical to direct
const dBad = await call("demo_write", { s: "x" });
r = await call("cf_tool_call", { tool: "demo_write", arguments: { s: "x" } });
assert.equal(r.isError, true); assert.deepEqual(r, dBad); assert.equal(writes, 0);
r = await call("cf_tool_call", { tool: "demo_write", arguments: { s: "x", confirm: true } }); assert.equal(r.content[0].text, "wrote x"); assert.equal(writes, 1);
console.log("CALL ok, validation identical to direct:", dBad.content[0].text.slice(0, 90));
// errors
r = await call("cf_tool_call", { tool: "nope_tool" }); assert.equal(r.structuredContent.error.code, "TOOL_NOT_FOUND");
r = await call("cf_tool_call", { tool: "cf_tool_call", arguments: { tool: "demo_write" } }); assert.equal(r.structuredContent.error.code, "TOOL_IS_GATEWAY");
r = await call("cf_tool_call", { tool: "../x" }); assert.equal(r.structuredContent.error.code, "TOOL_NAME_INVALID");
r = await call("cf_tool_call", { tool: "__proto__" }); assert.equal(r.structuredContent.error.code, "TOOL_NAME_INVALID");
r = await call("cf_tool_call", { tool: "constructor" }); assert.equal(r.structuredContent.error.code, "TOOL_NOT_FOUND");
console.log("ERRORS ok (unknown, recursion, bad name, prototype keys)");
// code scrub through gateway (telegram + late tool)
r = await call("cf_tool_read", { tool: "telegram_message_list" }); assert.ok(!/987654/.test(JSON.stringify(r)), JSON.stringify(r));
r = await call("cf_tool_read", { tool: "late_reader" }); assert.ok(!/112233/.test(JSON.stringify(r)), JSON.stringify(r));
console.log("SCRUB ok", r.content[0].text);
// cf-ops tool via gateway behaves like direct (agent unreachable here)
const strip = (x) => JSON.parse(JSON.stringify(x).replace(/"duration_ms":\d+/g, '"duration_ms":0'));
const d1 = strip(await call("server_status", {})); r = strip(await call("cf_tool_read", { tool: "server_status" }));
assert.deepEqual(r, d1); console.log("CF-OPS via gateway == direct:", JSON.stringify(d1).slice(0, 140));
const d2 = strip(await call("server_admin_list", {})); r = strip(await call("cf_tool_call", { tool: "server_admin_list" })); assert.deepEqual(r, d2);
console.log("ALL GATEWAY TESTS PASS");
process.exit(0);
