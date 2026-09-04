import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import { AuthGuard } from "./auth.guard.js";
import type { UserContext } from "./user-context.interface.js";

/**
 * Unit tests for AuthGuard. These exercise the JWT verification + team-scope
 * resolution + profileLimit adoption path end-to-end with a REAL RSA keypair
 * and the real `jsonwebtoken` verifier (no module mocking), mocking only the
 * backend `fetch` used by `resolveTeamScope`. The sync enforcement path
 * treats `profileLimit <= 0` as "unlimited", so these tests assert the exact
 * `profileLimit` value placed onto the request's `user` context.
 */

// --- Shared RSA keypair (real signing/verification, no mocking) -------------

let publicKeyPem: string;
let privateKeyObject: KeyObject;

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  privateKeyObject = privateKey;
});

// --- Test helpers -----------------------------------------------------------

interface ConfigOptions {
  syncToken?: string;
  jwtPublicKey?: string;
  backendInternalUrl?: string;
  backendInternalKey?: string;
}

function makeConfig(opts: ConfigOptions): ConfigService {
  const map: Record<string, string | undefined> = {
    SYNC_TOKEN: opts.syncToken,
    SYNC_JWT_PUBLIC_KEY: opts.jwtPublicKey,
    BACKEND_INTERNAL_URL: opts.backendInternalUrl,
    BACKEND_INTERNAL_KEY: opts.backendInternalKey,
  };
  return {
    get: jest.fn((key: string) => map[key]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as ConfigService;
}

function makeContext(authHeader?: string): {
  ctx: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = {
    headers: authHeader ? { authorization: authHeader } : {},
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

type TeamScope = { ownerId: string; teamId: string; teamProfileLimit: number };

function makeGuard(opts: ConfigOptions = {}): AuthGuard {
  return new AuthGuard(makeConfig(opts));
}

function mockTeamScopeResponse(
  value: TeamScope | null,
  init: { ok?: boolean; status?: number } = {},
): Response {
  const { ok = true, status = 200 } = init;
  return {
    ok,
    status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: async () => value as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function signToken(
  payload: jwt.JwtPayload,
  key: KeyObject | string = privateKeyObject,
): string {
  return jwt.sign(payload, key, { algorithm: "RS256", expiresIn: "1h" });
}

function userOf(request: Record<string, unknown>): UserContext {
  return request.user as UserContext;
}

/** Read the `warn` mock off a guard's private logger. */
function spyLoggerWarn(guard: AuthGuard): jest.Mock {
  const logger = (
    guard as unknown as {
      logger: { warn: jest.Mock };
    }
  ).logger;
  const mock = jest.fn();
  logger.warn = mock;
  return mock;
}

const BACKEND = {
  url: "http://backend.internal",
  key: "internal-key",
};

beforeEach(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// SYNC_TOKEN (self-hosted) path
// ===========================================================================

describe("AuthGuard — self-hosted SYNC_TOKEN path", () => {
  it("authenticates a matching bearer token as self-hosted with unlimited quota", async () => {
    const guard = makeGuard({ syncToken: "secret-token" });
    const { ctx, request } = makeContext("Bearer secret-token");

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(userOf(request)).toEqual({
      mode: "self-hosted",
      prefix: "",
      profileLimit: 0,
    });
  });

  it("rejects a missing authorization header with 401", async () => {
    const guard = makeGuard({ syncToken: "secret-token" });
    const { ctx } = makeContext();
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects a non-matching token when no JWT is configured", async () => {
    const guard = makeGuard({ syncToken: "secret-token" });
    const { ctx } = makeContext("Bearer wrong-token");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("throws 'No auth method configured' when neither token nor JWT is set", async () => {
    const guard = makeGuard({});
    const { ctx } = makeContext("Bearer whatever");
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      /No auth method configured/,
    );
  });
});

// ===========================================================================
// JWT (cloud) path — team-scope + profileLimit adoption (THE FIX)
// ===========================================================================

describe("AuthGuard — JWT cloud path", () => {
  function cloudGuard(): AuthGuard {
    return makeGuard({
      jwtPublicKey: publicKeyPem,
      backendInternalUrl: BACKEND.url,
      backendInternalKey: BACKEND.key,
    });
  }

  function fetchSpy(): jest.SpyInstance {
    return jest.spyOn(globalThis, "fetch");
  }

  // --- THE BUG: team with teamProfileLimit = 0 (unlimited) ------------------

  describe("team-limit adoption (the bug)", () => {
    it("adopts team limit 0 (unlimited) instead of the JWT personal cap", async () => {
      // Alice: personal free tier cap of 3, member of an UNLIMITED team.
      const token = signToken({
        sub: "alice",
        profileLimit: 3,
        prefix: "users/alice/",
      });
      const guard = cloudGuard();
      fetchSpy().mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "acme-owner",
          teamId: "acme",
          teamProfileLimit: 0,
        }),
      );
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      const user = userOf(request);
      // Before the fix this stayed at 3 (personal cap); now must be 0 (unlimited).
      expect(user.profileLimit).toBe(0);
      expect(user.mode).toBe("cloud");
      expect(user.prefix).toBe("users/acme-owner/");
      expect(user.sub).toBe("alice");
    });

    it("adopts a positive team limit that is larger than the personal cap", async () => {
      const token = signToken({
        sub: "bob",
        profileLimit: 3,
        prefix: "users/bob/",
      });
      const guard = cloudGuard();
      fetchSpy().mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "team-owner",
          teamId: "t1",
          teamProfileLimit: 25,
        }),
      );
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      expect(userOf(request).profileLimit).toBe(25);
      expect(userOf(request).prefix).toBe("users/team-owner/");
    });

    it("adopts a positive team limit that is SMALLER than the personal cap (team wins)", async () => {
      const token = signToken({
        sub: "bob",
        profileLimit: 50,
        prefix: "users/bob/",
      });
      const guard = cloudGuard();
      fetchSpy().mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "team-owner",
          teamId: "t1",
          teamProfileLimit: 10,
        }),
      );
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      // Team limit overrides personal, even when lower.
      expect(userOf(request).profileLimit).toBe(10);
    });
  });

  // --- Non-team and backend-configuration cases -----------------------------

  describe("non-team / no-backend", () => {
    it("keeps the personal cap and own prefix when the backend reports null (non-team)", async () => {
      const token = signToken({
        sub: "solo",
        profileLimit: 7,
        prefix: "users/solo/",
      });
      const guard = cloudGuard();
      fetchSpy().mockResolvedValueOnce(mockTeamScopeResponse(null));
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      const user = userOf(request);
      expect(user.profileLimit).toBe(7);
      expect(user.prefix).toBe("users/solo/");
    });

    it("keeps the personal cap when the backend (team resolver) is not configured", async () => {
      // No BACKEND_INTERNAL_URL/KEY → resolveTeamScope returns null without fetch.
      const guard = makeGuard({ jwtPublicKey: publicKeyPem });
      const token = signToken({
        sub: "solo",
        profileLimit: 4,
        prefix: "users/solo/",
      });
      const spy = fetchSpy();
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      expect(userOf(request).profileLimit).toBe(4);
      expect(userOf(request).prefix).toBe("users/solo/");
      expect(spy).not.toHaveBeenCalled();
    });

    it("uses users/{sub}/ prefix when the JWT omits the prefix claim", async () => {
      const token = signToken({ sub: "carol", profileLimit: 2 });
      const guard = cloudGuard();
      fetchSpy().mockResolvedValueOnce(mockTeamScopeResponse(null));
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      expect(userOf(request).prefix).toBe("users/carol/");
    });

    it("defaults profileLimit to 0 when the JWT claim is not a number, then adopts a team limit", async () => {
      const token = signToken({
        sub: "dave",
        // profileLimit deliberately absent → not a number → start at 0.
        prefix: "users/dave/",
      });
      const guard = cloudGuard();
      fetchSpy().mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "team-owner",
          teamId: "t1",
          teamProfileLimit: 12,
        }),
      );
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      expect(userOf(request).profileLimit).toBe(12);
    });
  });

  // --- ownerId validation ---------------------------------------------------

  describe("ownerId validation", () => {
    it("ignores a team scope whose ownerId contains a slash (keeps own namespace + personal cap)", async () => {
      const token = signToken({
        sub: "alice",
        profileLimit: 5,
        prefix: "users/alice/",
      });
      const guard = cloudGuard();
      fetchSpy().mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "evil/../../",
          teamId: "t1",
          teamProfileLimit: 0,
        }),
      );
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      const user = userOf(request);
      // ownerId regex `/^[^/]+$/` rejects slashes → entire override skipped.
      expect(user.prefix).toBe("users/alice/");
      expect(user.profileLimit).toBe(5);
    });
  });

  // --- fail-closed on malformed teamProfileLimit ----------------------------

  describe("fail-closed on malformed teamProfileLimit", () => {
    async function runInfiniteTeamLimitCase(
      teamProfileLimit: unknown,
    ): Promise<UserContext> {
      const token = signToken({
        sub: "alice",
        profileLimit: 3,
        prefix: "users/alice/",
      });
      const guard = cloudGuard();
      // Cast: simulating an unvalidated backend payload shaped wrong.
      fetchSpy().mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "acme-owner",
          teamId: "acme",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          teamProfileLimit: teamProfileLimit as any,
        }),
      );
      const { ctx, request } = makeContext(`Bearer ${token}`);
      await guard.canActivate(ctx);
      return userOf(request);
    }

    it("keeps the personal cap when teamProfileLimit is a string", async () => {
      const user = await runInfiniteTeamLimitCase("unlimited");
      expect(user.profileLimit).toBe(3); // personal, fail-closed
      // Namespace still widens to the validated team owner prefix.
      expect(user.prefix).toBe("users/acme-owner/");
    });

    it("keeps the personal cap when teamProfileLimit is undefined", async () => {
      const user = await runInfiniteTeamLimitCase(undefined);
      expect(user.profileLimit).toBe(3);
    });

    it("keeps the personal cap when teamProfileLimit is null", async () => {
      // null inside a non-null TeamScope is malformed (field is required).
      const user = await runInfiniteTeamLimitCase(null);
      expect(user.profileLimit).toBe(3);
    });

    it("keeps the personal cap when teamProfileLimit is NaN", async () => {
      const user = await runInfiniteTeamLimitCase(NaN);
      // typeof NaN === "number" is true, but NaN >= 0 is false → fail-closed.
      expect(user.profileLimit).toBe(3);
    });

    it("keeps the personal cap when teamProfileLimit is negative", async () => {
      const user = await runInfiniteTeamLimitCase(-1);
      // Negative is not an "unlimited" sentinel; reject and keep personal cap.
      expect(user.profileLimit).toBe(3);
    });
  });

  // --- fail-closed on resolver errors ---------------------------------------

  describe("fail-closed on team-scope resolver errors", () => {
    it("falls back to own namespace + personal cap when the backend returns non-ok", async () => {
      const token = signToken({
        sub: "alice",
        profileLimit: 6,
        prefix: "users/alice/",
      });
      const guard = cloudGuard();
      const warn = spyLoggerWarn(guard);
      fetchSpy().mockResolvedValueOnce(
        mockTeamScopeResponse(null, { ok: false, status: 500 }),
      );
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      const user = userOf(request);
      expect(user.prefix).toBe("users/alice/");
      expect(user.profileLimit).toBe(6);
      expect(warn).toHaveBeenCalled();
    });

    it("falls back to own namespace + personal cap when fetch rejects", async () => {
      const token = signToken({
        sub: "alice",
        profileLimit: 6,
        prefix: "users/alice/",
      });
      const guard = cloudGuard();
      const warn = spyLoggerWarn(guard);
      fetchSpy().mockRejectedValueOnce(new Error("network down"));
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      const user = userOf(request);
      expect(user.prefix).toBe("users/alice/");
      expect(user.profileLimit).toBe(6);
      expect(warn).toHaveBeenCalled();
    });

    it("does NOT widen to a team namespace when the resolver errors (never trusts a team prefix on failure)", async () => {
      const token = signToken({
        sub: "alice",
        profileLimit: 6,
        prefix: "users/alice/",
      });
      const guard = cloudGuard();
      fetchSpy().mockRejectedValueOnce(new Error("boom"));
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      expect(userOf(request).prefix).toBe("users/alice/");
    });
  });

  // --- missing sub ----------------------------------------------------------

  describe("missing sub", () => {
    it("skips team-scope resolution when sub is not a string and keeps personal cap", async () => {
      const token = signToken({
        // sub deliberately absent.
        profileLimit: 8,
        prefix: "users/nosub/",
      });
      const guard = cloudGuard();
      const spy = fetchSpy();
      const { ctx, request } = makeContext(`Bearer ${token}`);

      await guard.canActivate(ctx);
      const user = userOf(request);
      // No sub → resolveTeamScope not called → own prefix + personal cap.
      expect(user.prefix).toBe("users/nosub/");
      expect(user.profileLimit).toBe(8);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // --- JWT validation failures ---------------------------------------------

  describe("JWT validation failures", () => {
    it("rejects a token signed by a different key (401)", async () => {
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const forged = jwt.sign(
        { sub: "alice", profileLimit: 3, prefix: "users/alice/" },
        other.privateKey.export({ type: "pkcs8", format: "pem" }),
        { algorithm: "RS256", expiresIn: "1h" },
      );
      const guard = cloudGuard();
      const { ctx } = makeContext(`Bearer ${forged}`);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("rejects a token with an invalid prefix claim shape (falls through to 401)", async () => {
      const token = signToken({ sub: "alice", profileLimit: 3, prefix: "bad" });
      const guard = cloudGuard();
      const { ctx } = makeContext(`Bearer ${token}`);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});

// ===========================================================================
// Team-scope cache
// ===========================================================================

describe("AuthGuard — team-scope cache", () => {
  function cloudGuard(): AuthGuard {
    return makeGuard({
      jwtPublicKey: publicKeyPem,
      backendInternalUrl: BACKEND.url,
      backendInternalKey: BACKEND.key,
    });
  }

  it("caches the team scope for the TTL window (one backend call for two requests)", async () => {
    const token = signToken({
      sub: "alice",
      profileLimit: 3,
      prefix: "users/alice/",
    });
    const guard = cloudGuard();
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockTeamScopeResponse({
        ownerId: "acme-owner",
        teamId: "acme",
        teamProfileLimit: 0,
      }),
    );

    const r1 = makeContext(`Bearer ${token}`);
    const r2 = makeContext(`Bearer ${token}`);
    await guard.canActivate(r1.ctx);
    await guard.canActivate(r2.ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(userOf(r1.request).profileLimit).toBe(0);
    expect(userOf(r2.request).profileLimit).toBe(0);
  });

  it("caches a null (non-team) result so it does not re-fetch within the TTL", async () => {
    const token = signToken({
      sub: "solo",
      profileLimit: 5,
      prefix: "users/solo/",
    });
    const guard = cloudGuard();
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockTeamScopeResponse(null));

    const r1 = makeContext(`Bearer ${token}`);
    const r2 = makeContext(`Bearer ${token}`);
    await guard.canActivate(r1.ctx);
    await guard.canActivate(r2.ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(userOf(r2.request).profileLimit).toBe(5);
  });

  it("resolves independently per user (no cross-user cache poisoning)", async () => {
    const guard = cloudGuard();
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "acme-owner",
          teamId: "acme",
          teamProfileLimit: 0,
        }),
      )
      .mockResolvedValueOnce(
        mockTeamScopeResponse({
          ownerId: "beta-owner",
          teamId: "beta",
          teamProfileLimit: 9,
        }),
      );

    const tAlice = signToken({
      sub: "alice",
      profileLimit: 3,
      prefix: "users/alice/",
    });
    const tBob = signToken({
      sub: "bob",
      profileLimit: 4,
      prefix: "users/bob/",
    });

    const rA = makeContext(`Bearer ${tAlice}`);
    const rB = makeContext(`Bearer ${tBob}`);
    await guard.canActivate(rA.ctx);
    await guard.canActivate(rB.ctx);

    expect(userOf(rA.request).profileLimit).toBe(0); // alice → unlimited team
    expect(userOf(rA.request).prefix).toBe("users/acme-owner/");
    expect(userOf(rB.request).profileLimit).toBe(9); // bob → beta team limit
    expect(userOf(rB.request).prefix).toBe("users/beta-owner/");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
