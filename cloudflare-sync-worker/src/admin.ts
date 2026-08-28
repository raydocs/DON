import { Hono } from "hono";
import { adminHtmlContent } from "./admin_html.js";
import { safeEqual } from "./auth.js";
import type {
  CloudProfileRecord,
  Env,
  ProfileAssignmentRecord,
  SyncEventRecord,
  UserContext,
  UserRecord,
} from "./types.js";

export const adminRouter = new Hono<{
  Bindings: Env;
  Variables: { user?: UserContext };
}>();

// Helper: check if request is authenticated via Cloudflare Access
function getCfAccessUser(c: any): { email: string } | null {
  // 1. Direct header injected by Cloudflare Access Edge
  let email = c.req
    .header("cf-access-authenticated-user-email")
    ?.trim()
    .toLowerCase();

  // 2. JWT assertion header or CF_Authorization cookie from Cloudflare Access
  if (!email) {
    const jwt =
      c.req.header("cf-access-jwt-assertion") ||
      c.req.header("cookie")?.match(/CF_Authorization=([^;]+)/)?.[1];
    if (jwt) {
      try {
        const parts = jwt.split(".");
        if (parts.length === 3) {
          const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
          const payload = JSON.parse(atob(base64));
          if (payload.email) {
            email = String(payload.email).trim().toLowerCase();
          }
        }
      } catch {}
    }
  }

  // 3. Optional testing header
  if (!email) {
    email = c.req.header("x-admin-email")?.trim().toLowerCase();
  }

  if (!email) return null;

  const allowedEmails = (c.env.ADMIN_EMAILS || "ruiruiwan8@gmail.com")
    .split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.includes(email) || allowedEmails.includes("*")) {
    return { email };
  }
  return null;
}

// 1. GET /api/admin/auth-status (allows frontend to detect Cloudflare Access without prompt)
adminRouter.get("/api/admin/auth-status", async (c) => {
  const cfUser = getCfAccessUser(c);
  if (cfUser) {
    return c.json({
      authenticated: true,
      method: "cloudflare_access",
      email: cfUser.email,
      role: "admin",
    });
  }

  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7).trim()
    : c.req.query("token") || "";

  if (token && c.env.SYNC_TOKEN && safeEqual(token, c.env.SYNC_TOKEN)) {
    return c.json({
      authenticated: true,
      method: "master_token",
      username: "Master Admin",
      role: "admin",
    });
  }

  return c.json({ authenticated: false });
});

// Admin Authentication Middleware
adminRouter.use("/api/admin/*", async (c, next) => {
  // 1. Check Cloudflare Access Zero Trust header
  const cfUser = getCfAccessUser(c);
  if (cfUser) {
    c.set("user", {
      userId: `cf_${cfUser.email}`,
      username: cfUser.email,
      role: "admin",
      prefix: "",
    });
    return await next();
  }

  // 2. Fallback to Master Token / D1 Admin verification
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7).trim()
    : c.req.query("token") || "";

  const expectedToken = c.env.SYNC_TOKEN;
  if (!expectedToken || !token || !safeEqual(token, expectedToken)) {
    // Check if it is an admin user in D1
    if (c.env.DB && token) {
      try {
        const user = await c.env.DB.prepare(
          "SELECT id, username, role, is_active FROM users WHERE token_hash = ? AND is_active = 1 AND role = 'admin' LIMIT 1",
        )
          .bind(token)
          .first<{ id: string; username: string; role: "admin" }>();

        if (user) {
          c.set("user", {
            userId: user.id,
            username: user.username,
            role: "admin",
            prefix: "",
          });
          return await next();
        }
      } catch (e) {
        console.error("Admin auth check error:", e);
      }
    }
    return c.json(
      {
        error: "Unauthorized: Master Admin Token or Cloudflare Access required",
      },
      401,
    );
  }

  c.set("user", {
    userId: "root",
    username: "admin",
    role: "admin",
    prefix: "",
  });
  return await next();
});

