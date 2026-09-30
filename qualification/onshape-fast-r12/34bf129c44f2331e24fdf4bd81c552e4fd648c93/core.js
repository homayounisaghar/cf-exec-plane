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
  }

  async initialize() {
    await this.session.ensureBrowser();
  }

  async close() {
    await this.session.close();
  }

  async status() {
    return {
      session: await this.session.status(),
      scheduler: this.scheduler.status(),
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
      .then(() => this.session.login(progress))
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
      .then(() => this.session.submitVerification(code))
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
