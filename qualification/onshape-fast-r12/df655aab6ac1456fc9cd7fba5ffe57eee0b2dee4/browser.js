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
    this.authCacheMs = 60_000;
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
    bound.ensureBrowser = async () => {
      if (!bound.context || bound.context !== this.context || page.isClosed()) {
        const error = new Error("UI page lease is no longer attached to the active browser context.");
        error.code = "UI_LEASE_PAGE_CLOSED";
        throw error;
      }
    };
    bound.close = async () => {
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
    const currentUrlKind = url ? (url.includes("/signin") ? "SIGNIN" : url.includes("/documents") ? "DOCUMENTS" : "OTHER") : "NONE";
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
    };
  }

  async openDocument(documentId, workspaceId, elementId) {
    const did = String(documentId || "").trim();
    const wid = String(workspaceId || "").trim();
    const eid = String(elementId || "").trim();
    for (const [label, value] of [["document_id", did], ["workspace_id", wid], ["element_id", eid]]) {
      if (!/^[0-9a-fA-F]{24}$/.test(value)) {
        const error = new Error(`Invalid ${label}.`);
        error.code = "INVALID_DOCUMENT_ROUTE";
        throw error;
      }
    }
    await this.ensureBrowser();
    const auth = await this.proveAuthentication({ force: false });
    if (auth.state !== "PROVEN") {
      const error = new Error(`Onshape authentication state is ${auth.state}.`);
      error.code = auth.state === "REJECTED" ? "SESSION_REJECTED" : "SESSION_UNKNOWN";
      error.auth = auth;
      throw error;
    }
    const expectedUrl = `${CAD_ORIGIN}/documents/${did}/w/${wid}/e/${eid}`;
    const beforeUrl = this.page.url();
    const alreadyOnTarget = beforeUrl === expectedUrl || beforeUrl.startsWith(expectedUrl + "?") || beforeUrl.startsWith(expectedUrl + "#");
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
          await this.page.goto(expectedUrl, { waitUntil: "domcontentloaded" });
          await this.waitForSettled(1500);
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
    return {
      document_id: did,
      workspace_id: wid,
      element_id: eid,
      url: currentUrl,
      title: await this.page.title().catch(() => null),
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
