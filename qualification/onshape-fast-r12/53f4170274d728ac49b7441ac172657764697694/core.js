import crypto from "node:crypto";
import { createRequire } from "node:module";
import { BrowserSession } from "./browser.js";

const require = createRequire(import.meta.url);
const { GlassworksApiScheduler } = require("./onshape-request.cjs");

function now() {
  return new Date().toISOString();
}

function cleanError(error) {
  return {
    code: error?.code || "INTERNAL_ERROR",
    message: String(error?.message || error?.name || "Internal error").slice(0, 300),
    ...(error?.auth && typeof error.auth === "object" ? { auth: error.auth } : {}),
    ...(error?.input_required ? { input_required: String(error.input_required).slice(0, 120) } : {}),
  };
}

class OperationStore {
  constructor(limit = 50) {
    this.limit = limit;
    this.items = new Map();
  }

  create(kind) {
    const operation = {
      operation_id: `op_${crypto.randomUUID()}`,
      kind,
      status: "RUNNING",
      created_at: now(),
      updated_at: now(),
      input_required: null,
      result: null,
      error: null,
    };
    this.items.set(operation.operation_id, operation);
    this.prune();
    return operation;
  }

  prune() {
    if (this.items.size <= this.limit) return;
    for (const [id, item] of this.items) {
      if (["SUCCEEDED", "FAILED"].includes(item.status)) {
        this.items.delete(id);
        if (this.items.size <= this.limit) break;
      }
    }
  }

  public(item) {
    return item ? JSON.parse(JSON.stringify(item)) : null;
  }
}

export class OnshapeCore {
  constructor(config) {
    this.scheduler = new GlassworksApiScheduler({
      minimumIntervalMs: config.minimumApiIntervalMs ?? 1000,
    });
    this.session = new BrowserSession({
      ...config,
      apiScheduler: this.scheduler,
      navigationGate: null,
    });
    this.operations = new OperationStore();
    this.pendingVerification = null;
    const interval = Number(config.keeperIntervalMs ?? process.env.ONSHAPE_KEEPER_INTERVAL_MS ?? 60_000);
    this.keeper = {
      interval_ms: Number.isInteger(interval) && interval >= 10_000 ? interval : 60_000,
      timer: null,
      running: false,
      ticks: 0,
      last_tick_at: null,
      last_state: null,
      last_http_status: null,
      auto_reauth_count: 0,
      last_auto_reauth_at: null,
      last_auto_reauth_operation_id: null,
      last_error: null,
    };
  }

  async initialize() {
    await this.session.ensureBrowser();
    this.startKeeper();
  }

  // Session keeper: proves auth on a fixed interval and re-authenticates on its own,
  // so owner commands never meet a 401. One probe at a time; never stacks reauths.
  startKeeper() {
    if (this.keeper.timer) return;
    const tick = () => { void this.keeperTick(); };
    this.keeper.timer = setInterval(tick, this.keeper.interval_ms);
    if (typeof this.keeper.timer.unref === "function") this.keeper.timer.unref();
    setTimeout(tick, 5_000).unref?.();
  }

  reauthInFlight() {
    for (const op of this.operations.items.values()) {
      if (op.kind === "REAUTH" && (op.status === "RUNNING" || op.status === "AWAITING_INPUT")) return op;
    }
    return null;
  }

  async keeperTick() {
    const k = this.keeper;
    if (k.running) return;
    k.running = true;
    try {
      k.ticks += 1;
      k.last_tick_at = now();
      if (this.reauthInFlight()) { k.last_state = "REAUTH_IN_FLIGHT"; return; }
      const auth = await this.session.proveAuthentication({ schedulerMaintenance: true, force: true });
      k.last_state = auth?.state || "UNKNOWN";
      k.last_http_status = auth?.http_status ?? null;
      k.last_error = null;
      if (auth?.state === "REJECTED") {
        const started = this.startReauth();
        k.auto_reauth_count += 1;
        k.last_auto_reauth_at = now();
        k.last_auto_reauth_operation_id = started.operation_id;
      }
    } catch (error) {
      k.last_error = cleanError(error).code;
    } finally {
      k.running = false;
    }
  }

