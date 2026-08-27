import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  authenticateRequest,
  generateTransferSignature,
  verifyTransferSignature,
} from "./auth.js";
import type {
  DeletePrefixRequest,
  DeletePrefixResponse,
  DeleteRequest,
  DeleteResponse,
  Env,
  ListObjectItem,
  ListRequest,
  ListResponse,
  PresignDownloadBatchRequest,
  PresignDownloadBatchResponse,
  PresignDownloadRequest,
  PresignDownloadResponse,
  PresignUploadBatchRequest,
  PresignUploadBatchResponse,
  PresignUploadRequest,
  PresignUploadResponse,
  StatRequest,
  StatResponse,
  UserContext,
} from "./types.js";

const app = new Hono<{ Bindings: Env; Variables: { user: UserContext } }>();

// Enable CORS for all routes
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Content-Length",
      "x-amz-meta-*",
      "x-internal-key",
    ],
    exposeHeaders: ["ETag", "Content-Length", "Content-Type", "x-amz-meta-*"],
    maxAge: 86400,
  }),
);

// 1. Health checks (compatible with DON readiness checks)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "don-cloudflare-sync",
    timestamp: new Date().toISOString(),
  });
});

app.get("/readyz", (c) => {
  return c.json({
    status: "ready",
    storage: "cloudflare-r2",
    database: "cloudflare-d1",
  });
});

// Helper: build transfer URL
async function buildTransferUrl(
  c: any,
  key: string,
  method: "GET" | "PUT",
  expiresInSec = 3600,
): Promise<{ url: string; expiresAt: string }> {
  const expiresAtMs = Date.now() + expiresInSec * 1000;
  const signature = await generateTransferSignature(
    key,
    method,
    expiresAtMs,
    c.env,
  );
  const origin = new URL(c.req.url).origin;
  const encodedKey = encodeURIComponent(key);
  const url = `${origin}/raw/${method.toLowerCase()}/${signature}/${expiresAtMs}/${encodedKey}`;
  return {
    url,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

// 2. Direct R2 raw binary transfer endpoints (GET / PUT)
app.get("/raw/get/:signature/:expiresAt/:key", async (c) => {
  const signature = c.req.param("signature");
  const expiresAtMs = Number.parseInt(c.req.param("expiresAt"), 10);
  const key = decodeURIComponent(c.req.param("key"));

  const isValid = await verifyTransferSignature(
    signature,
    key,
    "GET",
    expiresAtMs,
    c.env,
  );
  if (!isValid) {
    return c.text("Unauthorized or expired transfer URL", 401);
  }

  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text("Object not found", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Length", object.size.toString());
  if (object.customMetadata) {
    for (const [k, v] of Object.entries(object.customMetadata)) {
      headers.set(`x-amz-meta-${k}`, String(v));
    }
  }

  return new Response(object.body, { headers });
});

app.put("/raw/put/:signature/:expiresAt/:key", async (c) => {
  const signature = c.req.param("signature");
  const expiresAtMs = Number.parseInt(c.req.param("expiresAt"), 10);
  const key = decodeURIComponent(c.req.param("key"));

  const isValid = await verifyTransferSignature(
    signature,
    key,
    "PUT",
    expiresAtMs,
    c.env,
  );
  if (!isValid) {
    return c.text("Unauthorized or expired transfer URL", 401);
  }

  const contentType =
    c.req.header("content-type") || "application/octet-stream";
  const customMetadata: Record<string, string> = {};
  for (const [headerKey, value] of Object.entries(c.req.header())) {
    if (headerKey.toLowerCase().startsWith("x-amz-meta-")) {
      const metaKey = headerKey.toLowerCase().replace("x-amz-meta-", "");
      customMetadata[metaKey] = value;
    }
  }

  const body = c.req.raw.body;
  if (!body) {
    return c.text("Missing request body", 400);
  }

  await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType },
    customMetadata:
      Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
  });

  return c.text("OK", 200);
});

// 3. Auth Guard Middleware for /v1/objects/* and /v1/selective-sync/*
app.use("/v1/*", async (c, next) => {
  const user = await authenticateRequest(c.req.raw, c.env);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", user);
  await next();
});

// 4. Standard Object Sync Endpoints (matches DON SyncClient exactly)

// POST /v1/objects/stat
app.post("/v1/objects/stat", async (c) => {
  const body = (await c.req.json()) as StatRequest;
  const user = c.get("user");
  const fullKey = user.prefix ? `${user.prefix}${body.key}` : body.key;

  const head = await c.env.BUCKET.head(fullKey);
  if (!head) {
    const res: StatResponse = { exists: false };
    return c.json(res);
  }

  const res: StatResponse = {
    exists: true,
    size: head.size,
    lastModified: head.uploaded.toISOString(),
    metadata: head.customMetadata,
  };
  return c.json(res);
});

