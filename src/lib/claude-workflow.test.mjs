import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(
        new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { getProxyHoldInfo, isProxyReusable, PROXY_REUSE_COOLDOWN_DAYS } =
  await import("./claude-workflow.ts");

const DAY_SECONDS = 24 * 60 * 60;

test("a leased proxy becomes reusable after three days", () => {
  const holdStart = 1_800_000_000;
  const profile = {
    id: "profile-1",
    name: "Profile 1",
    proxy_id: "proxy-1",
    created_at: holdStart,
  };

  assert.equal(PROXY_REUSE_COOLDOWN_DAYS, 3);
  assert.equal(
    getProxyHoldInfo(profile, holdStart + 3 * DAY_SECONDS - 1)?.active,
    true,
  );
  assert.equal(
    getProxyHoldInfo(profile, holdStart + 3 * DAY_SECONDS)?.active,
    false,
  );
  assert.equal(
    isProxyReusable(
      "proxy-1",
      [profile],
      undefined,
      holdStart + 3 * DAY_SECONDS,
    ),
    true,
  );
});

test("standalone migration guidance uses the three-day lease", () => {
  const migration = readFileSync(
    new URL("../../scripts/migrate-donut-profiles.py", import.meta.url),
    "utf8",
  );
  const guide = readFileSync(
    new URL("../../CLAUDE_WORKFLOW.md", import.meta.url),
    "utf8",
  );

  assert.match(migration, /proxy_lease_days: 3/);
  assert.doesNotMatch(migration, /proxy_lease_days: 7/);
  assert.match(guide, /3-day node reuse/);
  assert.doesNotMatch(guide, /7-day|7 days|after 7d|proxy_lease_days: 7/);
});