  keeperStatus() {
    const { timer, ...rest } = this.keeper;
    return { ...rest, active: Boolean(timer) };
  }

  async close() {
    if (this.keeper.timer) clearInterval(this.keeper.timer);
    this.keeper.timer = null;
    await this.session.close();
  }

  async status() {
    return {
      session: await this.session.status(),
      scheduler: this.scheduler.status(),
      keeper: this.keeperStatus(),
    };
  }

  startReauth() {
    const op = this.operations.create("REAUTH");
    const progress = {
      awaitInput: (kind) => {
        op.status = "AWAITING_INPUT";
        op.input_required = kind;
        op.updated_at = now();
        this.pendingVerification = { operationId: op.operation_id };
      },
    };

    Promise.resolve()
      .then(() => this.session.loginPreservingWorkPage(progress))
      .then((result) => {
        if (op.status === "AWAITING_INPUT") return;
        op.status = "SUCCEEDED";
        op.result = result;
        op.updated_at = now();
      })
      .catch((error) => {
        op.status = "FAILED";
        op.error = cleanError(error);
        op.updated_at = now();
      });

    return { operation_id: op.operation_id };
  }

  submitVerification(code) {
    const pending = this.pendingVerification;
    const op = pending ? this.operations.items.get(pending.operationId) : null;
    if (!op || op.status !== "AWAITING_INPUT" || op.input_required !== "EMAIL_VERIFICATION_CODE") {
      const error = new Error("No Onshape re-auth operation is awaiting a verification code.");
      error.code = "NO_VERIFICATION_PENDING";
      throw error;
    }

    op.status = "RUNNING";
    op.input_required = null;
    op.updated_at = now();
    this.pendingVerification = null;

    Promise.resolve()
      .then(() => this.session.submitVerificationPreservingWorkPage(code))
      .then((result) => {
        op.status = "SUCCEEDED";
        op.result = result;
        op.updated_at = now();
      })
      .catch((error) => {
        op.status = "FAILED";
        op.error = cleanError(error);
        op.updated_at = now();
      });

    return { operation_id: op.operation_id };
  }

  operationStatus(operationId) {
    const op = this.operations.items.get(String(operationId || ""));
    if (!op) {
      const error = new Error("Unknown operation id.");
      error.code = "OPERATION_NOT_FOUND";
      throw error;
    }
    return this.operations.public(op);
  }

  async request(method, path, query = null, body = undefined, options = {}) {
    return this.session.request(method, path, query, body, options);
  }

  async inspectViewer(args) {
    return this.session.inspectViewer(args);
  }

  async moveView(args) {
    return this.session.moveView(args);
  }

  async standardView(args) {
    return this.session.standardView(args);
  }

  async fitView(args) {
    return this.session.fitView(args);
  }

  async currentSelection(args) {
    return this.session.currentSelection(args);
  }

  async applyFeatureFromSelectionUi(args) {
    return this.session.applyFeatureFromSelectionUi(args);
  }

  async setViewerSelection(args) {
    return this.session.setViewerSelection(args);
  }

  async testFollowHandoff(args) {
    return this.session.testFollowHandoff(args);
  }

  async testRemoteSelectionGrounding(args) {
    return this.session.testRemoteSelectionGrounding(args);
  }

  async followView(args) {
    return this.session.followView(args);
  }

  async captureScreenshot(args) {
    return this.session.captureScreenshot(args);
  }

  async inspectFeatureReorderMachinery(args) {
    return this.session.inspectFeatureReorderMachinery(args);
  }

  async reorderFeature(args) {
    return this.session.reorderFeature(args);
  }

  async setPartVisibility(args) {
    return this.session.setPartVisibility(args);
  }

  artifact(action, args = {}) {
    return this.session.artifact(action, args);
  }

  async refreshOpenApi() {
    return this.session.refreshOpenApiSpec();
  }
}