// Security regression tests for the /raw/* R2 transfer URL authentication gate.
//
// These tests assert that the HMAC signing secret can NEVER silently resolve to a
// publicly-known value (the historical source-committed placeholders or the
// hardcoded fallback), and that the /raw/* endpoints therefore cannot be forged
// by anyone who reads this repo. They exercise the real Hono app (imported
// straight from src/index.ts) with an in-process mock Env.
//
// Run: node --test test/raw-transfer-auth.test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Node type-strips .ts on import, but the worker sources cross-import via
// NodeNext-style "./foo.js" specifiers that have no compiled .js output. Register
// an ESM resolve hook that maps a failed "./foo.js" resolution to "./foo.ts" so
// the real source can be loaded directly under `node --test`.
await register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      try {
        return await nextResolve(specifier, context);
      } catch (err) {
        if (typeof specifier === "string" && specifier.endsWith(".js")) {
          return await nextResolve(specifier.slice(0, -3) + ".ts", context);
        }
        throw err;
      }
    }
  `)}`,
  import.meta.url,
);

const { default: app } = await import("../src/index.ts");
const { generateTransferSignature, verifyTransferSignature } = await import(
  "../src/auth.ts"
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = dirname(__dirname); // cloudflare-sync-worker/

// The exact public placeholder values that must NEVER be usable as a signing key.
const PUBLIC_PLACEHOLDERS = [
  "default-don-signing-secret",
  "don-signing-secret",
  "don-secret-sync-token",
];
const REAL_SECRET = "real-deployment-secret-9f8e7d6c5b4a";
const REAL_TOKEN = "real-admin-sync-token-1a2b3c4d";

// Off-platform HMAC forge, mirroring repro_forge_raw_url.mjs / generateTransferSignature.
function forge(secret, method, key, expiresAtMs) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${method}:${key}:${expiresAtMs}`)
    .digest("hex");
}

function mockBucket() {
  const store = new Map();
  return {
    _store: store,
    get: async (k) => {
      if (!store.has(k)) return null;
      const data = store.get(k);
      return {
        body: new Response(data).body,
        httpEtag: `etag-${k}`,
        httpMetadata: { contentType: "text/plain" },
        writeHttpMetadata: (h) => {
          h.set("X-Mock-Bucket", "1");
        },
      };
    },
    put: async (k, body) => {
      store.set(k, await new Response(body).text());
    },
    head: async (k) =>
      store.has(k)
        ? {
            size: store.get(k).length,
            uploaded: new Date(),
            customMetadata: {},
          }
        : null,
    delete: async (k) => {
      (Array.isArray(k) ? k : [k]).forEach((x) => store.delete(x));
    },
    list: async ({ prefix } = {}) => ({
      objects: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((k) => ({
          key: k,
          size: store.get(k).length,
          uploaded: new Date(),
        })),
      truncated: false,
      cursor: undefined,
    }),
  };
}

function mockDb() {
  // Minimal D1 stub: every query chain resolves to empty success.
  const chain = () => ({
    run: async () => ({}),
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  return { prepare: () => ({ bind: () => chain() }), bind: () => chain() };
}

function makeEnv(opts = {}) {
  return {
    BUCKET: opts.BUCKET ?? mockBucket(),
    DB: opts.DB === null ? undefined : (opts.DB ?? mockDb()),
    SIGNING_SECRET: opts.SIGNING_SECRET,
    SYNC_TOKEN: opts.SYNC_TOKEN,
  };
}

function request(path, init, env) {
  return app.request(path, init, env);
}

// ---------------------------------------------------------------------------
// 1. getSigningSecret fail-closed unit guarantees (via exported auth functions)
// ---------------------------------------------------------------------------
describe("signing secret resolution (getSigningSecret)", () => {
  it("throws when neither SIGNING_SECRET nor SYNC_TOKEN is configured", async () => {
    await assert.rejects(
      () =>
        generateTransferSignature("k", "GET", Date.now() + 60000, makeEnv({})),
      /SIGNING_SECRET/,
    );
    await assert.rejects(
      () =>
        verifyTransferSignature(
          "deadbeef",
          "k",
          "GET",
          Date.now() + 60000,
          makeEnv({}),
        ),
      /SIGNING_SECRET/,
    );
  });

  it("throws when SIGNING_SECRET is any known-public placeholder", async () => {
    for (const ph of PUBLIC_PLACEHOLDERS) {
      await assert.rejects(
        () =>
          generateTransferSignature(
            "k",
            "GET",
            Date.now() + 60000,
            makeEnv({ SIGNING_SECRET: ph }),
          ),
        /placeholder/i,
        `placeholder ${ph} should be rejected`,
      );
    }
  });

  it("throws when only SYNC_TOKEN is set to a known-public placeholder", async () => {
    for (const ph of PUBLIC_PLACEHOLDERS) {
      await assert.rejects(
        () =>
          generateTransferSignature(
            "k",
            "GET",
            Date.now() + 60000,
            makeEnv({ SYNC_TOKEN: ph }),
          ),
        /placeholder/i,
        `placeholder ${ph} should be rejected`,
      );
    }
  });

  it("mints and verifies a signature with a real SIGNING_SECRET", async () => {
    const env = makeEnv({ SIGNING_SECRET: REAL_SECRET });
    const exp = Date.now() + 60000;
    const sig = await generateTransferSignature(
      "profiles/a/b",
      "GET",
      exp,
      env,
    );
    assert.equal(sig.length, 64);
    assert.ok(
      await verifyTransferSignature(sig, "profiles/a/b", "GET", exp, env),
    );
  });

  it("falls back to SYNC_TOKEN when SIGNING_SECRET is unset (real value)", async () => {
    const env = makeEnv({ SYNC_TOKEN: REAL_TOKEN });
    const exp = Date.now() + 60000;
    const sig = await generateTransferSignature("k", "PUT", exp, env);
    assert.ok(await verifyTransferSignature(sig, "k", "PUT", exp, env));
  });

  it("rejects a signature forged with a public placeholder when a real secret is configured", async () => {
    const env = makeEnv({ SIGNING_SECRET: REAL_SECRET });
    const key = "profiles/victim/secret.txt";
    const exp = Date.now() + 60000;
    for (const ph of PUBLIC_PLACEHOLDERS) {
      const forged = forge(ph, "GET", key, exp);
      assert.equal(
        await verifyTransferSignature(forged, key, "GET", exp, env),
        false,
        `forged URL signed with ${ph} must NOT verify`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. /raw/* route-level fail-closed behavior (full Hono app)
// ---------------------------------------------------------------------------
describe("/raw/get access control", () => {
  it("serves an object for a legitimately-signed URL", async () => {
    const env = makeEnv({ SIGNING_SECRET: REAL_SECRET });
    const key = "profiles/u/manifest.json";
    await env.BUCKET.put(key, "OK-DATA");
    const exp = Date.now() + 60000;
    const sig = await generateTransferSignature(key, "GET", exp, env);
    const res = await request(
      `/raw/get/${sig}/${exp}/${encodeURIComponent(key)}`,
      {},
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "OK-DATA");
  });

  it("REFUSES to serve when no secret is configured (no fallback to public default)", async () => {
    const env = makeEnv({}); // no SIGNING_SECRET, no SYNC_TOKEN
    const key = "profiles/victim/leak.txt";
    await env.BUCKET.put(key, "LEAK");
    const exp = Date.now() + 60000;
    // Attacker forges with the historical public fallback constant.
    const forged = forge("default-don-signing-secret", "GET", key, exp);
    const res = await request(
      `/raw/get/${forged}/${exp}/${encodeURIComponent(key)}`,
      {},
      env,
    );
    assert.notEqual(
      res.status,
      200,
      "must not serve object when secret is unconfigured",
    );
    const body = await res.text();
    assert.notEqual(body, "LEAK", "object body must never be returned");
  });

  it("REFUSES to serve when the configured secret is a known-public placeholder", async () => {
    for (const ph of [
      "don-signing-secret",
      "default-don-signing-secret",
      "don-secret-sync-token",
    ]) {
      const env = makeEnv({ SIGNING_SECRET: ph });
      const key = "profiles/victim/leak.txt";
      await env.BUCKET.put(key, "LEAK");
      const exp = Date.now() + 60000;
      // Even a "correctly"-computed signature using the placeholder must be rejected,
      // because the worker refuses to key on a known-public value.
      const sig = forge(ph, "GET", key, exp);
      const res = await request(
        `/raw/get/${sig}/${exp}/${encodeURIComponent(key)}`,
        {},
        env,
      );
      assert.notEqual(res.status, 200, `placeholder ${ph} must not be usable`);
      assert.notEqual(await res.text(), "LEAK");
    }
  });

  it("rejects a URL forged with a public placeholder when a real secret is configured", async () => {
    const env = makeEnv({ SIGNING_SECRET: REAL_SECRET });
    const key = "profiles/victim/secret.txt";
    await env.BUCKET.put(key, "PRIVATE");
    const exp = Date.now() + 60000;
    for (const ph of PUBLIC_PLACEHOLDERS) {
      const forged = forge(ph, "GET", key, exp);
      const res = await request(
        `/raw/get/${forged}/${exp}/${encodeURIComponent(key)}`,
        {},
        env,
      );
      assert.equal(
        res.status,
        401,
        `forged URL signed with ${ph} must be Unauthorized`,
      );
      assert.notEqual(await res.text(), "PRIVATE");
    }
  });
});

describe("/raw/put access control", () => {
  it("stores an object for a legitimately-signed PUT", async () => {
    const env = makeEnv({ SIGNING_SECRET: REAL_SECRET });
    const key = "profiles/u/upload.bin";
    const exp = Date.now() + 60000;
    const sig = await generateTransferSignature(key, "PUT", exp, env);
    const res = await request(
      `/raw/put/${sig}/${exp}/${encodeURIComponent(key)}`,
      { method: "PUT", body: "UPLOADED" },
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(env.BUCKET._store.get(key), "UPLOADED");
  });

  it("REFUSES an attacker PUT forged with the public default when no secret is configured", async () => {
    const env = makeEnv({});
    const key = "profiles/victim/overwrite.txt";
    const exp = Date.now() + 60000;
    const forged = forge("default-don-signing-secret", "PUT", key, exp);
    const res = await request(
      `/raw/put/${forged}/${exp}/${encodeURIComponent(key)}`,
      { method: "PUT", body: "PWNED" },
      env,
    );
    assert.notEqual(res.status, 200);
    assert.equal(
      env.BUCKET._store.get(key),
      undefined,
      "attacker body must not be stored",
    );
  });

  it("REFUSES a PUT forged with a public placeholder when a real secret is configured", async () => {
    const env = makeEnv({ SIGNING_SECRET: REAL_SECRET });
    const key = "profiles/victim/overwrite.txt";
    const exp = Date.now() + 60000;
    const forged = forge("don-signing-secret", "PUT", key, exp);
    const res = await request(
      `/raw/put/${forged}/${exp}/${encodeURIComponent(key)}`,
      { method: "PUT", body: "PWNED" },
      env,
    );
    assert.equal(res.status, 401);
    assert.equal(env.BUCKET._store.get(key), undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end presign -> /raw round-trip (no regression for legit clients)
// ---------------------------------------------------------------------------
describe("presign -> /raw end-to-end (legit client)", () => {
  it("presign-upload -> /raw/put stores, then presign-download -> /raw/get reads it back", async () => {
    const env = makeEnv({
      SYNC_TOKEN: REAL_TOKEN,
      SIGNING_SECRET: REAL_SECRET,
    });
    const key = "profiles/e2e/up.txt";

    const up = await request(
      "/v1/objects/presign-upload",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${REAL_TOKEN}`,
        },
        body: JSON.stringify({ key }),
      },
      env,
    );
    assert.equal(up.status, 200);
    const { url: putUrl } = await up.json();
    assert.ok(putUrl.includes("/raw/put/"));

    const putURLObj = new URL(putUrl);
    const putRes = await request(
      putURLObj.pathname,
      { method: "PUT", body: "ROUNDTRIP" },
      env,
    );
    assert.equal(putRes.status, 200);
    assert.equal(env.BUCKET._store.get(key), "ROUNDTRIP");

    const dl = await request(
      "/v1/objects/presign-download",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${REAL_TOKEN}`,
        },
        body: JSON.stringify({ key }),
      },
      env,
    );
    const { url: getUrl } = await dl.json();
    const getURLObj = new URL(getUrl);
    const getRes = await request(
      getURLObj.pathname + getURLObj.search,
      {},
      env,
    );
    assert.equal(getRes.status, 200);
    assert.equal(await getRes.text(), "ROUNDTRIP");
  });

  it("presign-download REFUSES to mint when SIGNING_SECRET is a known-public placeholder (fail closed at mint time)", async () => {
    // Auth passes via a real SYNC_TOKEN; the failure must come from the placeholder
    // signing secret, not from auth.
    const env = makeEnv({
      SYNC_TOKEN: REAL_TOKEN,
      SIGNING_SECRET: "don-signing-secret",
    });
    const res = await request(
      "/v1/objects/presign-download",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${REAL_TOKEN}`,
        },
        body: JSON.stringify({ key: "profiles/e2e/x.txt" }),
      },
      env,
    );
    assert.notEqual(
      res.status,
      200,
      "must not mint a transfer URL keyed on a public placeholder",
    );
    assert.notEqual(
      res.status,
      401,
      "auth passes with a real SYNC_TOKEN; failure must be the placeholder secret",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Config guard: wrangler.toml must not ship public secret defaults
// ---------------------------------------------------------------------------
describe("wrangler.toml does not ship public secret defaults", () => {
  const toml = readFileSync(join(workerRoot, "wrangler.toml"), "utf8");

  it("does not commit any known-public placeholder secret value", () => {
    for (const ph of PUBLIC_PLACEHOLDERS) {
      assert.ok(
        !toml.includes(ph),
        `public placeholder "${ph}" must not appear in wrangler.toml`,
      );
    }
  });

  it("does not set SIGNING_SECRET or SYNC_TOKEN as plaintext [vars]", () => {
    const varsBlock = toml.split(/\n\[vars\]/)[1] ?? "";
    assert.ok(
      !/^\s*SIGNING_SECRET\s*=/m.test(varsBlock),
      "SIGNING_SECRET must be set via `wrangler secret put`, not [vars]",
    );
    assert.ok(
      !/^\s*SYNC_TOKEN\s*=/m.test(varsBlock),
      "SYNC_TOKEN must be set via `wrangler secret put`, not [vars]",
    );
  });

  it("README documents `wrangler secret put SIGNING_SECRET`", () => {
    const readme = readFileSync(join(workerRoot, "README.md"), "utf8");
    assert.ok(
      /wrangler secret put SIGNING_SECRET/.test(readme),
      "README must instruct setting SIGNING_SECRET as a secret",
    );
  });
});
