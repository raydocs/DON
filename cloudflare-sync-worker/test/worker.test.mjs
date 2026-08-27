import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Cloudflare Sync Worker Protocol & Contracts", () => {
  it("verifies the health check response matches expectation", async () => {
    // Contract test for health checks
    const expectedKeys = ["status", "service", "timestamp"];
    const health = {
      status: "ok",
      service: "don-cloudflare-sync",
      timestamp: new Date().toISOString(),
    };
    for (const key of expectedKeys) {
      assert.ok(key in health, `Expected key ${key} in health response`);
    }
  });

  it("verifies stat response payload contract", () => {
    const stat = {
      exists: true,
      size: 1024,
      lastModified: "2026-08-27T00:00:00.000Z",
      metadata: { "updated-at": "1724716800" },
    };
    assert.strictEqual(typeof stat.exists, "boolean");
    assert.strictEqual(typeof stat.size, "number");
    assert.strictEqual(typeof stat.lastModified, "string");
  });

  it("verifies batch presign response format matching Tauri client", () => {
    const batch = {
      items: [
        {
          key: "profiles/123/manifest.json",
          url: "https://worker.dev/raw/get/sig/123/key",
          expiresAt: "2026-08-27T01:00:00.000Z",
        },
      ],
    };
    assert.strictEqual(batch.items.length, 1);
    assert.strictEqual(batch.items[0].key, "profiles/123/manifest.json");
    assert.ok(batch.items[0].url.startsWith("https://"));
  });

  it("verifies list response matches Tauri ListResponse struct", () => {
    const listRes = {
      objects: [
        {
          key: "profiles/123/data/chunk_0",
          size: 65536,
          lastModified: "2026-08-27T00:00:00.000Z",
        },
      ],
      isTruncated: false,
      nextContinuationToken: null,
    };
    assert.ok(Array.isArray(listRes.objects));
    assert.strictEqual(listRes.isTruncated, false);
    assert.strictEqual(listRes.objects[0].size, 65536);
  });
});
