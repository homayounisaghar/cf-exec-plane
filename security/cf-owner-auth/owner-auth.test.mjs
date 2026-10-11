import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOwnerAuthGate, observedCallerIdentity, registerOwnerAuthTools } from "./owner-auth.mjs";

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-owner-auth-"));
  return createOwnerAuthGate({ stateDir, buildId: "test" });
}
function call(name, subject, organization) {
  const meta = {};
  if (subject) meta["openai/subject"] = subject;
  if (organization) meta["openai/organization"] = organization;
  return { method: "tools/call", params: { name, _meta: meta } };
}

test("starts observe and fingerprint is stable", () => {
  const gate = fixture();
  assert.equal(gate.readState().mode, "observe");
  assert.equal(gate.subjectFingerprint("a"), gate.subjectFingerprint("a"));
  assert.notEqual(gate.subjectFingerprint("a"), gate.subjectFingerprint("b"));
});

test("disabled and observe never block existing tools", async () => {
  const gate = fixture();
  assert.equal(gate.authorizeToolCall(call("telegram_message_list", null)).allowed, true);
  const owner = gate.subjectFingerprint("owner-a");
  await gate.adminBootstrap({ ownerFingerprints: [owner], mode: "observe" });
  assert.equal(gate.authorizeToolCall(call("whatsapp_conversation_list", "other")).allowed, true);
});

test("enforce requires an authorized subject", async () => {
  const gate = fixture();
  const owner = gate.subjectFingerprint("owner-a");
  await gate.adminBootstrap({ ownerFingerprints: [owner], mode: "enforce" });
  assert.equal(gate.authorizeToolCall(call("onshape_status", null)).code, "CF_OWNER_AUTH_SUBJECT_REQUIRED");
  assert.equal(gate.authorizeToolCall(call("onshape_status", "other")).code, "CF_OWNER_AUTH_FORBIDDEN");
  assert.equal(gate.authorizeToolCall(call("onshape_status", "owner-a")).allowed, true);
});

test("status is available for onboarding while enforce is active", async () => {
  const gate = fixture();
  await gate.adminBootstrap({ ownerFingerprints: [gate.subjectFingerprint("owner-a")], mode: "enforce" });
  assert.equal(gate.authorizeToolCall(call("cf_auth_status", "new-owner")).allowed, true);
  const status = await gate.status({ "openai/subject": "new-owner" });
  assert.match(status.caller.subject_fingerprint, /^cfsub_[0-9a-f]{64}$/);
  assert.equal(status.caller.is_owner, false);
});

test("multiple owners are supported and only owners can mutate owner state", async () => {
  const gate = fixture();
  const a = gate.subjectFingerprint("owner-a");
  const b = gate.subjectFingerprint("owner-b");
  await gate.adminBootstrap({ ownerFingerprints: [a], mode: "enforce" });
  await assert.rejects(() => gate.addOwner({ "openai/subject": "other" }, b), e => e?.code === "CF_OWNER_AUTH_OWNER_REQUIRED");
  const added = await gate.addOwner({ "openai/subject": "owner-a" }, b, "B");
  assert.equal(added.owner_count, 2);
  assert.equal(gate.authorizeToolCall(call("bale_message_list", "owner-b")).allowed, true);
});

test("last owner cannot be removed through MCP", async () => {
  const gate = fixture();
  const a = gate.subjectFingerprint("owner-a");
  await gate.adminBootstrap({ ownerFingerprints: [a], mode: "enforce" });
  await assert.rejects(() => gate.removeOwner({ "openai/subject": "owner-a" }, a), e => e?.code === "CF_OWNER_AUTH_LAST_OWNER");
});

test("organization pin is optional and fail-closed when configured", async () => {
  const gate = fixture();
  const owner = gate.subjectFingerprint("owner-a");
  const org = gate.organizationFingerprint("org-a");
  await gate.adminBootstrap({ ownerFingerprints: [owner], organizationFingerprints: [org], mode: "enforce" });
  assert.equal(gate.authorizeToolCall(call("onshape_status", "owner-a")).code, "CF_OWNER_AUTH_ORGANIZATION_FORBIDDEN");
  assert.equal(gate.authorizeToolCall(call("onshape_status", "owner-a", "org-a")).allowed, true);
});

const zChain = { regex() { return this; }, trim() { return this; }, min() { return this; }, max() { return this; }, optional() { return this; } };
const zStub = { string: () => zChain, enum: () => zChain };

