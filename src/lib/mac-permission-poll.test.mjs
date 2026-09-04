import assert from "node:assert/strict";
import test from "node:test";
import { waitForPermissionGrant } from "./mac-permission-poll.ts";

// Builds a probe with controllable read results plus call counters. `reads`
// is indexed by read number (0-based): read #0 returns reads[0], and so on. A
// missing entry returns false (still not granted).
const makeProbe = ({ reads, requestImpl }) => {
  let readCount = 0;
  let requestCount = 0;
  const request = async () => {
    requestCount += 1;
    if (requestImpl) await requestImpl();
  };
  const read = async () => {
    const index = readCount;
    readCount += 1;
    return reads[index] ?? false;
  };
  return {
    request,
    read,
    requestCount: () => requestCount,
    readCount: () => readCount,
  };
};

const noSleep = async () => {};

test("awaits the request before the first read, so a delayed grant is seen", async () => {
  let requestResolved = false;
  const request = async () => {
    // Simulate the fire-and-forget dispatch resolving, then the user granting
    // immediately after. If read ran during request it would see false.
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    requestResolved = true;
  };
  const read = async () => requestResolved;
  const result = await waitForPermissionGrant(request, read, {
    sleep: noSleep,
  });
  assert.equal(result, true);
});

test("returns true as soon as the user grants without extra reads or sleeps", async () => {
  const sleeps = [];
  const probe = makeProbe({ reads: [false, false, true, true, true] });
  const result = await waitForPermissionGrant(probe.request, probe.read, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result, true);
  assert.equal(probe.readCount(), 3);
  assert.equal(probe.requestCount(), 1);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("returns true on the first read when already granted, with no sleeps", async () => {
  const sleeps = [];
  const probe = makeProbe({ reads: [true, true] });
  const result = await waitForPermissionGrant(probe.request, probe.read, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result, true);
  assert.equal(probe.readCount(), 1);
  assert.deepEqual(sleeps, []);
});

test("polls up to maxAttempts then returns the final read when never granted", async () => {
  const sleeps = [];
  const probe = makeProbe({ reads: Array(20).fill(false) });
  const result = await waitForPermissionGrant(probe.request, probe.read, {
    maxAttempts: 4,
    intervalMs: 500,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result, false);
  assert.equal(probe.readCount(), 5);
  assert.equal(probe.requestCount(), 1);
  assert.deepEqual(sleeps, [500, 500, 500, 500]);
});

test("default options poll 8 times at 1000ms before the final read", async () => {
  const sleeps = [];
  const probe = makeProbe({ reads: Array(20).fill(false) });
  const result = await waitForPermissionGrant(probe.request, probe.read, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result, false);
  assert.equal(probe.readCount(), 9);
  assert.deepEqual(sleeps, Array(8).fill(1000));
});

test("a grant exactly on the final read (after exhausting attempts) is reported true", async () => {
  const reads = Array(8).fill(false);
  reads.push(true);
  const probe = makeProbe({ reads });
  const result = await waitForPermissionGrant(probe.request, probe.read, {
    sleep: noSleep,
  });
  assert.equal(result, true);
  assert.equal(probe.readCount(), 9);
});

test("requests the permission exactly once regardless of read outcomes", async () => {
  const probe = makeProbe({ reads: Array(20).fill(false) });
  await waitForPermissionGrant(probe.request, probe.read, {
    sleep: noSleep,
  });
  assert.equal(probe.requestCount(), 1);
});

test("rethrows if the request rejects so the caller can fall back to denied", async () => {
  const probe = {
    request: async () => {
      throw new Error("request-boom");
    },
    read: async () => true,
  };
  await assert.rejects(
    waitForPermissionGrant(probe.request, probe.read, { sleep: noSleep }),
    /request-boom/,
  );
});

test("rethrows if a read rejects and stops polling", async () => {
  let readCount = 0;
  const probe = {
    request: async () => {},
    read: async () => {
      readCount += 1;
      throw new Error("read-boom");
    },
  };
  await assert.rejects(
    waitForPermissionGrant(probe.request, probe.read, { sleep: noSleep }),
    /read-boom/,
  );
  assert.equal(readCount, 1);
});
