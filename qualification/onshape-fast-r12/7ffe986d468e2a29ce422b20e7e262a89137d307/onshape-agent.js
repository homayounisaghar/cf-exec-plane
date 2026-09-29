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
const HIGH_IMPACT_OPERATION_PATTERN = /(?:share|permission|public|transfer.*ownership|ownership.*transfer|invite.*(?:team|company)|(?:team|company|account).*(?:member|admin|delete|remove)|api.?key|oauth|webhook|admin(?:istration)?)/i;
const REQUEST_ID_RE = /^[A-Za-z0-9:._-]{1,160}$/;

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

function operationRiskClass({ operationId, method, pathTemplate, summary = "" }) {
  if (READ_METHODS.has(method) || READ_ONLY_POST_OPERATION_IDS.has(operationId)) return RISK_READ;
  const semanticText = [
    operationAliasKey(operationId),
    operationAliasKey(summary),
    operationAliasKey(pathTemplate),
  ].join(" ");
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
    return { httpStatus: Number(response?.http ?? 0) || null, feature: matches[0] ?? null };
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
          const wid = String(pathParams.wid || "");
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
            verification = {
              kind: contract.verificationStrategy === "PARTSTUDIO_FEATURE_ADDED_READBACK"
                ? "partstudio_feature_projection_added"
                : "partstudio_feature_projection_equals",
              verified: candidates.some((candidate) => this._projectionMatches(expected, candidate)),
              featureId: fid,
              readbackHttpStatus: readback.httpStatus,
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
