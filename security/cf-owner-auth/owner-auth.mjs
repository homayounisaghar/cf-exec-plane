import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "capability-fabric.owner-auth.v1";
const MODES = new Set(["disabled", "observe", "enforce"]);
const SUBJECT_RE = /^cfsub_[0-9a-f]{64}$/;
const ORG_RE = /^cforg_[0-9a-f]{64}$/;

function nowIso() {
  return new Date().toISOString();
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeLabel(label) {
  if (label == null) return null;
  const value = String(label).trim();
  if (!value) return null;
  if (value.length > 80) throw codedError("CF_OWNER_AUTH_LABEL_INVALID", "Owner label is too long.");
  return value;
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("CF_OWNER_AUTH_STATE_INVALID", "Owner auth state must be an object.");
  }
  if (value.schema !== SCHEMA || !MODES.has(value.mode) || !Array.isArray(value.owners)) {
    throw codedError("CF_OWNER_AUTH_STATE_INVALID", "Owner auth state schema or mode is invalid.");
  }
  const owners = value.owners.map((entry) => {
    if (!entry || typeof entry !== "object" || !SUBJECT_RE.test(String(entry.subject_fingerprint || ""))) {
      throw codedError("CF_OWNER_AUTH_STATE_INVALID", "Owner auth state contains an invalid owner fingerprint.");
    }
    return {
      subject_fingerprint: String(entry.subject_fingerprint),
      label: entry.label == null ? null : normalizeLabel(entry.label),
      added_at: typeof entry.added_at === "string" ? entry.added_at : null,
      added_by_fingerprint: entry.added_by_fingerprint == null ? null : String(entry.added_by_fingerprint),
    };
  });
  const seen = new Set();
  for (const owner of owners) {
    if (seen.has(owner.subject_fingerprint)) {
      throw codedError("CF_OWNER_AUTH_STATE_INVALID", "Owner auth state contains a duplicate owner fingerprint.");
    }
    seen.add(owner.subject_fingerprint);
  }
  const organizations = Array.isArray(value.organization_fingerprints)
    ? value.organization_fingerprints.map((item) => String(item))
    : [];
  if (organizations.some((item) => !ORG_RE.test(item))) {
    throw codedError("CF_OWNER_AUTH_STATE_INVALID", "Owner auth state contains an invalid organization fingerprint.");
  }
  return {
    schema: SCHEMA,
    mode: value.mode,
    owners,
    organization_fingerprints: [...new Set(organizations)],
    created_at: typeof value.created_at === "string" ? value.created_at : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function createOwnerAuthGate({ stateDir, buildId = "unknown" }) {
  if (!stateDir || !path.isAbsolute(stateDir)) {
    throw codedError("CF_OWNER_AUTH_STATE_DIR_INVALID", "Owner auth state directory must be absolute.");
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const keyFile = path.join(stateDir, "subject-hmac.key");
  const stateFile = path.join(stateDir, "state.json");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw codedError("CF_OWNER_AUTH_KEY_INVALID", "Owner auth HMAC key is invalid.");
  if (!fs.existsSync(stateFile)) {
    const created = nowIso();
    atomicWriteJson(stateFile, {
      schema: SCHEMA,
      mode: "disabled",
      owners: [],
      organization_fingerprints: [],
      created_at: created,
      updated_at: created,
    });
  }

  const observed = new Set();
  let mutationTail = Promise.resolve();

  function fingerprint(prefix, domain, value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const digest = crypto.createHmac("sha256", key).update(`${domain}\0${value}`).digest("hex");
    return `${prefix}_${digest}`;
  }

  function subjectFingerprint(subject) {
    return fingerprint("cfsub", "openai/subject", subject);
  }

  function organizationFingerprint(organization) {
    return fingerprint("cforg", "openai/organization", organization);
  }

  function identity(meta) {
    const subject = typeof meta?.["openai/subject"] === "string" ? meta["openai/subject"] : null;
    const organization = typeof meta?.["openai/organization"] === "string" ? meta["openai/organization"] : null;
    return {
      subject_fingerprint: subjectFingerprint(subject),
      organization_fingerprint: organizationFingerprint(organization),
      has_subject: Boolean(subject),
      has_organization: Boolean(organization),
    };
  }

  function readState() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch (cause) {
      const error = codedError("CF_OWNER_AUTH_STATE_INVALID", "Owner auth state could not be read.");
      error.cause = cause;
      throw error;
    }
    return validateState(parsed);
  }

  function writeState(state) {
    const checked = validateState(state);
    checked.updated_at = nowIso();
    if (!checked.created_at) checked.created_at = checked.updated_at;
    atomicWriteJson(stateFile, checked);
    return checked;
  }

  function isOwner(state, subjectFp) {
    if (!subjectFp) return false;
    return state.owners.some((owner) => owner.subject_fingerprint === subjectFp);
  }

  function organizationAllowed(state, organizationFp) {
    if (!state.organization_fingerprints.length) return true;
    return Boolean(organizationFp && state.organization_fingerprints.includes(organizationFp));
  }

  function observe(meta, toolName) {
    const caller = identity(meta);
    const keyValue = `${caller.subject_fingerprint || "missing"}:${caller.organization_fingerprint || "missing"}`;
    if (observed.has(keyValue)) return;
    observed.add(keyValue);
    if (observed.size > 256) observed.delete(observed.values().next().value);
    console.log(JSON.stringify({
      event: "cf_owner_auth_observe",
      build_id: buildId,
      tool: toolName || null,
      subject_fingerprint: caller.subject_fingerprint,
      organization_fingerprint: caller.organization_fingerprint,
    }));
  }

  function authorizeToolCall(rpc) {
    if (!rpc || rpc.method !== "tools/call") return { allowed: true, mode: null };
    const toolName = typeof rpc?.params?.name === "string" ? rpc.params.name : null;
    if (toolName === "cf_auth_status") return { allowed: true, mode: "status-exempt" };
    let state;
    try {
      state = readState();
    } catch (error) {
      return { allowed: false, mode: "invalid", code: error.code || "CF_OWNER_AUTH_STATE_INVALID" };
    }
    const caller = identity(rpc?.params?._meta);
    if (state.mode === "disabled") return { allowed: true, mode: state.mode, caller };
    if (state.mode === "observe") {
      observe(rpc?.params?._meta, toolName);
      return { allowed: true, mode: state.mode, caller };
    }
    if (!caller.subject_fingerprint) {
      return { allowed: false, mode: state.mode, code: "CF_OWNER_AUTH_SUBJECT_REQUIRED", caller };
    }
    if (!isOwner(state, caller.subject_fingerprint)) {
      return { allowed: false, mode: state.mode, code: "CF_OWNER_AUTH_FORBIDDEN", caller };
    }
    if (!organizationAllowed(state, caller.organization_fingerprint)) {
      return { allowed: false, mode: state.mode, code: "CF_OWNER_AUTH_ORGANIZATION_FORBIDDEN", caller };
    }
    return { allowed: true, mode: state.mode, caller };
  }

  function deniedRpc(id, decision = {}) {
    const code = String(decision.code || "CF_OWNER_AUTH_FORBIDDEN");
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            build_id: buildId,
            status: "FAILED",
            error: {
              layer: "authorization",
              code,
              message: "This CF-server capability is restricted to authorized owners.",
            },
          }),
        }],
        isError: true,
      },
    };
  }

  function ownerRequired(meta) {
    const state = readState();
    const caller = identity(meta);
    if (!caller.subject_fingerprint || !isOwner(state, caller.subject_fingerprint)) {
      throw codedError("CF_OWNER_AUTH_OWNER_REQUIRED", "Only an authorized owner may change owner authorization state.");
    }
    if (!organizationAllowed(state, caller.organization_fingerprint)) {
      throw codedError("CF_OWNER_AUTH_ORGANIZATION_FORBIDDEN", "The caller organization is not allowed by owner authorization state.");
    }
    return { state, caller };
  }

  function mutate(fn) {
    const run = mutationTail.then(fn, fn);
    mutationTail = run.catch(() => {});
    return run;
  }

  async function status(meta) {
    const state = readState();
    const caller = identity(meta);
    const owner = isOwner(state, caller.subject_fingerprint);
    return {
      schema: SCHEMA,
      mode: state.mode,
      enforcement_active: state.mode === "enforce",
      owner_count: state.owners.length,
      caller: {
        subject_fingerprint: caller.subject_fingerprint,
        organization_fingerprint: caller.organization_fingerprint,
        is_owner: owner,
        organization_allowed: organizationAllowed(state, caller.organization_fingerprint),
      },
      bootstrap_required: state.owners.length === 0,
      organization_pin_count: state.organization_fingerprints.length,
      note: "Authorization uses anonymized ChatGPT subject metadata behind the existing secret MCP endpoint. Proper OAuth remains the long-term authentication boundary.",
    };
  }

  async function addOwner(meta, subjectFp, label = null) {
    return mutate(async () => {
      const { state, caller } = ownerRequired(meta);
      const value = String(subjectFp || "").trim();
      if (!SUBJECT_RE.test(value)) throw codedError("CF_OWNER_AUTH_FINGERPRINT_INVALID", "Owner fingerprint is invalid.");
      if (state.owners.some((owner) => owner.subject_fingerprint === value)) {
        return { changed: false, owner_count: state.owners.length, subject_fingerprint: value };
      }
      state.owners.push({
        subject_fingerprint: value,
        label: normalizeLabel(label),
        added_at: nowIso(),
        added_by_fingerprint: caller.subject_fingerprint,
      });
      const updated = writeState(state);
      return { changed: true, owner_count: updated.owners.length, subject_fingerprint: value };
    });
  }

  async function removeOwner(meta, subjectFp) {
    return mutate(async () => {
      const { state } = ownerRequired(meta);
      const value = String(subjectFp || "").trim();
      if (!SUBJECT_RE.test(value)) throw codedError("CF_OWNER_AUTH_FINGERPRINT_INVALID", "Owner fingerprint is invalid.");
      const index = state.owners.findIndex((owner) => owner.subject_fingerprint === value);
      if (index < 0) return { changed: false, owner_count: state.owners.length, subject_fingerprint: value };
      if (state.owners.length === 1) {
        throw codedError("CF_OWNER_AUTH_LAST_OWNER", "The final owner cannot be removed through MCP. Use the root recovery path.");
      }
      state.owners.splice(index, 1);
      const updated = writeState(state);
      return { changed: true, owner_count: updated.owners.length, subject_fingerprint: value };
    });
  }

  async function setMode(meta, mode) {
    return mutate(async () => {
      const { state } = ownerRequired(meta);
      const value = String(mode || "");
      if (!MODES.has(value)) throw codedError("CF_OWNER_AUTH_MODE_INVALID", "Owner auth mode is invalid.");
      if (value === "enforce" && state.owners.length < 1) {
        throw codedError("CF_OWNER_AUTH_NO_OWNER", "At least one owner is required before enforcement can be enabled.");
      }
      const changed = state.mode !== value;
      state.mode = value;
      const updated = writeState(state);
      return { changed, mode: updated.mode, owner_count: updated.owners.length };
    });
  }

  async function adminBootstrap({ ownerFingerprints, organizationFingerprints = [], mode = "enforce" }) {
    const owners = [...new Set((ownerFingerprints || []).map((item) => String(item).trim()))];
    if (!owners.length || owners.some((item) => !SUBJECT_RE.test(item))) {
      throw codedError("CF_OWNER_AUTH_BOOTSTRAP_OWNER_INVALID", "Bootstrap requires at least one valid owner fingerprint.");
    }
    const organizations = [...new Set((organizationFingerprints || []).map((item) => String(item).trim()).filter(Boolean))];
    if (organizations.some((item) => !ORG_RE.test(item))) {
      throw codedError("CF_OWNER_AUTH_BOOTSTRAP_ORGANIZATION_INVALID", "Bootstrap organization fingerprint is invalid.");
    }
    if (!MODES.has(mode) || mode === "disabled") {
      throw codedError("CF_OWNER_AUTH_BOOTSTRAP_MODE_INVALID", "Bootstrap mode must be observe or enforce.");
    }
    const existing = readState();
    const createdAt = existing.created_at || nowIso();
    const next = {
      schema: SCHEMA,
      mode,
      owners: owners.map((subject_fingerprint) => ({
        subject_fingerprint,
        label: null,
        added_at: nowIso(),
        added_by_fingerprint: "root-bootstrap",
      })),
      organization_fingerprints: organizations,
      created_at: createdAt,
      updated_at: nowIso(),
    };
    const updated = writeState(next);
    return { mode: updated.mode, owner_count: updated.owners.length, organization_pin_count: updated.organization_fingerprints.length };
  }

  async function adminDisable() {
    const state = readState();
    state.mode = "disabled";
    const updated = writeState(state);
    return { mode: updated.mode, owner_count: updated.owners.length };
  }

  return {
    stateDir,
    stateFile,
    keyFile,
    subjectFingerprint,
    organizationFingerprint,
    authorizeToolCall,
    deniedRpc,
    status,
    addOwner,
    removeOwner,
    setMode,
    adminBootstrap,
    adminDisable,
    readState,
  };
}

