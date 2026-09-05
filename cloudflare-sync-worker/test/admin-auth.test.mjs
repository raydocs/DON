// Behavioral tests for the admin authentication boundary in src/admin.ts.
//
// These tests import the REAL worker TypeScript source (via the
// test/_loader/js-to-ts.mjs resolve hook + Node >= 22 built-in type stripping),
// drive the actual `adminRouter` through Hono's `fetch`, and assert the
// security properties of `getCfAccessUser` and the `/api/admin/*` middleware.
//
// For the Cloudflare Access JWT path, a real RS256 key pair is generated with
// `jose`; valid/unsigned/tampered/wrong-iss/wrong-aud/expired JWTs are crafted
// and `globalThis.fetch` is stubbed to serve the matching JWKS, so the same
// `jose`-based verification code path (`src/cf-access.ts`) that runs in the
// Worker is exercised here.

import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

register("./_loader/js-to-ts.mjs", import.meta.url);

const { adminRouter } = await import("../src/admin.ts");

const TEAM = "https://test-team.cloudflareaccess.com";
const AUD = "test-access-aud-uuid";
const ADMIN_EMAIL = "admin@example.com";
const JWKS_URL = `${TEAM}/cdn-cgi/access/certs`;
const KID = "test-key-1";

// Real RS256 key pair + JWKS used to sign/verify test JWTs.
const { publicKey, privateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const publicJwk = await exportJWK(publicKey);
const JWKS = {
  keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }],
};

