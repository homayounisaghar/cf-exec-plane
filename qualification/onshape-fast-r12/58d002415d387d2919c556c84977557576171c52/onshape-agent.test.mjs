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
  const viewerCalls = [];
  const viewMoveCalls = [];
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
            { featureTypeName: "Fillet", featureType: "fillet", featureName: null, parameters: [{ btType: "BTParameterSpecQuery-174", parameterId: "entities", maxNumberOfPicks: -1 }, { btType: "BTParameterSpecQuantity-173", parameterId: "radius" }] },
            { featureTypeName: "Chamfer", featureType: "chamfer", featureName: null, parameters: [{ btType: "BTParameterSpecQuery-174", parameterId: "entities", maxNumberOfPicks: -1 }, { btType: "BTParameterSpecQuantity-173", parameterId: "width" }] },
            { featureTypeName: "Derived mirror", featureType: "derivedMirror", featureName: null, parameters: [{ btType: "BTParameterSpecReferencePartStudio-1256", parameterId: "partStudio" }] },
            { featureTypeName: "Derived", featureType: "importDerived", featureName: null, parameters: [{ btType: "BTParameterSpecReferencePartStudio-1256", parameterId: "partStudio" }] },
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
    async inspectViewer(args) {
      viewerCalls.push({ ...args });
      return {
        read_only: true,
        self_test: {
          viewer_module_id: 74266,
          viewer_export: "jM",
          viewer_instance_found: true,
          selection_model_available: true,
        },
        viewer: { ready: true, primary: true, element_id: args.elementId },
        camera: { width: 1440, height: 1000, perspective: false },
        view_data: { view_matrix: [1, 0, 0, 1], camera_viewport: [0, 0, 1440, 1000] },
        model_selection: { available: true, count: 0, selections: [] },
        ...(args.mode === "methods" ? {
          methods: {
            viewer: ["getViewData", "setViewData"],
            camera: ["getFrame", "setFrame"],
            selection: ["getSelection", "setSelection"],
          },
        } : {}),
        ...(args.mode === "method_details" ? {
          method_details: {
            movement_contracts: {
              viewer_rotate_in_direction_with_angle: { available: true, arity: 2, source: "rotateInDirectionWithAngle(direction, angle){}" },
              camera_pan: { available: true, arity: 1, source: "pan(vector){}" },
              camera_rotate_about: { available: true, arity: 3, source: "rotateAbout(point, axis, angle){}" },
              camera_zoom: { available: true, arity: 1, source: "zoom(scale){}" },
            },
            viewer: [{ name: "animateToView", available: true, arity: 2 }],
            camera: [{ name: "pan", available: true, arity: 1 }],
            selection: [{ name: "setSelection", available: true, arity: 1 }],
          },
        } : {}),
        ...(args.mode === "selection_scan" ? {
          selection_scan: {
            module_id: 45867,
            faces: { self_test: true, count: 2, active: [{ deterministic_id: "JHK", entity_type: "FACE" }] },
            edges: { self_test: true, count: 3, active: [{ deterministic_id: "JHt", entity_type: "EDGE" }] },
          },
        } : {}),
        ...(args.mode === "probe" ? {
          probe: {
            status: "HIT",
            x_fraction: args.xFraction,
            y_fraction: args.yFraction,
            picks: [{ deterministic_id: "JHK", is_face: true }],
          },
        } : {}),
        ...(args.mode === "collaboration" ? {
          page_lease: "PERSISTENT_WORK_PAGE",
          requested_page_count: args.collaborationPageCount,
          collaboration_page_count: 1,
          pages: [
            { index: 0, candidates: [{ text: "H", class_name: "collaboration-avatar" }] },
          ],
        } : {}),
        ...(args.mode === "hover_probe" ? {
          read_only: false,
          hover_set: {
            status: "VERIFIED",
            route: "VIEWER_SET_HOVERED_SELECTION",
            expected_deterministic_id: args.expectedDeterministicId,
            same_object: true,
          },
        } : {}),
      };
    },
    async moveView(args) {
      viewMoveCalls.push({ ...args });
      return {
        status: "VERIFIED",
        action: args.action,
        direction: args.direction,
        intensity: args.intensity,
        angle_degrees: args.angleDegrees ?? null,
        route: args.action === "pan" ? "PRIMARY_VIEW_CONTROLLER_ANIMATE_PAN_SCREEN_SPACE" : "PRIMARY_VIEW_CONTROLLER_ANIMATE_ZOOM",
        amount: 58,
        before_view_matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
        after_view_matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0.1,0,0,1],
        before_camera_viewport: [1,-1,1,-1],
        after_camera_viewport: [1,-1,1,-1],
        view_matrix_max_delta: 0.1,
        camera_viewport_max_delta: 0,
        screen_space_dispatch: args.action === "pan" ? { semantic_direction: args.direction } : null,
        timing: {
          open_document: { total_ms: 1, auth_ms: 0, navigation_ms: 0 },
          viewer_acquisition_ms: 2,
          dispatch_ms: 1,
          verification_ms: 3,
          total_ms: 7,
        },
      };
    },
    async fitView(args) {
      viewerCalls.push({ fitView: true, ...args });
      return {
        status: "VERIFIED",
        action: args.action,
        route: args.action === "fit_selection"
          ? "VIEWER_ANIMATE_ZOOM_FIT_SELECTION_BOUNDS"
          : "VIEWER_ANIMATE_ZOOM_FIT_ALL",
        before_selection: args.action === "fit_selection" ? [{ deterministic_id: "JHK", is_edge: true }] : [],
        after_selection: args.action === "fit_selection" ? [{ deterministic_id: "JHK", is_edge: true }] : [],
        selection_preserved: true,
        before_view_matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
        after_view_matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0.2,0,0,1],
        timing: {
          open_document: { total_ms: 1, auth_ms: 0, navigation_ms: 0 },
          viewer_acquisition_ms: 2,
          dispatch_ms: 1,
          verification_ms: 3,
          total_ms: 7,
        },
      };
    },
    async currentSelection(args) {
      viewerCalls.push({ currentSelection: true, ...args });
      return {
        document_id: args.documentId,
        workspace_id: args.workspaceId,
        element_id: args.elementId,
        page_lease: "PERSISTENT_WORK_PAGE",
        available: true,
        count: 1,
        selections: [{
          deterministic_id: "JHK",
          selection_id: "JHK",
          name: "Edge 1",
          is_edge: true,
          is_face: false,
          is_vertex: false,
          is_body: false,
        }],
        timing: { total_ms: 2 },
      };
    },
    async applyFeatureFromSelectionUi(args) {
      viewerCalls.push({ uiFeatureFromSelection: true, ...args });
      const id = `F${nextFeature++}`;
      const parameterId = String(args.featureType).toLowerCase() === "fillet" ? "radius" : "width";
      features.push({
        message: {
          btType: "BTMFeature-134",
          featureId: id,
          name: `${args.featureType} UI`,
          featureType: String(args.featureType).toLowerCase(),
          suppressed: false,
          parameters: [
            {
              btType: "BTMParameterQueryList-148",
              parameterId: "entities",
              queries: [{ btType: "BTMIndividualQuery-138", deterministicIds: ["JHK"] }],
            },
            {
              btType: "BTMParameterQuantity-147",
              parameterId,
              expression: args.valueExpression,
            },
          ],
        },
      });
      return {
        route: "BOUNDED_ONSHAPE_COMMAND_SEARCH_DIALOG",
        feature_type: String(args.featureType).toLowerCase(),
        value_expression: args.valueExpression,
        selection_before: [{ deterministic_id: "JHK", is_edge: true }],
        timing: { total_ms: 4, command_activation_ms: 1, dialog_ready_ms: 1, parameter_input_ms: 1, commit_ms: 1 },
      };
    },
    async standardView(args) {
      viewerCalls.push({ standardView: true, ...args });
      return {
        status: "VERIFIED",
        view: args.view,
        route: "ONSHAPE_SHORTCUT_SHIFT_5",
        data_view_shown: "TOP",
      };
    },
    async setViewerSelection(args) {
      viewerCalls.push({ viewerSelection: true, ...args });
      return {
        status: "VERIFIED",
        action: args.action,
        route: args.action === "clear" ? "UI_SELECTION_MANAGER_RESET" : "UI_SELECTION_MANAGER_SET_SELECTION",
        expected_deterministic_id: args.expectedDeterministicId || null,
        selected_deterministic_ids: args.action === "clear" ? [] : [args.expectedDeterministicId || "JHK"],
      };
    },
    async followView(args) {
      viewerCalls.push({ followView: true, ...args });
      return {
        status: "FOLLOW_DISPATCHED",
        collaborator_count: 2,
        candidate_index: args.candidateIndex ?? 1,
        selection_basis: args.candidateIndex == null
          ? "QUALIFIED_TWO_PARTICIPANT_REMOTE_INDEX_1"
          : "EXPLICIT_CANDIDATE_INDEX",
      };
    },
    async testFollowHandoff(args) {
      viewerCalls.push({ followTest: true, ...args });
      return {
        status: args.pageCount === 2 ? "VERIFIED" : "THREE_PARTICIPANT_DOM_VERIFIED",
        page_count: args.pageCount,
        forward: { status: "VERIFIED", target_candidate_index: 1 },
        local_break: { status: "VERIFIED", post_leader_move_delta: 0.1 },
        reverse: { status: "VERIFIED", target_candidate_index: 1 },
      };
    },
    async testRemoteSelectionGrounding(args) {
      viewerCalls.push({ remoteGroundTest: true, ...args });
      return {
        status: "VERIFIED",
        target: { deterministic_id: "JIO", x_fraction: 0.5, y_fraction: 0.5 },
        local_grounding: {
          identity_seen: true,
          repick_status: "VERIFIED",
          repick_route: "VIEWER_DO_PICK_MODEL_PREHIGHLIGHT",
        },
      };
    },
    async inspectFeatureReorderMachinery(args) {
      viewerCalls.push({ featureReorderProbe: true, ...args });
      return {
        probe: "FEATURE_REORDER_TIER2_MACHINERY",
        dom: {
          row_count: 2,
          rows: [
            { feature_id: "F1", data_id: "M1" },
            { feature_id: "F2", data_id: "M2" },
          ],
        },
        listeners: [],
        webpack: {
          available: true,
          scanned: 10,
          match_count: 1,
          matches: [{ module_id: "123", hits: ["reorder"], snippet: "reorder" }],
        },
      };
    },
    async reorderFeature(args) {
      viewerCalls.push({ featureReorder: true, ...args });
      const sourceIndex = features.findIndex((row) => row.message.featureId === args.sourceFeatureId);
      const targetIndexBefore = features.findIndex((row) => row.message.featureId === args.targetFeatureId);
      if (sourceIndex < 0 || targetIndexBefore < 0) throw new Error("feature missing");
      const [moved] = features.splice(sourceIndex, 1);
      const targetIndex = features.findIndex((row) => row.message.featureId === args.targetFeatureId);
      const insertAt = args.placement === "before" ? targetIndex : targetIndex + 1;
      features.splice(insertAt, 0, moved);
      return {
        status: "INPUT_SEQUENCE_COMPLETED",
        route: "FEATURE_LIST_SYNTHETIC_POINTER_MOUSE_DRAG",
        source_feature_id: args.sourceFeatureId,
        target_feature_id: args.targetFeatureId,
        placement: args.placement,
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
  return { dir, agent, calls, uiCalls, viewerCalls, viewMoveCalls };
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

    const inspect = agent.resolveIntent("inspect viewer");
    assert.equal(inspect.contract.capabilityId, "viewer.inspect");
    assert.equal(inspect.contract.riskClass, "READ");
    assert.equal(inspect.defaults.mode, "state");

    const hoverViewer = agent.resolveIntent("highlight viewer target");
    assert.equal(hoverViewer.contract.capabilityId, "viewer.hover_probe");
    assert.equal(hoverViewer.contract.riskClass, "ORDINARY_WRITE");

    const moveView = agent.resolveIntent("move view");
    assert.equal(moveView.contract.capabilityId, "view.move");
    assert.equal(moveView.contract.riskClass, "ORDINARY_WRITE");

    const fitView = agent.resolveIntent("fit all");
    assert.equal(fitView.contract.capabilityId, "view.fit");
    assert.equal(fitView.contract.riskClass, "ORDINARY_WRITE");

    const standardView = agent.resolveIntent("top view");
    assert.equal(standardView.contract.capabilityId, "view.standard");
    assert.equal(standardView.contract.riskClass, "ORDINARY_WRITE");

    const selection = agent.resolveIntent("select entity");
    assert.equal(selection.contract.capabilityId, "viewer.selection");
    assert.equal(selection.contract.riskClass, "ORDINARY_WRITE");
    const additiveSelection = agent.resolveIntent("add to selection");
    assert.equal(additiveSelection.contract.capabilityId, "viewer.selection");
    assert.equal(additiveSelection.defaults.action, "add");

    const selectedFeature = agent.resolveIntent("fillet current selection");
    assert.equal(selectedFeature.contract.capabilityId, "feature.from_selection");
    assert.equal(selectedFeature.contract.riskClass, "ORDINARY_WRITE");

    const follow = agent.resolveIntent("follow my view");
    assert.equal(follow.contract.capabilityId, "view.follow");
    assert.equal(follow.contract.riskClass, "ORDINARY_WRITE");

    const followTest = agent.resolveIntent("test follow handoff");
    assert.equal(followTest.contract.capabilityId, "view.follow_test");
    assert.equal(followTest.contract.riskClass, "ORDINARY_WRITE");

    const remoteGround = agent.resolveIntent("test remote selection grounding");
    assert.equal(remoteGround.contract.capabilityId, "viewer.remote_ground_test");
    assert.equal(remoteGround.contract.riskClass, "ORDINARY_WRITE");

    const reorderProbe = agent.resolveIntent("probe feature reorder machinery");
    assert.equal(reorderProbe.contract.capabilityId, "feature.reorder_probe");
    assert.equal(reorderProbe.contract.riskClass, "READ");

    const reorder = agent.resolveIntent("reorder feature");
    assert.equal(reorder.contract.capabilityId, "feature.reorder");
    assert.equal(reorder.contract.riskClass, "ORDINARY_WRITE");

    const surface = agent.semanticCapabilitySurface();
    assert.equal(surface.resolution, "startup-precompiled-semantic");
    assert.match(surface.prompt, /do not guess operationIds/i);
    assert.match(surface.prompt, /hide part/i);
    assert.match(surface.prompt, /rename document/i);
    assert.match(surface.prompt, /inspect viewer/i);
  } finally {
    cleanup(dir);
  }
});

