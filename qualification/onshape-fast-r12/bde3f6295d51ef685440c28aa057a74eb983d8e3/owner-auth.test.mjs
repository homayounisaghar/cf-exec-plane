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

test("cf_whoami registration has no input and is strictly annotated read-only", async () => {
  const registered = new Map();
  registerOwnerAuthTools({ registerTool: (name, spec, fn) => registered.set(name, { spec, fn }) }, zStub, fixture(), (_, fn) => fn());
  assert.equal(registered.size, 5);
  const tool = registered.get("cf_whoami");
  assert.deepEqual(tool.spec.inputSchema, {});
  assert.deepEqual(tool.spec.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  const absent = (await tool.fn({}, {})).structuredContent;
  assert.deepEqual(absent, {
    available: false, reason: "No caller subject or principal ID in request-scoped MCP auth context",
  });
});

test("cf_whoami observes the immediate request and uses the existing owner fingerprint", () => {
  const gate = fixture();
  const first = observedCallerIdentity(gate, {
    _meta: { "openai/subject": "opaque-chat-subject", "openai/organization": "opaque-org", user_id: "" },
  });
  const next = observedCallerIdentity(gate, { _meta: { "openai/subject": "opaque-chat-subject" } });
  assert.equal(first.caller.subject, "opaque-chat-subject");
  assert.equal(first.caller.subject_fingerprint, gate.subjectFingerprint("opaque-chat-subject"));
  assert.equal(first.caller.subject_fingerprint, next.caller.subject_fingerprint);
  assert.equal(first.caller.organization_id, "opaque-org");
  assert.equal(first.caller.organization_fingerprint, gate.organizationFingerprint("opaque-org"));
  assert.equal(first.caller.user_id, "");
  assert.equal(first.caller.issuer, null);
  assert.equal(first.caller.auth_scheme, null);
  assert.equal(first.field_sources.subject, "mcp_request.params._meta.openai/subject");
  assert.equal(first.field_sources.issuer, null);
  assert.match(first.server_timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\./);
});

test("cf_whoami never returns raw token or arbitrary credential metadata", async () => {
  const gate = fixture();
  const registered = new Map();
  registerOwnerAuthTools({ registerTool: (name, spec, fn) => registered.set(name, fn) }, zStub, gate, (_, fn) => fn());
  const result = await registered.get("cf_whoami")({}, {
    _meta: { "openai/subject": "subject", token: "meta-token-secret", connector_id: "notion-c-1" },
    authInfo: {
      token: "Bearer raw-auth-secret",
      clientId: "verified-client",
      scopes: ["read:identity"],
      extra: { iss: "issuer-original", aud: ["aud-1"], jti: "token-jti", client_secret: "another-secret" },
    },
  });
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  assert.equal(result.structuredContent.caller.client_id, "verified-client");
  assert.equal(result.structuredContent.caller.issuer, "issuer-original");
  assert.deepEqual(result.structuredContent.caller.audience, ["aud-1"]);
  assert.equal(result.structuredContent.caller.token_id, "token-jti");
  assert.equal(result.structuredContent.caller.connector_id, "notion-c-1");
  assert.equal(result.structuredContent.caller.scopes[0], "read:identity");
  assert.equal(JSON.stringify(result).includes("raw-auth-secret"), false);
  assert.equal(JSON.stringify(result).includes("meta-token-secret"), false);
  assert.equal(JSON.stringify(result).includes("another-secret"), false);
});

test("cf_whoami does not change enforce owner authorization policy", async () => {
  const gate = fixture();
  await gate.adminBootstrap({ ownerFingerprints: [gate.subjectFingerprint("owner")], mode: "enforce" });
  assert.equal(gate.authorizeToolCall(call("cf_auth_status", "visitor")).allowed, true);
  assert.equal(gate.authorizeToolCall(call("cf_whoami", "visitor")).code, "CF_OWNER_AUTH_FORBIDDEN");
  assert.equal(gate.authorizeToolCall(call("cf_whoami", "owner")).allowed, true);
});
