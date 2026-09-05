import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSensitiveText } from "./redact-sensitive-text.mjs";

test("redacts single-token credentials from HTTP authorization headers", () => {
  for (const header of ["Authorization", "Proxy-Authorization"]) {
    for (const scheme of ["Basic", "Token", "Negotiate", "bAsIc"]) {
      const out = redactSensitiveText(`${header}: ${scheme} dXNlcjpwYXNz`);
      assert.ok(
        !out.includes("dXNlcjpwYXNz"),
        `LEAKED in ${JSON.stringify(out)}`,
      );
      assert.ok(
        out.includes("<redacted-secret>"),
        `expected redaction placeholder in ${JSON.stringify(out)}`,
      );
    }
  }
});

test("still redacts Bearer auth credentials (regression guard)", () => {
  const out = redactSensitiveText("Authorization: Bearer secret-token");
  assert.ok(!out.includes("secret-token"), `LEAKED in ${JSON.stringify(out)}`);
});
