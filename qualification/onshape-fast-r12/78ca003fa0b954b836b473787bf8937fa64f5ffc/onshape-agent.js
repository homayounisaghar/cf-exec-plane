import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Semantic effect is not identical to HTTP method. Keep POST exceptions
// evidence-backed and intentionally small.
const READ_ONLY_POST_OPERATION_IDS = new Set(["evalFeatureScript"]);
const RISK_READ = "READ";
const RISK_ORDINARY_WRITE = "ORDINARY_WRITE";
const RISK_HIGH_IMPACT = "HIGH_IMPACT";
const QUALIFIED = "READY";
const QUALIFIED_OWNER_INTENT = "READY_REQUIRES_EXPLICIT_OWNER_INTENT";
// Confirmation is reserved for effects that leave the document: exposure, access,
// ownership and account administration. Everything inside a document is undoable in
// Onshape, so in-document work never asks, whatever the operation happens to be called.
const HIGH_IMPACT_OPERATION_PATTERN = /(?:\bshare|\bunshare|permission|\bpublic\b|transfer.*ownership|ownership.*transfer|invite|api.?key|oauth|webhook|\badmin(?:istration)?\b|\bbilling\b|\bsubscription\b)/i;
const IN_DOCUMENT_PATH_PATTERN = /^\/(?:partstudios|assemblies|featurestudios|parts|partnumber|drawings|elements|metadata|variables|billofmaterials|appelements|blobelements|translations|thumbnails|insertables|configurations|featurestudio)\b/i;
const EXTERNAL_ADMIN_PATH_PATTERN = /^\/(?:companies|teams|users|accounts|apikeys|oauth|webhooks|admin|clients|billing|subscriptions|sharing|share|globaltreenodes\/magic)\b/i;
const REQUEST_ID_RE = /^[A-Za-z0-9:._-]{1,160}$/;
const SEMANTIC_BACKEND_DOCUMENTED = "DOCUMENTED_OPERATION";
const SEMANTIC_BACKEND_BOUNDED_UI = "BOUNDED_UI";
const SEMANTIC_BACKEND_DERIVED = "DERIVED_PAYLOAD";

const DOCUMENTED_SEMANTIC_ALIASES = Object.freeze({
  updateDocumentAttributes: ["rename document", "update document metadata"],
  createPartStudio: ["create part studio", "add part studio", "new part studio"],
  addPartStudioFeature: ["add feature", "create feature", "add part studio feature"],
  updatePartStudioFeature: ["update feature", "edit feature", "update part studio feature"],
  deletePartStudioFeature: ["delete feature", "remove feature", "delete part studio feature"],
  updateWVEPMetadata: ["update metadata", "update part metadata"],
});