// jose's createRemoteJWKSet uses the global fetch; stub it to serve the test
// JWKS so verification runs fully off-line. All other URLs delegate to real.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url === JWKS_URL) {
    return new Response(JSON.stringify(JWKS), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signJwt({
  email = ADMIN_EMAIL,
  iss = TEAM,
  aud = AUD,
  exp = "2h",
} = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
}

function unsignedAlgNoneJwt({ email = ADMIN_EMAIL } = {}) {
  return `${b64url({ alg: "none", typ: "JWT", kid: KID })}.${b64url({ email })}.`;
}

async function tamperedJwt(newEmail) {
  const valid = await signJwt();
  const [h, p, s] = valid.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  payload.email = newEmail;
  return `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
}

// Minimal mock D1 for the admin-token fallback path (admin.ts D1-admin lookup).
function makeMockDb(adminToken) {
  const adminRow = { id: "usr_test", username: "d1admin", role: "admin" };
  const bound = (token) => ({
    first: async () => (adminToken && token === adminToken ? adminRow : null),
    all: async () => ({ results: [] }),
    run: async () => ({}),
  });
  return {
    prepare: () => ({
      bind: (...args) => bound(args[0]),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
    batch: async (stmts) => stmts,
  };
}

// Drive the real adminRouter. `env` is the Worker bindings object (c.env).
async function call(
  path,
  { method = "GET", headers = {}, body } = {},
  env = {},
) {
  const url = new URL(path, "http://localhost");
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!init.headers["Content-Type"] && !init.headers["content-type"]) {
      init.headers["Content-Type"] = "application/json";
    }
  }
  return adminRouter.fetch(new Request(url, init), env);
}

const okEnv = () => ({
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_AUD: AUD,
  ADMIN_EMAILS: ADMIN_EMAIL,
});

const json = async (res) => res.json();

describe("admin auth: forgeable headers are not trusted", () => {
  it("rejects unauthenticated requests to protected routes", async () => {
    const res = await call("/api/admin/users", {}, okEnv());
    assert.equal(res.status, 401);
  });

  it("auth-status reports unauthenticated without any credential", async () => {
    const res = await call("/api/admin/auth-status", {}, okEnv());
    assert.equal(res.status, 200);
    assert.equal((await json(res)).authenticated, false);
  });

  it("forged x-admin-email is NOT honored when ADMIN_DEV_BYPASS is unset", async () => {
    const res = await call(
      "/api/admin/users",
      { headers: { "x-admin-email": ADMIN_EMAIL } },
      okEnv(),
    );
    assert.equal(res.status, 401);
    const s = await call(
      "/api/admin/auth-status",
      { headers: { "x-admin-email": ADMIN_EMAIL } },
      okEnv(),
    );
    assert.equal((await json(s)).authenticated, false);
  });

  it("configuration cannot re-enable the forged-header bypass", async () => {
    for (const v of ["true", "false", "yes", "1", undefined, "TRUE", " true "]) {
      const env = { ADMIN_EMAILS: ADMIN_EMAIL, ADMIN_DEV_BYPASS: v };
      const res = await call(
        "/api/admin/users",
        { headers: { "x-admin-email": ADMIN_EMAIL } },
        env,
      );
      assert.equal(
        res.status,
        401,
        `ADMIN_DEV_BYPASS=${v} must not grant admin`,
      );
    }
  });

  it("forged cf-access-authenticated-user-email (no JWT) is NOT trusted", async () => {
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-authenticated-user-email": ADMIN_EMAIL } },
      okEnv(),
    );
    assert.equal(res.status, 401);
    const s = await call(
      "/api/admin/auth-status",
      { headers: { "cf-access-authenticated-user-email": ADMIN_EMAIL } },
      okEnv(),
    );
    assert.equal((await json(s)).authenticated, false);
  });
});

describe("admin auth: Cloudflare Access JWT verification (signature + iss/aud)", () => {
  it("rejects an unsigned alg:none JWT", async () => {
    const jwt = unsignedAlgNoneJwt();
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal(res.status, 401);
    const s = await call(
      "/api/admin/auth-status",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal((await json(s)).authenticated, false);
  });

  it("rejects a tampered JWT (signature no longer matches payload)", async () => {
    const jwt = await tamperedJwt("attacker@example.com");
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal(res.status, 401);
  });

  it("rejects a JWT signed with the wrong audience", async () => {
    const jwt = await signJwt({ aud: "wrong-audience" });
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal(res.status, 401);
  });

  it("rejects a JWT signed with the wrong issuer", async () => {
    const jwt = await signJwt({ iss: "https://other.cloudflareaccess.com" });
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal(res.status, 401);
  });

  it("rejects an expired JWT", async () => {
    const jwt = await signJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal(res.status, 401);
  });

  it("admits a validly signed JWT with correct iss/aud and allow-listed email", async () => {
    const jwt = await signJwt();
    const s = await call(
      "/api/admin/auth-status",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal(s.status, 200);
    const body = await json(s);
    assert.equal(body.authenticated, true);
    assert.equal(body.method, "cloudflare_access");
    assert.equal(body.email, ADMIN_EMAIL);
    assert.equal(body.role, "admin");
    const u = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      okEnv(),
    );
    assert.equal(u.status, 200);
    assert.deepEqual(await json(u), { users: [] });
  });

  it("accepts the JWT via CF_Authorization cookie (same verification path)", async () => {
    const jwt = await signJwt();
    const s = await call(
      "/api/admin/auth-status",
      { headers: { cookie: `CF_Authorization=${jwt}` } },
      okEnv(),
    );
    assert.equal((await json(s)).authenticated, true);
  });

  it("rejects a valid JWT whose email is not in the allow-list (defense in depth)", async () => {
    const env = { ...okEnv(), ADMIN_EMAILS: "someone-else@example.com" };
    const jwt = await signJwt();
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      env,
    );
    assert.equal(res.status, 401);
  });

  it("isAdmin via a wildcard ADMIN_EMAILS='*' still requires a verified JWT", async () => {
    const env = { ...okEnv(), ADMIN_EMAILS: "*" };
    // Forged header alone -> rejected (no verified JWT).
    const forged = await call(
      "/api/admin/users",
      { headers: { "x-admin-email": "anyone@x.com" } },
      env,
    );
    assert.equal(forged.status, 401);
    // Valid verified JWT with any email -> admitted (wildcard allow).
    const jwt = await signJwt({ email: "anyone@x.com" });
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      env,
    );
    assert.equal(res.status, 200);
  });

  it("disables (fail-closed) the JWT path when CF_ACCESS_TEAM_DOMAIN/AUD unset", async () => {
    const jwt = await signJwt();
    const envs = [
      { CF_ACCESS_AUD: AUD, ADMIN_EMAILS: ADMIN_EMAIL }, // missing team
      { CF_ACCESS_TEAM_DOMAIN: TEAM, ADMIN_EMAILS: ADMIN_EMAIL }, // missing aud
      { ADMIN_EMAILS: ADMIN_EMAIL }, // both missing
    ];
    for (const env of envs) {
      const res = await call(
        "/api/admin/users",
        { headers: { "cf-access-jwt-assertion": jwt } },
        env,
      );
      assert.equal(res.status, 401);
    }
  });

  it("no hard-coded ADMIN_EMAILS default: unset allow-list rejects a valid JWT", async () => {
    const env = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }; // no ADMIN_EMAILS
    const jwt = await signJwt();
    const res = await call(
      "/api/admin/users",
      { headers: { "cf-access-jwt-assertion": jwt } },
      env,
    );
    assert.equal(res.status, 401);
  });
});

describe("admin auth: master-token and D1-admin fallbacks (no regression)", () => {
  it("SYNC_TOKEN master token still grants admin", async () => {
    const env = { SYNC_TOKEN: "master-tok" };
    const u = await call(
      "/api/admin/users",
      { headers: { Authorization: "Bearer master-tok" } },
      env,
    );
    assert.equal(u.status, 200);
    assert.deepEqual(await json(u), { users: [] });
    const s = await call(
      "/api/admin/auth-status",
      { headers: { Authorization: "Bearer master-tok" } },
      env,
    );
    assert.equal((await json(s)).method, "master_token");
  });

  it("rejects an incorrect master token when no D1 fallback matches", async () => {
    const env = { SYNC_TOKEN: "master-tok" };
    const res = await call(
      "/api/admin/users",
      { headers: { Authorization: "Bearer wrong-token" } },
      env,
    );
    assert.equal(res.status, 401);
  });

  it("D1 admin token fallback still authenticates (token_hash lookup)", async () => {
    const adminToken = "d1-admin-token";
    const env = { SYNC_TOKEN: "different-master", DB: makeMockDb(adminToken) };
    const res = await call(
      "/api/admin/users",
      { headers: { Authorization: `Bearer ${adminToken}` } },
      env,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { users: [] });
  });

  it("rejects a token not in D1 and not the master token", async () => {
    const env = {
      SYNC_TOKEN: "different-master",
      DB: makeMockDb("d1-admin-token"),
    };
    const res = await call(
      "/api/admin/users",
      { headers: { Authorization: "Bearer not-a-real-token" } },
      env,
    );
    assert.equal(res.status, 401);
  });
});
