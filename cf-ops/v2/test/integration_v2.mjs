import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
// an "earlier" preload whose connect hook runs AFTER ours and registers a reader tool late
const prev = McpServer.prototype.connect;
McpServer.prototype.connect = async function (...a) {
  this.registerTool("bale_message_list", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "fwd: CF root code: 654 321 x" }] }));
  return prev.apply(this, a);
};
const { callerIdentity } = await import("./cf-ops-tools.mjs");
await import("./cf-ops-preload.mjs");
const server = new McpServer({ name: "t", version: "1" });
server.registerTool("telegram_message_list", { inputSchema: {} }, async () => ({
  structuredContent: { messages: [{ text: "CF root request abc\nCF root code: 123456\nValid" }], img: { type: "image", data: "CFrootcode1".repeat(200) } },
  content: [{ type: "text", text: JSON.stringify({ t: "CF root code:\u00a0987654" }) }] }));
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "c", version: "1" }); await client.connect(b);
const names = (await client.listTools()).tools.map(t => t.name);
console.log("TOOLS", names.length, names.filter(n => n.startsWith("server_admin") || n === "server_file_link").join(","));
let r = await client.callTool({ name: "telegram_message_list", arguments: {} });
assert.ok(!/\d{6}|987654|123456/.test(JSON.stringify(r.structuredContent.messages)) && !/987654/.test(r.content[0].text), JSON.stringify(r));
assert.equal(r.structuredContent.img.data.length, 2200); console.log("SCRUB telegram", r.structuredContent.messages[0].text.replace(/\n/g, " | "));
r = await client.callTool({ name: "bale_message_list", arguments: {} });
assert.ok(!/654/.test(r.content[0].text), r.content[0].text); console.log("SCRUB late tool", r.content[0].text);
const c = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
const sent = () => fs.existsSync("run/sent.jsonl") ? fs.readFileSync("run/sent.jsonl", "utf8").trim().split("\n").map(JSON.parse) : [];
const lastCode = () => { const m = /CF root code: (\d{6})/.exec(sent().at(-1).text); return m[1]; };
// root request / approve (foreground)
r = await c("server_admin_request", { command: 'echo "home=$HOME pct=%n %i"; echo err >&2; exit 3', reason: "تست فارسی test\u202e", timeout_s: 20 });
assert.equal(r.state, "ACHIEVED", JSON.stringify(r)); const rid = r.result.request_id;
const msg = sent().at(-1); assert.equal(msg.conversation_handle, "tgchat:777"); console.log("TELEGRAM_MSG\n" + msg.text.replace(/CF root code: \d{6}/, "CF root code: ######"));
r = await c("server_admin_approve", { request_id: rid, code: lastCode() === "000000" ? "000001" : "000000" }); assert.equal(r.error.code, "CODE_INVALID"); console.log("bad code", r.error.message);
r = await c("server_admin_approve", { request_id: rid, code: lastCode() }); assert.equal(r.state, "ACHIEVED", JSON.stringify(r));
assert.equal(r.result.exit_code, 3); assert.equal(r.result.stdout, "home=/root pct=%n %i\n"); assert.equal(r.result.stderr, "err\n"); console.log("FG ok", JSON.stringify(r.result));
r = await c("server_admin_approve", { request_id: rid, code: lastCode() }); assert.equal(r.error.code, "REQUEST_NOT_PENDING");
// validation
r = await c("server_admin_request", { command: "echo سلام", reason: "x" }); assert.equal(r.error.code, "COMMAND_NOT_PLAIN_ASCII");
r = await c("server_admin_request", { command: "echo ```", reason: "x" }); assert.equal(r.error.code, "COMMAND_HAS_TRIPLE_BACKTICK");
{ const raw = await client.callTool({ name: "server_admin_request", arguments: { command: "x".repeat(3201), reason: "x" } }); assert.equal(raw.isError, true); console.log("too long -> schema rejects:", raw.content[0].text.slice(0, 80)); }
// background
r = await c("server_admin_request", { command: "sleep 1; echo bg; echo bge >&2; exit 7", reason: "bg", background: true, timeout_s: 30 }); const rb = r.result.request_id;
r = await c("server_admin_approve", { request_id: rb, code: lastCode() }); assert.equal(r.result.status, "running", JSON.stringify(r));
r = await c("server_admin_output", { request_id: rb }); assert.equal(r.result.status, "running");
await new Promise(s => setTimeout(s, 2500));
r = await c("server_admin_output", { request_id: rb }); assert.equal(r.result.status, "done", JSON.stringify(r)); assert.equal(r.result.exit_code, 7); assert.equal(r.result.stdout, "bg\n"); console.log("BG ok", JSON.stringify(r.result));
// foreground timeout kills the whole group
r = await c("server_admin_request", { command: "sleep 60 & sleep 60", reason: "t", timeout_s: 2 }); const rt = r.result.request_id;
const t0 = Date.now(); r = await c("server_admin_approve", { request_id: rt, code: lastCode() });
assert.equal(r.result.exit_code, 124, JSON.stringify(r)); console.log("TIMEOUT ok ms", Date.now() - t0, JSON.stringify(r.result.stderr));
// concurrency: two approvals with the right code -> exactly one runs
r = await c("server_admin_request", { command: "echo once >> /tmp/cfit/run/once.txt", reason: "c" }); const rc = r.result.request_id; const code = lastCode();
const both = await Promise.all([c("server_admin_approve", { request_id: rc, code }), c("server_admin_approve", { request_id: rc, code })]);
assert.equal(both.filter(x => x.state === "ACHIEVED").length, 1, JSON.stringify(both)); assert.equal(fs.readFileSync("run/once.txt", "utf8"), "once\n"); console.log("RACE ok", both.map(x => x.error?.code || "ran").join(","));
// pending cap + cancel
const ids = []; for (let i = 0; i < 5; i++) { r = await c("server_admin_request", { command: "true", reason: "p" + i }); assert.equal(r.state, "ACHIEVED", JSON.stringify(r)); ids.push(r.result.request_id); }
r = await c("server_admin_request", { command: "true", reason: "p6" }); assert.equal(r.error.code, "TOO_MANY_PENDING"); console.log("PENDING cap ok");
r = await c("server_admin_cancel", { request_id: ids[0] }); assert.equal(r.result.status, "cancelled");
// lock after 5 bad attempts on one request
for (let i = 0; i < 5; i++) r = await c("server_admin_approve", { request_id: ids[1], code: "000000" });
r = await c("server_admin_approve", { request_id: ids[1], code: "000000" }); assert.equal(r.error.code, "REQUEST_NOT_PENDING"); console.log("LOCK per request ok", r.error.message);
r = await c("server_admin_list", {}); console.log("LIST", r.result.requests.length, "wrong24h", r.result.wrong_codes_last_24h, JSON.stringify(r.result.requests[0]).slice(0, 220));
// global lockout after 20 wrong codes
for (const id of ids.slice(2)) for (let i = 0; i < 5; i++) await c("server_admin_approve", { request_id: id, code: "000000" });
r = await c("server_admin_list", {}); console.log("wrong24h now", r.result.wrong_codes_last_24h);
for (let i = 0; i < 2; i++) { r = await c("server_admin_request", { command: "true", reason: "g" }); }
r = await c("server_admin_approve", { request_id: r.result.request_id, code: lastCode() }); assert.equal(r.error.code, "APPROVALS_LOCKED", JSON.stringify(r)); console.log("GLOBAL lockout ok");
fs.rmSync("admin/failures.json");
// delivery failure
fs.writeFileSync("run/pcg_fail", "1"); r = await c("server_admin_request", { command: "true", reason: "f" }); assert.equal(r.error.code, "TELEGRAM_DELIVERY_FAILED"); fs.rmSync("run/pcg_fail"); console.log("DELIVERY fail ok", r.error.message);
// download link through the http emit hook
fs.writeFileSync("run/big.bin", crypto.randomBytes(1300000));
r = await c("server_file_link", { path: "/tmp/cfit/run/big.bin", ttl_s: 60 }); assert.equal(r.state, "ACHIEVED", JSON.stringify(r)); const key = r.result.url.split("/").pop();
const hs = http.createServer((q, s) => { s.writeHead(418); s.end("fallthrough"); }); await new Promise(s => hs.listen(0, s)); const port = hs.address().port;
const get = (p) => new Promise((res, rej) => http.get({ port, path: p }, (x) => { const ch = []; x.on("data", d => ch.push(d)); x.on("end", () => res({ status: x.statusCode, body: Buffer.concat(ch), h: x.headers })); }).on("error", rej));
let g = await get("/mcp/cf-ops-file/" + key); assert.equal(g.status, 200); assert.ok(g.body.equals(fs.readFileSync("run/big.bin"))); console.log("LINK ok", g.body.length, g.h["content-disposition"]);
g = await get("/mcp/cf-ops-file/" + "0".repeat(64)); assert.equal(g.status, 404); g = await get("/other"); assert.equal(g.status, 418); console.log("LINK 404/fallthrough ok");
hs.close();
// caller identity (ChatGPT subject + OAuth bearer)
console.log("ID none", callerIdentity({}));
const sd = process.env.ONSHAPE_AGENT_STATE_DIR; const key2 = fs.readFileSync(sd + "/owner-auth/subject-hmac.key");
console.log("ID chatgpt", callerIdentity({ _meta: { "openai/subject": "user-abc" } }));
console.log("ID oauth", callerIdentity({ requestInfo: { headers: { authorization: "Bearer " + "ab".repeat(32) } } }));
console.log("ID oauth unknown", callerIdentity({ requestInfo: { headers: { authorization: "Bearer " + "cd".repeat(32) } } }));
console.log("ALL_PASS"); process.exit(0);
