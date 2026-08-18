import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldPollTraffic,
  trafficSnapshotsEqual,
} from "./traffic-snapshots.ts";

const snapshot = (overrides = {}) => ({
  profile_id: "profile-1",
  session_start: 10,
  last_update: 20,
  total_bytes_sent: 30,
  total_bytes_received: 40,
  total_requests: 2,
  current_bytes_sent: 5,
  current_bytes_received: 6,
  recent_bandwidth: [{ timestamp: 20, bytes_sent: 5, bytes_received: 6 }],
  ...overrides,
});

test("equal traffic snapshots do not trigger a UI update", () => {
  assert.equal(
    trafficSnapshotsEqual(
      { "profile-1": snapshot() },
      { "profile-1": snapshot() },
    ),
    true,
  );
});

test("a changed bandwidth point triggers a UI update", () => {
  assert.equal(
    trafficSnapshotsEqual(
      { "profile-1": snapshot() },
      {
        "profile-1": snapshot({
          recent_bandwidth: [
            { timestamp: 20, bytes_sent: 7, bytes_received: 6 },
          ],
        }),
      },
    ),
    false,
  );
});

test("traffic polling pauses while the app is hidden or unfocused", () => {
  assert.equal(shouldPollTraffic(1, true, true), true);
  assert.equal(shouldPollTraffic(1, false, true), false);
  assert.equal(shouldPollTraffic(1, true, false), false);
  assert.equal(shouldPollTraffic(0, true, true), false);
});
