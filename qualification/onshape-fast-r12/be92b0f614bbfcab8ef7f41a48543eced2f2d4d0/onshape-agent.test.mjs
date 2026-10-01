import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OnshapeAgent } from "./onshape-agent.js";

const DID = "0123456789abcdef01234567";
const WID = "111111111111111111111111";
const EID = "222222222222222222222222";
const PID = "JHD";

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
      "/partstudios/d/{did}/w/{wid}/e/{eid}/parts": {
        get: {
          operationId: "getPartsWMVE",
          summary: "Get parts in Part Studio",
          parameters: ["did", "wid", "eid"].map((name) => ({
            name, in: "path", required: true, schema: { type: "string" },
          })),
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
      "/partstudios/d/{did}/w/{wid}/e/{eid}/features": {
        get: {
          operationId: "getPartStudioFeatures",
          summary: "Get Part Studio features",
          parameters: ["did", "wid", "eid"].map((name) => ({
            name, in: "path", required: true, schema: { type: "string" },
          })),
          responses: { "200": { content: { "application/json": {} } } },
        },
        post: {
          operationId: "addPartStudioFeature",
          summary: "Add Part Studio feature",
          parameters: ["did", "wid", "eid"].map((name) => ({
            name, in: "path", required: true, schema: { type: "string" },
          })),
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
      "/partstudios/d/{did}/w/{wid}/e/{eid}/features/featureid/{fid}": {
        post: {
          operationId: "updatePartStudioFeature",
          summary: "Update Part Studio feature",
          parameters: ["did", "wid", "eid", "fid"].map((name) => ({
            name, in: "path", required: true, schema: { type: "string" },
          })),
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
      "/partstudios/d/{did}/w/{wid}/e/{eid}/featurespecs": {
        get: {
          operationId: "getPartStudioFeatureSpecs",
          summary: "Get feature specs",
          parameters: ["did", "wid", "eid"].map((name) => ({
            name, in: "path", required: true, schema: { type: "string" },
          })),
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
      "/partstudios/d/{did}/w/{wid}/e/{eid}/features/rollback": {
        post: {
          operationId: "updateRollback",
          summary: "Update rollback",
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
  const uiCalls = [];
  let documentName = "Before";
  let rollbackIndex = 1;
  let nextFeature = 2;
  let features = [{
    message: {
      btType: "BTMFeature-134",
      featureId: "F1",
      nodeId: "node-F1-initial",
      name: "Fillet 1",
      featureType: "fillet",
      suppressed: false,
      parameters: [{
        btType: "BTMParameterQuantity-147",
        parameterId: "radius",
        expression: "5 mm",
        nodeId: "node-radius-initial",
      }],
    },
  }];

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
      if (method === "GET" && requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}/e/${EID}/parts`) {
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: [{ partId: PID, name: "Part 1" }],
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
      if (method === "GET" && requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}/e/${EID}/features`) {
        const featureStates = Object.fromEntries(features.map((row) => [
          row.message.featureId,
          { featureStatus: "OK" },
        ]));
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: {
            serializationVersion: "1.2.3",
            sourceMicroversion: "mv-1",
            libraryVersion: 9,
            rollbackIndex,
            features: JSON.parse(JSON.stringify(features)),
            featureStates,
          },
          durationMs: 5,
          schedulerTiming: { queue_wait_ms: 0, pacing_wait_ms: 0, execution_ms: 5 },
        };
      }
      if (method === "GET" && requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}/e/${EID}/featurespecs`) {
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { featureSpecs: [
            { featureTypeName: "Plane", featureType: "cPlane", featureName: null, parameters: [{ btType: "BTParameterSpecQuantity-173", parameterId: "offset" }, { btType: "BTParameterSpecQuery-174", parameterId: "entities" }] },
            { featureTypeName: "Fillet", featureType: "fillet", featureName: null, parameters: [{ btType: "BTParameterSpecQuantity-173", parameterId: "radius" }] },
          ] },
          durationMs: 5,
          schedulerTiming: { queue_wait_ms: 0, pacing_wait_ms: 0, execution_ms: 5 },
        };
      }
      if (method === "POST" && requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}/e/${EID}/features`) {
        const id = `F${nextFeature++}`;
        const created = JSON.parse(JSON.stringify(body.feature));
        created.featureId = id;
        created.nodeId = `server-node-${id}`;
        for (const parameter of created.parameters || []) {
          parameter.nodeId = `server-node-${id}-${parameter.parameterId}`;
        }
        features.push({ message: created });
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { feature: { featureId: id } },
          durationMs: 6,
          schedulerTiming: { queue_wait_ms: 0, pacing_wait_ms: 0, execution_ms: 6 },
        };
      }
      if (method === "POST" && requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}/e/${EID}/features/featureid/F1`) {
        const updated = JSON.parse(JSON.stringify(body.feature));
        updated.featureId = "F1";
        updated.nodeId = "server-node-F1-regenerated";
        for (const parameter of updated.parameters || []) {
          parameter.nodeId = `server-node-F1-${parameter.parameterId}-regenerated`;
        }
        features = features.map((row) => row.message.featureId === "F1" ? { message: updated } : row);
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { feature: { featureId: "F1" } },
          durationMs: 6,
          schedulerTiming: { queue_wait_ms: 0, pacing_wait_ms: 0, execution_ms: 6 },
        };
      }
      if (method === "POST" && requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}/e/${EID}/features/rollback`) {
        rollbackIndex = body?.rollbackIndex === -1 ? features.length : body?.rollbackIndex;
        return {
          ok: true,
          http: 200,
          responseHeaders: headers,
          body: { rollbackIndex },
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
    async setPartVisibility(args) {
      uiCalls.push({ ...args });
      return {
        part_id: args.partId,
        part_name: args.partName,
        desired_visible: args.visible,
        acknowledgement: "INPUT_SEQUENCE_COMPLETED",
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
  return { dir, agent, calls, uiCalls };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("startup registry preindexes all operations and deterministic aliases", () => {
  const { dir, agent } = fixture();
  try {
    const registry = agent.operationRegistry();
    assert.equal(registry.count, 11);
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


test("semantic registry resolves ordinary human intents without operation-id guessing", () => {
  const { dir, agent } = fixture();
  try {
    const create = agent.resolveIntent("create part studio");
    assert.equal(create.contract.backend.kind, "DOCUMENTED_OPERATION");
    assert.equal(create.contract.backend.operationId, "createPartStudio");

    const rename = agent.resolveIntent("rename document");
    assert.equal(rename.contract.backend.operationId, "updateDocumentAttributes");

    const hide = agent.resolveIntent("hide Part");
    assert.equal(hide.contract.capabilityId, "part.visibility");
    assert.equal(hide.contract.backend.kind, "BOUNDED_UI");
    assert.equal(hide.defaults.visible, false);

    const show = agent.resolveIntent("show body");
    assert.equal(show.contract.capabilityId, "part.visibility");
    assert.equal(show.defaults.visible, true);

    const surface = agent.semanticCapabilitySurface();
    assert.equal(surface.resolution, "startup-precompiled-semantic");
    assert.match(surface.prompt, /do not guess operationIds/i);
    assert.match(surface.prompt, /hide part/i);
    assert.match(surface.prompt, /rename document/i);
  } finally {
    cleanup(dir);
  }
});

test("hide part resolves exact human target then dispatches bounded UI immediately", async () => {
  const { dir, agent, calls, uiCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "hide part",
      target: {
        document_id: DID,
        workspace_id: WID,
        element_id: EID,
        part_name: "Part 1",
      },
      requestId: "req-semantic-hide-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "part.visibility");
    assert.equal(result.semanticBackend, "BOUNDED_UI");
    assert.equal(result.evidence.target.partId, PID);
    assert.equal(result.evidence.target.partName, "Part 1");
    assert.equal(result.evidence.desiredVisible, false);
    assert.equal(result.evidence.targetResolutionOperationId, "getPartsWMVE");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(uiCalls.length, 1);
    assert.equal(uiCalls[0].partId, PID);
    assert.equal(uiCalls[0].visible, false);
    assert.ok(result.timing.intent_resolution_ms >= 0);
    assert.ok(result.timing.target_resolution_ms >= 0);
  } finally {
    cleanup(dir);
  }
});

test("semantic mutation request id deduplicates before repeating target read or UI effect", async () => {
  const { dir, agent, calls, uiCalls } = fixture();
  try {
    const request = {
      intent: "show part",
      target: {
        document_id: DID,
        workspace_id: WID,
        element_id: EID,
        part_id: PID,
      },
      requestId: "req-semantic-show-1",
    };
    const first = await agent.executeIntent(request);
    const second = await agent.executeIntent(request);
    assert.equal(first.state, "SUCCEEDED");
    assert.equal(second.state, "SUCCEEDED");
    assert.equal(second.replayedFromJournal, true);
    assert.equal(calls.length, 1);
    assert.equal(uiCalls.length, 1);
    assert.equal(uiCalls[0].visible, true);
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

test("feature.patch suppresses an exact feature and echoes the read identity", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "suppress feature",
      target: { document_id: DID, workspace_id: WID, element_id: EID, feature_name: "Fillet 1" },
      requestId: "req-patch-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "feature.patch");
    const write = calls.find((call) => call.requestPath.endsWith("/features/featureid/F1"));
    assert.equal(write.body.feature.suppressed, true);
    assert.equal(write.body.rejectMicroversionSkew, false);
    assert.equal(write.body.serializationVersion, "1.2.3");
    assert.equal(write.body.sourceMicroversion, "mv-1");
    assert.equal(result.evidence.postconditionVerified, true);
    assert.equal(result.evidence.verification.featureStatus, "OK");
  } finally {
    cleanup(dir);
  }
});

test("feature.patch rewrites a named parameter without touching the rest of the feature", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "edit feature",
      target: { document_id: DID, workspace_id: WID, element_id: EID, feature_name: "Fillet 1" },
      arguments: { parameters: { radius: "12 mm" }, new_name: "Fillet A" },
      requestId: "req-patch-2",
    });
    assert.equal(result.state, "SUCCEEDED");
    const write = calls.find((call) => call.requestPath.endsWith("/features/featureid/F1"));
    assert.equal(write.body.feature.name, "Fillet A");
    assert.equal(write.body.feature.parameters[0].expression, "12 mm");
    assert.equal(write.body.feature.featureId, "F1");
  } finally {
    cleanup(dir);
  }
});

test("feature.add clones a healthy Onshape-created reference and changes only qualified scalar values", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "add fillet",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { parameters: { radius: "12 mm" }, name: "Fillet Copy", suppressed: true },
      requestId: "req-add-reference-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "feature.add");
    assert.equal(result.derived.reference_feature_id, "F1");
    const write = calls.find((call) => call.method === "POST" && call.requestPath.endsWith("/features"));
    assert.equal(write.body.feature.btType, "BTMFeature-134");
    assert.equal(write.body.feature.featureType, "fillet");
    assert.equal(write.body.feature.name, "Fillet Copy");
    assert.equal(write.body.feature.suppressed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(write.body.feature, "featureId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(write.body.feature, "nodeId"), false);
    const radius = write.body.feature.parameters.find((item) => item.parameterId === "radius");
    assert.equal(radius.btType, "BTMParameterQuantity-147");
    assert.equal(radius.expression, "12 mm");
    assert.equal(Object.prototype.hasOwnProperty.call(radius, "nodeId"), false);
    assert.equal(write.body.serializationVersion, "1.2.3");
    assert.equal(write.body.sourceMicroversion, "mv-1");
    assert.equal(write.body.libraryVersion, 9);
    assert.equal(result.evidence.postconditionVerified, true);
    assert.equal(result.evidence.verification.featureStatus, "OK");
  } finally {
    cleanup(dir);
  }
});

test("feature.add refuses specs-only synthesis when no healthy reference exists", async () => {
  const { dir, agent, calls } = fixture();
  try {
    await assert.rejects(
      agent.executeIntent({
        intent: "add plane",
        target: { document_id: DID, workspace_id: WID, element_id: EID },
        arguments: { parameters: { offset: "30 mm" }, name: "Plane 1" },
        requestId: "req-add-reference-required",
      }),
      (error) => error.code === "ONSHAPE_REFERENCE_FEATURE_REQUIRED",
    );
    assert.equal(calls.filter((call) => call.method === "POST" && call.requestPath.endsWith("/features")).length, 0);
  } finally {
    cleanup(dir);
  }
});

test("feature.add refuses a feature type this Part Studio does not offer", async () => {
  const { dir, agent } = fixture();
  try {
    await assert.rejects(
      agent.executeIntent({
        intent: "add feature",
        target: { document_id: DID, workspace_id: WID, element_id: EID },
        arguments: { feature_type: "notARealFeature" },
        requestId: "req-add-2",
      }),
      (error) => error.code === "ONSHAPE_FEATURE_TYPE_UNKNOWN",
    );
  } finally {
    cleanup(dir);
  }
});

test("rollback.set converts a named anchor into an index", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "move rollback bar",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { before_feature: "Fillet 1" },
      requestId: "req-rollback-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    const write = calls.find((call) => call.requestPath.endsWith("/features/rollback"));
    assert.equal(write.body.rollbackIndex, 0);
    assert.equal(result.evidence.postconditionVerified, true);
    assert.equal(result.evidence.verification.kind, "partstudio_rollback_index_equals");
    assert.equal(result.evidence.verification.observedRollbackIndex, 0);
  } finally {
    cleanup(dir);
  }
});

test("rollback.set treats provider canonical end index as equivalent to requested -1", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "rollback to end",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      requestId: "req-rollback-end-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    const write = calls.find((call) => call.requestPath.endsWith("/features/rollback"));
    assert.equal(write.body.rollbackIndex, -1);
    assert.equal(result.evidence.postconditionVerified, true);
    assert.equal(result.evidence.verification.requestedRollbackIndex, -1);
    assert.equal(result.evidence.verification.expectedRollbackIndex, 1);
    assert.equal(result.evidence.verification.observedRollbackIndex, 1);
    assert.equal(result.evidence.verification.observedFeatureCount, 1);
  } finally {
    cleanup(dir);
  }
});