test("view.move dispatches one precompiled persistent camera movement with continuous intensity", async () => {
  const { dir, agent, calls, viewMoveCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "move view",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { action: "pan", direction: "left", intensity: 0.1 },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "view.move");
    assert.equal(result.semanticBackend, "BOUNDED_UI");
    assert.equal(result.evidence.effectSent, true);
    assert.equal(result.evidence.effectScope, "PERSISTENT_WORK_PAGE_CAMERA");
    assert.equal(result.movement.status, "VERIFIED");
    assert.equal(viewMoveCalls.length, 1);
    assert.deepEqual(viewMoveCalls[0], {
      documentId: DID, workspaceId: WID, elementId: EID,
      action: "pan", direction: "left", intensity: 0.1, angleDegrees: null,
    });
    assert.equal(calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("view.standard applies the exact persistent top view", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "top view",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {},
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "view.standard");
    assert.equal(result.evidence.effectScope, "PERSISTENT_WORK_PAGE_CAMERA");
    assert.equal(result.standardView.status, "VERIFIED");
    assert.equal(result.standardView.view, "top");
    assert.equal(viewerCalls.at(-1).standardView, true);
    assert.equal(viewerCalls.at(-1).view, "top");
    assert.equal(calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("viewer.selection selects an exact target then clears selection on the persistent work page", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const selected = await agent.executeIntent({
      intent: "select entity",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { x_fraction: 0.5, y_fraction: 0.5, expected_deterministic_id: "JHK" },
    });
    assert.equal(selected.state, "SUCCEEDED");
    assert.equal(selected.capabilityId, "viewer.selection");
    assert.equal(selected.evidence.effectScope, "PERSISTENT_WORK_PAGE_SELECTION");
    assert.deepEqual(selected.selection.selected_deterministic_ids, ["JHK"]);
    assert.equal(viewerCalls.at(-1).viewerSelection, true);
    assert.equal(viewerCalls.at(-1).action, "select");

    const cleared = await agent.executeIntent({
      intent: "clear viewer selection",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {},
    });
    assert.equal(cleared.state, "SUCCEEDED");
    assert.equal(cleared.selection.action, "clear");
    assert.deepEqual(cleared.selection.selected_deterministic_ids, []);
    assert.equal(viewerCalls.at(-1).action, "clear");
    assert.equal(calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("view.follow dispatches persistent qualified collaborator follow", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "follow my view",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {},
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "view.follow");
    assert.equal(result.evidence.effectScope, "PERSISTENT_WORK_PAGE_FOLLOW");
    assert.equal(result.follow.status, "FOLLOW_DISPATCHED");
    assert.equal(result.follow.candidate_index, 1);
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.at(-1).followView, true);
    assert.equal(viewerCalls.at(-1).candidateIndex, null);
  } finally {
    cleanup(dir);
  }
});

test("feature.reorder executes bounded drag and verifies exact adjacency", async () => {
  const { dir, agent, viewerCalls } = fixture();
  try {
    const added = await agent.executeIntent({
      intent: "add plane",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { name: "Plane 1", parameters: { offset: "10 mm", entities: [] } },
      requestId: "req-reorder-add-plane",
    });
    assert.equal(added.state, "SUCCEEDED");

    const result = await agent.executeIntent({
      intent: "reorder feature",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {
        source_feature_name: "Plane 1",
        target_feature_name: "Fillet 1",
        placement: "before",
      },
      requestId: "req-reorder-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "feature.reorder");
    assert.equal(result.semanticBackend, "BOUNDED_UI");
    assert.equal(result.evidence.effectSent, true);
    assert.equal(result.evidence.postconditionVerified, true);
    assert.equal(result.evidence.source.name, "Plane 1");
    assert.equal(result.evidence.target.name, "Fillet 1");
    assert.equal(result.evidence.verification.placement, "before");
    assert.equal(result.evidence.verification.source_index + 1, result.evidence.verification.target_index);
    assert.equal(viewerCalls.at(-1).featureReorder, true);

    const replay = await agent.executeIntent({
      intent: "reorder feature",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {
        source_feature_name: "Plane 1",
        target_feature_name: "Fillet 1",
        placement: "before",
      },
      requestId: "req-reorder-1",
    });
    assert.equal(replay.replayedFromJournal, true);
    assert.equal(viewerCalls.filter((row) => row.featureReorder).length, 1);
  } finally {
    cleanup(dir);
  }
});

test("feature.reorder_probe dispatches bounded read-only machinery inspection", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "probe feature reorder machinery",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {},
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "feature.reorder_probe");
    assert.equal(result.semanticBackend, "BOUNDED_UI");
    assert.equal(result.evidence.effectSent, false);
    assert.equal(result.probe.probe, "FEATURE_REORDER_TIER2_MACHINERY");
    assert.equal(result.probe.dom.row_count, 2);
    assert.equal(result.probe.webpack.match_count, 1);
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.at(-1).featureReorderProbe, true);
  } finally {
    cleanup(dir);
  }
});

