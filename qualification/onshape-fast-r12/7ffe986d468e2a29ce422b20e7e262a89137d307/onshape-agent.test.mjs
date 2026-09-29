import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OnshapeAgent } from "./onshape-agent.js";

const DID = "0123456789abcdef01234567";
const WID = "111111111111111111111111";

function writeSpec(dir) {
  const file = path.join(dir, "openapi.json");
  fs.writeFileSync(file, JSON.stringify({
    openapi: "3.0.0",
    info: { version: "test-v1" },
    servers: [{ url: "https://cad.onshape.com/api/v17" }],
    paths: {
      "/documents/{did}": {
        get: {
          operationId: "getDocument",
          summary: "Get document",
          parameters: [{ name: "did", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { content: { "application/json": {} } } },
        },
        post: {
          operationId: "updateDocumentAttributes",
          summary: "Update document attributes",
          parameters: [{ name: "did", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
      "/partstudios/d/{did}/w/{wid}": {
        post: {
          operationId: "createPartStudio",
          summary: "Create Part Studio",
          parameters: ["did", "wid"].map((name) => ({
            name, in: "path", required: true, schema: { type: "string" },
          })),
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
      "/partstudios/d/{did}/w/{wid}/e/{eid}/featurescript": {
        post: {
          operationId: "evalFeatureScript",
          summary: "Evaluate FeatureScript",
          parameters: ["did", "wid", "eid"].map((name) => ({
            name, in: "path", required: true, schema: { type: "string" },
          })),
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
      "/companies/{cid}/members/invite": {
        post: {
          operationId: "inviteCompanyMember",
          summary: "Invite company member",
          parameters: [{ name: "cid", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
    },
  }));
  return file;
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "onshape-direct-"));
  const openApiFile = writeSpec(dir);
  const calls = [];
  let documentName = "Before";

  const core = {
    async request(method, requestPath, query, body, options) {
      calls.push({ method, requestPath, query, body, options });
      if (body?.forceTransportFailure === true) {
        const error = new Error("simulated transport failure");
        error.code = "SIMULATED_TRANSPORT";
        throw error;
      }

      const headers = { "x-api-version": "v17" };
      if (method === "POST" && requestPath === `/api/v17/documents/${DID}`) {
        if (body && typeof body.name === "string") documentName = body.name;
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { id: DID, name: documentName },
          durationMs: 12,
          pool_execution: { duration_ms: 12, api_minimum_interval_ms: 1000 },
          schedulerTiming: { queue_wait_ms: 2, pacing_wait_ms: 3, execution_ms: 7 },
        };
      }
      if (method === "GET" && requestPath === `/api/v17/documents/${DID}`) {
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { id: DID, name: documentName },
          durationMs: 5,
          schedulerTiming: { queue_wait_ms: 0, pacing_wait_ms: 0, execution_ms: 5 },
        };
      }
      if (method === "POST" && requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}`) {
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { id: "222222222222222222222222", name: body?.name || "Part Studio 1" },
          durationMs: 10,
          schedulerTiming: { queue_wait_ms: 1, pacing_wait_ms: 2, execution_ms: 7 },
        };
      }
      if (method === "POST" && requestPath.includes("/featurescript")) {
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { result: 42 },
          durationMs: 4,
          schedulerTiming: { queue_wait_ms: 0, pacing_wait_ms: 0, execution_ms: 4 },
        };
      }
      if (method === "POST" && requestPath === "/api/v17/companies/acme/members/invite") {
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { invited: true },
          durationMs: 8,
          schedulerTiming: { queue_wait_ms: 0, pacing_wait_ms: 1, execution_ms: 7 },
        };
      }
      return {
        ok: false,
        http: 404,
        responseHeaders: headers,
        reason: "not found",
        layer: "provider",
      };
    },
  };

  const agent = new OnshapeAgent({
    core,
    openApiFile,
    stateDir: path.join(dir, "agent-state"),
    buildId: "test-fast-r12",
    allowedOpenApiRoot: dir,
  });
  return { dir, agent, calls };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("startup registry preindexes all operations and deterministic aliases", () => {
  const { dir, agent } = fixture();
  try {
    const registry = agent.operationRegistry();
    assert.equal(registry.count, 5);
    assert.equal(registry.resolution, "startup-preindexed");
    assert.equal(agent.resolveOperation("getDocument").operationId, "getDocument");
    assert.equal(agent.resolveOperation("get document").operationId, "getDocument");
    assert.equal(agent.resolveOperation("create part studio").operationId, "createPartStudio");
    assert.equal(agent.resolveOperation("createPartStudio").riskClass, "ORDINARY_WRITE");
    assert.equal(agent.resolveOperation("inviteCompanyMember").riskClass, "HIGH_IMPACT");
    assert.equal(agent.resolveOperation("evalFeatureScript").riskClass, "READ");
  } finally {
    cleanup(dir);
  }
});

test("documented read executes directly from the preindexed contract", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeDocumentedOperation({
      operationId: "getDocument",
      pathParams: { did: DID },
      requestId: "req-read-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.effectSent, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestPath, `/api/v17/documents/${DID}`);
    assert.ok(result.timing.total_ms >= 0);
    assert.ok(result.timing.registry_ms >= 0);
    assert.ok(result.timing.provider_ms >= 0);
  } finally {
    cleanup(dir);
  }
});

test("ordinary write needs no guard or second authorization and uses proportionate readback", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeDocumentedOperation({
      operationId: "updateDocumentAttributes",
      pathParams: { did: DID },
      body: { name: "After" },
      requestId: "req-write-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.operationRiskClass, "ORDINARY_WRITE");
    assert.equal(result.evidence.providerAcknowledged, true);
    assert.equal(result.evidence.verification.kind, "document_name_equals");
    assert.equal(result.evidence.verification.verified, true);
    assert.equal(calls.filter((x) => x.method === "POST").length, 1);
    assert.equal(calls.filter((x) => x.method === "GET").length, 1);
  } finally {
    cleanup(dir);
  }
});

test("ordinary write without a special verifier uses provider acknowledgement only", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeDocumentedOperation({
      operationId: "createPartStudio",
      pathParams: { did: DID, wid: WID },
      body: { name: "Fast Studio" },
      requestId: "req-create-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.operationRiskClass, "ORDINARY_WRITE");
    assert.equal(result.evidence.verification.kind, "provider_acknowledged");
    assert.equal(result.evidence.verification.verified, true);
    assert.equal(calls.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("semantic read-only POST does not become a mutation because of HTTP method", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeDocumentedOperation({
      operationId: "evalFeatureScript",
      pathParams: {
        did: DID,
        wid: WID,
        eid: "222222222222222222222222",
      },
      body: { script: "return 42;" },
      requestId: "req-fs-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.operationRiskClass, "READ");
    assert.equal(result.evidence.effectSent, false);
    assert.equal(calls.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("high-impact operation requires explicit owner intent but only once", async () => {
  const { dir, agent, calls } = fixture();
  try {
    await assert.rejects(
      () => agent.executeDocumentedOperation({
        operationId: "inviteCompanyMember",
        pathParams: { cid: "acme" },
        body: { email: "person@example.com" },
        requestId: "req-high-1",
      }),
      /explicit owner intent/i,
    );
    assert.equal(calls.length, 0);

    const result = await agent.executeDocumentedOperation({
      operationId: "inviteCompanyMember",
      pathParams: { cid: "acme" },
      body: { email: "person@example.com" },
      ownerConfirmedHighImpact: true,
      requestId: "req-high-2",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.operationRiskClass, "HIGH_IMPACT");
    assert.equal(calls.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("same request id is journal-deduplicated without a second provider call", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const request = {
      operationId: "createPartStudio",
      pathParams: { did: DID, wid: WID },
      body: { name: "Once" },
      requestId: "req-dedupe-1",
    };
    const first = await agent.executeDocumentedOperation(request);
    const second = await agent.executeDocumentedOperation(request);
    assert.equal(first.state, "SUCCEEDED");
    assert.equal(second.state, "SUCCEEDED");
    assert.equal(second.replayedFromJournal, true);
    assert.equal(calls.length, 1);

    await assert.rejects(
      () => agent.executeDocumentedOperation({ ...request, body: { name: "Different" } }),
      /reused for a different/i,
    );
    assert.equal(calls.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("ambiguous write is recorded UNCERTAIN and the same request id is never replayed", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const request = {
      operationId: "createPartStudio",
      pathParams: { did: DID, wid: WID },
      body: { name: "Maybe", forceTransportFailure: true },
      requestId: "req-uncertain-1",
    };
    const first = await agent.executeDocumentedOperation(request);
    assert.equal(first.state, "UNCERTAIN");
    assert.equal(first.evidence.blindReplayAllowed, false);
    assert.equal(calls.length, 1);

    const second = await agent.executeDocumentedOperation(request);
    assert.equal(second.state, "UNCERTAIN");
    assert.equal(second.replayedFromJournal, true);
    assert.equal(calls.length, 1);
  } finally {
    cleanup(dir);
  }
});
