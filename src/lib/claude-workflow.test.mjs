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

const {
  assessClaudeProfile,
  buildIsolationWayfernConfig,
  buildClaudeNote,
  buildResidentialUsage,
  claudeCreateBlockers,
  launchBlockMessages,
  pickAvailableProxy,
  planAutoClaudeProfile,
} = await import("./claude-workflow.ts");
const { getCurrentOS } = await import("./wayfern-defaults.ts");

const DAY_SECONDS = 24 * 60 * 60;

test("readiness compares simulated DPR to its device target and flag repair preserves identity", () => {
  const config = {
    os: "android",
    device_preset: "pixel9",
    expected_device_pixel_ratio: 2.75,
    fingerprint: JSON.stringify({
      fingerprint: { devicePixelRatio: 2.75, timezone: "Europe/Paris" },
    }),
    randomize_fingerprint_on_launch: true,
    geoip: false,
    webrtc_mode: "real",
  };
  const profile = {
    id: "one",
    name: "Claude one",
    tags: ["claude"],
    proxy_id: "missing",
    wayfern_config: config,
  };
  const issues = assessClaudeProfile(profile, [profile], [], 1).issues.map(
    (i) => i.code,
  );
  assert.ok(!issues.includes("DPR_MISMATCH"));
  assert.ok(issues.includes("PROXY_MISSING"));
  const drifted = {
    ...profile,
    wayfern_config: { ...config, expected_device_pixel_ratio: 3 },
  };
  assert.ok(
    assessClaudeProfile(drifted, [drifted], [], 1).issues.some(
      (i) => i.code === "DPR_MISMATCH",
    ),
  );
  const native = {
    ...profile,
    wayfern_config: { ...config, os: getCurrentOS() },
  };
  assert.ok(
    assessClaudeProfile(native, [native], [], 1).issues.some(
      (i) => i.code === "DPR_MISMATCH",
    ),
  );
  const fixed = buildIsolationWayfernConfig(config);
  assert.equal(fixed.fingerprint, config.fingerprint);
  assert.equal(fixed.device_preset, "pixel9");
  assert.equal(fixed.expected_device_pixel_ratio, 2.75);
  assert.equal(fixed.webrtc_mode, "proxy");
  assert.equal(fixed.randomize_fingerprint_on_launch, false);
});

const now = 1_800_000_000;
const proxy = {
  id: "route",
  name: "fixture",
  proxy_settings: { proxy_type: "socks5", host: "not-an-exit" },
};
const makeProfile = (id, label) => ({
  id,
  name: `Claude-${id}`,
  proxy_id: proxy.id,
  tags: ["claude"],
  note:
    label == null
      ? "private user note"
      : `private user note\nresidential: ${label}`,
  wayfern_config: buildIsolationWayfernConfig(),
});
const observe = (profile, ip, observed_at = now, extra = {}) => ({
  profile_id: profile.id,
  proxy_id: profile.proxy_id ?? null,
  ip,
  observed_at,
  fresh: true,
  ...extra,
});
const ids = (profiles) => profiles.map((p) => p.id).sort();

for (const days of [0, 3, 7]) {
  test(`shared routes never block creation or launch at age ${days} days`, () => {
    const first = {
      ...makeProfile("first", "home"),
      created_at: now - days * DAY_SECONDS,
    };
    const second = makeProfile("second", "home");
    const profiles = [first, second];
    const health = assessClaudeProfile(second, profiles, [proxy], 1);
    assert.equal(
      health.issues.find((i) => i.code === "SHARED_PROXY")?.severity,
      "warn",
    );
    assert.ok(!health.issues.some((i) => i.severity === "block"));
    assert.deepEqual(launchBlockMessages(second, profiles, 1), []);
    assert.deepEqual(
      claudeCreateBlockers({
        name: "new",
        proxyId: proxy.id,
        profiles,
        cardLabel: "card-C",
        nowSecs: now,
      }),
      [],
    );
    for (const proxyId of [undefined, proxy.id]) {
      const plan = planAutoClaudeProfile({
        profiles,
        proxies: [proxy],
        proxyId,
      });
      assert.ok(!("error" in plan));
      assert.equal(plan.proxyId, proxy.id);
      assert.equal(plan.wayfernConfig.randomize_fingerprint_on_launch, false);
    }
  });
}