test("viewer.remote_ground_test dispatches bounded follow viewport re-pick qualification", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "test remote selection grounding",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {},
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "viewer.remote_ground_test");
    assert.equal(result.evidence.effectScope, "PERSISTENT_FOLLOWER_EPHEMERAL_LEADER_GROUNDING_QUALIFICATION");
    assert.equal(result.grounding.status, "VERIFIED");
    assert.equal(result.grounding.target.deterministic_id, "JIO");
    assert.equal(result.grounding.local_grounding.identity_seen, true);
    assert.equal(result.grounding.local_grounding.repick_status, "VERIFIED");
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.at(-1).remoteGroundTest, true);
  } finally {
    cleanup(dir);
  }
});

test("view.follow_test dispatches bounded two-way follow qualification", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "test follow handoff",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { page_count: 2 },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "view.follow_test");
    assert.equal(result.evidence.effectSent, true);
    assert.equal(result.evidence.effectScope, "EPHEMERAL_MULTI_TAB_FOLLOW_QUALIFICATION");
    assert.equal(result.follow.status, "VERIFIED");
    assert.equal(result.follow.forward.status, "VERIFIED");
    assert.equal(result.follow.local_break.status, "VERIFIED");
    assert.equal(result.follow.reverse.status, "VERIFIED");
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.at(-1).followTest, true);
    assert.equal(viewerCalls.at(-1).pageCount, 2);
  } finally {
    cleanup(dir);
  }
});

