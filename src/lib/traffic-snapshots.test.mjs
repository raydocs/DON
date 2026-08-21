import assert from "node:assert/strict";
import test from "node:test";
import * as traffic from "./traffic-snapshots.ts";

const { shouldPollTraffic } = traffic;

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

test("traffic polling pauses while the app is hidden or unfocused", () => {
  assert.equal(shouldPollTraffic(1, true, true), true);
  assert.equal(shouldPollTraffic(1, false, true), false);
  assert.equal(shouldPollTraffic(1, true, false), false);
  assert.equal(shouldPollTraffic(0, true, true), false);
});

test("traffic store notifies only the profile whose snapshot changed", () => {
  assert.equal(typeof traffic.createTrafficSnapshotStore, "function");
  const store = traffic.createTrafficSnapshotStore({
    "profile-1": snapshot(),
    "profile-2": snapshot({ profile_id: "profile-2" }),
  });
  let profileOneUpdates = 0;
  let profileTwoUpdates = 0;
  store.subscribe("profile-1", () => {
    profileOneUpdates += 1;
  });
  store.subscribe("profile-2", () => {
    profileTwoUpdates += 1;
  });

  store.replace({
    "profile-1": snapshot({ current_bytes_sent: 99 }),
    "profile-2": snapshot({ profile_id: "profile-2" }),
  });

  assert.equal(profileOneUpdates, 1);
  assert.equal(profileTwoUpdates, 0);
  assert.equal(store.getSnapshot("profile-1")?.current_bytes_sent, 99);
});

test("traffic store notifies a profile when its snapshot is removed", () => {
  assert.equal(typeof traffic.createTrafficSnapshotStore, "function");
  const store = traffic.createTrafficSnapshotStore({
    "profile-1": snapshot(),
  });
  let updates = 0;
  store.subscribe("profile-1", () => {
    updates += 1;
  });

  store.replace({});

  assert.equal(updates, 1);
  assert.equal(store.getSnapshot("profile-1"), undefined);
});

test("bandwidth series fills missing seconds without rescanning every point", () => {
  assert.equal(typeof traffic.buildBandwidthSeries, "function");
  assert.deepEqual(
    traffic.buildBandwidthSeries(
      [
        { timestamp: 98, bytes_sent: 3, bytes_received: 4 },
        { timestamp: 100, bytes_sent: 5, bytes_received: 6 },
      ],
      100,
      4,
    ),
    [0, 7, 0, 11],
  );
});
