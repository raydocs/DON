import assert from "node:assert/strict";
import test from "node:test";
import { gateDecisionAction } from "./launch-gate.ts";

const decision = (overrides = {}) => ({
  proceed: false,
  ackFingerprint: false,
  ackExtensionKeys: [],
  applyToRemaining: false,
  ...overrides,
});

test("a fingerprint match retries instead of proceeding with stale consent", () => {
  assert.equal(
    gateDecisionAction(
      decision({
        retryAfterFingerprintMatch: true,
        proceed: false,
      }),
    ),
    "retry",
  );
});

test("ordinary gate decisions keep their proceed and cancel behavior", () => {
  assert.equal(gateDecisionAction(decision({ proceed: true })), "proceed");
  assert.equal(gateDecisionAction(decision()), "cancel");
});
