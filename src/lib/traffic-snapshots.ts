import type { BandwidthDataPoint, TrafficSnapshot } from "@/types";

export type TrafficSnapshotMap = Record<string, TrafficSnapshot>;

export function buildBandwidthSeries(
  data: BandwidthDataPoint[],
  now: number,
  seconds = 60,
): number[] {
  const bandwidthBySecond = new Map(
    data.map((point) => [
      point.timestamp,
      point.bytes_sent + point.bytes_received,
    ]),
  );
  return Array.from(
    { length: seconds },
    (_, index) => bandwidthBySecond.get(now - (seconds - 1 - index)) ?? 0,
  );
}

function trafficSnapshotEqual(
  left: TrafficSnapshot | undefined,
  right: TrafficSnapshot | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (
    left.profile_id !== right.profile_id ||
    left.session_start !== right.session_start ||
    left.last_update !== right.last_update ||
    left.total_bytes_sent !== right.total_bytes_sent ||
    left.total_bytes_received !== right.total_bytes_received ||
    left.total_requests !== right.total_requests ||
    left.current_bytes_sent !== right.current_bytes_sent ||
    left.current_bytes_received !== right.current_bytes_received ||
    left.recent_bandwidth.length !== right.recent_bandwidth.length
  ) {
    return false;
  }

  return left.recent_bandwidth.every((point, index) => {
    const other = right.recent_bandwidth[index];
    return (
      other !== undefined &&
      point.timestamp === other.timestamp &&
      point.bytes_sent === other.bytes_sent &&
      point.bytes_received === other.bytes_received
    );
  });
}

export interface TrafficSnapshotStore {
  getSnapshot: (profileId: string) => TrafficSnapshot | undefined;
  replace: (next: TrafficSnapshotMap) => void;
  subscribe: (profileId: string, listener: () => void) => () => void;
}

export function createTrafficSnapshotStore(
  initial: TrafficSnapshotMap = {},
): TrafficSnapshotStore {
  let current = { ...initial };
  const listeners = new Map<string, Set<() => void>>();

  return {
    getSnapshot(profileId) {
      return current[profileId];
    },
    replace(next) {
      const changedIds = new Set<string>();
      const stableNext: TrafficSnapshotMap = {};

      for (const [profileId, snapshot] of Object.entries(next)) {
        const previous = current[profileId];
        if (trafficSnapshotEqual(previous, snapshot)) {
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
      let profileListeners = listeners.get(profileId);
      if (!profileListeners) {
        profileListeners = new Set();
        listeners.set(profileId, profileListeners);
      }
      profileListeners.add(listener);
      return () => {
        profileListeners.delete(listener);
        if (profileListeners.size === 0) listeners.delete(profileId);
      };
    },
  };
}

export function shouldPollTraffic(
  runningCount: number,
  documentVisible: boolean,
  windowFocused: boolean,
): boolean {
  return runningCount > 0 && documentVisible && windowFocused;
}