test("viewer inspector is a read-only bounded UI semantic operation with no provider mutation", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "probe viewer",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { x_fraction: 0.5, y_fraction: 0.5 },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "viewer.inspect");
    assert.equal(result.semanticBackend, "BOUNDED_UI");
    assert.equal(result.evidence.effectSent, false);
    assert.equal(result.evidence.operationRiskClass, "READ");
    assert.equal(result.viewer.self_test.viewer_instance_found, true);
    assert.equal(result.viewer.probe.status, "HIT");
    assert.equal(result.viewer.probe.picks[0].deterministic_id, "JHK");
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.length, 1);
    assert.equal(viewerCalls[0].mode, "probe");
    assert.equal(viewerCalls[0].xFraction, 0.5);
    assert.equal(viewerCalls[0].yFraction, 0.5);
  } finally {
    cleanup(dir);
  }
});

test("viewer methods mode stays read-only and returns only bounded method inventory", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "inspect viewer",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { mode: "methods" },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.effectSent, false);
    assert.deepEqual(result.viewer.methods.viewer, ["getViewData", "setViewData"]);
    assert.deepEqual(result.viewer.methods.selection, ["getSelection", "setSelection"]);
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.length, 1);
    assert.equal(viewerCalls[0].mode, "methods");
  } finally {
    cleanup(dir);
  }
});