export function registerOwnerAuthTools(server, z, gate, safeTool) {
  server.registerTool("cf_auth_status", {
    title: "CF-server owner authorization status",
    description: "Return this caller's anonymized owner fingerprint and current owner-authorization mode. This tool is intentionally available even to an unauthorized caller so a new owner can obtain a fingerprint for an existing owner to approve.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_args, { _meta }) => safeTool("authorization", async () => gate.status(_meta)));

  server.registerTool("cf_auth_owner_add", {
    title: "Add CF-server owner",
    description: "Add one ChatGPT subject fingerprint to the CF-server owner allowlist. Only an already-authorized owner may call this. The first owner must be bootstrapped out-of-band by the root recovery path.",
    inputSchema: {
      subject_fingerprint: z.string().regex(SUBJECT_RE),
      label: z.string().trim().min(1).max(80).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ subject_fingerprint, label }, { _meta }) => safeTool("authorization", async () => gate.addOwner(_meta, subject_fingerprint, label ?? null)));

  server.registerTool("cf_auth_owner_remove", {
    title: "Remove CF-server owner",
    description: "Remove one ChatGPT subject fingerprint from the CF-server owner allowlist. Only an authorized owner may call this. The final owner cannot be removed through MCP.",
    inputSchema: { subject_fingerprint: z.string().regex(SUBJECT_RE) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ subject_fingerprint }, { _meta }) => safeTool("authorization", async () => gate.removeOwner(_meta, subject_fingerprint)));

  server.registerTool("cf_auth_mode_set", {
    title: "Set CF-server owner authorization mode",
    description: "Set owner authorization mode to disabled, observe, or enforce. Only an authorized owner may call this. Enforcement requires at least one owner.",
    inputSchema: { mode: z.enum(["disabled", "observe", "enforce"]) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ mode }, { _meta }) => safeTool("authorization", async () => gate.setMode(_meta, mode)));
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const stateDir = process.env.CF_OWNER_AUTH_STATE_DIR || path.join(process.env.ONSHAPE_AGENT_STATE_DIR || "/agent-state", "owner-auth");
  const gate = createOwnerAuthGate({ stateDir, buildId: process.env.CF_BUILD_ID || "admin" });
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(gate.readState(), null, 2)}\n`);
    return;
  }
  if (command === "disable") {
    process.stdout.write(`${JSON.stringify(await gate.adminDisable())}\n`);
    return;
  }
  if (command === "bootstrap") {
    const owners = [];
    const organizations = [];
    let mode = "enforce";
    while (args.length) {
      const flag = args.shift();
      const value = args.shift();
      if (!value) throw codedError("CF_OWNER_AUTH_CLI_INVALID", `Missing value for ${flag}.`);
      if (flag === "--owner") owners.push(value);
      else if (flag === "--organization") organizations.push(value);
      else if (flag === "--mode") mode = value;
      else throw codedError("CF_OWNER_AUTH_CLI_INVALID", `Unknown flag ${flag}.`);
    }
    process.stdout.write(`${JSON.stringify(await gate.adminBootstrap({ ownerFingerprints: owners, organizationFingerprints: organizations, mode }))}\n`);
    return;
  }
  throw codedError("CF_OWNER_AUTH_CLI_USAGE", "Usage: owner-auth.mjs status | disable | bootstrap --owner <cfsub_...> [--owner ...] [--organization <cforg_...>] [--mode observe|enforce]");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runCli().catch((error) => {
    console.error(error?.code || "CF_OWNER_AUTH_CLI_ERROR", error?.message || String(error));
    process.exit(1);
  });
}