// POST /v1/objects/presign-upload
app.post("/v1/objects/presign-upload", async (c) => {
  const body = (await c.req.json()) as PresignUploadRequest;
  const user = c.get("user");
  const fullKey = user.prefix ? `${user.prefix}${body.key}` : body.key;

  const { url, expiresAt } = await buildTransferUrl(
    c,
    fullKey,
    "PUT",
    body.expiresIn || 3600,
  );

  const res: PresignUploadResponse = {
    url,
    expiresAt,
    metadata: body.metadata,
  };
  return c.json(res);
});

// POST /v1/objects/presign-upload-batch
app.post("/v1/objects/presign-upload-batch", async (c) => {
  const body = (await c.req.json()) as PresignUploadBatchRequest;
  const user = c.get("user");
  const expiresIn = body.expiresIn || 3600;

  const items = await Promise.all(
    body.items.map(async (item) => {
      const fullKey = user.prefix ? `${user.prefix}${item.key}` : item.key;
      const { url, expiresAt } = await buildTransferUrl(
        c,
        fullKey,
        "PUT",
        expiresIn,
      );
      return {
        key: item.key,
        url,
        expiresAt,
      };
    }),
  );

  const res: PresignUploadBatchResponse = { items };
  return c.json(res);
});

// POST /v1/objects/presign-download
app.post("/v1/objects/presign-download", async (c) => {
  const body = (await c.req.json()) as PresignDownloadRequest;
  const user = c.get("user");
  const fullKey = user.prefix ? `${user.prefix}${body.key}` : body.key;

  const { url, expiresAt } = await buildTransferUrl(
    c,
    fullKey,
    "GET",
    body.expiresIn || 3600,
  );

  const res: PresignDownloadResponse = {
    url,
    expiresAt,
  };
  return c.json(res);
});

// POST /v1/objects/presign-download-batch
app.post("/v1/objects/presign-download-batch", async (c) => {
  const body = (await c.req.json()) as PresignDownloadBatchRequest;
  const user = c.get("user");
  const expiresIn = body.expiresIn || 3600;

  const items = await Promise.all(
    body.keys.map(async (key) => {
      const fullKey = user.prefix ? `${user.prefix}${key}` : key;
      const { url, expiresAt } = await buildTransferUrl(
        c,
        fullKey,
        "GET",
        expiresIn,
      );
      return {
        key,
        url,
        expiresAt,
      };
    }),
  );

  const res: PresignDownloadBatchResponse = { items };
  return c.json(res);
});

