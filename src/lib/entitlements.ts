import type { CloudUser, Entitlements } from "@/types";

/**
 * DON fork: every local capability is unlocked. Cloud login remains optional
 * for remote/sync features that still need a server token.
 */
const UNLOCKED: Entitlements = {
  active: true,
  browserAutomation: true,
  crossOsFingerprints: true,
  cloudBackup: true,
  teamCollaboration: true,
  cookieBot: true,
  remoteInteractive: true,
  profileLimit: Number.MAX_SAFE_INTEGER,
  requestsPerHour: 1_000_000,
  remoteBrowserHours: Number.MAX_SAFE_INTEGER,
};

/**
 * The user's effective entitlements. DON always returns a full unlock so
 * fingerprint editing, automation, and cookie bot work without a paid plan.
 */
export function getEntitlements(
  _user?: CloudUser | null | undefined,
): Entitlements {
  return { ...UNLOCKED };
}

/**
 * Whether this user may enrol profiles in Cookie Bot. DON removes the paid
 * plan gate, but the bot still runs on the cloud service and needs a signed-in
 * account. Keeping signed-out sessions idle avoids retrying cloud requests that
 * cannot succeed.
 */
export function canUseCookieBot(user?: CloudUser | null | undefined): boolean {
  return Boolean(user);
}

/**
 * Only a team owner sees per-member attribution. An admin can change team
 * settings but the pooled spend is the owner's bill.
 */
export function isTeamOwner(user: CloudUser | null | undefined): boolean {
  return Boolean(user?.teamRole === "owner" && user.teamId);
}
