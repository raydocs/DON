import type { TrafficSnapshot } from "@/types";

export type TrafficSnapshotMap = Record<string, TrafficSnapshot>;

export function trafficSnapshotsEqual(
  current: TrafficSnapshotMap,
  next: TrafficSnapshotMap,
): boolean {
  const currentIds = Object.keys(current);
  const nextIds = Object.keys(next);
  if (currentIds.length !== nextIds.length) return false;

  return currentIds.every((id) => {
    const left = current[id];
    const right = next[id];
    if (!left || !right) return false;
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
  });
}

export function shouldPollTraffic(
  runningCount: number,
  documentVisible: boolean,
  windowFocused: boolean,
): boolean {
  return runningCount > 0 && documentVisible && windowFocused;
}
