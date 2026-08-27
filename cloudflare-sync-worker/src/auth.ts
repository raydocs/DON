import type { Env, UserContext } from "./types.js";

/** Constant-time string comparison */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Get signing key from Env */
function getSigningSecret(env: Env): string {
  return env.SIGNING_SECRET || env.SYNC_TOKEN || "default-don-signing-secret";
}

/** Generate an HMAC-SHA256 signature for a raw file transfer URL */
export async function generateTransferSignature(
  key: string,
  method: "GET" | "PUT",
  expiresAtMs: number,
  env: Env,
): Promise<string> {
  const secret = getSigningSecret(env);
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const payload = `${method}:${key}:${expiresAtMs}`;
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(payload),
  );

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify an HMAC-SHA256 signature for a raw file transfer URL */
export async function verifyTransferSignature(
  signature: string,
  key: string,
  method: "GET" | "PUT",
  expiresAtMs: number,
  env: Env,
): Promise<boolean> {
  if (Date.now() > expiresAtMs) {
    return false; // Expired
  }
  const expected = await generateTransferSignature(
    key,
    method,
    expiresAtMs,
    env,
  );
  return safeEqual(signature, expected);
}

/** Authenticate an incoming request and return UserContext */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<UserContext | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7).trim();
  const expectedToken = env.SYNC_TOKEN;

  // 1. Check direct SYNC_TOKEN match (self-hosted / master token)
  if (expectedToken && safeEqual(token, expectedToken)) {
    return {
      userId: "root",
      username: "admin",
      role: "admin",
      prefix: "",
    };
  }

  // 2. Check D1 database for user tokens
  if (env.DB) {
    try {
      // For fast lookup, token can be matched or hashed
      const user = await env.DB.prepare(
        "SELECT id, username, role FROM users WHERE token_hash = ? LIMIT 1",
      )
        .bind(token)
        .first<{ id: string; username: string; role: "admin" | "member" }>();

      if (user) {
        return {
          userId: user.id,
          username: user.username,
          role: user.role,
          prefix: user.role === "admin" ? "" : `users/${user.id}/`,
        };
      }
    } catch (err) {
      console.warn("D1 auth lookup failed:", err);
    }
  }

  return null;
}
