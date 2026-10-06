import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { onshapeRequest, ArtifactStore } = require("./onshape-request.cjs");

const CAD_ORIGIN = "https://cad.onshape.com";
const SIGNIN_URL = `${CAD_ORIGIN}/signin`;
const DOCUMENTS_URL = `${CAD_ORIGIN}/documents`;

const OPENAPI_HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

const GENERIC_REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const BLOCKED_GENERIC_HEADERS = new Set([
  "authorization", "cookie", "set-cookie", "host", "origin", "referer",
  "content-length", "transfer-encoding", "connection", "x-xsrf-token", "x-csrf-token",
]);

function resolveOpenApiSchema(spec, schema) {
  const ref = schema?.$ref;
  if (!ref || !String(ref).startsWith("#/components/schemas/")) return schema || {};
  const name = String(ref).split("/").pop();
  return spec?.components?.schemas?.[name] || schema || {};
}

function responseMediaTypes(operation) {
  return [...new Set(Object.values(operation?.responses || {}).flatMap((response) => Object.keys(response?.content || {})))];
}

function auditOpenApiCoverage(spec) {
  const gaps = [];
  let total = 0;
  let multipartOperations = 0;
  let binaryResponseOperations = 0;
  let optionalHeaderOperations = 0;

  for (const [path, item] of Object.entries(spec?.paths || {})) {
    if (!item || typeof item !== "object") continue;
    const pathParameters = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of OPENAPI_HTTP_METHODS) {
      const operation = item[method];
      if (!operation || typeof operation !== "object") continue;
      total += 1;
      const upper = method.toUpperCase();
      const key = `${upper} ${path}`;
      if (!GENERIC_REQUEST_METHODS.has(upper)) gaps.push({ operation: key, reason: "unsupported-http-method" });

      const parameters = [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      if (parameters.some((p) => p?.in === "header" && !p?.required)) optionalHeaderOperations += 1;
      for (const parameter of parameters) {
        const where = parameter?.in;
        const name = String(parameter?.name || "").toLowerCase();
        if (where === "cookie") gaps.push({ operation: key, reason: "cookie-parameter-not-expressible", parameter: parameter?.name ?? null });
        if (where === "query" && parameter?.schema?.type === "object") gaps.push({ operation: key, reason: "object-query-parameter-not-expressible", parameter: parameter?.name ?? null });
        if (where === "header" && parameter?.required && (BLOCKED_GENERIC_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-"))) {
          gaps.push({ operation: key, reason: "required-security-boundary-header", parameter: parameter?.name ?? null });
        }
      }

      for (const [mediaType, descriptor] of Object.entries(operation.requestBody?.content || {})) {
        const media = mediaType.toLowerCase();
        if (media.includes("json")) continue;
        if (media === "multipart/form-data") {
          multipartOperations += 1;
          const schema = resolveOpenApiSchema(spec, descriptor?.schema);
          for (const [fieldName, rawProperty] of Object.entries(schema?.properties || {})) {
            const property = resolveOpenApiSchema(spec, rawProperty);
            const isBinary = property?.type === "string" && property?.format === "binary";
            const isScalar = ["string", "boolean", "integer", "number"].includes(property?.type) && property?.format !== "binary";
            if (!isBinary && !isScalar) gaps.push({
              operation: key,
              reason: "unsupported-multipart-field-shape",
              field: fieldName,
              type: property?.type ?? null,
              format: property?.format ?? null,
            });
          }
          continue;
        }
        gaps.push({ operation: key, reason: "unsupported-request-media-type", media_type: mediaType });
      }

      const media = responseMediaTypes(operation);
      if (media.some((value) => {
        const lower = value.toLowerCase();
        return lower.includes("octet-stream") || lower.startsWith("image/") || lower.includes("gltf-binary");
      })) binaryResponseOperations += 1;
    }
  }

  const affected = new Set(gaps.map((gap) => gap.operation));
  return {
    status: gaps.length === 0 ? "FULL" : "GAPS",
    total_operations: total,
    supported_operations: total - affected.size,
    gap_count: gaps.length,
    gaps: gaps.slice(0, 100),
    multipart_operations: multipartOperations,
    binary_response_operations: binaryResponseOperations,
    optional_header_operations: optionalHeaderOperations,
    transport: {
      json_request: true,
      multipart_form_data_request: true,
      caller_headers_with_security_boundary: true,
      byte_safe_binary_response: true,
      binary_artifact_storage: "ephemeral-tmpfs",
      artifact_chunk_bytes: 393216,
    },
  };
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

function validateOpenApiSpec(spec) {
  return !!(
    spec &&
    typeof spec === "object" &&
    typeof spec.openapi === "string" &&
    spec.info &&
    typeof spec.info === "object" &&
    typeof spec.info.version === "string" &&
    spec.paths &&
    typeof spec.paths === "object" &&
    !Array.isArray(spec.paths)
  );
}

function openApiOperationMap(spec) {
  const operations = new Map();
  for (const [path, item] of Object.entries(spec?.paths || {})) {
    if (!item || typeof item !== "object") continue;
    for (const method of OPENAPI_HTTP_METHODS) {
      const operation = item[method];
      if (!operation || typeof operation !== "object") continue;
      const key = `${method.toUpperCase()} ${path}`;
      operations.set(key, {
        operationId: operation.operationId || null,
        hash: sha256Json(operation),
      });
    }
  }
  return operations;
}

function diffOpenApi(previous, current) {
  const before = openApiOperationMap(previous || {});
  const after = openApiOperationMap(current || {});
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, value] of after.entries()) {
    const old = before.get(key);
    if (!old) {
      added.push({ operation: key, operationId: value.operationId });
    } else if (old.hash !== value.hash) {
      changed.push({
        operation: key,
        operationId: value.operationId,
        previous_hash: old.hash,
        current_hash: value.hash,
      });
    }
  }
  for (const [key, value] of before.entries()) {
    if (!after.has(key)) removed.push({ operation: key, operationId: value.operationId });
  }

  added.sort((a, b) => a.operation.localeCompare(b.operation));
  removed.sort((a, b) => a.operation.localeCompare(b.operation));
  changed.sort((a, b) => a.operation.localeCompare(b.operation));

  const limit = 200;
  return {
    previous_path_count: Object.keys(previous?.paths || {}).length,
    current_path_count: Object.keys(current?.paths || {}).length,
    previous_operation_count: before.size,
    current_operation_count: after.size,
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length,
    added: added.slice(0, limit),
    removed: removed.slice(0, limit),
    changed: changed.slice(0, limit),
    diff_truncated: added.length > limit || removed.length > limit || changed.length > limit,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statMode(path) {
  const st = fs.statSync(path);
  return { uid: st.uid, gid: st.gid, mode: st.mode & 0o777, size: st.size };
}

function assertRootFile(path) {
  const st = statMode(path);
  if (st.uid !== 0 || st.gid !== 0 || st.mode !== 0o600) {
    throw new Error(`unsafe file permissions: ${path}`);
  }
  return st;
}

function firstVisible(page, selectors) {
  return (async () => {
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      try {
        if (await loc.isVisible({ timeout: 250 })) return loc;
      } catch {}
    }
    return null;
  })();
}

export class BrowserSession {
  constructor({ profileDir, accountFile, passwordFile, buildId, companyOwnerId, antiForgeryHeaderName, uiApiVersion, openApiFile, navigationGate = null, apiScheduler = null }) {
    this.profileDir = profileDir;
    this.buildId = buildId || "unknown";
    this.companyOwnerId = String(companyOwnerId || "").trim();
    this.antiForgeryHeaderName = String(antiForgeryHeaderName || "").trim().toLowerCase();
    this.uiApiVersion = String(uiApiVersion || "").trim();
    this.openApiFile = String(openApiFile || "").trim();
    this.accountFile = accountFile;
    this.passwordFile = passwordFile;
    this.navigationGate = navigationGate;
    this.apiScheduler = apiScheduler;
    this.context = null;
    this.page = null;
    this.lastError = null;
    this.lastProvenAuth = null;
    this.lastProvenAuthAt = 0;
    this.authCacheMs = 120_000;
    this.workSession = {
      generation: 0,
      target: null,
      last_navigation_at: null,
      last_navigation_reason: null,
      last_continuity_break: null,
      current_selection: [],
      last_camera: null,
    };
    this.authRecovery = null;
    this.viewerRuntimeCache = null;
    this.artifactStore = new ArtifactStore("/tmp/onshape-artifacts");
  }

  requestContext(overrides = {}) {
    return {
      build: this.buildId,
      antiForgeryHeaderName: this.antiForgeryHeaderName,
      artifactStore: this.artifactStore,
      apiScheduler: this.apiScheduler,
      ...overrides,
    };
  }

  async createUiPageSession() {
    await this.ensureBrowser();
    const page = await this.context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(45_000);
    await page.goto(DOCUMENTS_URL, { waitUntil: "domcontentloaded" });
    const bound = Object.create(Object.getPrototypeOf(this));
    Object.assign(bound, this);
    bound.page = page;
    bound.uiPageBound = true;
    bound.viewerRuntimeCache = null;
    bound.workSession = {
      generation: 0,
      target: null,
      last_navigation_at: null,
      last_navigation_reason: null,
      last_continuity_break: null,
      current_selection: [],
      last_camera: null,
    };
    bound.ensureBrowser = async () => {
      if (!bound.context || bound.context !== this.context || page.isClosed()) {
        const error = new Error("UI page lease is no longer attached to the active browser context.");
        error.code = "UI_LEASE_PAGE_CLOSED";
        throw error;
      }
    };
    bound.close = async () => {
      await bound._disposeViewerRuntimeCache().catch(() => {});
      if (!page.isClosed()) await page.close();
    };
    return bound;
  }

  async sessionFingerprint() {
    await this.ensureBrowser();
    const cookies = await this.context.cookies(CAD_ORIGIN);
    const material = cookies
      .filter((cookie) => String(cookie.domain || "").includes("onshape.com"))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
      }))
      .sort((a, b) => `${a.domain}\n${a.path}\n${a.name}`.localeCompare(`${b.domain}\n${b.path}\n${b.name}`))
      .map((cookie) => `${cookie.domain}\n${cookie.path}\n${cookie.name}=${cookie.value}`)
      .join("\n");
    if (!material) return null;
    return createHash("sha256").update(material).digest("hex").slice(0, 24);
  }

  credentialsProvisioned() {
    const a = assertRootFile(this.accountFile);
    const p = assertRootFile(this.passwordFile);
    return a.size > 0 && p.size > 0;
  }

  credentialState() {
    const a = assertRootFile(this.accountFile);
    const p = assertRootFile(this.passwordFile);
    if (a.size === 0 && p.size === 0) return "EMPTY";
    if (a.size > 0 && p.size > 0) return "PROVISIONED";
    return "INCONSISTENT";
  }

  installCredentials(account, password) {
    const state = this.credentialState();
    if (state !== "EMPTY") {
      const error = new Error("Credentials are already provisioned or inconsistent; refusing overwrite.");
      error.code = "CREDENTIALS_ALREADY_PROVISIONED";
      throw error;
    }
    const normalized = String(account ?? "").trim();
    const secret = String(password ?? "");
    if (!normalized || normalized.length > 320 || /[\r\n\0]/.test(normalized)) {
      const error = new Error("Invalid Onshape account identifier.");
      error.code = "INVALID_ACCOUNT";
      throw error;
    }
    if (secret.length < 8 || secret.length > 1024 || /[\r\n\0]/.test(secret)) {
      const error = new Error("Invalid Onshape password length or characters.");
      error.code = "INVALID_PASSWORD";
      throw error;
    }
    fs.writeFileSync(this.accountFile, normalized, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(this.passwordFile, secret, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(this.accountFile, 0o600);
    fs.chmodSync(this.passwordFile, 0o600);
    assertRootFile(this.accountFile);
    assertRootFile(this.passwordFile);
    return { provisioned: true };
  }

  readCredentials() {
    if (!this.credentialsProvisioned()) {
      const error = new Error("Onshape credentials are not provisioned.");
      error.code = "CREDENTIALS_REQUIRED";
      throw error;
    }
    return {
      account: fs.readFileSync(this.accountFile, "utf8"),
      password: fs.readFileSync(this.passwordFile, "utf8"),
    };
  }

  async close() {
    await this._disposeViewerRuntimeCache();
    const context = this.context;
    this.page = null;
    this.context = null;
    if (context) {
      try {
        await context.close();
      } catch (error) {
        this.lastError = error?.name ? `browser-close-${error.name}` : "browser-close-error";
      }
    }
  }

  async ensureBrowser() {
    if (this.context && this.page && !this.page.isClosed()) return;
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      chromiumSandbox: false,
      viewport: { width: 1440, height: 1000 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const pages = this.context.pages();
    this.page = pages[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(10_000);
    this.page.setDefaultNavigationTimeout(45_000);
    if (this.page.url() === "about:blank") {
      await this.page.goto(DOCUMENTS_URL, { waitUntil: "domcontentloaded" }).catch((e) => {
        this.lastError = e?.name || "navigation-error";
      });
    }
  }

  _targetDescriptor(documentId, workspaceId, elementId) {
    return {
      document_id: String(documentId || "").trim(),
      workspace_id: String(workspaceId || "").trim(),
      element_id: String(elementId || "").trim(),
    };
  }

  _targetUrl(target) {
    return `${CAD_ORIGIN}/documents/${target.document_id}/w/${target.workspace_id}/e/${target.element_id}`;
  }

  _sameTarget(a, b) {
    return !!a && !!b
      && a.document_id === b.document_id
      && a.workspace_id === b.workspace_id
      && a.element_id === b.element_id;
  }

  workSessionStatus() {
    const currentUrl = this.page && !this.page.isClosed() ? this.page.url() : null;
    const target = this.workSession?.target ? { ...this.workSession.target } : null;
    const expectedUrl = target ? this._targetUrl(target) : null;
    return {
      generation: Number(this.workSession?.generation || 0),
      target,
      current_url: currentUrl,
      target_route_active: !!(expectedUrl && currentUrl && currentUrl.startsWith(expectedUrl)),
      last_navigation_at: this.workSession?.last_navigation_at || null,
      last_navigation_reason: this.workSession?.last_navigation_reason || null,
      last_continuity_break: this.workSession?.last_continuity_break || null,
      current_selection: Array.isArray(this.workSession?.current_selection)
        ? this.workSession.current_selection.map((item) => ({ ...item }))
        : [],
      auth_recovery_active: !!this.authRecovery,
    };
  }

  async loginPreservingWorkPage(progress) {
    await this.ensureBrowser();
    if (this.authRecovery?.bound && this.authRecovery?.page && !this.authRecovery.page.isClosed()) {
      const error = new Error("An Onshape authentication recovery is already active.");
      error.code = "REAUTH_ALREADY_ACTIVE";
      throw error;
    }
    const page = await this.context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(45_000);
    const bound = Object.create(Object.getPrototypeOf(this));
    Object.assign(bound, this);
    bound.page = page;
    bound.uiPageBound = true;
    bound.authRecovery = null;
    bound.viewerRuntimeCache = null;
    bound.workSession = {
      generation: 0,
      target: null,
      last_navigation_at: null,
      last_navigation_reason: null,
      last_continuity_break: null,
      current_selection: [],
      last_camera: null,
    };
    bound.ensureBrowser = async () => {
      if (!bound.context || bound.context !== this.context || page.isClosed()) {
        const error = new Error("Authentication recovery page is no longer attached.");
        error.code = "AUTH_RECOVERY_PAGE_CLOSED";
        throw error;
      }
    };
    this.authRecovery = { page, bound, started_at: new Date().toISOString() };
    try {
      const result = await bound.login(progress);
      if (!result) return null;
      if (result?.auth?.state === "PROVEN") {
        this.lastProvenAuth = { ...result.auth };
        this.lastProvenAuthAt = Date.now();
        this.lastError = null;
      }
      await page.close().catch(() => {});
      this.authRecovery = null;
      return {
        ...result,
        work_page_preserved: true,
        work_session: this.workSessionStatus(),
      };
    } catch (error) {
      await page.close().catch(() => {});
      this.authRecovery = null;
      throw error;
    }
  }

  async submitVerificationPreservingWorkPage(code) {
    const recovery = this.authRecovery;
    if (!recovery?.bound || !recovery?.page || recovery.page.isClosed()) {
      const error = new Error("No authentication recovery page is awaiting verification.");
      error.code = "NO_AUTH_RECOVERY_PAGE";
      throw error;
    }
    try {
      const result = await recovery.bound.submitVerification(code);
      if (result?.auth?.state === "PROVEN") {
        this.lastProvenAuth = { ...result.auth };
        this.lastProvenAuthAt = Date.now();
        this.lastError = null;
      }
      await recovery.page.close().catch(() => {});
      this.authRecovery = null;
      return {
        ...result,
        work_page_preserved: true,
        work_session: this.workSessionStatus(),
      };
    } catch (error) {
      if (!recovery.page.isClosed()) await recovery.page.close().catch(() => {});
      this.authRecovery = null;
      throw error;
    }
  }

  async _disposeViewerRuntimeCache() {
    const cache = this.viewerRuntimeCache;
    this.viewerRuntimeCache = null;
    if (!cache) return;
    try {
      if (cache.cdp && cache.objectGroup) {
        await cache.cdp.send("Runtime.releaseObjectGroup", { objectGroup: cache.objectGroup }).catch(() => {});
      }
    } finally {
      if (cache.cdp) await cache.cdp.detach().catch(() => {});
    }
  }

  async _viewerRuntimeObjects() {
    await this.ensureBrowser();
    const started = performance.now();
    const generation = Number(this.workSession?.generation || 0);
    const cached = this.viewerRuntimeCache;
    if (cached
      && cached.page === this.page
      && cached.generation === generation
      && cached.cdp
      && cached.objectsId) {
      try {
        const live = await cached.cdp.send("Runtime.callFunctionOn", {
          objectId: cached.objectsId,
          functionDeclaration: "function(){return Number(this.length)||0}",
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        });
        const count = Number(live?.result?.value || 0);
        if (count > 0) {
          return {
            cdp: cached.cdp,
            objectsId: cached.objectsId,
            objectGroup: cached.objectGroup,
            acquisition_ms: Math.round((performance.now() - started) * 10) / 10,
            cache_hit: true,
            instance_count: count,
          };
        }
      } catch {}
      await this._disposeViewerRuntimeCache();
    }

    const objectGroup = `cf-viewer-cache-${process.pid}-${generation}-${Date.now()}`;
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      await cdp.send("Runtime.enable");
      const proto = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const chunks = window.webpackChunkNewton;
          if (!Array.isArray(chunks)) return null;
          let req = null;
          const before = chunks.length;
          const chunkId = -Date.now();
          chunks.push([[chunkId], {}, (runtime) => { req = runtime; }]);
          if (chunks.length > before) chunks.splice(before);
          if (typeof req !== "function") return null;
          const Viewer = req(74266)?.jM;
          if (typeof Viewer !== "function" || !Viewer.prototype
            || typeof Viewer.prototype.pickInRect !== "function"
            || typeof Viewer.prototype.getViewData !== "function"
            || typeof Viewer.prototype.getCamera !== "function") return null;
          return Viewer.prototype;
        })()`,
        objectGroup,
        includeCommandLineAPI: false,
        silent: true,
        returnByValue: false,
        awaitPromise: false,
      });
      const prototypeObjectId = proto?.result?.objectId;
      if (!prototypeObjectId) {
        const error = new Error("The precompiled Onshape Viewer runtime contract did not pass its method self-test.");
        error.code = "VIEWER_RUNTIME_SELF_TEST_FAILED";
        throw error;
      }
      const queried = await cdp.send("Runtime.queryObjects", { prototypeObjectId, objectGroup });
      const objectsId = queried?.objects?.objectId;
      if (!objectsId) {
        const error = new Error("No live Onshape Viewer object collection was returned.");
        error.code = "VIEWER_RUNTIME_INSTANCE_QUERY_FAILED";
        throw error;
      }
      this.viewerRuntimeCache = {
        page: this.page,
        generation,
        cdp,
        objectGroup,
        objectsId,
        created_at: new Date().toISOString(),
      };
      return {
        cdp,
        objectsId,
        objectGroup,
        acquisition_ms: Math.round((performance.now() - started) * 10) / 10,
        cache_hit: false,
        instance_count: null,
      };
    } catch (error) {
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
      await cdp.detach().catch(() => {});
      throw error;
    }
  }

  async proveAuthentication({ schedulerMaintenance = false, force = true } = {}) {
    await this.ensureBrowser();
    if (
      force !== true
      && this.lastProvenAuth?.state === "PROVEN"
      && Date.now() - this.lastProvenAuthAt <= this.authCacheMs
    ) {
      return { ...this.lastProvenAuth, cached: true };
    }
    const pageUrl = this.page && !this.page.isClosed() ? this.page.url() : null;
    let pageOrigin = null;
    try { pageOrigin = pageUrl ? new URL(pageUrl).origin : null; } catch {}
    const base = {
      state: "UNKNOWN",
      account_id: null,
      request_origin: pageOrigin,
      http_status: null,
      service_build_id: this.buildId,
    };
    if (pageOrigin !== CAD_ORIGIN) {
      this.lastProvenAuth = null;
      this.lastProvenAuthAt = 0;
      this.lastError = "auth-probe-origin-mismatch";
      return base;
    }
    try {
      const probe = await onshapeRequest(
        this.page,
        { method: "GET", path: "/api/users/current" },
        this.requestContext({
          apiRequestKind: "auth-probe",
          apiSchedulerMaintenance: schedulerMaintenance === true,
        }),
      );
      const parsed = probe && typeof probe.body === "object" && probe.body !== null ? probe.body : null;
      const accountId = parsed?.id ?? parsed?.userId ?? parsed?.user?.id ?? parsed?.user?.userId ?? parsed?.currentUser?.id ?? null;
      const status = Number.isFinite(probe?.http) ? probe.http : null;
      let state = "UNKNOWN";
      if (status === 401 || status === 403) state = "REJECTED";
      else if (probe?.ok && accountId) state = "PROVEN";

      if (state === "PROVEN") {
        if (this.lastError && /^auth-probe-/.test(this.lastError)) this.lastError = null;
      } else if (state === "REJECTED") {
        this.lastError = `auth-probe-http-${status}`;
      } else if (status != null && status >= 200 && status < 300) {
        this.lastError = "auth-probe-identity-missing";
      } else {
        this.lastError = status == null ? "auth-probe-unknown" : `auth-probe-http-${status}`;
      }
      const authResult = {
        state,
        account_id: accountId ? String(accountId).slice(0, 200) : null,
        request_origin: probe?.issuedFrom || pageOrigin,
        http_status: status,
        service_build_id: this.buildId,
      };
      if (state === "PROVEN") {
        this.lastProvenAuth = authResult;
        this.lastProvenAuthAt = Date.now();
      } else {
        this.lastProvenAuth = null;
        this.lastProvenAuthAt = 0;
      }
      return authResult;
    } catch (e) {
      this.lastProvenAuth = null;
      this.lastProvenAuthAt = 0;
      this.lastError = e?.name ? `auth-probe-${e.name}` : "auth-probe-error";
      return base;
    }
  }

  async status() {
    const browserStarted = !!this.context && !!this.page && !this.page.isClosed();
    let url = browserStarted ? this.page.url() : null;
    let auth = {
      state: "UNKNOWN",
      account_id: null,
      request_origin: null,
      http_status: null,
      service_build_id: this.buildId,
    };
    if (browserStarted) {
      auth = await this.proveAuthentication();
      url = this.page && !this.page.isClosed() ? this.page.url() : url;
    }
    const currentUrlKind = url
      ? (url.includes("/signin")
          ? "SIGNIN"
          : /\/documents\/[0-9a-fA-F]{24}\/(?:w|v|m)\/[0-9a-fA-F]{24}\/e\/[0-9a-fA-F]{24}/.test(url)
            ? "DOCUMENT"
            : url.includes("/documents") ? "DOCUMENTS" : "OTHER")
      : "NONE";
    let login_ui = null;
    if (browserStarted && currentUrlKind === "SIGNIN") {
      login_ui = await this.page.evaluate(() => {
        const visible = (el) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
        };
        const inputs = Array.from(document.querySelectorAll("input")).filter(visible).slice(0, 20).map((el) => ({
          type: el.getAttribute("type") || "text",
          name: el.getAttribute("name"),
          id: el.id || null,
          autocomplete: el.getAttribute("autocomplete"),
          placeholder: el.getAttribute("placeholder"),
          aria_label: el.getAttribute("aria-label"),
          disabled: !!el.disabled,
          readonly: !!el.readOnly,
          value_length: String(el.value || "").length,
        }));
        const buttons = Array.from(document.querySelectorAll("button,input[type=submit]")).filter(visible).slice(0, 20).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120),
          id: el.id || null,
          class_name: String(el.className || "").slice(0, 160),
          disabled: !!el.disabled,
        }));
        return { title: document.title, inputs, buttons };
      }).catch(() => null);
      if (login_ui) {
        login_ui.frames = this.page.frames().slice(0, 20).map((frame) => {
          try {
            const u = new URL(frame.url());
            return { origin: u.origin, pathname: u.pathname };
          } catch {
            return { origin: null, pathname: null };
          }
        });
      }
    }
    return {
      browser_started: browserStarted,
      credential_state: this.credentialState(),
      auth,
      current_url_kind: currentUrlKind,
      login_ui,
      last_error: this.lastError,
      work_session: this.workSessionStatus(),
    };
  }

  async openDocument(documentId, workspaceId, elementId) {
    const started = performance.now();
    const target = this._targetDescriptor(documentId, workspaceId, elementId);
    const { document_id: did, workspace_id: wid, element_id: eid } = target;
    for (const [label, value] of [["document_id", did], ["workspace_id", wid], ["element_id", eid]]) {
      if (!/^[0-9a-fA-F]{24}$/.test(value)) {
        const error = new Error(`Invalid ${label}.`);
        error.code = "INVALID_DOCUMENT_ROUTE";
        throw error;
      }
    }

    const ensureStarted = performance.now();
    await this.ensureBrowser();
    const ensureBrowserMs = performance.now() - ensureStarted;

    const authStarted = performance.now();
    const auth = await this.proveAuthentication({ force: false });
    const authMs = performance.now() - authStarted;
    if (auth.state !== "PROVEN") {
      const error = new Error(`Onshape authentication state is ${auth.state}.`);
      error.code = auth.state === "REJECTED" ? "SESSION_REJECTED" : "SESSION_UNKNOWN";
      error.auth = auth;
      throw error;
    }

    const expectedUrl = this._targetUrl(target);
    const beforeUrl = this.page.url();
    const alreadyOnTarget = beforeUrl === expectedUrl
      || beforeUrl.startsWith(expectedUrl + "?")
      || beforeUrl.startsWith(expectedUrl + "#");
    const priorTarget = this.workSession?.target ? { ...this.workSession.target } : null;
    const continuityBreak = !alreadyOnTarget
      && Number(this.workSession?.generation || 0) > 0
      && this._sameTarget(priorTarget, target);
    let navigationMs = 0;
    let navigated = false;

    if (!alreadyOnTarget) {
      const releaseNavigation = this.navigationGate && typeof this.navigationGate.acquire === "function"
        ? await this.navigationGate.acquire()
        : null;
      try {
        const currentBeforeNavigation = this.page.url();
        const becameCurrent = currentBeforeNavigation === expectedUrl
          || currentBeforeNavigation.startsWith(expectedUrl + "?")
          || currentBeforeNavigation.startsWith(expectedUrl + "#");
        if (!becameCurrent) {
          const navigationStarted = performance.now();
          await this._disposeViewerRuntimeCache();
          await this.page.goto(expectedUrl, { waitUntil: "domcontentloaded" });
          await this.waitForSettled(300);
          navigationMs = performance.now() - navigationStarted;
          navigated = true;
        }
      } finally {
        if (releaseNavigation) releaseNavigation();
      }
    }

    const currentUrl = this.page.url();
    if (!currentUrl.startsWith(expectedUrl)) {
      const error = new Error("Onshape browser did not remain on the requested document route.");
      error.code = "DOCUMENT_NAVIGATION_MISMATCH";
      throw error;
    }

    if (!this._sameTarget(this.workSession.target, target) || navigated || this.workSession.generation === 0) {
      this.workSession.generation += 1;
      this.workSession.target = { ...target };
      this.workSession.last_navigation_at = new Date().toISOString();
      this.workSession.last_navigation_reason = continuityBreak
        ? "CONTINUITY_RECOVERY"
        : (priorTarget ? "TARGET_CHANGE" : "INITIAL_TARGET");
      this.workSession.current_selection = [];
      this.workSession.last_camera = null;
    }
    if (continuityBreak) {
      this.workSession.last_continuity_break = {
        detected_at: new Date().toISOString(),
        generation: this.workSession.generation,
        prior_url: beforeUrl,
        restored_url: currentUrl,
        target: { ...target },
      };
    }

    return {
      document_id: did,
      workspace_id: wid,
      element_id: eid,
      url: currentUrl,
      title: await this.page.title().catch(() => null),
      continuity: {
        generation: this.workSession.generation,
        reused: alreadyOnTarget && !navigated,
        navigated,
        break_detected: continuityBreak,
        break: continuityBreak ? this.workSession.last_continuity_break : null,
      },
      timing: {
        ensure_browser_ms: Math.round(ensureBrowserMs * 10) / 10,
        auth_ms: Math.round(authMs * 10) / 10,
        navigation_ms: Math.round(navigationMs * 10) / 10,
        total_ms: Math.round((performance.now() - started) * 10) / 10,
      },
    };
  }

  async assertUiInputHygiene(documentId, workspaceId, elementId, expectedPageCount = null) {
    await this.ensureBrowser();
    const did = String(documentId || "").trim();
    const wid = String(workspaceId || "").trim();
    const eid = String(elementId || "").trim();
    const expectedPrefix = `${CAD_ORIGIN}/documents/${did}/w/${wid}/e/${eid}`;

    const pages = this.context.pages().filter((page) => !page.isClosed());
    if (!this.uiPageBound && expectedPageCount != null && pages.length !== expectedPageCount) {
      const error = new Error("Onshape UI page count changed during input sequence.");
      error.code = "UI_INPUT_POPUP_OR_PAGE_CHANGE";
      throw error;
    }
    if (!this.page || this.page.isClosed() || !pages.includes(this.page)) {
      const error = new Error("UI input page is not attached to the active authenticated context.");
      error.code = "UI_INPUT_PAGE_DETACHED";
      throw error;
    }

    const url = this.page.url();
    let origin = null;
    try { origin = new URL(url).origin; } catch {}
    if (origin !== CAD_ORIGIN || !url.startsWith(expectedPrefix)) {
      const error = new Error("UI input target origin or document route changed.");
      error.code = "UI_INPUT_TARGET_DRIFT";
      throw error;
    }

    const auth = await this.proveAuthentication({ force: false });
    if (auth.state !== "PROVEN" || auth.request_origin !== CAD_ORIGIN) {
      const error = new Error("UI input requires PROVEN same-origin Onshape authentication.");
      error.code = "UI_INPUT_AUTH_NOT_PROVEN";
      error.auth = auth;
      throw error;
    }

    return {
      page_count: pages.length,
      origin,
      url,
      auth_state: auth.state,
      request_origin: auth.request_origin,
    };
  }

  async inputSequence(documentId, workspaceId, elementId, steps) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 80) {
      const error = new Error("Input sequence must contain 1 to 80 steps.");
      error.code = "INVALID_UI_INPUT_SEQUENCE";
      throw error;
    }

    const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
    const finite = (value) => typeof value === "number" && Number.isFinite(value);
    const intIn = (value, min, max, fallback) => {
      if (value == null) return fallback;
      if (!Number.isInteger(value) || value < min || value > max) throw new Error("Input step integer option is out of bounds.");
      return value;
    };
    const numberIn = (value, min, max, fallback) => {
      if (value == null) return fallback;
      if (!finite(value) || value < min || value > max) throw new Error("Input step numeric option is out of bounds.");
      return value;
    };
    const textIn = (value, label, max, allowEmpty = false) => {
      if (typeof value !== "string" || (!allowEmpty && !value.length) || value.length > max || /\0/.test(value)) {
        throw new Error(`Invalid ${label}.`);
      }
      return value;
    };
    const buttonIn = (value) => {
      const button = value == null ? "left" : String(value);
      if (!["left", "right", "middle"].includes(button)) throw new Error("Mouse button must be left, right, or middle.");
      return button;
    };
    const positionIn = (value) => {
      if (value == null) return undefined;
      if (!plain(value)) throw new Error("position must be an object.");
      return {
        x: numberIn(value.x, 0, 10000, 0),
        y: numberIn(value.y, 0, 10000, 0),
      };
    };
    const actionNames = new Set([
      "keyboard.down", "keyboard.up", "keyboard.press", "keyboard.type", "keyboard.insert_text",
      "mouse.move", "mouse.down", "mouse.up", "mouse.click", "mouse.dblclick", "mouse.wheel",
      "locator.hover", "locator.click", "locator.dblclick", "locator.press",
      "locator.press_sequentially", "locator.fill", "locator.drag_to",
    ]);

    const normalized = steps.map((raw, index) => {
      if (!plain(raw)) throw new Error(`Input step ${index} must be an object.`);
      const action = textIn(raw.action, `steps[${index}].action`, 80);
      if (!actionNames.has(action)) throw new Error(`Unsupported input action: ${action}`);
      const step = { action, after_ms: intIn(raw.after_ms, 0, 2000, 0) };

      if (action.startsWith("keyboard.")) {
        if (action === "keyboard.type" || action === "keyboard.insert_text") {
          step.text = textIn(raw.text, `steps[${index}].text`, 4000, true);
          if (action === "keyboard.type") step.delay = intIn(raw.delay, 0, 1000, 0);
        } else {
          step.key = textIn(raw.key, `steps[${index}].key`, 120);
          if (action === "keyboard.press") step.delay = intIn(raw.delay, 0, 2000, 0);
        }
      } else if (action === "mouse.move" || action === "mouse.click" || action === "mouse.dblclick") {
        if (raw.x != null) step.x = numberIn(raw.x, 0, 10000, 0);
        if (raw.y != null) step.y = numberIn(raw.y, 0, 10000, 0);
        if (raw.x_fraction != null) step.x_fraction = numberIn(raw.x_fraction, 0, 1, 0.5);
        if (raw.y_fraction != null) step.y_fraction = numberIn(raw.y_fraction, 0, 1, 0.5);
        if (action === "mouse.move") {
          step.steps = intIn(raw.steps, 1, 100, 1);
        } else {
          step.button = buttonIn(raw.button);
          step.delay = intIn(raw.delay, 0, 2000, 0);
          if (action === "mouse.click") step.click_count = intIn(raw.click_count, 1, 5, 1);
        }
      } else if (action === "mouse.down" || action === "mouse.up") {
        step.button = buttonIn(raw.button);
        step.click_count = intIn(raw.click_count, 1, 5, 1);
      } else if (action === "mouse.wheel") {
        step.delta_x = numberIn(raw.delta_x, -10000, 10000, 0);
        step.delta_y = numberIn(raw.delta_y, -10000, 10000, 0);
      } else {
        step.selector = textIn(raw.selector, `steps[${index}].selector`, 1000);
        step.position = positionIn(raw.position);
        if (action === "locator.click" || action === "locator.dblclick") {
          step.button = buttonIn(raw.button);
          step.delay = intIn(raw.delay, 0, 2000, 0);
          if (action === "locator.click") step.click_count = intIn(raw.click_count, 1, 5, 1);
        } else if (action === "locator.press") {
          step.key = textIn(raw.key, `steps[${index}].key`, 120);
          step.delay = intIn(raw.delay, 0, 2000, 0);
        } else if (action === "locator.press_sequentially") {
          step.text = textIn(raw.text, `steps[${index}].text`, 4000, true);
          step.delay = intIn(raw.delay, 0, 1000, 0);
        } else if (action === "locator.fill") {
          step.value = textIn(raw.value, `steps[${index}].value`, 10000, true);
        } else if (action === "locator.drag_to") {
          step.target_selector = textIn(raw.target_selector, `steps[${index}].target_selector`, 1000);
          step.target_position = positionIn(raw.target_position);
        }
      }
      return step;
    });

    const opened = await this.openDocument(documentId, workspaceId, elementId);
    const hygieneBefore = await this.assertUiInputHygiene(documentId, workspaceId, elementId);
    const viewport = this.page.viewportSize() || { width: 1440, height: 1000 };
    const point = (step) => {
      const xf = finite(step.x_fraction) ? step.x_fraction : 0.5;
      const yf = finite(step.y_fraction) ? step.y_fraction : 0.5;
      const x = finite(step.x) ? step.x : Math.round((viewport.width - 1) * xf);
      const y = finite(step.y) ? step.y : Math.round((viewport.height - 1) * yf);
      return {
        x: Math.max(0, Math.min(viewport.width - 1, Math.round(x))),
        y: Math.max(0, Math.min(viewport.height - 1, Math.round(y))),
      };
    };

    const completed = [];
    for (let index = 0; index < normalized.length; index++) {
      const step = normalized[index];
      const action = step.action;
      if (action === "keyboard.down") {
        await this.page.keyboard.down(step.key);
      } else if (action === "keyboard.up") {
        await this.page.keyboard.up(step.key);
      } else if (action === "keyboard.press") {
        await this.page.keyboard.press(step.key, { delay: step.delay });
      } else if (action === "keyboard.type") {
        await this.page.keyboard.type(step.text, { delay: step.delay });
      } else if (action === "keyboard.insert_text") {
        await this.page.keyboard.insertText(step.text);
      } else if (action === "mouse.move") {
        const p = point(step);
        await this.page.mouse.move(p.x, p.y, { steps: step.steps });
      } else if (action === "mouse.down") {
        await this.page.mouse.down({ button: step.button, clickCount: step.click_count });
      } else if (action === "mouse.up") {
        await this.page.mouse.up({ button: step.button, clickCount: step.click_count });
      } else if (action === "mouse.click") {
        const p = point(step);
        await this.page.mouse.click(p.x, p.y, {
          button: step.button,
          clickCount: step.click_count,
          delay: step.delay,
        });
      } else if (action === "mouse.dblclick") {
        const p = point(step);
        await this.page.mouse.dblclick(p.x, p.y, { button: step.button, delay: step.delay });
      } else if (action === "mouse.wheel") {
        await this.page.mouse.wheel(step.delta_x, step.delta_y);
      } else {
        const locator = this.page.locator(step.selector).first();
        if (action === "locator.hover") {
          await locator.hover(step.position ? { position: step.position } : {});
        } else if (action === "locator.click") {
          const options = {
            button: step.button,
            clickCount: step.click_count,
            delay: step.delay,
          };
          if (step.position) options.position = step.position;
          await locator.click(options);
        } else if (action === "locator.dblclick") {
          const options = { button: step.button, delay: step.delay };
          if (step.position) options.position = step.position;
          await locator.dblclick(options);
        } else if (action === "locator.press") {
          await locator.press(step.key, { delay: step.delay });
        } else if (action === "locator.press_sequentially") {
          await locator.pressSequentially(step.text, { delay: step.delay });
        } else if (action === "locator.fill") {
          await locator.fill(step.value);
        } else if (action === "locator.drag_to") {
          const target = this.page.locator(step.target_selector).first();
          const options = {};
          if (step.position) options.sourcePosition = step.position;
          if (step.target_position) options.targetPosition = step.target_position;
          await locator.dragTo(target, options);
        }
      }
      completed.push({ index, action });
      if (step.after_ms) await sleep(step.after_ms);
    }

    const hygieneAfter = await this.assertUiInputHygiene(
      documentId,
      workspaceId,
      elementId,
      hygieneBefore.page_count,
    );

    return {
      ...opened,
      sequence: {
        requested_steps: normalized.length,
        completed_steps: completed.length,
        actions: completed,
      },
      hygiene: {
        before: hygieneBefore,
        after: hygieneAfter,
      },
      final_url: this.page.url(),
      title: await this.page.title().catch(() => null),
    };
  }

  async standardView({ documentId, workspaceId, elementId, view }) {
    const totalStarted = performance.now();
    const opened = await this.openDocument(documentId, workspaceId, elementId);
    if (opened?.continuity?.break_detected) {
      const error = new Error("Persistent work-page continuity broke and the target route was restored before applying the standard view.");
      error.code = "VIEW_STANDARD_NOT_VERIFIED";
      error.standard_view = {
        status: "CONTINUITY_BREAK_RESTORED_TARGET",
        continuity: opened.continuity,
      };
      throw error;
    }
    const normalized = String(view || "").trim().toLowerCase();
    if (normalized !== "top") {
      const error = new Error("Only the qualified top standard view is currently admitted.");
      error.code = "VIEW_STANDARD_UNSUPPORTED";
      throw error;
    }
    const maximumAttempts = 10;
    const retryIntervalMs = 100;
    let before = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        before = await this._inspectViewerOnCurrentPage({
          mode: "state", xFraction: null, yFraction: null,
          expectedDeterministicId: null, worldPoint: null, allowCameraFit: false,
        });
      } catch {}
      if (before?.viewer?.ready === true) break;
      if (attempt < 6) await sleep(retryIntervalMs);
    }
    const dispatchStarted = performance.now();
    await this.page.keyboard.press("Shift+5");
    const dispatchMs = performance.now() - dispatchStarted;
    let after = null;
    let shown = null;
    const verifyStarted = performance.now();
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (attempt > 1) await sleep(retryIntervalMs);
      try {
        after = await this._inspectViewerOnCurrentPage({
          mode: "state", xFraction: null, yFraction: null,
          expectedDeterministicId: null, worldPoint: null, allowCameraFit: false,
        });
      } catch {}
      shown = await this.page.locator("[data-view-shown]").first().getAttribute("data-view-shown").catch(() => null);
      if (["top", "xy"].includes(String(shown || "").trim().toLowerCase())) {
        const afterMatrix = Array.isArray(after?.view_data?.view_matrix) ? after.view_data.view_matrix : [];
        const afterViewport = Array.isArray(after?.view_data?.camera_viewport) ? after.view_data.camera_viewport : [];
        this.workSession.last_camera = {
          generation: this.workSession.generation,
          target: { ...this.workSession.target },
          view_matrix: [...afterMatrix],
          camera_viewport: [...afterViewport],
          updated_at: new Date().toISOString(),
        };
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          page_lease: "PERSISTENT_WORK_PAGE",
          continuity: opened.continuity,
          status: "VERIFIED",
          view: "top",
          route: "ONSHAPE_SHORTCUT_SHIFT_5",
          data_view_shown: shown,
          before_view_matrix: Array.isArray(before?.view_data?.view_matrix) ? before.view_data.view_matrix : [],
          after_view_matrix: afterMatrix,
          timing: {
            open_document: opened.timing || null,
            dispatch_ms: Math.round(dispatchMs * 10) / 10,
            verification_ms: Math.round((performance.now() - verifyStarted) * 10) / 10,
            total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
          },
        };
      }
    }
    const error = new Error("Top standard view shortcut did not verify.");
    error.code = "VIEW_STANDARD_NOT_VERIFIED";
    error.standard_view = {
      status: "NOT_VERIFIED",
      view: "top",
      route: "ONSHAPE_SHORTCUT_SHIFT_5",
      data_view_shown: shown,
      before_view_matrix: Array.isArray(before?.view_data?.view_matrix) ? before.view_data.view_matrix : [],
      after_view_matrix: Array.isArray(after?.view_data?.view_matrix) ? after.view_data.view_matrix : [],
      timing: {
        open_document: opened.timing || null,
        dispatch_ms: Math.round(dispatchMs * 10) / 10,
        verification_ms: Math.round((performance.now() - verifyStarted) * 10) / 10,
        total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
      },
    };
    throw error;
  }

  async currentSelection({ documentId, workspaceId, elementId }) {
    const totalStarted = performance.now();
    const opened = await this.openDocument(documentId, workspaceId, elementId);
    if (opened?.continuity?.break_detected) {
      const error = new Error("Persistent work-page continuity broke; current selection cannot be reused safely.");
      error.code = "VIEWER_SELECTION_CONTINUITY_BREAK";
      error.continuity = opened.continuity;
      throw error;
    }
    const readStarted = performance.now();
    const state = await this._inspectViewerOnCurrentPage({
      mode: "selection",
      xFraction: null,
      yFraction: null,
      expectedDeterministicId: null,
      worldPoint: null,
      allowCameraFit: false,
    });
    const selections = Array.isArray(state?.model_selection?.selections)
      ? state.model_selection.selections.map((item) => ({ ...item }))
      : [];
    this.workSession.current_selection = selections;
    return {
      document_id: String(documentId),
      workspace_id: String(workspaceId),
      element_id: String(elementId),
      page_lease: "PERSISTENT_WORK_PAGE",
      continuity: opened.continuity,
      available: state?.model_selection?.available === true,
      count: selections.length,
      selections,
      timing: {
        open_document: opened.timing || null,
        readback_ms: Math.round((performance.now() - readStarted) * 10) / 10,
        total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
      },
    };
  }

  async applyFeatureFromSelectionUi({ documentId, workspaceId, elementId, featureType, valueExpression }) {
    const totalStarted = performance.now();
    const current = await this.currentSelection({ documentId, workspaceId, elementId });
    if (!current.count) {
      const error = new Error("Native UI feature execution requires an existing persistent Viewer selection.");
      error.code = "UI_FEATURE_SELECTION_EMPTY";
      throw error;
    }
    const normalizedType = String(featureType || "").trim().toLowerCase();
    const label = normalizedType === "fillet" ? "Fillet" : normalizedType === "chamfer" ? "Chamfer" : null;
    if (!label) {
      const error = new Error("Bounded native UI feature execution currently admits only fillet and chamfer.");
      error.code = "UI_FEATURE_TYPE_UNSUPPORTED";
      throw error;
    }
    const expression = String(valueExpression || "").trim();
    if (!expression || expression.length > 120 || /[\r\n\0]/.test(expression)) {
      const error = new Error("A bounded quantity expression is required for native UI feature execution.");
      error.code = "UI_FEATURE_VALUE_INVALID";
      throw error;
    }

    const activateStarted = performance.now();
    const trigger = this.page.locator("button.command-search-trigger").first();
    if (!(await trigger.isVisible().catch(() => false))) {
      const error = new Error("The qualified Onshape command-search trigger is not visible.");
      error.code = "UI_FEATURE_COMMAND_SEARCH_UNAVAILABLE";
      throw error;
    }
    await trigger.click();
    let searchInput = null;
    for (const selector of [
      "input.command-search-input",
      ".command-search input",
      "input[placeholder*='Search tools']",
      "input[placeholder*='Search']",
    ]) {
      const candidate = this.page.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        searchInput = candidate;
        break;
      }
    }
    if (!searchInput) {
      const error = new Error("Onshape command-search input did not become visible.");
      error.code = "UI_FEATURE_COMMAND_SEARCH_INPUT_UNAVAILABLE";
      throw error;
    }
    await searchInput.fill(label);
    await sleep(60);
    await searchInput.press("Enter");
    const activationMs = performance.now() - activateStarted;

    const dialogStarted = performance.now();
    let dialog = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidates = [
        this.page.locator(".feature-dialog").filter({ hasText: label }).last(),
        this.page.locator("[role='dialog']").filter({ hasText: label }).last(),
        this.page.locator(".dialog-content").filter({ hasText: label }).last(),
      ];
      for (const candidate of candidates) {
        if (await candidate.isVisible().catch(() => false)) {
          dialog = candidate;
          break;
        }
      }
      if (dialog) break;
      await sleep(60);
    }
    if (!dialog) {
      const error = new Error(`${label} command did not open a bounded feature dialog.`);
      error.code = "UI_FEATURE_DIALOG_UNAVAILABLE";
      throw error;
    }
    const dialogReadyMs = performance.now() - dialogStarted;

    const inputStarted = performance.now();
    const fieldLocator = dialog.locator("input, textarea, [contenteditable='true']");
    let inputCount = 0;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      inputCount = await fieldLocator.count();
      if (inputCount > 0) break;
      await sleep(60);
    }
    let valueInput = null;
    let bestScore = -Infinity;
    const fieldDiagnostics = [];
    for (let index = 0; index < Math.min(inputCount, 24); index += 1) {
      const candidate = fieldLocator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const attrs = {
        name: await candidate.getAttribute("name").catch(() => null),
        placeholder: await candidate.getAttribute("placeholder").catch(() => null),
        aria: await candidate.getAttribute("aria-label").catch(() => null),
        title: await candidate.getAttribute("title").catch(() => null),
        type: await candidate.getAttribute("type").catch(() => null),
      };
      const parentText = await candidate.locator("xpath=..").innerText().catch(() => "");
      const text = [attrs.name, attrs.placeholder, attrs.aria, attrs.title, parentText].filter(Boolean).join(" ");
      let score = 0;
      if (normalizedType === "fillet" && /radius|fillet/i.test(text)) score += 100;
      if (normalizedType === "chamfer" && /width|distance|chamfer/i.test(text)) score += 100;
      if (/radius|width|distance|size/i.test(text)) score += 30;
      if (/search|filter|name/i.test(text)) score -= 80;
      if (String(attrs.type || "").toLowerCase() === "text" || !attrs.type) score += 10;
      fieldDiagnostics.push({ index, score, text: text.slice(0, 240) });
      if (score > bestScore) {
        bestScore = score;
        valueInput = candidate;
      }
    }
    if (!valueInput || bestScore < 0) {
      await this.page.keyboard.press("Escape").catch(() => {});
      const error = new Error(`${label} quantity input was not identified by the bounded dialog contract.`);
      error.code = "UI_FEATURE_PARAMETER_INPUT_UNAVAILABLE";
      error.field_diagnostics = fieldDiagnostics;
      throw error;
    }
    await valueInput.fill(expression);
    await valueInput.press("Enter").catch(() => {});
    const parameterInputMs = performance.now() - inputStarted;

    const commitStarted = performance.now();
    let accept = null;
    const buttonCount = await dialog.locator("button").count();
    let fallbackPrimary = null;
    for (let index = 0; index < Math.min(buttonCount, 24); index += 1) {
      const button = dialog.locator("button").nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      const text = [
        await button.innerText().catch(() => ""),
        await button.getAttribute("title").catch(() => ""),
        await button.getAttribute("aria-label").catch(() => ""),
      ].filter(Boolean).join(" ");
      const cls = String(await button.getAttribute("class").catch(() => "") || "");
      if (/accept|confirm|create|apply|ok|check/i.test(text)) {
        accept = button;
        break;
      }
      if (!fallbackPrimary && /btn-primary|primary/.test(cls) && !/cancel/i.test(text)) {
        fallbackPrimary = button;
      }
    }
    accept ||= fallbackPrimary;
    if (!accept) {
      await this.page.keyboard.press("Escape").catch(() => {});
      const error = new Error(`${label} dialog accept control was not identified.`);
      error.code = "UI_FEATURE_ACCEPT_UNAVAILABLE";
      throw error;
    }
    await accept.click();
    let closed = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!(await dialog.isVisible().catch(() => false))) {
        closed = true;
        break;
      }
      await sleep(80);
    }
    if (!closed) {
      const error = new Error(`${label} dialog did not close after commit.`);
      error.code = "UI_FEATURE_COMMIT_NOT_OBSERVED";
      throw error;
    }
    const commitMs = performance.now() - commitStarted;

    return {
      document_id: String(documentId),
      workspace_id: String(workspaceId),
      element_id: String(elementId),
      page_lease: "PERSISTENT_WORK_PAGE",
      feature_type: normalizedType,
      value_expression: expression,
      selection_before: current.selections,
      route: "BOUNDED_ONSHAPE_COMMAND_SEARCH_DIALOG",
      timing: {
        selection_readback_ms: Number(current?.timing?.total_ms || 0),
        command_activation_ms: Math.round(activationMs * 10) / 10,
        dialog_ready_ms: Math.round(dialogReadyMs * 10) / 10,
        parameter_input_ms: Math.round(parameterInputMs * 10) / 10,
        commit_ms: Math.round(commitMs * 10) / 10,
        total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
      },
    };
  }

  async fitView({ documentId, workspaceId, elementId, action }) {
    const totalStarted = performance.now();
    const opened = await this.openDocument(documentId, workspaceId, elementId);
    if (opened?.continuity?.break_detected) {
      const error = new Error("Persistent work-page continuity broke and the target route was restored before applying Fit.");
      error.code = "VIEW_FIT_NOT_VERIFIED";
      error.fit_result = {
        status: "CONTINUITY_BREAK_RESTORED_TARGET",
        continuity: opened.continuity,
      };
      throw error;
    }
    const normalized = String(action || "fit").trim().toLowerCase();
    if (!["fit", "fit_selection"].includes(normalized)) {
      const error = new Error("View fit action must be fit or fit_selection.");
      error.code = "VIEW_FIT_ACTION_INVALID";
      throw error;
    }

    const maximumAttempts = 10;
    const retryIntervalMs = 100;
    let last = null;
    const readinessStarted = performance.now();
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      last = await this._fitViewOnCurrentPage({ action: normalized });
      if (normalized === "fit_selection" && [
        "SELECTION_BOUNDS_UNAVAILABLE",
        "MULTI_SELECTION_FIT_REQUIRES_FALLBACK",
      ].includes(String(last?.status || ""))) {
        last = await this._fitSelectionCommandSearchOnCurrentPage();
      }
      if (last?.status === "VERIFIED") {
        const afterSelection = Array.isArray(last?.after_selection) ? last.after_selection : [];
        if (normalized === "fit_selection") {
          this.workSession.current_selection = afterSelection.map((item) => ({ ...item }));
        }
        this.workSession.last_camera = {
          generation: this.workSession.generation,
          target: { ...this.workSession.target },
          view_matrix: Array.isArray(last.after_view_matrix) ? [...last.after_view_matrix] : [],
          camera_viewport: Array.isArray(last.after_camera_viewport) ? [...last.after_camera_viewport] : [],
          updated_at: new Date().toISOString(),
        };
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          page_lease: "PERSISTENT_WORK_PAGE",
          continuity: opened.continuity,
          readiness: {
            attempts: attempt,
            maximum_attempts: maximumAttempts,
            retry_interval_ms: retryIntervalMs,
            elapsed_ms: Math.round((performance.now() - readinessStarted) * 10) / 10,
          },
          ...last,
          timing: {
            open_document: opened.timing || null,
            viewer_acquisition_ms: Number(last?.timing?.viewer_acquisition_ms || 0),
            dispatch_ms: Number(last?.timing?.dispatch_ms || 0),
            verification_ms: Number(last?.timing?.verification_ms || 0),
            total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
          },
        };
      }
      if (!["NOT_READY", "NO_VIEWPORT", "NO_VIEWER"].includes(String(last?.status || ""))) break;
      if (attempt < maximumAttempts) await sleep(retryIntervalMs);
    }
    const error = new Error(`View fit did not verify: ${String(last?.status || "UNKNOWN")}`);
    error.code = "VIEW_FIT_NOT_VERIFIED";
    error.fit_result = {
      ...(last || {}),
      timing: {
        open_document: opened.timing || null,
        total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
      },
    };
    throw error;
  }

  async _fitSelectionCommandSearchOnCurrentPage() {
    const totalStarted = performance.now();
    const stateArgs = {
      mode: "state",
      xFraction: null,
      yFraction: null,
      expectedDeterministicId: null,
      worldPoint: null,
      allowCameraFit: false,
    };
    const before = await this._inspectViewerOnCurrentPage(stateArgs);
    if (before?.viewer?.ready !== true) {
      return { status: "NOT_READY", action: "fit_selection", route: "ONSHAPE_COMMAND_SEARCH_ZOOM_TO_SELECTION" };
    }
    const beforeSelection = Array.isArray(before?.model_selection?.selections)
      ? before.model_selection.selections.map((item) => ({ ...item }))
      : [];
    const beforeIds = beforeSelection
      .map((item) => String(item?.deterministic_id || "").trim())
      .filter(Boolean)
      .sort();
    if (!beforeIds.length) {
      return {
        status: "NO_SELECTION",
        action: "fit_selection",
        route: "ONSHAPE_COMMAND_SEARCH_ZOOM_TO_SELECTION",
        before_selection: beforeSelection,
      };
    }
    const beforeMatrix = Array.isArray(before?.view_data?.view_matrix) ? before.view_data.view_matrix.map(Number) : [];
    const beforeViewport = Array.isArray(before?.view_data?.camera_viewport) ? before.view_data.camera_viewport.map(Number) : [];
    const delta = (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
      let max = 0;
      for (let i = 0; i < a.length; i += 1) {
        const x = Number(a[i]), y = Number(b[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        max = Math.max(max, Math.abs(x - y));
      }
      return max;
    };

    const activationStarted = performance.now();
    const trigger = this.page.locator("button.command-search-trigger").first();
    if (!(await trigger.isVisible().catch(() => false))) {
      return {
        status: "FIT_SELECTION_COMMAND_SEARCH_UNAVAILABLE",
        action: "fit_selection",
        route: "ONSHAPE_COMMAND_SEARCH_ZOOM_TO_SELECTION",
        before_selection: beforeSelection,
      };
    }
    await trigger.click();

    let searchInput = null;
    for (const selector of [
      "input.command-search-input",
      ".command-search input",
      "input[placeholder*='Search tools']",
      "input[placeholder*='Search']",
    ]) {
      const candidate = this.page.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        searchInput = candidate;
        break;
      }
    }
    if (!searchInput) {
      await this.page.keyboard.press("Escape").catch(() => {});
      return {
        status: "FIT_SELECTION_COMMAND_INPUT_UNAVAILABLE",
        action: "fit_selection",
        route: "ONSHAPE_COMMAND_SEARCH_ZOOM_TO_SELECTION",
        before_selection: beforeSelection,
      };
    }

    await searchInput.fill("Zoom to selection");
    await sleep(80);
    let dispatched = false;
    const exact = this.page.getByText("Zoom to selection", { exact: true }).last();
    if (await exact.isVisible().catch(() => false)) {
      await exact.click().catch(() => {});
      dispatched = true;
    }
    if (!dispatched) {
      await searchInput.press("Enter").catch(() => {});
      dispatched = true;
    }
    const activationMs = performance.now() - activationStarted;

    const verifyStarted = performance.now();
    let after = null;
    let changed = false;
    let selectionPreserved = false;
    let afterSelection = [];
    let matrixDelta = null;
    let viewportDelta = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      if (attempt > 1) await sleep(80);
      try {
        after = await this._inspectViewerOnCurrentPage(stateArgs);
      } catch {
        continue;
      }
      const afterMatrix = Array.isArray(after?.view_data?.view_matrix) ? after.view_data.view_matrix.map(Number) : [];
      const afterViewport = Array.isArray(after?.view_data?.camera_viewport) ? after.view_data.camera_viewport.map(Number) : [];
      matrixDelta = delta(beforeMatrix, afterMatrix);
      viewportDelta = delta(beforeViewport, afterViewport);
      changed = (Number.isFinite(matrixDelta) && matrixDelta > 1e-9)
        || (Number.isFinite(viewportDelta) && viewportDelta > 1e-9);
      afterSelection = Array.isArray(after?.model_selection?.selections)
        ? after.model_selection.selections.map((item) => ({ ...item }))
        : [];
      const afterIds = afterSelection
        .map((item) => String(item?.deterministic_id || "").trim())
        .filter(Boolean)
        .sort();
      selectionPreserved = beforeIds.length === afterIds.length
        && beforeIds.every((id, index) => id === afterIds[index]);
      if (changed && selectionPreserved) break;
    }

    if (!changed || !selectionPreserved) {
      await this.page.keyboard.press("Escape").catch(() => {});
      return {
        status: !selectionPreserved ? "SELECTION_CHANGED_DURING_FIT" : "NO_CAMERA_CHANGE",
        action: "fit_selection",
        route: "ONSHAPE_COMMAND_SEARCH_ZOOM_TO_SELECTION",
        before_selection: beforeSelection,
        after_selection: afterSelection,
        selection_preserved: selectionPreserved,
        view_matrix_max_delta: matrixDelta,
        camera_viewport_max_delta: viewportDelta,
        timing: {
          dispatch_ms: Math.round(activationMs * 10) / 10,
          verification_ms: Math.round((performance.now() - verifyStarted) * 10) / 10,
          total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
        },
      };
    }

    return {
      status: "VERIFIED",
      action: "fit_selection",
      route: "ONSHAPE_COMMAND_SEARCH_ZOOM_TO_SELECTION",
      before_view_matrix: beforeMatrix,
      after_view_matrix: Array.isArray(after?.view_data?.view_matrix) ? after.view_data.view_matrix.map(Number) : [],
      before_camera_viewport: beforeViewport,
      after_camera_viewport: Array.isArray(after?.view_data?.camera_viewport) ? after.view_data.camera_viewport.map(Number) : [],
      view_matrix_max_delta: matrixDelta,
      camera_viewport_max_delta: viewportDelta,
      camera_changed: changed,
      before_selection: beforeSelection,
      after_selection: afterSelection,
      selection_preserved: selectionPreserved,
      timing: {
        viewer_acquisition_ms: 0,
        viewer_cache_hit: false,
        dispatch_ms: Math.round(activationMs * 10) / 10,
        verification_ms: Math.round((performance.now() - verifyStarted) * 10) / 10,
        total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
      },
    };
  }

  async _fitViewOnCurrentPage({ action }) {
    const runtime = await this._viewerRuntimeObjects();
    const { cdp, objectsId, objectGroup } = runtime;
    const viewerAcquisitionMs = Number(runtime.acquisition_ms || 0);
    try {
      const fn = `async function(action, viewerAcquisitionMs, cacheHit) {
        const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
        const plainArray = (value, max = 16) => {
          if (Array.isArray(value)) return value.slice(0, max).map(Number);
          if (ArrayBuffer.isView(value)) return Array.from(value).slice(0, max).map(Number);
          return [];
        };
        const delta = (a, b) => {
          if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
          let max = 0;
          for (let i = 0; i < a.length; i++) {
            const x = Number(a[i]), y = Number(b[i]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            max = Math.max(max, Math.abs(x - y));
          }
          return max;
        };
        const selectedModels = () => {
          const chunks = window.webpackChunkNewton;
          if (!Array.isArray(chunks)) return [];
          let req = null;
          const before = chunks.length;
          const chunkId = -Date.now();
          chunks.push([[chunkId], {}, (runtime) => { req = runtime; }]);
          if (chunks.length > before) chunks.splice(before);
          if (typeof req !== "function") return [];
          const mod = safe(() => req(85367), null);
          const list = safe(() => mod?.h$?.(), null);
          return Array.isArray(list?.models) ? list.models.slice(0, 32) : [];
        };
        const serializeSelection = (models) => models.map((m) => ({
          deterministic_id: safe(() => m.getDeterministicId?.(), null),
          selection_id: safe(() => m.getIdForCollection?.(), m?.selectionId ?? null),
          name: safe(() => m.getName?.(), m?.name ?? null),
          is_body: safe(() => m.isBody?.(), null),
          is_vertex: safe(() => m.isVertex?.(), null),
          is_edge: safe(() => m.isEdge?.(), null),
          is_face: safe(() => m.isFace?.(), null),
        }));
        const readSelection = () => serializeSelection(selectedModels());

        const count = Number(this.length) || 0;
        const candidates = [];
        for (let i = 0; i < count; i++) {
          const v = this[i];
          if (!v || typeof v !== "object") continue;
          if (typeof v.getViewData !== "function" || typeof v.getCamera !== "function"
            || typeof v.animateZoomFit !== "function" || typeof v.getSelectionFitBounds !== "function") continue;
          const camera = safe(() => v.getCamera(), null);
          if (!camera) continue;
          candidates.push({
            v, index: i,
            ready: safe(() => !!v.isReadyForDrawing?.(), false),
            primary: safe(() => !!v.getIsPrimaryViewer?.(), false),
          });
        }
        const chosen = candidates.find((x) => x.ready && x.primary)
          || candidates.find((x) => x.ready)
          || candidates[candidates.length - 1];
        if (!chosen) return { status: "NO_VIEWER", instance_count: count };
        const v = chosen.v;
        if (!chosen.ready) return { status: "NOT_READY", viewer_index: chosen.index };
        const camera = safe(() => v.getCamera(), null);
        const width = safe(() => Number(camera?.getViewportWidth?.()), null);
        const height = safe(() => Number(camera?.getViewportHeight?.()), null);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
          return { status: "NO_VIEWPORT", viewer_index: chosen.index };
        }

        const fitSource = safe(() => Function.prototype.toString.call(v.animateZoomFit), "");
        const fitQualified = Number(v.animateZoomFit.length) === 1
          && fitSource.includes("resetZoomToSelectionBounds()")
          && fitSource.includes("getPrimaryViewController()?.animateZoomToFit")
          && fitSource.includes("getFitBounds()");
        if (!fitQualified) {
          return { status: "FIT_CONTRACT_MISMATCH", fit_source: fitSource.slice(0, 2400) };
        }

        const normalized = String(action || "fit").toLowerCase();
        const beforeData = safe(() => v.getViewData(), null);
        const beforeMatrix = plainArray(beforeData?.viewMatrix, 16);
        const beforeViewport = plainArray(beforeData?.cameraViewport, 4);
        const beforeModels = selectedModels();
        const beforeSelection = serializeSelection(beforeModels);
        const beforeIds = beforeSelection.map((item) => String(item?.deterministic_id || "")).filter(Boolean).sort();

        let fitArgument = false;
        let route = "VIEWER_ANIMATE_ZOOM_FIT_ALL";
        if (normalized === "fit_selection") {
          if (!beforeIds.length) {
            return {
              status: "NO_SELECTION",
              action: normalized,
              before_selection: beforeSelection,
            };
          }
          const selectionFitSource = safe(() => Function.prototype.toString.call(v.getSelectionFitBounds), "");
          const selectionFitArity = Number(v.getSelectionFitBounds.length) || 0;
          const selected = beforeModels;
          if (selected.length !== 1) {
            return {
              status: selected.length ? "MULTI_SELECTION_FIT_REQUIRES_FALLBACK" : "NO_SELECTION",
              action: normalized,
              before_selection: beforeSelection,
              selected_model_count: selected.length,
              get_selection_fit_bounds_arity: selectionFitArity,
              get_selection_fit_bounds_source: selectionFitSource.slice(0, 2400),
            };
          }
          fitArgument = safe(() => v.getSelectionFitBounds(selected[0]), null);
          if (!fitArgument) {
            return {
              status: "SELECTION_BOUNDS_UNAVAILABLE",
              action: normalized,
              before_selection: beforeSelection,
              selected_model_count: selected.length,
              get_selection_fit_bounds_arity: selectionFitArity,
              get_selection_fit_bounds_source: selectionFitSource.slice(0, 2400),
            };
          }
          route = "VIEWER_ANIMATE_ZOOM_FIT_SINGLE_SELECTION_BOUNDS";
        }

        const dispatchStarted = performance.now();
        let dispatched = false;
        try {
          v.animateZoomFit(fitArgument);
          dispatched = true;
        } catch {}
        const dispatchMs = performance.now() - dispatchStarted;
        if (!dispatched) return { status: "FIT_DISPATCH_FAILED", action: normalized, route };

        const verifyStarted = performance.now();
        let afterData = safe(() => v.getViewData(), null);
        let afterMatrix = plainArray(afterData?.viewMatrix, 16);
        let afterViewport = plainArray(afterData?.cameraViewport, 4);
        let previousMatrix = afterMatrix;
        let previousViewport = afterViewport;
        let changed = false;
        let stableSamples = 0;
        let samples = 0;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          samples += 1;
          afterData = safe(() => v.getViewData(), null);
          afterMatrix = plainArray(afterData?.viewMatrix, 16);
          afterViewport = plainArray(afterData?.cameraViewport, 4);
          const totalMatrix = delta(beforeMatrix, afterMatrix);
          const totalViewport = delta(beforeViewport, afterViewport);
          const stepMatrix = delta(previousMatrix, afterMatrix);
          const stepViewport = delta(previousViewport, afterViewport);
          changed = changed
            || (Number.isFinite(totalMatrix) && totalMatrix > 1e-9)
            || (Number.isFinite(totalViewport) && totalViewport > 1e-9);
          const stable = (!Number.isFinite(stepMatrix) || stepMatrix < 1e-7)
            && (!Number.isFinite(stepViewport) || stepViewport < 1e-7);
          stableSamples = stable ? stableSamples + 1 : 0;
          previousMatrix = afterMatrix;
          previousViewport = afterViewport;
          if (stableSamples >= 2 && (changed || attempt >= 1)) break;
        }

        const afterSelection = readSelection();
        const afterIds = afterSelection.map((item) => String(item?.deterministic_id || "")).filter(Boolean).sort();
        const selectionPreserved = beforeIds.length === afterIds.length
          && beforeIds.every((id, index) => id === afterIds[index]);
        const matrixDelta = delta(beforeMatrix, afterMatrix);
        const viewportDelta = delta(beforeViewport, afterViewport);
        const verified = normalized === "fit_selection" ? selectionPreserved : true;

        return {
          status: verified ? "VERIFIED" : "SELECTION_CHANGED_DURING_FIT",
          action: normalized,
          route,
          viewer_index: chosen.index,
          camera_width: width,
          camera_height: height,
          before_view_matrix: beforeMatrix,
          after_view_matrix: afterMatrix,
          before_camera_viewport: beforeViewport,
          after_camera_viewport: afterViewport,
          view_matrix_max_delta: matrixDelta,
          camera_viewport_max_delta: viewportDelta,
          camera_changed: changed,
          before_selection: beforeSelection,
          after_selection: afterSelection,
          selection_preserved: selectionPreserved,
          verification_samples: samples,
          fit_source: fitSource.slice(0, 2400),
          timing: {
            viewer_acquisition_ms: Number(viewerAcquisitionMs) || 0,
            viewer_cache_hit: cacheHit === true,
            dispatch_ms: Math.round(dispatchMs * 10) / 10,
            verification_ms: Math.round((performance.now() - verifyStarted) * 10) / 10,
          },
        };
      }`;

      const called = await cdp.send("Runtime.callFunctionOn", {
        objectId: objectsId,
        functionDeclaration: fn,
        arguments: [
          { value: String(action || "fit") },
          { value: Math.round(viewerAcquisitionMs * 10) / 10 },
          { value: runtime.cache_hit === true },
        ],
        objectGroup,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });
      return called?.result?.value || { status: "NO_RESULT" };
    } catch (error) {
      await this._disposeViewerRuntimeCache().catch(() => {});
      throw error;
    }
  }

  async setViewerSelection({ documentId, workspaceId, elementId, action, xFraction = null, yFraction = null, expectedDeterministicId = null }) {
    const totalStarted = performance.now();
    const opened = await this.openDocument(documentId, workspaceId, elementId);
    if (opened?.continuity?.break_detected) {
      const error = new Error("Persistent work-page continuity broke and the target route was restored before changing selection.");
      error.code = "VIEWER_SELECTION_NOT_VERIFIED";
      error.selection_result = {
        status: "CONTINUITY_BREAK_RESTORED_TARGET",
        continuity: opened.continuity,
      };
      throw error;
    }

    const normalized = String(action || "").trim().toLowerCase();
    const maximumAttempts = 8;
    const retryIntervalMs = 60;

    const readSelection = async () => {
      const state = await this._inspectViewerOnCurrentPage({
        mode: "selection",
        xFraction: null,
        yFraction: null,
        expectedDeterministicId: null,
        worldPoint: null,
        allowCameraFit: false,
      });
      const selections = Array.isArray(state?.model_selection?.selections)
        ? state.model_selection.selections.map((item) => ({ ...item }))
        : [];
      return { state, selections };
    };

    const clearNativeSelection = async (knownSelection = null) => {
      if (Array.isArray(knownSelection) && knownSelection.length === 0) {
        return {
          status: "VERIFIED",
          action: "clear",
          route: "PRE_READ_ALREADY_EMPTY",
          selected_deterministic_ids: [],
          model_selection: { available: true, count: 0, selections: [] },
        };
      }

      const reset = await this._inspectViewerOnCurrentPage({
        mode: "clear_selection",
        xFraction: null,
        yFraction: null,
        expectedDeterministicId: null,
        worldPoint: null,
        allowCameraFit: false,
      });
      if (String(reset?.selection_set?.status || "") === "VERIFIED") {
        return { ...reset.selection_set, model_selection: reset.model_selection };
      }

      // Native Escape is the lowest-cost bounded UI fallback. It is verified by
      // exact selection readback; failure simply falls through to the qualified
      // empty-viewport click route.
      await this.page.keyboard.press("Escape").catch(() => {});
      await sleep(40);
      const escaped = await readSelection();
      if (escaped.selections.length === 0) {
        return {
          status: "VERIFIED",
          action: "clear",
          route: "ONSHAPE_ESCAPE_DESELECT",
          selected_deterministic_ids: [],
          reset_status: String(reset?.selection_set?.status || "UNKNOWN"),
          model_selection: escaped.state?.model_selection || { available: true, count: 0, selections: [] },
        };
      }

      const box = await this.page.locator("#viewerdiv").boundingBox().catch(() => null);
      if (!box || !(box.width > 1) || !(box.height > 1)) {
        return {
          status: "NO_VIEWPORT",
          action: "clear",
          reset_status: String(reset?.selection_set?.status || "UNKNOWN"),
        };
      }

      const cached = this.workSession?.empty_view_point;
      const candidates = [];
      if (cached && Number.isFinite(cached.x_fraction) && Number.isFinite(cached.y_fraction)) {
        candidates.push([cached.x_fraction, cached.y_fraction, "CACHE"]);
      }
      for (const point of [
        [0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98],
        [0.50, 0.02], [0.50, 0.98], [0.02, 0.50], [0.98, 0.50],
      ]) {
        if (!candidates.some((row) => row[0] === point[0] && row[1] === point[1])) {
          candidates.push([point[0], point[1], "SCAN"]);
        }
      }

      const attempts = [];
      for (const [xf, yf, source] of candidates) {
        const probe = await this._inspectViewerOnCurrentPage({
          mode: "probe",
          xFraction: xf,
          yFraction: yf,
          expectedDeterministicId: null,
          worldPoint: null,
          allowCameraFit: false,
        });
        const picks = Array.isArray(probe?.probe?.picks) ? probe.probe.picks : [];
        const observed = picks
          .map((pick) => String(pick?.deterministic_id || "").trim())
          .filter(Boolean);
        if (picks.length !== 0) {
          attempts.push({ x_fraction: xf, y_fraction: yf, source, status: "OCCUPIED", observed_deterministic_ids: observed });
          continue;
        }
        const px = box.x + xf * (box.width - 1);
        const py = box.y + yf * (box.height - 1);
        await this.page.mouse.click(px, py, { button: "left" });
        await sleep(40);
        const post = await readSelection();
        const selectedIds = post.selections.map((item) => String(item?.deterministic_id || "")).filter(Boolean);
        attempts.push({
          x_fraction: xf,
          y_fraction: yf,
          source,
          status: selectedIds.length === 0 ? "VERIFIED" : "SELECTION_READBACK_MISMATCH",
          selected_deterministic_ids: selectedIds,
        });
        if (selectedIds.length === 0) {
          this.workSession.empty_view_point = { x_fraction: xf, y_fraction: yf };
          return {
            status: "VERIFIED",
            action: "clear",
            route: "PERSISTENT_VIEWPORT_EMPTY_CLICK",
            selected_deterministic_ids: [],
            reset_status: String(reset?.selection_set?.status || "UNKNOWN"),
            empty_click: { x_fraction: xf, y_fraction: yf, x: px, y: py },
            attempts,
            model_selection: post.state?.model_selection || { available: true, count: 0, selections: [] },
          };
        }
      }

      return {
        status: "SELECTION_READBACK_MISMATCH",
        action: "clear",
        route: "PERSISTENT_VIEWPORT_EMPTY_CLICK",
        reset_status: String(reset?.selection_set?.status || "UNKNOWN"),
        selected_deterministic_ids: escaped.selections
          .map((item) => String(item?.deterministic_id || "")).filter(Boolean),
        attempts,
      };
    };

    if (normalized === "clear") {
      const preReadStarted = performance.now();
      const pre = await readSelection();
      const preReadMs = performance.now() - preReadStarted;
      const clearStarted = performance.now();
      const cleared = await clearNativeSelection(pre.selections);
      const clearMs = performance.now() - clearStarted;
      if (String(cleared?.status || "") === "VERIFIED") {
        this.workSession.current_selection = [];
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          page_lease: "PERSISTENT_WORK_PAGE",
          continuity: opened.continuity,
          readiness: { attempts: 1, maximum_attempts: maximumAttempts, retry_interval_ms: retryIntervalMs },
          ...cleared,
          timing: {
            open_document: opened.timing || null,
            pre_read_ms: Math.round(preReadMs * 10) / 10,
            clear_ms: Math.round(clearMs * 10) / 10,
            total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
          },
        };
      }
      const error = new Error(`Viewer selection clear did not verify: ${String(cleared?.status || "UNKNOWN")}`);
      error.code = "VIEWER_SELECTION_NOT_VERIFIED";
      error.selection_result = cleared || null;
      throw error;
    }

    const probeStarted = performance.now();
    const probe = await this._inspectViewerOnCurrentPage({
      mode: "probe",
      xFraction,
      yFraction,
      expectedDeterministicId: null,
      worldPoint: null,
      allowCameraFit: false,
    });
    const probeMs = performance.now() - probeStarted;
    const ids = (Array.isArray(probe?.probe?.picks) ? probe.probe.picks : [])
      .map((pick) => String(pick?.deterministic_id || "").trim())
      .filter(Boolean);
    const unique = [...new Set(ids)];
    const explicitExpectedId = String(expectedDeterministicId || "").trim() || null;
    let deterministicId = explicitExpectedId || (unique.length === 1 ? unique[0] : null);
    if (explicitExpectedId && ids.filter((id) => id === explicitExpectedId).length !== 1) {
      const error = new Error("Expected viewer target was not uniquely picked.");
      error.code = "VIEWER_SELECTION_NOT_VERIFIED";
      error.selection_result = {
        status: ids.includes(explicitExpectedId) ? "AMBIGUOUS_EXPECTED_ID" : "EXPECTED_ID_NOT_PICKED",
        action: "select",
        expected_deterministic_id: explicitExpectedId,
        observed_deterministic_ids: ids,
      };
      throw error;
    }

    const preSelections = Array.isArray(probe?.model_selection?.selections)
      ? probe.model_selection.selections.map((item) => ({ ...item }))
      : [];
    const preIds = preSelections.map((item) => String(item?.deterministic_id || "")).filter(Boolean);
    const additive = normalized === "add";
    if (deterministicId && ((additive && preIds.includes(deterministicId))
      || (!additive && preIds.length === 1 && preIds[0] === deterministicId))) {
      this.workSession.current_selection = preSelections;
      return {
        document_id: String(documentId),
        workspace_id: String(workspaceId),
        element_id: String(elementId),
        page_lease: "PERSISTENT_WORK_PAGE",
        continuity: opened.continuity,
        status: "VERIFIED",
        action: additive ? "add" : "select",
        route: "PRE_READ_ALREADY_SELECTED",
        expected_deterministic_id: deterministicId,
        observed_deterministic_ids: ids,
        selected_deterministic_ids: preIds,
        model_selection: probe.model_selection,
        timing: {
          open_document: opened.timing || null,
          probe_ms: Math.round(probeMs * 10) / 10,
          clear_ms: 0,
          click_ms: 0,
          readback_ms: 0,
          total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
        },
      };
    }

    let cleared = {
      status: "VERIFIED",
      action: "clear",
      route: "ADD_PRESERVES_EXISTING_SELECTION",
      selected_deterministic_ids: preIds,
    };
    let clearMs = 0;
    if (!additive) {
      const clearStarted = performance.now();
      cleared = await clearNativeSelection(preSelections);
      clearMs = performance.now() - clearStarted;
      if (String(cleared?.status || "") !== "VERIFIED") {
        const error = new Error("Pre-select clear did not verify.");
        error.code = "VIEWER_SELECTION_NOT_VERIFIED";
        error.selection_result = {
          status: "PRESELECT_CLEAR_NOT_VERIFIED",
          action: "select",
          expected_deterministic_id: deterministicId,
          clear_result: cleared,
        };
        throw error;
      }
    }

    const box = await this.page.locator("#viewerdiv").boundingBox().catch(() => null);
    if (!box || !(box.width > 1) || !(box.height > 1)) {
      const error = new Error("Viewer viewport is unavailable.");
      error.code = "VIEWER_SELECTION_NOT_VERIFIED";
      error.selection_result = { status: "NO_VIEWPORT", action: "select", expected_deterministic_id: deterministicId };
      throw error;
    }

    const px = box.x + Number(xFraction) * (box.width - 1);
    const py = box.y + Number(yFraction) * (box.height - 1);
    const clickStarted = performance.now();
    await this.page.mouse.click(px, py, {
      button: "left",
      ...(additive ? { modifiers: ["Shift"] } : {}),
    });
    const clickMs = performance.now() - clickStarted;

    let post = null;
    let selectedIds = [];
    const readbackStarted = performance.now();
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (attempt > 1) await sleep(retryIntervalMs);
      post = await this._inspectViewerOnCurrentPage({
        mode: "selection",
        xFraction: null,
        yFraction: null,
        expectedDeterministicId: null,
        worldPoint: null,
        allowCameraFit: false,
      });
      selectedIds = Array.isArray(post?.model_selection?.selections)
        ? post.model_selection.selections
            .map((item) => String(item?.deterministic_id || "").trim())
            .filter(Boolean)
        : [];
      const additivePreserved = additive
        ? preIds.every((id) => selectedIds.includes(id))
        : true;
      const nativeSingle = !explicitExpectedId && !additive && selectedIds.length === 1;
      const explicitMatched = explicitExpectedId ? selectedIds.includes(explicitExpectedId) : false;
      const additiveNew = additive
        ? selectedIds.some((id) => !preIds.includes(id))
        : false;
      if ((nativeSingle || explicitMatched || additiveNew) && additivePreserved) break;
    }
    const readbackMs = performance.now() - readbackStarted;

    const additivePreserved = additive
      ? preIds.every((id) => selectedIds.includes(id))
      : true;
    const nativeSingle = !explicitExpectedId && !additive && selectedIds.length === 1;
    const explicitMatched = explicitExpectedId ? selectedIds.includes(explicitExpectedId) : false;
    const additiveNew = additive
      ? selectedIds.some((id) => !preIds.includes(id))
      : false;
    const verified = additivePreserved && (nativeSingle || explicitMatched || additiveNew);
    if (!explicitExpectedId && !additive && selectedIds.length === 1) {
      deterministicId = selectedIds[0];
    } else if (!explicitExpectedId && additive && additiveNew) {
      deterministicId = selectedIds.find((id) => !preIds.includes(id)) || deterministicId;
    }
    const result = {
      status: verified ? "VERIFIED" : "SELECTION_READBACK_MISMATCH",
      action: additive ? "add" : "select",
      route: additive ? "PERSISTENT_VIEWPORT_NATIVE_SHIFT_HIT" : "PERSISTENT_VIEWPORT_NATIVE_HIT_SELECTION",
      expected_deterministic_id: explicitExpectedId,
      selected_deterministic_id: deterministicId,
      observed_deterministic_ids: ids,
      selected_deterministic_ids: selectedIds,
      click: { x: px, y: py },
      preselect_clear_route: additive ? null : (cleared.route || null),
      preserved_prior_deterministic_ids: additive ? preIds : [],
    };
    if (result.status !== "VERIFIED") {
      const observedPost = Array.isArray(post?.model_selection?.selections)
        ? post.model_selection.selections.map((item) => ({ ...item })) : [];
      const cleanup = await clearNativeSelection(observedPost).catch(() => null);
      this.workSession.current_selection = [];
      const error = new Error("Viewer selection click did not verify.");
      error.code = "VIEWER_SELECTION_NOT_VERIFIED";
      error.selection_result = { ...result, cleanup_status: cleanup?.status || null };
      throw error;
    }

    const selected = Array.isArray(post?.model_selection?.selections)
      ? post.model_selection.selections.map((item) => ({ ...item }))
      : [];
    this.workSession.current_selection = selected;
    return {
      document_id: String(documentId),
      workspace_id: String(workspaceId),
      element_id: String(elementId),
      page_lease: "PERSISTENT_WORK_PAGE",
      continuity: opened.continuity,
      readiness: { attempts: 1, maximum_attempts: maximumAttempts, retry_interval_ms: retryIntervalMs },
      ...result,
      model_selection: post.model_selection,
      timing: {
        open_document: opened.timing || null,
        probe_ms: Math.round(probeMs * 10) / 10,
        clear_ms: Math.round(clearMs * 10) / 10,
        click_ms: Math.round(clickMs * 10) / 10,
        readback_ms: Math.round(readbackMs * 10) / 10,
        total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
      },
    };
  }

  async moveView({ documentId, workspaceId, elementId, action, direction, intensity, angleDegrees = null }) {
    const totalStarted = performance.now();
    const opened = await this.openDocument(documentId, workspaceId, elementId);
    if (opened?.continuity?.break_detected) {
      const error = new Error("Persistent work-page continuity broke and the target route was restored before applying the camera command.");
      error.code = "VIEWER_MOVE_NOT_VERIFIED";
      error.move_result = {
        status: "CONTINUITY_BREAK_RESTORED_TARGET",
        continuity: opened.continuity,
        timing: { open_document: opened.timing || null },
      };
      throw error;
    }

    const maximumAttempts = 12;
    const retryIntervalMs = 100;
    let last = null;
    const readinessStarted = performance.now();
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      last = await this._moveViewOnCurrentPage({ action, direction, intensity, angleDegrees });
      if (last?.status === "VERIFIED") {
        const readinessMs = performance.now() - readinessStarted;
        this.workSession.last_camera = {
          generation: this.workSession.generation,
          target: { ...this.workSession.target },
          view_matrix: Array.isArray(last.after_view_matrix) ? [...last.after_view_matrix] : [],
          camera_viewport: Array.isArray(last.after_camera_viewport) ? [...last.after_camera_viewport] : [],
          updated_at: new Date().toISOString(),
        };
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          page_lease: "PERSISTENT_WORK_PAGE",
          continuity: opened.continuity,
          readiness: {
            attempts: attempt,
            maximum_attempts: maximumAttempts,
            retry_interval_ms: retryIntervalMs,
            elapsed_ms: Math.round(readinessMs * 10) / 10,
          },
          ...last,
          timing: {
            open_document: opened.timing || null,
            viewer_acquisition_ms: Number(last?.timing?.viewer_acquisition_ms || 0),
            dispatch_ms: Number(last?.timing?.dispatch_ms || 0),
            verification_ms: Number(last?.timing?.verification_ms || 0),
            total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
          },
        };
      }
      if (!["NOT_READY", "NO_VIEWPORT", "NO_VIEWER"].includes(String(last?.status || ""))) break;
      if (attempt < maximumAttempts) await sleep(retryIntervalMs);
    }
    const error = new Error(`Viewer movement did not verify: ${String(last?.status || "UNKNOWN")}`);
    error.code = "VIEWER_MOVE_NOT_VERIFIED";
    error.move_result = {
      ...(last || {}),
      timing: {
        open_document: opened.timing || null,
        total_ms: Math.round((performance.now() - totalStarted) * 10) / 10,
      },
    };
    throw error;
  }

  async _moveViewOnCurrentPage({ action, direction, intensity, angleDegrees = null }) {
    const runtime = await this._viewerRuntimeObjects();
    const { cdp, objectsId, objectGroup } = runtime;
    const viewerAcquisitionMs = Number(runtime.acquisition_ms || 0);
    try {
      const fn = `async function(action, direction, intensity, angleDegrees, viewerAcquisitionMs, cacheHit) {
        const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
        const plainArray = (value, max = 16) => {
          if (Array.isArray(value)) return value.slice(0, max).map(Number);
          if (ArrayBuffer.isView(value)) return Array.from(value).slice(0, max).map(Number);
          return [];
        };
        const source = (fn) => typeof fn === "function"
          ? safe(() => Function.prototype.toString.call(fn).slice(0, 1800), null) : null;
        const delta = (a, b) => {
          if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
          let max = 0;
          for (let i = 0; i < a.length; i++) {
            const x = Number(a[i]), y = Number(b[i]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            max = Math.max(max, Math.abs(x - y));
          }
          return max;
        };
        const strength = (value, power, highGain) => {
          if (value <= 1) return Math.pow(value, power);
          return 1 + highGain * (Math.exp(0.48 * (value - 1)) - 1);
        };

        const count = Number(this.length) || 0;
        const candidates = [];
        for (let i = 0; i < count; i++) {
          const v = this[i];
          if (!v || typeof v !== "object") continue;
          if (typeof v.getViewData !== "function" || typeof v.getCamera !== "function"
            || typeof v.getPrimaryViewController !== "function") continue;
          const camera = safe(() => v.getCamera(), null);
          if (!camera) continue;
          candidates.push({
            v, index: i,
            ready: safe(() => !!v.isReadyForDrawing?.(), false),
            primary: safe(() => !!v.getIsPrimaryViewer?.(), false),
          });
        }
        const chosen = candidates.find((x) => x.ready && x.primary)
          || candidates.find((x) => x.ready)
          || candidates[candidates.length - 1];
        if (!chosen) return { status: "NO_VIEWER", instance_count: count };
        const v = chosen.v;
        if (!chosen.ready) return { status: "NOT_READY", viewer_index: chosen.index };
        const camera = safe(() => v.getCamera(), null);
        const width = safe(() => Number(camera?.getViewportWidth?.()), null);
        const height = safe(() => Number(camera?.getViewportHeight?.()), null);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
          return { status: "NO_VIEWPORT", viewer_index: chosen.index };
        }
        const controller = safe(() => v.getPrimaryViewController(), null);
        if (!controller) return { status: "NO_PRIMARY_VIEW_CONTROLLER" };

        const beforeData = safe(() => v.getViewData(), null);
        const beforeMatrix = plainArray(beforeData?.viewMatrix, 16);
        const beforeViewport = plainArray(beforeData?.cameraViewport, 4);
        const normalizedAction = String(action || "").toLowerCase();
        const normalizedDirection = String(direction || "").toLowerCase();
        const normalizedIntensity = Number(intensity);
        const explicitAngle = angleDegrees == null ? null : Number(angleDegrees);
        if (!Number.isFinite(normalizedIntensity) || normalizedIntensity <= 0 || normalizedIntensity > 5) {
          return { status: "INTENSITY_INVALID" };
        }
        if (explicitAngle != null && (!Number.isFinite(explicitAngle) || explicitAngle <= 0 || explicitAngle > 360)) {
          return { status: "ANGLE_INVALID" };
        }

        let amount = null;
        let route = null;
        let contractSource = null;
        let screenSpaceDispatch = null;
        let screenSpaceProbe = null;
        if (normalizedAction === "pan" && typeof v.pickInRect === "function") {
          const points = [
            [0.50, 0.50], [0.40, 0.50], [0.60, 0.50],
            [0.50, 0.40], [0.50, 0.60],
            [0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65],
          ];
          for (const [xf, yf] of points) {
            const px = Math.round(xf * (width - 1));
            const py = Math.round(yf * (height - 1));
            const picks = Array.from(safe(() => v.pickInRect(px, py, 3, 3), []) || []).slice(0, 16);
            const ids = [...new Set(picks.map((pick) => String(pick?.deterministicId || "")).filter(Boolean))];
            if (ids.length === 1) {
              screenSpaceProbe = { deterministic_id: ids[0], x: px, y: py };
              break;
            }
          }
        }
        const dispatchStarted = performance.now();

        if (normalizedAction === "pan") {
          if (!["left","right","up","down"].includes(normalizedDirection)) return { status: "DIRECTION_INVALID" };
          if (typeof controller.pan !== "function" || Number(controller.pan.length) !== 2) {
            return { status: "PAN_CONTRACT_MISMATCH" };
          }
          contractSource = source(controller.pan);
          if (!contractSource || !contractSource.includes("this.camera.pan") || !contractSource.includes("requestDraw")) {
            return { status: "PAN_CONTRACT_MISMATCH" };
          }
          const pixels = Math.max(1, Math.round(2 + 170 * strength(normalizedIntensity, 1.2, 0.55)));
          const dx = normalizedDirection === "left" ? -pixels : normalizedDirection === "right" ? pixels : 0;
          const dy = normalizedDirection === "up" ? -pixels : normalizedDirection === "down" ? pixels : 0;
          const center = [Math.round(width / 2), Math.round(height / 2)];
          controller.pan(center, [dx, dy]);
          amount = pixels;
          screenSpaceDispatch = { dx, dy, semantic_direction: normalizedDirection };
          route = "PRIMARY_VIEW_CONTROLLER_DIRECT_PAN_SCREEN_SPACE";
        } else if (normalizedAction === "zoom") {
          if (!["in","out"].includes(normalizedDirection)) return { status: "DIRECTION_INVALID" };
          if (typeof controller.zoom !== "function" || Number(controller.zoom.length) !== 1) {
            return { status: "ZOOM_CONTRACT_MISMATCH" };
          }
          contractSource = source(controller.zoom);
          if (!contractSource || !contractSource.includes("this.camera.zoom")) return { status: "ZOOM_CONTRACT_MISMATCH" };
          const zoomStrength = strength(normalizedIntensity, 1.1, 0.75);
          const inScale = Math.exp(-0.45 * zoomStrength);
          const scale = normalizedDirection === "in" ? inScale : 1 / inScale;
          const wheelUnits = -6 * Math.log2(scale);
          controller.zoom(wheelUnits);
          safe(() => v.requestDrawUsingAnimationFrame?.(), null);
          amount = scale;
          route = "PRIMARY_VIEW_CONTROLLER_DIRECT_ZOOM";
        } else if (normalizedAction === "orbit") {
          if (!["left","right","up","down","clockwise","counterclockwise"].includes(normalizedDirection)) {
            return { status: "DIRECTION_INVALID" };
          }
          if (typeof controller.rotateAbout !== "function" || Number(controller.rotateAbout.length) !== 3) {
            return { status: "ORBIT_CONTRACT_MISMATCH" };
          }
          contractSource = source(controller.rotateAbout);
          if (!contractSource || !contractSource.includes("this.camera.rotateAbout")) {
            return { status: "ORBIT_CONTRACT_MISMATCH" };
          }
          const angle = explicitAngle != null
            ? explicitAngle * Math.PI / 180
            : 0.005 + 0.42 * strength(normalizedIntensity, 1.25, 0.45);
          const axis = ["left","right"].includes(normalizedDirection)
            ? camera.up
            : ["up","down"].includes(normalizedDirection)
              ? safe(() => camera.getRight?.(), null)
              : camera.direction;
          if (!axis) return { status: "ORBIT_AXIS_UNAVAILABLE" };
          const signedAngle = ["right","down","clockwise"].includes(normalizedDirection) ? -angle : angle;
          const center = safe(() => camera.focalPoint?.(), null);
          if (!center) return { status: "ORBIT_CENTER_UNAVAILABLE" };
          controller.rotateAbout(signedAngle, axis, center);
          safe(() => controller.updateCameraNearFar?.(), null);
          safe(() => controller.afterViewChange?.(), null);
          safe(() => v.requestDrawUsingAnimationFrame?.(), null);
          amount = angle;
          route = explicitAngle != null
            ? "PRIMARY_VIEW_CONTROLLER_DIRECT_ROTATE_EXACT_DEGREES"
            : "PRIMARY_VIEW_CONTROLLER_DIRECT_ROTATE_IN_DIRECTION";
        } else {
          return { status: "ACTION_INVALID" };
        }
        const dispatchMs = performance.now() - dispatchStarted;

        const verifyStarted = performance.now();
        let afterData = safe(() => v.getViewData(), null);
        let afterMatrix = plainArray(afterData?.viewMatrix, 16);
        let afterViewport = plainArray(afterData?.cameraViewport, 4);
        let matrixDelta = delta(beforeMatrix, afterMatrix);
        let viewportDelta = delta(beforeViewport, afterViewport);
        let changed = (Number.isFinite(matrixDelta) && matrixDelta > 1e-9)
          || (Number.isFinite(viewportDelta) && viewportDelta > 1e-9);
        let previousMatrix = afterMatrix;
        let previousViewport = afterViewport;
        let stableSamples = 0;
        let samples = 0;

        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          samples += 1;
          afterData = safe(() => v.getViewData(), null);
          afterMatrix = plainArray(afterData?.viewMatrix, 16);
          afterViewport = plainArray(afterData?.cameraViewport, 4);
          matrixDelta = delta(beforeMatrix, afterMatrix);
          viewportDelta = delta(beforeViewport, afterViewport);
          const stepMatrix = delta(previousMatrix, afterMatrix);
          const stepViewport = delta(previousViewport, afterViewport);
          changed = changed
            || (Number.isFinite(matrixDelta) && matrixDelta > 1e-9)
            || (Number.isFinite(viewportDelta) && viewportDelta > 1e-9);
          const stable = changed
            && (!Number.isFinite(stepMatrix) || stepMatrix < 1e-7)
            && (!Number.isFinite(stepViewport) || stepViewport < 1e-7);
          stableSamples = stable ? stableSamples + 1 : 0;
          previousMatrix = afterMatrix;
          previousViewport = afterViewport;
          if (stableSamples >= 2) break;
        }

        let screenSpaceVerification = null;
        if (normalizedAction === "pan") {
          if (!screenSpaceProbe) {
            screenSpaceVerification = { status: "NO_TRACKABLE_PICK" };
          } else {
            const semanticDx = normalizedDirection === "left" ? -amount : normalizedDirection === "right" ? amount : 0;
            const semanticDy = normalizedDirection === "up" ? -amount : normalizedDirection === "down" ? amount : 0;
            const expectedX = Math.round(screenSpaceProbe.x + semanticDx);
            const expectedY = Math.round(screenSpaceProbe.y + semanticDy);
            if (expectedX < 0 || expectedX >= width || expectedY < 0 || expectedY >= height) {
              screenSpaceVerification = {
                status: "EXPECTED_POINT_OFFSCREEN",
                tracked_deterministic_id: screenSpaceProbe.deterministic_id,
                before_x: screenSpaceProbe.x,
                before_y: screenSpaceProbe.y,
                expected_x: expectedX,
                expected_y: expectedY,
              };
            } else {
              const afterPicks = Array.from(
                safe(() => v.pickInRect(expectedX, expectedY, 9, 9), []) || [],
              ).slice(0, 32);
              const afterIds = [...new Set(
                afterPicks.map((pick) => String(pick?.deterministicId || "")).filter(Boolean),
              )];
              screenSpaceVerification = {
                status: afterIds.includes(screenSpaceProbe.deterministic_id)
                  ? "VERIFIED"
                  : "TRACKED_ENTITY_NOT_AT_EXPECTED_SCREEN_POINT",
                tracked_deterministic_id: screenSpaceProbe.deterministic_id,
                before_x: screenSpaceProbe.x,
                before_y: screenSpaceProbe.y,
                expected_x: expectedX,
                expected_y: expectedY,
                observed_deterministic_ids: afterIds,
              };
            }
          }
        }
        const screenSpaceHardFailure = normalizedAction === "pan"
          && screenSpaceVerification
          && screenSpaceVerification.status === "TRACKED_ENTITY_NOT_AT_EXPECTED_SCREEN_POINT";

        return {
          status: !changed
            ? "NO_CAMERA_CHANGE"
            : screenSpaceHardFailure ? "SCREEN_SPACE_DIRECTION_NOT_VERIFIED" : "VERIFIED",
          action: normalizedAction,
          direction: normalizedDirection,
          intensity: normalizedIntensity,
          angle_degrees: explicitAngle,
          amount,
          route,
          viewer_index: chosen.index,
          camera_width: width,
          camera_height: height,
          before_view_matrix: beforeMatrix,
          after_view_matrix: afterMatrix,
          before_camera_viewport: beforeViewport,
          after_camera_viewport: afterViewport,
          view_matrix_max_delta: matrixDelta,
          camera_viewport_max_delta: viewportDelta,
          screen_space_dispatch: screenSpaceDispatch,
          screen_space_verification: screenSpaceVerification,
          verification_samples: samples,
          contract_source: contractSource,
          timing: {
            viewer_acquisition_ms: Number(viewerAcquisitionMs) || 0,
            viewer_cache_hit: cacheHit === true,
            dispatch_ms: Math.round(dispatchMs * 10) / 10,
            verification_ms: Math.round((performance.now() - verifyStarted) * 10) / 10,
          },
        };
      }`;
      const called = await cdp.send("Runtime.callFunctionOn", {
        objectId: objectsId,
        functionDeclaration: fn,
        arguments: [
          { value: String(action || "") },
          { value: String(direction || "") },
          { value: Number(intensity) },
          { value: angleDegrees == null ? null : Number(angleDegrees) },
          { value: Math.round(viewerAcquisitionMs * 10) / 10 },
          { value: runtime.cache_hit === true },
        ],
        objectGroup,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });
      return called?.result?.value || { status: "NO_RESULT" };
    } catch (error) {
      await this._disposeViewerRuntimeCache().catch(() => {});
      throw error;
    }
  }

  async testFollowHandoff({ documentId, workspaceId, elementId, pageCount = 2 }) {
    const requestedCount = Number(pageCount);
    if (![2, 3].includes(requestedCount)) {
      const error = new Error("Follow handoff test page_count must be 2 or 3.");
      error.code = "VIEWER_FOLLOW_PAGE_COUNT_INVALID";
      throw error;
    }
    const leases = [];
    const stateArgs = {
      mode: "state",
      xFraction: null,
      yFraction: null,
      expectedDeterministicId: null,
      worldPoint: null,
      allowCameraFit: false,
    };
    const matrixOf = async (tab) => {
      for (let attempt = 1; attempt <= 16; attempt += 1) {
        try {
          const v = await tab._inspectViewerOnCurrentPage(stateArgs);
          const matrix = Array.isArray(v?.view_data?.view_matrix) ? v.view_data.view_matrix.map(Number) : [];
          if (v?.viewer?.ready === true && matrix.length === 16 && matrix.every(Number.isFinite)) return matrix;
        } catch {}
        if (attempt < 16) await sleep(250);
      }
      return [];
    };
    const delta = (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
      let max = 0;
      for (let i = 0; i < a.length; i += 1) {
        const x = Number(a[i]), y = Number(b[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        max = Math.max(max, Math.abs(x - y));
      }
      return max;
    };
    const waitConvergence = async (follower, leader, maximumAttempts = 12) => {
      let last = null;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const [fm, lm] = await Promise.all([matrixOf(follower), matrixOf(leader)]);
        const d = delta(fm, lm);
        last = { attempt, delta: d, follower_matrix: fm, leader_matrix: lm };
        if (Number.isFinite(d) && d < 1e-5) return { converged: true, ...last };
        if (attempt < maximumAttempts) await sleep(200);
      }
      return { converged: false, ...(last || {}) };
    };
    const collaboratorCount = async (tab) => {
      await tab.ensureBrowser();
      return tab.page.locator(".clients osx-collaborator-icon").count();
    };
    const dblclickCandidate = async (tab, index) => {
      await tab.ensureBrowser();
      const locator = tab.page.locator(".clients osx-collaborator-icon").nth(index);
      if (!(await locator.isVisible().catch(() => false))) return false;
      await locator.dblclick({ button: "left", delay: 60 });
      await sleep(250);
      return true;
    };
    const tryFollow = async ({ follower, leader, followerIndex, leaderIndex }) => {
      const count = await collaboratorCount(follower);
      const attempts = [];
      for (let candidate = 0; candidate < count; candidate += 1) {
        const clicked = await dblclickCandidate(follower, candidate);
        if (!clicked) {
          attempts.push({ candidate, clicked: false });
          continue;
        }
        await leader.moveView({
          documentId, workspaceId, elementId,
          action: "pan", direction: "right", intensity: 0.12,
        });
        const convergence = await waitConvergence(follower, leader);
        attempts.push({ candidate, clicked: true, convergence });
        if (convergence.converged) {
          return {
            status: "VERIFIED",
            follower_index: followerIndex,
            leader_index: leaderIndex,
            collaborator_count: count,
            target_candidate_index: candidate,
            attempts,
          };
        }
        await leader.moveView({
          documentId, workspaceId, elementId,
          action: "pan", direction: "left", intensity: 0.12,
        }).catch(() => {});
        await sleep(250);
      }
      return {
        status: "FOLLOW_NOT_ESTABLISHED",
        follower_index: followerIndex,
        leader_index: leaderIndex,
        collaborator_count: count,
        attempts,
      };
    };

    try {
      for (let index = 0; index < requestedCount; index += 1) {
        const tab = await this.createUiPageSession();
        leases.push(tab);
        await tab.openDocument(documentId, workspaceId, elementId);
        await matrixOf(tab);
      }

      const dom = [];
      for (let index = 0; index < leases.length; index += 1) {
        const tab = leases[index];
        dom.push({
          index,
          collaborator_count: await collaboratorCount(tab),
          ...(await tab._inspectCollaborationDomOnCurrentPage()),
        });
      }

      if (requestedCount === 3) {
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          page_lease: "EPHEMERAL_MULTI_TAB_SHARED_AUTH_CONTEXT",
          page_count: requestedCount,
          status: "THREE_PARTICIPANT_DOM_VERIFIED",
          pages: dom,
        };
      }

      const forward = await tryFollow({
        follower: leases[0], leader: leases[1], followerIndex: 0, leaderIndex: 1,
      });
      if (forward.status !== "VERIFIED") {
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          page_lease: "EPHEMERAL_MULTI_TAB_SHARED_AUTH_CONTEXT",
          page_count: requestedCount,
          status: "FORWARD_FOLLOW_NOT_VERIFIED",
          pages: dom,
          forward,
        };
      }

      await leases[0].moveView({
        documentId, workspaceId, elementId,
        action: "orbit", direction: "left", intensity: 0.08,
      });
      const afterLocalBreak = await matrixOf(leases[0]);
      await leases[1].moveView({
        documentId, workspaceId, elementId,
        action: "pan", direction: "right", intensity: 0.12,
      });
      await sleep(500);
      const [breakFollower, breakLeader] = await Promise.all([matrixOf(leases[0]), matrixOf(leases[1])]);
      const breakDelta = delta(breakFollower, breakLeader);
      const breakVerified = Number.isFinite(breakDelta) && breakDelta > 1e-4;

      const reverse = await tryFollow({
        follower: leases[1], leader: leases[0], followerIndex: 1, leaderIndex: 0,
      });

      return {
        document_id: String(documentId),
        workspace_id: String(workspaceId),
        element_id: String(elementId),
        page_lease: "EPHEMERAL_MULTI_TAB_SHARED_AUTH_CONTEXT",
        page_count: requestedCount,
        status: forward.status === "VERIFIED" && breakVerified && reverse.status === "VERIFIED"
          ? "VERIFIED" : "FOLLOW_HANDOFF_INCOMPLETE",
        pages: dom,
        forward,
        local_break: {
          status: breakVerified ? "VERIFIED" : "NOT_VERIFIED",
          local_matrix_after_break: afterLocalBreak,
          post_leader_move_delta: breakDelta,
        },
        reverse,
      };
    } finally {
      for (const tab of leases.reverse()) await tab.close().catch(() => {});
    }
  }


  async testRemoteSelectionGrounding({ documentId, workspaceId, elementId }) {
    await this.openDocument(documentId, workspaceId, elementId);
    const leader = await this.createUiPageSession();

    const stateArgs = {
      mode: "state",
      xFraction: null,
      yFraction: null,
      expectedDeterministicId: null,
      worldPoint: null,
      allowCameraFit: false,
    };
    const matrixOf = async (tab) => {
      for (let attempt = 1; attempt <= 16; attempt += 1) {
        try {
          const v = await tab._inspectViewerOnCurrentPage(stateArgs);
          const matrix = Array.isArray(v?.view_data?.view_matrix) ? v.view_data.view_matrix.map(Number) : [];
          if (v?.viewer?.ready === true && matrix.length === 16 && matrix.every(Number.isFinite)) return matrix;
        } catch {}
        if (attempt < 16) await sleep(250);
      }
      return [];
    };
    const delta = (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
      let max = 0;
      for (let i = 0; i < a.length; i += 1) {
        const x = Number(a[i]), y = Number(b[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        max = Math.max(max, Math.abs(x - y));
      }
      return max;
    };
    const waitConvergence = async (follower, remoteLeader, maximumAttempts = 12) => {
      let last = null;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const [fm, lm] = await Promise.all([matrixOf(follower), matrixOf(remoteLeader)]);
        const d = delta(fm, lm);
        last = { attempt, delta: d };
        if (Number.isFinite(d) && d < 1e-5) return { converged: true, ...last };
        if (attempt < maximumAttempts) await sleep(200);
      }
      return { converged: false, ...(last || {}) };
    };

    let followCandidate = null;
    let followEvidence = null;
    let target = null;
    let localGrounding = null;
    try {
      await leader.openDocument(documentId, workspaceId, elementId);
      await Promise.all([matrixOf(this), matrixOf(leader)]);

      const collaboratorCount = await this.page.locator(".clients osx-collaborator-icon").count();
      const followAttempts = [];
      for (let candidate = 0; candidate < collaboratorCount; candidate += 1) {
        const locator = this.page.locator(".clients osx-collaborator-icon").nth(candidate);
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) {
          followAttempts.push({ candidate, clicked: false });
          continue;
        }
        await locator.dblclick({ button: "left", delay: 60 });
        await sleep(250);
        await leader.moveView({
          documentId, workspaceId, elementId,
          action: "pan", direction: "right", intensity: 0.08,
        });
        const convergence = await waitConvergence(this, leader);
        followAttempts.push({ candidate, clicked: true, convergence });
        if (convergence.converged) {
          followCandidate = candidate;
          followEvidence = {
            collaborator_count: collaboratorCount,
            candidate_index: candidate,
            attempts: followAttempts,
            convergence,
          };
          break;
        }
        await leader.moveView({
          documentId, workspaceId, elementId,
          action: "pan", direction: "left", intensity: 0.08,
        }).catch(() => {});
        await sleep(250);
      }

      if (followCandidate == null) {
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          status: "FOLLOW_NOT_ESTABLISHED",
          follow: {
            collaborator_count: collaboratorCount,
            attempts: followAttempts,
          },
        };
      }

      const points = [
        [0.50, 0.50],
        [0.45, 0.50], [0.55, 0.50], [0.50, 0.45], [0.50, 0.55],
        [0.40, 0.50], [0.60, 0.50], [0.50, 0.40], [0.50, 0.60],
        [0.40, 0.40], [0.60, 0.40], [0.40, 0.60], [0.60, 0.60],
      ];
      const targetAttempts = [];
      for (const [xFraction, yFraction] of points) {
        const probe = await leader._inspectViewerOnCurrentPage({
          mode: "probe",
          xFraction,
          yFraction,
          expectedDeterministicId: null,
          worldPoint: null,
          allowCameraFit: false,
        });
        const picks = Array.isArray(probe?.probe?.picks) ? probe.probe.picks : [];
        const ids = picks
          .map((pick) => String(pick?.deterministic_id || "").trim())
          .filter(Boolean);
        const counts = new Map();
        for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
        let marked = null;
        for (const [id, count] of counts.entries()) {
          if (count !== 1) continue;
          const mark = await leader._inspectViewerOnCurrentPage({
            mode: "hover_probe",
            xFraction,
            yFraction,
            expectedDeterministicId: id,
            worldPoint: null,
            allowCameraFit: false,
          });
          targetAttempts.push({
            x_fraction: xFraction,
            y_fraction: yFraction,
            deterministic_id: id,
            mark_status: String(mark?.hover_set?.status || "UNKNOWN"),
            mark_route: mark?.hover_set?.route || null,
          });
          if (String(mark?.hover_set?.status || "") === "VERIFIED") {
            marked = {
              x_fraction: xFraction,
              y_fraction: yFraction,
              deterministic_id: id,
              leader_mark_route: mark?.hover_set?.route || null,
            };
            break;
          }
        }
        if (marked) {
          target = marked;
          break;
        }
      }

      if (!target) {
        return {
          document_id: String(documentId),
          workspace_id: String(workspaceId),
          element_id: String(elementId),
          status: "NO_GROUNDABLE_PICK",
          follow: followEvidence,
          target_attempts: targetAttempts,
        };
      }

      const groundingAttempts = [];
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const convergence = await waitConvergence(this, leader, 4);
        const probe = await this._inspectViewerOnCurrentPage({
          mode: "probe",
          xFraction: target.x_fraction,
          yFraction: target.y_fraction,
          expectedDeterministicId: null,
          worldPoint: null,
          allowCameraFit: false,
        });
        const observed = Array.isArray(probe?.probe?.picks)
          ? probe.probe.picks
              .map((pick) => String(pick?.deterministic_id || "").trim())
              .filter(Boolean)
          : [];
        const repick = await this._inspectViewerOnCurrentPage({
          mode: "hover_probe",
          xFraction: target.x_fraction,
          yFraction: target.y_fraction,
          expectedDeterministicId: target.deterministic_id,
          worldPoint: null,
          allowCameraFit: false,
        });
        const repickStatus = String(repick?.hover_set?.status || "UNKNOWN");
        const identitySeen = observed.includes(target.deterministic_id);
        const row = {
          attempt,
          convergence,
          observed_deterministic_ids: observed.slice(0, 16),
          identity_seen: identitySeen,
          repick_status: repickStatus,
          repick_route: repick?.hover_set?.route || null,
        };
        groundingAttempts.push(row);
        if (convergence.converged && identitySeen && repickStatus === "VERIFIED") {
          localGrounding = row;
          break;
        }
        if (attempt < 6) await sleep(250);
      }

      return {
        document_id: String(documentId),
        workspace_id: String(workspaceId),
        element_id: String(elementId),
        page_lease: "PERSISTENT_FOLLOWER_PLUS_EPHEMERAL_LEADER",
        status: localGrounding ? "VERIFIED" : "LOCAL_REPICK_NOT_VERIFIED",
        follow: followEvidence,
        target,
        grounding_attempts: groundingAttempts,
        local_grounding: localGrounding,
      };
    } finally {
      if (followCandidate != null) {
        await this.moveView({
          documentId, workspaceId, elementId,
          action: "orbit", direction: "left", intensity: 0.01,
        }).catch(() => {});
      }
      await leader.close().catch(() => {});
    }
  }

  async followView({ documentId, workspaceId, elementId, candidateIndex = null }) {
    await this.openDocument(documentId, workspaceId, elementId);
    const maximumAttempts = 16;
    const retryIntervalMs = 250;
    let count = 0;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      count = await this.page.locator(".clients osx-collaborator-icon").count();
      if (count >= 2) break;
      if (attempt < maximumAttempts) await sleep(retryIntervalMs);
    }
    if (count < 2) {
      const error = new Error("No remote Onshape collaborator is currently available to follow.");
      error.code = "VIEW_FOLLOW_NO_REMOTE_COLLABORATOR";
      throw error;
    }

    let chosen = candidateIndex == null ? null : Number(candidateIndex);
    if (chosen == null && count === 2) chosen = 1;
    if (chosen == null) {
      const error = new Error("Multiple Onshape collaborators are present; candidate_index is required.");
      error.code = "VIEW_FOLLOW_COLLABORATOR_AMBIGUOUS";
      error.collaborator_count = count;
      throw error;
    }
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= count) {
      const error = new Error("view.follow candidate_index is outside the current collaborator list.");
      error.code = "VIEW_FOLLOW_CANDIDATE_INVALID";
      throw error;
    }
    if (count === 2 && chosen === 0) {
      const error = new Error("In the qualified two-participant layout candidate 0 is the local session; use the remote collaborator.");
      error.code = "VIEW_FOLLOW_SELF_CANDIDATE";
      throw error;
    }

    const locator = this.page.locator(".clients osx-collaborator-icon").nth(chosen);
    if (!(await locator.isVisible().catch(() => false))) {
      const error = new Error("Selected Onshape collaborator icon is not visible.");
      error.code = "VIEW_FOLLOW_CANDIDATE_NOT_VISIBLE";
      throw error;
    }
    await locator.dblclick({ button: "left", delay: 60 });
    await sleep(250);
    return {
      document_id: String(documentId),
      workspace_id: String(workspaceId),
      element_id: String(elementId),
      page_lease: "PERSISTENT_WORK_PAGE",
      status: "FOLLOW_DISPATCHED",
      collaborator_count: count,
      candidate_index: chosen,
      selection_basis: count === 2 && candidateIndex == null
        ? "QUALIFIED_TWO_PARTICIPANT_REMOTE_INDEX_1"
        : "EXPLICIT_CANDIDATE_INDEX",
      verification: "FOLLOW_PRIMITIVE_LIVE_QUALIFIED_BY_TWO_WAY_CAMERA_CONVERGENCE",
    };
  }

  async captureScreenshot({ documentId = null, workspaceId = null, elementId = null, format = "jpeg", quality = 80 }) {
    await this.ensureBrowser();
    const hasAnyTarget = [documentId, workspaceId, elementId].some((value) => value != null && String(value).trim() !== "");
    const hasFullTarget = [documentId, workspaceId, elementId].every((value) => value != null && String(value).trim() !== "");
    if (hasAnyTarget && !hasFullTarget) {
      const error = new Error("Screenshot target requires document_id, workspace_id, and element_id together.");
      error.code = "SCREENSHOT_TARGET_INCOMPLETE";
      throw error;
    }
    if (hasFullTarget) {
      await this.openDocument(documentId, workspaceId, elementId);
    }

    const normalizedFormat = String(format || "jpeg").toLowerCase();
    if (!["jpeg", "png"].includes(normalizedFormat)) {
      const error = new Error("Screenshot format must be jpeg or png.");
      error.code = "SCREENSHOT_FORMAT_INVALID";
      throw error;
    }
    const normalizedQuality = Math.max(40, Math.min(95, Math.round(Number(quality) || 80)));
    const viewport = this.page.viewportSize() || { width: 1440, height: 1000 };
    const started = performance.now();
    const bytes = await this.page.screenshot({
      type: normalizedFormat,
      ...(normalizedFormat === "jpeg" ? { quality: normalizedQuality } : {}),
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    return {
      data_base64: bytes.toString("base64"),
      mime_type: normalizedFormat === "png" ? "image/png" : "image/jpeg",
      format: normalizedFormat,
      quality: normalizedFormat === "jpeg" ? normalizedQuality : null,
      byte_length: bytes.length,
      width: viewport.width,
      height: viewport.height,
      capture_ms: Math.round((performance.now() - started) * 10) / 10,
      url: this.page.url(),
      title: await this.page.title().catch(() => null),
      target: hasFullTarget ? {
        document_id: String(documentId),
        workspace_id: String(workspaceId),
        element_id: String(elementId),
      } : null,
    };
  }

  async inspectViewer({ documentId, workspaceId, elementId, mode = "state", xFraction = null, yFraction = null, expectedDeterministicId = null, worldPoint = null, collaborationPageCount = 2 }) {
    const normalizedMode = String(mode || "state").trim().toLowerCase();
    if (!["state", "probe", "selection", "methods", "method_details", "selection_scan", "collaboration", "hover_probe"].includes(normalizedMode)) {
      const error = new Error("Viewer inspection mode is not admitted.");
      error.code = "VIEWER_INSPECT_MODE_INVALID";
      throw error;
    }
    let xf = null;
    let yf = null;
    if (normalizedMode === "probe" || normalizedMode === "hover_probe") {
      xf = xFraction == null ? null : Number(xFraction);
      yf = yFraction == null ? null : Number(yFraction);
      const hasScreenPoint = Number.isFinite(xf) && Number.isFinite(yf) && xf >= 0 && xf <= 1 && yf >= 0 && yf <= 1;
      const hasWorldPoint = normalizedMode === "hover_probe"
        && worldPoint && typeof worldPoint === "object"
        && ["x", "y", "z"].every((key) => Number.isFinite(Number(worldPoint[key])));
      if (normalizedMode === "probe" ? !hasScreenPoint : (!hasScreenPoint && !hasWorldPoint)) {
        const error = new Error("Viewer probe requires x_fraction/y_fraction in 0..1, or hover_probe may use a finite world_point.");
        error.code = "VIEWER_PROBE_COORDINATE_INVALID";
        throw error;
      }
      if (!hasScreenPoint) {
        xf = null;
        yf = null;
      }
    }
    let expectedId = null;
    if (normalizedMode === "hover_probe") {
      expectedId = String(expectedDeterministicId || "").trim() || null;
      if (expectedId && (expectedId.length > 240 || /[\r\n\0]/.test(expectedId))) {
        const error = new Error("Viewer hover expected deterministic id is invalid.");
        error.code = "VIEWER_HOVER_EXPECTED_ID_INVALID";
        throw error;
      }
    }

    if (normalizedMode === "collaboration") {
      const requestedCount = Number(collaborationPageCount);
      if (![1, 2, 3].includes(requestedCount)) {
        const error = new Error("Collaboration inspection page_count must be 1, 2, or 3.");
        error.code = "VIEWER_COLLABORATION_PAGE_COUNT_INVALID";
        throw error;
      }
      await this.openDocument(documentId, workspaceId, elementId);
      let viewerState = null;
      let attempts = 0;
      const maximumAttempts = 16;
      const retryIntervalMs = 500;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        attempts = attempt;
        try {
          viewerState = await this._inspectViewerOnCurrentPage({
            mode: "state",
            xFraction: null,
            yFraction: null,
            expectedDeterministicId: null,
            worldPoint: null,
            allowCameraFit: false,
          });
        } catch {
          viewerState = null;
        }
        const ready = viewerState?.viewer?.ready === true;
        const width = Number(viewerState?.camera?.width);
        const height = Number(viewerState?.camera?.height);
        if (ready && Number.isFinite(width) && width > 1 && Number.isFinite(height) && height > 1) break;
        if (attempt < maximumAttempts) await sleep(retryIntervalMs);
      }
      const dom = await this._inspectCollaborationDomOnCurrentPage();
      const page = {
        index: 0,
        readiness: {
          ready: viewerState?.viewer?.ready === true,
          attempts,
          maximum_attempts: maximumAttempts,
          retry_interval_ms: retryIntervalMs,
          camera_width: Number.isFinite(Number(viewerState?.camera?.width)) ? Number(viewerState.camera.width) : null,
          camera_height: Number.isFinite(Number(viewerState?.camera?.height)) ? Number(viewerState.camera.height) : null,
        },
        ...dom,
      };
      return {
        document_id: String(documentId),
        workspace_id: String(workspaceId),
        element_id: String(elementId),
        read_only: true,
        page_lease: "PERSISTENT_WORK_PAGE",
        requested_page_count: requestedCount,
        collaboration_page_count: 1,
        pages: [page],
      };
    }

    const lease = await this.createUiPageSession();
    try {
      const opened = await lease.openDocument(documentId, workspaceId, elementId);
      let inspection = null;
      let lastReadinessError = null;
      let readinessAttempts = 0;
      let cameraFitEvidence = null;
      const maximumAttempts = 16;
      const retryIntervalMs = 500;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        readinessAttempts = attempt;
        try {
          inspection = await lease._inspectViewerOnCurrentPage({
            mode: normalizedMode,
            xFraction: xf,
            yFraction: yf,
            expectedDeterministicId: expectedId,
            worldPoint,
            allowCameraFit: normalizedMode === "hover_probe" && !!worldPoint && !!expectedId && !cameraFitEvidence,
          });
          if (cameraFitEvidence && inspection?.hover_set && typeof inspection.hover_set === "object") {
            inspection = {
              ...inspection,
              hover_set: {
                ...inspection.hover_set,
                camera_fit_dispatched: true,
                camera_fit_source: cameraFitEvidence.camera_fit_source || null,
              },
            };
          }
          const hoverStatus = String(inspection?.hover_set?.status || "");
          const retryWorldPointReadiness = normalizedMode === "hover_probe"
            && !!worldPoint
            && !!expectedId
            && ["NOT_READY", "NO_VIEWPORT", "WORLD_POINT_PROJECTION_UNAVAILABLE", "EXPECTED_ID_NOT_PICKED"].includes(hoverStatus);
          if (retryWorldPointReadiness && attempt < maximumAttempts) {
            inspection = null;
            await sleep(retryIntervalMs);
            continue;
          }
          break;
        } catch (error) {
          const code = String(error?.code || "");
          const hoverStatus = String(error?.hover_set?.status || "");
          const cameraFitDispatched = normalizedMode === "hover_probe"
            && !!worldPoint
            && !!expectedId
            && code === "VIEWER_HOVER_NOT_VERIFIED"
            && hoverStatus === "CAMERA_FIT_DISPATCHED";
          if (cameraFitDispatched) {
            cameraFitEvidence = error?.hover_set && typeof error.hover_set === "object" ? error.hover_set : {};
            lastReadinessError = error;
            if (attempt < maximumAttempts) {
              await sleep(retryIntervalMs);
              continue;
            }
            break;
          }
          const retryWorldPointFailure = normalizedMode === "hover_probe"
            && !!worldPoint
            && !!expectedId
            && code === "VIEWER_HOVER_NOT_VERIFIED"
            && ["NOT_READY", "NO_VIEWPORT", "WORLD_POINT_PROJECTION_UNAVAILABLE", "EXPECTED_ID_NOT_PICKED"].includes(hoverStatus);
          if (retryWorldPointFailure) {
            lastReadinessError = error;
            if (attempt < maximumAttempts) {
              await sleep(retryIntervalMs);
              continue;
            }
            break;
          }
          if (!["VIEWER_RUNTIME_SELF_TEST_FAILED", "VIEWER_RUNTIME_INSTANCE_NOT_FOUND", "VIEWER_RUNTIME_NOT_READY"].includes(code)) throw error;
          lastReadinessError = error;
          if (attempt < maximumAttempts) await sleep(retryIntervalMs);
        }
      }
      if (!inspection && lastReadinessError && cameraFitEvidence) {
        lastReadinessError.hover_set = {
          ...(lastReadinessError.hover_set || {}),
          camera_fit_dispatched: true,
          camera_fit_source: cameraFitEvidence.camera_fit_source || null,
        };
      }
      if (!inspection) throw lastReadinessError || new Error("Viewer readiness remained unresolved.");
      return {
        ...opened,
        read_only: normalizedMode !== "hover_probe",
        page_lease: "EPHEMERAL_SHARED_AUTH_CONTEXT",
        readiness: {
          attempts: readinessAttempts,
          maximum_attempts: maximumAttempts,
          retry_interval_ms: retryIntervalMs,
        },
        ...inspection,
      };
    } finally {
      await lease.close();
    }
  }

  async _inspectCollaborationDomOnCurrentPage() {
    await this.ensureBrowser();
    return this.page.evaluate(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(rect.width) > 0
          && Number(rect.height) > 0;
      };
      const clean = (value, max = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max) || null;
      const keyword = /(follow|collab|presence|avatar|participant|people|member|user|online|active)/i;
      const all = Array.from(document.querySelectorAll("button,[role=button],[aria-label],[title],[class],[data-testid]"));
      const candidates = [];
      for (const el of all) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        const text = clean(el.innerText || el.textContent || "", 100);
        const aria = clean(el.getAttribute("aria-label"), 140);
        const title = clean(el.getAttribute("title"), 140);
        const id = clean(el.id, 120);
        const className = clean(typeof el.className === "string" ? el.className : "", 220);
        const testId = clean(el.getAttribute("data-testid"), 120);
        const role = clean(el.getAttribute("role"), 80);
        const metadata = [text, aria, title, id, className, testId, role].filter(Boolean).join(" ");
        const topRight = rect.top >= 0 && rect.top <= 220 && rect.right >= innerWidth - 460;
        if (!keyword.test(metadata) && !topRight) continue;
        candidates.push({
          tag: el.tagName.toLowerCase(),
          text,
          aria_label: aria,
          title,
          id,
          class_name: className,
          data_testid: testId,
          role,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
        if (candidates.length >= 120) break;
      }
      const clientsRoot = document.querySelector(".clients");
      const describe = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: clean(el.innerText || el.textContent || "", 160),
          aria_label: clean(el.getAttribute("aria-label"), 160),
          title: clean(el.getAttribute("title"), 160),
          id: clean(el.id, 120),
          class_name: clean(typeof el.className === "string" ? el.className : "", 240),
          role: clean(el.getAttribute("role"), 80),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      };
      const clientDescendants = clientsRoot
        ? Array.from(clientsRoot.querySelectorAll("*")).slice(0, 48).map(describe).filter(Boolean)
        : [];
      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        clients: {
          exists: !!clientsRoot,
          root: describe(clientsRoot),
          child_count: clientsRoot ? clientsRoot.children.length : 0,
          descendant_count: clientsRoot ? clientsRoot.querySelectorAll("*").length : 0,
          descendants: clientDescendants,
        },
        candidates,
      };
    });
  }

  async _inspectViewerOnCurrentPage({ mode, xFraction, yFraction, expectedDeterministicId = null, worldPoint = null, allowCameraFit = false }) {
    const runtime = await this._viewerRuntimeObjects();
    const { cdp, objectsId, objectGroup } = runtime;
    const viewerAcquisitionMs = Number(runtime.acquisition_ms || 0);
    try {
      const fn = `async function(mode, xFraction, yFraction, expectedDeterministicId, worldPoint, allowCameraFit) {
        const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
        const plain = (value, depth = 0) => {
          if (value == null || typeof value === "boolean" || typeof value === "string") {
            return typeof value === "string" ? value.slice(0, 500) : value;
          }
          if (typeof value === "number") return Number.isFinite(value) ? value : null;
          if (depth >= 3) return "[depth-bound]";
          if (Array.isArray(value)) return value.slice(0, 64).map((item) => plain(item, depth + 1));
          if (ArrayBuffer.isView(value)) return Array.from(value).slice(0, 64).map((item) => plain(item, depth + 1));
          if (typeof value === "object") {
            const out = {};
            for (const key of safe(() => Object.getOwnPropertyNames(value).slice(0, 32), [])) {
              const desc = safe(() => Object.getOwnPropertyDescriptor(value, key), null);
              if (desc && Object.prototype.hasOwnProperty.call(desc, "value")) out[key] = plain(desc.value, depth + 1);
            }
            return out;
          }
          return String(typeof value);
        };

        const count = Number(this.length) || 0;
        const candidates = [];
        for (let i = 0; i < count; i++) {
          const v = this[i];
          if (!v || typeof v !== "object") continue;
          if (typeof v.pickInRect !== "function" || typeof v.getViewData !== "function" || typeof v.getCamera !== "function") continue;
          const ready = safe(() => !!v.isReadyForDrawing?.(), false);
          const primary = safe(() => !!v.getIsPrimaryViewer?.(), false);
          const camera = safe(() => v.getCamera?.(), null);
          if (!camera) continue;
          candidates.push({ v, index: i, ready, primary });
        }
        if (!candidates.length) {
          return {
            self_test: {
              viewer_module_id: 74266,
              viewer_export: "jM",
              required_methods: ["pickInRect", "getViewData", "getCamera"],
              viewer_instance_found: false,
            },
            instance_count: count,
            usable_count: 0,
          };
        }

        const chosen = candidates.find((item) => item.ready && item.primary)
          || candidates.find((item) => item.ready)
          || candidates[candidates.length - 1];
        const v = chosen.v;
        const camera = safe(() => v.getCamera(), null);
        const width = safe(() => Number(camera.getViewportWidth()), null);
        const height = safe(() => Number(camera.getViewportHeight()), null);
        const viewData = safe(() => v.getViewData(), null);
        const selectionManager = safe(() => v.getUISelectionManager?.(), null);
        const boundedMethods = (obj) => {
          if (!obj || typeof obj !== "object") return [];
          const names = new Set();
          let current = obj;
          let depth = 0;
          while (current && depth < 6 && names.size < 160) {
            for (const key of safe(() => Object.getOwnPropertyNames(current), [])) {
              if (!/(set|view|camera|fit|zoom|pan|orbit|rotat|select|highlight|hover|focus|frame|standard)/i.test(key)) continue;
              const desc = safe(() => Object.getOwnPropertyDescriptor(current, key), null);
              if (desc && typeof desc.value === "function") names.add(key);
            }
            current = safe(() => Object.getPrototypeOf(current), null);
            depth += 1;
          }
          return [...names].sort().slice(0, 120);
        };

        const methodDetails = (obj, allowlist) => {
          return allowlist.map((name) => {
            let current = obj;
            let depth = 0;
            while (current && depth < 6) {
              const desc = safe(() => Object.getOwnPropertyDescriptor(current, name), null);
              if (desc && typeof desc.value === "function") {
                return {
                  name,
                  available: true,
                  arity: Number.isInteger(desc.value.length) ? desc.value.length : null,
                  prototype_depth: depth,
                  owner_constructor: safe(() => current.constructor?.name || null, null),
                };
              }
              current = safe(() => Object.getPrototypeOf(current), null);
              depth += 1;
            }
            return { name, available: false, arity: null, prototype_depth: null, owner_constructor: null };
          });
        };

        const readSelection = () => {
          const chunks = window.webpackChunkNewton;
          if (!Array.isArray(chunks)) return { available: false, count: 0, selections: [] };
          let req = null;
          const before = chunks.length;
          const chunkId = -Date.now();
          chunks.push([[chunkId], {}, (runtime) => { req = runtime; }]);
          if (chunks.length > before) chunks.splice(before);
          if (typeof req !== "function") return { available: false, count: 0, selections: [] };
          const mod = safe(() => req(85367), null);
          const list = safe(() => mod?.h$?.(), null);
          const models = Array.isArray(list?.models) ? list.models : [];
          return {
            available: !!list,
            count: models.length,
            selections: models.slice(0, 16).map((m) => ({
              deterministic_id: safe(() => m.getDeterministicId?.(), null),
              selection_id: plain(m?.selectionId ?? null),
              id_for_collection: safe(() => m.getIdForCollection?.(), m?.id ?? null),
              name: safe(() => m.getName?.(), m?.name ?? null),
              feature_id: plain(m?.featureId ?? null),
              feature_type: safe(() => m.getFeatureType?.(), m?.featureType ?? null),
              is_entity: safe(() => m.isEntity?.(), null),
              is_body: safe(() => m.isBody?.(), null),
              is_vertex: safe(() => m.isVertex?.(), null),
              is_edge: safe(() => m.isEdge?.(), null),
              is_face: safe(() => m.isFace?.(), null),
            })),
          };
        };
        const selection = readSelection();

        const base = {
          self_test: {
            viewer_module_id: 74266,
            viewer_export: "jM",
            selection_module_id: 85367,
            required_methods: ["pickInRect", "getViewData", "getCamera"],
            viewer_instance_found: true,
            selection_model_available: selection.available,
          },
          instance_count: count,
          usable_count: candidates.length,
          viewer: {
            index: chosen.index,
            ready: chosen.ready,
            primary: chosen.primary,
            element_id: typeof v.elementId === "string" ? v.elementId : null,
          },
          camera: {
            width,
            height,
            perspective: safe(() => !!camera.isPerspective(), null),
            frame: plain(safe(() => camera.getFrame(), null)),
            top: Number.isFinite(camera?.top) ? camera.top : null,
            bottom: Number.isFinite(camera?.bottom) ? camera.bottom : null,
            left: Number.isFinite(camera?.left) ? camera.left : null,
            right: Number.isFinite(camera?.right) ? camera.right : null,
            angle: Number.isFinite(camera?.angle) ? camera.angle : null,
          },
          view_data: {
            view_matrix: plain(viewData?.viewMatrix ?? null),
            camera_viewport: plain(viewData?.cameraViewport ?? null),
            is_perspective: typeof viewData?.isPerspective === "boolean" ? viewData.isPerspective : null,
            angle: Number.isFinite(viewData?.angle) ? viewData.angle : null,
          },
          model_selection: selection,
        };

        if (mode === "clear_selection") {
          if (!selectionManager || typeof selectionManager.reset !== "function" || Number(selectionManager.reset.length) !== 0) {
            return { ...base, selection_set: { status: "RESET_CONTRACT_MISMATCH" } };
          }
          safe(() => selectionManager.reset(), null);
          await new Promise((resolve) => {
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(resolve));
            else setTimeout(resolve, 32);
          });
          const post = readSelection();
          return {
            ...base,
            model_selection: post,
            selection_set: {
              status: post.available && post.count === 0 ? "VERIFIED" : "SELECTION_READBACK_MISMATCH",
              action: "clear",
              route: "UI_SELECTION_MANAGER_RESET",
              selected_deterministic_ids: post.selections.map((item) => item.deterministic_id).filter(Boolean),
            },
          };
        }

        if (mode === "select") {
          if (chosen.ready !== true) return { ...base, selection_set: { status: "NOT_READY" } };
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
            return { ...base, selection_set: { status: "NO_VIEWPORT" } };
          }
          if (!selectionManager || typeof selectionManager.setSelection !== "function"
            || Number(selectionManager.setSelection.length) !== 1) {
            return { ...base, selection_set: { status: "SET_SELECTION_CONTRACT_MISMATCH" } };
          }
          const x = Math.max(0, Math.min(width - 1, Math.round(Number(xFraction) * (width - 1))));
          const y = Math.max(0, Math.min(height - 1, Math.round(Number(yFraction) * (height - 1))));
          const picks = Array.from(safe(() => v.pickInRect(x, y, 1, 1), []) || []).slice(0, 16);
          const observed = picks.map((pick) => typeof pick?.deterministicId === "string" ? pick.deterministicId : null).filter(Boolean);
          let match = null;
          if (expectedDeterministicId) {
            const matches = picks.filter((pick) => String(pick?.deterministicId || "") === String(expectedDeterministicId));
            if (matches.length !== 1) {
              return {
                ...base,
                selection_set: {
                  status: matches.length ? "AMBIGUOUS_EXPECTED_ID" : "EXPECTED_ID_NOT_PICKED",
                  action: "select",
                  x, y,
                  expected_deterministic_id: expectedDeterministicId,
                  observed_deterministic_ids: observed,
                },
              };
            }
            match = matches[0];
          } else {
            if (picks.length !== 1) {
              return {
                ...base,
                selection_set: {
                  status: picks.length ? "AMBIGUOUS_PICK" : "NO_PICK",
                  action: "select",
                  x, y,
                  observed_deterministic_ids: observed,
                },
              };
            }
            match = picks[0];
          }
          const deterministicId = String(match?.deterministicId || "");
          const modelSelection = safe(() => match.getModelSelection?.(), null);
          const modelDeterministicId = modelSelection && typeof modelSelection === "object"
            ? safe(() => modelSelection.getDeterministicId?.(), modelSelection.deterministicId ?? null)
            : null;
          if (!modelSelection || typeof modelSelection !== "object"
            || String(modelDeterministicId || "") !== deterministicId) {
            return {
              ...base,
              selection_set: {
                status: "MODEL_SELECTION_UNAVAILABLE",
                action: "select",
                x, y,
                expected_deterministic_id: deterministicId || expectedDeterministicId || null,
                observed_deterministic_ids: observed,
              },
            };
          }
          const doPickSource = typeof v.doPick === "function"
            ? safe(() => Function.prototype.toString.call(v.doPick), "")
            : "";
          const doPickContractQualified = typeof v.doPick === "function"
            && Number(v.doPick.length) === 5
            && doPickSource.includes("this.pick(")
            && doPickSource.includes("getModelSelection")
            && doPickSource.includes("uiSelectionManager")
            && doPickSource.includes("handleEmptyUiPick")
            && doPickSource.includes("setUserIsManipulatingWithTimeout");
          if (!doPickContractQualified) {
            return {
              ...base,
              selection_set: {
                status: "DO_PICK_CONTRACT_MISMATCH",
                action: "select",
                x, y,
                expected_deterministic_id: deterministicId,
                observed_deterministic_ids: observed,
              },
            };
          }
          let dispatched = false;
          try {
            dispatched = !!v.doPick(x, y, true, true, { skipPreHighlight: false, shiftKey: false });
          } catch {}
          if (!dispatched) {
            return {
              ...base,
              selection_set: {
                status: "DO_PICK_DISPATCH_FAILED",
                action: "select",
                x, y,
                expected_deterministic_id: deterministicId,
                observed_deterministic_ids: observed,
              },
            };
          }
          await new Promise((resolve) => {
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(resolve));
            else setTimeout(resolve, 32);
          });
          const post = readSelection();
          const selectedIds = post.selections.map((item) => String(item.deterministic_id || "")).filter(Boolean);
          return {
            ...base,
            model_selection: post,
            selection_set: {
              status: selectedIds.includes(deterministicId) ? "VERIFIED" : "SELECTION_READBACK_MISMATCH",
              action: "select",
              route: "VIEWER_DO_PICK_SELECTION",
              x, y,
              expected_deterministic_id: deterministicId,
              observed_deterministic_ids: observed,
              selected_deterministic_ids: selectedIds,
            },
          };
        }

        if (mode === "hover_probe") {
          if (chosen.ready !== true) return { ...base, hover_set: { status: "NOT_READY" } };
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
            return { ...base, hover_set: { status: "NO_VIEWPORT" } };
          }
          if (typeof v.setHoveredSelection !== "function" || v.setHoveredSelection.length !== 1) {
            return { ...base, hover_set: { status: "SET_HOVERED_SELECTION_CONTRACT_MISMATCH" } };
          }
          if (!selectionManager || typeof selectionManager.getHoveredSelection !== "function") {
            return { ...base, hover_set: { status: "HOVER_READBACK_UNAVAILABLE" } };
          }
          let resolvedXFraction = xFraction;
          let resolvedYFraction = yFraction;
          let projectionDiagnostic = null;
          if (worldPoint && typeof worldPoint === "object") {
            if (safe(() => !!camera.isPerspective(), false)) {
              return { ...base, hover_set: { status: "WORLD_POINT_PERSPECTIVE_UNSUPPORTED" } };
            }
            const matrix = Array.isArray(viewData?.viewMatrix) ? viewData.viewMatrix : null;
            const viewport = Array.isArray(viewData?.cameraViewport) ? viewData.cameraViewport : null;
            const px = Number(worldPoint.x), py = Number(worldPoint.y), pz = Number(worldPoint.z);
            if (!matrix || matrix.length !== 16 || !viewport || viewport.length < 4
              || ![px, py, pz, ...matrix, ...viewport.slice(0, 4)].every(Number.isFinite)) {
              return { ...base, hover_set: { status: "WORLD_POINT_PROJECTION_UNAVAILABLE" } };
            }
            // Reuse the exact projection primitive qualified by the historical
            // Blind Re-Select proof: the Viewer viewMatrix is inverted as a full
            // column-major 4x4 matrix before projecting world geometry.
            const invert4ColumnMajor = (a) => {
              const m = Array.from({ length: 4 }, (_, row) =>
                Array.from({ length: 4 }, (_, col) => Number(a[col * 4 + row])));
              const aug = m.map((row, rowIndex) => [
                ...row,
                ...Array.from({ length: 4 }, (_, col) => rowIndex === col ? 1 : 0),
              ]);
              for (let col = 0; col < 4; col += 1) {
                let pivot = col;
                for (let row = col + 1; row < 4; row += 1) {
                  if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) pivot = row;
                }
                if (Math.abs(aug[pivot][col]) < 1e-12) return null;
                [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
                const divisor = aug[col][col];
                for (let j = 0; j < 8; j += 1) aug[col][j] /= divisor;
                for (let row = 0; row < 4; row += 1) {
                  if (row === col) continue;
                  const factor = aug[row][col];
                  for (let j = 0; j < 8; j += 1) aug[row][j] -= factor * aug[col][j];
                }
              }
              return aug.map((row) => row.slice(4));
            };
            const inverse = invert4ColumnMajor(matrix);
            if (!inverse) {
              return { ...base, hover_set: { status: "WORLD_POINT_PROJECTION_UNAVAILABLE" } };
            }
            const point = [px, py, pz, 1];
            const projected = inverse.map((row) =>
              row.reduce((sum, value, index) => sum + value * point[index], 0));
            if (!Number.isFinite(projected[3]) || Math.abs(projected[3]) < 1e-12) {
              return { ...base, hover_set: { status: "WORLD_POINT_PROJECTION_UNAVAILABLE" } };
            }
            const viewX = projected[0] / projected[3];
            const viewY = projected[1] / projected[3];
            const top = viewport[0], bottom = viewport[1], right = viewport[2], left = viewport[3];
            const spanX = right - left, spanY = top - bottom;
            if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || Math.abs(spanX) < 1e-12 || Math.abs(spanY) < 1e-12) {
              return { ...base, hover_set: { status: "WORLD_POINT_PROJECTION_UNAVAILABLE" } };
            }
            resolvedXFraction = (viewX - left) / spanX;
            resolvedYFraction = (top - viewY) / spanY;
            if (!Number.isFinite(resolvedXFraction) || !Number.isFinite(resolvedYFraction)
              || resolvedXFraction < 0 || resolvedXFraction > 1 || resolvedYFraction < 0 || resolvedYFraction > 1) {
              return {
                ...base,
                hover_set: {
                  status: "WORLD_POINT_OFFSCREEN",
                  projected_x_fraction: Number.isFinite(resolvedXFraction) ? resolvedXFraction : null,
                  projected_y_fraction: Number.isFinite(resolvedYFraction) ? resolvedYFraction : null,
                  projection_camera_width: width,
                  projection_camera_height: height,
                  projection_view_matrix: matrix.slice(0, 16),
                  projection_camera_viewport: viewport.slice(0, 4),
                  projection_is_perspective: false,
                },
              };
            }
            projectionDiagnostic = {
              projected_x_fraction: resolvedXFraction,
              projected_y_fraction: resolvedYFraction,
              projection_camera_width: width,
              projection_camera_height: height,
              projection_view_matrix: matrix.slice(0, 16),
              projection_camera_viewport: viewport.slice(0, 4),
              projection_is_perspective: false,
            };
          }
          const x = Math.max(0, Math.min(width - 1, Math.round(resolvedXFraction * (width - 1))));
          const y = Math.max(0, Math.min(height - 1, Math.round(resolvedYFraction * (height - 1))));
          if (projectionDiagnostic) {
            projectionDiagnostic.projected_x = x;
            projectionDiagnostic.projected_y = y;
          }
          const picks = Array.from(safe(() => v.pickInRect(x, y, 1, 1), []) || []).slice(0, 16);
          const observed = picks.map((pick) => typeof pick?.deterministicId === "string" ? pick.deterministicId : null).filter(Boolean);
          let match = null;
          if (expectedDeterministicId) {
            const matches = picks.filter((pick) => String(pick?.deterministicId || "") === String(expectedDeterministicId));
            if (matches.length !== 1) {
              if (matches.length === 0 && allowCameraFit) {
                const fitSource = typeof v.animateZoomFit === "function"
                  ? safe(() => Function.prototype.toString.call(v.animateZoomFit), "")
                  : "";
                const fitContractQualified = typeof v.animateZoomFit === "function"
                  && Number(v.animateZoomFit.length) === 1
                  && fitSource.includes("resetZoomToSelectionBounds()")
                  && fitSource.includes("getPrimaryViewController()?.animateZoomToFit")
                  && fitSource.includes("getFitBounds()");
                if (!fitContractQualified) {
                  return {
                    ...base,
                    hover_set: {
                      status: "CAMERA_FIT_CONTRACT_MISMATCH",
                      x,
                      y,
                      expected_deterministic_id: expectedDeterministicId || null,
                      observed_deterministic_ids: observed.slice(0, 16),
                      camera_fit_source: typeof fitSource === "string" ? fitSource.slice(0, 2400) : null,
                      ...(projectionDiagnostic || {}),
                    },
                  };
                }
                let fitDispatched = false;
                try {
                  v.animateZoomFit(false);
                  fitDispatched = true;
                } catch {}
                if (!fitDispatched) {
                  return {
                    ...base,
                    hover_set: {
                      status: "CAMERA_FIT_DISPATCH_FAILED",
                      x,
                      y,
                      expected_deterministic_id: expectedDeterministicId || null,
                      observed_deterministic_ids: observed.slice(0, 16),
                      camera_fit_source: fitSource.slice(0, 2400),
                      ...(projectionDiagnostic || {}),
                    },
                  };
                }
                await new Promise((resolve) => setTimeout(resolve, 350));
                return {
                  ...base,
                  hover_set: {
                    status: "CAMERA_FIT_DISPATCHED",
                    x,
                    y,
                    expected_deterministic_id: expectedDeterministicId || null,
                    observed_deterministic_ids: observed.slice(0, 16),
                    camera_fit_dispatched: true,
                    camera_fit_source: fitSource.slice(0, 2400),
                    ...(projectionDiagnostic || {}),
                  },
                };
              }
              return {
                ...base,
                hover_set: {
                  status: matches.length ? "AMBIGUOUS_EXPECTED_ID" : "EXPECTED_ID_NOT_PICKED",
                  x,
                  y,
                  expected_deterministic_id: expectedDeterministicId || null,
                  observed_deterministic_ids: observed.slice(0, 16),
                  ...(projectionDiagnostic || {}),
                },
              };
            }
            match = matches[0];
          } else {
            if (picks.length !== 1 || !observed[0]) {
              return {
                ...base,
                hover_set: {
                  status: picks.length ? "AMBIGUOUS_PICK" : "NO_PICK",
                  x,
                  y,
                  expected_deterministic_id: null,
                  observed_deterministic_ids: observed.slice(0, 16),
                  ...(projectionDiagnostic || {}),
                },
              };
            }
            match = picks[0];
          }
          const resolvedDeterministicId = String(match?.deterministicId || "");
          const getterUiSelection = safe(() => match.getUISelection?.(), null);
          const uiSelection = (match?.uiSelection && typeof match.uiSelection === "object")
            ? match.uiSelection
            : getterUiSelection;
          if (!uiSelection || typeof uiSelection !== "object") {
            const ownKeys = safe(() => Object.getOwnPropertyNames(match).slice(0, 48), []);
            const getterUiSelectionType = getterUiSelection === null
              ? "null"
              : Array.isArray(getterUiSelection) ? "array" : typeof getterUiSelection;
            const getterUiSelectionConstructor = getterUiSelection && typeof getterUiSelection === "object"
              ? safe(() => getterUiSelection.constructor?.name || null, null)
              : null;
            const getterUiSelectionOwnKeys = getterUiSelection && typeof getterUiSelection === "object"
              ? safe(() => Object.getOwnPropertyNames(getterUiSelection).slice(0, 32), [])
              : [];
            const isUiPick = safe(() => match.isUIPick?.(), null);
            const getterModelSelection = safe(() => match.getModelSelection?.(), null);
            const modelSelectionOwnKeys = getterModelSelection && typeof getterModelSelection === "object"
              ? safe(() => Object.getOwnPropertyNames(getterModelSelection).slice(0, 48), [])
              : [];
            const modelSelectionMethodMap = new Map();
            if (getterModelSelection && typeof getterModelSelection === "object") {
              let modelProtoCursor = getterModelSelection;
              let modelProtoDepth = 0;
              while (modelProtoCursor && modelProtoDepth < 5) {
                for (const key of safe(() => Object.getOwnPropertyNames(modelProtoCursor), [])) {
                  if (!/(select|source|pick|id|ui|model|get)/i.test(key)) continue;
                  const value = safe(() => getterModelSelection[key], null);
                  if (typeof value === "function" && !modelSelectionMethodMap.has(key)) {
                    modelSelectionMethodMap.set(key, { name: key, arity: Number(value.length) || 0 });
                  }
                }
                modelProtoCursor = safe(() => Object.getPrototypeOf(modelProtoCursor), null);
                modelProtoDepth += 1;
              }
            }
            const modelSelectionSourcePick = getterModelSelection && typeof getterModelSelection === "object"
              ? safe(() => getterModelSelection.getSourcePick?.(), getterModelSelection.sourcePick ?? null)
              : null;
            const createdBtUiSelection = getterModelSelection && typeof getterModelSelection === "object"
              ? safe(() => getterModelSelection.createBTUiSelection?.(), null)
              : null;
            const createdBtUiElement = createdBtUiSelection && typeof createdBtUiSelection === "object"
              && createdBtUiSelection.uiElement && typeof createdBtUiSelection.uiElement === "object"
              ? createdBtUiSelection.uiElement : null;
            const boundedFunctionSource = (fn) => {
              if (typeof fn !== "function") return null;
              const source = safe(() => Function.prototype.toString.call(fn), null);
              return typeof source === "string" ? source.slice(0, 1600) : null;
            };
            const methodMap = new Map();
            let protoCursor = match;
            let protoDepth = 0;
            while (protoCursor && protoDepth < 5) {
              for (const key of safe(() => Object.getOwnPropertyNames(protoCursor), [])) {
                if (!/(select|ui|hover|get)/i.test(key)) continue;
                const value = safe(() => match[key], null);
                if (typeof value === "function" && !methodMap.has(key)) {
                  methodMap.set(key, { name: key, arity: Number(value.length) || 0 });
                }
              }
              protoCursor = safe(() => Object.getPrototypeOf(protoCursor), null);
              protoDepth += 1;
            }
            const modelDeterministicId = getterModelSelection && typeof getterModelSelection === "object"
              ? safe(() => getterModelSelection.getDeterministicId?.(), null)
              : null;
            const doPickSourceForContract = typeof v.doPick === "function"
              ? safe(() => Function.prototype.toString.call(v.doPick), "")
              : "";
            const doPickContractQualified = typeof v.doPick === "function"
              && Number(v.doPick.length) === 5
              && doPickSourceForContract.includes("this.pick(")
              && doPickSourceForContract.includes("getModelSelection")
              && doPickSourceForContract.includes("uiSelectionManager")
              && doPickSourceForContract.includes("handleEmptyUiPick")
              && doPickSourceForContract.includes("setUserIsManipulatingWithTimeout");
            const canUseModelPreHighlight = getterModelSelection && typeof getterModelSelection === "object"
              && String(modelDeterministicId || "") === resolvedDeterministicId
              && doPickContractQualified;
            if (canUseModelPreHighlight) {
              const doPickResult = safe(
                () => !!v.doPick(x, y, true, true, { skipPreHighlight: false, shiftKey: false }),
                false,
              );
              const verificationDelayFrames = doPickResult ? 2 : 0;
              if (doPickResult) {
                await new Promise((resolve) => {
                  if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(() => requestAnimationFrame(resolve));
                  } else {
                    setTimeout(resolve, 32);
                  }
                });
              }
              const postPicks = Array.from(safe(() => v.pickInRect(x, y, 1, 1), []) || []).slice(0, 16);
              const postObserved = postPicks
                .map((pick) => typeof pick?.deterministicId === "string" ? pick.deterministicId : null)
                .filter(Boolean);
              const postMatches = postPicks.filter(
                (pick) => String(pick?.deterministicId || "") === resolvedDeterministicId,
              );
              const hoveredModel = safe(() => selectionManager.getHoveredSelection(), null);
              const hoveredModelDeterministicId = hoveredModel && typeof hoveredModel === "object"
                ? safe(() => hoveredModel.getDeterministicId?.(), hoveredModel.deterministicId ?? hoveredModel.deterministic_id ?? null)
                : null;
              const sameModelObject = hoveredModel === getterModelSelection;
              if (!doPickResult) {
                return {
                  ...base,
                  hover_set: {
                    status: "HOVER_READBACK_MISMATCH",
                    x,
                    y,
                    expected_deterministic_id: resolvedDeterministicId || expectedDeterministicId || null,
                    source_deterministic_id: String(modelDeterministicId || "") || null,
                    hovered_deterministic_id: String(hoveredModelDeterministicId || "") || null,
                    same_model_object: sameModelObject,
                    do_pick_result: doPickResult,
                    post_observed_deterministic_ids: postObserved,
                    verification_delay_frames: verificationDelayFrames,
                    do_pick_source: typeof doPickSourceForContract === "string"
                      ? doPickSourceForContract.slice(0, 2400) : null,
                    route: "VIEWER_DO_PICK_MODEL_PREHIGHLIGHT",
                    ...(projectionDiagnostic || {}),
                  },
                };
              }
              return {
                ...base,
                hover_set: {
                  status: "VERIFIED",
                  route: "VIEWER_DO_PICK_MODEL_PREHIGHLIGHT",
                  x,
                  y,
                  expected_deterministic_id: resolvedDeterministicId || expectedDeterministicId || null,
                  source_deterministic_id: String(modelDeterministicId || ""),
                  hovered_deterministic_id: String(hoveredModelDeterministicId || "") || null,
                  same_model_object: sameModelObject,
                  do_pick_result: true,
                  post_observed_deterministic_ids: postObserved,
                  verification_delay_frames: verificationDelayFrames,
                  do_pick_source: typeof doPickSourceForContract === "string"
                    ? doPickSourceForContract.slice(0, 2400) : null,
                  ...(projectionDiagnostic || {}),
                },
              };
            }
            return {
              ...base,
              hover_set: {
                status: "UI_SELECTION_UNAVAILABLE",
                x,
                y,
                expected_deterministic_id: resolvedDeterministicId || expectedDeterministicId || null,
                observed_deterministic_ids: observed.slice(0, 16),
                pick_constructor: safe(() => match.constructor?.name || null, null),
                pick_own_keys: ownKeys,
                pick_methods: [...methodMap.values()].slice(0, 64),
                is_ui_pick: typeof isUiPick === "boolean" ? isUiPick : null,
                get_ui_selection_type: getterUiSelectionType,
                get_ui_selection_constructor: getterUiSelectionConstructor,
                get_ui_selection_own_keys: getterUiSelectionOwnKeys,
                get_model_selection_type: getterModelSelection === null
                  ? "null" : Array.isArray(getterModelSelection) ? "array" : typeof getterModelSelection,
                get_model_selection_constructor: getterModelSelection && typeof getterModelSelection === "object"
                  ? safe(() => getterModelSelection.constructor?.name || null, null) : null,
                get_model_selection_own_keys: modelSelectionOwnKeys,
                get_model_selection_methods: [...modelSelectionMethodMap.values()].slice(0, 64),
                get_model_selection_id_string: getterModelSelection && typeof getterModelSelection === "object"
                  ? safe(() => getterModelSelection.getIdString?.(), getterModelSelection.selectionId ?? null) : null,
                get_model_selection_deterministic_id: getterModelSelection && typeof getterModelSelection === "object"
                  ? safe(() => getterModelSelection.getDeterministicId?.(), null) : null,
                get_model_selection_source_pick_same_object: modelSelectionSourcePick
                  ? modelSelectionSourcePick === match : null,
                created_bt_ui_selection_type: createdBtUiSelection === null
                  ? "null" : Array.isArray(createdBtUiSelection) ? "array" : typeof createdBtUiSelection,
                created_bt_ui_selection_constructor: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  ? safe(() => createdBtUiSelection.constructor?.name || null, null) : null,
                created_bt_ui_selection_own_keys: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  ? safe(() => Object.getOwnPropertyNames(createdBtUiSelection).slice(0, 48), []) : [],
                created_bt_ui_selection_selection_id: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  && typeof createdBtUiSelection.selectionId === "string"
                  ? createdBtUiSelection.selectionId : null,
                created_bt_ui_selection_mesh_increment_id: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  && typeof createdBtUiSelection.meshIncrementId === "string"
                  ? createdBtUiSelection.meshIncrementId : null,
                created_bt_ui_selection_id: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  && (typeof createdBtUiSelection.id === "string" || Number.isFinite(createdBtUiSelection.id))
                  ? createdBtUiSelection.id : null,
                created_bt_ui_selection_type_value: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  && (typeof createdBtUiSelection.type === "string" || Number.isFinite(createdBtUiSelection.type))
                  ? createdBtUiSelection.type : null,
                created_bt_ui_selection_deterministic_ids: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  && Array.isArray(createdBtUiSelection.deterministicIdList)
                  ? createdBtUiSelection.deterministicIdList.slice(0, 16).map((value) => String(value).slice(0, 240)) : [],
                created_bt_ui_selection_table_row_id: createdBtUiSelection && typeof createdBtUiSelection === "object"
                  && (typeof createdBtUiSelection.tableRowId === "string" || Number.isFinite(createdBtUiSelection.tableRowId))
                  ? createdBtUiSelection.tableRowId : null,
                created_bt_ui_element_constructor: createdBtUiElement
                  ? safe(() => createdBtUiElement.constructor?.name || null, null) : null,
                created_bt_ui_element_own_keys: createdBtUiElement
                  ? safe(() => Object.getOwnPropertyNames(createdBtUiElement).slice(0, 48), []) : [],
                viewer_do_pre_highlight_pick_available: typeof v.doPreHighlightPick === "function",
                viewer_do_pre_highlight_pick_arity: typeof v.doPreHighlightPick === "function"
                  ? Number(v.doPreHighlightPick.length) || 0 : null,
                viewer_do_pre_highlight_pick_source: boundedFunctionSource(v.doPreHighlightPick),
                viewer_do_pick_available: typeof v.doPick === "function",
                viewer_do_pick_arity: typeof v.doPick === "function" ? Number(v.doPick.length) || 0 : null,
                viewer_do_pick_source: boundedFunctionSource(v.doPick),
                viewer_pre_highlight_ui_selection_available: typeof v.preHighlightUiSelection === "function",
                viewer_pre_highlight_ui_selection_arity: typeof v.preHighlightUiSelection === "function"
                  ? Number(v.preHighlightUiSelection.length) || 0 : null,
                viewer_pre_highlight_ui_selection_source: boundedFunctionSource(v.preHighlightUiSelection),
                ...(projectionDiagnostic || {}),
              },
            };
          }
          v.setHoveredSelection(uiSelection);
          const hovered = safe(() => selectionManager.getHoveredSelection(), null);
          const sourceSelectionId = typeof uiSelection?.selectionId === "string" ? uiSelection.selectionId : null;
          const hoveredSelectionId = typeof hovered?.selectionId === "string" ? hovered.selectionId : null;
          const sameObject = hovered === uiSelection;
          const sameSelectionId = !!sourceSelectionId && sourceSelectionId === hoveredSelectionId;
          if (!hovered || (!sameObject && !sameSelectionId)) {
            return {
              ...base,
              hover_set: {
                status: "HOVER_READBACK_MISMATCH",
                x,
                y,
                expected_deterministic_id: resolvedDeterministicId || expectedDeterministicId || null,
                source_selection_id: sourceSelectionId,
                hovered_selection_id: hoveredSelectionId,
                same_object: sameObject,
              },
            };
          }
          return {
            ...base,
            hover_set: {
              status: "VERIFIED",
              route: "VIEWER_SET_HOVERED_SELECTION",
              x,
              y,
              expected_deterministic_id: resolvedDeterministicId || expectedDeterministicId || null,
              source_selection_id: sourceSelectionId,
              hovered_selection_id: hoveredSelectionId,
              same_object: sameObject,
            },
          };
        }

        if (mode === "methods") {
          return {
            ...base,
            methods: {
              viewer_constructor: safe(() => v.constructor?.name || null, null),
              camera_constructor: safe(() => camera?.constructor?.name || null, null),
              selection_constructor: safe(() => selectionManager?.constructor?.name || null, null),
              viewer: boundedMethods(v),
              camera: boundedMethods(camera),
              selection: boundedMethods(selectionManager),
            },
          };
        }
        if (mode === "method_details") {
          const boundedSource = (fn) => {
            if (typeof fn !== "function") return null;
            const source = safe(() => Function.prototype.toString.call(fn), null);
            return typeof source === "string" ? source.slice(0, 2400) : null;
          };
          const primaryViewController = safe(() => v.getPrimaryViewController?.(), null);
          const boundedMovementSources = (obj) => {
            if (!obj || typeof obj !== "object") return [];
            const found = [];
            let current = obj;
            let depth = 0;
            const seen = new Set();
            while (current && depth < 6 && found.length < 36) {
              for (const name of safe(() => Object.getOwnPropertyNames(current), [])) {
                if (seen.has(name) || !/(pan|zoom|rotat|view|camera|fit)/i.test(name)) continue;
                const desc = safe(() => Object.getOwnPropertyDescriptor(current, name), null);
                if (!desc || typeof desc.value !== "function") continue;
                seen.add(name);
                found.push({
                  name,
                  arity: Number.isInteger(desc.value.length) ? desc.value.length : null,
                  prototype_depth: depth,
                  source: boundedSource(desc.value)?.slice(0, 1600) || null,
                });
                if (found.length >= 36) break;
              }
              current = safe(() => Object.getPrototypeOf(current), null);
              depth += 1;
            }
            return found;
          };
          return {
            ...base,
            method_details: {
              fit_contracts: {
                viewer_animate_zoom_fit: {
                  available: typeof v.animateZoomFit === "function",
                  arity: typeof v.animateZoomFit === "function" ? Number(v.animateZoomFit.length) || 0 : null,
                  source: boundedSource(v.animateZoomFit),
                },
                camera_zoom_to_fit: {
                  available: typeof camera?.zoomToFit === "function",
                  arity: typeof camera?.zoomToFit === "function" ? Number(camera.zoomToFit.length) || 0 : null,
                  source: boundedSource(camera?.zoomToFit),
                },
                viewer_get_selection_fit_bounds: {
                  available: typeof v.getSelectionFitBounds === "function",
                  arity: typeof v.getSelectionFitBounds === "function" ? Number(v.getSelectionFitBounds.length) || 0 : null,
                  source: boundedSource(v.getSelectionFitBounds),
                },
              },
              movement_contracts: {
                viewer_rotate_in_direction: {
                  available: typeof v.rotateInDirection === "function",
                  arity: typeof v.rotateInDirection === "function" ? Number(v.rotateInDirection.length) || 0 : null,
                  source: boundedSource(v.rotateInDirection),
                },
                viewer_rotate_in_direction_with_angle: {
                  available: typeof v.rotateInDirectionWithAngle === "function",
                  arity: typeof v.rotateInDirectionWithAngle === "function" ? Number(v.rotateInDirectionWithAngle.length) || 0 : null,
                  source: boundedSource(v.rotateInDirectionWithAngle),
                },
                camera_pan: {
                  available: typeof camera?.pan === "function",
                  arity: typeof camera?.pan === "function" ? Number(camera.pan.length) || 0 : null,
                  source: boundedSource(camera?.pan),
                },
                camera_rotate_about: {
                  available: typeof camera?.rotateAbout === "function",
                  arity: typeof camera?.rotateAbout === "function" ? Number(camera.rotateAbout.length) || 0 : null,
                  source: boundedSource(camera?.rotateAbout),
                },
                camera_zoom: {
                  available: typeof camera?.zoom === "function",
                  arity: typeof camera?.zoom === "function" ? Number(camera.zoom.length) || 0 : null,
                  source: boundedSource(camera?.zoom),
                },
                camera_zoom_point: {
                  available: typeof camera?.zoomPoint === "function",
                  arity: typeof camera?.zoomPoint === "function" ? Number(camera.zoomPoint.length) || 0 : null,
                  source: boundedSource(camera?.zoomPoint),
                },
                camera_set_view_position_and_orientation: {
                  available: typeof camera?.setViewPositionAndOrientation === "function",
                  arity: typeof camera?.setViewPositionAndOrientation === "function" ? Number(camera.setViewPositionAndOrientation.length) || 0 : null,
                  source: boundedSource(camera?.setViewPositionAndOrientation),
                },
              },
              high_level_view_contracts: {
                viewer_animate_to_view: {
                  available: typeof v.animateToView === "function",
                  arity: typeof v.animateToView === "function" ? Number(v.animateToView.length) || 0 : null,
                  source: boundedSource(v.animateToView),
                },
                viewer_push_camera_state: {
                  available: typeof v.pushCameraState === "function",
                  arity: typeof v.pushCameraState === "function" ? Number(v.pushCameraState.length) || 0 : null,
                  source: boundedSource(v.pushCameraState),
                },
                viewer_pop_camera_state: {
                  available: typeof v.popCameraState === "function",
                  arity: typeof v.popCameraState === "function" ? Number(v.popCameraState.length) || 0 : null,
                  source: boundedSource(v.popCameraState),
                },
                viewer_sync_local_view: {
                  available: typeof v.onViewDidDrawSynchronizeLocalView === "function",
                  arity: typeof v.onViewDidDrawSynchronizeLocalView === "function" ? Number(v.onViewDidDrawSynchronizeLocalView.length) || 0 : null,
                  source: boundedSource(v.onViewDidDrawSynchronizeLocalView),
                },
                viewer_get_primary_view_controller: {
                  available: typeof v.getPrimaryViewController === "function",
                  arity: typeof v.getPrimaryViewController === "function" ? Number(v.getPrimaryViewController.length) || 0 : null,
                  source: boundedSource(v.getPrimaryViewController),
                },
              },
              primary_view_controller: {
                available: !!primaryViewController,
                constructor: safe(() => primaryViewController?.constructor?.name || null, null),
                methods: boundedMethods(primaryViewController),
                movement_sources: boundedMovementSources(primaryViewController),
                targeted_sources: {
                  animate_pan: {
                    available: typeof primaryViewController?.animatePan === "function",
                    arity: typeof primaryViewController?.animatePan === "function" ? Number(primaryViewController.animatePan.length) || 0 : null,
                    source: boundedSource(primaryViewController?.animatePan),
                  },
                  animate_zoom: {
                    available: typeof primaryViewController?.animateZoom === "function",
                    arity: typeof primaryViewController?.animateZoom === "function" ? Number(primaryViewController.animateZoom.length) || 0 : null,
                    source: boundedSource(primaryViewController?.animateZoom),
                  },
                  animate_rotation: {
                    available: typeof primaryViewController?.animateRotation === "function",
                    arity: typeof primaryViewController?.animateRotation === "function" ? Number(primaryViewController.animateRotation.length) || 0 : null,
                    source: boundedSource(primaryViewController?.animateRotation),
                  },
                  rotate_in_direction: {
                    available: typeof primaryViewController?.rotateInDirection === "function",
                    arity: typeof primaryViewController?.rotateInDirection === "function" ? Number(primaryViewController.rotateInDirection.length) || 0 : null,
                    source: boundedSource(primaryViewController?.rotateInDirection),
                  },
                  pan_left: {
                    available: typeof primaryViewController?.panLeft === "function",
                    arity: typeof primaryViewController?.panLeft === "function" ? Number(primaryViewController.panLeft.length) || 0 : null,
                    source: boundedSource(primaryViewController?.panLeft),
                  },
                  pan_right: {
                    available: typeof primaryViewController?.panRight === "function",
                    arity: typeof primaryViewController?.panRight === "function" ? Number(primaryViewController.panRight.length) || 0 : null,
                    source: boundedSource(primaryViewController?.panRight),
                  },
                  pan_up: {
                    available: typeof primaryViewController?.panUp === "function",
                    arity: typeof primaryViewController?.panUp === "function" ? Number(primaryViewController.panUp.length) || 0 : null,
                    source: boundedSource(primaryViewController?.panUp),
                  },
                  pan_down: {
                    available: typeof primaryViewController?.panDown === "function",
                    arity: typeof primaryViewController?.panDown === "function" ? Number(primaryViewController.panDown.length) || 0 : null,
                    source: boundedSource(primaryViewController?.panDown),
                  },
                  zoom_in: {
                    available: typeof primaryViewController?.zoomIn === "function",
                    arity: typeof primaryViewController?.zoomIn === "function" ? Number(primaryViewController.zoomIn.length) || 0 : null,
                    source: boundedSource(primaryViewController?.zoomIn),
                  },
                  zoom_out: {
                    available: typeof primaryViewController?.zoomOut === "function",
                    arity: typeof primaryViewController?.zoomOut === "function" ? Number(primaryViewController.zoomOut.length) || 0 : null,
                    source: boundedSource(primaryViewController?.zoomOut),
                  },
                },
              },
              viewer: methodDetails(v, [
                "preHighlightUiSelection",
                "setHoveredSelection",
                "clearHoveredSelection",
                "animateToView",
                "animateToStandardView",
                "animateToStandardViewIgnoringUIPanels",
                "animateZoomFit",
                "pushCameraState",
                "popCameraState",
                "rotateInDirection",
                "rotateInDirectionWithAngle",
              ]),
              camera: methodDetails(camera, [
                "pan",
                "rotateAbout",
                "zoom",
                "zoomPoint",
                "zoomToFit",
                "setViewPositionAndOrientation",
                "setFrame",
                "setViewport",
              ]),
              selection: methodDetails(selectionManager, [
                "setSelection",
                "setHoveredSelection",
                "overrideHoveredSelection",
                "reset",
                "removeSelectionForUiElement",
              ]),
            },
          };
        }
        if (mode !== "probe") return base;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
          return { ...base, probe: { status: "NO_VIEWPORT", picks: [] } };
        }
        const x = Math.max(0, Math.min(width - 1, Math.round(xFraction * (width - 1))));
        const y = Math.max(0, Math.min(height - 1, Math.round(yFraction * (height - 1))));
        const picks = safe(() => v.pickInRect(x, y, 1, 1), []) || [];
        return {
          ...base,
          probe: {
            status: picks.length ? "HIT" : "MISS",
            x,
            y,
            x_fraction: xFraction,
            y_fraction: yFraction,
            picks: Array.from(picks).slice(0, 8).map((pick) => ({
              id: safe(() => pick.getId?.(), null),
              deterministic_id: typeof pick?.deterministicId === "string" ? pick.deterministicId : null,
              body_id: safe(() => pick.getBodyId?.(), null),
              feature_ids: plain(safe(() => pick.getFeatureIds?.(), pick?.featureIdList ?? null)),
              entity_type: safe(() => pick.getEntityType?.(), null),
              is_vertex: safe(() => pick.isVertex?.(), null),
              is_edge: safe(() => pick.isEdge?.(), null),
              is_face: safe(() => pick.isFace?.(), null),
              is_body: safe(() => pick.isBody?.(), null),
              edge_type: safe(() => pick.getEdgeType?.(), null),
              surface_type: safe(() => pick.getSurfaceType?.(), null),
            })),
          },
        };
      }`;

      const result = await cdp.send("Runtime.callFunctionOn", {
        objectId: objectsId,
        functionDeclaration: fn,
        arguments: [
          { value: mode },
          { value: xFraction },
          { value: yFraction },
          { value: expectedDeterministicId },
          { value: worldPoint },
          { value: !!allowCameraFit },
        ],
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });
      if (result?.exceptionDetails) {
        const error = new Error("The bounded Onshape Viewer inspection call failed.");
        error.code = "VIEWER_RUNTIME_CALL_FAILED";
        throw error;
      }
      const value = result?.result?.value;
      if (!value || typeof value !== "object" || value?.self_test?.viewer_instance_found !== true) {
        const error = new Error("No usable live Onshape Viewer instance passed the bounded self-test.");
        error.code = "VIEWER_RUNTIME_INSTANCE_NOT_FOUND";
        error.viewer = value || null;
        throw error;
      }
      if ((mode === "probe" || mode === "hover_probe" || mode === "selection_scan") && value?.viewer?.ready !== true) {
        const error = new Error("The live Onshape Viewer exists but is not ready for drawing yet.");
        error.code = "VIEWER_RUNTIME_NOT_READY";
        throw error;
      }
      if (mode === "hover_probe" && value?.hover_set?.status !== "VERIFIED") {
        const error = new Error("The bounded Viewer hover route did not verify.");
        error.code = "VIEWER_HOVER_NOT_VERIFIED";
        error.hover_set = value?.hover_set || null;
        throw error;
      }
      if (mode === "selection_scan") {
        const queryDisplayEntities = async (exportKey, kind) => {
          const protoResult = await cdp.send("Runtime.evaluate", {
            expression: `(() => {
              const chunks = window.webpackChunkNewton;
              if (!Array.isArray(chunks)) return null;
              let req = null;
              const before = chunks.length;
              const chunkId = -Date.now();
              chunks.push([[chunkId], {}, (runtime) => { req = runtime; }]);
              if (chunks.length > before) chunks.splice(before);
              if (typeof req !== "function") return null;
              const C = req(45867)?.[${JSON.stringify(exportKey)}];
              return typeof C === "function" && C.prototype ? C.prototype : null;
            })()`,
            objectGroup,
            includeCommandLineAPI: false,
            silent: true,
            returnByValue: false,
            awaitPromise: false,
          });
          const entityPrototypeObjectId = protoResult?.result?.objectId;
          if (!entityPrototypeObjectId) {
            return { kind, export_key: exportKey, self_test: false, count: 0, active: [], sample: [] };
          }
          const queriedEntities = await cdp.send("Runtime.queryObjects", {
            prototypeObjectId: entityPrototypeObjectId,
            objectGroup,
          });
          const entityObjectsId = queriedEntities?.objects?.objectId;
          if (!entityObjectsId) {
            return { kind, export_key: exportKey, self_test: true, count: 0, active: [], sample: [] };
          }
          const scan = await cdp.send("Runtime.callFunctionOn", {
            objectId: entityObjectsId,
            functionDeclaration: `function(kind, exportKey) {
              const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
              const plain = (value, depth = 0) => {
                if (value == null || typeof value === "boolean" || typeof value === "string") {
                  return typeof value === "string" ? value.slice(0, 500) : value;
                }
                if (typeof value === "number") return Number.isFinite(value) ? value : null;
                if (depth >= 2) return "[depth-bound]";
                if (Array.isArray(value)) return value.slice(0, 32).map((item) => plain(item, depth + 1));
                if (ArrayBuffer.isView(value)) return Array.from(value).slice(0, 32);
                if (typeof value === "object") {
                  const out = {};
                  for (const key of safe(() => Object.getOwnPropertyNames(value).slice(0, 32), [])) {
                    const desc = safe(() => Object.getOwnPropertyDescriptor(value, key), null);
                    if (desc && Object.prototype.hasOwnProperty.call(desc, "value")) out[key] = plain(desc.value, depth + 1);
                  }
                  return out;
                }
                return null;
              };
              const summarize = (item, index) => ({
                index,
                kind,
                export_key: exportKey,
                setting_index: Number.isFinite(item?.settingIndex) ? item.settingIndex : null,
                id: safe(() => item.getId?.(), null),
                deterministic_id: safe(() => item.getDeterministicId?.(), typeof item?.deterministicId === "string" ? item.deterministicId : null),
                selection_id: typeof item?.selectionId === "string" ? item.selectionId : null,
                entity_type: safe(() => item.isFace?.() ? "FACE" : item.isEdge?.() ? "EDGE" : item.isVertex?.() ? "VERTEX" : item.isBody?.() ? "BODY" : null, null),
                body_id: safe(() => item.getBodyId?.(), null),
                feature_ids: plain(safe(() => item.getFeatureIds?.(), item?.featureIdList ?? null)),
                own: plain(item),
              });
              const count = Number(this.length) || 0;
              const active = [];
              const sample = [];
              for (let i = 0; i < count && (active.length < 48 || sample.length < 48); i += 1) {
                const item = this[i];
                if (!item || typeof item !== "object") continue;
                const summary = summarize(item, i);
                if (sample.length < 48) sample.push(summary);
                if (summary.setting_index !== 2 && active.length < 48) active.push(summary);
              }
              return { kind, export_key: exportKey, count, active, sample };
            }`,
            arguments: [{ value: kind }, { value: exportKey }],
            returnByValue: true,
            silent: true,
          });
          if (scan?.exceptionDetails) {
            const error = new Error("Viewer display-entity scan failed.");
            error.code = "VIEWER_SELECTION_SCAN_FAILED";
            throw error;
          }
          return { self_test: true, ...(scan?.result?.value || { kind, export_key: exportKey, count: 0, active: [], sample: [] }) };
        };
        return {
          ...value,
          selection_scan: {
            module_id: 45867,
            faces: await queryDisplayEntities("bjR", "FACE"),
            edges: await queryDisplayEntities("ZiX", "EDGE"),
          },
        };
      }
      return value;
    } catch (error) {
      await this._disposeViewerRuntimeCache().catch(() => {});
      throw error;
    }
  }


  async inspectFeatureReorderMachinery({ documentId, workspaceId, elementId }) {
    const did = String(documentId || "").trim();
    const wid = String(workspaceId || "").trim();
    const eid = String(elementId || "").trim();
    if (![did, wid, eid].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      const error = new Error("Feature reorder probe requires valid document/workspace/element ids.");
      error.code = "INVALID_FEATURE_REORDER_TARGET";
      throw error;
    }

    const opened = await this.openDocument(did, wid, eid);
    await this.waitForSettled(1200);
    const hygieneBefore = await this.assertUiInputHygiene(did, wid, eid);
    await this.page.keyboard.press("Space");
    await sleep(350);

    const dom = await this.page.evaluate(() => {
      const root = document.querySelector("#feature-list") || document.querySelector("#feature-list-container");
      const rows = root
        ? Array.from(root.querySelectorAll(".os-list-item.ns-user-feature, .os-list-item[feature-id], .os-list-item[data-id]"))
            .slice(0, 24)
        : [];
      const describe = (node) => {
        if (!(node instanceof Element)) return null;
        const attrs = {};
        for (const attr of Array.from(node.attributes || [])) {
          if (["id", "class", "feature-id", "data-id", "draggable", "role", "aria-label"].includes(attr.name)
            || attr.name.startsWith("data-")
            || attr.name.startsWith("ng-")) {
            attrs[attr.name] = String(attr.value).slice(0, 240);
          }
        }
        const ownKeys = Object.keys(node)
          .filter((key) => /react|angular|ng|sortable|drag|drop|dnd/i.test(key))
          .slice(0, 40);
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          attrs,
          text: String(node.innerText || node.textContent || "").trim().slice(0, 300),
          draggable: !!node.draggable,
          own_keys: ownKeys,
          rect: {
            x: Math.round(rect.x * 10) / 10,
            y: Math.round(rect.y * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          },
        };
      };
      const frameworkData = (node) => {
        const out = {};
        try {
          const jq = window.jQuery || window.$;
          if (typeof jq === "function") {
            const data = jq(node).data?.();
            out.jquery = {
              present: true,
              data_keys: data && typeof data === "object" ? Object.keys(data).slice(0, 40) : [],
            };
          } else {
            out.jquery = { present: false, data_keys: [] };
          }
        } catch (error) {
          out.jquery = { present: true, error: String(error?.message || error).slice(0, 200) };
        }
        try {
          const ng = window.angular;
          if (ng?.element) {
            const wrapped = ng.element(node);
            const scope = wrapped.scope?.() || wrapped.isolateScope?.() || null;
            out.angular = {
              present: true,
              version: String(ng.version?.full || ""),
              scope_keys: scope && typeof scope === "object"
                ? Object.keys(scope).filter((key) => !key.startsWith("$")).slice(0, 60)
                : [],
            };
          } else {
            out.angular = { present: false, version: "", scope_keys: [] };
          }
        } catch (error) {
          out.angular = { present: true, error: String(error?.message || error).slice(0, 200) };
        }
        return out;
      };
      return {
        url: location.href,
        root: describe(root),
        row_count: rows.length,
        rows: rows.map((row) => ({
          ...describe(row),
          feature_id: row.getAttribute("feature-id"),
          data_id: row.getAttribute("data-id"),
          framework: frameworkData(row),
          parent: describe(row.parentElement),
        })),
        root_framework: root ? frameworkData(root) : null,
        panel_opened_by_space: true,
        globals: {
          angular: !!window.angular,
          jquery: !!(window.jQuery || window.$),
          webpack_chunk_newton: Array.isArray(window.webpackChunkNewton),
        },
      };
    });

    const objectGroup = `cf-feature-reorder-${process.pid}-${Date.now()}`;
    const cdp = await this.page.context().newCDPSession(this.page);
    const eventTypes = /drag|drop|pointer|mouse/i;
    const listenerSet = async (label, expression) => {
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression,
        objectGroup,
        returnByValue: false,
        silent: true,
      });
      const objectId = evaluated?.result?.objectId;
      if (!objectId) return { label, listeners: [] };
      const result = await cdp.send("DOMDebugger.getEventListeners", {
        objectId,
        depth: 1,
        pierce: true,
      }).catch(() => ({ listeners: [] }));
      const listeners = (result?.listeners || [])
        .filter((listener) => eventTypes.test(String(listener.type || "")))
        .slice(0, 40)
        .map((listener) => ({
          type: String(listener.type || ""),
          use_capture: !!listener.useCapture,
          passive: !!listener.passive,
          once: !!listener.once,
          script_id: String(listener.scriptId || ""),
          line_number: Number(listener.lineNumber ?? -1),
          column_number: Number(listener.columnNumber ?? -1),
          handler_source: String(listener.handler?.description || "").slice(0, 900),
        }));
      return { label, listeners };
    };

    try {
      await cdp.send("Runtime.enable");
      const listenerEvidence = [];
      listenerEvidence.push(await listenerSet(
        "feature_root",
        'document.querySelector("#feature-list") || document.querySelector("#feature-list-container")',
      ));
      listenerEvidence.push(await listenerSet(
        "first_feature_row",
        'document.querySelector("#feature-list .os-list-item.ns-user-feature, #feature-list .os-list-item[feature-id], #feature-list-container .os-list-item.ns-user-feature, #feature-list-container .os-list-item[feature-id], #feature-list-container .os-list-item[data-id]")',
      ));
      listenerEvidence.push(await listenerSet("document", "document"));

      const moduleScan = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const chunks = window.webpackChunkNewton;
          if (!Array.isArray(chunks)) return { available: false, matches: [] };
          let req = null;
          const before = chunks.length;
          const chunkId = -Date.now();
          chunks.push([[chunkId], {}, (runtime) => { req = runtime; }]);
          if (chunks.length > before) chunks.splice(before);
          if (typeof req !== "function") return { available: false, matches: [] };
          const factories = req.m && typeof req.m === "object" ? req.m : {};
          const needles = [
            "feature-list", "feature-id", "reorder", "dragstart", "dragover",
            "rollbackindex", "movefeature", "featuretree", "treeedit",
          ];
          const matches = [];
          let scanned = 0;
          for (const [id, factory] of Object.entries(factories)) {
            scanned += 1;
            let source = "";
            try { source = String(factory); } catch { continue; }
            const lower = source.toLowerCase();
            const hits = needles.filter((needle) => lower.includes(needle));
            if (!hits.length) continue;
            const indexes = hits.map((needle) => lower.indexOf(needle)).filter((n) => n >= 0);
            const at = indexes.length ? Math.min(...indexes) : 0;
            matches.push({
              module_id: String(id),
              hits,
              snippet: source.slice(Math.max(0, at - 260), Math.min(source.length, at + 900)),
            });
            if (matches.length >= 40) break;
          }
          const focused = [];
          for (const id of ["27066"]) {
            const factory = factories[id];
            if (typeof factory !== "function") continue;
            let source = "";
            try { source = String(factory); } catch { continue; }
            const lower = source.toLowerCase();
            const occurrences = [];
            for (const needleRaw of [
              "mapNodeMovementToReorderFeaturesMsg",
              "subscribeToFeatureListReorderingObservables",
            ]) {
              const needle = needleRaw.toLowerCase();
              let from = 0;
              let count = 0;
              while (count < 3) {
                const at = lower.indexOf(needle, from);
                if (at < 0) break;
                occurrences.push({
                  needle: needleRaw,
                  index: at,
                  snippet: source.slice(Math.max(0, at - 700), Math.min(source.length, at + 3200)),
                });
                from = at + needle.length;
                count += 1;
              }
            }

            let export_surface = null;
            let controller_surface = null;
            try {
              const loaded = req(Number(id));
              const Controller = loaded?.n;
              const methodNames = [
                "mapNodeMovementToReorderFeaturesMsg",
                "subscribeToFeatureListReorderingObservables",
                "getFeatureWrapperForFeatureId",
                "getFeatureWrapperForNodeId",
                "getFeatureListView",
                "getIsFeatureReorderAllowed",
              ];
              export_surface = {
                loaded: true,
                keys: Object.keys(loaded || {}).slice(0, 40),
                controller_export: typeof Controller === "function",
                controller_name: typeof Controller === "function" ? String(Controller.name || "") : "",
                methods: typeof Controller === "function" && Controller.prototype
                  ? methodNames.map((name) => {
                      let methodSource = "";
                      try { methodSource = String(Controller.prototype[name]); } catch {}
                      return {
                        name,
                        exists: typeof Controller.prototype[name] === "function",
                        source: methodSource.slice(0, 4200),
                      };
                    })
                  : [],
              };

              const root = document.querySelector("#feature-list");
              const candidates = [];
              const seen = new Set();
              const nodes = [];
              if (root) {
                nodes.push(root);
                let parent = root.parentElement;
                for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) nodes.push(parent);
                nodes.push(...Array.from(root.querySelectorAll("*")).slice(0, 160));
              }
              for (const node of nodes) {
                let data = null;
                try { data = window.angular?.element(node)?.data?.() || null; } catch {}
                if (!data || typeof data !== "object") continue;
                for (const [key, value] of Object.entries(data)) {
                  if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
                  const isController = typeof Controller === "function" && value instanceof Controller;
                  const hasMapper = typeof value.mapNodeMovementToReorderFeaturesMsg === "function";
                  if (!isController && !hasMapper) continue;
                  if (seen.has(value)) continue;
                  seen.add(value);
                  const proto = Object.getPrototypeOf(value);
                  candidates.push({
                    key,
                    tag: node.tagName,
                    id: String(node.id || ""),
                    class_name: String(node.className || "").slice(0, 240),
                    is_controller_instance: isController,
                    has_mapper: hasMapper,
                    constructor_name: String(value.constructor?.name || ""),
                    prototype_methods: proto
                      ? Object.getOwnPropertyNames(proto)
                          .filter((name) => /move|reorder|feature|list|drag/i.test(name))
                          .slice(0, 100)
                      : [],
                    has_feature_list_view: !!value.featureListView,
                    has_element_connection: !!value.elementConnection,
                    has_part_studio_model: !!value.partStudioElementModel,
                    feature_list_view_methods: value.featureListView
                      ? Object.getOwnPropertyNames(Object.getPrototypeOf(value.featureListView) || {})
                          .filter((name) => /reorder|move|drag|node|list|observable/i.test(name))
                          .slice(0, 100)
                      : [],
                  });
                }
              }
              controller_surface = { candidate_count: candidates.length, candidates: candidates.slice(0, 12) };
            } catch (error) {
              export_surface = { loaded: false, error: String(error?.message || error).slice(0, 300), methods: [] };
              controller_surface = { candidate_count: 0, candidates: [], error: String(error?.message || error).slice(0, 300) };
            }

            focused.push({
              module_id: id,
              source_length: source.length,
              occurrences,
              export_surface,
              controller_surface,
            });
          }
          let active_element_helper = null;
          try {
            const helperMod = req(22873);
            const helperEntries = [];
            let activeElement = null;
            let activeGetter = null;
            for (const [key, value] of Object.entries(helperMod || {})) {
              if (typeof value !== "function") continue;
              const staticMethods = Object.getOwnPropertyNames(value)
                .filter((name) => /open|document|active|element|feature|tree|reorder|node/i.test(name))
                .slice(0, 100);
              helperEntries.push({
                key,
                name: String(value.name || ""),
                static_methods: staticMethods,
              });
              if (!activeGetter && typeof value.getOpenDocumentActiveElement === "function") {
                activeGetter = value;
              }
            }
            if (activeGetter) {
              try { activeElement = activeGetter.getOpenDocumentActiveElement(); } catch {}
            }
            let active = null;
            if (activeElement) {
              const proto = Object.getPrototypeOf(activeElement);
              const ownKeys = Object.keys(activeElement).filter((name) =>
                /connection|element|node|feature|tree|model|workspace|document/i.test(name)
              ).slice(0, 120);
              const protoMethods = proto
                ? Object.getOwnPropertyNames(proto)
                    .filter((name) => /connection|element|node|feature|tree|model|location|reorder|move|map/i.test(name))
                    .slice(0, 160)
                : [];
              active = {
                constructor_name: String(activeElement.constructor?.name || ""),
                own_keys: ownKeys,
                prototype_methods: protoMethods,
                element_id: typeof activeElement.getElementId === "function"
                  ? String(activeElement.getElementId() || "")
                  : String(activeElement.get?.("elementId") || ""),
                has_map_nodes: typeof activeElement.mapNodes === "function",
                has_location_after_node: typeof activeElement.locationAfterNode === "function",
                has_location_before_node: typeof activeElement.locationBeforeNode === "function",
                has_get_node_from_feature: typeof activeElement.getNodeModelFromFeatureId === "function",
                has_get_element_connection: typeof activeElement.getElementConnection === "function",
                connection_property: Object.keys(activeElement).find((name) => /elementConnection/i.test(name)) || null,
              };
            }
            active_element_helper = {
              module_keys: Object.keys(helperMod || {}).slice(0, 80),
              helpers: helperEntries,
              getter_found: !!activeGetter,
              active_element_found: !!activeElement,
              active,
            };
          } catch (error) {
            active_element_helper = {
              error: String(error?.message || error).slice(0, 320),
              getter_found: false,
              active_element_found: false,
            };
          }

          return {
            available: true,
            scanned,
            match_count: matches.length,
            matches: matches
              .filter((row) => ["27066", "22873"].includes(String(row.module_id)))
              .map((row) => ({ ...row, snippet: String(row.snippet || "").slice(0, 700) })),
            focused,
            active_element_helper,
          };
        })()`,
        objectGroup,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });

      const hygieneAfter = await this.assertUiInputHygiene(did, wid, eid, hygieneBefore.page_count);
      return {
        ...opened,
        probe: "FEATURE_REORDER_TIER2_MACHINERY",
        hygiene: { before: hygieneBefore, after: hygieneAfter },
        dom,
        listeners: listenerEvidence,
        webpack: moduleScan?.result?.value || { available: false, matches: [] },
      };
    } finally {
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }

  async _syntheticFeatureReorderOnCurrentPage({ sourceFeatureId, targetFeatureId, placement }) {
    const sourceId = String(sourceFeatureId || "").trim();
    const targetId = String(targetFeatureId || "").trim();
    const where = String(placement || "").trim().toLowerCase();
    if (![sourceId, targetId].every((value) => /^[A-Za-z0-9_.:-]{1,180}$/.test(value))) {
      const error = new Error("Feature reorder requires exact source and target feature ids.");
      error.code = "FEATURE_REORDER_ID_INVALID";
      throw error;
    }
    if (!["before", "after"].includes(where)) {
      const error = new Error("Feature reorder placement must be before or after.");
      error.code = "FEATURE_REORDER_PLACEMENT_INVALID";
      throw error;
    }

    await this.waitForSettled(900);
    let rootCount = await this.page.locator("#feature-list").count();
    if (rootCount !== 1) {
      await this.page.keyboard.press("Space").catch(() => {});
      for (let attempt = 1; attempt <= 32; attempt += 1) {
        await sleep(250);
        rootCount = await this.page.locator("#feature-list").count();
        if (rootCount === 1) break;
      }
    }
    if (rootCount !== 1) {
      const error = new Error(`Feature-list root resolved to ${rootCount} elements.`);
      error.code = rootCount === 0 ? "FEATURE_REORDER_LIST_NOT_FOUND" : "FEATURE_REORDER_LIST_AMBIGUOUS";
      throw error;
    }

    const sourceSelector = `#feature-list .os-list-item[feature-id=${JSON.stringify(sourceId)}]`;
    const targetSelector = `#feature-list .os-list-item[feature-id=${JSON.stringify(targetId)}]`;
    let sourceCount = 0;
    let targetCount = 0;
    for (let attempt = 1; attempt <= 32; attempt += 1) {
      [sourceCount, targetCount] = await Promise.all([
        this.page.locator(sourceSelector).count(),
        this.page.locator(targetSelector).count(),
      ]);
      if (sourceCount === 1 && targetCount === 1) break;
      if (attempt < 32) await sleep(250);
    }
    if (sourceCount !== 1 || targetCount !== 1) {
      const error = new Error(`Feature reorder rows resolved source=${sourceCount}, target=${targetCount}.`);
      error.code = "FEATURE_REORDER_ROW_IDENTITY_MISMATCH";
      throw error;
    }

    const result = await this.page.evaluate(async ({ sourceId, targetId, where }) => {
      const src = document.querySelector(`#feature-list .os-list-item[feature-id="${CSS.escape(sourceId)}"]`);
      const dst = document.querySelector(`#feature-list .os-list-item[feature-id="${CSS.escape(targetId)}"]`);
      if (!src || !dst) return { status: "ROW_NOT_FOUND", source: !!src, target: !!dst };

      src.scrollIntoView({ block: "nearest" });
      dst.scrollIntoView({ block: "nearest" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const sr = src.getBoundingClientRect();
      const dr = dst.getBoundingClientRect();
      const sx = sr.left + sr.width * 0.55;
      const sy = sr.top + sr.height * 0.5;
      const tx = dr.left + dr.width * 0.55;
      const ty = where === "before" ? dr.top + 2 : dr.bottom - 2;
      const log = [];

      const fire = (el, type, Ctor, opts) => {
        const ev = new Ctor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: opts.x,
          clientY: opts.y,
          screenX: opts.x,
          screenY: opts.y,
          button: opts.button ?? 0,
          buttons: opts.buttons ?? 1,
          ...(opts.extra || {}),
        });
        const accepted = el.dispatchEvent(ev);
        log.push({
          type,
          target: el.getAttribute?.("feature-id") || el.tagName || "document",
          accepted,
          defaultPrevented: ev.defaultPrevented,
          isTrusted: ev.isTrusted,
        });
      };

      fire(src, "pointerdown", PointerEvent, {
        x: sx, y: sy,
        extra: { pointerId: 1, pointerType: "mouse", isPrimary: true },
      });
      fire(src, "mousedown", MouseEvent, { x: sx, y: sy });
      for (let step = 1; step <= 8; step += 1) {
        const x = sx + (tx - sx) * step / 8;
        const y = sy + (ty - sy) * step / 8;
        const el = document.elementFromPoint(x, y) || document;
        fire(el, "pointermove", PointerEvent, {
          x, y,
          extra: { pointerId: 1, pointerType: "mouse", isPrimary: true },
        });
        fire(el, "mousemove", MouseEvent, { x, y });
        await new Promise((resolve) => setTimeout(resolve, 35));
      }

      let dt = null;
      try { dt = new DataTransfer(); } catch {}
      if (dt) {
        for (const type of ["dragstart", "dragenter", "dragover", "drop", "dragend"]) {
          const el = (type === "dragstart" || type === "dragend") ? src : dst;
          const ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: tx,
            clientY: ty,
            dataTransfer: dt,
          });
          const accepted = el.dispatchEvent(ev);
          log.push({
            type,
            target: el.getAttribute?.("feature-id") || el.tagName,
            accepted,
            defaultPrevented: ev.defaultPrevented,
            isTrusted: ev.isTrusted,
          });
        }
      }

      const end = document.elementFromPoint(tx, ty) || dst;
      fire(end, "mouseup", MouseEvent, { x: tx, y: ty, buttons: 0 });
      fire(end, "pointerup", PointerEvent, {
        x: tx, y: ty, buttons: 0,
        extra: { pointerId: 1, pointerType: "mouse", isPrimary: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return {
        status: "INPUT_SEQUENCE_COMPLETED",
        route: "FEATURE_LIST_SYNTHETIC_POINTER_MOUSE_DRAG",
        source_feature_id: sourceId,
        target_feature_id: targetId,
        placement: where,
        coords: { sx, sy, tx, ty },
        drag_event_count: log.length,
        untrusted_events: log.every((row) => row.isTrusted === false),
      };
    }, { sourceId, targetId, where });

    if (String(result?.status || "") !== "INPUT_SEQUENCE_COMPLETED") {
      const error = new Error(`Feature reorder input sequence failed: ${String(result?.status || "UNKNOWN")}`);
      error.code = "FEATURE_REORDER_INPUT_FAILED";
      throw error;
    }
    return result;
  }

  async reorderFeature({ documentId, workspaceId, elementId, sourceFeatureId, targetFeatureId, placement }) {
    const did = String(documentId || "").trim();
    const wid = String(workspaceId || "").trim();
    const eid = String(elementId || "").trim();
    if (![did, wid, eid].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      const error = new Error("Feature reorder requires valid document/workspace/element ids.");
      error.code = "INVALID_FEATURE_REORDER_TARGET";
      throw error;
    }

    const opened = await this.openDocument(did, wid, eid);
    await this.waitForSettled(1200);
    const hygieneBefore = await this.assertUiInputHygiene(did, wid, eid);
    const input = await this._syntheticFeatureReorderOnCurrentPage({
      sourceFeatureId,
      targetFeatureId,
      placement,
    });
    const hygieneAfter = await this.assertUiInputHygiene(did, wid, eid, hygieneBefore.page_count);
    return {
      ...opened,
      page_lease: "PERSISTENT_WORK_PAGE",
      hygiene: { before: hygieneBefore, after: hygieneAfter },
      ...input,
    };
  }

  async setPartVisibility({ documentId, workspaceId, elementId, partId, partName, visible }) {
    const did = String(documentId || "").trim();
    const wid = String(workspaceId || "").trim();
    const eid = String(elementId || "").trim();
    const pid = String(partId || "").trim();
    const expectedName = String(partName || "").trim();
    if (![did, wid, eid].every((value) => /^[0-9a-fA-F]{24}$/.test(value))) {
      const error = new Error("Part visibility requires valid document/workspace/element ids.");
      error.code = "INVALID_VISIBILITY_TARGET";
      throw error;
    }
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(pid) || !expectedName || expectedName.length > 300) {
      const error = new Error("Part visibility requires an exact resolved part id and name.");
      error.code = "INVALID_VISIBILITY_TARGET";
      throw error;
    }
    if (typeof visible !== "boolean") {
      const error = new Error("Part visibility requires a boolean desired state.");
      error.code = "INVALID_VISIBILITY_STATE";
      throw error;
    }

    const opened = await this.openDocument(did, wid, eid);
    const hygieneBefore = await this.assertUiInputHygiene(did, wid, eid);
    await this.page.keyboard.press("Space");

    const selector = `#part-list .os-list-item[data-id=${JSON.stringify(pid)}]`;
    const row = this.page.locator(selector);
    const count = await row.count();
    if (count !== 1) {
      const error = new Error(`Exact Parts-list identity resolved to ${count} rows.`);
      error.code = count === 0 ? "VISIBILITY_ROW_NOT_FOUND" : "VISIBILITY_ROW_AMBIGUOUS";
      throw error;
    }
    const rowText = String(await row.first().innerText()).trim();
    if (!rowText.split(/\r?\n/).map((value) => value.trim()).includes(expectedName) && rowText !== expectedName) {
      const error = new Error("Parts-list row identity does not match the resolved part name.");
      error.code = "VISIBILITY_ROW_IDENTITY_MISMATCH";
      throw error;
    }

    await row.first().click();
    await this.assertUiInputHygiene(did, wid, eid, hygieneBefore.page_count);
    const shortcut = visible ? "Shift+Y" : "y";
    await this.page.keyboard.press(shortcut);
    const hygieneAfter = await this.assertUiInputHygiene(did, wid, eid, hygieneBefore.page_count);

    return {
      ...opened,
      part_id: pid,
      part_name: expectedName,
      desired_visible: visible,
      shortcut,
      selector_basis: "#part-list .os-list-item[data-id=<exact-part-id>]",
      row_text: rowText,
      acknowledgement: "INPUT_SEQUENCE_COMPLETED",
      verification: "DIRECTIONAL_ONSHAPE_HIDE_SHOW_COMMAND",
      hygiene: { before: hygieneBefore, after: hygieneAfter },
      final_url: this.page.url(),
    };
  }

  async waitForSettled(ms = 1200) {
    await Promise.race([
      this.page.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => null),
      sleep(ms),
    ]);
  }

  async detectVerificationInput() {
    return firstVisible(this.page, [
      'input[autocomplete="one-time-code"]',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[type="tel"]',
    ]);
  }

  async establishSessionFromFreshProfile(account, password) {
    const tempProfile = `/tmp/cf-onshape-login-${process.pid}-${Date.now()}`;
    let tempContext = null;
    try {
      fs.rmSync(tempProfile, { recursive: true, force: true });
      tempContext = await chromium.launchPersistentContext(tempProfile, {
        headless: true,
        chromiumSandbox: false,
        viewport: { width: 1440, height: 1000 },
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = tempContext.pages()[0] || (await tempContext.newPage());
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(45_000);

      const authProbe = async () => {
        try {
          const probe = await onshapeRequest(
            page,
            { method: "GET", path: "/api/users/current" },
            this.requestContext(),
          );
          const d = probe && typeof probe.body === "object" && probe.body !== null ? probe.body : null;
          const id = d?.id ?? d?.userId ?? d?.user?.id ?? d?.user?.userId ?? d?.currentUser?.id ?? null;
          return {
            state: (probe?.http === 401 || probe?.http === 403) ? "REJECTED" : (probe?.ok && id) ? "PROVEN" : "UNKNOWN",
            account_id: id ? String(id).slice(0, 200) : null,
            request_origin: probe?.issuedFrom || null,
            http_status: Number.isFinite(probe?.http) ? probe.http : null,
          };
        } catch {
          return { state: "UNKNOWN", account_id: null, request_origin: null, http_status: null };
        }
      };

      await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });
      let emailDone = false;
      let passwordDone = false;
      let proven = null;

      for (let step = 0; step < 45; step++) {
        const auth = await authProbe();
        if (auth.state === "PROVEN") { proven = auth; break; }

        const verification = await firstVisible(page, [
          'input[autocomplete="one-time-code"]',
          'input[name*="code" i]',
          'input[id*="code" i]',
          'input[type="tel"]',
        ]);
        if (verification) {
          const error = new Error("Fresh-profile login requires an e-mail verification code.");
          error.code = "FRESH_LOGIN_VERIFICATION_REQUIRED";
          throw error;
        }

        const body = await page.locator("body").innerText().catch(() => "");
        if (/captcha|recaptcha|robot/i.test(body)) {
          const error = new Error("Fresh-profile login presented an interactive anti-bot challenge.");
          error.code = "INTERACTIVE_CHALLENGE_REQUIRED";
          throw error;
        }
        if (/approve.*device|device.*approval|verify.*identity|confirm.*identity/i.test(body)) {
          const error = new Error("Fresh-profile login presented a device or identity approval challenge.");
          error.code = "DEVICE_OR_IDENTITY_CHALLENGE";
          throw error;
        }

        const email = await firstVisible(page, [
          'input[type="email"]',
          'input[autocomplete="username"]',
          'input[name*="email" i]',
          'input[id*="email" i]',
        ]);
        const pass = await firstVisible(page, [
          'input[type="password"]',
          'input[autocomplete="current-password"]',
          'input[name*="password" i]',
        ]);

        if (email && !emailDone) {
          await email.fill("");
          await email.pressSequentially(account, { delay: 10 });
          emailDone = true;
          const continueButton = page
            .locator('button.continue-button, button:has-text("Continue"), button:has-text("Next")')
            .filter({ visible: true })
            .first();
          let enabled = false;
          for (let i = 0; i < 20; i++) {
            try { enabled = await continueButton.isEnabled({ timeout: 100 }); } catch {}
            if (enabled) break;
            await sleep(100);
          }
          if (enabled) await continueButton.click();
          else await email.press("Enter");
          await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => null);
          await sleep(500);
          continue;
        }

        if (pass && !passwordDone) {
          await pass.fill("");
          await pass.pressSequentially(password, { delay: 10 });
          passwordDone = true;
          const submit = await firstVisible(page, [
            'button[type="submit"]:not([disabled])',
            'button:has-text("Sign in"):not([disabled])',
            'button:has-text("Log in"):not([disabled])',
            'button:has-text("Continue"):not([disabled])',
          ]);
          if (submit) await submit.click();
          else await pass.press("Enter");
          await page.waitForLoadState("domcontentloaded", { timeout: 7000 }).catch(() => null);
          await sleep(800);
          continue;
        }

        await sleep(500);
      }

      if (!proven) {
        const error = new Error("Fresh-profile login did not reach PROVEN authentication.");
        error.code = "FRESH_LOGIN_UNRESOLVED";
        throw error;
      }

      const storage = await tempContext.storageState();
      const cadCookies = storage.cookies.filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "");
        return domain === "onshape.com" || domain.endsWith(".onshape.com");
      });
      if (cadCookies.length === 0) {
        const error = new Error("Fresh-profile login produced no Onshape cookies.");
        error.code = "FRESH_LOGIN_COOKIE_STATE_MISSING";
        throw error;
      }

      await this.context.clearCookies();
      await this.context.addCookies(cadCookies);
      await this.page.goto(DOCUMENTS_URL, { waitUntil: "domcontentloaded" });
      await sleep(1200);
      const auth = await this.proveAuthentication();
      if (auth.state !== "PROVEN") {
        const error = new Error("Fresh-profile session transfer did not prove authentication.");
        error.code = "FRESH_PROFILE_TRANSFER_UNVERIFIED";
        error.auth = auth;
        throw error;
      }
      return { auth, recovered_via: "fresh-profile-session-transfer" };
    } finally {
      if (tempContext) await tempContext.close().catch(() => null);
      fs.rmSync(tempProfile, { recursive: true, force: true });
    }
  }

  async login(progress) {
    await this.ensureBrowser();
    { const auth = await this.proveAuthentication(); if (auth.state === "PROVEN") return { auth }; }
    const { account, password } = this.readCredentials();
    await this.page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });

    let emailDone = false;
    let passwordDone = false;
    let emptyFormSteps = 0;
    let originResetDone = false;
    let freshRecoveryDone = false;
    for (let step = 0; step < 75; step++) {
      { const auth = await this.proveAuthentication(); if (auth.state === "PROVEN") return { auth }; }

      const verification = await this.detectVerificationInput();
      if (verification) {
        progress.awaitInput("EMAIL_VERIFICATION_CODE");
        return null;
      }

      const body = await this.page.locator("body").innerText().catch(() => "");
      if (/captcha|robot|recaptcha/i.test(body)) {
        const error = new Error("Onshape presented an interactive anti-bot challenge.");
        error.code = "INTERACTIVE_CHALLENGE_REQUIRED";
        throw error;
      }
      if (/approve.*device|device.*approval|verify.*identity|confirm.*identity/i.test(body)) {
        const error = new Error("Onshape presented a device or identity approval challenge.");
        error.code = "DEVICE_OR_IDENTITY_CHALLENGE";
        throw error;
      }

      const email = await firstVisible(this.page, [
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[name*="email" i]',
        'input[id*="email" i]',
      ]);
      const pass = await firstVisible(this.page, [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[name*="password" i]',
      ]);

      if (email && !emailDone) {
        await email.fill("");
        await email.pressSequentially(account, { delay: 10 });
        emailDone = true;
        const continueButton = this.page
          .locator('button.continue-button, button:has-text("Continue"), button:has-text("Next")')
          .filter({ visible: true })
          .first();
        let enabled = false;
        for (let i = 0; i < 20; i++) {
          try { enabled = await continueButton.isEnabled({ timeout: 100 }); } catch {}
          if (enabled) break;
          await sleep(100);
        }
        if (enabled) await continueButton.click();
        else await email.press("Enter");
        await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => null);
        await sleep(500);
        continue;
      }

      if (pass && !passwordDone) {
        await pass.fill("");
        await pass.pressSequentially(password, { delay: 10 });
        passwordDone = true;
        const submit = await firstVisible(this.page, [
          'button[type="submit"]:not([disabled])',
          'button:has-text("Sign in"):not([disabled])',
          'button:has-text("Log in"):not([disabled])',
          'button:has-text("Continue"):not([disabled])',
        ]);
        if (submit) await submit.click();
        else await pass.press("Enter");
        await this.page.waitForLoadState("domcontentloaded", { timeout: 7000 }).catch(() => null);
        await sleep(800);
        continue;
      }

      if (!email && !pass) {
        emptyFormSteps += 1;
        if (emptyFormSteps >= 6 && !originResetDone && this.page.url().startsWith(SIGNIN_URL)) {
          originResetDone = true;
          let cdp = null;
          try {
            cdp = await this.context.newCDPSession(this.page);
            await cdp.send("Network.enable");
            await cdp.send("Network.clearBrowserCache");
            await cdp.send("Storage.clearDataForOrigin", { origin: CAD_ORIGIN, storageTypes: "all" });
          } catch (cause) {
            const error = new Error("Persistent Onshape origin state could not be reset.");
            error.code = "PERSISTENT_PROFILE_RECOVERY_FAILED";
            throw error;
          } finally {
            if (cdp) await cdp.detach().catch(() => null);
          }
          emailDone = false;
          passwordDone = false;
          emptyFormSteps = 0;
          await this.page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });
          await sleep(1500);
          continue;
        }
        if (originResetDone && emptyFormSteps >= 6 && !freshRecoveryDone && this.page.url().startsWith(SIGNIN_URL)) {
          freshRecoveryDone = true;
          return this.establishSessionFromFreshProfile(account, password);
        }
      } else {
        emptyFormSteps = 0;
      }

      await sleep(500);
    }
    const error = new Error("Onshape login did not reach PROVEN authentication or a verification-code state.");
    error.code = "LOGIN_STATE_UNRESOLVED";
    throw error;
  }

  async submitVerification(code) {
    await this.ensureBrowser();
    const value = String(code ?? "").trim();
    if (!/^[0-9A-Za-z-]{4,16}$/.test(value)) {
      const error = new Error("Verification code format is invalid.");
      error.code = "INVALID_VERIFICATION_CODE";
      throw error;
    }
    const input = await this.detectVerificationInput();
    if (!input) {
      const error = new Error("No verification-code input is currently visible.");
      error.code = "VERIFICATION_INPUT_NOT_FOUND";
      throw error;
    }
    await input.fill(value);
    const submit = await firstVisible(this.page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
    ]);
    if (submit) await submit.click(); else await input.press("Enter");
    for (let i = 0; i < 30; i++) {
      { const auth = await this.proveAuthentication(); if (auth.state === "PROVEN") return { auth }; }
      await sleep(1000);
    }
    const error = new Error("Verification code was submitted but authentication did not complete.");
    error.code = "VERIFICATION_NOT_ACCEPTED";
    throw error;
  }

  async fetchElements(documentId, workspaceId) {
    await this.ensureBrowser();
    if (!/^[0-9a-f]{24}$/i.test(documentId) || !/^[0-9a-f]{24}$/i.test(workspaceId)) {
      const error = new Error("Document/workspace ids must be 24 hexadecimal characters.");
      error.code = "INVALID_TARGET_ID";
      throw error;
    }
    const path = `/api/v10/documents/d/${documentId}/w/${workspaceId}/elements`;
    const response = await this.request("GET", path);
    if (!response.ok) {
      const error = new Error(`Onshape elements read failed with HTTP ${response.http ?? "unknown"}.`);
      error.code = "ONSHAPE_READ_FAILED";
      throw error;
    }
    const list = Array.isArray(response.body) ? response.body : [];
    return {
      count: list.length,
      elements: list.slice(0, 500).map((x) => ({
        id: x.id ?? null,
        name: x.name ?? null,
        elementType: x.elementType ?? null,
        microversionId: x.microversionId ?? null,
      })),
      truncated: list.length > 500,
    };
  }

  async fetchPartStudioFeatures(documentId, workspaceId, elementId) {
    await this.ensureBrowser();
    if (![documentId, workspaceId, elementId].every((x) => /^[0-9a-f]{24}$/i.test(x))) {
      const error = new Error("Document/workspace/element ids must be 24 hexadecimal characters.");
      error.code = "INVALID_TARGET_ID";
      throw error;
    }
    const path = `/api/v9/partstudios/d/${documentId}/w/${workspaceId}/e/${elementId}/features`;
    const response = await this.request("GET", path, { includeGeometryIds: true });
    if (!response.ok) {
      const error = new Error(`Onshape Part Studio features read failed with HTTP ${response.http ?? "unknown"}.`);
      error.code = "ONSHAPE_PARTSTUDIO_READ_FAILED";
      throw error;
    }
    const parsed = response.body && typeof response.body === "object" ? response.body : {};
    const features = Array.isArray(parsed?.features) ? parsed.features : [];
    const featureStates = parsed?.featureStates && typeof parsed.featureStates === "object" ? parsed.featureStates : {};
    const compact = features.slice(0, 500).map((x) => {
      const m = x?.message ?? x ?? {};
      const id = m.featureId ?? null;
      return {
        id,
        name: m.name ?? null,
        featureType: m.featureType ?? null,
        suppressed: m.suppressed ?? null,
        status: id ? (featureStates[id]?.featureStatus ?? null) : null,
      };
    });
    return {
      sourceMicroversion: parsed?.sourceMicroversion ?? null,
      count: features.length,
      features: compact,
      truncated: features.length > 500,
    };
  }

  async createDocument(name, ownerScope, folderId = null) {
    await this.ensureBrowser();
    const auth = await this.proveAuthentication({ force: false });
    if (auth.state !== "PROVEN") {
      const error = new Error(`Onshape authentication state is ${auth.state}.`);
      error.code = auth.state === "REJECTED" ? "SESSION_REJECTED" : "SESSION_UNKNOWN";
      error.auth = auth;
      throw error;
    }

    const documentName = String(name ?? "").trim();
    const scope = String(ownerScope ?? "").trim().toLowerCase();
    const destinationFolderId = folderId == null || String(folderId).trim() === "" ? null : String(folderId).trim();
    if (!documentName || documentName.length > 200 || /[\r\n\0]/.test(documentName)) {
      const error = new Error("Invalid document name.");
      error.code = "INVALID_DOCUMENT_NAME";
      throw error;
    }
    if (!["personal", "company"].includes(scope)) {
      const error = new Error("Owner scope must be personal or company.");
      error.code = "INVALID_OWNER_SCOPE";
      throw error;
    }
    if (destinationFolderId && !/^[0-9a-fA-F]{24}$/.test(destinationFolderId)) {
      const error = new Error("Folder id must be 24 hexadecimal characters.");
      error.code = "INVALID_FOLDER_ID";
      throw error;
    }

    const ownerId = scope === "personal" ? auth.account_id : this.companyOwnerId;
    const ownerType = scope === "personal" ? 0 : 1;
    if (!ownerId || !/^[0-9a-fA-F]{24}$/.test(ownerId)) {
      const error = new Error(`Owner id for ${scope} scope is unavailable or invalid.`);
      error.code = scope === "company" ? "COMPANY_OWNER_NOT_CONFIGURED" : "PERSONAL_OWNER_UNAVAILABLE";
      throw error;
    }

    const body = { name: documentName, ownerId, ownerType };
    if (destinationFolderId) body.parentId = destinationFolderId;
    const response = await this.request("POST", "/api/v10/documents", null, body);
    if (!response.ok) {
      const error = new Error(`Onshape document creation failed with HTTP ${response.http ?? "unknown"}.`);
      error.code = "ONSHAPE_DOCUMENT_CREATE_FAILED";
      throw error;
    }
    const parsed = response.body && typeof response.body === "object" ? response.body : {};
    return {
      documentId: parsed?.id ?? null,
      name: parsed?.name ?? documentName,
      owner_scope: scope,
      owner: { id: ownerId, type: ownerType === 0 ? "user" : "company" },
      parentId: parsed?.parentId ?? destinationFolderId,
      folder_id: destinationFolderId,
      defaultWorkspaceId: parsed?.defaultWorkspace?.id ?? null,
      via: destinationFolderId ? "api-owner-scope-folder-id" : "api-owner-scope-root",
      verified: true,
      http_status: response.http,
      request_contract: {
        path: "/api/v10/documents",
        anti_forgery_header: response?.antiForgery?.headerSent ?? null,
        helper: "onshape-request",
      },
    };
  }

  async request(method, path, query = null, body = undefined, options = {}) {
    await this.ensureBrowser();
    let normalizedPath = String(path ?? "").trim();
    if (!normalizedPath.startsWith("/")) normalizedPath = "/" + normalizedPath;
    if (!normalizedPath.startsWith("/api/")) normalizedPath = "/api" + normalizedPath;
    const response = await onshapeRequest(
      this.page,
      {
        method,
        path: normalizedPath,
        query: query || undefined,
        body,
        headers: options?.headers || undefined,
        multipart: options?.multipart || undefined,
      },
      this.requestContext(),
    );
    if (response?.http === 401 || response?.http === 403) {
      this.lastProvenAuth = null;
      this.lastProvenAuthAt = 0;
      const error = new Error(`Onshape authentication was rejected with HTTP ${response.http}.`);
      error.code = "SESSION_REJECTED";
      error.auth = {
        state: "REJECTED",
        account_id: null,
        request_origin: response?.issuedFrom || null,
        http_status: response.http,
        service_build_id: this.buildId,
      };
      throw error;
    }
    return response;
  }

  artifact(action, args = {}) {
    return this.artifactStore.handle(action, args);
  }

  readLocalOpenApiSpec() {
    if (!this.openApiFile) {
      const error = new Error("Local OpenAPI path is not configured.");
      error.code = "OPENAPI_PATH_NOT_CONFIGURED";
      throw error;
    }
    if (!fs.existsSync(this.openApiFile) || fs.statSync(this.openApiFile).size <= 1000) return null;
    try {
      const spec = JSON.parse(fs.readFileSync(this.openApiFile, "utf8"));
      return validateOpenApiSpec(spec) ? spec : null;
    } catch {
      return null;
    }
  }

  writeLocalOpenApiSpec(spec) {
    if (!validateOpenApiSpec(spec)) {
      const error = new Error("Refusing to cache an invalid Onshape OpenAPI document.");
      error.code = "OPENAPI_INVALID_SPEC";
      throw error;
    }
    fs.mkdirSync(new URL(".", "file://" + this.openApiFile).pathname, { recursive: true, mode: 0o700 });
    const tmp = this.openApiFile + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(spec), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.openApiFile);
    fs.chmodSync(this.openApiFile, 0o600);
  }

  async fetchLiveOpenApiSpec() {
    await this.ensureBrowser();
    const auth = await this.proveAuthentication({ force: false });
    if (auth.state !== "PROVEN") {
      const error = new Error(`Onshape authentication state is ${auth.state}.`);
      error.code = auth.state === "REJECTED" ? "SESSION_REJECTED" : "SESSION_UNKNOWN";
      error.auth = auth;
      throw error;
    }

    const result = await onshapeRequest(
      this.page,
      { method: "GET", path: "/api/openapi" },
      this.requestContext(),
    );
    if (!result.ok || !validateOpenApiSpec(result.body)) {
      const error = new Error(`Onshape OpenAPI fetch failed or returned an invalid document (HTTP ${result.http ?? "unknown"}).`);
      error.code = result.ok ? "OPENAPI_INVALID_SPEC" : "OPENAPI_FETCH_FAILED";
      throw error;
    }
    return result.body;
  }

  async ensureOpenApiSpec() {
    const local = this.readLocalOpenApiSpec();
    if (local) return { source: "local", path: this.openApiFile };

    const live = await this.fetchLiveOpenApiSpec();
    this.writeLocalOpenApiSpec(live);
    return { source: "refreshed", path: this.openApiFile };
  }

  async refreshOpenApiSpec() {
    const previous = this.readLocalOpenApiSpec();
    const current = await this.fetchLiveOpenApiSpec();
    const previousHash = previous ? sha256Json(previous) : null;
    const currentHash = sha256Json(current);
    const diff = diffOpenApi(previous, current);
    const changed = previousHash !== currentHash;
    let cacheUpdated = false;

    if (!previous || changed) {
      this.writeLocalOpenApiSpec(current);
      cacheUpdated = true;
    }

    return {
      checked_at: new Date().toISOString(),
      source: "official-live-openapi",
      previous_version: previous?.info?.version || null,
      current_version: current?.info?.version || null,
      previous_hash: previousHash,
      current_hash: currentHash,
      changed,
      cache_updated: cacheUpdated,
      coverage: auditOpenApiCoverage(current),
      ...diff,
    };
  }

  async lookupOpenApi(keyword) {
    const requested = String(keyword ?? "").trim();
    if (!requested || requested.length > 120 || /[\r\n\0]/.test(requested)) {
      const error = new Error("Invalid OpenAPI lookup keyword.");
      error.code = "INVALID_OPENAPI_KEYWORD";
      throw error;
    }
    const source = await this.ensureOpenApiSpec();
    const spec = JSON.parse(fs.readFileSync(this.openApiFile, "utf8"));
    const k = requested.toLowerCase();
    const hits = [];
    for (const [path, operations] of Object.entries(spec?.paths || {})) {
      for (const [method, operation] of Object.entries(operations || {})) {
        if (!operation || typeof operation !== "object") continue;
        const haystack = `${path} ${operation.summary || ""} ${operation.operationId || ""}`.toLowerCase();
        if (!haystack.includes(k)) continue;
        const bodyContent = operation.requestBody?.content || {};
        const contentTypes = Object.keys(bodyContent);
        const firstSchema = Object.values(bodyContent)[0]?.schema;
        hits.push({
          method: String(method).toUpperCase(),
          path,
          summary: operation.summary || null,
          operationId: operation.operationId || null,
          contentType: contentTypes[0] || null,
          requestBodySchema: firstSchema?.$ref ? String(firstSchema.$ref).split("/").pop() : null,
          parameters: Array.isArray(operation.parameters)
            ? operation.parameters.slice(0, 40).map((p) => ({
                name: p?.name ?? null,
                in: p?.in ?? null,
                required: !!p?.required,
                schema: p?.schema?.type ?? null,
              }))
            : [],
        });
      }
    }
    return {
      keyword: requested,
      count: hits.length,
      endpoints: hits.slice(0, 80),
      spec_source: source.source,
      spec_local: true,
      coverage: auditOpenApiCoverage(spec),
    };
  }

  async auditOpenApiCoverage() {
    await this.ensureOpenApiSpec();
    const spec = this.readLocalOpenApiSpec();
    if (!spec) {
      const error = new Error("Local OpenAPI specification is unavailable.");
      error.code = "OPENAPI_SPEC_UNAVAILABLE";
      throw error;
    }
    return auditOpenApiCoverage(spec);
  }

}