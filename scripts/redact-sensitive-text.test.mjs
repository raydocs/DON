import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSensitiveText } from "./redact-sensitive-text.mjs";

test("redacts Basic auth credentials from an Authorization header", () => {
  const out = redactSensitiveText("Authorization: Basic dXNlcjpwYXNz");
  assert.ok(!out.includes("dXNlcjpwYXNz"), `LEAKED in ${JSON.stringify(out)}`);
  assert.ok(
    out.includes("<redacted-secret>"),
    `expected redaction placeholder in ${JSON.stringify(out)}`,
  );
});

test("still redacts Bearer auth credentials (regression guard)", () => {
  const out = redactSensitiveText("Authorization: Bearer secret-token");
  assert.ok(!out.includes("secret-token"), `LEAKED in ${JSON.stringify(out)}`);
});