test("viewer method_details mode is read-only and bounded to precompiled setter metadata", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "inspect viewer",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { mode: "method_details" },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.effectSent, false);
    assert.deepEqual(result.viewer.method_details.selection, [{ name: "setSelection", available: true, arity: 1 }]);
    assert.deepEqual(result.viewer.method_details.camera, [{ name: "pan", available: true, arity: 1 }]);
    assert.equal(result.viewer.method_details.movement_contracts.camera_pan.arity, 1);
    assert.match(result.viewer.method_details.movement_contracts.camera_rotate_about.source, /rotateAbout/);
    assert.equal(result.viewer.method_details.movement_contracts.viewer_rotate_in_direction_with_angle.arity, 2);
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.length, 1);
    assert.equal(viewerCalls[0].mode, "method_details");
  } finally {
    cleanup(dir);
  }
});

test("viewer collaboration inspection is read-only on the persistent work page and opens no participant tabs", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "inspect viewer",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { mode: "collaboration", page_count: 2 },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.effectSent, false);
    assert.equal(result.viewer.page_lease, "PERSISTENT_WORK_PAGE");
    assert.equal(result.viewer.requested_page_count, 2);
    assert.equal(result.viewer.collaboration_page_count, 1);
    assert.equal(viewerCalls[0].collaborationPageCount, 2);
    assert.equal(calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("viewer hover probe is bounded to an exact deterministic pick and verified", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "highlight viewer target",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { x_fraction: 0.5, y_fraction: 0.5, expected_deterministic_id: "JHK" },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "viewer.hover_probe");
    assert.equal(result.evidence.effectSent, true);
    assert.equal(result.evidence.effectScope, "EPHEMERAL_VIEWER_HOVER");
    assert.equal(result.evidence.operationRiskClass, "ORDINARY_WRITE");
    assert.equal(result.viewer.hover_set.status, "VERIFIED");
    assert.equal(result.viewer.hover_set.expected_deterministic_id, "JHK");
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.length, 1);
    assert.equal(viewerCalls[0].mode, "hover_probe");
    assert.equal(viewerCalls[0].expectedDeterministicId, "JHK");
  } finally {
    cleanup(dir);
  }
});

test("viewer hover may use a deterministic world point projected inside the same Viewer page", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const worldPoint = { x: 0, y: 0.0215, z: 0.012 };
    const result = await agent.executeIntent({
      intent: "highlight viewer target",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { world_point: worldPoint, expected_deterministic_id: "JHK" },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.effectSent, true);
    assert.deepEqual(result.evidence.worldPoint, worldPoint);
    assert.equal(result.evidence.xFraction, null);
    assert.equal(result.evidence.yFraction, null);
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls.length, 1);
    assert.equal(viewerCalls[0].mode, "hover_probe");
    assert.deepEqual(viewerCalls[0].worldPoint, worldPoint);
    assert.equal(viewerCalls[0].expectedDeterministicId, "JHK");
  } finally {
    cleanup(dir);
  }
});

test("viewer selection_scan is read-only and fixed to bounded Face/Edge display entities", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "inspect viewer",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { mode: "selection_scan" },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.effectSent, false);
    assert.equal(result.evidence.operationRiskClass, "READ");
    assert.equal(result.viewer.selection_scan.module_id, 45867);
    assert.equal(result.viewer.selection_scan.faces.active[0].deterministic_id, "JHK");
    assert.equal(result.viewer.selection_scan.edges.active[0].deterministic_id, "JHt");
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls[0].mode, "selection_scan");
  } finally {
    cleanup(dir);
  }
});

test("viewer hover probe may qualify a unique point without a pre-known deterministic id", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "highlight viewer target",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { x_fraction: 0.46, y_fraction: 0.48 },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.viewer.hover_set.status, "VERIFIED");
    assert.equal(calls.length, 0);
    assert.equal(viewerCalls[0].expectedDeterministicId, null);
  } finally {
    cleanup(dir);
  }
});