// 1. GET /api/admin/overview
adminRouter.get("/api/admin/overview", async (c) => {
  if (!c.env.DB) {
    return c.json({ error: "D1 database not bound" }, 500);
  }

  const [usersCount, profilesCount, assignmentsCount, recentEvents] =
    await Promise.all([
      c.env.DB.prepare("SELECT COUNT(*) as count FROM users").first<{
        count: number;
      }>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) as count, SUM(size_bytes) as total_size FROM cloud_profiles WHERE is_deleted = 0",
      ).first<{ count: number; total_size: number | null }>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM profile_assignments",
      ).first<{ count: number }>(),
      c.env.DB.prepare(
        "SELECT * FROM sync_events ORDER BY created_at DESC LIMIT 10",
      ).all<SyncEventRecord>(),
    ]);

  return c.json({
    totalUsers: usersCount?.count || 0,
    totalProfiles: profilesCount?.count || 0,
    totalStorageBytes: profilesCount?.total_size || 0,
    totalAssignments: assignmentsCount?.count || 0,
    recentEvents: recentEvents?.results || [],
    serverTime: new Date().toISOString(),
  });
});

// 2. User Whitelist Management APIs
// GET /api/admin/users
adminRouter.get("/api/admin/users", async (c) => {
  if (!c.env.DB) return c.json({ users: [] });

  const query = `
    SELECT u.*, 
      (SELECT COUNT(*) FROM profile_assignments WHERE user_id = u.id) as assigned_profiles_count
    FROM users u
    ORDER BY u.created_at DESC
  `;
  const result = await c.env.DB.prepare(query).all<UserRecord>();
  return c.json({ users: result.results });
});

// POST /api/admin/users
adminRouter.post("/api/admin/users", async (c) => {
  if (!c.env.DB) return c.json({ error: "D1 not bound" }, 500);

  const body = (await c.req.json()) as {
    username: string;
    role?: "admin" | "member";
    note?: string;
    customToken?: string;
  };

  if (!body.username || body.username.trim().length === 0) {
    return c.json({ error: "Username is required" }, 400);
  }

  const userId = `usr_${crypto.randomUUID().replaceAll("-", "").substring(0, 16)}`;
  const token =
    body.customToken ||
    `don_usr_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").substring(0, 8)}`;
  const role = body.role || "member";
  const note = body.note || null;
  const now = Date.now();

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, token_hash, role, note, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(userId, body.username.trim(), token, role, note, now, now)
      .run();

    return c.json({
      success: true,
      user: {
        id: userId,
        username: body.username.trim(),
        token: token,
        role,
        note,
        is_active: 1,
        created_at: now,
      },
    });
  } catch (err: any) {
    if (String(err).includes("UNIQUE constraint failed")) {
      return c.json({ error: "Username already exists" }, 409);
    }
    return c.json({ error: String(err) }, 500);
  }
});

// PUT /api/admin/users/:id
adminRouter.put("/api/admin/users/:id", async (c) => {
  if (!c.env.DB) return c.json({ error: "D1 not bound" }, 500);

  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    username?: string;
    role?: "admin" | "member";
    note?: string;
    is_active?: number;
  };

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE users SET 
       username = COALESCE(?, username),
       role = COALESCE(?, role),
       note = COALESCE(?, note),
       is_active = COALESCE(?, is_active),
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      body.username ?? null,
      body.role ?? null,
      body.note ?? null,
      typeof body.is_active === "number" ? body.is_active : null,
      now,
      id,
    )
    .run();

  return c.json({ success: true });
});

// POST /api/admin/users/:id/reset-token
adminRouter.post("/api/admin/users/:id/reset-token", async (c) => {
  if (!c.env.DB) return c.json({ error: "D1 not bound" }, 500);

  const id = c.req.param("id");
  const newToken = `don_usr_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").substring(0, 8)}`;
  const now = Date.now();

  await c.env.DB.prepare(
    "UPDATE users SET token_hash = ?, updated_at = ? WHERE id = ?",
  )
    .bind(newToken, now, id)
    .run();

  return c.json({ success: true, token: newToken });
});

