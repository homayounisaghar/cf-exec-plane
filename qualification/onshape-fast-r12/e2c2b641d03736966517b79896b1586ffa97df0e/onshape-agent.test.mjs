import assert from "node:assert/strict";
import test from "node:test";
import { OnshapeAgent } from "./onshape-agent.js";

test("r201 Bale canary preserves the qualified Onshape agent surface", () => {
  assert.equal(typeof OnshapeAgent, "function");
  assert.equal(typeof OnshapeAgent.prototype.executeIntent, "function");
  assert.equal(typeof OnshapeAgent.prototype.executeDocumentedOperation, "function");
  assert.equal(typeof OnshapeAgent.prototype._buildOperationRegistry, "function");
  assert.equal(typeof OnshapeAgent.prototype._buildSemanticRegistry, "function");
});