test("cf_whoami registration is read-only and returns diagnostic shapes without identity", async () => {
  const registered = new Map();
  registerOwnerAuthTools({ registerTool: (name, spec, fn) => registered.set(name, { spec, fn }) }, zStub, fixture(), (_, fn) => fn());
  assert.equal(registered.size, 5);
  const tool = registered.get("cf_whoami");
  assert.deepEqual(tool.spec.inputSchema, {});
  assert.deepEqual(tool.spec.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  const result = (await tool.fn({}, {})).structuredContent;
  assert.equal(result.available, true);
  assert.equal(result.schema, "cf_whoami.shape.v1");
  assert.equal(result.mcp_metadata.present, false);
  assert.equal(result.mcp_metadata.fields["openai/subject"].present, false);
  assert.equal(result.auth_info.present, false);
  assert.equal(result.forwarded_http_headers.observable, false);
});

test("cf_whoami exposes only redacted presence, type, and length for all metadata keys", () => {
  const gate = fixture();
  const first = observedCallerIdentity(gate, {
    _meta: { "openai/subject": "opaque-chat-subject", "openai/organization": "opaque-org",
      "notion/workspace_id": "abc-workspace", count: 1, keyz: ["a","b"], silent: null },
  });
  assert.equal(first.available, true);
  const m=first.mcp_metadata.fields;
  assert.deepEqual(m["openai/subject"], { present: true, type: "string", length: 19, value: "REDACTED" });
  assert.equal(m["openai/organization"].type, "string");
  assert.equal(m["notion/workspace_id"].value, "REDACTED");
  assert.equal(m.count.type, "number");
  assert.equal(m.keyz.length, 2);
  assert.equal(m.silent.type, "null");
  const encoded=JSON.stringify(first);
  for(const secret of ["opaque-chat-subject","opaque-org","abc-workspace"]) assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes(gate.subjectFingerprint("opaque-chat-subject")), false);
});

test("cf_whoami reports auth claim KEYS and HTTP header NAMES, never values", async () => {
  const gate = fixture();
  const registered=new Map();
  registerOwnerAuthTools({ registerTool: (name, spec, fn) => registered.set(name, fn) }, zStub, gate, (_, fn) => fn());
  const output=await registered.get("cf_whoami")({}, {
    _meta: { token:"meta-token-secret" },
    authInfo: {
      token:"Bearer raw-auth-secret",
      clientId:"verified-client",
      scopes:["read:identity"],
      extra: {iss:"issuer-original",aud:["aud-1"],sub:"notion-agent-id",
        client_secret:"another-secret",client_id:"secret-client-id"},
    },
    requestInfo: {headers: {
      authorization:"Bearer http-secret",
      "x-notion-workspace-id":"work-secret",
      "x-connector-id":"connector-secret",
    }},
  });
  const d=output.structuredContent;
  assert.deepEqual(d,JSON.parse(output.content[0].text));
  assert.equal(d.auth_info.present,true);
  assert.equal(d.auth_info.claims.clientId.type,"string");
  assert.equal(d.auth_info.claims.token.value,"REDACTED");
  assert.deepEqual(d.auth_info.extra.key_names,["aud","client_id","client_secret","iss","sub"]);
  assert.equal(d.auth_info.extra.claims.iss.type,"string");
  assert.deepEqual(d.forwarded_http_headers.names,["authorization","x-connector-id","x-notion-workspace-id"]);
  assert.deepEqual(d.forwarded_http_headers.sources,["requestInfo.headers"]);
  assert.deepEqual(d.request_info_keys,["headers"]);
  const serialized=JSON.stringify(output);
  for(const secret of ["meta-token-secret","raw-auth-secret","verified-client","issuer-original",
    "aud-1","notion-agent-id","another-secret","secret-client-id","http-secret","work-secret",
    "connector-secret","read:identity"]) assert.equal(serialized.includes(secret),false,secret);
});

test("cf_whoami is exempt in enforce but all other tools retain owner gate", async () => {
  const gate=fixture();
  await gate.adminBootstrap({ownerFingerprints:[gate.subjectFingerprint("owner")],mode:"enforce"});
  assert.equal(gate.authorizeToolCall(call("cf_auth_status", null)).allowed, true);
  assert.equal(gate.authorizeToolCall(call("cf_whoami", null)).allowed, true);
  assert.equal(gate.authorizeToolCall(call("cf_whoami", "visitor")).allowed, true);
  assert.equal(gate.authorizeToolCall(call("onshape_status", null)).code, "CF_OWNER_AUTH_SUBJECT_REQUIRED");
  assert.equal(gate.authorizeToolCall(call("telegram_message_list", "visitor")).code,"CF_OWNER_AUTH_FORBIDDEN");
  assert.equal(gate.authorizeToolCall(call("cf_auth_owner_add", null)).code,"CF_OWNER_AUTH_SUBJECT_REQUIRED");
  assert.equal(gate.authorizeToolCall(call("cf_auth_owner_remove", "visitor")).code,"CF_OWNER_AUTH_FORBIDDEN");
  assert.equal(gate.authorizeToolCall(call("cf_auth_mode_set", "visitor")).code,"CF_OWNER_AUTH_FORBIDDEN");
  assert.equal(gate.readState().mode,"enforce");
  assert.equal(gate.readState().owners.length,1);
  const notion=observedCallerIdentity(gate,{_meta:{"notion/workspace":"stable-opaque-value"}});
  assert.equal(notion.available,true);
  assert.equal(notion.mcp_metadata.fields["openai/subject"].present,false);
  assert.equal(notion.mcp_metadata.fields["notion/workspace"].type,"string");
  assert.equal(JSON.stringify(notion).includes("stable-opaque-value"),false);
});