// DELETE /api/admin/users/:id
adminRouter.delete("/api/admin/users/:id", async (c) => {
  if (!c.env.DB) return c.json({ error: "D1 not bound" }, 500);

  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM profile_assignments WHERE user_id = ?").bind(
      id,
    ),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);

  return c.json({ success: true });
});

// 3. Profile Whitelist & Assignment APIs
// GET /api/admin/profiles
adminRouter.get("/api/admin/profiles", async (c) => {
  if (!c.env.DB) return c.json({ profiles: [] });

  const profilesResult = await c.env.DB.prepare(
    "SELECT * FROM cloud_profiles WHERE is_deleted = 0 ORDER BY updated_at DESC",
  ).all<CloudProfileRecord>();

  const assignmentsResult = await c.env.DB.prepare(
    `SELECT a.*, u.username 
     FROM profile_assignments a
     LEFT JOIN users u ON a.user_id = u.id`,
  ).all<ProfileAssignmentRecord>();

  // Group assignments by profile_id
  const assignmentsByProfile = new Map<string, ProfileAssignmentRecord[]>();
  for (const a of assignmentsResult.results) {
    const list = assignmentsByProfile.get(a.profile_id) || [];
    list.push(a);
    assignmentsByProfile.set(a.profile_id, list);
  }

  const profilesWithAssignments = profilesResult.results.map((p) => ({
    ...p,
    assignments: assignmentsByProfile.get(p.id) || [],
  }));

  return c.json({ profiles: profilesWithAssignments });
});

// POST /api/admin/profiles/:id/assign
adminRouter.post("/api/admin/profiles/:id/assign", async (c) => {
  if (!c.env.DB) return c.json({ error: "D1 not bound" }, 500);

  const profileId = c.req.param("id");
  const body = (await c.req.json()) as {
    assignments: Array<{
      userId: string;
      canWrite?: boolean;
      isPinned?: boolean;
    }>;
  };

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "DELETE FROM profile_assignments WHERE profile_id = ?",
    ).bind(profileId),
  ];

  for (const item of body.assignments || []) {
    const id = `${profileId}_${item.userId}`;
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO profile_assignments (id, profile_id, user_id, can_write, is_pinned, assigned_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        profileId,
        item.userId,
        item.canWrite ? 1 : 0,
        item.isPinned ? 1 : 0,
        now,
      ),
    );
  }

  await c.env.DB.batch(statements);

  // Log sync event
  try {
    await c.env.DB.prepare(
      `INSERT INTO sync_events (profile_id, user_id, event_type, details, created_at)
       VALUES (?, 'admin', 'assign_users', ?, ?)`,
    )
      .bind(
        profileId,
        JSON.stringify({ userIds: body.assignments.map((a) => a.userId) }),
        now,
      )
      .run();
  } catch {}

  return c.json({ success: true });
});

// DELETE /api/admin/profiles/:id
adminRouter.delete("/api/admin/profiles/:id", async (c) => {
  if (!c.env.DB) return c.json({ error: "D1 not bound" }, 500);

  const profileId = c.req.param("id");
  const now = Date.now();

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE cloud_profiles SET is_deleted = 1, updated_at = ? WHERE id = ?",
    ).bind(now, profileId),
    c.env.DB.prepare(
      "DELETE FROM profile_assignments WHERE profile_id = ?",
    ).bind(profileId),
  ]);

  return c.json({ success: true });
});

// 4. GET /api/admin/events
adminRouter.get("/api/admin/events", async (c) => {
  if (!c.env.DB) return c.json({ events: [] });

  const result = await c.env.DB.prepare(
    `SELECT e.*, u.username, p.name as profile_name
     FROM sync_events e
     LEFT JOIN users u ON e.user_id = u.id
     LEFT JOIN cloud_profiles p ON e.profile_id = p.id
     ORDER BY e.created_at DESC
     LIMIT 100`,
  ).all<SyncEventRecord>();

  return c.json({ events: result.results });
});

// 5. GET /admin (Modern Web Admin SPA Dashboard)
adminRouter.get("/admin", (c) => {
  return c.html(adminHtmlContent);
});
