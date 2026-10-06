import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOwnerAuthGate } from "./owner-auth.mjs";

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

test("starts disabled and fingerprint is stable", () => {
  const gate = fixture();
  assert.equal(gate.readState().mode, "disabled");
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