test("viewer hover failure surfaces bounded pre-effect diagnostic evidence", async () => {
  const { dir, agent } = fixture();
  try {
    agent.core.inspectViewer = async () => {
      const error = new Error("hover not verified");
      error.code = "VIEWER_HOVER_NOT_VERIFIED";
      error.hover_set = {
        status: "NO_PICK",
        observed_deterministic_ids: [],
        pick_constructor: "PickResult",
        pick_own_keys: ["deterministicId"],
        pick_methods: [{ name: "getUISelection", arity: 0 }],
        is_ui_pick: false,
        get_ui_selection_type: "null",
        get_ui_selection_constructor: null,
        get_ui_selection_own_keys: [],
        get_model_selection_type: "object",
        get_model_selection_constructor: "ModelSelection",
        get_model_selection_own_keys: ["selectionId", "sourcePick"],
        get_model_selection_methods: [{ name: "getSourcePick", arity: 0 }, { name: "getDeterministicId", arity: 0 }],
        get_model_selection_id_string: "model-selection-1",
        get_model_selection_deterministic_id: "JIO",
        get_model_selection_source_pick_same_object: true,
        created_bt_ui_selection_type: "object",
        created_bt_ui_selection_constructor: "BTUiSelection",
        created_bt_ui_selection_own_keys: ["selectionId", "meshIncrementId", "uiElement"],
        created_bt_ui_selection_selection_id: "ui-selection-1",
        created_bt_ui_selection_mesh_increment_id: "mesh-1",
        created_bt_ui_selection_id: "JIO",
        created_bt_ui_selection_type_value: 4,
        created_bt_ui_selection_deterministic_ids: ["JIO"],
        created_bt_ui_selection_table_row_id: "row-1",
        created_bt_ui_element_constructor: "UiElement",
        created_bt_ui_element_own_keys: ["id", "collectionId"],
        viewer_do_pre_highlight_pick_available: true,
        viewer_do_pre_highlight_pick_arity: 1,
        viewer_do_pre_highlight_pick_source: "function doPreHighlightPick(pick){return this.preHighlightUiSelection(pick.getUISelection())}",
        viewer_do_pick_available: true,
        viewer_do_pick_arity: 5,
        viewer_do_pick_source: "function doPick(x,y,a,b,options){return options}",
        viewer_pre_highlight_ui_selection_available: true,
        viewer_pre_highlight_ui_selection_arity: 1,
        viewer_pre_highlight_ui_selection_source: "function preHighlightUiSelection(ui){return ui}",
        projected_x_fraction: 0.5315,
        projected_y_fraction: 0.7626,
        projected_x: 634,
        projected_y: 681,
        projection_camera_width: 1194,
        projection_camera_height: 894,
        projection_view_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, 0.3, 1],
        projection_camera_viewport: [0.12, -0.12, 0.16, -0.16],
        projection_is_perspective: false,
        source_deterministic_id: "JIO",
        hovered_deterministic_id: "JIX",
        same_model_object: false,
        do_pick_result: true,
        post_observed_deterministic_ids: ["JIX"],
        verification_delay_frames: 2,
        do_pick_source: "function doPick(x,y,a,b,options){return this.pick(x,y)}",
        route: "VIEWER_DO_PICK_MODEL_PREHIGHLIGHT",
      };
      throw error;
    };
    const result = await agent.executeIntent({
      intent: "highlight viewer target",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { x_fraction: 0.5, y_fraction: 0.5 },
    });
    assert.equal(result.state, "REJECTED");
    assert.equal(result.evidence.effectSent, false);
    assert.equal(result.evidence.hoverStatus, "NO_PICK");
    assert.deepEqual(result.evidence.observedDeterministicIds, []);
    assert.equal(result.evidence.pickConstructor, "PickResult");
    assert.deepEqual(result.evidence.pickOwnKeys, ["deterministicId"]);
    assert.deepEqual(result.evidence.pickMethods, [{ name: "getUISelection", arity: 0 }]);
    assert.equal(result.evidence.isUiPick, false);
    assert.equal(result.evidence.getUiSelectionType, "null");
    assert.equal(result.evidence.getUiSelectionConstructor, null);
    assert.deepEqual(result.evidence.getUiSelectionOwnKeys, []);
    assert.equal(result.evidence.getModelSelectionType, "object");
    assert.equal(result.evidence.getModelSelectionConstructor, "ModelSelection");
    assert.deepEqual(result.evidence.getModelSelectionOwnKeys, ["selectionId", "sourcePick"]);
    assert.deepEqual(result.evidence.getModelSelectionMethods, [
      { name: "getSourcePick", arity: 0 },
      { name: "getDeterministicId", arity: 0 },
    ]);
    assert.equal(result.evidence.getModelSelectionIdString, "model-selection-1");
    assert.equal(result.evidence.getModelSelectionDeterministicId, "JIO");
    assert.equal(result.evidence.getModelSelectionSourcePickSameObject, true);
    assert.equal(result.evidence.createdBtUiSelectionType, "object");
    assert.equal(result.evidence.createdBtUiSelectionConstructor, "BTUiSelection");
    assert.deepEqual(result.evidence.createdBtUiSelectionOwnKeys, ["selectionId", "meshIncrementId", "uiElement"]);
    assert.equal(result.evidence.createdBtUiSelectionSelectionId, "ui-selection-1");
    assert.equal(result.evidence.createdBtUiSelectionMeshIncrementId, "mesh-1");
    assert.equal(result.evidence.createdBtUiSelectionId, "JIO");
    assert.equal(result.evidence.createdBtUiSelectionTypeValue, "4");
    assert.deepEqual(result.evidence.createdBtUiSelectionDeterministicIds, ["JIO"]);
    assert.equal(result.evidence.createdBtUiSelectionTableRowId, "row-1");
    assert.equal(result.evidence.createdBtUiElementConstructor, "UiElement");
    assert.deepEqual(result.evidence.createdBtUiElementOwnKeys, ["id", "collectionId"]);
    assert.equal(result.evidence.viewerDoPreHighlightPickAvailable, true);
    assert.equal(result.evidence.viewerDoPreHighlightPickArity, 1);
    assert.match(result.evidence.viewerDoPreHighlightPickSource, /doPreHighlightPick/);
    assert.equal(result.evidence.viewerDoPickAvailable, true);
    assert.equal(result.evidence.viewerDoPickArity, 5);
    assert.match(result.evidence.viewerDoPickSource, /doPick/);
    assert.equal(result.evidence.viewerPreHighlightUiSelectionAvailable, true);
    assert.equal(result.evidence.viewerPreHighlightUiSelectionArity, 1);
    assert.match(result.evidence.viewerPreHighlightUiSelectionSource, /preHighlightUiSelection/);
    assert.equal(result.evidence.projectedXFraction, 0.5315);
    assert.equal(result.evidence.projectedYFraction, 0.7626);
    assert.equal(result.evidence.projectedX, 634);
    assert.equal(result.evidence.projectedY, 681);
    assert.equal(result.evidence.projectionCameraWidth, 1194);
    assert.equal(result.evidence.projectionCameraHeight, 894);
    assert.equal(result.evidence.projectionViewMatrix.length, 16);
    assert.deepEqual(result.evidence.projectionCameraViewport, [0.12, -0.12, 0.16, -0.16]);
    assert.equal(result.evidence.projectionIsPerspective, false);
    assert.equal(result.evidence.sourceDeterministicId, "JIO");
    assert.equal(result.evidence.hoveredDeterministicId, "JIX");
    assert.equal(result.evidence.sameModelObject, false);
    assert.equal(result.evidence.doPickResult, true);
    assert.deepEqual(result.evidence.postObservedDeterministicIds, ["JIX"]);
    assert.equal(result.evidence.verificationDelayFrames, 2);
    assert.match(result.evidence.doPickSource, /doPick/);
    assert.equal(result.evidence.hoverRoute, "VIEWER_DO_PICK_MODEL_PREHIGHLIGHT");
  } finally {
    cleanup(dir);
  }
});

