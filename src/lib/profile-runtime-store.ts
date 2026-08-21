export interface ProfileRuntimeSnapshot {
  isRunning: boolean;
  isLaunching: boolean;
  isStopping: boolean;
  syncStatus?: string;
  syncError?: string;
  isLockedByAnother: boolean;
  lockEmail?: string;
  remoteHandoff: string | null;
  syncSessionId?: string;
  syncLeaderProfileName?: string;
  isSyncLeader?: boolean;
  syncFailedAtUrl?: string | null;
}

export type ProfileRuntimeSnapshotMap = Record<string, ProfileRuntimeSnapshot>;

export interface ProfileRuntimeStore {
  getSnapshot: (profileId: string) => ProfileRuntimeSnapshot | undefined;
  replace: (next: ProfileRuntimeSnapshotMap) => void;
  subscribe: (profileId: string, listener: () => void) => () => void;
}

function runtimeSnapshotEqual(
  left: ProfileRuntimeSnapshot | undefined,
  right: ProfileRuntimeSnapshot | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.isRunning === right.isRunning &&
    left.isLaunching === right.isLaunching &&
    left.isStopping === right.isStopping &&
    left.syncStatus === right.syncStatus &&
    left.syncError === right.syncError &&
    left.isLockedByAnother === right.isLockedByAnother &&
    left.lockEmail === right.lockEmail &&
    left.remoteHandoff === right.remoteHandoff &&
    left.syncSessionId === right.syncSessionId &&
    left.syncLeaderProfileName === right.syncLeaderProfileName &&
    left.isSyncLeader === right.isSyncLeader &&
    left.syncFailedAtUrl === right.syncFailedAtUrl
  );
}

export function createProfileRuntimeStore(
  initial: ProfileRuntimeSnapshotMap = {},
): ProfileRuntimeStore {
  let current = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  return {
    getSnapshot: (profileId) => current[profileId],
    replace(next) {
      const changedIds = new Set<string>();
      const stableNext: ProfileRuntimeSnapshotMap = {};
      for (const [profileId, snapshot] of Object.entries(next)) {
        const previous = current[profileId];
        if (runtimeSnapshotEqual(previous, snapshot)) {
          stableNext[profileId] = previous;
        } else {
          stableNext[profileId] = snapshot;
          changedIds.add(profileId);
        }
      }
      for (const profileId of Object.keys(current)) {
        if (!(profileId in next)) changedIds.add(profileId);
      }
      current = stableNext;
      for (const profileId of changedIds) {
        for (const listener of listeners.get(profileId) ?? []) listener();
      }
    },
    subscribe(profileId, listener) {
      const profileListeners = listeners.get(profileId) ?? new Set();
      profileListeners.add(listener);
      listeners.set(profileId, profileListeners);
      return () => {
        profileListeners.delete(listener);
        if (profileListeners.size === 0) listeners.delete(profileId);
      };
    },
  };
}