// POST /v1/objects/delete
app.post("/v1/objects/delete", async (c) => {
  const body = (await c.req.json()) as DeleteRequest;
  const user = c.get("user");
  const fullKey = user.prefix ? `${user.prefix}${body.key}` : body.key;

  await c.env.BUCKET.delete(fullKey);

  let tombstoneCreated = false;
  if (body.tombstoneKey && body.deletedAt) {
    const tombstoneFullKey = user.prefix
      ? `${user.prefix}${body.tombstoneKey}`
      : body.tombstoneKey;
    await c.env.BUCKET.put(
      tombstoneFullKey,
      JSON.stringify({ deletedAt: body.deletedAt }),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
    tombstoneCreated = true;
  }

  const res: DeleteResponse = {
    deleted: true,
    tombstoneCreated,
  };
  return c.json(res);
});

// POST /v1/objects/delete-prefix
app.post("/v1/objects/delete-prefix", async (c) => {
  const body = (await c.req.json()) as DeletePrefixRequest;
  const user = c.get("user");
  const prefix = user.prefix ? `${user.prefix}${body.prefix}` : body.prefix;

  let deletedCount = 0;
  let cursor: string | undefined;

  do {
    const listed = await c.env.BUCKET.list({
      prefix,
      cursor,
      limit: 500,
    });

    if (listed.objects.length > 0) {
      const keysToDelete = listed.objects.map((o: { key: string }) => o.key);
      await c.env.BUCKET.delete(keysToDelete);
      deletedCount += keysToDelete.length;
    }

    cursor = listed.truncated ? (listed as any).cursor : undefined;
  } while (cursor);

  let tombstoneCreated = false;
  if (body.tombstoneKey && body.deletedAt) {
    const tombstoneFullKey = user.prefix
      ? `${user.prefix}${body.tombstoneKey}`
      : body.tombstoneKey;
    await c.env.BUCKET.put(
      tombstoneFullKey,
      JSON.stringify({ deletedAt: body.deletedAt }),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
    tombstoneCreated = true;
  }

  const res: DeletePrefixResponse = {
    deletedCount,
    tombstoneCreated,
  };
  return c.json(res);
});

// POST /v1/objects/list
app.post("/v1/objects/list", async (c) => {
  const body = (await c.req.json()) as ListRequest;
  const user = c.get("user");
  const prefix = user.prefix ? `${user.prefix}${body.prefix}` : body.prefix;

  const listed = await c.env.BUCKET.list({
    prefix,
    limit: body.maxKeys || 1000,
    cursor: body.continuationToken || undefined,
  });

  const objects: ListObjectItem[] = listed.objects.map(
    (obj: { key: string; size: number; uploaded: Date }) => {
      const relativeKey = user.prefix
        ? obj.key.replace(new RegExp(`^${user.prefix}`), "")
        : obj.key;
      return {
        key: relativeKey,
        size: obj.size,
        lastModified: obj.uploaded.toISOString(),
      };
    },
  );

  const res: ListResponse = {
    objects,
    isTruncated: listed.truncated,
    nextContinuationToken: listed.truncated ? (listed as any).cursor : null,
  };
  return c.json(res);
});

// GET /v1/objects/subscribe (SSE stream for live changes)
app.get("/v1/objects/subscribe", (c) => {
  // Return SSE stream
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(`event: connected\ndata: {"status":"connected"}\n\n`),
      );
      // Keepalive ping every 15s
      const timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(timer);
        }
      }, 15000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// 5. Selective Sync & Profile Management APIs (backed by D1)

// GET /v1/selective-sync/profiles (lists cloud profiles available to the current user)
app.get("/v1/selective-sync/profiles", async (c) => {
  const user = c.get("user");
  if (!c.env.DB) {
    return c.json({ profiles: [] });
  }

  let rows: any[] = [];
  if (user.role === "admin") {
    const result = await c.env.DB.prepare(
      "SELECT * FROM cloud_profiles WHERE is_deleted = 0 ORDER BY updated_at DESC",
    ).all();
    rows = result.results;
  } else {
    const result = await c.env.DB.prepare(
      `SELECT p.*, a.can_write, a.is_pinned 
       FROM cloud_profiles p
       INNER JOIN profile_assignments a ON p.id = a.profile_id
       WHERE a.user_id = ? AND p.is_deleted = 0
       ORDER BY p.updated_at DESC`,
    )
      .bind(user.userId)
      .all();
    rows = result.results;
  }

  return c.json({ profiles: rows });
});

// POST /v1/selective-sync/profiles/register (records/updates profile metadata in D1)
app.post("/v1/selective-sync/profiles/register", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as any;
  if (!c.env.DB) {
    return c.json({ success: true, warning: "D1 not bound" });
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO cloud_profiles (id, owner_id, name, browser, version, tags, note, proxy_summary, wayfern_config_summary, size_bytes, manifest_version, is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       version = excluded.version,
       tags = excluded.tags,
       note = excluded.note,
       proxy_summary = excluded.proxy_summary,
       wayfern_config_summary = excluded.wayfern_config_summary,
       size_bytes = excluded.size_bytes,
       manifest_version = excluded.manifest_version,
       updated_at = excluded.updated_at`,
  )
    .bind(
      body.id,
      user.userId,
      body.name,
      body.browser || "wayfern",
      body.version || "1.0",
      JSON.stringify(body.tags || []),
      body.note || null,
      body.proxy_summary || null,
      body.wayfern_config_summary || null,
      body.size_bytes || 0,
      body.manifest_version || 1,
      now,
      now,
    )
    .run();

  return c.json({ success: true });
});

// POST /v1/selective-sync/assign (admin assigns a profile to a user)
app.post("/v1/selective-sync/assign", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Forbidden: Admin required" }, 403);
  }
  const body = (await c.req.json()) as {
    profileId: string;
    userId: string;
    canWrite?: boolean;
    isPinned?: boolean;
  };

  const id = `${body.profileId}_${body.userId}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO profile_assignments (id, profile_id, user_id, can_write, is_pinned, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, user_id) DO UPDATE SET
       can_write = excluded.can_write,
       is_pinned = excluded.is_pinned`,
  )
    .bind(
      id,
      body.profileId,
      body.userId,
      body.canWrite ? 1 : 0,
      body.isPinned ? 1 : 0,
      now,
    )
    .run();

  return c.json({ success: true });
});

// Export default worker handler
export default app;