const BOUNDED_UI_CAPABILITIES = Object.freeze([
  Object.freeze({
    capabilityId: "viewer.inspect",
    aliases: Object.freeze([
      Object.freeze({ phrase: "inspect viewer", defaults: Object.freeze({ mode: "state" }) }),
      Object.freeze({ phrase: "inspect onshape viewer", defaults: Object.freeze({ mode: "state" }) }),
      Object.freeze({ phrase: "read viewer state", defaults: Object.freeze({ mode: "state" }) }),
      Object.freeze({ phrase: "probe viewer", defaults: Object.freeze({ mode: "probe" }) }),
      Object.freeze({ phrase: "read viewer selection", defaults: Object.freeze({ mode: "selection" }) }),
    ]),
    surfaceAliases: Object.freeze(["inspect viewer", "probe viewer", "read viewer selection"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEWER_INSPECT",
    }),
    riskClass: RISK_READ,
    verificationStrategy: "VIEWER_RUNTIME_SELF_TEST",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "mode:\"state\"|\"selection\"|\"probe\"|\"methods\"|\"method_details\"|\"selection_scan\"|\"collaboration\"; collaboration inspects only the persistent work page and never creates participant tabs; selection_scan returns bounded Face/Edge display-entity metadata from fixed module 45867 exports; probe requires x_fraction and y_fraction from 0 to 1",
  }),
  Object.freeze({
    capabilityId: "viewer.hover_probe",
    aliases: Object.freeze([
      Object.freeze({ phrase: "highlight viewer target", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "hover viewer target", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["highlight viewer target", "hover viewer target"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEWER_HOVER_PROBE",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "VIEWER_ROUTE_SPECIFIC_VERIFICATION",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "x_fraction and y_fraction from 0 to 1, or world_point:{x,y,z} projected against the same live Viewer camera; optional expected_deterministic_id enforces an exact match. Exact world-point targets may dispatch one source-qualified Viewer.animateZoomFit(false) full-document fit on the same ephemeral page after an exact pre-pick miss, then retry with fresh projection; remaining pre-effect readiness misses stay bounded. UI picks verify through getHoveredSelection; model picks require exact pre-pick identity, exact ModelSelection identity, a live-qualified Viewer.doPick contract, and doPick=true from the model-selection handler. Same-pixel post-pick remains diagnostic only.",
  }),
  Object.freeze({
    capabilityId: "viewer.selection",
    aliases: Object.freeze([
      Object.freeze({ phrase: "select viewer target", defaults: Object.freeze({ action: "select" }) }),
      Object.freeze({ phrase: "select entity", defaults: Object.freeze({ action: "select" }) }),
      Object.freeze({ phrase: "select face", defaults: Object.freeze({ action: "select" }) }),
      Object.freeze({ phrase: "add to selection", defaults: Object.freeze({ action: "add" }) }),
      Object.freeze({ phrase: "select additional entity", defaults: Object.freeze({ action: "add" }) }),
      Object.freeze({ phrase: "clear viewer selection", defaults: Object.freeze({ action: "clear" }) }),
      Object.freeze({ phrase: "deselect entity", defaults: Object.freeze({ action: "clear" }) }),
    ]),
    surfaceAliases: Object.freeze(["select viewer target", "select entity", "add to selection", "clear viewer selection", "deselect entity"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEWER_SELECTION",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PERSISTENT_VIEWER_SELECTION_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "action:select|add|clear. select replaces the current selection; add Shift-clicks one additional deterministic target while preserving prior exact identities; both require x_fraction/y_fraction from 0 to 1 and may include expected_deterministic_id. clear removes the persistent Viewer selection.",
  }),
  Object.freeze({
    capabilityId: "view.move",
    aliases: Object.freeze([
      Object.freeze({ phrase: "move view", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "pan view", defaults: Object.freeze({ action: "pan" }) }),
      Object.freeze({ phrase: "orbit view", defaults: Object.freeze({ action: "orbit" }) }),
      Object.freeze({ phrase: "zoom view", defaults: Object.freeze({ action: "zoom" }) }),
    ]),
    surfaceAliases: Object.freeze(["move view", "pan view", "orbit view", "zoom view"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEW_MOVE",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PERSISTENT_VIEW_CAMERA_BEFORE_AFTER",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "action:pan|orbit|zoom; direction pan=left|right|up|down in user screen-space, orbit=left|right|up|down|clockwise|counterclockwise, zoom=in|out; intensity:number in (0,5] with nonlinear scaling. Orbit may alternatively include angle_degrees in (0,360]. Values <=1 preserve fine-control compatibility; values >1 provide progressively larger movement.",
  }),
  Object.freeze({
    capabilityId: "view.fit",
    aliases: Object.freeze([
      Object.freeze({ phrase: "fit view", defaults: Object.freeze({ action: "fit" }) }),
      Object.freeze({ phrase: "fit all", defaults: Object.freeze({ action: "fit" }) }),
      Object.freeze({ phrase: "zoom to fit", defaults: Object.freeze({ action: "fit" }) }),
      Object.freeze({ phrase: "fit selection", defaults: Object.freeze({ action: "fit_selection" }) }),
      Object.freeze({ phrase: "zoom to selection", defaults: Object.freeze({ action: "fit_selection" }) }),
    ]),
    surfaceAliases: Object.freeze(["fit view", "fit all", "fit selection", "zoom to selection"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEW_FIT",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PERSISTENT_VIEW_FIT_CAMERA_AND_SELECTION_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "action:fit|fit_selection. fit uses the native Viewer fit bounds on the persistent work page. fit_selection consumes the existing persistent Viewer selection and preserves its exact deterministic identities.",
  }),
  Object.freeze({
    capabilityId: "view.standard",
    aliases: Object.freeze([
      Object.freeze({ phrase: "standard view", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "top view", defaults: Object.freeze({ view: "top" }) }),
      Object.freeze({ phrase: "show top view", defaults: Object.freeze({ view: "top" }) }),
      Object.freeze({ phrase: "go to top view", defaults: Object.freeze({ view: "top" }) }),
    ]),
    surfaceAliases: Object.freeze(["standard view", "top view", "show top view"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEW_STANDARD",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PERSISTENT_STANDARD_VIEW_TAG_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "view:top. Uses the fixed Onshape Shift+5 standard-view shortcut on the persistent work page and verifies the resulting data-view-shown tag.",
  }),
  Object.freeze({
    capabilityId: "view.follow",
    aliases: Object.freeze([
      Object.freeze({ phrase: "follow collaborator", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "follow my view", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "follow view", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["follow collaborator", "follow my view", "follow view"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEW_FOLLOW",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "QUALIFIED_COLLABORATOR_DBLCLICK_DISPATCH",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "optional candidate_index. With exactly two collaborator icons the live-qualified remote candidate index 1 is selected automatically; with three or more collaborators candidate_index is required to avoid guessing.",
  }),
  Object.freeze({
    capabilityId: "view.follow_test",
    aliases: Object.freeze([
      Object.freeze({ phrase: "test follow handoff", defaults: Object.freeze({ page_count: 2 }) }),
      Object.freeze({ phrase: "test onshape follow", defaults: Object.freeze({ page_count: 2 }) }),
    ]),
    surfaceAliases: Object.freeze(["test follow handoff", "test onshape follow"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEW_FOLLOW_TEST",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "COLLABORATION_CAMERA_CONVERGENCE",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "page_count:2|3. Two-page mode qualifies follow -> local break -> reverse follow using only the fixed collaborator icon path and camera convergence. Three-page mode records bounded collaborator DOM/disambiguation evidence.",
  }),
  Object.freeze({
    capabilityId: "viewer.remote_ground_test",
    aliases: Object.freeze([
      Object.freeze({ phrase: "test remote selection grounding", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "test selection grounding", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["test remote selection grounding", "test selection grounding"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "VIEW_REMOTE_GROUND_TEST",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "FOLLOW_VIEW_LOCAL_REPICK_IDENTITY",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "No arguments. Bounded qualification only: establishes Follow to an ephemeral leader, marks one deterministic geometry target on the leader, re-picks the same screen point locally on the persistent follower, and verifies deterministic identity.",
  }),
  Object.freeze({
    capabilityId: "feature.reorder_probe",
    aliases: Object.freeze([
      Object.freeze({ phrase: "probe feature reorder machinery", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "inspect feature reorder machinery", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["probe feature reorder machinery", "inspect feature reorder machinery"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "FEATURE_REORDER_PROBE",
    }),
    riskClass: RISK_READ,
    verificationStrategy: "FEATURE_LIST_MACHINERY_INSPECTION",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "No arguments. Read-only bounded qualification probe over Feature-list DOM, attached drag/drop/pointer listeners, and loaded Onshape webpack factories matching reorder-specific terms. No generic JavaScript surface.",
  }),
  Object.freeze({
    capabilityId: "feature.reorder",
    aliases: Object.freeze([
      Object.freeze({ phrase: "move feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "reorder feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "move feature before", defaults: Object.freeze({ placement: "before" }) }),
      Object.freeze({ phrase: "move feature after", defaults: Object.freeze({ placement: "after" }) }),
    ]),
    surfaceAliases: Object.freeze(["move feature", "reorder feature"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "FEATURE_REORDER",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PARTSTUDIO_FEATURE_ORDER_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "source_feature_id or source_feature_name; target_feature_id or target_feature_name; placement:before|after. Exact feature identities are resolved through getPartStudioFeatures before the bounded drag, then order is verified by fresh feature-list readback.",
  }),
  Object.freeze({
    capabilityId: "part.visibility",
    aliases: Object.freeze([
      Object.freeze({ phrase: "hide part", defaults: Object.freeze({ visible: false }) }),
      Object.freeze({ phrase: "hide body", defaults: Object.freeze({ visible: false }) }),
      Object.freeze({ phrase: "show part", defaults: Object.freeze({ visible: true }) }),
      Object.freeze({ phrase: "show body", defaults: Object.freeze({ visible: true }) }),
      Object.freeze({ phrase: "set part visibility", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["hide part", "show part", "set part visibility"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_BOUNDED_UI,
      executor: "PART_VISIBILITY",
      targetResolverOperationId: "getPartsWMVE",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "EXACT_PART_ROW_DIRECTIONAL_VISIBILITY_COMMAND",
    qualificationState: QUALIFIED,
    targetDescription: "document_id, workspace_id, element_id, plus part_id/entity_id or part_name/entity_name",
    argumentDescription: "visible:boolean; hide/show aliases supply visible automatically",
  }),
]);

const DERIVED_CAPABILITIES = Object.freeze([
  Object.freeze({
    capabilityId: "feature.delete_part",
    aliases: Object.freeze([
      Object.freeze({ phrase: "delete part", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "remove part", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "delete body", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "remove body", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "delete bodies", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u062d\u0630\u0641 \u067e\u0627\u0631\u062a", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u067e\u0627\u06a9 \u06a9\u0631\u062f\u0646 \u0642\u0637\u0639\u0647", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["delete part", "remove part", "delete body", "\u062d\u0630\u0641 \u067e\u0627\u0631\u062a"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "DELETE_PART_BODIES",
      operationId: "addPartStudioFeature",
      targetResolverOperationId: "getPartsWMVE",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PARTSTUDIO_FEATURE_ADDED_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id, plus part_name or part_id",
    argumentDescription: "none; the admitted deleteBodies payload is derived from the resolved part query",
  }),
  Object.freeze({
    capabilityId: "feature.parameter.set",
    aliases: Object.freeze([
      Object.freeze({ phrase: "set feature parameter", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "change feature parameter", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "edit feature parameter", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "set feature dimension", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "change fillet radius", defaults: Object.freeze({ parameter_id: "radius" }) }),
      Object.freeze({ phrase: "set fillet radius", defaults: Object.freeze({ parameter_id: "radius" }) }),
      Object.freeze({ phrase: "\u062a\u063a\u06cc\u06cc\u0631 \u067e\u0627\u0631\u0627\u0645\u062a\u0631 \u0641\u06cc\u0686\u0631", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["set feature parameter", "change fillet radius", "set feature dimension"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "FEATURE_PARAMETER_SET",
      operationId: "updatePartStudioFeature",
      targetResolverOperationId: "getPartStudioFeatures",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PARTSTUDIO_FEATURE_PROJECTION_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or ids, plus feature_name or feature_id",
    argumentDescription: "parameter_id or parameter_name, plus expression (for example \"5 mm\"), value for boolean/enum parameters, or part_name/part_names to replace the parts a query parameter points at",
  }),
  Object.freeze({
    capabilityId: "feature.delete",
    aliases: Object.freeze([
      Object.freeze({ phrase: "delete feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "remove feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "delete last feature", defaults: Object.freeze({ position: "last" }) }),
      Object.freeze({ phrase: "undo last feature", defaults: Object.freeze({ position: "last" }) }),
      Object.freeze({ phrase: "\u062d\u0630\u0641 \u0641\u06cc\u0686\u0631", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u067e\u0627\u06a9 \u06a9\u0631\u062f\u0646 \u0641\u06cc\u0686\u0631", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u062d\u0630\u0641 \u0622\u062e\u0631\u06cc\u0646 \u0641\u06cc\u0686\u0631", defaults: Object.freeze({ position: "last" }) }),
    ]),
    surfaceAliases: Object.freeze(["delete feature", "delete last feature", "\u062d\u0630\u0641 \u0641\u06cc\u0686\u0631"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "FEATURE_DELETE",
      operationId: "deletePartStudioFeature",
      targetResolverOperationId: "getPartStudioFeatures",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PARTSTUDIO_FEATURE_ABSENCE_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or ids; feature_name or feature_id, otherwise the last feature is used",
    argumentDescription: "position:\"last\"|\"first\" when no feature is named",
  }),
  Object.freeze({
    capabilityId: "feature.add",
    aliases: Object.freeze([
      Object.freeze({ phrase: "add feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "create feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "add plane", defaults: Object.freeze({ feature_type: "cPlane" }) }),
      Object.freeze({ phrase: "create plane", defaults: Object.freeze({ feature_type: "cPlane" }) }),
      Object.freeze({ phrase: "add fillet", defaults: Object.freeze({ feature_type: "fillet" }) }),
      Object.freeze({ phrase: "add chamfer", defaults: Object.freeze({ feature_type: "chamfer" }) }),
      Object.freeze({ phrase: "linear pattern", defaults: Object.freeze({ feature_type: "linearPattern" }) }),
      Object.freeze({ phrase: "circular pattern", defaults: Object.freeze({ feature_type: "circularPattern" }) }),
      Object.freeze({ phrase: "mirror", defaults: Object.freeze({ feature_type: "mirror" }) }),
      Object.freeze({ phrase: "\u0627\u0641\u0632\u0648\u062f\u0646 \u0641\u06cc\u0686\u0631", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u0633\u0627\u062e\u062a \u067e\u0644\u06cc\u0646", defaults: Object.freeze({ feature_type: "cPlane" }) }),
    ]),
    surfaceAliases: Object.freeze(["add feature", "add plane", "linear pattern", "add fillet"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "FEATURE_ADD",
      operationId: "addPartStudioFeature",
      targetResolverOperationId: "getPartStudioFeatures",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PARTSTUDIO_FEATURE_ADDED_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id",
    argumentDescription: "feature_type (validated against this Part Studio's feature specs), optional name, and parameters as an object of parameterId to value; quantities take strings such as \"30 mm\", geometry references take part names, feature names, or Top/Front/Right; an empty list [] is allowed and the feature is committed even if it regenerates with an error (reported as featureStatus); built from the official feature spec, no existing feature needed",
  }),
  Object.freeze({
    capabilityId: "feature.from_selection",
    aliases: Object.freeze([
      Object.freeze({ phrase: "feature from current selection", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "fillet current selection", defaults: Object.freeze({ feature_type: "fillet" }) }),
      Object.freeze({ phrase: "fillet selected edge", defaults: Object.freeze({ feature_type: "fillet" }) }),
      Object.freeze({ phrase: "chamfer current selection", defaults: Object.freeze({ feature_type: "chamfer" }) }),
      Object.freeze({ phrase: "chamfer selected edge", defaults: Object.freeze({ feature_type: "chamfer" }) }),
    ]),
    surfaceAliases: Object.freeze(["feature from current selection", "fillet current selection", "chamfer current selection"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "FEATURE_FROM_SELECTION",
      operationId: "addPartStudioFeature",
      targetResolverOperationId: "getPartStudioFeatures",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PERSISTENT_SELECTION_TO_DOCUMENTED_FEATURE_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or document_id/workspace_id/element_id with an existing persistent Viewer selection",
    argumentDescription: "feature_type plus non-selection feature parameters. The existing exact deterministic Viewer selection is first-class input and is bridged to documented BTMIndividualQuery deterministicIds without re-picking coordinates. Optional selection_parameter_id disambiguates features with multiple query parameters. qualification_route:auto|api|ui is admitted only for bounded qualification/benchmarking of the internal route; ordinary use should omit it and remain implementation-independent.",
  }),
  Object.freeze({
    capabilityId: "feature.patch",
    aliases: Object.freeze([
      Object.freeze({ phrase: "edit feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "update feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "suppress feature", defaults: Object.freeze({ suppressed: true }) }),
      Object.freeze({ phrase: "unsuppress feature", defaults: Object.freeze({ suppressed: false }) }),
      Object.freeze({ phrase: "rename feature", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u0648\u06cc\u0631\u0627\u06cc\u0634 \u0641\u06cc\u0686\u0631", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u0633\u0627\u067e\u0631\u0633 \u06a9\u0631\u062f\u0646 \u0641\u06cc\u0686\u0631", defaults: Object.freeze({ suppressed: true }) }),
    ]),
    surfaceAliases: Object.freeze(["edit feature", "suppress feature", "rename feature"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "FEATURE_PATCH",
      operationId: "updatePartStudioFeature",
      targetResolverOperationId: "getPartStudioFeatures",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PARTSTUDIO_FEATURE_PROJECTION_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or ids, plus feature_name or feature_id (otherwise the last feature)",
    argumentDescription: "any combination of suppressed:boolean, new_name, and parameters as an object of parameterId to expression, value, or geometry reference list",
  }),
  Object.freeze({
    capabilityId: "rollback.set",
    aliases: Object.freeze([
      Object.freeze({ phrase: "set rollback", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "move rollback bar", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "rollback to end", defaults: Object.freeze({ position: "end" }) }),
      Object.freeze({ phrase: "\u0631\u0627\u0644\u0628\u06a9 \u0628\u0627\u0631", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["set rollback", "move rollback bar"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "ROLLBACK_SET",
      operationId: "updateRollback",
      targetResolverOperationId: "getPartStudioFeatures",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PARTSTUDIO_ROLLBACK_READBACK",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or ids",
    argumentDescription: "before_feature or after_feature by name, or position:\"end\"|\"start\", or rollback_index (-1 means end)",
  }),
  Object.freeze({
    capabilityId: "metadata.property.set",
    aliases: Object.freeze([
      Object.freeze({ phrase: "set part color", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "change part color", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "set appearance", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "set metadata property", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "set part property", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "rename part", defaults: Object.freeze({ property_name: "Name" }) }),
      Object.freeze({ phrase: "set part material", defaults: Object.freeze({ property_name: "Material" }) }),
      Object.freeze({ phrase: "\u0631\u0646\u06af \u067e\u0627\u0631\u062a", defaults: Object.freeze({}) }),
      Object.freeze({ phrase: "\u062a\u063a\u06cc\u06cc\u0631 \u0631\u0646\u06af \u0642\u0637\u0639\u0647", defaults: Object.freeze({}) }),
    ]),
    surfaceAliases: Object.freeze(["set part color", "set metadata property", "\u0631\u0646\u06af \u067e\u0627\u0631\u062a"]),
    backend: Object.freeze({
      kind: SEMANTIC_BACKEND_DERIVED,
      executor: "METADATA_PROPERTY_SET",
      operationId: "updateWVEPMetadata",
      targetResolverOperationId: "getPartsWMVE",
    }),
    riskClass: RISK_ORDINARY_WRITE,
    verificationStrategy: "PROVIDER_ACKNOWLEDGEMENT",
    qualificationState: QUALIFIED,
    targetDescription: "document_url or ids, plus part_name/part_id for a part property; without a part the element property is set",
    argumentDescription: "property_name or property_id plus value; or color (name, #rrggbb, or {red,green,blue}) for the Appearance property",
  }),
]);

function normalizeColor(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const red = Number(input.red ?? input.r);
    const green = Number(input.green ?? input.g);
    const blue = Number(input.blue ?? input.b);
    if ([red, green, blue].every((value) => Number.isFinite(value) && value >= 0 && value <= 255)) {
      return { red: Math.round(red), green: Math.round(green), blue: Math.round(blue) };
    }
    return null;
  }
  const raw = String(input ?? "").trim().toLowerCase();
  const hex = /^#?([0-9a-f]{6})$/.exec(raw);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return { red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255 };
  }
  const named = {
    red: [255, 0, 0], "\u0642\u0631\u0645\u0632": [255, 0, 0],
    green: [0, 176, 80], "\u0633\u0628\u0632": [0, 176, 80],
    blue: [0, 112, 192], "\u0622\u0628\u06cc": [0, 112, 192],
    yellow: [255, 217, 0], "\u0632\u0631\u062f": [255, 217, 0],
    orange: [255, 140, 0], "\u0646\u0627\u0631\u0646\u062c\u06cc": [255, 140, 0],
    purple: [128, 0, 176], "\u0628\u0646\u0641\u0634": [128, 0, 176],
    black: [26, 26, 26], "\u0645\u0634\u06a9\u06cc": [26, 26, 26], "\u0633\u06cc\u0627\u0647": [26, 26, 26],
    white: [245, 245, 245], "\u0633\u0641\u06cc\u062f": [245, 245, 245],
    gray: [150, 150, 150], grey: [150, 150, 150], "\u062e\u0627\u06a9\u0633\u062a\u0631\u06cc": [150, 150, 150],
    pink: [255, 105, 180], "\u0635\u0648\u0631\u062a\u06cc": [255, 105, 180],
    brown: [139, 69, 19], "\u0642\u0647\u0648\u0647\u200c\u0627\u06cc": [139, 69, 19],
  };
  const hit = named[raw];
  return hit ? { red: hit[0], green: hit[1], blue: hit[2] } : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function elapsedMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("ONSHAPE_AGENT_INVALID", `${label} must be an object`);
  }
  return value;
}

function cleanRequestId(value) {
  const text = String(value || "").trim();
  if (!REQUEST_ID_RE.test(text)) throw codedError("ONSHAPE_REQUEST_ID_INVALID", "Invalid request identity.");
  return text;
}

function operationAliasKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function operationAliases(operation) {
  const values = new Set();
  const operationId = String(operation?.operationId || "").trim();
  if (operationId) {
    values.add(operationId);
    values.add(operationAliasKey(operationId));
  }
  const summary = String(operation?.summary || "").trim();
  if (summary) values.add(operationAliasKey(summary));
  return [...values].filter(Boolean);
}

const DOCUMENT_URL_RE = /\/documents\/([0-9a-f]{24})(?:\/(w|v|m)\/([0-9a-f]{24}))?(?:\/e\/([0-9a-f]{24}))?/i;

export function normalizeHumanName(value) {
  return String(value ?? "")
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, " ")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u064a/g, "\u06cc")
    .replace(/\u0643/g, "\u06a9")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function nameTokens(value) {
  const normalized = normalizeHumanName(value);
  return normalized ? normalized.split(" ") : [];
}

function nameMatchTier(candidateName, requestedName) {
  const candidate = normalizeHumanName(candidateName);
  const requested = normalizeHumanName(requestedName);
  if (!candidate || !requested) return 0;
  if (candidate === requested) return 4;
  if (candidate.startsWith(requested) || requested.startsWith(candidate)) return 3;
  if (candidate.includes(requested) || requested.includes(candidate)) return 2;
  const candidateTokens = new Set(nameTokens(candidateName));
  const requestedTokens = nameTokens(requestedName);
  if (!requestedTokens.length) return 0;
  const shared = requestedTokens.filter((token) => candidateTokens.has(token)).length;
  return shared / requestedTokens.length >= 0.6 ? 1 : 0;
}

// Human words for toolbar features whose canonical id differs from the word.
export const FEATURE_TYPE_ALIASES = Object.freeze({
  derive: "importDerived", derived: "importDerived", "دیرایو": "importDerived", "derived part": "importDerived",
});

export function pickByHumanName(items, requestedName, nameOf) {
  const scored = items
    .map((item) => ({ item, tier: nameMatchTier(nameOf(item), requestedName) }))
    .filter((entry) => entry.tier > 0);
  if (!scored.length) return { match: null, tier: 0, candidates: [] };
  const best = Math.max(...scored.map((entry) => entry.tier));
  const top = scored.filter((entry) => entry.tier === best);
  if (top.length === 1) return { match: top[0].item, tier: best, candidates: [] };
  return { match: null, tier: best, candidates: top.map((entry) => entry.item) };
}

function parseDocumentUrl(value) {
  const match = DOCUMENT_URL_RE.exec(String(value || ""));
  if (!match) return null;
  return {
    documentId: match[1],
    workspaceId: match[2] && match[2].toLowerCase() === "w" ? match[3] : undefined,
    elementId: match[4],
  };
}

function operationRiskClass({ operationId, method, pathTemplate, summary = "" }) {
  if (READ_METHODS.has(method) || READ_ONLY_POST_OPERATION_IDS.has(operationId)) return RISK_READ;
  const path = String(pathTemplate || "");
  // Anything that edits the contents of a document is ordinary work: undo and
  // microversion restore make it reversible, so a name like "delete" must not gate it.
  if (IN_DOCUMENT_PATH_PATTERN.test(path)) return RISK_ORDINARY_WRITE;
  const semanticText = [
    operationAliasKey(operationId),
    operationAliasKey(summary),
  ].join(" ");
  if (EXTERNAL_ADMIN_PATH_PATTERN.test(path) && HIGH_IMPACT_OPERATION_PATTERN.test(semanticText)) return RISK_HIGH_IMPACT;
  if (EXTERNAL_ADMIN_PATH_PATTERN.test(path) && /\b(?:delete|remove|transfer|create|update|post|put)\b/i.test(operationAliasKey(operationId))
      && /(?:member|admin|owner|permission|share|apikey|api key|oauth|webhook)/i.test(semanticText)) {
    return RISK_HIGH_IMPACT;
  }
  if (HIGH_IMPACT_OPERATION_PATTERN.test(semanticText)) return RISK_HIGH_IMPACT;
  return RISK_ORDINARY_WRITE;
}

function operationVerificationStrategy(operationId, riskClass) {
  if (riskClass === RISK_READ) return "HTTP_SUCCESS";
  if (operationId === "updateDocumentAttributes") return "DOCUMENT_NAME_READBACK";
  if (operationId === "copyWorkspace") return "WORKSPACE_COPY_READBACK";
  if (operationId === "updatePartStudioFeature") return "PARTSTUDIO_FEATURE_PROJECTION_READBACK";
  if (operationId === "addPartStudioFeature") return "PARTSTUDIO_FEATURE_ADDED_READBACK";
  if (operationId === "deletePartStudioFeature") return "PARTSTUDIO_FEATURE_ABSENCE_READBACK";
  if (["updateRollback", "updatePartStudioRollback", "setRollback", "updateFeatureRollback"].includes(operationId)) {
    return "PARTSTUDIO_ROLLBACK_READBACK";
  }
  return "PROVIDER_ACKNOWLEDGEMENT";
}

function operationQualificationState(riskClass) {
  return riskClass === RISK_HIGH_IMPACT ? QUALIFIED_OWNER_INTENT : QUALIFIED;
}

export class OnshapeAgent {
  constructor({
    core,
    openApiFile,
    stateDir,
    buildId,
    allowedOpenApiRoot = "/openapi",
  }) {
    if (!core) throw new Error("OnshapeAgent requires Onshape core.");
    this.core = core;
    this.openApiFile = path.resolve(String(openApiFile || ""));
    this.stateDir = String(stateDir || "");
    this.buildId = String(buildId || "unknown");
    const openApiRoot = path.resolve(String(allowedOpenApiRoot || "/openapi"));
    const openApiRelative = path.relative(openApiRoot, this.openApiFile);
    if (!openApiRelative || openApiRelative === ".." || openApiRelative.startsWith(".." + path.sep) || path.isAbsolute(openApiRelative)) {
      throw new Error("Invalid OpenAPI path.");
    }
    if (!this.stateDir.startsWith("/")) throw new Error("Agent state directory must be absolute.");
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateDir, 0o700);
    this._operationRegistry = this._buildOperationRegistry();
    this._semanticRegistry = this._buildSemanticRegistry();
  }

  _recordPath(requestId) {
    const safe = cleanRequestId(requestId);
    const name = createHash("sha256").update(safe).digest("hex") + ".json";
    return path.join(this.stateDir, name);
  }

  _readRecord(requestId) {
    const file = this._recordPath(requestId);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.requestId !== requestId) {
      throw codedError("ONSHAPE_JOURNAL_INVALID", "Persisted request record is invalid.");
    }
    return parsed;
  }

  _writeRecord(record) {
    const file = this._recordPath(record.requestId);
    const tmp = file + ".tmp-" + process.pid + "-" + randomBytes(4).toString("hex");
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  }

  _readSpec() {
    const raw = fs.readFileSync(this.openApiFile, "utf8");
    const spec = JSON.parse(raw);
    if (!spec || typeof spec !== "object" || !spec.paths || typeof spec.info?.version !== "string") {
      throw codedError("OPENAPI_SPEC_INVALID", "Local OpenAPI specification is invalid.");
    }
    const servers = Array.isArray(spec.servers) ? spec.servers : [];
    if (servers.length !== 1 || typeof servers[0]?.url !== "string") {
      throw codedError("OPENAPI_SERVER_INVALID", "Official OpenAPI contract must expose exactly one executable server.");
    }
    let server;
    try {
      server = new URL(servers[0].url);
    } catch {
      throw codedError("OPENAPI_SERVER_INVALID", "Official OpenAPI server URL is invalid.");
    }
    if (server.protocol !== "https:" || server.hostname !== "cad.onshape.com" || server.search || server.hash) {
      throw codedError("OPENAPI_SERVER_INVALID", "Official OpenAPI server must be the expected HTTPS Onshape origin.");
    }
    const apiBasePath = server.pathname.replace(/\/$/, "");
    if (!/^\/api\/v[1-9][0-9]*$/.test(apiBasePath)) {
      throw codedError("OPENAPI_SERVER_INVALID", "Official OpenAPI server must provide an explicit versioned /api/vN base path.");
    }
    return {
      spec,
      hash: sha256Json(spec),
      version: spec.info.version,
      apiBasePath,
      apiVersion: apiBasePath.split("/").pop(),
    };
  }

  _buildOperationRegistry() {
    const { spec, hash, version, apiBasePath, apiVersion } = this._readSpec();
    const byId = new Map();
    const aliasCandidates = new Map();

    for (const [pathTemplate, item] of Object.entries(spec.paths || {})) {
      if (!item || typeof item !== "object") continue;
      const pathParameters = Array.isArray(item.parameters) ? item.parameters : [];
      for (const [methodRaw, operation] of Object.entries(item)) {
        const method = String(methodRaw).toUpperCase();
        if (!METHODS.has(method) || !operation || typeof operation !== "object") continue;
        const operationId = String(operation.operationId || "").trim();
        if (!operationId) continue;
        if (byId.has(operationId)) {
          throw codedError("OPENAPI_OPERATION_AMBIGUOUS", `Duplicate official OpenAPI operationId: ${operationId}.`);
        }
        const parameters = [
          ...pathParameters,
          ...(Array.isArray(operation.parameters) ? operation.parameters : []),
        ];
        const requiredPathParameters = parameters
          .filter((p) => p?.in === "path" && p?.required)
          .map((p) => String(p.name));
        const summary = typeof operation.summary === "string" ? operation.summary : null;
        const riskClass = operationRiskClass({ operationId, method, pathTemplate, summary: summary || "" });
        const contract = Object.freeze({
          operationId,
          method,
          pathTemplate,
          openapiHash: hash,
          openapiVersion: version,
          apiBasePath,
          apiVersion,
          riskClass,
          verificationStrategy: operationVerificationStrategy(operationId, riskClass),
          qualificationState: operationQualificationState(riskClass),
          requiredPathParameters,
          parameters: parameters.slice(0, 80).map((p) => ({
            name: p?.name ?? null,
            in: p?.in ?? null,
            required: !!p?.required,
            schema: p?.schema?.type ?? null,
          })),
          requestContentTypes: Object.keys(operation.requestBody?.content || {}),
          responseContentTypes: [...new Set(
            Object.values(operation.responses || {}).flatMap((r) => Object.keys(r?.content || {})),
          )],
          summary,
        });
        byId.set(operationId, contract);
        for (const alias of operationAliases(operation)) {
          const key = operationAliasKey(alias);
          if (!key) continue;
          if (!aliasCandidates.has(key)) aliasCandidates.set(key, []);
          aliasCandidates.get(key).push(operationId);
        }
      }
    }

    const byAlias = new Map();
    for (const [key, ids] of aliasCandidates.entries()) {
      const unique = [...new Set(ids)];
      if (unique.length === 1) byAlias.set(key, unique[0]);
    }
    if (byId.size < 1) {
      throw codedError("OPENAPI_SPEC_INVALID", "Official OpenAPI registry contains no executable operations.");
    }
    return Object.freeze({
      byId,
      byAlias,
      count: byId.size,
      openapiHash: hash,
      openapiVersion: version,
      apiBasePath,
      apiVersion,
    });
  }

  resolveOperation(operationIdOrAlias) {
    const requested = String(operationIdOrAlias || "").trim();
    if (!requested || requested.length > 240 || /[\r\n\0]/.test(requested)) {
      throw codedError("OPENAPI_OPERATION_ID_INVALID", "Invalid OpenAPI operation selector.");
    }
    const direct = this._operationRegistry.byId.get(requested);
    if (direct) return direct;
    const canonicalId = this._operationRegistry.byAlias.get(operationAliasKey(requested));
    if (!canonicalId) {
      throw codedError(
        "OPENAPI_OPERATION_NOT_FOUND",
        `No unique pre-indexed official OpenAPI operation for ${requested}.`,
      );
    }
    return this._operationRegistry.byId.get(canonicalId);
  }

  operationRegistryStatus() {
    return {
      count: this._operationRegistry.count,
      openapiHash: this._operationRegistry.openapiHash,
      openapiVersion: this._operationRegistry.openapiVersion,
      apiBasePath: this._operationRegistry.apiBasePath,
      apiVersion: this._operationRegistry.apiVersion,
      resolution: "startup-preindexed",
    };
  }

  operationRegistry() {
    return {
      ...this.operationRegistryStatus(),
      operations: [...this._operationRegistry.byId.values()].map((item) => ({
        operationId: item.operationId,
        method: item.method,
        pathTemplate: item.pathTemplate,
        requiredPathParameters: item.requiredPathParameters,
        parameters: item.parameters,
        requestContentTypes: item.requestContentTypes,
        responseContentTypes: item.responseContentTypes,
        summary: item.summary,
        riskClass: item.riskClass,
        verificationStrategy: item.verificationStrategy,
        qualificationState: item.qualificationState,
        agentEffect: (
          READ_METHODS.has(item.method) || READ_ONLY_POST_OPERATION_IDS.has(item.operationId)
        ) ? "READ_ONLY" : "MUTATION",
      })),
    };
  }

  _buildSemanticRegistry() {
    const byId = new Map();
    const aliasCandidates = new Map();
    const publicCapabilities = [];

    const addAlias = (capabilityId, phrase, defaults = {}, replace = false) => {
      const key = operationAliasKey(phrase);
      if (!key) return;
      if (replace || !aliasCandidates.has(key)) aliasCandidates.set(key, []);
      aliasCandidates.get(key).push({
        capabilityId,
        defaults: plainObject(defaults, "semantic alias defaults"),
      });
    };

    for (const operation of this._operationRegistry.byId.values()) {
      const capabilityId = `documented.${operation.operationId}`;
      const contract = Object.freeze({
        capabilityId,
        backend: Object.freeze({
          kind: SEMANTIC_BACKEND_DOCUMENTED,
          operationId: operation.operationId,
        }),
        riskClass: operation.riskClass,
        verificationStrategy: operation.verificationStrategy,
        qualificationState: operation.qualificationState,
        targetDescription: "documented operation path parameters; common document/workspace/element/entity ids auto-map from target",
        argumentDescription: "query/body/headers/multipart follow the precompiled documented contract",
      });
      byId.set(capabilityId, contract);
      for (const alias of operationAliases(operation)) addAlias(capabilityId, alias, {});

      const curated = DOCUMENTED_SEMANTIC_ALIASES[operation.operationId] || [];
      for (const phrase of curated) addAlias(capabilityId, phrase, {}, true);
      if (curated.length) {
        publicCapabilities.push(Object.freeze({
          capabilityId,
          intents: Object.freeze([...new Set([
            ...(operation.summary ? [operation.summary] : []),
            ...curated,
          ])]),
          backend: SEMANTIC_BACKEND_DOCUMENTED,
          riskClass: operation.riskClass,
          target: contract.targetDescription,
          arguments: contract.argumentDescription,
        }));
      }
    }

    for (const capability of [...BOUNDED_UI_CAPABILITIES, ...DERIVED_CAPABILITIES]) {
      if (capability.backend.targetResolverOperationId
        && !this._operationRegistry.byId.has(capability.backend.targetResolverOperationId)) continue;
      const contract = Object.freeze({
        capabilityId: capability.capabilityId,
        backend: Object.freeze({ ...capability.backend }),
        riskClass: capability.riskClass,
        verificationStrategy: capability.verificationStrategy,
        qualificationState: capability.qualificationState,
        targetDescription: capability.targetDescription,
        argumentDescription: capability.argumentDescription,
      });
      byId.set(contract.capabilityId, contract);
      for (const alias of capability.aliases) {
        addAlias(contract.capabilityId, alias.phrase, alias.defaults, true);
      }
      publicCapabilities.push(Object.freeze({
        capabilityId: contract.capabilityId,
        intents: [...capability.surfaceAliases],
        backend: contract.backend.kind,
        riskClass: contract.riskClass,
        target: contract.targetDescription,
        arguments: contract.argumentDescription,
      }));
    }

    const byAlias = new Map();
    for (const [key, candidates] of aliasCandidates.entries()) {
      const unique = new Map();
      for (const candidate of candidates) {
        unique.set(`${candidate.capabilityId}\n${stableJson(candidate.defaults)}`, candidate);
      }
      if (unique.size === 1) byAlias.set(key, [...unique.values()][0]);
    }

    return Object.freeze({
      byId,
      byAlias,
      publicCapabilities: Object.freeze(publicCapabilities),
      count: byId.size,
      resolution: "startup-precompiled-semantic",
    });
  }

  resolveIntent(intentInput) {
    const requested = String(intentInput || "").trim();
    if (!requested || requested.length > 240 || /[\r\n\0]/.test(requested)) {
      throw codedError("ONSHAPE_INTENT_INVALID", "Invalid Onshape intent selector.");
    }
    const direct = this._semanticRegistry.byId.get(requested);
    if (direct) return { contract: direct, defaults: {} };
    let resolved = this._semanticRegistry.byAlias.get(operationAliasKey(requested));
    if (!resolved) {
      const tolerant = this._tolerantIntentMatch(requested);
      if (tolerant.match) resolved = tolerant.match;
      else {
        throw codedError(
          "ONSHAPE_INTENT_NOT_FOUND",
          `No admitted semantic capability for "${requested}". Closest admitted intents: ${tolerant.suggestions.join(" | ") || "none"}. Call onshape_capability_list for the full catalogue.`,
        );
      }
    }
    return {
      contract: this._semanticRegistry.byId.get(resolved.capabilityId),
      defaults: { ...resolved.defaults },
    };
  }

  _tolerantIntentMatch(requested) {
    const requestedTokens = nameTokens(requested);
    const scores = [];
    for (const [aliasKey, candidate] of this._semanticRegistry.byAlias.entries()) {
      const aliasTokens = new Set(nameTokens(aliasKey));
      if (!requestedTokens.length || !aliasTokens.size) continue;
      const shared = requestedTokens.filter((token) => aliasTokens.has(token)).length;
      const score = shared / Math.max(requestedTokens.length, aliasTokens.size);
      if (score > 0) scores.push({ aliasKey, candidate, score });
    }
    scores.sort((a, b) => b.score - a.score);
    const suggestions = [];
    for (const entry of scores) {
      if (suggestions.length >= 5) break;
      if (!suggestions.includes(entry.aliasKey)) suggestions.push(entry.aliasKey);
    }
    const best = scores[0];
    const runnerUp = scores.find((entry) => entry && best && entry.candidate.capabilityId !== best.candidate.capabilityId);
    const clear = Boolean(best)
      && best.score >= 0.6
      && (!runnerUp || best.score - runnerUp.score >= 0.15);
    return { match: clear ? best.candidate : null, suggestions };
  }

  async _readDocumented(operationId, target) {
    const operation = this.resolveOperation(operationId);
    const pathParams = this._semanticPathParams(operation, target, {});
    const read = await this.executeDocumentedOperation({ operationId: operation.operationId, pathParams });
    if (read.state !== "SUCCEEDED") {
      throw codedError("ONSHAPE_IDENTITY_READ_FAILED", `${operationId} read did not succeed.`);
    }
    return read?.evidence?.body;
  }

  async resolveIdentities(input = {}) {
    const request = plainObject(input, "identity request");
    const fromUrl = request.document_url ? parseDocumentUrl(request.document_url) : null;
    const documentId = String(request.document_id ?? request.documentId ?? fromUrl?.documentId ?? "").trim();
    let workspaceId = String(request.workspace_id ?? request.workspaceId ?? fromUrl?.workspaceId ?? "").trim();
    let elementId = String(request.element_id ?? request.elementId ?? fromUrl?.elementId ?? "").trim();
    if (!/^[0-9a-fA-F]{24}$/.test(documentId)) {
      throw codedError("ONSHAPE_IDENTITY_TARGET_INVALID", "A document id or document URL is required.");
    }
    const result = { document_id: documentId, workspace_id: workspaceId || null, element_id: elementId || null };
    const elementName = String(request.element_name ?? request.elementName ?? "").trim();
    const partName = String(request.part_name ?? request.partName ?? "").trim();
    const featureName = String(request.feature_name ?? request.featureName ?? "").trim();
    const wantElements = Boolean(elementName) || request.include_elements === true || !elementId;

    if (!workspaceId) {
      throw codedError("ONSHAPE_IDENTITY_TARGET_INVALID", "A workspace id is required; take it from the document URL.");
    }

    if (wantElements) {
      const body = await this._readDocumented("getElementsInDocument", { document_id: documentId, workspace_id: workspaceId });
      const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
      result.elements = rows.map((row) => ({
        element_id: String(row?.id ?? "").trim(),
        name: String(row?.name ?? "").trim(),
        element_type: String(row?.elementType ?? row?.type ?? "").trim(),
      })).filter((row) => row.element_id);
      if (elementName) {
        const picked = pickByHumanName(result.elements, elementName, (row) => row.name);
        if (!picked.match) {
          throw codedError(
            picked.candidates.length ? "ONSHAPE_IDENTITY_AMBIGUOUS" : "ONSHAPE_IDENTITY_NOT_FOUND",
            `Tab "${elementName}" matched ${picked.candidates.length} tabs. Available: ${result.elements.map((row) => row.name).join(" | ")}`,
          );
        }
        elementId = picked.match.element_id;
        result.element_id = elementId;
        result.element_name = picked.match.name;
      }
    }

    if ((partName || request.include_parts === true) && elementId) {
      const body = await this._readDocumented("getPartsWMVE", { document_id: documentId, workspace_id: workspaceId, element_id: elementId });
      const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.parts) ? body.parts : [];
      result.parts = rows.map((row) => ({
        part_id: String(row?.partId ?? row?.id ?? "").trim(),
        name: String(row?.name ?? "").trim(),
      })).filter((row) => row.part_id);
      if (partName) {
        const picked = pickByHumanName(result.parts, partName, (row) => row.name);
        if (!picked.match) {
          throw codedError(
            picked.candidates.length ? "ONSHAPE_IDENTITY_AMBIGUOUS" : "ONSHAPE_IDENTITY_NOT_FOUND",
            `Part "${partName}" matched ${picked.candidates.length} parts. Available: ${result.parts.map((row) => row.name).join(" | ")}`,
          );
        }
        result.part_id = picked.match.part_id;
        result.part_name = picked.match.name;
      }
    }

    if ((featureName || request.include_features === true) && elementId) {
      const body = await this._readDocumented("getPartStudioFeatures", { document_id: documentId, workspace_id: workspaceId, element_id: elementId });
      const rows = Array.isArray(body?.features) ? body.features : Array.isArray(body) ? body : [];
      result.features = rows.map((row) => {
        const message = row?.message ?? row;
        return {
          feature_id: String(message?.featureId ?? "").trim(),
          name: String(message?.name ?? "").trim(),
          feature_type: String(message?.featureType ?? "").trim(),
        };
      }).filter((row) => row.feature_id);
      if (featureName) {
        const picked = pickByHumanName(result.features, featureName, (row) => row.name);
        if (!picked.match) {
          throw codedError(
            picked.candidates.length ? "ONSHAPE_IDENTITY_AMBIGUOUS" : "ONSHAPE_IDENTITY_NOT_FOUND",
            `Feature "${featureName}" matched ${picked.candidates.length} features. Available: ${result.features.map((row) => row.name).join(" | ")}`,
          );
        }
        result.feature_id = picked.match.feature_id;
        result.feature_name = picked.match.name;
        result.feature_type = picked.match.feature_type;
      }
    }

    return result;
  }

  async _buildDeletePartBodies(target) {
    const operation = this.resolveOperation("addPartStudioFeature");
    const documentId = String(target.document_id ?? target.documentId ?? "").trim();
    const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
    const elementId = String(target.element_id ?? target.elementId ?? "").trim();
    if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      throw codedError("ONSHAPE_TARGET_ID_INVALID", "Deleting a part requires 24-hex document/workspace/element ids or a document URL.");
    }
    const requestedName = String(target.part_name ?? target.partName ?? "").trim();
    const requestedId = String(target.part_id ?? target.partId ?? "").trim();
    if (!requestedName && !requestedId) {
      throw codedError("ONSHAPE_TARGET_REQUIRED", "Deleting a part requires part_name or part_id.");
    }
    const body = await this._readDocumented("getPartsWMVE", {
      document_id: documentId,
      workspace_id: workspaceId,
      element_id: elementId,
    });
    const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.parts) ? body.parts : [];
    const byId = rows.filter((row) => !requestedId || String(row?.partId ?? row?.id ?? "").trim() === requestedId);
    let picked = byId.length === 1 && !requestedName ? { match: byId[0], candidates: [] } : { match: null, candidates: [] };
    if (requestedName) picked = pickByHumanName(byId, requestedName, (row) => String(row?.name ?? ""));
    if (!picked.match) {
      throw codedError(
        picked.candidates.length ? "ONSHAPE_TARGET_AMBIGUOUS" : "ONSHAPE_TARGET_NOT_FOUND",
        `Part target matched ${picked.candidates.length} parts. Available: ${rows.map((row) => String(row?.name ?? "")).join(" | ")}`,
      );
    }
    const partName = String(picked.match?.name ?? "").trim();
    const partQuery = String(picked.match?.partQuery ?? "").trim();
    if (!partQuery) {
      throw codedError("ONSHAPE_PART_QUERY_MISSING", "The resolved part row carries no partQuery, so the admitted deleteBodies payload cannot be derived.");
    }
    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: documentId,
        workspace_id: workspaceId,
        element_id: elementId,
      }, {}),
      body: {
        feature: {
          btType: "BTMFeature-134",
          featureType: "deleteBodies",
          name: `Delete ${partName}`,
          parameters: [
            {
              btType: "BTMParameterQueryList-148",
              parameterId: "entities",
              queries: [{ btType: "BTMIndividualQuery-138", queryString: partQuery }],
            },
          ],
        },
      },
      summary: { part_name: partName, feature_type: "deleteBodies" },
    };
  }

  async _buildFeatureParameterUpdate(target, args) {
    const operation = this.resolveOperation("updatePartStudioFeature");
    const documentId = String(target.document_id ?? target.documentId ?? "").trim();
    const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
    const elementId = String(target.element_id ?? target.elementId ?? "").trim();
    if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      throw codedError("ONSHAPE_TARGET_ID_INVALID", "Editing a feature requires 24-hex document/workspace/element ids or a document URL.");
    }
    const requestedFeatureName = String(target.feature_name ?? target.featureName ?? "").trim();
    const requestedFeatureId = String(target.feature_id ?? target.featureId ?? "").trim();
    if (!requestedFeatureName && !requestedFeatureId) {
      throw codedError("ONSHAPE_TARGET_REQUIRED", "Editing a feature requires feature_name or feature_id.");
    }
    const read = await this._readDocumented("getPartStudioFeatures", {
      document_id: documentId,
      workspace_id: workspaceId,
      element_id: elementId,
    });
    const rows = Array.isArray(read?.features) ? read.features : Array.isArray(read) ? read : [];
    const messages = rows.map((row) => row?.message ?? row).filter(Boolean);
    let feature = null;
    if (requestedFeatureId) {
      feature = messages.find((item) => String(item?.featureId ?? "").trim() === requestedFeatureId) || null;
    }
    if (!feature && requestedFeatureName) {
      const picked = pickByHumanName(messages, requestedFeatureName, (item) => String(item?.name ?? ""));
      if (!picked.match) {
        throw codedError(
          picked.candidates.length ? "ONSHAPE_TARGET_AMBIGUOUS" : "ONSHAPE_TARGET_NOT_FOUND",
          `Feature target matched ${picked.candidates.length} features. Available: ${messages.map((item) => String(item?.name ?? "")).join(" | ")}`,
        );
      }
      feature = picked.match;
    }
    if (!feature) throw codedError("ONSHAPE_TARGET_NOT_FOUND", "Feature target was not found in this Part Studio.");

    const parameters = Array.isArray(feature.parameters) ? feature.parameters : [];
    const requestedParameterId = String(args.parameter_id ?? args.parameterId ?? "").trim();
    const requestedParameterName = String(args.parameter_name ?? args.parameterName ?? "").trim();
    let selector = requestedParameterId || requestedParameterName;
    const wantsQuerySwap = (args.part_names ?? args.partNames ?? args.part_name ?? args.partName
      ?? args.part_ids ?? args.partIds ?? args.part_id ?? args.partId) !== undefined;
    if (!selector && wantsQuerySwap) {
      const queryParameters = parameters.filter((item) => Array.isArray(item?.queries));
      if (queryParameters.length === 1) selector = String(queryParameters[0]?.parameterId ?? "");
    }
    if (!selector) {
      throw codedError(
        "ONSHAPE_INTENT_ARGUMENTS",
        `parameter_id is required. Parameters on "${feature.name}": ${parameters.map((item) => String(item?.parameterId ?? "")).join(" | ")}`,
      );
    }
    const pickedParameter = pickByHumanName(parameters, selector, (item) => String(item?.parameterId ?? ""));
    const parameter = pickedParameter.match;
    if (!parameter) {
      throw codedError(
        "ONSHAPE_PARAMETER_NOT_FOUND",
        `Parameter "${selector}" was not found on "${feature.name}". Parameters: ${parameters.map((item) => String(item?.parameterId ?? "")).join(" | ")}`,
      );
    }
    const expression = args.expression === undefined ? undefined : String(args.expression).trim();
    const updated = JSON.parse(JSON.stringify(feature));
    const updatedParameter = updated.parameters.find(
      (item) => String(item?.parameterId ?? "") === String(parameter.parameterId ?? ""),
    );
    const partInput = args.part_names ?? args.partNames ?? args.part_name ?? args.partName
      ?? args.part_ids ?? args.partIds ?? args.part_id ?? args.partId;
    if (partInput !== undefined && Array.isArray(updatedParameter?.queries)) {
      const wanted = Array.isArray(partInput) ? partInput : [partInput];
      const resolvedParts = await this._resolvePartQueries(documentId, workspaceId, elementId, wanted);
      updatedParameter.queries = resolvedParts.map((row) => ({
        btType: "BTMIndividualQuery-138",
        queryString: row.partQuery,
      }));
      const bodyQuery = { feature: updated, rejectMicroversionSkew: false };
      if (read?.serializationVersion) bodyQuery.serializationVersion = read.serializationVersion;
      if (read?.sourceMicroversion) bodyQuery.sourceMicroversion = read.sourceMicroversion;
      if (read?.libraryVersion) bodyQuery.libraryVersion = read.libraryVersion;
      return {
        operationId: operation.operationId,
        pathParams: this._semanticPathParams(operation, {
          document_id: documentId,
          workspace_id: workspaceId,
          element_id: elementId,
          feature_id: String(feature.featureId ?? "").trim(),
        }, {}),
        body: bodyQuery,
        summary: {
          feature_name: String(feature.name ?? ""),
          feature_type: String(feature.featureType ?? ""),
          parameter_id: String(parameter.parameterId ?? ""),
          parts: resolvedParts.map((row) => row.name),
        },
      };
    }
    if (expression !== undefined && expression !== "") {
      if (!("expression" in updatedParameter)) {
        throw codedError("ONSHAPE_PARAMETER_KIND", `Parameter "${parameter.parameterId}" carries no expression; pass value instead.`);
      }
      updatedParameter.expression = expression;
    } else if (args.value !== undefined) {
      updatedParameter.value = args.value;
    } else {
      throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Pass expression (for quantities) or value (for boolean/enum parameters).");
    }

    const body = { feature: updated, rejectMicroversionSkew: false };
    if (read?.serializationVersion) body.serializationVersion = read.serializationVersion;
    if (read?.sourceMicroversion) body.sourceMicroversion = read.sourceMicroversion;
    if (read?.libraryVersion) body.libraryVersion = read.libraryVersion;

    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: documentId,
        workspace_id: workspaceId,
        element_id: elementId,
        feature_id: String(feature.featureId ?? "").trim(),
      }, {}),
      body,
      summary: {
        feature_name: String(feature.name ?? ""),
        feature_type: String(feature.featureType ?? ""),
        parameter_id: String(parameter.parameterId ?? ""),
        expression: expression ?? null,
      },
    };
  }

  async _readPartStudioFeatures(documentId, workspaceId, elementId) {
    const read = await this._readDocumented("getPartStudioFeatures", {
      document_id: documentId,
      workspace_id: workspaceId,
      element_id: elementId,
    });
    const rows = Array.isArray(read?.features) ? read.features : Array.isArray(read) ? read : [];
    return { read, messages: rows.map((row) => row?.message ?? row).filter(Boolean) };
  }

  _requireStudioIds(target, what) {
    const documentId = String(target.document_id ?? target.documentId ?? "").trim();
    const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
    const elementId = String(target.element_id ?? target.elementId ?? "").trim();
    if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      throw codedError("ONSHAPE_TARGET_ID_INVALID", `${what} requires 24-hex document/workspace/element ids or a document URL.`);
    }
    return { documentId, workspaceId, elementId };
  }

  async _buildFeatureDelete(target, args = {}) {
    const operation = this.resolveOperation("deletePartStudioFeature");
    const { documentId, workspaceId, elementId } = this._requireStudioIds(target, "Deleting a feature");
    const { messages } = await this._readPartStudioFeatures(documentId, workspaceId, elementId);
    if (!messages.length) throw codedError("ONSHAPE_TARGET_NOT_FOUND", "This Part Studio has no features.");
    const requestedId = String(target.feature_id ?? target.featureId ?? "").trim();
    const requestedName = String(target.feature_name ?? target.featureName ?? "").trim();
    const position = String(args.position ?? args.feature_position ?? "").trim().toLowerCase();
    let feature = null;
    if (requestedId) {
      feature = messages.find((item) => String(item?.featureId ?? "").trim() === requestedId) || null;
    } else if (requestedName) {
      const picked = pickByHumanName(messages, requestedName, (item) => String(item?.name ?? ""));
      if (!picked.match) {
        throw codedError(
          picked.candidates.length ? "ONSHAPE_TARGET_AMBIGUOUS" : "ONSHAPE_TARGET_NOT_FOUND",
          `Feature "${requestedName}" matched ${picked.candidates.length} features. Available: ${messages.map((item) => String(item?.name ?? "")).join(" | ")}`,
        );
      }
      feature = picked.match;
    } else if (position === "first") {
      feature = messages[0];
    } else {
      feature = messages[messages.length - 1];
    }
    if (!feature) throw codedError("ONSHAPE_TARGET_NOT_FOUND", "Feature target was not found in this Part Studio.");
    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: documentId,
        workspace_id: workspaceId,
        element_id: elementId,
        feature_id: String(feature.featureId ?? "").trim(),
      }, {}),
      body: undefined,
      summary: {
        feature_name: String(feature.name ?? ""),
        feature_type: String(feature.featureType ?? ""),
        selected_by: requestedId ? "feature_id" : requestedName ? "feature_name" : (position || "last"),
      },
    };
  }

  async _resolvePartQueries(documentId, workspaceId, elementId, names) {
    const body = await this._readDocumented("getPartsWMVE", {
      document_id: documentId,
      workspace_id: workspaceId,
      element_id: elementId,
    });
    const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.parts) ? body.parts : [];
    const picked = [];
    for (const wanted of names) {
      const value = String(wanted ?? "").trim();
      if (!value) continue;
      let row = rows.find((item) => String(item?.partId ?? item?.id ?? "").trim() === value) || null;
      if (!row) {
        const match = pickByHumanName(rows, value, (item) => String(item?.name ?? ""));
        if (!match.match) {
          throw codedError(
            match.candidates.length ? "ONSHAPE_TARGET_AMBIGUOUS" : "ONSHAPE_TARGET_NOT_FOUND",
            `Part "${value}" matched ${match.candidates.length} parts. Available: ${rows.map((item) => String(item?.name ?? "")).join(" | ")}`,
          );
        }
        row = match.match;
      }
      const partQuery = String(row?.partQuery ?? "").trim();
      if (!partQuery) throw codedError("ONSHAPE_PART_QUERY_MISSING", `Part "${value}" carries no partQuery.`);
      picked.push({ name: String(row?.name ?? ""), partQuery });
    }
    if (!picked.length) throw codedError("ONSHAPE_INTENT_ARGUMENTS", "No part was given for the query input.");
    return picked;
  }


  // ---------------------------------------------------------------------
  // Generic feature read-modify-write engine.
  // Every Part Studio write is the same shape: read the feature list, locate
  // or build one feature object, echo the read's identity fields back, and
  // send it to the documented endpoint. Capabilities below are thin wrappers
  // over these helpers instead of one-off payload builders.
  // ---------------------------------------------------------------------

  _locateFeature(messages, { featureId = "", featureName = "", position = "", index = null } = {}) {
    const id = String(featureId || "").trim();
    const name = String(featureName || "").trim();
    const where = String(position || "").trim().toLowerCase();
    if (id) {
      const found = messages.find((item) => String(item?.featureId ?? "").trim() === id);
      if (!found) throw codedError("ONSHAPE_TARGET_NOT_FOUND", `Feature id "${id}" is not in this Part Studio.`);
      return found;
    }
    if (name) {
      const picked = pickByHumanName(messages, name, (item) => String(item?.name ?? ""));
      if (!picked.match) {
        throw codedError(
          picked.candidates.length ? "ONSHAPE_TARGET_AMBIGUOUS" : "ONSHAPE_TARGET_NOT_FOUND",
          `Feature "${name}" matched ${picked.candidates.length} features. Available: ${messages.map((item) => String(item?.name ?? "")).join(" | ")}`,
        );
      }
      return picked.match;
    }
    if (Number.isInteger(index) && index >= 0 && index < messages.length) return messages[index];
    if (where === "first") return messages[0];
    if (where === "last" || !where) return messages[messages.length - 1];
    throw codedError("ONSHAPE_TARGET_REQUIRED", "Pass feature_name, feature_id, or position (first/last).");
  }

  _featureWriteEnvelope(read, feature) {
    const body = { feature, rejectMicroversionSkew: false };
    if (read?.serializationVersion) body.serializationVersion = read.serializationVersion;
    if (read?.sourceMicroversion) body.sourceMicroversion = read.sourceMicroversion;
    if (read?.libraryVersion) body.libraryVersion = read.libraryVersion;
    return body;
  }

  // Turn one human token into an Onshape query: a part name/id, a default
  // plane (Top/Front/Right), or an existing feature's created geometry.
  async _resolveQueryToken(documentId, workspaceId, elementId, token, featureMessages) {
    const value = String(token ?? "").trim();
    if (!value) throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Empty geometry reference.");
    if (/^query=/.test(value)) return value;
    const plane = { top: "Top", front: "Front", right: "Right", "\u0628\u0627\u0644\u0627": "Top", "\u062c\u0644\u0648": "Front", "\u0631\u0627\u0633\u062a": "Right" }[value.toLowerCase()];
    if (plane) return `query=qCreatedBy(makeId("${plane}"), EntityType.FACE);`;
    try {
      const [part] = await this._resolvePartQueries(documentId, workspaceId, elementId, [value]);
      if (part?.partQuery) return part.partQuery;
    } catch (error) {
      if (!/NOT_FOUND|AMBIGUOUS/.test(String(error?.code || ""))) throw error;
    }
    const messages = featureMessages || (await this._readPartStudioFeatures(documentId, workspaceId, elementId)).messages;
    const picked = pickByHumanName(messages, value, (item) => String(item?.name ?? ""));
    if (picked.match) return `query=qCreatedBy(makeId("${String(picked.match.featureId ?? "").trim()}"));`;
    throw codedError("ONSHAPE_TARGET_NOT_FOUND", `Geometry reference "${value}" matched no part, default plane, or feature.`);
  }

  async _queryListParameter(documentId, workspaceId, elementId, parameterId, tokens, featureMessages) {
    const list = Array.isArray(tokens) ? tokens : [tokens];
    const queries = [];
    for (const token of list) {
      const deterministicId = token && typeof token === "object" && !Array.isArray(token)
        ? String(token.deterministic_id ?? token.deterministicId ?? "").trim()
        : (/^deterministic:/i.test(String(token ?? ""))
            ? String(token).replace(/^deterministic:/i, "").trim()
            : "");
      if (deterministicId) {
        if (deterministicId.length > 240 || /[\r\n\0]/.test(deterministicId)) {
          throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Invalid deterministic entity identity.");
        }
        queries.push({
          btType: "BTMIndividualQuery-138",
          deterministicIds: [deterministicId],
        });
        continue;
      }
      queries.push({
        btType: "BTMIndividualQuery-138",
        queryString: await this._resolveQueryToken(documentId, workspaceId, elementId, token, featureMessages),
      });
    }
    return { btType: "BTMParameterQueryList-148", parameterId, queries };
  }

  // Build one parameter object, preferring the official feature spec for its
  // exact btType and enum namespace, falling back to value-shape inference.
  async _featureParameter(ids, parameterId, value, spec, featureMessages) {
    const specType = String(spec?.btType ?? "");
    const isQuery = /Query/i.test(specType)
      || (!spec && (Array.isArray(value) || (value && typeof value === "object" && (value.parts || value.entities || value.queries))));
    if (isQuery) {
      const tokens = Array.isArray(value) ? value : (value?.parts ?? value?.entities ?? value?.queries ?? value);
      return this._queryListParameter(ids.documentId, ids.workspaceId, ids.elementId, parameterId, tokens, featureMessages);
    }
    if (/Bool/i.test(specType) || typeof value === "boolean") {
      return { btType: "BTMParameterBoolean-144", parameterId, value: value === true || value === "true" };
    }
    if (/Enum/i.test(specType)) {
      const options = Array.isArray(spec?.options) ? spec.options : [];
      const wanted = String(value ?? "").trim();
      const match = options.find((item) => String(item?.option ?? "").toLowerCase() === wanted.toLowerCase())
        || options.find((item) => String(item?.optionName ?? item?.option ?? "").toLowerCase() === wanted.toLowerCase());
      return {
        btType: "BTMParameterEnum-145",
        parameterId,
        enumName: String(spec?.enumName ?? ""),
        namespace: String(spec?.namespace ?? ""),
        value: String(match?.option ?? wanted).toUpperCase() === String(match?.option ?? "") ? String(match?.option ?? wanted) : String(match?.option ?? wanted),
      };
    }
    if (/String/i.test(specType)) {
      return { btType: "BTMParameterString-149", parameterId, value: String(value ?? "") };
    }
    if (/Quantity|Length|Angle|Number/i.test(specType) || typeof value === "number" || /^[-+0-9.]/.test(String(value ?? ""))) {
      return { btType: "BTMParameterQuantity-147", parameterId, expression: String(value) };
    }
    return { btType: "BTMParameterString-149", parameterId, value: String(value ?? "") };
  }

  async _featureSpecFor(ids, requestedType) {
    let specs = null;
    // Feature specs change only with the Part Studio's library version, so one
    // read per Part Studio per 30 minutes is enough (the read takes seconds).
    this._featureSpecCache = this._featureSpecCache || new Map();
    const cacheKey = `${ids.documentId}/${ids.workspaceId}/${ids.elementId}`;
    const cached = this._featureSpecCache.get(cacheKey);
    try {
      if (cached && Date.now() - cached.at < 30 * 60_000) {
        specs = cached.specs;
      } else {
        specs = await this._readDocumented("getPartStudioFeatureSpecs", {
          document_id: ids.documentId,
          workspace_id: ids.workspaceId,
          element_id: ids.elementId,
        });
        this._featureSpecCache.set(cacheKey, { at: Date.now(), specs });
      }
    } catch (error) {
      throw codedError(
        "ONSHAPE_FEATURE_SPECS_UNAVAILABLE",
        `Current feature specs could not be read; refusing to create a feature without validation (${String(error?.code || error?.name || "error")}).`,
      );
    }
    const rows = Array.isArray(specs?.featureSpecs) ? specs.featureSpecs : Array.isArray(specs) ? specs : [];
    const wanted = String(requestedType || "").trim();
    const available = rows.map((row) => String(row?.featureType ?? row?.featureTypeName ?? "")).filter(Boolean);
    const displayName = (row) => String(row?.featureTypeName ?? row?.featureName ?? "");
    const lower = wanted.toLowerCase();
    // Order matters: people speak toolbar names, so an exact display name beats a
    // fuzzy id match ("derived" must reach importDerived/"Derived", never the
    // internal derivedMirror whose id merely starts with the same word).
    let spec = rows.find((row) => String(row?.featureType ?? "") === wanted) || null;
    if (!spec) spec = rows.find((row) => String(row?.featureType ?? "").toLowerCase() === lower) || null;
    if (!spec) spec = rows.find((row) => displayName(row).toLowerCase() === lower) || null;
    if (!spec && FEATURE_TYPE_ALIASES[lower]) {
      spec = rows.find((row) => String(row?.featureType ?? "") === FEATURE_TYPE_ALIASES[lower]) || null;
    }
    if (!spec) {
      const picked = pickByHumanName(rows, wanted, displayName);
      if (picked.match) spec = picked.match;
    }
    if (!spec) {
      const picked = pickByHumanName(rows, wanted, (row) => String(row?.featureType ?? ""));
      if (picked.match) spec = picked.match;
    }
    if (!spec) {
      throw codedError(
        "ONSHAPE_FEATURE_TYPE_UNKNOWN",
        `Feature type "${wanted}" is not offered by this Part Studio. Available: ${available.slice(0, 80).join(" | ")}`,
      );
    }
    return { featureType: String(spec.featureType ?? spec.featureTypeName ?? wanted), spec, available };
  }

  _specParameterMap(spec) {
    const rows = Array.isArray(spec?.parameters) ? spec.parameters : Array.isArray(spec?.parameterSpecs) ? spec.parameterSpecs : [];
    const map = new Map();
    for (const row of rows) {
      const id = String(row?.parameterId ?? row?.parameterName ?? "").trim();
      if (id) map.set(id.toLowerCase(), row);
    }
    return map;
  }

  _featureSelectionParameter(spec, requestedParameterId = null) {
    const rows = Array.isArray(spec?.parameters)
      ? spec.parameters
      : Array.isArray(spec?.parameterSpecs) ? spec.parameterSpecs : [];
    const queryRows = rows.filter((row) => /Query/i.test(String(row?.btType || "")));
    const requested = String(requestedParameterId || "").trim();
    if (requested) {
      const exact = queryRows.find((row) =>
        String(row?.parameterId || "").toLowerCase() === requested.toLowerCase());
      if (!exact) {
        throw codedError(
          "ONSHAPE_SELECTION_PARAMETER_NOT_FOUND",
          `Selection parameter "${requested}" is not a query parameter in the current feature spec.`,
        );
      }
      return exact;
    }
    if (!queryRows.length) {
      throw codedError("ONSHAPE_SELECTION_PARAMETER_NOT_FOUND", "The current feature has no query parameter for the Viewer selection.");
    }
    const scored = queryRows.map((row) => {
      const id = String(row?.parameterId || "");
      const name = String(row?.parameterName || "");
      const text = `${id} ${name}`;
      let score = 0;
      if (/^(entities|entity|edges|faces)$/i.test(id)) score += 100;
      if (/(entit|edge|face|fillet|chamfer|item|object)/i.test(text)) score += 40;
      if (Number(row?.maxNumberOfPicks) === -1 || Number(row?.maxNumberOfPicks) > 1) score += 10;
      if (/(scope|merge|tool|target|direction|axis|plane|reference|profile|boolean)/i.test(text)) score -= 50;
      return { row, score };
    }).sort((a, b) => b.score - a.score);
    if (scored.length > 1 && scored[0].score === scored[1].score) {
      throw codedError(
        "ONSHAPE_SELECTION_PARAMETER_AMBIGUOUS",
        `Multiple feature query parameters are equally plausible: ${scored.slice(0, 8).map((item) => String(item.row?.parameterId || "")).join(" | ")}. Pass selection_parameter_id.`,
      );
    }
    return scored[0].row;
  }

  async _buildFeatureAddFromSelection(target, args, selection) {
    const ids = this._requireStudioIds(target, "Adding a feature from the current selection");
    const requestedType = args.feature_type ?? args.featureType ?? args.type;
    if (!String(requestedType ?? "").trim()) {
      throw codedError("ONSHAPE_INTENT_ARGUMENTS", "feature_type is required.");
    }
    const selected = Array.isArray(selection?.selections) ? selection.selections : [];
    if (!selected.length) {
      throw codedError("ONSHAPE_CURRENT_SELECTION_EMPTY", "No persistent Viewer selection is available.");
    }
    const deterministicIds = selected.map((item) => String(item?.deterministic_id || "").trim()).filter(Boolean);
    if (deterministicIds.length !== selected.length || deterministicIds.some((id) => id.length > 240 || /[\r\n\0]/.test(id))) {
      throw codedError("ONSHAPE_CURRENT_SELECTION_INVALID", "Current Viewer selection does not have exact deterministic identities.");
    }

    const { featureType, spec } = await this._featureSpecFor(ids, requestedType);
    const selectionParameter = this._featureSelectionParameter(
      spec,
      args.selection_parameter_id ?? args.selectionParameterId ?? null,
    );
    const selectionParameterId = String(selectionParameter?.parameterId || "").trim();
    const requestedParameters = args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
      ? { ...args.parameters }
      : {};
    if (Object.keys(requestedParameters).some((key) => key.toLowerCase() === selectionParameterId.toLowerCase())) {
      throw codedError(
        "ONSHAPE_SELECTION_PARAMETER_CONFLICT",
        `Parameter "${selectionParameterId}" is supplied by the persistent Viewer selection and must not also be passed explicitly.`,
      );
    }

    const nextArgs = {
      ...args,
      feature_type: featureType,
      parameters: {
        ...requestedParameters,
        [selectionParameterId]: deterministicIds.map((deterministic_id) => ({ deterministic_id })),
      },
    };
    delete nextArgs.selection_parameter_id;
    delete nextArgs.selectionParameterId;
    delete nextArgs.qualification_route;
    delete nextArgs.qualificationRoute;
    delete nextArgs.route;
    delete nextArgs.value_expression;
    delete nextArgs.valueExpression;
    const built = await this._buildFeatureAdd(target, nextArgs);
    built.summary = {
      ...(built.summary || {}),
      source: "CURRENT_PERSISTENT_VIEWER_SELECTION",
      selected_deterministic_ids: deterministicIds,
      selected_entity_types: selected.map((item) =>
        item?.is_edge ? "EDGE"
          : item?.is_face ? "FACE"
            : item?.is_vertex ? "VERTEX"
              : item?.is_body ? "BODY" : "ENTITY"),
      selection_parameter_id: selectionParameterId,
      selection_count: deterministicIds.length,
      route: "VIEWER_SELECTION_TO_DOCUMENTED_API",
    };
    return built;
  }

  async _buildFeatureAdd(target, args = {}) {
    const operation = this.resolveOperation("addPartStudioFeature");
    const ids = this._requireStudioIds(target, "Adding a feature");
    const requestedType = args.feature_type ?? args.featureType ?? args.type;
    if (!String(requestedType ?? "").trim()) {
      throw codedError("ONSHAPE_INTENT_ARGUMENTS", "feature_type is required.");
    }

    const { featureType, spec } = await this._featureSpecFor(ids, requestedType);
    const specParameters = this._specParameterMap(spec);
    const { read, messages } = await this._readPartStudioFeatures(ids.documentId, ids.workspaceId, ids.elementId);
    const sameType = messages.filter((item) => String(item?.featureType ?? "") === featureType);
    const referenceId = String(
      args.reference_feature_id ?? args.referenceFeatureId
      ?? target.reference_feature_id ?? target.referenceFeatureId ?? "",
    ).trim();
    const referenceName = String(
      args.reference_feature_name ?? args.referenceFeatureName
      ?? target.reference_feature_name ?? target.referenceFeatureName ?? "",
    ).trim();

    let reference = null;
    if (referenceId || referenceName) {
      reference = this._locateFeature(messages, { featureId: referenceId, featureName: referenceName });
      if (String(reference?.featureType ?? "") !== featureType) {
        throw codedError(
          "ONSHAPE_REFERENCE_FEATURE_TYPE_MISMATCH",
          `Reference feature "${String(reference?.name ?? reference?.featureId ?? "")}" is ${String(reference?.featureType ?? "unknown")}, not ${featureType}.`,
        );
      }
    } else {
      // Owner rule (2026-10-01): build from the official catalog (feature specs);
      // a pre-existing feature is never a precondition. Parameters not given are
      // left to Onshape's own defaults; empty or partial inputs are allowed and the
      // feature may regenerate with an error, exactly as the owner asked for.
      return this._buildFeatureAddFromCatalog(operation, ids, featureType, spec, specParameters, read, messages, args);
    }

    const referenceIdObserved = String(reference?.featureId ?? "").trim();
    const referenceStatus = String(read?.featureStates?.[referenceIdObserved]?.featureStatus ?? "");
    if (!referenceIdObserved || referenceStatus !== "OK") {
      throw codedError(
        "ONSHAPE_REFERENCE_FEATURE_UNHEALTHY",
        `Reference feature must have featureStatus=OK; observed "${referenceStatus || "missing"}".`,
      );
    }

    const feature = this._featureVerificationProjection(JSON.parse(JSON.stringify(reference)));
    delete feature.featureId;
    if (args.name !== undefined || args.feature_name !== undefined) {
      const wantedName = String(args.name ?? args.feature_name ?? "").trim();
      if (!wantedName) throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Feature name may not be empty.");
      feature.name = wantedName;
    }
    if (args.suppressed !== undefined) feature.suppressed = args.suppressed === true || args.suppressed === "true";

    const requested = args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
      ? args.parameters
      : {};
    feature.parameters = Array.isArray(feature.parameters) ? feature.parameters : [];
    const referenceParameters = new Map(
      feature.parameters.map((item) => [String(item?.parameterId ?? "").toLowerCase(), item]),
    );

    for (const [key, value] of Object.entries(requested)) {
      const normalized = String(key).toLowerCase();
      const specParameter = specParameters.get(normalized) || null;
      const existing = referenceParameters.get(normalized) || null;
      if (!specParameter || !existing) {
        throw codedError(
          "ONSHAPE_REFERENCE_PARAMETER_NOT_FOUND",
          `Parameter "${key}" is not present in both the current feature spec and the healthy reference structure.`,
        );
      }
      if (Array.isArray(existing.queries)) {
        const tokens = value == null ? [] : (Array.isArray(value) ? value : [value]);
        const rebuilt = await this._queryListParameter(ids.documentId, ids.workspaceId, ids.elementId, existing.parameterId, tokens, messages);
        existing.queries = rebuilt.queries;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(existing, "expression")) {
        existing.expression = String(value);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(existing, "value")) {
        if (/BTMParameterBoolean/.test(String(existing.btType || ""))) {
          if (!(value === true || value === false || value === "true" || value === "false")) {
            throw codedError("ONSHAPE_INTENT_ARGUMENTS", `Boolean parameter "${existing.parameterId}" requires true/false.`);
          }
          existing.value = value === true || value === "true";
        } else if (/BTMParameterEnum/.test(String(existing.btType || ""))) {
          const options = Array.isArray(specParameter?.options) ? specParameter.options : [];
          const optionNames = Array.isArray(specParameter?.optionNames) ? specParameter.optionNames : [];
          const wanted = String(value ?? "").trim();
          if (options.length) {
            let matchedValue = null;
            for (let i = 0; i < options.length; i += 1) {
              const option = typeof options[i] === "string" ? options[i] : String(options[i]?.option ?? "");
              const optionName = typeof options[i] === "string"
                ? String(optionNames[i] ?? "")
                : String(options[i]?.optionName ?? optionNames[i] ?? "");
              if (option.toLowerCase() === wanted.toLowerCase() || optionName.toLowerCase() === wanted.toLowerCase()) {
                matchedValue = option;
                break;
              }
            }
            if (!matchedValue) {
              throw codedError(
                "ONSHAPE_INTENT_ARGUMENTS",
                `Enum parameter "${existing.parameterId}" does not admit "${wanted}".`,
              );
            }
            existing.value = matchedValue;
          } else {
            existing.value = wanted;
          }
        } else {
          existing.value = value;
        }
        continue;
      }
      throw codedError(
        "ONSHAPE_REFERENCE_PARAMETER_UNQUALIFIED",
        `Parameter "${existing.parameterId}" has no qualified scalar substitution rule.`,
      );
    }

    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: ids.documentId,
        workspace_id: ids.workspaceId,
        element_id: ids.elementId,
      }, {}),
      body: this._featureWriteEnvelope(read, feature),
      summary: {
        feature_type: featureType,
        feature_name: String(feature.name ?? ""),
        reference_feature_id: referenceIdObserved,
        reference_feature_name: String(reference?.name ?? ""),
        parameters: Object.keys(requested),
      },
    };
  }

  async _buildFeatureAddFromCatalog(operation, ids, featureType, spec, specParameters, read, messages, args) {
    const feature = {
      btType: "BTMFeature-134",
      featureType,
      namespace: String(spec?.namespace ?? ""),
      name: String(args.name ?? args.feature_name ?? "").trim() || String(spec?.featureTypeName ?? featureType),
      suppressed: args.suppressed === true || args.suppressed === "true",
      parameters: [],
    };
    const requested = args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
      ? args.parameters
      : {};
    for (const [key, value] of Object.entries(requested)) {
      const specParameter = specParameters.get(String(key).toLowerCase()) || null;
      if (!specParameter) {
        throw codedError(
          "ONSHAPE_FEATURE_PARAMETER_UNKNOWN",
          `Parameter "${key}" is not in the ${featureType} feature spec. Available: ${[...specParameters.keys()].slice(0, 60).join(" | ")}`,
        );
      }
      const parameterId = String(specParameter.parameterId ?? key);
      const tokens = /Query/i.test(String(specParameter?.btType ?? "")) && value == null ? [] : value;
      feature.parameters.push(await this._featureParameter(ids, parameterId, tokens, specParameter, messages));
    }
    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: ids.documentId,
        workspace_id: ids.workspaceId,
        element_id: ids.elementId,
      }, {}),
      body: this._featureWriteEnvelope(read, feature),
      summary: {
        feature_type: featureType,
        feature_name: feature.name,
        source: "OFFICIAL_FEATURE_SPEC_CATALOG",
        reference_feature_id: null,
        parameters: Object.keys(requested),
      },
    };
  }

  async _buildFeaturePatch(target, args = {}) {
    const operation = this.resolveOperation("updatePartStudioFeature");
    const ids = this._requireStudioIds(target, "Editing a feature");
    const { read, messages } = await this._readPartStudioFeatures(ids.documentId, ids.workspaceId, ids.elementId);
    if (!messages.length) throw codedError("ONSHAPE_TARGET_NOT_FOUND", "This Part Studio has no features.");
    const original = this._locateFeature(messages, {
      featureId: target.feature_id ?? target.featureId,
      featureName: target.feature_name ?? target.featureName,
      position: args.position ?? target.position,
    });
    const feature = JSON.parse(JSON.stringify(original));
    const changed = [];

    const suppressed = args.suppressed ?? args.suppress;
    if (suppressed !== undefined) {
      feature.suppressed = suppressed === true || suppressed === "true";
      changed.push(feature.suppressed ? "suppressed" : "unsuppressed");
    }
    const newName = args.new_name ?? args.newName ?? args.rename_to ?? args.name;
    if (newName !== undefined && String(newName).trim()) {
      feature.name = String(newName).trim();
      changed.push("name");
    }
    const requested = args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
      ? args.parameters
      : {};
    feature.parameters = Array.isArray(feature.parameters) ? feature.parameters : [];
    const specParameters = new Map(feature.parameters.map((item) => [String(item?.parameterId ?? "").toLowerCase(), item]));
    for (const [key, value] of Object.entries(requested)) {
      const existing = specParameters.get(String(key).toLowerCase());
      if (!existing) {
        throw codedError(
          "ONSHAPE_PARAMETER_NOT_FOUND",
          `Parameter "${key}" is not on "${feature.name}". Parameters: ${feature.parameters.map((item) => String(item?.parameterId ?? "")).join(" | ")}`,
        );
      }
      if (Array.isArray(existing.queries)) {
        const rebuilt = await this._queryListParameter(ids.documentId, ids.workspaceId, ids.elementId, String(existing.parameterId), value, messages);
        existing.queries = rebuilt.queries;
      } else if ("expression" in existing) {
        existing.expression = String(value);
      } else {
        existing.value = value;
      }
      changed.push(`parameter:${existing.parameterId}`);
    }
    if (!changed.length) {
      throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Pass suppressed, new_name, or parameters to patch a feature.");
    }
    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: ids.documentId,
        workspace_id: ids.workspaceId,
        element_id: ids.elementId,
        feature_id: String(feature.featureId ?? "").trim(),
      }, {}),
      body: this._featureWriteEnvelope(read, feature),
      summary: { feature_name: String(feature.name ?? ""), feature_type: String(feature.featureType ?? ""), changed },
    };
  }

  async _buildRollbackSet(target, args = {}) {
    let operation = null;
    for (const candidate of ["updateRollback", "updatePartStudioRollback", "setRollback", "updateFeatureRollback"]) {
      try {
        operation = this.resolveOperation(candidate);
        break;
      } catch {
        operation = null;
      }
    }
    if (!operation) throw codedError("ONSHAPE_OPERATION_UNAVAILABLE", "This Onshape API build exposes no rollback endpoint.");
    const ids = this._requireStudioIds(target, "Moving the rollback bar");
    const { messages } = await this._readPartStudioFeatures(ids.documentId, ids.workspaceId, ids.elementId);
    const where = String(args.position ?? "").trim().toLowerCase();
    let index;
    if (args.rollback_index !== undefined || args.index !== undefined) {
      index = Number(args.rollback_index ?? args.index);
    } else if (where === "end" || where === "bottom") {
      index = -1;
    } else if (where === "start" || where === "top" || where === "beginning") {
      index = 0;
    } else {
      const anchorName = args.before_feature ?? args.feature_name ?? target.feature_name;
      const afterName = args.after_feature;
      const anchor = this._locateFeature(messages, { featureName: String(anchorName ?? afterName ?? "") });
      const at = messages.findIndex((item) => item === anchor);
      index = afterName ? at + 1 : at;
    }
    if (!Number.isInteger(index) || index < -1 || index > messages.length) {
      throw codedError("ONSHAPE_INTENT_ARGUMENTS", `rollback index ${index} is out of range (features: ${messages.length}).`);
    }
    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: ids.documentId,
        workspace_id: ids.workspaceId,
        element_id: ids.elementId,
      }, {}),
      body: { rollbackIndex: index },
      summary: { rollback_index: index, feature_count: messages.length },
    };
  }

  async _buildMetadataPropertySet(target, args = {}) {
    const documentId = String(target.document_id ?? target.documentId ?? "").trim();
    const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
    const elementId = String(target.element_id ?? target.elementId ?? "").trim();
    if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      throw codedError("ONSHAPE_TARGET_ID_INVALID", "Setting metadata requires 24-hex document/workspace/element ids or a document URL.");
    }
    const partId = String(target.part_id ?? target.partId ?? "").trim();
    const onPart = Boolean(partId);
    const readOperationId = onPart ? "getWMVEPMetadata" : "getWMVEMetadata";
    const writeOperationId = onPart ? "updateWVEPMetadata" : "updateWVEMetadata";
    const operation = this.resolveOperation(writeOperationId);
    const readTarget = {
      document_id: documentId,
      workspace_id: workspaceId,
      element_id: elementId,
      wvm: "w",
    };
    if (onPart) {
      readTarget.iden = "p";
      readTarget.part_id = partId;
    }
    const current = await this._readDocumented(readOperationId, readTarget);
    const properties = Array.isArray(current?.properties) ? current.properties : [];
    const selector = String(args.property_id ?? args.propertyId ?? args.property_name ?? args.propertyName ?? "").trim()
      || (args.color !== undefined || args.color_name !== undefined ? "Appearance" : "");
    if (!selector) {
      throw codedError(
        "ONSHAPE_INTENT_ARGUMENTS",
        `property_name is required. Properties here: ${properties.map((item) => String(item?.name ?? item?.propertyId ?? "")).join(" | ")}`,
      );
    }
    let property = properties.find((item) => String(item?.propertyId ?? "").trim() === selector) || null;
    if (!property) {
      const picked = pickByHumanName(properties, selector, (item) => String(item?.name ?? ""));
      if (!picked.match) {
        throw codedError(
          picked.candidates.length ? "ONSHAPE_PROPERTY_AMBIGUOUS" : "ONSHAPE_PROPERTY_NOT_FOUND",
          `Property "${selector}" was not found. Properties here: ${properties.map((item) => String(item?.name ?? "")).join(" | ")}`,
        );
      }
      property = picked.match;
    }

    let value;
    const colorInput = args.color ?? args.color_name ?? args.colour ?? undefined;
    if (colorInput !== undefined) {
      const rgb = normalizeColor(colorInput);
      if (!rgb) throw codedError("ONSHAPE_INTENT_ARGUMENTS", `Color "${colorInput}" was not understood. Pass a known colour name or {red,green,blue} 0-255.`);
      const base = property.value && typeof property.value === "object" && !Array.isArray(property.value)
        ? JSON.parse(JSON.stringify(property.value))
        : {};
      base.color = { red: rgb.red, green: rgb.green, blue: rgb.blue };
      if (base.opacity === undefined) base.opacity = 255;
      value = base;
    } else if (args.value !== undefined) {
      value = args.value;
    } else {
      throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Pass value, or color for an appearance property.");
    }

    const item = { propertyId: String(property.propertyId ?? ""), value };
    // Onshape validates metadata writes against the identity of the object that
    // was read, so echo back whatever identity fields the read returned.
    const identity = {};
    const href = typeof current?.href === "string" ? current.href.trim() : "";
    if (href) identity.href = href;
    if (typeof current?.jsonType === "string" && current.jsonType.trim()) identity.jsonType = current.jsonType.trim();
    if (onPart) {
      identity.partId = String(current?.partId ?? partId);
      const partIdentity = String(current?.partIdentity ?? "").trim();
      if (partIdentity) identity.partIdentity = partIdentity;
      const configuration = String(current?.configuration ?? "").trim();
      if (configuration) identity.configuration = configuration;
    }
    if (!href) {
      throw codedError(
        "ONSHAPE_METADATA_HREF_MISSING",
        "Onshape did not return an href for this metadata object, so the write cannot be addressed.",
      );
    }
    const body = { items: [{ ...identity, properties: [item] }] };

    return {
      operationId: operation.operationId,
      pathParams: this._semanticPathParams(operation, {
        document_id: documentId,
        workspace_id: workspaceId,
        element_id: elementId,
        wvm: "w",
        ...(onPart ? { iden: "p", part_id: partId } : {}),
      }, {}),
      body,
      summary: {
        scope: onPart ? "part" : "element",
        property_id: String(property.propertyId ?? ""),
        property_name: String(property.name ?? ""),
      },
    };
  }

  async _autoResolveTarget(targetInput, { resolveParts = true } = {}) {
    const target = { ...plainObject(targetInput, "target") };
    const fromUrl = target.document_url ? parseDocumentUrl(target.document_url) : null;
    if (fromUrl) {
      if (!target.document_id && !target.documentId) target.document_id = fromUrl.documentId;
      if (!target.workspace_id && !target.workspaceId && fromUrl.workspaceId) target.workspace_id = fromUrl.workspaceId;
      if (!target.element_id && !target.elementId && fromUrl.elementId) target.element_id = fromUrl.elementId;
    }
    delete target.document_url;
    const needsElement = !(target.element_id || target.elementId) && Boolean(target.element_name || target.elementName);
    const needsFeature = !(target.feature_id || target.featureId) && Boolean(target.feature_name || target.featureName);
    const needsPart = resolveParts
      && !(target.part_id || target.partId)
      && Boolean(target.part_name || target.partName);
    if (!needsElement && !needsFeature && !needsPart) return target;
    const resolved = await this.resolveIdentities({
      document_id: target.document_id ?? target.documentId,
      workspace_id: target.workspace_id ?? target.workspaceId,
      element_id: target.element_id ?? target.elementId,
      element_name: needsElement ? (target.element_name ?? target.elementName) : undefined,
      part_name: needsPart ? (target.part_name ?? target.partName) : undefined,
      feature_name: needsFeature ? (target.feature_name ?? target.featureName) : undefined,
    });
    if (needsElement && resolved.element_id) target.element_id = resolved.element_id;
    if (needsFeature && resolved.feature_id) target.feature_id = resolved.feature_id;
    if (needsPart && resolved.part_id) target.part_id = resolved.part_id;
    return target;
  }

  semanticCapabilitySurface() {
    const capabilities = this._semanticRegistry.publicCapabilities.map((item) => ({ ...item }));
    const prompt = [
      "Use this semantic intent tool for ordinary human Onshape commands. Do not guess operationIds and do not perform source/OpenAPI discovery.",
      "Any change inside a document (add, edit, suppress, delete feature, delete part, delete element) is an ordinary reversible write: never ask the owner to confirm it and never set owner_confirmed_high_impact for it. Only sharing, permissions, ownership, API keys, webhooks and billing need confirmation, and the tool itself says so with ONSHAPE_HIGH_IMPACT_CONFIRMATION_REQUIRED.",
      ...capabilities.map((item) => (
        `${item.capabilityId}: intents=[${item.intents.join(" | ")}]; target=${item.target}; args=${item.arguments}; backend=${item.backend}`
      )),
      "Exact documented operationIds and their precompiled summaries are also accepted as intents for advanced documented operations.",
    ].join("\n");
    return {
      count: this._semanticRegistry.count,
      public_count: capabilities.length,
      resolution: this._semanticRegistry.resolution,
      capabilities,
      prompt,
    };
  }

  _semanticPathParams(operation, targetInput, explicitInput) {
    const target = plainObject(targetInput, "target");
    const explicit = plainObject(explicitInput, "pathParams");
    const mapped = {};
    const valueFor = (name) => {
      const key = String(name || "").toLowerCase();
      if (key === "did" || key === "documentid") return target.document_id ?? target.documentId;
      if (key === "wid" || key === "workspaceid") return target.workspace_id ?? target.workspaceId;
      if (key === "wid") return target.workspace_id ?? target.workspaceId;
      if (key === "iden") return target.iden ?? ((target.part_id ?? target.partId ?? target.part_name ?? target.partName) ? "p" : undefined);
      if (key === "wvm") return target.wvm ?? "w";
      if (key === "wvmid") return target.workspace_id ?? target.workspaceId ?? target.wvmid;
      if (key === "eid" || key === "elementid") return target.element_id ?? target.elementId;
      if (key === "pid" || key === "partid") return target.part_id ?? target.partId ?? target.entity_id ?? target.entityId;
      if (key === "fid" || key === "featureid") return target.feature_id ?? target.featureId ?? target.entity_id ?? target.entityId;
      if (key === "vid" || key === "versionid") return target.version_id ?? target.versionId;
      if (key === "mid" || key === "microversionid") return target.microversion_id ?? target.microversionId;
      return undefined;
    };

    for (const name of operation.requiredPathParameters) {
      const value = valueFor(name);
      if (value !== undefined && value !== null && String(value).trim() !== "") mapped[name] = value;
    }
    for (const [name, value] of Object.entries(explicit)) {
      if (
        Object.prototype.hasOwnProperty.call(mapped, name)
        && String(mapped[name]) !== String(value)
      ) {
        throw codedError("ONSHAPE_TARGET_CONFLICT", `Target and path_params disagree for ${name}.`);
      }
      mapped[name] = value;
    }
    return mapped;
  }

  async _resolvePartTarget(targetInput) {
    const target = plainObject(targetInput, "target");
    const operation = this.resolveOperation("getPartsWMVE");
    const pathParams = this._semanticPathParams(operation, target, {});
    const read = await this.executeDocumentedOperation({
      operationId: operation.operationId,
      pathParams,
    });
    if (read.state !== "SUCCEEDED") {
      throw codedError("ONSHAPE_TARGET_RESOLUTION_FAILED", "Part target resolution read did not succeed.");
    }

    const body = read?.evidence?.body;
    const parts = Array.isArray(body)
      ? body
      : Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body?.parts)
          ? body.parts
          : [];
    const requestedId = String(
      target.part_id ?? target.partId ?? target.entity_id ?? target.entityId ?? "",
    ).trim();
    const requestedName = String(
      target.part_name ?? target.partName ?? target.entity_name ?? target.entityName ?? "",
    ).trim();
    if (!requestedId && !requestedName) {
      throw codedError("ONSHAPE_TARGET_REQUIRED", "Part visibility requires a part id or part name.");
    }

    const byId = parts.filter((part) => {
      const id = String(part?.partId ?? part?.id ?? "").trim();
      return !requestedId || id === requestedId;
    });
    let matches = byId;
    if (requestedName) {
      const picked = pickByHumanName(byId, requestedName, (part) => String(part?.name ?? ""));
      matches = picked.match ? [picked.match] : picked.candidates;
    }
    if (matches.length !== 1) {
      throw codedError(
        matches.length === 0 ? "ONSHAPE_TARGET_NOT_FOUND" : "ONSHAPE_TARGET_AMBIGUOUS",
        `Part target resolved to ${matches.length} candidates.`,
      );
    }
    const partId = String(matches[0]?.partId ?? matches[0]?.id ?? "").trim();
    const partName = String(matches[0]?.name ?? "").trim();
    if (!partId || !partName) {
      throw codedError("ONSHAPE_TARGET_INVALID", "Resolved part target lacks stable id/name identity.");
    }
    return {
      partId,
      partName,
      readTiming: read.timing || null,
      readOperationId: operation.operationId,
    };
  }

  _expandPath(template, pathParamsInput) {
    const params = plainObject(pathParamsInput, "pathParams");
    const names = [...String(template).matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    const unique = [...new Set(names)];
    const extras = Object.keys(params).filter((key) => !unique.includes(key));
    if (extras.length) throw codedError("OPENAPI_PATH_PARAMS", `Unexpected path parameters: ${extras.join(",")}`);
    let pathValue = String(template);
    for (const name of unique) {
      const raw = params[name];
      if (raw === undefined || raw === null || String(raw).trim() === "") {
        throw codedError("OPENAPI_PATH_PARAMS", `Missing path parameter: ${name}`);
      }
      pathValue = pathValue.replaceAll(`{${name}}`, encodeURIComponent(String(raw)));
    }
    return pathValue;
  }

  _versionedApiPath(requestPath, apiBasePathInput = null) {
    const raw = String(requestPath || "").trim();
    if (!raw.startsWith("/") || raw.startsWith("/api/")) {
      throw codedError(
        "OPENAPI_PATH_VERSION",
        "Execution-agent API paths must be unprefixed OpenAPI paths and are versioned only from the pinned OpenAPI server contract.",
      );
    }
    const apiBasePath = apiBasePathInput == null
      ? this._operationRegistry.apiBasePath
      : String(apiBasePathInput);
    if (!/^\/api\/v[1-9][0-9]*$/.test(apiBasePath)) {
      throw codedError("OPENAPI_SERVER_INVALID", "Pinned OpenAPI API base path is invalid.");
    }
    return apiBasePath + raw;
  }

  async _request(method, requestPath, query = null, body = undefined, options = {}, apiBasePath = null) {
    const versionedPath = this._versionedApiPath(requestPath, apiBasePath);
    return this.core.request(method, versionedPath, query, body, options);
  }

  _apiVersionFromBase(apiBasePathInput) {
    const apiBasePath = String(apiBasePathInput || "");
    const match = apiBasePath.match(/^\/api\/(v[1-9][0-9]*)$/);
    if (!match) {
      throw codedError("OPENAPI_SERVER_INVALID", "Pinned OpenAPI API base path is invalid.");
    }
    return match[1];
  }

  _observedApiVersion(response) {
    const headers = response?.responseHeaders;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
    for (const [name, value] of Object.entries(headers)) {
      if (String(name).toLowerCase() === "x-api-version") {
        const normalized = String(value || "").trim();
        return normalized || null;
      }
    }
    return null;
  }

  _assertVersionedReadResponse(response, apiBasePath) {
    const expected = this._apiVersionFromBase(apiBasePath);
    const observed = this._observedApiVersion(response);
    if (observed !== expected) {
      throw codedError(
        "OPENAPI_RESPONSE_VERSION_MISMATCH",
        `Onshape response API version ${observed || "missing"} does not match pinned ${expected}.`,
      );
    }
    return observed;
  }

  _featureVerificationProjection(value) {
    if (Array.isArray(value)) {
      return value.map((item) => this._featureVerificationProjection(item));
    }
    if (!value || typeof value !== "object") return value;
    const deterministicIds = Array.isArray(value.deterministicIds)
      ? value.deterministicIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const geometryIds = Array.isArray(value.geometryIds)
      ? value.geometryIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const hasGroundedIdentity = deterministicIds.length > 0 || geometryIds.length > 0;
    const hasDeclarativeQuery = typeof value.queryString === "string" && value.queryString.trim().length > 0;
    const projected = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "nodeId") continue;
      if ((key === "suppressionState" || key === "queryStatement") && item == null) continue;
      // Onshape enriches deterministic-id queries with a generated queryString on
      // readback. Identity is stronger than that provider-generated serialization,
      // so compare the exact ids and ignore the generated query text when present.
      if (key === "queryString" && hasGroundedIdentity) continue;
      if ((key === "deterministicIds" || key === "geometryIds") && hasDeclarativeQuery && !hasGroundedIdentity) continue;
      projected[key] = this._featureVerificationProjection(item);
    }
    return projected;
  }

  _projectionMatches(expected, actual) {
    if (Array.isArray(expected)) {
      return Array.isArray(actual)
        && expected.length === actual.length
        && expected.every((item, index) => this._projectionMatches(item, actual[index]));
    }
    if (expected && typeof expected === "object") {
      if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
      return Object.keys(expected).every(
        (key) => Object.prototype.hasOwnProperty.call(actual, key)
          && this._projectionMatches(expected[key], actual[key]),
      );
    }
    return Object.is(expected, actual);
  }

  _featureId(value) {
    const candidates = [
      value?.featureId,
      value?.message?.featureId,
      value?.feature?.featureId,
      value?.feature?.message?.featureId,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return null;
  }

  async _readPartStudioFeature(documentId, workspaceId, elementId, featureId, apiBasePath = null) {
    const response = await this._request(
      "GET",
      `/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/features`,
      { featureId: [featureId] },
      undefined,
      {},
      apiBasePath,
    );
    this._assertVersionedReadResponse(response, apiBasePath);
    if (!response?.ok) {
      throw codedError("ONSHAPE_READBACK_FAILED", "Part Studio feature readback failed.");
    }
    const features = Array.isArray(response?.body?.features) ? response.body.features : [];
    const matches = features.filter((feature) => this._featureId(feature) === featureId);
    if (matches.length > 1) {
      throw codedError("ONSHAPE_READBACK_AMBIGUOUS", "Part Studio feature readback returned duplicate feature ids.");
    }
    const feature = matches[0] ?? null;
    const state = featureId && response?.body?.featureStates && typeof response.body.featureStates === "object"
      ? response.body.featureStates[featureId] ?? null
      : null;
    return {
      httpStatus: Number(response?.http ?? 0) || null,
      feature,
      featureState: state,
    };
  }

  async executeIntent(input = {}) {
    const totalStart = process.hrtime.bigint();
    const timings = {
      intent_resolution_ms: 0,
      registry_ms: 0,
      validation_ms: 0,
      journal_ms: 0,
      target_resolution_ms: 0,
      provider_ms: 0,
      verification_ms: null,
      total_ms: 0,
    };

    const resolutionStart = process.hrtime.bigint();
    const request = plainObject(input, "intent request");
    const intent = String(request.intent || "").trim();
    const resolved = this.resolveIntent(intent);
    const contract = resolved.contract;
    timings.intent_resolution_ms = elapsedMs(resolutionStart);

    if (contract.backend.kind === SEMANTIC_BACKEND_DOCUMENTED) {
      const operation = this.resolveOperation(contract.backend.operationId);
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target);
      const pathParams = this._semanticPathParams(operation, target, request.pathParams);
      const query = plainObject(request.query, "query");
      const headers = plainObject(request.headers, "headers");
      const args = {
        operationId: operation.operationId,
        pathParams,
        query,
        headers,
      };
      if (Object.prototype.hasOwnProperty.call(request, "body")) args.body = request.body;
      if (request.multipart !== undefined) args.multipart = request.multipart;
      if (request.ownerConfirmedHighImpact !== undefined) {
        args.ownerConfirmedHighImpact = request.ownerConfirmedHighImpact;
      }
      if (request.requestId !== undefined) args.requestId = request.requestId;
      timings.validation_ms = elapsedMs(validationStart);

      const delegated = await this.executeDocumentedOperation(args);
      const dt = delegated?.timing || {};
      timings.registry_ms = Number(dt.registry_ms ?? 0) || 0;
      timings.validation_ms += Number(dt.validation_ms ?? 0) || 0;
      timings.journal_ms = Number(dt.journal_ms ?? 0) || 0;
      timings.provider_ms = Number(dt.provider_ms ?? 0) || 0;
      timings.verification_ms = dt.verification_ms == null ? null : Number(dt.verification_ms) || 0;
      if (dt.queue_wait_ms != null) timings.queue_wait_ms = Number(dt.queue_wait_ms) || 0;
      if (dt.pacing_wait_ms != null) timings.pacing_wait_ms = Number(dt.pacing_wait_ms) || 0;
      if (dt.provider_execution_ms != null) timings.provider_execution_ms = Number(dt.provider_execution_ms) || 0;
      timings.total_ms = elapsedMs(totalStart);
      return {
        ...delegated,
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        resolvedOperationId: operation.operationId,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_DERIVED) {
      const derivedTargetStart = process.hrtime.bigint();
      const derivedTarget = await this._autoResolveTarget(
        request.target,
        { resolveParts: contract.backend.executor !== "FEATURE_FROM_SELECTION" },
      );
      timings.target_resolution_ms = elapsedMs(derivedTargetStart);
      const derivedArgs = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      let built;
      let currentSelection = null;
      if (contract.backend.executor === "FEATURE_FROM_SELECTION") {
        const ids = this._requireStudioIds(derivedTarget, "Feature from current selection");
        const selectionStart = process.hrtime.bigint();
        currentSelection = await this.core.currentSelection({
          documentId: ids.documentId,
          workspaceId: ids.workspaceId,
          elementId: ids.elementId,
        });
        timings.selection_readback_ms = elapsedMs(selectionStart);

        const requestedRoute = String(
          derivedArgs.qualification_route ?? derivedArgs.qualificationRoute ?? derivedArgs.route ?? "auto",
        ).trim().toLowerCase();
        if (!["auto", "api", "ui"].includes(requestedRoute)) {
          throw codedError("ONSHAPE_INTENT_ARGUMENTS", "feature.from_selection route must be auto, api, or ui.");
        }
        if (requestedRoute === "ui") {
          const featureType = String(
            derivedArgs.feature_type ?? derivedArgs.featureType ?? derivedArgs.type ?? "",
          ).trim();
          if (!["fillet", "chamfer"].includes(featureType.toLowerCase())) {
            throw codedError("ONSHAPE_UI_FEATURE_UNSUPPORTED", "The bounded UI comparison route currently admits only fillet and chamfer.");
          }
          const params = derivedArgs.parameters && typeof derivedArgs.parameters === "object" && !Array.isArray(derivedArgs.parameters)
            ? derivedArgs.parameters : {};
          let valueExpression = String(
            derivedArgs.value_expression ?? derivedArgs.valueExpression ?? "",
          ).trim();
          if (!valueExpression) {
            const quantity = Object.entries(params).find(([, value]) =>
              typeof value === "string" || typeof value === "number");
            if (quantity) valueExpression = String(quantity[1]).trim();
          }
          if (!valueExpression) {
            throw codedError("ONSHAPE_UI_FEATURE_VALUE_REQUIRED", "The bounded UI comparison route requires value_expression or one scalar quantity parameter.");
          }

          const beforeReadStart = process.hrtime.bigint();
          const before = await this._readPartStudioFeatures(ids.documentId, ids.workspaceId, ids.elementId);
          timings.ui_before_read_ms = elapsedMs(beforeReadStart);
          const beforeIds = new Set(before.messages.map((item) => String(item?.featureId || "").trim()).filter(Boolean));

          const uiStart = process.hrtime.bigint();
          let ui;
          try {
            ui = await this.core.applyFeatureFromSelectionUi({
              documentId: ids.documentId,
              workspaceId: ids.workspaceId,
              elementId: ids.elementId,
              featureType,
              valueExpression,
            });
          } catch (error) {
            timings.provider_ms = elapsedMs(uiStart);
            timings.total_ms = elapsedMs(totalStart);
            return {
              intent,
              capabilityId: contract.capabilityId,
              semanticBackend: contract.backend.kind,
              state: "REJECTED",
              detail: `Bounded UI feature route did not verify: ${String(error?.code || "UI_FEATURE_FAILED")}`,
              evidence: {
                effectSent: ![
                  "UI_FEATURE_SELECTION_EMPTY",
                  "UI_FEATURE_TYPE_UNSUPPORTED",
                  "UI_FEATURE_VALUE_INVALID",
                  "UI_FEATURE_COMMAND_SEARCH_UNAVAILABLE",
                  "UI_FEATURE_COMMAND_SEARCH_INPUT_UNAVAILABLE",
                  "UI_FEATURE_DIALOG_UNAVAILABLE",
                  "UI_FEATURE_PARAMETER_INPUT_UNAVAILABLE",
                  "UI_FEATURE_ACCEPT_UNAVAILABLE",
                ].includes(String(error?.code || "")) ? null : false,
                effectScope: "PERSISTENT_WORK_PAGE_FEATURE_UI",
                operationRiskClass: contract.riskClass,
                verificationStrategy: contract.verificationStrategy,
                target: ids,
                route: "ui",
                featureType,
                valueExpression,
                errorCode: String(error?.code || ""),
                fieldDiagnostics: Array.isArray(error?.field_diagnostics) ? error.field_diagnostics : [],
              },
              timing: timings,
            };
          }
          timings.provider_ms = elapsedMs(uiStart);

          const afterReadStart = process.hrtime.bigint();
          const after = await this._readPartStudioFeatures(ids.documentId, ids.workspaceId, ids.elementId);
          timings.ui_after_read_ms = elapsedMs(afterReadStart);
          const added = after.messages.filter((item) => {
            const id = String(item?.featureId || "").trim();
            return id && !beforeIds.has(id);
          });
          const created = added.length === 1 ? added[0] : null;
          const createdId = String(created?.featureId || "").trim() || null;
          const createdType = String(created?.featureType || "").trim();
          const selectedIds = Array.isArray(currentSelection?.selections)
            ? currentSelection.selections.map((item) => String(item?.deterministic_id || "").trim()).filter(Boolean)
            : [];
          const collectDeterministicIds = (value, out = []) => {
            if (Array.isArray(value)) {
              for (const item of value) collectDeterministicIds(item, out);
              return out;
            }
            if (!value || typeof value !== "object") return out;
            if (Array.isArray(value.deterministicIds)) {
              for (const id of value.deterministicIds) {
                const text = String(id || "").trim();
                if (text) out.push(text);
              }
            }
            for (const child of Object.values(value)) collectDeterministicIds(child, out);
            return out;
          };
          const boundIds = created ? [...new Set(collectDeterministicIds(created))] : [];
          const identityPreserved = selectedIds.length > 0
            && selectedIds.every((id) => boundIds.includes(id));
          const typeMatches = !!created
            && createdType.toLowerCase() === featureType.toLowerCase();
          const featureState = createdId && after?.read?.featureStates && typeof after.read.featureStates === "object"
            ? after.read.featureStates[createdId] ?? null : null;

          let selectionAfter = null;
          const afterSelectionStart = process.hrtime.bigint();
          try {
            selectionAfter = await this.core.currentSelection({
              documentId: ids.documentId,
              workspaceId: ids.workspaceId,
              elementId: ids.elementId,
            });
          } catch {}
          timings.ui_selection_after_ms = elapsedMs(afterSelectionStart);
          timings.total_ms = elapsedMs(totalStart);

          const verified = added.length === 1 && typeMatches && identityPreserved;
          return {
            intent,
            capabilityId: contract.capabilityId,
            semanticBackend: contract.backend.kind,
            state: verified ? "SUCCEEDED" : "REJECTED",
            detail: verified
              ? "Bounded native UI feature route committed one feature and documented readback preserved the selected entity identities."
              : "Bounded native UI feature route did not pass documented identity/type readback.",
            evidence: {
              effectSent: true,
              effectScope: "PERSISTENT_WORK_PAGE_FEATURE_UI",
              operationRiskClass: contract.riskClass,
              verificationStrategy: contract.verificationStrategy,
              target: ids,
              route: "ui",
              featureType,
              valueExpression,
              selectedDeterministicIds: selectedIds,
              addedFeatureCount: added.length,
              createdFeatureId: createdId,
              createdFeatureType: createdType || null,
              boundDeterministicIds: boundIds,
              identityPreserved,
              typeMatches,
              featureState,
              selectionAfter,
              ui,
            },
            timing: timings,
          };
        }
      }
      const buildStart = process.hrtime.bigint();
      if (contract.backend.executor === "DELETE_PART_BODIES") {
        built = await this._buildDeletePartBodies(derivedTarget);
      } else if (contract.backend.executor === "FEATURE_DELETE") {
        built = await this._buildFeatureDelete(derivedTarget, derivedArgs);
      } else if (contract.backend.executor === "METADATA_PROPERTY_SET") {
        built = await this._buildMetadataPropertySet(derivedTarget, derivedArgs);
      } else if (contract.backend.executor === "FEATURE_ADD") {
        built = await this._buildFeatureAdd(derivedTarget, derivedArgs);
      } else if (contract.backend.executor === "FEATURE_FROM_SELECTION") {
        built = await this._buildFeatureAddFromSelection(derivedTarget, derivedArgs, currentSelection);
      } else if (contract.backend.executor === "FEATURE_PATCH") {
        built = await this._buildFeaturePatch(derivedTarget, derivedArgs);
      } else if (contract.backend.executor === "ROLLBACK_SET") {
        built = await this._buildRollbackSet(derivedTarget, derivedArgs);
      } else {
        built = await this._buildFeatureParameterUpdate(derivedTarget, derivedArgs);
      }
      const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
      const delegatedArgs = {
        operationId: built.operationId,
        pathParams: built.pathParams,
      };
      if (built.body !== undefined) delegatedArgs.body = built.body;
      if (request.requestId !== undefined) delegatedArgs.requestId = request.requestId;
      if (request.ownerConfirmedHighImpact !== undefined) {
        delegatedArgs.ownerConfirmedHighImpact = request.ownerConfirmedHighImpact;
      }
      const delegated = await this.executeDocumentedOperation(delegatedArgs);
      const dt = delegated?.timing || {};
      timings.registry_ms = Number(dt.registry_ms ?? 0) || 0;
      timings.validation_ms = Number(dt.validation_ms ?? 0) || 0;
      timings.journal_ms = Number(dt.journal_ms ?? 0) || 0;
      timings.provider_ms = Number(dt.provider_ms ?? 0) || 0;
      timings.verification_ms = dt.verification_ms == null ? null : Number(dt.verification_ms) || 0;
      if (dt.queue_wait_ms != null) timings.queue_wait_ms = Number(dt.queue_wait_ms) || 0;
      if (dt.pacing_wait_ms != null) timings.pacing_wait_ms = Number(dt.pacing_wait_ms) || 0;
      if (dt.provider_execution_ms != null) timings.provider_execution_ms = Number(dt.provider_execution_ms) || 0;
      timings.build_ms = buildMs;
      timings.total_ms = elapsedMs(totalStart);
      return {
        ...delegated,
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        resolvedOperationId: built.operationId,
        derived: built.summary,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEWER_HOVER_PROBE") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const args = {
        ...resolved.defaults,
        ...plainObject(request.arguments, "arguments"),
      };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "Viewer hover requires 24-hex document/workspace/element ids.");
      }
      let xFraction = args.x_fraction ?? args.xFraction;
      let yFraction = args.y_fraction ?? args.yFraction;
      xFraction = xFraction == null ? null : Number(xFraction);
      yFraction = yFraction == null ? null : Number(yFraction);
      const rawWorldPoint = args.world_point ?? args.worldPoint ?? null;
      const worldPoint = rawWorldPoint && typeof rawWorldPoint === "object" && !Array.isArray(rawWorldPoint)
        ? { x: Number(rawWorldPoint.x), y: Number(rawWorldPoint.y), z: Number(rawWorldPoint.z) }
        : null;
      const hasScreenPoint = Number.isFinite(xFraction) && Number.isFinite(yFraction)
        && xFraction >= 0 && xFraction <= 1 && yFraction >= 0 && yFraction <= 1;
      const hasWorldPoint = !!worldPoint && [worldPoint.x, worldPoint.y, worldPoint.z].every(Number.isFinite);
      if (!hasScreenPoint && !hasWorldPoint) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Viewer hover requires x_fraction/y_fraction from 0 to 1, or a finite world_point {x,y,z}.");
      }
      if (!hasScreenPoint) {
        xFraction = null;
        yFraction = null;
      }
      const expectedDeterministicId = String(
        args.expected_deterministic_id ?? args.expectedDeterministicId ?? "",
      ).trim() || null;
      if (expectedDeterministicId && (expectedDeterministicId.length > 240 || /[\r\n\0]/.test(expectedDeterministicId))) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Viewer hover expected_deterministic_id is invalid.");
      }
      timings.validation_ms = elapsedMs(validationStart);

      const providerStart = process.hrtime.bigint();
      let viewer;
      try {
        viewer = await this.core.inspectViewer({
          documentId,
          workspaceId,
          elementId,
          mode: "hover_probe",
          xFraction,
          yFraction,
          expectedDeterministicId,
          worldPoint: hasWorldPoint ? worldPoint : null,
        });
      } catch (error) {
        timings.provider_ms = elapsedMs(providerStart);
        timings.total_ms = elapsedMs(totalStart);
        if (String(error?.code || "") !== "VIEWER_HOVER_NOT_VERIFIED") throw error;
        const hover = error?.hover_set && typeof error.hover_set === "object" ? error.hover_set : {};
        const hoverStatus = String(hover.status || "UNKNOWN").slice(0, 80);
        const preEffectStatuses = new Set([
          "NOT_READY",
          "NO_VIEWPORT",
          "SET_HOVERED_SELECTION_CONTRACT_MISMATCH",
          "HOVER_READBACK_UNAVAILABLE",
          "AMBIGUOUS_EXPECTED_ID",
          "EXPECTED_ID_NOT_PICKED",
          "AMBIGUOUS_PICK",
          "NO_PICK",
          "UI_SELECTION_UNAVAILABLE",
          "WORLD_POINT_PERSPECTIVE_UNSUPPORTED",
          "WORLD_POINT_PROJECTION_UNAVAILABLE",
          "WORLD_POINT_OFFSCREEN",
          "CAMERA_FIT_CONTRACT_MISMATCH",
          "CAMERA_FIT_DISPATCH_FAILED",
        ]);
        const effectSent = preEffectStatuses.has(hoverStatus)
          ? false
          : hoverStatus === "HOVER_READBACK_MISMATCH" ? true : null;
        const observedIds = Array.isArray(hover.observed_deterministic_ids)
          ? hover.observed_deterministic_ids.map((value) => String(value).slice(0, 240)).slice(0, 16)
          : [];
        return {
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: effectSent === false ? "REJECTED" : "UNCERTAIN",
          detail: `Viewer hover did not verify: ${hoverStatus}`,
          evidence: {
            effectSent,
            effectScope: hasWorldPoint ? "EPHEMERAL_VIEWER_CAMERA_AND_HOVER" : "EPHEMERAL_VIEWER_HOVER",
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
            target: { documentId, workspaceId, elementId },
            expectedDeterministicId,
            xFraction,
            yFraction,
            worldPoint: hasWorldPoint ? worldPoint : null,
            hoverStatus,
            observedDeterministicIds: observedIds,
            projectedXFraction: Number.isFinite(Number(hover.projected_x_fraction)) ? Number(hover.projected_x_fraction) : null,
            projectedYFraction: Number.isFinite(Number(hover.projected_y_fraction)) ? Number(hover.projected_y_fraction) : null,
            projectedX: Number.isInteger(Number(hover.projected_x)) ? Number(hover.projected_x) : null,
            projectedY: Number.isInteger(Number(hover.projected_y)) ? Number(hover.projected_y) : null,
            projectionCameraWidth: Number.isFinite(Number(hover.projection_camera_width)) ? Number(hover.projection_camera_width) : null,
            projectionCameraHeight: Number.isFinite(Number(hover.projection_camera_height)) ? Number(hover.projection_camera_height) : null,
            projectionViewMatrix: Array.isArray(hover.projection_view_matrix)
              && hover.projection_view_matrix.length === 16
              && hover.projection_view_matrix.every((value) => Number.isFinite(Number(value)))
              ? hover.projection_view_matrix.map(Number) : [],
            projectionCameraViewport: Array.isArray(hover.projection_camera_viewport)
              && hover.projection_camera_viewport.length >= 4
              && hover.projection_camera_viewport.slice(0, 4).every((value) => Number.isFinite(Number(value)))
              ? hover.projection_camera_viewport.slice(0, 4).map(Number) : [],
            projectionIsPerspective: typeof hover.projection_is_perspective === "boolean"
              ? hover.projection_is_perspective : null,
            pickConstructor: typeof hover.pick_constructor === "string" ? hover.pick_constructor.slice(0, 120) : null,
            pickOwnKeys: Array.isArray(hover.pick_own_keys)
              ? hover.pick_own_keys.map((value) => String(value).slice(0, 120)).slice(0, 48)
              : [],
            pickMethods: Array.isArray(hover.pick_methods)
              ? hover.pick_methods.slice(0, 64).map((item) => ({
                  name: String(item?.name || "").slice(0, 120),
                  arity: Number.isFinite(Number(item?.arity)) ? Number(item.arity) : null,
                }))
              : [],
            isUiPick: typeof hover.is_ui_pick === "boolean" ? hover.is_ui_pick : null,
            getUiSelectionType: typeof hover.get_ui_selection_type === "string"
              ? hover.get_ui_selection_type.slice(0, 40) : null,
            getUiSelectionConstructor: typeof hover.get_ui_selection_constructor === "string"
              ? hover.get_ui_selection_constructor.slice(0, 120) : null,
            getUiSelectionOwnKeys: Array.isArray(hover.get_ui_selection_own_keys)
              ? hover.get_ui_selection_own_keys.map((value) => String(value).slice(0, 120)).slice(0, 32)
              : [],
            getModelSelectionType: typeof hover.get_model_selection_type === "string"
              ? hover.get_model_selection_type.slice(0, 40) : null,
            getModelSelectionConstructor: typeof hover.get_model_selection_constructor === "string"
              ? hover.get_model_selection_constructor.slice(0, 120) : null,
            getModelSelectionOwnKeys: Array.isArray(hover.get_model_selection_own_keys)
              ? hover.get_model_selection_own_keys.map((value) => String(value).slice(0, 120)).slice(0, 48)
              : [],
            getModelSelectionMethods: Array.isArray(hover.get_model_selection_methods)
              ? hover.get_model_selection_methods.slice(0, 64).map((item) => ({
                  name: String(item?.name || "").slice(0, 120),
                  arity: Number.isFinite(Number(item?.arity)) ? Number(item.arity) : null,
                }))
              : [],
            getModelSelectionIdString: typeof hover.get_model_selection_id_string === "string"
              ? hover.get_model_selection_id_string.slice(0, 240) : null,
            getModelSelectionDeterministicId: typeof hover.get_model_selection_deterministic_id === "string"
              ? hover.get_model_selection_deterministic_id.slice(0, 240) : null,
            getModelSelectionSourcePickSameObject: typeof hover.get_model_selection_source_pick_same_object === "boolean"
              ? hover.get_model_selection_source_pick_same_object : null,
            createdBtUiSelectionType: typeof hover.created_bt_ui_selection_type === "string"
              ? hover.created_bt_ui_selection_type.slice(0, 40) : null,
            createdBtUiSelectionConstructor: typeof hover.created_bt_ui_selection_constructor === "string"
              ? hover.created_bt_ui_selection_constructor.slice(0, 120) : null,
            createdBtUiSelectionOwnKeys: Array.isArray(hover.created_bt_ui_selection_own_keys)
              ? hover.created_bt_ui_selection_own_keys.map((value) => String(value).slice(0, 120)).slice(0, 48)
              : [],
            createdBtUiSelectionSelectionId: typeof hover.created_bt_ui_selection_selection_id === "string"
              ? hover.created_bt_ui_selection_selection_id.slice(0, 240) : null,
            createdBtUiSelectionMeshIncrementId: typeof hover.created_bt_ui_selection_mesh_increment_id === "string"
              ? hover.created_bt_ui_selection_mesh_increment_id.slice(0, 240) : null,
            createdBtUiSelectionId: (typeof hover.created_bt_ui_selection_id === "string"
              || Number.isFinite(Number(hover.created_bt_ui_selection_id)))
              ? String(hover.created_bt_ui_selection_id).slice(0, 240) : null,
            createdBtUiSelectionTypeValue: (typeof hover.created_bt_ui_selection_type_value === "string"
              || Number.isFinite(Number(hover.created_bt_ui_selection_type_value)))
              ? String(hover.created_bt_ui_selection_type_value).slice(0, 120) : null,
            createdBtUiSelectionDeterministicIds: Array.isArray(hover.created_bt_ui_selection_deterministic_ids)
              ? hover.created_bt_ui_selection_deterministic_ids.map((value) => String(value).slice(0, 240)).slice(0, 16)
              : [],
            createdBtUiSelectionTableRowId: (typeof hover.created_bt_ui_selection_table_row_id === "string"
              || Number.isFinite(Number(hover.created_bt_ui_selection_table_row_id)))
              ? String(hover.created_bt_ui_selection_table_row_id).slice(0, 240) : null,
            createdBtUiElementConstructor: typeof hover.created_bt_ui_element_constructor === "string"
              ? hover.created_bt_ui_element_constructor.slice(0, 120) : null,
            createdBtUiElementOwnKeys: Array.isArray(hover.created_bt_ui_element_own_keys)
              ? hover.created_bt_ui_element_own_keys.map((value) => String(value).slice(0, 120)).slice(0, 48)
              : [],
            viewerDoPreHighlightPickAvailable: typeof hover.viewer_do_pre_highlight_pick_available === "boolean"
              ? hover.viewer_do_pre_highlight_pick_available : null,
            viewerDoPreHighlightPickArity: Number.isInteger(Number(hover.viewer_do_pre_highlight_pick_arity))
              ? Number(hover.viewer_do_pre_highlight_pick_arity) : null,
            viewerDoPreHighlightPickSource: typeof hover.viewer_do_pre_highlight_pick_source === "string"
              ? hover.viewer_do_pre_highlight_pick_source.slice(0, 1600) : null,
            viewerDoPickAvailable: typeof hover.viewer_do_pick_available === "boolean"
              ? hover.viewer_do_pick_available : null,
            viewerDoPickArity: Number.isInteger(Number(hover.viewer_do_pick_arity))
              ? Number(hover.viewer_do_pick_arity) : null,
            viewerDoPickSource: typeof hover.viewer_do_pick_source === "string"
              ? hover.viewer_do_pick_source.slice(0, 1600) : null,
            viewerPreHighlightUiSelectionAvailable: typeof hover.viewer_pre_highlight_ui_selection_available === "boolean"
              ? hover.viewer_pre_highlight_ui_selection_available : null,
            viewerPreHighlightUiSelectionArity: Number.isInteger(Number(hover.viewer_pre_highlight_ui_selection_arity))
              ? Number(hover.viewer_pre_highlight_ui_selection_arity) : null,
            viewerPreHighlightUiSelectionSource: typeof hover.viewer_pre_highlight_ui_selection_source === "string"
              ? hover.viewer_pre_highlight_ui_selection_source.slice(0, 1600) : null,
            sourceSelectionId: typeof hover.source_selection_id === "string" ? hover.source_selection_id.slice(0, 240) : null,
            hoveredSelectionId: typeof hover.hovered_selection_id === "string" ? hover.hovered_selection_id.slice(0, 240) : null,
            sameObject: typeof hover.same_object === "boolean" ? hover.same_object : null,
            sourceDeterministicId: typeof hover.source_deterministic_id === "string"
              ? hover.source_deterministic_id.slice(0, 240) : null,
            hoveredDeterministicId: typeof hover.hovered_deterministic_id === "string"
              ? hover.hovered_deterministic_id.slice(0, 240) : null,
            sameModelObject: typeof hover.same_model_object === "boolean" ? hover.same_model_object : null,
            doPickResult: typeof hover.do_pick_result === "boolean" ? hover.do_pick_result : null,
            postObservedDeterministicIds: Array.isArray(hover.post_observed_deterministic_ids)
              ? hover.post_observed_deterministic_ids.map((value) => String(value).slice(0, 240)).slice(0, 16)
              : [],
            verificationDelayFrames: Number.isInteger(Number(hover.verification_delay_frames))
              ? Number(hover.verification_delay_frames) : null,
            doPickSource: typeof hover.do_pick_source === "string"
              ? hover.do_pick_source.slice(0, 2400) : null,
            hoverRoute: typeof hover.route === "string" ? hover.route.slice(0, 120) : null,
          },
          timing: timings,
        };
      }
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "SUCCEEDED",
        detail: "The exact Viewer pick was highlighted through the precompiled Tier-2 route and verified through its route-specific bounded readback.",
        evidence: {
          effectSent: true,
          effectScope: hasWorldPoint ? "EPHEMERAL_VIEWER_CAMERA_AND_HOVER" : "EPHEMERAL_VIEWER_HOVER",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
          expectedDeterministicId,
          xFraction,
          yFraction,
          worldPoint: hasWorldPoint ? worldPoint : null,
        },
        viewer,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEWER_SELECTION") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const args = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "Viewer selection requires 24-hex document/workspace/element ids.");
      }
      const action = String(args.action || "select").trim().toLowerCase();
      if (!["select", "add", "clear"].includes(action)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "viewer.selection action must be select, add, or clear.");
      }
      let xFraction = null;
      let yFraction = null;
      if (action === "select" || action === "add") {
        xFraction = Number(args.x_fraction ?? args.xFraction);
        yFraction = Number(args.y_fraction ?? args.yFraction);
        if (!Number.isFinite(xFraction) || !Number.isFinite(yFraction)
          || xFraction < 0 || xFraction > 1 || yFraction < 0 || yFraction > 1) {
          throw codedError("ONSHAPE_INTENT_ARGUMENTS", "viewer.selection select/add requires x_fraction and y_fraction from 0 to 1.");
        }
      }
      const expectedDeterministicId = String(
        args.expected_deterministic_id ?? args.expectedDeterministicId ?? "",
      ).trim() || null;
      if (expectedDeterministicId && (expectedDeterministicId.length > 240 || /[\r\n\0]/.test(expectedDeterministicId))) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "viewer.selection expected_deterministic_id is invalid.");
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      let selection;
      try {
        selection = await this.core.setViewerSelection({
          documentId, workspaceId, elementId,
          action, xFraction, yFraction, expectedDeterministicId,
        });
      } catch (error) {
        timings.provider_ms = elapsedMs(providerStart);
        timings.total_ms = elapsedMs(totalStart);
        if (String(error?.code || "") !== "VIEWER_SELECTION_NOT_VERIFIED") throw error;
        const result = error?.selection_result && typeof error.selection_result === "object" ? error.selection_result : {};
        return {
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "REJECTED",
          detail: `Viewer selection did not verify: ${String(result.status || "UNKNOWN").slice(0, 100)}`,
          evidence: {
            effectSent: ["SELECTION_READBACK_MISMATCH", "SET_SELECTION_DISPATCH_FAILED"].includes(String(result.status || "")),
            effectScope: "PERSISTENT_WORK_PAGE_SELECTION",
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
            target: { documentId, workspaceId, elementId },
            action, xFraction, yFraction, expectedDeterministicId,
          },
          selection: result,
          timing: timings,
        };
      }
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "SUCCEEDED",
        detail: action === "clear"
          ? "Persistent Viewer selection was cleared and verified by selection readback."
          : action === "add"
            ? "Persistent Viewer target was added while preserving prior exact selection identities."
            : "Persistent Viewer target was selected and verified by exact deterministic-id readback.",
        evidence: {
          effectSent: true,
          effectScope: "PERSISTENT_WORK_PAGE_SELECTION",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
          action, xFraction, yFraction, expectedDeterministicId,
        },
        selection,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEW_STANDARD") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const args = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "view.standard requires 24-hex document/workspace/element ids.");
      }
      const view = String(args.view || "").trim().toLowerCase();
      if (view !== "top") {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "view.standard currently admits only view:top.");
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      let standard;
      try {
        standard = await this.core.standardView({ documentId, workspaceId, elementId, view });
      } catch (error) {
        timings.provider_ms = elapsedMs(providerStart);
        timings.total_ms = elapsedMs(totalStart);
        if (String(error?.code || "") !== "VIEW_STANDARD_NOT_VERIFIED") throw error;
        return {
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "REJECTED",
          detail: "Top standard view did not verify.",
          evidence: {
            effectSent: true,
            effectScope: "PERSISTENT_WORK_PAGE_CAMERA",
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
            target: { documentId, workspaceId, elementId },
            view,
          },
          standardView: error?.standard_view || null,
          timing: timings,
        };
      }
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "SUCCEEDED",
        detail: "Exact Top standard view was applied on the persistent work page and verified.",
        evidence: {
          effectSent: true,
          effectScope: "PERSISTENT_WORK_PAGE_CAMERA",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
          view,
        },
        standardView: standard,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEW_MOVE") {
      const validationStart = process.hrtime.bigint();
      const targetResolveStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      timings.target_resolution_ms = elapsedMs(targetResolveStart);
      const args = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "View movement requires 24-hex document/workspace/element ids.");
      }
      const action = String(args.action || "").trim().toLowerCase();
      const direction = String(args.direction || "").trim().toLowerCase();
      const rawAngle = args.angle_degrees ?? args.angleDegrees ?? null;
      const angleDegrees = rawAngle == null ? null : Number(rawAngle);
      const intensity = args.intensity == null
        ? (angleDegrees != null ? 1 : NaN)
        : Number(args.intensity);
      if (!["pan", "orbit", "zoom"].includes(action)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "view.move action must be pan, orbit, or zoom.");
      }
      const allowedDirection = action === "zoom"
        ? ["in", "out"]
        : action === "pan"
          ? ["left", "right", "up", "down"]
          : ["left", "right", "up", "down", "clockwise", "counterclockwise"];
      if (!allowedDirection.includes(direction)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", `view.move direction is invalid for ${action}.`);
      }
      if (!Number.isFinite(intensity) || intensity <= 0 || intensity > 5) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "view.move intensity must be a finite number greater than 0 and at most 5.");
      }
      if (angleDegrees != null) {
        if (action !== "orbit") {
          throw codedError("ONSHAPE_INTENT_ARGUMENTS", "angle_degrees is admitted only for orbit.");
        }
        if (!Number.isFinite(angleDegrees) || angleDegrees <= 0 || angleDegrees > 360) {
          throw codedError("ONSHAPE_INTENT_ARGUMENTS", "angle_degrees must be greater than 0 and at most 360.");
        }
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      let movement;
      try {
        movement = await this.core.moveView({
          documentId, workspaceId, elementId, action, direction, intensity, angleDegrees,
        });
      } catch (error) {
        timings.provider_ms = elapsedMs(providerStart);
        timings.total_ms = elapsedMs(totalStart);
        if (String(error?.code || "") !== "VIEWER_MOVE_NOT_VERIFIED") throw error;
        const move = error?.move_result && typeof error.move_result === "object" ? error.move_result : {};
        const bt = move?.timing || {};
        if (bt?.open_document?.total_ms != null) timings.open_document_ms = Number(bt.open_document.total_ms) || 0;
        if (bt?.viewer_acquisition_ms != null) timings.viewer_acquisition_ms = Number(bt.viewer_acquisition_ms) || 0;
        if (bt?.dispatch_ms != null) timings.dispatch_ms = Number(bt.dispatch_ms) || 0;
        if (bt?.verification_ms != null) timings.camera_verification_ms = Number(bt.verification_ms) || 0;
        return {
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "REJECTED",
          detail: `View movement did not verify: ${String(move.status || "UNKNOWN").slice(0, 80)}`,
          evidence: {
            effectSent: String(move.status || "") === "NO_CAMERA_CHANGE" ? true : false,
            effectScope: "PERSISTENT_WORK_PAGE_CAMERA",
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
            target: { documentId, workspaceId, elementId },
            action, direction, intensity, angleDegrees,
            movement: move,
          },
          timing: timings,
        };
      }
      timings.provider_ms = elapsedMs(providerStart);
      const bt = movement?.timing || {};
      if (bt?.open_document?.total_ms != null) timings.open_document_ms = Number(bt.open_document.total_ms) || 0;
      if (bt?.open_document?.auth_ms != null) timings.auth_ms = Number(bt.open_document.auth_ms) || 0;
      if (bt?.open_document?.navigation_ms != null) timings.navigation_ms = Number(bt.open_document.navigation_ms) || 0;
      if (bt?.viewer_acquisition_ms != null) timings.viewer_acquisition_ms = Number(bt.viewer_acquisition_ms) || 0;
      if (bt?.dispatch_ms != null) timings.dispatch_ms = Number(bt.dispatch_ms) || 0;
      if (bt?.verification_ms != null) timings.camera_verification_ms = Number(bt.verification_ms) || 0;
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "SUCCEEDED",
        detail: action === "pan"
          ? "Persistent Viewer pan completed with screen-space user-direction mapping and camera readback."
          : "Persistent Viewer camera movement completed and verified by bounded before/after camera readback.",
        evidence: {
          effectSent: true,
          effectScope: "PERSISTENT_WORK_PAGE_CAMERA",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
          action, direction, intensity, angleDegrees,
        },
        movement,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEW_FIT") {
      const validationStart = process.hrtime.bigint();
      const targetResolveStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      timings.target_resolution_ms = elapsedMs(targetResolveStart);
      const args = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "View fit requires 24-hex document/workspace/element ids.");
      }
      const action = String(args.action || "fit").trim().toLowerCase();
      if (!["fit", "fit_selection"].includes(action)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "view.fit action must be fit or fit_selection.");
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      let fit;
      try {
        fit = await this.core.fitView({ documentId, workspaceId, elementId, action });
      } catch (error) {
        timings.provider_ms = elapsedMs(providerStart);
        timings.total_ms = elapsedMs(totalStart);
        if (String(error?.code || "") !== "VIEW_FIT_NOT_VERIFIED") throw error;
        const result = error?.fit_result && typeof error.fit_result === "object" ? error.fit_result : {};
        const bt = result?.timing || {};
        if (bt?.open_document?.total_ms != null) timings.open_document_ms = Number(bt.open_document.total_ms) || 0;
        const preEffect = new Set([
          "CONTINUITY_BREAK_RESTORED_TARGET",
          "NOT_READY",
          "NO_VIEWPORT",
          "NO_VIEWER",
          "CONTRACT_MISMATCH",
          "INSTANCE_QUERY_FAILED",
          "FIT_CONTRACT_MISMATCH",
          "NO_SELECTION",
          "SELECTION_BOUNDS_UNAVAILABLE",
          "FIT_DISPATCH_FAILED",
        ]);
        return {
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "REJECTED",
          detail: `View fit did not verify: ${String(result.status || "UNKNOWN").slice(0, 100)}`,
          evidence: {
            effectSent: preEffect.has(String(result.status || "")) ? false : true,
            effectScope: "PERSISTENT_WORK_PAGE_CAMERA",
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
            target: { documentId, workspaceId, elementId },
            action,
            fit: result,
          },
          timing: timings,
        };
      }
      timings.provider_ms = elapsedMs(providerStart);
      const bt = fit?.timing || {};
      if (bt?.open_document?.total_ms != null) timings.open_document_ms = Number(bt.open_document.total_ms) || 0;
      if (bt?.open_document?.auth_ms != null) timings.auth_ms = Number(bt.open_document.auth_ms) || 0;
      if (bt?.viewer_acquisition_ms != null) timings.viewer_acquisition_ms = Number(bt.viewer_acquisition_ms) || 0;
      if (bt?.dispatch_ms != null) timings.dispatch_ms = Number(bt.dispatch_ms) || 0;
      if (bt?.verification_ms != null) timings.camera_verification_ms = Number(bt.verification_ms) || 0;
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "SUCCEEDED",
        detail: action === "fit_selection"
          ? "Existing persistent Viewer selection was fit and preserved by exact deterministic-id readback."
          : "Persistent Viewer geometry was fit using native Viewer bounds.",
        evidence: {
          effectSent: true,
          effectScope: "PERSISTENT_WORK_PAGE_CAMERA",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
          action,
        },
        fit,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEW_FOLLOW") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const args = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "view.follow requires 24-hex document/workspace/element ids.");
      }
      const rawCandidate = args.candidate_index ?? args.candidateIndex ?? null;
      const candidateIndex = rawCandidate == null ? null : Number(rawCandidate);
      if (candidateIndex != null && (!Number.isInteger(candidateIndex) || candidateIndex < 0)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "view.follow candidate_index must be a non-negative integer when provided.");
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      const follow = await this.core.followView({
        documentId, workspaceId, elementId, candidateIndex,
      });
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: String(follow?.status || "") === "FOLLOW_DISPATCHED" ? "SUCCEEDED" : "REJECTED",
        detail: "Persistent Onshape Follow was dispatched on the qualified collaborator-icon path.",
        evidence: {
          effectSent: true,
          effectScope: "PERSISTENT_WORK_PAGE_FOLLOW",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
        },
        follow,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEW_FOLLOW_TEST") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const args = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "Follow handoff testing requires 24-hex document/workspace/element ids.");
      }
      const pageCount = Number(args.page_count ?? args.pageCount ?? 2);
      if (![2, 3].includes(pageCount)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "view.follow_test page_count must be 2 or 3.");
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      const follow = await this.core.testFollowHandoff({
        documentId, workspaceId, elementId, pageCount,
      });
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      const verified = pageCount === 2
        ? String(follow?.status || "") === "VERIFIED"
        : String(follow?.status || "") === "THREE_PARTICIPANT_DOM_VERIFIED";
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: verified ? "SUCCEEDED" : "REJECTED",
        detail: verified
          ? (pageCount === 2
              ? "Two-way Onshape Follow handoff was verified by camera convergence, local break, and reverse convergence."
              : "Three-participant collaboration DOM/disambiguation evidence was captured.")
          : `Follow handoff did not verify: ${String(follow?.status || "UNKNOWN").slice(0, 100)}`,
        evidence: {
          effectSent: pageCount === 2,
          effectScope: "EPHEMERAL_MULTI_TAB_FOLLOW_QUALIFICATION",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
          pageCount,
        },
        follow,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEW_REMOTE_GROUND_TEST") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "Remote selection grounding test requires 24-hex document/workspace/element ids.");
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      const grounding = await this.core.testRemoteSelectionGrounding({
        documentId, workspaceId, elementId,
      });
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      const verified = String(grounding?.status || "") === "VERIFIED";
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: verified ? "SUCCEEDED" : "REJECTED",
        detail: verified
          ? "Follow viewport inheritance and bounded local deterministic-id re-pick were verified."
          : `Remote selection grounding did not verify: ${String(grounding?.status || "UNKNOWN").slice(0, 100)}`,
        evidence: {
          effectSent: true,
          effectScope: "PERSISTENT_FOLLOWER_EPHEMERAL_LEADER_GROUNDING_QUALIFICATION",
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
        },
        grounding,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "VIEWER_INSPECT") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const args = {
        ...resolved.defaults,
        ...plainObject(request.arguments, "arguments"),
      };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "Viewer inspection requires 24-hex document/workspace/element ids.");
      }
      const mode = String(args.mode ?? "state").trim().toLowerCase();
      if (!["state", "selection", "probe", "methods", "method_details", "selection_scan", "collaboration"].includes(mode)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Viewer inspection mode must be state, selection, probe, methods, method_details, selection_scan, or collaboration.");
      }
      let xFraction = null;
      let yFraction = null;
      if (mode === "probe") {
        xFraction = Number(args.x_fraction ?? args.xFraction);
        yFraction = Number(args.y_fraction ?? args.yFraction);
        if (!Number.isFinite(xFraction) || !Number.isFinite(yFraction)
          || xFraction < 0 || xFraction > 1 || yFraction < 0 || yFraction > 1) {
          throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Viewer probe requires x_fraction and y_fraction from 0 to 1.");
        }
      }
      timings.validation_ms = elapsedMs(validationStart);

      const providerStart = process.hrtime.bigint();
      const viewer = await this.core.inspectViewer({
        documentId,
        workspaceId,
        elementId,
        mode,
        xFraction,
        yFraction,
        collaborationPageCount: mode === "collaboration" ? Number(args.page_count ?? args.pageCount ?? 2) : 2,
      });
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "SUCCEEDED",
        detail: "Read-only Onshape Viewer inspection completed with the precompiled runtime self-test.",
        evidence: {
          effectSent: false,
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
          mode,
        },
        viewer,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "FEATURE_REORDER_PROBE") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "Feature reorder probe requires 24-hex document/workspace/element ids.");
      }
      timings.validation_ms = elapsedMs(validationStart);
      const providerStart = process.hrtime.bigint();
      const probe = await this.core.inspectFeatureReorderMachinery({
        documentId, workspaceId, elementId,
      });
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      return {
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "SUCCEEDED",
        detail: "Read-only bounded Feature-list reorder machinery probe completed.",
        evidence: {
          effectSent: false,
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: { documentId, workspaceId, elementId },
        },
        probe,
        timing: timings,
      };
    }

    if (contract.backend.kind === SEMANTIC_BACKEND_BOUNDED_UI && contract.backend.executor === "FEATURE_REORDER") {
      const validationStart = process.hrtime.bigint();
      const target = await this._autoResolveTarget(request.target, { resolveParts: false });
      const args = { ...resolved.defaults, ...plainObject(request.arguments, "arguments") };
      const documentId = String(target.document_id ?? target.documentId ?? "").trim();
      const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
      const elementId = String(target.element_id ?? target.elementId ?? "").trim();
      if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
        throw codedError("ONSHAPE_TARGET_ID_INVALID", "Feature reorder requires 24-hex document/workspace/element ids.");
      }
      const sourceFeatureId = String(args.source_feature_id ?? args.sourceFeatureId ?? "").trim();
      const sourceFeatureName = String(args.source_feature_name ?? args.sourceFeatureName ?? "").trim();
      const targetFeatureId = String(args.target_feature_id ?? args.targetFeatureId ?? "").trim();
      const targetFeatureName = String(args.target_feature_name ?? args.targetFeatureName ?? "").trim();
      const placement = String(args.placement ?? "before").trim().toLowerCase();
      if (!sourceFeatureId && !sourceFeatureName) {
        throw codedError("ONSHAPE_TARGET_REQUIRED", "Feature reorder requires source_feature_id or source_feature_name.");
      }
      if (!targetFeatureId && !targetFeatureName) {
        throw codedError("ONSHAPE_TARGET_REQUIRED", "Feature reorder requires target_feature_id or target_feature_name.");
      }
      if (!["before", "after"].includes(placement)) {
        throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Feature reorder placement must be before or after.");
      }
      const requestId = request.requestId == null
        ? "req_" + randomBytes(16).toString("hex")
        : cleanRequestId(request.requestId);
      const requestHash = sha256Json({
        capabilityId: contract.capabilityId,
        documentId, workspaceId, elementId,
        sourceFeatureId, sourceFeatureName,
        targetFeatureId, targetFeatureName,
        placement,
      });
      timings.validation_ms = elapsedMs(validationStart);

      const journalStart = process.hrtime.bigint();
      const existing = this._readRecord(requestId);
      if (existing) {
        if (existing.schema !== "onshape.semantic-request.v1" || existing.requestHash !== requestHash) {
          throw codedError("ONSHAPE_REQUEST_ID_CONFLICT", "request_id was reused for a different Onshape semantic operation.");
        }
        timings.journal_ms = elapsedMs(journalStart);
        timings.total_ms = elapsedMs(totalStart);
        if (existing.observation) {
          return {
            ...existing.observation,
            replayedFromJournal: true,
            timing: {
              ...(existing.observation.timing || {}),
              replay_lookup_ms: timings.total_ms,
            },
          };
        }
        return {
          requestId,
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "UNCERTAIN",
          externalReference: "onshape-agent:" + requestId,
          detail: "The same feature reorder is already in-flight or ended before a terminal journal write.",
          evidence: { effectSent: null, blindReplayAllowed: false },
          timing: timings,
        };
      }
      const claimed = {
        schema: "onshape.semantic-request.v1",
        requestId,
        capabilityId: contract.capabilityId,
        requestHash,
        state: "EXECUTING",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        observation: null,
      };
      this._writeRecord(claimed);
      timings.journal_ms = elapsedMs(journalStart);
      const finish = (observation) => {
        timings.total_ms = elapsedMs(totalStart);
        const finalObservation = { ...observation, timing: { ...timings } };
        this._writeRecord({
          ...claimed,
          state: finalObservation.state,
          updatedAt: new Date().toISOString(),
          observation: finalObservation,
        });
        return finalObservation;
      };

      const targetStart = process.hrtime.bigint();
      let beforeRead;
      let sourceFeature;
      let targetFeature;
      try {
        beforeRead = await this._readPartStudioFeatures(documentId, workspaceId, elementId);
        const messages = beforeRead.messages;
        sourceFeature = this._locateFeature(messages, { featureId: sourceFeatureId, featureName: sourceFeatureName });
        targetFeature = this._locateFeature(messages, { featureId: targetFeatureId, featureName: targetFeatureName });
        if (String(sourceFeature?.featureId || "") === String(targetFeature?.featureId || "")) {
          throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Source and target feature must be different.");
        }
        timings.target_resolution_ms = elapsedMs(targetStart);
      } catch (error) {
        timings.target_resolution_ms = elapsedMs(targetStart);
        return finish({
          requestId,
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "REJECTED",
          externalReference: "onshape-agent:" + requestId,
          detail: `Feature reorder target resolution failed: ${error?.code || error?.name || "error"}`,
          evidence: {
            effectSent: false,
            blindReplayAllowed: false,
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
          },
        });
      }

      const sourceId = String(sourceFeature.featureId || "").trim();
      const targetId = String(targetFeature.featureId || "").trim();
      const sourceName = String(sourceFeature.name || "").trim();
      const targetName = String(targetFeature.name || "").trim();
      const providerStart = process.hrtime.bigint();
      let uiResult;
      try {
        uiResult = await this.core.reorderFeature({
          documentId, workspaceId, elementId,
          sourceFeatureId: sourceId,
          targetFeatureId: targetId,
          placement,
        });
        timings.provider_ms = elapsedMs(providerStart);
      } catch (error) {
        timings.provider_ms = elapsedMs(providerStart);
        return finish({
          requestId,
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "UNCERTAIN",
          externalReference: "onshape-agent:" + requestId,
          detail: `Bounded feature reorder did not return a terminal acknowledgement: ${error?.code || error?.name || "error"}`,
          evidence: {
            effectSent: null,
            blindReplayAllowed: false,
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
            source: { featureId: sourceId, name: sourceName },
            target: { featureId: targetId, name: targetName },
            placement,
          },
        });
      }

      const verifyStart = process.hrtime.bigint();
      let verification;
      try {
        const after = await this._readPartStudioFeatures(documentId, workspaceId, elementId);
        const order = after.messages.map((item) => String(item?.featureId ?? "").trim()).filter(Boolean);
        const sourceIndex = order.indexOf(sourceId);
        const targetIndex = order.indexOf(targetId);
        const verified = placement === "before"
          ? sourceIndex >= 0 && targetIndex >= 0 && sourceIndex + 1 === targetIndex
          : sourceIndex >= 0 && targetIndex >= 0 && targetIndex + 1 === sourceIndex;
        verification = {
          verified,
          source_index: sourceIndex,
          target_index: targetIndex,
          placement,
          observed_order: order,
        };
        timings.verification_ms = elapsedMs(verifyStart);
      } catch (error) {
        timings.verification_ms = elapsedMs(verifyStart);
        return finish({
          requestId,
          intent,
          capabilityId: contract.capabilityId,
          semanticBackend: contract.backend.kind,
          state: "UNCERTAIN",
          externalReference: "onshape-agent:" + requestId,
          detail: `Feature reorder was dispatched but readback failed: ${error?.code || error?.name || "error"}`,
          evidence: {
            effectSent: true,
            blindReplayAllowed: false,
            providerAcknowledged: true,
            postconditionVerified: null,
            operationRiskClass: contract.riskClass,
            verificationStrategy: contract.verificationStrategy,
            source: { featureId: sourceId, name: sourceName },
            target: { featureId: targetId, name: targetName },
            placement,
            ui: uiResult,
          },
        });
      }

      return finish({
        requestId,
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: verification.verified ? "SUCCEEDED" : "UNCERTAIN",
        externalReference: "onshape-agent:" + requestId,
        detail: verification.verified
          ? "Onshape feature reorder completed and exact adjacency was verified by fresh Part Studio feature-list readback."
          : "Feature reorder input completed but the requested final adjacency was not verified; blind replay is disabled.",
        evidence: {
          effectSent: true,
          blindReplayAllowed: false,
          providerAcknowledged: true,
          postconditionVerified: verification.verified,
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          source: { featureId: sourceId, name: sourceName },
          target: { featureId: targetId, name: targetName },
          placement,
          verification,
          ui: uiResult,
        },
      });
    }

    if (contract.backend.kind !== SEMANTIC_BACKEND_BOUNDED_UI || contract.backend.executor !== "PART_VISIBILITY") {
      throw codedError("ONSHAPE_SEMANTIC_BACKEND_INVALID", "Unsupported semantic backend.");
    }

    const validationStart = process.hrtime.bigint();
    const target = await this._autoResolveTarget(request.target, { resolveParts: false });
    const args = {
      ...resolved.defaults,
      ...plainObject(request.arguments, "arguments"),
    };
    if (typeof args.visible !== "boolean") {
      throw codedError("ONSHAPE_INTENT_ARGUMENTS", "Part visibility requires visible=true or visible=false.");
    }
    const documentId = String(target.document_id ?? target.documentId ?? "").trim();
    const workspaceId = String(target.workspace_id ?? target.workspaceId ?? "").trim();
    const elementId = String(target.element_id ?? target.elementId ?? "").trim();
    if (![documentId, workspaceId, elementId].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      throw codedError("ONSHAPE_TARGET_ID_INVALID", "Part visibility requires 24-hex document/workspace/element ids.");
    }
    const requestedPartId = String(
      target.part_id ?? target.partId ?? target.entity_id ?? target.entityId ?? "",
    ).trim();
    const requestedPartName = String(
      target.part_name ?? target.partName ?? target.entity_name ?? target.entityName ?? "",
    ).trim();
    if (!requestedPartId && !requestedPartName) {
      throw codedError("ONSHAPE_TARGET_REQUIRED", "Part visibility requires a part id or part name.");
    }
    if (requestedPartId && !/^[A-Za-z0-9_.:-]{1,160}$/.test(requestedPartId)) {
      throw codedError("ONSHAPE_TARGET_ID_INVALID", "Part id contains unsupported characters.");
    }
    if (requestedPartName && (requestedPartName.length > 300 || /[\r\n\0]/.test(requestedPartName))) {
      throw codedError("ONSHAPE_TARGET_NAME_INVALID", "Part name is invalid.");
    }
    const requestId = request.requestId == null
      ? "req_" + randomBytes(16).toString("hex")
      : cleanRequestId(request.requestId);
    const requestHash = sha256Json({
      capabilityId: contract.capabilityId,
      documentId,
      workspaceId,
      elementId,
      requestedPartId,
      requestedPartName,
      visible: args.visible,
    });
    timings.validation_ms = elapsedMs(validationStart);

    const journalStart = process.hrtime.bigint();
    const existing = this._readRecord(requestId);
    if (existing) {
      if (existing.schema !== "onshape.semantic-request.v1" || existing.requestHash !== requestHash) {
        throw codedError("ONSHAPE_REQUEST_ID_CONFLICT", "request_id was reused for a different Onshape semantic operation.");
      }
      timings.journal_ms = elapsedMs(journalStart);
      timings.total_ms = elapsedMs(totalStart);
      if (existing.observation) {
        return {
          ...existing.observation,
          replayedFromJournal: true,
          timing: {
            ...(existing.observation.timing || {}),
            replay_lookup_ms: timings.total_ms,
          },
        };
      }
      return {
        requestId,
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "UNCERTAIN",
        externalReference: "onshape-agent:" + requestId,
        detail: "The same semantic mutation is already in-flight or ended before a terminal journal write.",
        evidence: { effectSent: null, blindReplayAllowed: false },
        timing: timings,
      };
    }
    const claimed = {
      schema: "onshape.semantic-request.v1",
      requestId,
      capabilityId: contract.capabilityId,
      requestHash,
      state: "EXECUTING",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      observation: null,
    };
    this._writeRecord(claimed);
    timings.journal_ms = elapsedMs(journalStart);

    const finish = (observation) => {
      timings.total_ms = elapsedMs(totalStart);
      const finalObservation = { ...observation, timing: { ...timings } };
      this._writeRecord({
        ...claimed,
        state: finalObservation.state,
        updatedAt: new Date().toISOString(),
        observation: finalObservation,
      });
      return finalObservation;
    };

    let partTarget;
    const targetStart = process.hrtime.bigint();
    try {
      partTarget = await this._resolvePartTarget({
        ...target,
        document_id: documentId,
        workspace_id: workspaceId,
        element_id: elementId,
      });
      timings.target_resolution_ms = elapsedMs(targetStart);
      const rt = partTarget.readTiming || {};
      timings.registry_ms += Number(rt.registry_ms ?? 0) || 0;
      if (rt.queue_wait_ms != null) timings.target_queue_wait_ms = Number(rt.queue_wait_ms) || 0;
      if (rt.pacing_wait_ms != null) timings.target_pacing_wait_ms = Number(rt.pacing_wait_ms) || 0;
      if (rt.provider_execution_ms != null) timings.target_provider_execution_ms = Number(rt.provider_execution_ms) || 0;
    } catch (error) {
      timings.target_resolution_ms = elapsedMs(targetStart);
      return finish({
        requestId,
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "REJECTED",
        externalReference: "onshape-agent:" + requestId,
        detail: `Part target resolution failed: ${error?.code || error?.name || "error"}`,
        evidence: {
          effectSent: false,
          blindReplayAllowed: false,
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
        },
      });
    }

    const providerStart = process.hrtime.bigint();
    let uiResult;
    try {
      uiResult = await this.core.setPartVisibility({
        documentId,
        workspaceId,
        elementId,
        partId: partTarget.partId,
        partName: partTarget.partName,
        visible: args.visible,
      });
      timings.provider_ms = elapsedMs(providerStart);
    } catch (error) {
      timings.provider_ms = elapsedMs(providerStart);
      return finish({
        requestId,
        intent,
        capabilityId: contract.capabilityId,
        semanticBackend: contract.backend.kind,
        state: "UNCERTAIN",
        externalReference: "onshape-agent:" + requestId,
        detail: `Bounded UI visibility execution did not return a terminal acknowledgement: ${error?.code || error?.name || "error"}`,
        evidence: {
          effectSent: null,
          blindReplayAllowed: false,
          operationRiskClass: contract.riskClass,
          verificationStrategy: contract.verificationStrategy,
          target: {
            partId: partTarget.partId,
            partName: partTarget.partName,
          },
        },
      });
    }

    return finish({
      requestId,
      intent,
      capabilityId: contract.capabilityId,
      semanticBackend: contract.backend.kind,
      state: "SUCCEEDED",
      externalReference: "onshape-agent:" + requestId,
      detail: args.visible
        ? "Onshape UI acknowledged show-part input on the exact semantic Parts-list row."
        : "Onshape UI acknowledged hide-part input on the exact semantic Parts-list row.",
      evidence: {
        effectSent: true,
        blindReplayAllowed: false,
        providerAcknowledged: true,
        postconditionVerified: null,
        operationRiskClass: contract.riskClass,
        verificationStrategy: contract.verificationStrategy,
        targetResolutionOperationId: partTarget.readOperationId,
        target: {
          partId: partTarget.partId,
          partName: partTarget.partName,
        },
        desiredVisible: args.visible,
        ui: uiResult,
      },
    });
  }

  async executeDocumentedOperation(input = {}) {
    const totalStart = process.hrtime.bigint();
    const timings = {
      registry_ms: 0,
      validation_ms: 0,
      journal_ms: 0,
      provider_ms: 0,
      verification_ms: 0,
      total_ms: 0,
    };

    const registryStart = process.hrtime.bigint();
    const request = plainObject(input, "operation request");
    const operationId = String(request.operationId || "").trim();
    const contract = this.resolveOperation(operationId);
    timings.registry_ms = elapsedMs(registryStart);

    const validationStart = process.hrtime.bigint();
    const riskClass = contract.riskClass;
    const agentEffect = riskClass === RISK_READ ? "READ_ONLY" : "MUTATION";
    if (agentEffect === "MUTATION") {
      if (riskClass === RISK_HIGH_IMPACT && request.ownerConfirmedHighImpact !== true) {
        throw codedError(
          "ONSHAPE_HIGH_IMPACT_CONFIRMATION_REQUIRED",
          "High-impact Onshape operation requires explicit owner intent in the same invocation.",
        );
      }
    }

    const pathParams = plainObject(request.pathParams, "pathParams");
    const pathValue = this._expandPath(contract.pathTemplate, pathParams);
    const query = plainObject(request.query, "query");
    const headers = plainObject(request.headers, "headers");
    const body = Object.prototype.hasOwnProperty.call(request, "body") ? request.body : undefined;
    const multipart = request.multipart ?? undefined;
    const requestId = request.requestId == null
      ? "req_" + randomBytes(16).toString("hex")
      : cleanRequestId(request.requestId);
    const mutation = agentEffect === "MUTATION";
    const requestHash = sha256Json({
      operationId: contract.operationId,
      pathParams,
      query,
      headers,
      body: body === undefined ? null : body,
      multipart: multipart === undefined ? null : multipart,
      ownerConfirmedHighImpact: request.ownerConfirmedHighImpact === true,
    });
    timings.validation_ms = elapsedMs(validationStart);

    let claimed = null;
    if (mutation) {
      const journalStart = process.hrtime.bigint();
      const existing = this._readRecord(requestId);
      if (existing) {
        if (existing.schema !== "onshape.direct-request.v1" || existing.requestHash !== requestHash) {
          throw codedError("ONSHAPE_REQUEST_ID_CONFLICT", "request_id was reused for a different Onshape operation.");
        }
        timings.journal_ms = elapsedMs(journalStart);
        timings.total_ms = elapsedMs(totalStart);
        if (existing.observation) {
          return {
            ...existing.observation,
            requestId,
            operationId: contract.operationId,
            replayedFromJournal: true,
            timing: { ...existing.observation.timing, replay_lookup_ms: timings.total_ms },
          };
        }
        return {
          requestId,
          operationId: contract.operationId,
          state: "UNCERTAIN",
          externalReference: "onshape-agent:" + requestId,
          detail: "The same mutation request is already in-flight or ended before a terminal journal write.",
          evidence: {
            effectSent: null,
            blindReplayAllowed: false,
            operationRiskClass: riskClass,
          },
          timing: timings,
        };
      }

      claimed = {
        schema: "onshape.direct-request.v1",
        requestId,
        operationId: contract.operationId,
        requestHash,
        state: "EXECUTING",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        observation: null,
      };
      this._writeRecord(claimed);
      timings.journal_ms = elapsedMs(journalStart);
    }

    const externalReference = "onshape-agent:" + requestId;
    let result;
    const providerStart = process.hrtime.bigint();
    try {
      const options = {
        headers: Object.keys(headers).length ? headers : undefined,
        multipart,
      };
      result = await this._request(
        contract.method,
        pathValue,
        query,
        body,
        options,
        contract.apiBasePath,
      );
    } catch (error) {
      timings.provider_ms = elapsedMs(providerStart);
      timings.total_ms = elapsedMs(totalStart);
      const observed = {
        requestId,
        operationId: contract.operationId,
        state: agentEffect === "MUTATION" ? "UNCERTAIN" : "REJECTED",
        externalReference,
        detail: `Onshape ${agentEffect === "MUTATION" ? "write" : "read"} transport failed: ${error?.code || error?.name || "error"}`,
        evidence: {
          effectSent: agentEffect === "MUTATION" ? null : false,
          blindReplayAllowed: false,
          operationRiskClass: riskClass,
          verificationStrategy: contract.verificationStrategy,
        },
        timing: timings,
      };
      if (claimed) {
        this._writeRecord({
          ...claimed,
          state: observed.state,
          updatedAt: new Date().toISOString(),
          observation: observed,
        });
      }
      return observed;
    }
    timings.provider_ms = elapsedMs(providerStart);
    if (result?.schedulerTiming && typeof result.schedulerTiming === "object") {
      timings.queue_wait_ms = Number(result.schedulerTiming.queue_wait_ms ?? 0) || 0;
      timings.pacing_wait_ms = Number(result.schedulerTiming.pacing_wait_ms ?? 0) || 0;
      timings.provider_execution_ms = Number(result.schedulerTiming.execution_ms ?? 0) || 0;
    }

    const http = Number(result?.http ?? 0) || null;
    const observedApiVersion = this._observedApiVersion(result);
    const baseEvidence = {
      httpStatus: http,
      contentType: result?.contentType ?? null,
      body: result?.body ?? null,
      artifact: result?.artifact ?? null,
      poolExecution: result?.pool_execution ?? null,
      glassworksDurationMs: Number(result?.durationMs ?? 0) || null,
      poolDurationMs: Number(result?.pool_execution?.duration_ms ?? 0) || null,
      apiMinimumIntervalMs: Number(result?.pool_execution?.api_minimum_interval_ms ?? 0) || null,
      schedulerTiming: result?.schedulerTiming ?? null,
      apiVersion: contract.apiVersion,
      observedApiVersion,
      operationRiskClass: riskClass,
      verificationStrategy: contract.verificationStrategy,
      qualificationState: contract.qualificationState,
      blindReplayAllowed: false,
    };

    let observed;
    if (!result?.ok) {
      const preEffect = result?.layer === "validation" || result?.layer === "anti-forgery";
      const state = preEffect || agentEffect === "READ_ONLY" || (http && http >= 400 && http < 500)
        ? "REJECTED"
        : "UNCERTAIN";
      observed = {
        requestId,
        operationId: contract.operationId,
        state,
        externalReference,
        detail: String(result?.reason || "Onshape operation failed."),
        evidence: {
          ...baseEvidence,
          effectSent: state === "REJECTED" ? false : null,
        },
        timing: timings,
      };
    } else if (agentEffect === "READ_ONLY") {
      observed = {
        requestId,
        operationId: contract.operationId,
        state: "SUCCEEDED",
        externalReference,
        detail: "Onshape read completed.",
        evidence: { ...baseEvidence, effectSent: false },
        timing: timings,
      };
    } else {
      const verifyStart = process.hrtime.bigint();
      let verification = {
        kind: "provider_acknowledged",
        verified: true,
      };
      try {
        if (contract.verificationStrategy === "DOCUMENT_NAME_READBACK") {
          const did = String(pathParams.did || "").trim();
          const expectedName = body && typeof body === "object" && !Array.isArray(body)
            ? String(body.name || "")
            : "";
          if (/^[0-9a-fA-F]{24}$/.test(did) && expectedName) {
            const readback = await this._request(
              "GET",
              `/documents/${encodeURIComponent(did)}`,
              null,
              undefined,
              {},
              contract.apiBasePath,
            );
            const observedName = String(readback?.body?.name || "");
            verification = {
              kind: "document_name_equals",
              verified: !!readback?.ok && observedName === expectedName,
              expectedName,
              observedName,
              readbackHttpStatus: Number(readback?.http ?? 0) || null,
            };
          }
        } else if (contract.verificationStrategy === "WORKSPACE_COPY_READBACK") {
          const newDocumentId = String(result?.body?.newDocumentId || "");
          const newWorkspaceId = String(result?.body?.newWorkspaceId || "");
          const expectedName = body && typeof body === "object" && !Array.isArray(body)
            ? String(body.newName || "")
            : "";
          if (/^[0-9a-fA-F]{24}$/.test(newDocumentId) && /^[0-9a-fA-F]{24}$/.test(newWorkspaceId)) {
            const readback = await this._request(
              "GET",
              `/documents/${encodeURIComponent(newDocumentId)}`,
              null,
              undefined,
              {},
              contract.apiBasePath,
            );
            verification = {
              kind: "workspace_copy_created",
              verified: !!readback?.ok
                && String(readback?.body?.id || "").toLowerCase() === newDocumentId.toLowerCase()
                && String(readback?.body?.defaultWorkspace?.id || "").toLowerCase() === newWorkspaceId.toLowerCase()
                && (!expectedName || String(readback?.body?.name || "") === expectedName),
              newDocumentId,
              newWorkspaceId,
              expectedName: expectedName || null,
              observedName: String(readback?.body?.name || ""),
              readbackHttpStatus: Number(readback?.http ?? 0) || null,
            };
          }
        } else if (
          contract.verificationStrategy === "PARTSTUDIO_FEATURE_PROJECTION_READBACK"
          || contract.verificationStrategy === "PARTSTUDIO_FEATURE_ADDED_READBACK"
        ) {
          const did = String(pathParams.did || "");
          const wid = String(pathParams.wid || (String(pathParams.wvm || "w") === "w" ? pathParams.wvmid || "" : ""));
          const eid = String(pathParams.eid || "");
          let fid = contract.verificationStrategy === "PARTSTUDIO_FEATURE_PROJECTION_READBACK"
            ? String(pathParams.fid || "")
            : String(this._featureId(result?.body) || "");
          const expected = body?.feature;
          if (
            /^[0-9a-fA-F]{24}$/.test(did)
            && /^[0-9a-fA-F]{24}$/.test(wid)
            && /^[0-9a-fA-F]{24}$/.test(eid)
            && fid
            && expected && typeof expected === "object"
          ) {
            const readback = await this._readPartStudioFeature(
              did, wid, eid, fid, contract.apiBasePath,
            );
            const candidates = [
              readback.feature,
              readback.feature?.feature,
              readback.feature?.message,
              readback.feature?.feature?.message,
            ].filter((value) => value && typeof value === "object");
            const expectedProjection = this._featureVerificationProjection(expected);
            const projectionVerified = candidates.some(
              (candidate) => this._projectionMatches(
                expectedProjection,
                this._featureVerificationProjection(candidate),
              ),
            );
            const featureStatus = String(readback?.featureState?.featureStatus ?? "");
            verification = {
              kind: contract.verificationStrategy === "PARTSTUDIO_FEATURE_ADDED_READBACK"
                ? "partstudio_feature_projection_added"
                : "partstudio_feature_projection_equals",
              // Verified = the feature is in the Feature List exactly as sent.
              // Regeneration status is reported separately: a red feature is a
              // legitimate result when the owner asked for incomplete inputs.
              verified: projectionVerified && Boolean(featureStatus),
              projectionVerified,
              featureStatus: featureStatus || null,
              regenerationOk: featureStatus === "OK",
              featureId: fid,
              readbackHttpStatus: readback.httpStatus,
            };
          }
        } else if (contract.verificationStrategy === "PARTSTUDIO_ROLLBACK_READBACK") {
          const did = String(pathParams.did || "");
          const wid = String(pathParams.wid || "");
          const eid = String(pathParams.eid || "");
          const expectedRollbackIndex = Number(body?.rollbackIndex);
          if (
            /^[0-9a-fA-F]{24}$/.test(did)
            && /^[0-9a-fA-F]{24}$/.test(wid)
            && /^[0-9a-fA-F]{24}$/.test(eid)
            && Number.isInteger(expectedRollbackIndex)
          ) {
            const readback = await this._request(
              "GET",
              `/partstudios/d/${encodeURIComponent(did)}/w/${encodeURIComponent(wid)}/e/${encodeURIComponent(eid)}/features`,
              null,
              undefined,
              {},
              contract.apiBasePath,
            );
            this._assertVersionedReadResponse(readback, contract.apiBasePath);
            const observedRollbackIndex = Number(readback?.body?.rollbackIndex);
            const observedFeatureCount = Array.isArray(readback?.body?.features)
              ? readback.body.features.length
              : null;
            const normalizedExpectedRollbackIndex = expectedRollbackIndex === -1
              ? observedFeatureCount
              : expectedRollbackIndex;
            verification = {
              kind: "partstudio_rollback_index_equals",
              verified: !!readback?.ok
                && Number.isInteger(normalizedExpectedRollbackIndex)
                && observedRollbackIndex === normalizedExpectedRollbackIndex,
              requestedRollbackIndex: expectedRollbackIndex,
              expectedRollbackIndex: normalizedExpectedRollbackIndex,
              observedRollbackIndex: Number.isInteger(observedRollbackIndex) ? observedRollbackIndex : null,
              observedFeatureCount,
              readbackHttpStatus: Number(readback?.http ?? 0) || null,
            };
          }
        } else if (contract.verificationStrategy === "PARTSTUDIO_FEATURE_ABSENCE_READBACK") {
          const did = String(pathParams.did || "");
          const wid = String(pathParams.wid || "");
          const eid = String(pathParams.eid || "");
          const fid = String(pathParams.fid || "");
          if (
            /^[0-9a-fA-F]{24}$/.test(did)
            && /^[0-9a-fA-F]{24}$/.test(wid)
            && /^[0-9a-fA-F]{24}$/.test(eid)
            && fid
          ) {
            const readback = await this._readPartStudioFeature(
              did, wid, eid, fid, contract.apiBasePath,
            );
            verification = {
              kind: "partstudio_feature_absent",
              verified: readback.feature == null,
              featureId: fid,
              readbackHttpStatus: readback.httpStatus,
            };
          }
        }
      } catch (error) {
        verification = {
          ...verification,
          verified: false,
          readbackError: String(error?.code || error?.name || "error"),
        };
      }
      timings.verification_ms = elapsedMs(verifyStart);
      observed = {
        requestId,
        operationId: contract.operationId,
        state: "SUCCEEDED",
        externalReference,
        detail: verification.kind === "provider_acknowledged"
          ? "Onshape provider acknowledged the write."
          : verification.verified
            ? "Onshape write completed and readback verified it."
            : "Onshape provider acknowledged the write; optional readback did not verify it.",
        evidence: {
          ...baseEvidence,
          effectSent: true,
          providerAcknowledged: true,
          postconditionVerified: verification.kind === "provider_acknowledged" ? null : verification.verified,
          verification,
        },
        timing: timings,
      };
    }

    timings.total_ms = elapsedMs(totalStart);
    observed.timing = { ...timings };
    if (claimed) {
      this._writeRecord({
        ...claimed,
        state: observed.state,
        updatedAt: new Date().toISOString(),
        observation: observed,
      });
    }
    return observed;
  }

}

export { sha256Json };