test("viewer hover readback mismatch is surfaced as ephemeral uncertain effect", async () => {
  const { dir, agent } = fixture();
  try {
    agent.core.inspectViewer = async () => {
      const error = new Error("hover not verified");
      error.code = "VIEWER_HOVER_NOT_VERIFIED";
      error.hover_set = {
        status: "HOVER_READBACK_MISMATCH",
        source_selection_id: "source-1",
        hovered_selection_id: "hovered-2",
        same_object: false,
      };
      throw error;
    };
    const result = await agent.executeIntent({
      intent: "highlight viewer target",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { x_fraction: 0.5, y_fraction: 0.5 },
    });
    assert.equal(result.state, "UNCERTAIN");
    assert.equal(result.evidence.effectSent, true);
    assert.equal(result.evidence.hoverStatus, "HOVER_READBACK_MISMATCH");
    assert.equal(result.evidence.sourceSelectionId, "source-1");
    assert.equal(result.evidence.hoveredSelectionId, "hovered-2");
  } finally {
    cleanup(dir);
  }
});

test("viewer probe rejects out-of-range coordinates before touching the browser", async () => {
  const { dir, agent, viewerCalls } = fixture();
  try {
    await assert.rejects(
      () => agent.executeIntent({
        intent: "probe viewer",
        target: { document_id: DID, workspace_id: WID, element_id: EID },
        arguments: { x_fraction: 2, y_fraction: 0.5 },
      }),
      (error) => error.code === "ONSHAPE_INTENT_ARGUMENTS",
    );
    assert.equal(viewerCalls.length, 0);
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

test("feature.add clones an explicitly named reference and changes only the requested values", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "add fillet",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { parameters: { radius: "12 mm" }, name: "Fillet Copy", suppressed: true, reference_feature_name: "Fillet 1" },
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

test("feature.add builds from the official spec catalog when no feature of that type exists, empty query allowed", async () => {
  const { dir, agent, calls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "add plane",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { parameters: { offset: "30 mm", entities: [] }, name: "Plane 1" },
      requestId: "req-add-catalog-1",
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.derived.source, "OFFICIAL_FEATURE_SPEC_CATALOG");
    const write = calls.find((call) => call.method === "POST" && call.requestPath.endsWith("/features"));
    assert.equal(write.body.feature.btType, "BTMFeature-134");
    assert.equal(write.body.feature.featureType, "cPlane");
    assert.equal(write.body.feature.name, "Plane 1");
    const offset = write.body.feature.parameters.find((item) => item.parameterId === "offset");
    assert.equal(offset.btType, "BTMParameterQuantity-147");
    assert.equal(offset.expression, "30 mm");
    const entities = write.body.feature.parameters.find((item) => item.parameterId === "entities");
    assert.equal(entities.btType, "BTMParameterQueryList-148");
    assert.deepEqual(entities.queries, []);
    assert.ok(result.timing.build_ms >= 0);
  } finally {
    cleanup(dir);
  }
});

test("feature.add rejects a parameter the spec does not define", async () => {
  const { dir, agent } = fixture();
  try {
    await assert.rejects(
      agent.executeIntent({
        intent: "add plane",
        target: { document_id: DID, workspace_id: WID, element_id: EID },
        arguments: { parameters: { notAParameter: "1 mm" } },
        requestId: "req-add-catalog-2",
      }),
      (error) => error.code === "ONSHAPE_FEATURE_PARAMETER_UNKNOWN",
    );
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

test("feature.add maps the spoken word derived to the toolbar Derive feature, never the internal derivedMirror", async () => {
  for (const word of ["derived", "Derived", "derive", "دیرایو"]) {
    const { dir, agent, calls } = fixture();
    try {
      const result = await agent.executeIntent({
        intent: "add feature",
        target: { document_id: DID, workspace_id: WID, element_id: EID },
        arguments: { feature_type: word },
        requestId: `req-derive-${Buffer.from(word).toString("hex")}`,
      });
      assert.equal(result.state, "SUCCEEDED");
      const write = calls.find((call) => call.method === "POST" && call.requestPath.endsWith("/features"));
      assert.equal(write.body.feature.featureType, "importDerived", word);
    } finally {
      cleanup(dir);
    }
  }
});

test("view.move admits wide nonlinear intensity and exact orbit degrees without changing semantic direction", async () => {
  const { dir, agent, viewMoveCalls } = fixture();
  try {
    const pan = await agent.executeIntent({
      intent: "pan view",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { action: "pan", direction: "left", intensity: 5 },
    });
    assert.equal(pan.state, "SUCCEEDED");
    assert.equal(viewMoveCalls.at(-1).direction, "left");
    assert.equal(viewMoveCalls.at(-1).intensity, 5);

    const orbit = await agent.executeIntent({
      intent: "orbit view",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: { action: "orbit", direction: "clockwise", angle_degrees: 45 },
    });
    assert.equal(orbit.state, "SUCCEEDED");
    assert.equal(viewMoveCalls.at(-1).angleDegrees, 45);
  } finally {
    cleanup(dir);
  }
});

test("view.fit uses persistent fit-all and fit-selection while preserving exact selection identity", async () => {
  const { dir, agent, viewerCalls } = fixture();
  try {
    const fit = await agent.executeIntent({
      intent: "fit all",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {},
    });
    assert.equal(fit.state, "SUCCEEDED");
    assert.equal(fit.capabilityId, "view.fit");
    assert.equal(fit.fit.action, "fit");

    const selected = await agent.executeIntent({
      intent: "fit selection",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {},
    });
    assert.equal(selected.state, "SUCCEEDED");
    assert.equal(selected.fit.action, "fit_selection");
    assert.equal(selected.fit.selection_preserved, true);
    assert.deepEqual(selected.fit.after_selection.map((item) => item.deterministic_id), ["JHK"]);
    assert.equal(viewerCalls.at(-1).fitView, true);
  } finally {
    cleanup(dir);
  }
});

test("feature.from_selection bridges exact Viewer ids to documented BTMIndividualQuery without re-pick", async () => {
  const { dir, agent, calls, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "fillet current selection",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {
        qualification_route: "api",
        parameters: { radius: "5 mm" },
      },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.capabilityId, "feature.from_selection");
    assert.equal(result.derived.route, "VIEWER_SELECTION_TO_DOCUMENTED_API");
    assert.deepEqual(result.derived.selected_deterministic_ids, ["JHK"]);
    assert.equal(viewerCalls.some((call) => call.currentSelection === true), true);

    const write = calls.filter((call) =>
      call.method === "POST"
      && call.requestPath === `/api/v17/partstudios/d/${DID}/w/${WID}/e/${EID}/features`
    ).at(-1);
    const query = write.body.feature.parameters.find((parameter) => parameter.parameterId === "entities");
    assert.deepEqual(query.queries[0].deterministicIds, ["JHK"]);
    const radius = write.body.feature.parameters.find((parameter) => parameter.parameterId === "radius");
    assert.equal(radius.expression, "5 mm");
  } finally {
    cleanup(dir);
  }
});

test("feature.from_selection can benchmark bounded native UI and verify identity by documented readback", async () => {
  const { dir, agent, viewerCalls } = fixture();
  try {
    const result = await agent.executeIntent({
      intent: "fillet current selection",
      target: { document_id: DID, workspace_id: WID, element_id: EID },
      arguments: {
        qualification_route: "ui",
        value_expression: "5 mm",
      },
    });
    assert.equal(result.state, "SUCCEEDED");
    assert.equal(result.evidence.route, "ui");
    assert.equal(result.evidence.addedFeatureCount, 1);
    assert.equal(result.evidence.identityPreserved, true);
    assert.equal(viewerCalls.some((call) => call.uiFeatureFromSelection === true), true);
  } finally {
    cleanup(dir);
  }
});

test("tool description tells the client that in-document deletes need no confirmation", () => {
  const { dir, agent } = fixture();
  try {
    const prompt = agent.semanticCapabilitySurface().prompt;
    assert.match(prompt, /never ask the owner to confirm/);
    assert.match(prompt, /delete part/);
  } finally {
    cleanup(dir);
  }
});


test("browser page-function telemetry receives viewer cache hit as an explicit argument", () => {
  const browserSource = fs.readFileSync(new URL("./browser.js", import.meta.url), "utf8");
  assert.doesNotMatch(browserSource, /viewer_cache_hit:\s*runtime\.cache_hit/);
  assert.equal((browserSource.match(/viewer_cache_hit:\s*cacheHit/g) || []).length, 2);
  assert.match(browserSource, /async function\(action, viewerAcquisitionMs, cacheHit\)/);
  assert.match(browserSource, /async function\(action, direction, intensity, angleDegrees, viewerAcquisitionMs, cacheHit\)/);
});