import type { CloudUser, Entitlements } from "@/types";

/**
 * DON fork: every local capability is unlocked. Cloud login remains optional
 * for remote/sync features that still need a server token.
 */
const UNLOCKED: Entitlements = {
  active: true,
  browserAutomation: true,
  crossOsFingerprints: true,
  cloudBackup: false,
  teamCollaboration: false,
  cookieBot: false,
  remoteInteractive: false,
  remoteControl: false,
  scheduledAutomation: false,
  profileLimit: Number.MAX_SAFE_INTEGER,
  requestsPerHour: 1_000_000,
  remoteBrowserHours: 0,
};

/**
 * Local DON features are unlocked; remote capabilities come from the server.
 */
export function getEntitlements(
  user?: CloudUser | null | undefined,
): Entitlements {
  const server = user?.entitlements;
  return {
    ...UNLOCKED,
    cloudBackup: Boolean(server?.active && server.cloudBackup),
    teamCollaboration: Boolean(server?.active && server.teamCollaboration),
    cookieBot: Boolean(server?.active && server.cookieBot),
    remoteInteractive: Boolean(server?.active && server.remoteInteractive),
    remoteControl: Boolean(server?.active && server.remoteControl),
    scheduledAutomation: Boolean(server?.active && server.scheduledAutomation),
    remoteBrowserHours: server?.remoteBrowserHours ?? 0,
  };
}

export function effectivePlanOf(user: CloudUser | null | undefined): string {
  return user?.effectivePlan ?? user?.plan ?? "free";
}

export function canUseScheduledAutomation(
  user: CloudUser | null | undefined,
): boolean {
  return getEntitlements(user).scheduledAutomation;
}

/**
 * Cookie Bot runs on the cloud service and needs a server-authorized account.
 */
export function canUseCookieBot(user?: CloudUser | null | undefined): boolean {
  return getEntitlements(user).cookieBot;
}

/**
 * Whether this user may drive this desktop from donutbrowser.com.
 *
 * The bridge itself does not read this, the server decides who may send work,
 * and a cached entitlement that is a refresh cycle out of date must not be what
 * refuses a customer their own machine. This is what the UI reads to explain
 * WHY a connected desktop cannot be driven.
 */
export function canUseRemoteControl(
  user: CloudUser | null | undefined,
): boolean {
  const entitlements = getEntitlements(user);
  return entitlements.active && entitlements.remoteControl;
}

/**
 * Only a team owner sees per-member attribution. An admin can change team
 * settings but the pooled spend is the owner's bill.
 */
export function isTeamOwner(user: CloudUser | null | undefined): boolean {
  return Boolean(user?.teamRole === "owner" && user.teamId);
}

/**
 * A team seat that may open the team's profiles and keep what a session
 * changes, but not change the team's profiles, proxies or groups.
 */
export function isTeamLauncher(user: CloudUser | null | undefined): boolean {
  return Boolean(user?.teamId) && user?.teamRole === "launcher";
}

/** Owners and admins read the team's activity log. The cloud checks again. */
export function canViewTeamActivity(
  user: CloudUser | null | undefined,
): boolean {
  return (
    getEntitlements(user).teamCollaboration &&
    Boolean(user?.teamId) &&
    (user?.teamRole === "owner" || user?.teamRole === "admin")
  );
}
