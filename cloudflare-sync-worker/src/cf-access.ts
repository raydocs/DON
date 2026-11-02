import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types.js";

// A JWKS ("JSON Web Key Set") fetched from the Cloudflare Access team domain
// is cached per team at module scope so it survives across requests within a
// Worker isolate. jose's RemoteJWKSet also caches the keys internally and will
// re-fetch on key rotation (kid mismatch).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  const normalized = teamDomain.replace(/\/+$/, "");
  let jwks = jwksCache.get(normalized);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${normalized}/cdn-cgi/access/certs`));
    jwksCache.set(normalized, jwks);
  }
  return jwks;
}

/**
 * Verify a Cloudflare Zero Trust Access JWT and return the authenticated
 * admin email, or `null` if the JWT is missing, malformed, expired, signed
 * by an untrusted key, or fails issuer/audience validation.
 *
 * The JWT must come from Cloudflare Access (the `Cf-Access-Jwt-Assertion`
 * header is preferred over the `CF_Authorization` cookie). The signature is
 * verified against the team's JWKS, and both the `iss` (team domain) and
 * `aud` (Application Audience Identifier) claims are enforced. Unsigned
 * (`alg: "none"`) / tampered / wrong-issuer / wrong-audience tokens are
 * rejected. Requires `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` to be
 * configured; if either is unset the Access path is disabled (fail-closed).
 */
export async function verifyCfAccessJwt(
  jwt: string,
  env: Env,
): Promise<string | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (!teamDomain || !audience || typeof jwt !== "string" || jwt.length === 0) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(jwt, getJwks(teamDomain), {
      issuer: teamDomain.replace(/\/+$/, ""),
      audience,
    });

    if (typeof payload.email !== "string") {
      return null;
    }
    const email = payload.email.trim().toLowerCase();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}