test("route selection prefers unreferenced SOCKS5, but used routes remain selectable", () => {
  const free = { ...proxy, id: "free" };
  const http = { ...proxy, id: "http", proxy_settings: { proxy_type: "http" } };
  const profiles = [makeProfile("one", "home")];
  assert.equal(pickAvailableProxy([http, proxy, free], profiles), free);
  assert.equal(pickAvailableProxy([http, proxy], profiles), proxy);
  assert.equal(pickAvailableProxy([http], profiles), null);
  assert.ok(
    "error" in
      planAutoClaudeProfile({ proxies: [], profiles, proxyId: "missing" }),
  );
  assert.ok(claudeCreateBlockers({ name: "", profiles }).length > 0);
  const missing = { ...profiles[0], proxy_id: null };
  assert.ok(launchBlockMessages(missing, [missing]).length > 0);
  const randomized = {
    ...profiles[0],
    wayfern_config: { randomize_fingerprint_on_launch: true },
  };
  assert.ok(launchBlockMessages(randomized, [randomized]).length > 0);
});

test("labels and current exits group independently, with full profiles and counts", () => {
  const profiles = [
    makeProfile("a", "home-A"),
    makeProfile("b", "home-A"),
    makeProfile("c", "home-C"),
  ];
  const observations = [
    observe(profiles[0], "192.0.2.1", now - 30),
    observe(profiles[1], "192.0.2.2"),
    observe(profiles[2], "192.0.2.1", now - 10),
  ];
  const before = JSON.stringify({ profiles, observations });
  const usage = buildResidentialUsage(profiles, observations, now);
  assert.deepEqual(usage.byLabel[0], {
    key: "home-A",
    profiles: profiles.slice(0, 2),
    count: 2,
    lastObservedAt: now,
  });
  assert.deepEqual(usage.byIp[0], {
    key: "192.0.2.1",
    profiles: [profiles[0], profiles[2]],
    count: 2,
    lastObservedAt: now - 10,
  });
  assert.deepEqual(ids(usage.duplicateLabelProfiles), ["a", "b"]);
  assert.deepEqual(ids(usage.duplicateIpProfiles), ["a", "c"]);
  assert.equal(usage.byLabel[0].profiles[0], profiles[0]);
  assert.equal(JSON.stringify({ profiles, observations }), before);
});

test("dynamic exits replace older observations regardless of input order", () => {
  const profile = makeProfile("a", "home");
  const usage = buildResidentialUsage(
    [profile],
    [observe(profile, "192.0.2.2"), observe(profile, "192.0.2.1", now - 1)],
    now,
  );
  assert.deepEqual(
    usage.byIp.map((g) => g.key),
    ["192.0.2.2"],
  );
  assert.deepEqual(usage.duplicateIpProfiles, []);
  const invalid = buildResidentialUsage(
    [profile],
    [observe(profile, null), observe(profile, "192.0.2.1", now - 1)],
    now,
  );
  assert.equal(invalid.byIp.length, 0);
  assert.deepEqual(invalid.unknownIp.profiles, [profile]);
});

test("unknown labels and missing, expired, future or wrong-route exits never count as duplicates", () => {
  const profiles = Array.from({ length: 9 }, (_, i) =>
    makeProfile(String(i), i === 1 ? "(set 家宽 label)" : null),
  );
  const observations = [
    observe(profiles[1], "192.0.2.1", now - 1801),
    observe(profiles[2], "192.0.2.1", now + 1),
    observe(profiles[3], "192.0.2.1", now, { proxy_id: "old-route" }),
    observe(profiles[4], "192.0.2.1", now, { fresh: false }),
    observe(profiles[5], "192.0.2.1", null),
    observe(profiles[6], null),
    observe(profiles[7], "192.0.2.1", now - 1800),
    observe(profiles[8], "192.0.2.1", Number.NaN),
  ];
  const usage = buildResidentialUsage(profiles, observations, now);
  assert.equal(usage.unknownLabel.count, 9);
  assert.equal(usage.unknownLabel.lastObservedAt, now);
  assert.equal(usage.unknownIp.count, 6);
  assert.equal(usage.unknownIp.lastObservedAt, null);
  assert.equal(usage.expiredIp.count, 3);
  assert.deepEqual(ids(usage.expiredIp.profiles), ["1", "4", "7"]);
  assert.equal(usage.expiredIp.lastObservedAt, now);
  assert.deepEqual(usage.byIp, []);
  assert.deepEqual(usage.duplicateIpProfiles, []);
  assert.deepEqual(usage.duplicateLabelProfiles, []);
  assert.deepEqual(buildResidentialUsage([], [], now).byIp, []);
});

test("new notes and migration additions never write reuse windows", () => {
  const migration = readFileSync(
    new URL("../../scripts/migrate-donut-profiles.py", import.meta.url),
    "utf8",
  );
  const guide = readFileSync(
    new URL("../../CLAUDE_WORKFLOW.md", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(buildClaudeNote({}), /proxy_lease|reuse node|3d|7d/);
  assert.doesNotMatch(migration, /proxy_lease_days|reuse node/);
  assert.match(guide, /Reuse is allowed immediately/);
  assert.doesNotMatch(guide, /3-day|7-day|after [37]d|proxy_lease_days: [37]/);
});
